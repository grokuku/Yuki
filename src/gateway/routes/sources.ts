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
  SourceApiError,
  SourceValidationError,
  SourcesFullError,
  type SourceConversation,
  type SourceOpenResult,
  type SourcesLogger,
  type SourcesService,
} from "../../sources/index.js";
import { requireWriteGuards } from "./config.js";

export interface SourcesApiDeps {
  service: SourcesService;
  logger: SourcesLogger;
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

/** Segment de chemin après `/api/sources/` (vide si aucun). */
function segments(path: string): string[] {
  return path.slice("/api/sources".length).split("/").filter((part) => part !== "");
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

/** Réglages acceptés par la création/modification d'une source. */
function settingsFrom(body: unknown): {
  consigne?: string;
  conversation?: SourceConversation;
  tour?: "lancer" | "stocker";
  notifier?: boolean;
} {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new SourceApiError(400, "invalid_body", "Objet JSON attendu.");
  }
  const raw = body as Record<string, unknown>;
  const settings: {
    consigne?: string;
    conversation?: SourceConversation;
    tour?: "lancer" | "stocker";
    notifier?: boolean;
  } = {};
  if (raw["consigne"] !== undefined) settings.consigne = String(raw["consigne"]);
  if (raw["conversation"] !== undefined) {
    // ⚠️ `conversation` est un MODE ou l'identifiant d'une conversation existante :
    // la FORME est validée par le store, qui refuse tout le reste (aucun repli muet).
    if (typeof raw["conversation"] !== "string") {
      throw new SourceApiError(
        400,
        "invalid_conversation",
        "Champ « conversation » : chaîne attendue.",
      );
    }
    settings.conversation = raw["conversation"].trim();
  }
  if (raw["tour"] !== undefined) settings.tour = raw["tour"] as "lancer" | "stocker";
  if (raw["notifier"] !== undefined) settings.notifier = raw["notifier"] === true;
  return settings;
}

/** Traite une requête de l'API des sources (asynchrone : `/ouvrir` attend le host). */
export async function handleSourcesRequest(
  input: SourcesRequestInput,
): Promise<SourcesHttpResponse> {
  const { method, path, deps } = input;
  const parts = segments(path);

  try {
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
      return json(202, {
        ...(delivery.outcome === "started" ? { started: true } : { stored: true }),
        entree: entryBody(delivery.entree as NonNullable<typeof delivery.entree>),
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
        // Conversations proposables au sélecteur « Envoyer dans : » de `/config`
        // (liste VIDE en mode dégradé : on n'invente aucune conversation).
        const conversations = await deps.service.conversationList();
        return json(200, { sources: deps.service.list(), conversations });
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
