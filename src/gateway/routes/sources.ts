/**
 * API des SOURCES — `node:http`, aucun framework.
 *
 * Routes PUBLIQUES (authentification par JETON de source, jamais la config) :
 *   POST /api/sources/<nom>/messages   → un programme réveille Yuki
 *        `Authorization: Bearer <jeton>` · corps JSON ≤ 64 Kio
 *        → 202 {started|stored, entree, raison?} · 200 {duplicate:true}
 *        · 400 (corps invalide) · 401 (jeton) · 404 (source) · 413/415 · 429
 *
 * Routes d'ADMINISTRATION (mêmes garde-fous que `/api/config` :
 * `requireWriteGuards` ⇒ en-tête `X-Yuki-Config: 1` + contrôle `Origin`/`Host`) :
 *   GET    /api/sources                → liste + conversations proposables
 *   POST   /api/sources                → création
 *   GET    /api/sources/<nom>          → une source
 *   PATCH  /api/sources/<nom>          → réglages (où / tour / notifier / consigne)
 *   DELETE /api/sources/<nom>          → suppression (et jeton)
 *   POST   /api/sources/<nom>/jeton    → crée le jeton, ⚠️ affiché UNE SEULE FOIS
 *
 * ⚠️ La LECTURE est GARDÉE elle aussi (en-tête `X-Yuki-Config: 1`) : la fiche d'une
 * source porte sa CONSIGNE (du texte d'utilisateur) et la destination de chaque
 * programme branché ; une page tierce ne doit pas pouvoir les lire. Seule exception,
 * la route de RÉVEIL (`…/messages`), authentifiée par le JETON de la source.
 *
 * Route du JOURNAL des déclencheurs silencieux (lecture GARDÉE) :
 *   GET    /api/sources/journal?limite=N&type=echec,saut&source=<nom>
 *        → les N derniers événements (`recu` / `silence` / `publie` / `echec` /
 *        `saut` / `plafond` / `desactive` / `refus` / `preautorisation`),
 *        FILTRÉS par type et/ou par source. ⚠️ Toujours BORNÉ (`limite` ≤ 200) :
 *        la page de gestion ne charge jamais tout le fichier. ⚠️ Jamais affiché
 *        dans l'interface de conversation.
 *
 * `GET /api/sources` porte en plus, pour chaque source, son DERNIER ÉVÉNEMENT de
 * journal (`dernierEvenement`) : c'est la colonne « dernier résultat » de la page
 * de gestion — sans elle, une source muette depuis 3 jours est indistinguable
 * d'une source qui travaille.
 *
 * Route d'APERÇU du moteur horloge (lecture GARDÉE, lot 2) :
 *   GET    /api/sources/apercu?expression=…&fuseau=…&depuis=ISO&combien=N
 *        → { passages: ISO[], expression, fuseau, raison?, code? }
 *        ⚠️ INDISPENSABLE dans l'interface : une expression fausse se voit tout de
 *        suite, avec la raison (« L » refusé, 31 février impossible…).
 *
 * Routes de la BOÎTE « Notifications » (lecture GARDÉE, TOUTE mutation gardée —
 * même doctrine que `/api/config` : c'est un en-tête maison + `Origin`/`Host`) :
 *   GET    /api/sources/inbox            → entrées + compteur de non-lus + limite
 *   POST   /api/sources/inbox/lu         → tout marquer comme lu
 *   POST   /api/sources/inbox/<id>/lu    → marquer une entrée comme lue
 *   DELETE /api/sources/inbox/<id>       → supprimer une entrée
 *   POST   /api/sources/inbox/<id>/ouvrir → ouvre le fil de la source (jamais pour
 *        en créer un sur simple réception)
 *
 * ⚠️ Aucune réponse ne contient un jeton (sauf la création, une seule fois).
 */

import type { IncomingHttpHeaders } from "node:http";

import {
  apercuCron,
  DECLENCHEUR_EVENTS,
  isDeclencheurEvent,
  SourceApiError,
  SourceValidationError,
  SourcesFullError,
  type DeclencheurEvent,
  type DeclencheurJournalFilter,
  type DeclencheurJournalRecord,
  type SourceOpenResult,
  type SourceSettingsInput,
  type SourcesLogger,
  type SourcesService,
} from "../../sources/index.js";
import { requireWriteGuards } from "./config.js";
import {
  DUREE_DEFAUT_JOURS,
  DUREE_MAX_JOURS,
  etatPreAutorisation,
  MAX_PREAUTORISATIONS,
  MOTIFS_PROPOSES,
  PreAutorisationError,
  texteMotif,
  type EtatPreAutorisation,
  type PreAutorisation,
} from "../../agents/preautorisations.js";

/**
 * Vue PUBLIQUE d'une pré-autorisation (aucun champ interne).
 *
 * ⚠️ Elle porte l'ÉTAT CALCULÉ (`active`/`consommee`/`expiree`/`revoquee`) et le
 * compteur de consommations : la page de gestion peut ainsi afficher, sans
 * deviner, ce qui est encore utilisable.
 */
function preAutorisationBody(
  pre: PreAutorisation,
  maintenant: number,
  agentNom?: string,
): Record<string, unknown> {
  return {
    id: pre.id,
    declencheur: pre.declencheur,
    agentId: pre.agentId,
    ...(agentNom !== undefined ? { agentNom } : {}),
    motif: pre.motif,
    motifTexte: texteMotif(pre),
    portee: pre.portee,
    destructifAutorise: pre.destructifAutorise,
    expireA: pre.expireA,
    creeLe: pre.creeLe,
    ...(pre.consommeeLe !== undefined ? { consommeeLe: pre.consommeeLe } : {}),
    consommations: pre.consommations,
    ...(pre.revoqueeLe !== undefined ? { revoqueeLe: pre.revoqueeLe } : {}),
    ...(pre.revoqueeRaison !== undefined ? { revoqueeRaison: pre.revoqueeRaison } : {}),
    etat: etatPreAutorisation(pre, maintenant) as EtatPreAutorisation,
  };
}

export interface SourcesApiDeps {
  service: SourcesService;
  logger: SourcesLogger;
  /**
   * Journal des déclencheurs silencieux (lecture seule ici). Absent ⇒ la route
   * `GET /api/sources/journal` répond une liste vide (mode dégradé).
   */
  journal?: {
    recent(limit?: number, filter?: DeclencheurJournalFilter): DeclencheurJournalRecord[];
  };
  /**
   * REGISTRE des PRÉ-AUTORISATIONS (lot 26, lot 4/4).
   *
   * Absent ⇒ la route répond une liste VIDE et les écritures sont refusées (503) :
   * on n'invente jamais une autorisation qui n'existe pas.
   */
  preAutorisations?: {
    list(): PreAutorisation[];
    activesPour(declencheur: string): PreAutorisation[];
    get(id: string): PreAutorisation | undefined;
    creer(input: {
      declencheur: unknown;
      agentId: unknown;
      motif: unknown;
      portee?: unknown;
      destructifAutorise?: unknown;
      dureeJours?: unknown;
    }): PreAutorisation;
    revoquer(id: string, raison?: string): boolean;
  };
  /**
   * Agents connus (annuaire) : la page de gestion propose la MACHINE sur
   * laquelle la commande s'exécutera. Absent ⇒ aucune machine proposée.
   */
  agents?: {
    list(): Array<{ agentId: string; name?: string; level?: string; revoked?: boolean }>;
  };
}

export interface SourcesHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface SourcesRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  /** Corps BRUT (chaîne UTF-8) — déjà borné par l'appelant. */
  body: string;
  deps: SourcesApiDeps;
}

/** Réponses JSON systématiquement non mises en cache (données vivantes). */
const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(status: number, body: unknown, headers?: Record<string, string>): SourcesHttpResponse {
  return { status, body, headers: { ...JSON_HEADERS, ...(headers ?? {}) } };
}

/** Message d'erreur normalisé (français, jamais un secret). */
function errorBody(error: unknown): SourcesHttpResponse {
  if (error instanceof SourceApiError) {
    return json(error.status, {
      error: error.code,
      code: error.code,
      message: error.message,
      ...error.extra,
    });
  }
  if (error instanceof SourceValidationError) {
    const status = error.code === "unknown_source" ? 404 : 400;
    return json(status, { error: error.code, code: error.code, message: error.message });
  }
  if (error instanceof PreAutorisationError) {
    // ⚠️ Motif/déclencheur/agent/durée refusés : 400 avec le CODE stable et la
    // raison en français (joker interdit, préfixe trop court, durée hors bornes…).
    return json(400, { error: error.code, code: error.code, message: error.message });
  }
  if (error instanceof SourcesFullError) {
    return json(429, {
      error: "sources_full",
      code: "sources_full",
      message: error.message,
      limit: error.limit,
    });
  }
  throw error;
}

/** Lit un en-tête sans tenir compte de la casse (en-têtes forgés en test). */
function headerString(headers: IncomingHttpHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) return raw[0];
  }
  return undefined;
}

/** Extrait le jeton `Authorization: Bearer <jeton>` (sinon chaîne vide). */
export function bearerToken(headers: IncomingHttpHeaders): string {
  const raw = headerString(headers, "authorization") ?? "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(raw.trim());
  return match ? match[1] : "";
}

/** Vrai si le chemin relève de l'API des sources. */
export function isSourcesPath(path: string): boolean {
  return path === "/api/sources" || path.startsWith("/api/sources/");
}

/** Segment de chemin après `/api/sources/` (vide si aucun, requête ignorée). */
function segments(path: string): string[] {
  const at = path.indexOf("?");
  const chemin = at < 0 ? path : path.slice(0, at);
  return chemin.slice("/api/sources".length).split("/").filter((part) => part !== "");
}

/** Vue renvoyée pour une entrée (aucune donnée interne inutile). */
function entryBody(entry: {
  id: string;
  source: string;
  recu: string;
  titre: string;
  texte: string;
  octets: number;
  etat: string;
  reponse?: string;
  lu: boolean;
  enAttente: boolean;
  raison?: string;
  note?: string;
  conversationOuverte?: boolean;
}) {
  return {
    id: entry.id,
    source: entry.source,
    recu: entry.recu,
    titre: entry.titre,
    texte: entry.texte,
    octets: entry.octets,
    etat: entry.etat,
    ...(entry.reponse !== undefined ? { reponse: entry.reponse } : {}),
    lu: entry.lu,
    enAttente: entry.enAttente,
    ...(entry.raison !== undefined ? { raison: entry.raison } : {}),
    ...(entry.note !== undefined ? { note: entry.note } : {}),
    ...(entry.conversationOuverte === true ? { conversationOuverte: true } : {}),
  };
}

function parseJsonBody(body: string): unknown {
  const trimmed = body.trim();
  if (trimmed === "") return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new SourceApiError(400, "invalid_json", "Corps JSON invalide.");
  }
}

/**
 * Réglages acceptés par la création/modification d'une source.
 *
 * ⚠️ Les réglages du MOTEUR HORLOGE (`declencheur`, `chevauchement`,
 * `rattrapage`, `plafondMs`, `maxToursParJour`, `actif`) sont transmis SANS être
 * validés ici : le store est la SEULE autorité (il refuse avec la raison exacte,
 * `SourceValidationError` ⇒ 400). On ne duplique pas la validation.
 */
function settingsFrom(body: unknown): SourceSettingsInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SourceApiError(400, "invalid_body", "Objet JSON attendu.");
  }
  const raw = body as Record<string, unknown>;
  const settings: SourceSettingsInput = {};
  if (raw["consigne"] !== undefined) settings.consigne = String(raw["consigne"]);
  if (raw["visibilite"] !== undefined) {
    // ⚠️ Deux valeurs, pas davantage : le store refuse tout le reste (aucun repli muet).
    const visibilite = raw["visibilite"];
    if (visibilite !== "silencieux" && visibilite !== "visible") {
      throw new SourceApiError(
        400,
        "invalid_visibilite",
        'Champ « visibilite » : "silencieux" ou "visible" attendu.',
      );
    }
    settings.visibilite = visibilite;
  }
  // ⚠️ `destination` est un MODE ou l'identifiant d'une conversation existante :
  // la FORME est validée par le store, qui refuse tout le reste (aucun repli muet).
  // `conversation` reste accepté comme ALIAS historique (interface déjà déployée).
  const destination = raw["destination"] ?? raw["conversation"];
  if (destination !== undefined) {
    if (typeof destination !== "string") {
      throw new SourceApiError(400, "invalid_destination", "Champ « destination » : chaîne attendue.");
    }
    settings.destination = destination.trim();
  }
  if (raw["tour"] !== undefined) settings.tour = raw["tour"] as "lancer" | "stocker";
  if (raw["notifier"] !== undefined) settings.notifier = raw["notifier"] === true;
  // ⚠️ MOTEUR HORLOGE (lot 2) : les réglages de déclenchement sont transmis TELS
  // QUELS au store, seule autorité de validation — une expression cron invalide
  // ou un plafond hors bornes sont REFUSÉS avec la raison (`SourceValidationError`
  // ⇒ 400). Aucun repli silencieux ici.
  if (raw["declencheur"] !== undefined) {
    settings.declencheur = raw["declencheur"] as SourceSettingsInput["declencheur"];
  }
  if (raw["chevauchement"] !== undefined) {
    settings.chevauchement = raw["chevauchement"] as SourceSettingsInput["chevauchement"];
  }
  if (raw["rattrapage"] !== undefined) {
    settings.rattrapage = raw["rattrapage"] as SourceSettingsInput["rattrapage"];
  }
  if (raw["plafondMs"] !== undefined) {
    settings.plafondMs = raw["plafondMs"] as SourceSettingsInput["plafondMs"];
  }
  if (raw["maxToursParJour"] !== undefined) {
    settings.maxToursParJour = raw["maxToursParJour"] as SourceSettingsInput["maxToursParJour"];
  }
  if (raw["actif"] !== undefined) {
    settings.actif = raw["actif"] as SourceSettingsInput["actif"];
  }
  return settings;
}

/** Traite une requête de l'API des sources (asynchrone : `/ouvrir` attend le host). */
export async function handleSourcesRequest(
  input: SourcesRequestInput,
): Promise<SourcesHttpResponse> {
  const { method, path, deps } = input;
  const parts = segments(path);

  try {
    // ── Journal des déclencheurs silencieux ────────────────────────────────
    // ⚠️ Lecture GARDÉE (comme la boîte) : le journal porte le CONTENU reçu par
    // les déclencheurs silencieux. Il n'est jamais affiché dans l'interface de
    // conversation — c'est la page de gestion qui le montre (lot 3).
    if (parts.length === 1 && parts[0] === "journal") {
      if (method !== "GET" && method !== "HEAD") {
        return json(405, { error: "method_not_allowed", method });
      }
      const guard = requireWriteGuards(input.headers);
      if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };
      const params = queryOf(input.path);
      const filtre = journalFilter(params);
      const limite = journalLimit(input.path);
      return json(200, {
        evenements: deps.journal?.recent(limite, filtre) ?? [],
        limite,
        types: DECLENCHEUR_EVENTS,
        filtre: {
          ...(filtre.types !== undefined ? { types: filtre.types } : {}),
          ...(filtre.source !== undefined ? { source: filtre.source } : {}),
        },
      });
    }

    // ── PRÉ-AUTORISATIONS (lot 26, lot 4/4) ────────────────────────────────
    // ⚠️ TOUTES ces routes sont GARDÉES (`X-Yuki-Config: 1` + `Origin`/`Host`) :
    // une pré-autorisation dit quelles commandes tourneront SANS validation
    // humaine sur une machine — c'est une donnée de sécurité.
    if (parts[0] === "preautorisations") {
      return handlePreAutorisations(input, parts);
    }

    // ── APERÇU du prochain passage (moteur horloge, lot 2) ─────────────────
    // ⚠️ Lecture GARDÉE (même en-tête que le reste de l'administration) : l'aperçu
    // révèle l'expression cron d'un déclencheur. INDISPENSABLE dans l'interface :
    // une expression fausse (ou impossible) se voit tout de suite, avec la raison.
    if (parts.length === 1 && parts[0] === "apercu") {
      if (method !== "GET" && method !== "HEAD") {
        return json(405, { error: "method_not_allowed", method });
      }
      const guard = requireWriteGuards(input.headers);
      if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };
      const params = queryOf(input.path);
      const depuis = instantOu(params.get("depuis"), Date.now());
      const combien = nombreOu(params.get("combien"), 3);
      return json(
        200,
        apercuCron(
          params.get("expression") ?? "",
          params.get("fuseau") ?? undefined,
          depuis,
          combien,
        ),
      );
    }

    // ── Boîte « Notifications » ────────────────────────────────────────────
    if (parts[0] === "inbox") {
      // `await` OBLIGATOIRE : sans lui, une erreur du handler sortirait du
      // `try/catch` ci-dessous et deviendrait un rejet de promesse.
      return await handleInbox(input, parts);
    }

    // ── Message poussé par une source (authentification par JETON) ─────────
    if (parts.length === 2 && parts[1] === "messages") {
      if (method !== "POST") {
        return json(405, { error: "method_not_allowed", method });
      }
      if (!isJsonContentType(input.headers)) {
        return json(415, {
          error: "unsupported_media_type",
          code: "unsupported_media_type",
          message:
            "Content-Type « application/json » attendu (le multipart n'est pas accepté : " +
            "seul du TEXTE est pris en charge).",
        });
      }
      const delivery = await deps.service.receive(parts[0], bearerToken(input.headers), parseJsonBody(input.body));
      if (delivery.outcome === "duplicate") {
        return json(200, {
          duplicate: true,
          message: "Ce message a déjà été reçu (idempotence de 7 jours) : aucun tour n'a été relancé.",
          ...(delivery.entree ? { entree: entryBody(delivery.entree) } : {}),
        });
      }
      // ⚠️ Un déclencheur SILENCIEUX ne produit AUCUNE entrée dans la boîte : la
      // réponse n'en porte donc pas toujours une.
      return json(202, {
        ...(delivery.outcome === "started"
          ? { started: true }
          : delivery.outcome === "stored"
            ? { stored: true }
            : { started: false, stored: false }),
        ...(delivery.entree ? { entree: entryBody(delivery.entree) } : {}),
        ...(delivery.raison !== undefined ? { raison: delivery.raison } : {}),
      });
    }

    // ── Création du jeton d'une source ─────────────────────────────────────
    if (parts.length === 2 && parts[1] === "jeton") {
      if (method !== "POST") return json(405, { error: "method_not_allowed", method });
      const guard = requireWriteGuards(input.headers);
      if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };
      const token = deps.service.createToken(parts[0]);
      return json(200, {
        source: parts[0],
        // ⚠️ UNE SEULE FOIS : la valeur n'est jamais réaffichée ensuite.
        jeton: token,
        message:
          "Notez ce jeton maintenant : il ne sera plus jamais affiché. " +
          "Il vit dans le coffre de secrets (YUKI_SOURCE_…) et peut être remplacé par " +
          "un nouveau clic sur « Nouveau jeton ».",
      });
    }

    // ── Administration d'une source ────────────────────────────────────────
    // `parts` est VIDE pour `/api/sources` lui-même (création + liste).
    if (parts.length === 0) {
      if (method === "GET" || method === "HEAD") {
        // ⚠️ LECTURE GARDÉE : la liste porte les CONSIGNES et les destinations de
        // chaque programme branché — la MÊME garde que les mutations.
        const guard = requireWriteGuards(input.headers);
        if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };
        // Conversations proposables au sélecteur « Envoyer dans : » de `/config`
        // (liste VIDE en mode dégradé : on n'invente aucune conversation).
        const conversations = await deps.service.conversationList();
        // ⚠️ DERNIER ÉVÉNEMENT de journal par source : colonne « dernier résultat »
        // de la page de gestion. Lecture BORNÉE (une seule lecture, partagée).
        const derniers = derniersEvenements(deps.journal);
        return json(200, {
          sources: deps.service.list().map((view) => ({
            ...view,
            ...(derniers.has(view.nom) ? { dernierEvenement: derniers.get(view.nom) } : {}),
            // ⚠️ LOT 4/4 : la colonne « pré-autorisations actives » de la page de
            // gestion est remplie ICI, depuis le REGISTRE (et non depuis
            // `sources.json`, qui ne les porte pas). Une liste vide reste une
            // liste vide — jamais une case muette.
            ...(deps.preAutorisations
              ? {
                  preAutorisations: deps.preAutorisations
                    .activesPour(view.nom)
                    .map((pre) => `${texteMotif(pre)} (agent ${pre.agentId})`),
                }
              : {}),
          })),
          conversations,
        });
      }
      if (method === "POST") {
        const guard = requireWriteGuards(input.headers);
        if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };
        const body = parseJsonBody(input.body);
        const nom =
          body && typeof body === "object" && !Array.isArray(body)
            ? String((body as Record<string, unknown>)["nom"] ?? "")
            : "";
        const view = deps.service.create(nom, settingsFrom(body));
        return json(201, { source: view });
      }
      return json(405, { error: "method_not_allowed", method });
    }

    // `/api/sources/<nom>` : lecture GARDÉE (comme la liste), mutations GARDÉES.
    if (parts.length === 1) {
      const nom = parts[0];
      if (method === "GET" || method === "HEAD") {
        const guard = requireWriteGuards(input.headers);
        if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };
        const view = deps.service.get(nom);
        if (!view) {
          return json(404, {
            error: "unknown_source",
            code: "unknown_source",
            message: `Source inconnue : « ${nom} ».`,
          });
        }
        return json(200, { source: view });
      }
      if (method === "PATCH" || method === "PUT") {
        const guard = requireWriteGuards(input.headers);
        if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };
        const view = deps.service.update(nom, settingsFrom(parseJsonBody(input.body)));
        return json(200, { source: view });
      }
      if (method === "DELETE") {
        const guard = requireWriteGuards(input.headers);
        if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };
        if (!deps.service.remove(nom)) {
          return json(404, {
            error: "unknown_source",
            code: "unknown_source",
            message: `Source inconnue : « ${nom} ».`,
          });
        }
        return json(200, { removed: true, source: nom });
      }
      return json(405, { error: "method_not_allowed", method });
    }

    // Toute autre forme (`/api/sources/<nom>/<autre>`) n'existe pas : 404 explicite.
    return json(404, { error: "not_found", path });
  } catch (error) {
    return errorBody(error);
  }
}

/**
 * ROUTES des PRÉ-AUTORISATIONS — `/api/sources/preautorisations`.
 *
 *   GET    /api/sources/preautorisations
 *        → { preAutorisations, motifs, agents, dureeDefautJours, dureeMaxJours }
 *   POST   /api/sources/preautorisations
 *        → { preAutorisation } (201) · 400 (motif/déclencheur/agent refusé)
 *   DELETE /api/sources/preautorisations/<id>  → { revoked: true } (révocation)
 *
 * ⚠️ LECTURE ET ÉCRITURE gardées par `requireWriteGuards` : la route liste ce
 * qui peut s'exécuter SANS validation humaine sur une machine.
 * ⚠️ Le CATALOGUE des motifs (`MOTIFS_PROPOSES`) est servi par le serveur : la
 * page n'a pas sa propre copie, donc pas de dérive.
 */
function handlePreAutorisations(
  input: SourcesRequestInput,
  parts: string[],
): SourcesHttpResponse {
  const { method, deps } = input;
  const guard = requireWriteGuards(input.headers);
  if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };

  const registre = deps.preAutorisations;
  const maintenant = Date.now();
  const nomDeLAgent = (agentId: string): string | undefined => {
    const trouve = deps.agents?.list().find((agent) => agent.agentId === agentId);
    if (!trouve) return undefined;
    return trouve.name !== undefined && trouve.name !== "" ? trouve.name : trouve.agentId;
  };

  // `/api/sources/preautorisations/<id>` — révocation uniquement.
  if (parts.length === 2) {
    if (method !== "DELETE") return json(405, { error: "method_not_allowed", method });
    if (!registre) {
      return json(503, {
        error: "preautorisations_unavailable",
        code: "preautorisations_unavailable",
        message: "Le registre des pré-autorisations n'est pas câblé sur cette instance.",
      });
    }
    const id = decodeURIComponent(parts[1] as string);
    const existante = registre.get(id);
    if (!existante) {
      return json(404, {
        error: "unknown_preautorisation",
        code: "unknown_preautorisation",
        message: `Pré-autorisation inconnue : « ${id} ».`,
      });
    }
    registre.revoquer(id, "révocation demandée depuis la page de gestion");
    const apres = registre.get(id) ?? existante;
    return json(200, {
      revoked: true,
      preAutorisation: preAutorisationBody(apres, maintenant, nomDeLAgent(apres.agentId)),
    });
  }

  if (parts.length !== 1) {
    return json(404, { error: "not_found", path: input.path });
  }

  if (method === "GET" || method === "HEAD") {
    const liste = registre?.list() ?? [];
    return json(200, {
      preAutorisations: liste
        .slice()
        .sort((a, b) => Date.parse(b.creeLe) - Date.parse(a.creeLe))
        .map((pre) => preAutorisationBody(pre, maintenant, nomDeLAgent(pre.agentId))),
      motifs: MOTIFS_PROPOSES,
      agents: deps.agents?.list() ?? [],
      dureeDefautJours: DUREE_DEFAUT_JOURS,
      dureeMaxJours: DUREE_MAX_JOURS,
      limite: MAX_PREAUTORISATIONS,
      portees: ["exacte", "prefixe"],
    });
  }

  if (method !== "POST") return json(405, { error: "method_not_allowed", method });
  if (!registre) {
    return json(503, {
      error: "preautorisations_unavailable",
      code: "preautorisations_unavailable",
      message: "Le registre des pré-autorisations n'est pas câblé sur cette instance.",
    });
  }
  const body = parseJsonBody(input.body);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SourceApiError(400, "invalid_body", "Objet JSON attendu.");
  }
  const raw = body as Record<string, unknown>;
  const declencheur = typeof raw["declencheur"] === "string" ? raw["declencheur"].trim() : "";
  if (declencheur === "" || !deps.service.get(declencheur)) {
    return json(400, {
      error: "unknown_source",
      code: "unknown_source",
      message: `Déclencheur inconnu : « ${declencheur} ». Créez-le d'abord.`,
    });
  }
  const agentId = typeof raw["agentId"] === "string" ? raw["agentId"].trim() : "";
  const agent = deps.agents?.list().find((item) => item.agentId === agentId);
  if (agentId === "" || !agent) {
    return json(400, {
      error: "unknown_agent",
      code: "unknown_agent",
      message:
        `Agent inconnu : « ${agentId} ». Une pré-autorisation est TOUJOURS liée à une ` +
        "machine appairée précise : appairez-la d'abord.",
    });
  }
  if (agent.revoked === true) {
    return json(400, {
      error: "revoked_agent",
      code: "revoked_agent",
      message: `L'agent « ${agentId} » est révoqué : il ne peut rien exécuter.`,
    });
  }
  const creee = registre.creer({
    declencheur,
    agentId,
    motif: raw["motif"],
    ...(raw["portee"] !== undefined ? { portee: raw["portee"] } : {}),
    ...(raw["destructifAutorise"] !== undefined
      ? { destructifAutorise: raw["destructifAutorise"] }
      : {}),
    ...(raw["dureeJours"] !== undefined ? { dureeJours: raw["dureeJours"] } : {}),
  });
  return json(201, {
    preAutorisation: preAutorisationBody(creee, maintenant, nomDeLAgent(creee.agentId)),
  });
}

/** Paramètres de requête d'un chemin (jamais une exception : chaîne vide sinon). */
function queryOf(path: string): URLSearchParams {
  const at = path.indexOf("?");
  return new URLSearchParams(at < 0 ? "" : path.slice(at + 1));
}

/** Instant ISO d'un paramètre (`depuis`) ; repli sur `defaut` si illisible. */
function instantOu(raw: string | null, defaut: number): number {
  if (raw === null || raw === "") return defaut;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : defaut;
}

/** Entier borné d'un paramètre (1 à 10). */
function nombreOu(raw: string | null, defaut: number): number {
  const valeur = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(valeur)) return defaut;
  return Math.min(10, Math.max(1, Math.trunc(valeur)));
}

/** Borne du nombre d'événements renvoyés par `GET /api/sources/journal`. */
function journalLimit(path: string): number {
  const at = path.indexOf("?");
  const raw = at < 0 ? null : new URLSearchParams(path.slice(at + 1)).get("limite");
  const value = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return 50;
  return Math.min(200, Math.max(1, Math.trunc(value)));
}

/**
 * Filtre de la route du journal : `type` (liste séparée par des virgules) et
 * `source` (nom exact). ⚠️ Un type INCONNU est refusé (400) : un filtre muet qui
 * rendrait « aucun événement » ferait croire que le journal est vide.
 */
const EMPTY_FILTER: DeclencheurJournalFilter = {};

function journalFilter(params: URLSearchParams): DeclencheurJournalFilter {
  const filter: DeclencheurJournalFilter = {};
  const rawType = params.get("type");
  if (rawType !== null && rawType.trim() !== "" && rawType.trim() !== "tous") {
    const demandes = rawType
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value !== "");
    const types: DeclencheurEvent[] = [];
    for (const demande of demandes) {
      if (!isDeclencheurEvent(demande)) {
        throw new SourceApiError(
          400,
          "invalid_journal_type",
          `Type d'événement inconnu : « ${demande} ». Types acceptés : ` +
            DECLENCHEUR_EVENTS.join(", ") + ".",
        );
      }
      types.push(demande);
    }
    if (types.length > 0) filter.types = types;
  }
  const source = params.get("source");
  if (source !== null && source.trim() !== "") filter.source = source.trim();
  return filter.types === undefined && filter.source === undefined ? EMPTY_FILTER : filter;
}

/**
 * Dernier événement de journal de CHAQUE source (lecture bornée, une seule fois).
 *
 * Le contenu éventuel est réduit à un RÉSUMÉ court : la page de gestion affiche
 * « dernier résultat », pas le journal complet (qui a son propre volet).
 */
function derniersEvenements(
  journal: SourcesApiDeps["journal"],
): Map<string, { ts: string; event: string; raison?: string; resume?: string }> {
  const map = new Map<string, { ts: string; event: string; raison?: string; resume?: string }>();
  if (!journal) return map;
  for (const record of journal.recent(500)) {
    if (map.has(record.source)) continue;
    map.set(record.source, {
      ts: record.ts,
      event: record.event,
      ...(record.raison !== undefined ? { raison: record.raison } : {}),
      ...(record.texte !== undefined
        ? { resume: record.texte.replace(/\s+/g, " ").trim().slice(0, 200) }
        : {}),
    });
  }
  return map;
}

/** `Content-Type` JSON accepté (le multipart est refusé : texte seul en v1). */
function isJsonContentType(headers: IncomingHttpHeaders): boolean {
  const raw = (headerString(headers, "content-type") ?? "").toLowerCase();
  if (raw === "") return true; // pas d'en-tête (curl minimal) : on accepte le JSON
  return raw.startsWith("application/json") || raw.includes("+json");
}

/** Routes de la boîte de notifications. */
async function handleInbox(
  input: SourcesRequestInput,
  parts: string[],
): Promise<SourcesHttpResponse> {
  const { method, deps } = input;
  // ⚠️ TOUTE la boîte est gardée — y compris la LECTURE : les entrées portent le
  // CONTENU des messages de sources et les réponses de Yuki. Une page tierce ne doit
  // ni les lire, ni les marquer lues, ni créer une conversation.
  const guard = requireWriteGuards(input.headers);
  if (guard) return { status: guard.status, body: guard.body, headers: guard.headers };
  // GET /api/sources/inbox
  if (parts.length === 1) {
    if (method !== "GET" && method !== "HEAD") {
      return json(405, { error: "method_not_allowed", method });
    }
    const view = deps.service.inboxView();
    return json(200, {
      entries: view.entries.map(entryBody),
      nonLus: view.nonLus,
      limite: view.limite,
    });
  }
  // POST /api/sources/inbox/lu — tout marquer comme lu
  if (parts.length === 2 && parts[1] === "lu") {
    if (method !== "POST") return json(405, { error: "method_not_allowed", method });
    const changed = deps.service.markAllRead();
    const view = deps.service.inboxView();
    return json(200, { changed, nonLus: view.nonLus });
  }
  if (parts.length === 3) {
    const id = parts[1];
    if (parts[2] === "lu") {
      if (method !== "POST") return json(405, { error: "method_not_allowed", method });
      const entry = deps.service.markRead(id);
      return json(200, { entree: entryBody(entry), nonLus: deps.service.inboxView().nonLus });
    }
    if (parts[2] === "ouvrir") {
      if (method !== "POST") return json(405, { error: "method_not_allowed", method });
      const result: SourceOpenResult = await deps.service.openConversation(id);
      return json(200, {
        entree: entryBody(result.entree),
        sessionId: result.sessionId,
        created: result.created,
      });
    }
  }
  if (parts.length === 2 && method === "DELETE") {
    const entry = deps.service.removeEntry(parts[1]);
    return json(200, { removed: true, entree: entryBody(entry) });
  }
  return json(404, { error: "not_found", path: input.path });
}
