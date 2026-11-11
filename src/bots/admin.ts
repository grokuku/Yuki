/**
 * ADMINISTRATION DES BOTS (lot 35e) — AJOUTER, CLONER, SUPPRIMER, PURGER.
 *
 * Ce module est le SEUL endroit qui manipule les DOSSIERS des bots :
 *
 *  - `creerBot`      : `mkdir <state>/bots/<slug>/` + entrée du registre
 *    (+ copie des éléments choisis quand on clone un bot existant) ;
 *  - `supprimerBot`  : ⚠️ **n'efface RIEN** — `rename` du dossier vers
 *    `<state>/bots-supprimes/<slug>-<AAAAMMJJ-HHMM>/` (même volume, donc
 *    atomique) puis retrait de l'entrée du registre ; ⚠️ LOT 35i : il déplace
 *    AUSSI les **sessions Pi** du bot (`<pi>/agent/sessions/<id>`), qui vivent
 *    sur un AUTRE volume (copie + suppression, jamais `rename`) ;
 *  - `purgerArchivesBots` : purge RÉELLE des archives de plus de 90 jours
 *    (sessions Pi comprises), appelée par le BALAYEUR EXISTANT
 *    (`src/sources/scheduler.ts`) ;
 *  - `compterDonneesBot` : compteurs RÉELS de la confirmation de suppression.
 *
 * ## ⚠️ Ce qu'un clone ne copie JAMAIS
 * Un bot cloné avec la mémoire de Yuki **croirait avoir vécu la même chose** :
 * la mémoire et les déclencheurs sont donc DÉCOCHÉS par défaut. Surtout, une
 * liste NOIRE explicite (`JAMAIS_COPIES`) interdit la copie de ce qui
 * n'appartient qu'à UN bot ou à l'instance :
 *
 *   `chat-mirror.json` / `chat-mirror/` (un canal appartient à UN seul bot),
 *   `conversations-archive*`, `jobs.jsonl`, `preautorisations.json`,
 *   `envois-programmes.json`, `session-pins.json`, `reactions.jsonl`,
 *   `librarian-*`, et l'index de recherche (`memory-index.sqlite`, DÉRIVÉ et
 *   reconstruit au démarrage : une copie à chaud serait déchirée).
 *
 * ⚠️ Les SESSIONS Pi ne sont jamais copiées non plus par un CLONE : elles
 * vivent sur un AUTRE volume (`<pi>/agent/sessions/<slug>`), et un clone n'a
 * pas à hériter des conversations vécues de l'original. ⚠️ En revanche une
 * SUPPRESSION les ARCHIVE (voir `ResultatSessionsPi`) : jamais de conversation
 * perdue en silence.
 *
 * ## Agents autorisés (lot 35g)
 * La décision utilisateur est que les agents sont GLOBAUX et que chaque agent
 * porte la LISTE des bots autorisés à l'utiliser (`AgentRecord.bots`).
 * `supprimerBot` accepte donc un rappel `retirerDesListesDAgents` : il est
 * FOURNI par le câblage (`src/index.ts`) et retire l'identifiant supprimé de
 * toutes les listes, SANS jamais supprimer d'agent. Sans rappel, la suppression
 * ne touche à aucune liste d'agents.
 *
 * Aucun import SDK/typebox.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

import { AvatarRefusal, AvatarStore } from "../identity/avatar.js";
import { ConfigOverlayStore } from "../config/overlay.js";
import { resolveConfigOverlayPath } from "../config/paths.js";

import {
  CAPACITES_BOT,
  MAX_BOTS,
  ecrireRegistreBots,
  estCapaciteBot,
  estSlugBot,
  cheminRegistreBots,
  type BotRecord,
  type CapaciteBot,
  type EchangeBots,
  type RegistreBots,
} from "./registry.js";
import { MAX_ACTIFS_DEFAUT, botsAActiver, normaliserPlafond } from "./actifs.js";
import { SOUS_DOSSIER_BOTS } from "./paths.js";

/**
 * Nombre MAXIMAL de bots d'une instance (`409 max_bots` au-delà).
 * ⚠️ Ré-exporté depuis `registry.ts` (source unique, partagée avec le domaine
 * `agents` qui borne la liste des bots autorisés d'un agent).
 */
export { MAX_BOTS };

/** Longueur maximale du NOM affiché d'un bot (1..40). */
export const NOM_BOT_MAX = 40;

/** Sous-dossier des bots SUPPRIMÉS (même volume `state`, donc `rename`). */
export const SOUS_DOSSIER_SUPPRIMES = "bots-supprimes";

/**
 * Sous-dossier des SESSIONS Pi DÉPLACÉES, dans l'archive d'un bot supprimé
 * (lot 35i). C'est ce dossier que la purge des 90 jours efface avec le reste.
 */
export const SOUS_DOSSIER_SESSIONS_PI = "sessions-pi";

/**
 * Marqueur des sessions Pi qui n'ont PAS pu être archivées (lot 35i).
 *
 * ⚠️ Écrit dans l'archive : il nomme le dossier RESTÉ sur le volume `pi`, pour
 * que la purge des 90 jours sache quoi effacer — et pour que personne ne croie
 * que les conversations ont disparu. Une perte silencieuse est le seul
 * interdit absolu de cette opération.
 */
export const MARQUEUR_SESSIONS_RESTANTES = "sessions-pi-restantes.json";

/** Rétention des archives de bots supprimés : 3 mois (décision utilisateur). */
export const RETENTION_ARCHIVES_JOURS = 90;

/** Millisecondes d'un jour (rétention, âges). */
export const MS_PAR_JOUR = 86_400_000;

/** Nom du fichier d'overlay de configuration d'un bot (compat `src/config/paths.ts`). */
const OVERLAY_FICHIER = "config.overlay.json";

/** Code d'erreur d'administration (chaque refus a un code stable). */
export type CodeAdminBot =
  | "nom_invalide"
  | "slug_invalide"
  | "slug_deja_pris"
  | "max_bots"
  | "capacite_inconnue"
  | "bot_inconnu"
  | "dernier_bot"
  | "avatar_invalide"
  | "echec_fichier"
  // LOT 36 (L2) — on/off d'un bot.
  | "actif_invalide"
  | "plafond_actifs"
  | "dernier_bot_actif"
  // LOT 37 — on/off de la BOUCLE entre deux bots (`echanges["a->b"].actif`).
  | "echange_invalide"
  // LOT 37 — un NOM déjà porté par un autre bot : la création refuse le doublon
  // (« le slug on s'en fout » : c'est le nom que l'utilisateur lit).
  | "nom_deja_pris";

/** Refus EXPLICITE (code stable + message français actionnable). */
export class AdminBotError extends Error {
  override readonly name = "AdminBotError";
  constructor(
    readonly code: CodeAdminBot,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ── Éléments clonables ─────────────────────────────────────────────────────

/** Identifiants des éléments qu'un clone peut copier. */
export type IdElementClone =
  | "identite"
  | "capacites"
  | "memoire"
  | "declencheurs"
  | "agents";

/**
 * Définition d'un élément clonable. `chemins` sont RELATIFS à la racine du bot
 * (`<state>/bots/<slug>/`) et ne contiennent que des fichiers/dossiers du bot.
 */
export interface ElementClone {
  readonly id: IdElementClone;
  readonly libelle: string;
  readonly aide: string;
  readonly defaut: boolean;
  readonly chemins: readonly string[];
  /** `true` : l'élément n'existe pas encore dans le produit (aucune copie). */
  readonly indisponible?: boolean;
}

/**
 * ⚠️ DÉFAUTS DÉCIDÉS PAR L'UTILISATEUR : identité et capacités OUI, mémoire et
 * déclencheurs NON. « Agents » est là pour que la case existe dès maintenant,
 * mais elle ne copie RIEN (le champ « agents autorisés » n'existe pas encore).
 */
export const ELEMENTS_CLONE: readonly ElementClone[] = [
  {
    id: "identite",
    libelle: "Identité",
    aide: "Personnalité (personality.md), règles (rules.md) et avatar.",
    defaut: true,
    chemins: ["personality.md", "rules.md", "avatar"],
  },
  {
    id: "capacites",
    libelle: "Capacités et réglages",
    aide:
      "Capacités autorisées (onglet « Général ») et réglages de configuration du " +
      "bot (config.overlay.json).",
    defaut: true,
    chemins: [OVERLAY_FICHIER],
  },
  {
    id: "memoire",
    libelle: "Mémoire",
    aide:
      "Souvenirs (memory.jsonl), archives et héritage. ⚠️ Décoché par défaut : " +
      "un bot cloné AVEC la mémoire de l'original croirait avoir vécu la même chose.",
    defaut: false,
    chemins: ["memory.jsonl", "memory-archive", "memory-heritage", "memory-consolidation.json"],
  },
  {
    id: "declencheurs",
    libelle: "Déclencheurs",
    aide:
      "Sources (sources.json), boîte de réception et journal des déclencheurs. " +
      "Décoché par défaut : deux bots ne doivent pas tirer la même tâche.",
    defaut: false,
    chemins: ["sources.json", "sources-inbox.json", "declencheurs-journal.jsonl"],
  },
  {
    id: "agents",
    libelle: "Agents autorisés",
    aide:
      "⚠️ Pas encore disponible : la liste des bots autorisés par agent n'existe " +
      "pas encore. Cochez-la sans effet aujourd'hui (rien n'est copié).",
    defaut: false,
    chemins: [],
    indisponible: true,
  },
];

/**
 * ⚠️ JAMAIS copié, quelle que soit la case cochée. Cette liste est une GARDE
 * (une entrée d'élément qui la contredirait lève) et la référence des tests.
 */
export const JAMAIS_COPIES: readonly string[] = [
  // Un CANAL appartient à UN seul bot : copier son miroir le lui volerait.
  "chat-mirror.json",
  "chat-mirror",
  // Conversations : elles appartiennent à l'historique vécu de l'original.
  "conversations-archive",
  "conversations-archive-index.sqlite",
  // Travaux, pré-autorisations et envois en attente : liés à l'original.
  "jobs.jsonl",
  "preautorisations.json",
  "envois-programmes.json",
  "session-pins.json",
  "reactions.jsonl",
  "librarian-jobs.jsonl",
  "librarian-shots",
  // Index DÉRIVÉ (FTS/SQLite) : reconstruit au démarrage, jamais copié à chaud.
  "memory-index.sqlite",
];

/** Vrai si ce chemin relatif (ou son PREMIER segment) est interdit à la copie. */
export function estJamaisCopie(relatif: string): boolean {
  const premier = relatif.split(/[\\/]/)[0] ?? relatif;
  return JAMAIS_COPIES.some(
    (interdit) => interdit === relatif || interdit === premier,
  );
}

// ── Création ───────────────────────────────────────────────────────────────

export interface OptionsCreationBot {
  /** Volume `state` (racine de `bots/` et `bots-supprimes/`). */
  stateDir: string;
  /** Registre courant (déjà lu : la création ne relit pas le disque). */
  registre: RegistreBots;
  /**
   * Nom AFFICHÉ (obligatoire, 1..40 caractères).
   *
   * ⚠️ Le SLUG n'est plus demandé : il est DÉRIVÉ du nom et dédupliqué
   * (`slugLibrePour`). L'utilisateur ne saisit plus d'identifiant technique.
   */
  nom: unknown;
  /**
   * Éléments à copier quand on clone. Absent/`undefined` ⇒ DÉFAUTS de
   * `ELEMENTS_CLONE`. Une case cochée inconnue lève (`echec_fichier`).
   */
  elements?: Record<string, unknown>;
  /** Slug du bot à cloner (`null`/absent ⇒ création de zéro). */
  cloneDe?: unknown;
  /** Avatar facultatif, en `data:` URL (PNG/JPEG/WebP, ≤ `AVATAR_MAX_BYTES`). */
  avatar?: unknown;
  /** Horloge injectable (tests). */
  maintenant?: number;
}

export interface ResultatCreationBot {
  registre: RegistreBots;
  bot: BotRecord;
  /** Éléments RÉELLEMENT copiés (vide pour une création de zéro). */
  copies: IdElementClone[];
}

/** Nom affiché : non vide, borné à 40 caractères, sans caractère de contrôle. */
/**
 * Clé de comparaison d'un NOM de bot : espaces condensés, casse ignorée.
 *
 * ⚠️ Deux noms qui ne diffèrent que par la casse ou les espaces sont le MÊME nom
 * pour l'utilisateur : `creerBot` les refuse (`409 nom_deja_pris`).
 */
export function cleNomBot(nom: unknown): string {
  return String(nom ?? "")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("fr-FR");
}

export function validerNomBot(nom: unknown): string {
  if (typeof nom !== "string") {
    throw new AdminBotError("nom_invalide", 400, "Le nom du bot est obligatoire.");
  }
  const propre = nom.trim();
  if (propre.length === 0) {
    throw new AdminBotError("nom_invalide", 400, "Le nom du bot est obligatoire.");
  }
  if (propre.length > NOM_BOT_MAX) {
    throw new AdminBotError(
      "nom_invalide",
      400,
      `Le nom du bot est trop long (${propre.length} caractères, maximum ${NOM_BOT_MAX}).`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(propre)) {
    throw new AdminBotError("nom_invalide", 400, "Le nom du bot contient un caractère de contrôle.");
  }
  return propre;
}

/** Slug : `^[a-z0-9][a-z0-9-]{1,30}$`, IMMUABLE (il nomme un dossier). */
export function validerSlugBot(slug: unknown): string {
  if (!estSlugBot(slug)) {
    throw new AdminBotError(
      "slug_invalide",
      400,
      "Slug invalide : 2 à 31 caractères, minuscules, chiffres et « - » uniquement, " +
        "commençant par une lettre ou un chiffre (exemple : « kohai-2 »).",
    );
  }
  return slug;
}

/**
 * CAPACITÉS demandées : tableau de clés CONNUES, `[]` par défaut.
 *
 * ⚠️ Une capacité inconnue est REFUSÉE (`400 capacite_inconnue`) — jamais ignorée
 * en silence : un client qui envoie `{"capacites": ["tout"]}` doit apprendre que
 * ce n'est pas une capacité, pas croire qu'elle a été prise en compte.
 *
 * ⚠️ L'ordre canonique (`CAPACITES_BOT`) est rétabli et les doublons disparaissent :
 * le fichier du registre reste stable d'une écriture à l'autre.
 */
export function validerCapacitesBot(capacites: unknown): CapaciteBot[] {
  if (capacites === undefined || capacites === null) return [];
  if (!Array.isArray(capacites)) {
    throw new AdminBotError(
      "capacite_inconnue",
      400,
      "Les capacités doivent être une liste (exemple : [\"envoi\", \"libraire\"]).",
    );
  }
  const demandees = new Set<CapaciteBot>();
  for (const capacite of capacites as unknown[]) {
    if (!estCapaciteBot(capacite)) {
      throw new AdminBotError(
        "capacite_inconnue",
        400,
        `Capacité inconnue : ${JSON.stringify(capacite)} ` +
          `(connues : ${CAPACITES_BOT.join(", ")}).`,
      );
    }
    demandees.add(capacite);
  }
  return CAPACITES_BOT.filter((capacite) => demandees.has(capacite));
}

/**
 * SLUG libre dérivé d'un NOM : `Kohai 2` ⇒ `kohai-2`, puis `kohai-2-2`, `-3`…
 *
 * ⚠️ Le slug est IMMUABLE (il nomme un dossier et des chemins) mais il n'est plus
 * demandé à l'utilisateur : il est calculé ici, de façon lisible et dédupliquée.
 * Deux bots peuvent porter le même NOM ; seuls les slugs sont uniques.
 *
 * ⚠️ On évite aussi un DOSSIER déjà présent (`bots/<slug>/`), pas seulement une
 * entrée du registre : un dossier orphelin (création interrompue) rendrait la
 * création impossible avec un message incompréhensible.
 */
export function slugLibrePour(
  stateDir: string,
  registre: RegistreBots,
  nom: string,
): string {
  const base = slugifier(nom);
  const pris = new Set(registre.bots.map((bot) => bot.id));
  const libre = (candidat: string) =>
    !pris.has(candidat) &&
    !existsSync(join(stateDir, SOUS_DOSSIER_BOTS, candidat));
  if (libre(base)) return base;
  for (let rang = 2; rang < 1_000; rang += 1) {
    const suffixe = `-${rang}`;
    const candidat = `${base.slice(0, 31 - suffixe.length).replace(/-+$/g, "")}${suffixe}`;
    if (libre(candidat)) return candidat;
  }
  // ⚠️ Inatteignable en pratique (plafond `MAX_BOTS`), mais on ne rend jamais un
  // slug déjà pris : un slug horodaté est toujours libre.
  return `bot-${Date.now().toString(36)}`.slice(0, 31);
}

/** Slug technique d'un nom libre (2..31 caractères, motif `SLUG_BOT_PATTERN`). */
function slugifier(nom: string): string {
  const base = String(nom ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    // ⚠️ 27 caractères : il doit rester la place du suffixe de déduplication (`-12`).
    .slice(0, 27)
    .replace(/-+$/g, "");
  // Un nom sans lettre ni chiffre (« !!! ») ou d'un seul caractère donnerait un
  // slug refusé par le motif : on retombe sur un identifiant TOUJOURS valide.
  if (base === "") return "bot";
  if (base.length < 2) return `${base}-bot`;
  return base;
}

/** Éléments demandés : les inconnus sont REFUSÉS (jamais ignorés en silence). */
export function elementsDemandes(
  elements: Record<string, unknown> | undefined,
  clone: boolean,
): Set<IdElementClone> {
  const actifs = new Set<IdElementClone>();
  if (!clone) return actifs; // sans clone, aucune case n'a de sens
  for (const element of ELEMENTS_CLONE) {
    const demande = elements?.[element.id];
    const actif = demande === undefined ? element.defaut : demande === true;
    if (actif && !element.indisponible && element.chemins.length > 0) {
      actifs.add(element.id);
    }
  }
  for (const cle of Object.keys(elements ?? {})) {
    if (!ELEMENTS_CLONE.some((element) => element.id === cle)) {
      throw new AdminBotError(
        "echec_fichier",
        400,
        `Élément de clone inconnu : ${JSON.stringify(cle)}.`,
      );
    }
  }
  return actifs;
}

/**
 * CRÉE un bot : dossiers, overlay, avatar puis entrée du registre.
 *
 * ⚠️ CRÉATION SIMPLE (décision utilisateur du 2026-11-10) : on ne demande QUE le
 * nom (et, facultativement, un avatar). Le slug est DÉRIVÉ et dédupliqué
 * (`slugLibrePour`), les capacités sont VIDES — le bot ne peut que répondre tant
 * que l'utilisateur ne l'a pas autorisé, dans l'onglet « Général » de `/bots`.
 *
 * ⚠️ Ordre : le DOSSIER d'abord, le REGISTRE en dernier. Une coupure entre les
 * deux laisse un dossier orphelin (inoffensif, jamais listé) plutôt qu'un bot
 * déclaré dont les chemins n'existent pas. Si l'écriture du registre échoue, la
 * copie est ANNULÉE (le dossier vient d'être créé : rien d'autre n'y vit).
 */
export function creerBot(options: OptionsCreationBot): ResultatCreationBot {
  const nom = validerNomBot(options.nom);
  const registre = options.registre;
  const stateDir = options.stateDir;
  const maintenant = options.maintenant ?? Date.now();

  if (registre.bots.length >= MAX_BOTS) {
    throw new AdminBotError(
      "max_bots",
      409,
      `Limite de ${MAX_BOTS} bots atteinte : supprimez un bot avant d'en ajouter un autre.`,
    );
  }
  /**
   * ⚠️ NOM DÉJÀ PRIS — REFUS, pas de doublon silencieux.
   *
   * Deux bots nommés « Grolaf » (`grolaf`, `grolaf-2`) étaient indistinguables
   * dans la barre du haut, et l'utilisateur n'avait aucun moyen de voir qu'il
   * créait un second « Grolaf ». Le nom est ce qu'il lit : c'est le nom qu'on
   * compare (casse et espaces ignorés, comme le fait l'UI avant l'appel).
   *
   * ⚠️ Les doublons DÉJÀ présents ne sont pas touchés : ils restent lisibles et
   * supprimables (menu de la barre du haut).
   */
  const nomPris = registre.bots.find((bot) => cleNomBot(bot.nom) === cleNomBot(nom));
  if (nomPris !== undefined) {
    throw new AdminBotError(
      "nom_deja_pris",
      409,
      `Un bot nommé « ${nom} » existe déjà. Choisissez un autre nom.`,
    );
  }
  const slug = slugLibrePour(stateDir, registre, nom);

  const source =
    options.cloneDe === undefined || options.cloneDe === null || options.cloneDe === ""
      ? null
      : String(options.cloneDe);
  if (source !== null && !registre.bots.some((bot) => bot.id === source)) {
    throw new AdminBotError(
      "bot_inconnu",
      404,
      `Le bot à cloner « ${source} » n'existe pas dans le registre.`,
    );
  }
  const copies = source === null
    ? new Set<IdElementClone>()
    : elementsDemandes(
        options.elements as Record<string, unknown> | undefined,
        true,
      );

  const racine = join(stateDir, SOUS_DOSSIER_BOTS, slug);
  if (existsSync(racine)) {
    // ⚠️ `slugLibrePour` évite déjà un dossier existant : cette garde protège d'une
    // course entre le calcul du slug et la création (deux requêtes simultanées).
    throw new AdminBotError(
      "slug_deja_pris",
      409,
      `Un dossier existe déjà pour « ${slug} » (${racine}).`,
    );
  }

  try {
    mkdirSync(racine, { recursive: true, mode: 0o700 });
    if (source !== null) {
      copierElements(stateDir, source, slug, copies);
    }
    // Overlay : un fichier PLAT explicite, vide quand on part de zéro (la copie
    // de « capacités » a pu le poser juste avant).
    const overlay = new ConfigOverlayStore(resolveConfigOverlayPath(stateDir, slug));
    if (!overlay.exists()) overlay.write({});
    ecrireAvatar(stateDir, slug, options.avatar);
  } catch (error) {
    rmSync(racine, { recursive: true, force: true });
    throw traduireErreurFichier(error, "La création du bot a échoué");
  }

  const ordre = registre.bots.reduce((max, bot) => Math.max(max, bot.ordre), -1) + 1;
  // ⚠️ AUCUNE capacité à la création : « de base un bot ajouté ne peut rien
  // faire » (décision utilisateur). Elles s'ouvrent dans l'onglet « Général ».
  // ⚠️ EXCEPTION explicite : un CLONE dont la case « Capacités et réglages » est
  // cochée reprend les capacités de son modèle — l'utilisateur les avait déjà
  // autorisées là-bas. Case décochée ⇒ `[]`, comme un bot neuf.
  const sourceRecord =
    source === null ? null : (registre.bots.find((bot) => bot.id === source) ?? null);
  const capacites =
    sourceRecord !== null && copies.has("capacites") ? [...sourceRecord.capacites] : [];
  const bot: BotRecord = {
    id: slug,
    nom,
    capacites,
    // ⚠️ Le bot CRÉÉ n'est pas le bot ACTIF : le gateway en cours applique le
    // bot résolu à son démarrage. Le drapeau ne bougera qu'à une promotion
    // explicite (suppression du bot actif) — jamais à la création.
    actif: false,
    ordre,
    creeLe: new Date(maintenant).toISOString(),
    plateformes: {},
  };
  const suivant: RegistreBots = { ...registre, bots: [...registre.bots, bot] };
  try {
    ecrireRegistreBots(cheminRegistreBots(stateDir), suivant);
  } catch (error) {
    rmSync(racine, { recursive: true, force: true });
    throw traduireErreurFichier(error, "L'enregistrement du bot a échoué");
  }
  return { registre: suivant, bot, copies: [...copies] };
}

// ── Modification (nom, capacités) ───────────────────────────────────────────

export interface OptionsModificationBot {
  /** Volume `state` (le registre vit à sa racine). */
  stateDir: string;
  /** Registre courant (déjà lu). */
  registre: RegistreBots;
  botId: string;
  /** Nouveau nom affiché. Absent ⇒ inchangé. */
  nom?: unknown;
  /** Nouvelles capacités (liste de clés connues). Absent ⇒ inchangées. */
  capacites?: unknown;
}

export interface ResultatModificationBot {
  registre: RegistreBots;
  bot: BotRecord;
}

/**
 * MODIFIE un bot existant : son NOM et/ou ses CAPACITÉS.
 *
 * ⚠️ Le SLUG n'est jamais modifiable : il nomme un dossier et des chemins. C'est
 * pour cela qu'il n'apparaît pas ici (aucune route de renommage technique).
 *
 * ⚠️ Une capacité inconnue est REFUSÉE (`400 capacite_inconnue`) : le registre ne
 * contient jamais une clé que le produit n'interprète pas.
 */
export function modifierBot(options: OptionsModificationBot): ResultatModificationBot {
  const registre = options.registre;
  const index = registre.bots.findIndex((bot) => bot.id === options.botId);
  if (index < 0) {
    throw new AdminBotError("bot_inconnu", 404, `Bot inconnu : « ${options.botId} ».`);
  }
  const actuel = registre.bots[index] as BotRecord;
  const nom = options.nom === undefined ? actuel.nom : validerNomBot(options.nom);
  const capacites =
    options.capacites === undefined
      ? [...actuel.capacites]
      : validerCapacitesBot(options.capacites);
  const bot: BotRecord = { ...actuel, nom, capacites };
  const bots = [...registre.bots];
  bots[index] = bot;
  const suivant: RegistreBots = { ...registre, bots };
  try {
    ecrireRegistreBots(cheminRegistreBots(options.stateDir), suivant);
  } catch (error) {
    throw traduireErreurFichier(error, "L'enregistrement du bot a échoué");
  }
  return { registre: suivant, bot };
}

// ── On/off d'un bot (lot 36, L2) ─────────────────────────────────────────

export interface OptionsDefinirActif {
  /** Volume `state` (le registre vit à sa racine). */
  stateDir: string;
  /** Registre courant (déjà lu : aucun accès disque en lecture). */
  registre: RegistreBots;
  botId: string;
  /** `true` = doit tourner, `false` = ne doit pas tourner. Tout autre type est refusé. */
  actif: unknown;
  /** Plafond des bots simultanés (défaut `bots.maxActifs` = 3). */
  maxActifs?: unknown;
}

export interface ResultatDefinirActif {
  registre: RegistreBots;
  bot: BotRecord;
  /** État ÉCRIT (identique à la demande quand `inchange` est faux). */
  actif: boolean;
  /** `true` ⇒ le bot était DÉJÀ dans l'état demandé : AUCUNE écriture. */
  inchange: boolean;
  /** Bots marqués actifs APRÈS l'appel (ordre de démarrage). */
  actifs: string[];
  /** Plafond appliqué à cet appel. */
  plafond: number;
  /** Le bot vient de passer à `true` : il ne tourne pas encore. */
  demarrageRequis: boolean;
  /** Le bot vient de passer à `false` : sa pile tourne jusqu'au redémarrage. */
  arretRequis: boolean;
}

/**
 * ALLUME ou ÉTEINT un bot — « `actif` = doit tourner » (lot 36, L2).
 *
 * ⚠️ C'est la PREMIÈRE route qui écrit `actif` : jusque-là le drapeau n'était
 * posé qu'à la création (`false`) et à la promotion après suppression.
 *
 * DEUX refus, tous deux EXPLICITES (jamais un état incohérent écrit) :
 *  - `plafond_actifs` : allumer un bot de plus dépasserait `bots.maxActifs` ;
 *    le message nomme le plafond ET les bots déjà allumés (il faut en éteindre
 *    un). `MAX_BOTS` reste la borne de CRÉATION du registre, pas celle-ci ;
 *  - `dernier_bot_actif` : éteindre le DERNIER bot actif laisserait une instance
 *    qui refuse de démarrer (`AUCUN_BOT_ACTIF`). On refuse plutôt que de créer
 *    un état dont on sait qu'il ne redémarrera pas.
 *
 * ⚠️ `inchange` est un vrai cas : renvoyer une écriture inutile ferait croire à
 * un changement d'état (et réveillerait les observateurs pour rien).
 */
export function definirActif(options: OptionsDefinirActif): ResultatDefinirActif {
  const registre = options.registre;
  const botId = options.botId;
  const index = registre.bots.findIndex((bot) => bot.id === botId);
  if (index < 0) {
    throw new AdminBotError("bot_inconnu", 404, `Bot inconnu : « ${botId} ».`);
  }
  if (typeof options.actif !== "boolean") {
    throw new AdminBotError(
      "actif_invalide",
      400,
      "Le champ « actif » doit être un BOOLÉEN (`true` = doit tourner, `false` = arrêté).",
    );
  }
  const actif = options.actif;
  const plafond = normaliserPlafond(options.maxActifs ?? MAX_ACTIFS_DEFAUT);
  const actuel = registre.bots[index] as BotRecord;
  const allumes = botsAActiver(registre);

  if (actuel.actif === actif) {
    return {
      registre,
      bot: actuel,
      actif,
      inchange: true,
      actifs: allumes.map((bot) => bot.id),
      plafond,
      demarrageRequis: false,
      arretRequis: false,
    };
  }

  if (actif) {
    if (allumes.length >= plafond) {
      throw new AdminBotError(
        "plafond_actifs",
        409,
        `Plafond de ${plafond} bot(s) simultané(s) atteint ` +
          `(\`bots.maxActifs\`) : éteignez d'abord l'un des bots actifs ` +
          `(${allumes.map((bot) => bot.id).join(", ")}) avant d'allumer « ${botId} ».`,
      );
    }
  } else if (allumes.length <= 1) {
    // ⚠️ Éteindre le dernier bot actif rendrait le prochain démarrage IMPOSSIBLE
    // (`AUCUN_BOT_ACTIF`) : le refus nomme l'action à faire (allumer un autre bot).
    throw new AdminBotError(
      "dernier_bot_actif",
      409,
      `Impossible d'éteindre « ${botId} » : c'est le DERNIER bot actif. ` +
        "Allumez d'abord un autre bot, sinon le gateway ne pourrait plus démarrer.",
    );
  }

  const bot: BotRecord = { ...actuel, actif };
  const bots = [...registre.bots];
  bots[index] = bot;
  const suivant: RegistreBots = { ...registre, bots };
  try {
    ecrireRegistreBots(cheminRegistreBots(options.stateDir), suivant);
  } catch (error) {
    throw traduireErreurFichier(error, "L'enregistrement du bot a échoué");
  }
  return {
    registre: suivant,
    bot,
    actif,
    inchange: false,
    actifs: botsAActiver(suivant).map((entree) => entree.id),
    plafond,
    // ⚠️ L'application est au REDÉMARRAGE (L1/L2 ne construisent qu'une pile) :
    // le drapeau décrit ce qui DOIT tourner, pas ce qui tourne déjà.
    demarrageRequis: actif,
    arretRequis: !actif,
  };
}

/** Clé de registre d'une paire d'échanges : `"<source>-><cible>"`. */
export function cleEchange(source: string, cible: string): string {
  return `${source}->${cible}`;
}

export interface OptionsDefinirEchange {
  /** Volume `state` (le registre vit à sa racine). */
  stateDir: string;
  /** Registre courant (déjà lu : aucun accès disque en lecture). */
  registre: RegistreBots;
  /** Bot SOURCE de la boucle. */
  de: string;
  /** Bot CIBLE de la boucle. */
  vers: string;
  /** `true` = la boucle entre ces deux bots est autorisée. Tout autre type est refusé. */
  actif: unknown;
}

export interface ResultatDefinirEchange {
  registre: RegistreBots;
  /** Clé écrite (`"<source>-><cible>"`). */
  cle: string;
  /** État ÉCRIT. */
  actif: boolean;
  /** `true` ⇒ la paire était DÉJÀ dans l'état demandé : AUCUNE écriture. */
  inchange: boolean;
  /** Paires APRÈS l'appel (le registre entier : l'UI n'a rien à recalculer). */
  echanges: Record<string, EchangeBots>;
}

/**
 * ALLUME ou ÉTEINT la BOUCLE entre deux bots (lot 37, décision utilisateur).
 *
 * ⚠️ C'est le SEUL garde-fou d'une paire, et il n'y a **aucun frein par paire** :
 * `echanges["a->b"] = { actif }`, rien d'autre (le schéma REFUSE tout autre champ,
 * `src/bots/registry.ts:419-430`). Un compteur éventuel restera informatif.
 *
 * ⚠️ La paire est ORIENTÉE : `a->b` (a peut joindre b) n'est pas `b->a`.
 * ⚠️ `de === vers` est REFUSÉ : un bot ne se délègue pas à lui-même.
 */
export function definirEchange(options: OptionsDefinirEchange): ResultatDefinirEchange {
  const registre = options.registre;
  const de = options.de;
  const vers = options.vers;
  for (const [cote, botId] of [
    ["source", de],
    ["cible", vers],
  ] as const) {
    if (!registre.bots.some((bot) => bot.id === botId)) {
      throw new AdminBotError(
        "bot_inconnu",
        404,
        `Bot ${cote} inconnu : « ${botId} ».`,
      );
    }
  }
  if (de === vers) {
    throw new AdminBotError(
      "echange_invalide",
      400,
      `Un bot ne peut pas échanger avec lui-même : « ${de} ».`,
    );
  }
  if (typeof options.actif !== "boolean") {
    throw new AdminBotError(
      "echange_invalide",
      400,
      "Le champ « actif » doit être un BOOLÉEN (`true` = la boucle est autorisée).",
    );
  }
  const actif = options.actif;
  const cle = cleEchange(de, vers);
  const existant = registre.echanges[cle];
  if (existant !== undefined && existant.actif === actif) {
    return {
      registre,
      cle,
      actif,
      inchange: true,
      echanges: { ...registre.echanges },
    };
  }
  const echanges: Record<string, EchangeBots> = { ...registre.echanges, [cle]: { actif } };
  const suivant: RegistreBots = { ...registre, echanges };
  try {
    ecrireRegistreBots(cheminRegistreBots(options.stateDir), suivant);
  } catch (error) {
    throw traduireErreurFichier(error, "L'enregistrement de la boucle a échoué");
  }
  return { registre: suivant, cle, actif, inchange: false, echanges };
}

/** Copie les éléments demandés d'un bot existant (aucune écriture hors du clone). */
function copierElements(
  stateDir: string,
  source: string,
  cible: string,
  copies: ReadonlySet<IdElementClone>,
): void {
  const racineSource = join(stateDir, SOUS_DOSSIER_BOTS, source);
  const racineCible = join(stateDir, SOUS_DOSSIER_BOTS, cible);
  for (const element of ELEMENTS_CLONE) {
    if (!copies.has(element.id)) continue;
    for (const relatif of element.chemins) {
      // ⚠️ GARDE : un élément qui oserait copier un chemin de `JAMAIS_COPIES`
      // lève — il ne « passera pas » en silence.
      if (estJamaisCopie(relatif)) {
        throw new AdminBotError(
          "echec_fichier",
          500,
          `Copie refusée : « ${relatif} » ne doit jamais être cloné (${element.id}).`,
        );
      }
      const de = join(racineSource, relatif);
      if (!existsSync(de)) continue;
      const vers = join(racineCible, relatif);
      mkdirSync(dirname(vers), { recursive: true });
      cpSync(de, vers, { recursive: true, force: true, preserveTimestamps: true });
    }
  }
}

/** Écrit l'avatar facultatif (data URL) dans `<racine>/avatar/`. */
function ecrireAvatar(stateDir: string, slug: string, avatar: unknown): void {
  if (avatar === undefined || avatar === null || avatar === "") return;
  if (typeof avatar !== "string") {
    throw new AdminBotError("avatar_invalide", 400, "Avatar invalide : image attendue.");
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(avatar);
  if (!match) {
    throw new AdminBotError(
      "avatar_invalide",
      400,
      "Avatar invalide : une image PNG, JPEG ou WebP encodée en base64 est attendue.",
    );
  }
  const octets = Buffer.from((match[2] as string).replace(/\s+/g, ""), "base64");
  const store = new AvatarStore({ dir: racineAvatar(stateDir, slug) });
  try {
    // ⚠️ `AvatarStore` valide la SIGNATURE binaire et les bornes (2 Mio,
    // 4096 px) : aucune image n'entre sans passer par là.
    store.ecrire(octets);
  } catch (error) {
    if (error instanceof AvatarRefusal) {
      throw new AdminBotError("avatar_invalide", 400, error.message);
    }
    throw error;
  }
}

/** Dossier d'avatar d'un bot (`<state>/bots/<slug>/avatar`). */
function racineAvatar(stateDir: string, slug: string): string {
  return join(stateDir, SOUS_DOSSIER_BOTS, slug, "avatar");
}

// ── Suppression (archivage) ────────────────────────────────────────────────

export interface OptionsSuppressionBot {
  stateDir: string;
  registre: RegistreBots;
  botId: string;
  maintenant?: number;
  /**
   * Volume `pi` (ses SESSIONS sont sous `<piSessionsDir>/<botId>`, lot 35i).
   *
   * ⚠️ Ce dossier vit sur un AUTRE volume que `<state>/bots/<id>` : il ne peut
   * pas être déplacé par `rename` (EXDEV). Il est donc COPIÉ dans l'archive
   * (`sessions-pi/`) puis supprimé — et si la copie échoue, RIEN n'est
   * supprimé : l'échec est journalisé (`bot.sessions.echec`), remonté à
   * l'appelant et DIT dans l'interface (jamais une perte silencieuse).
   *
   * Absent ⇒ les sessions ne sont pas touchées (le volume `pi` est inconnu de
   * cet appel) : le résultat le dit (`etat: "inconnu"`).
   */
  piSessionsDir?: string;
  /**
   * Couture de test : remplace la COPIE des sessions (défaut `cpSync` récursif).
   * ⚠️ Sert uniquement à prouver le comportement d'ÉCHEC (l'origine reste
   * intacte, l'erreur est journalisée et marquée) sans dépendre des permissions
   * du système de fichiers — un `chmod` ne retient pas `root`.
   */
  copierSessions?: (origine: string, cible: string) => void;
  /**
   * DÉTACHEMENT DES AGENTS (lot 35g). Appelé avec l'identifiant supprimé pour
   * le RETIRER de la liste `bots` de chaque agent (`AgentStore.retirerBotDesListes`).
   *
   * ⚠️ Le rappel renvoie le NOMBRE d'agents modifiés (journalisé
   * `bot.agents.detached`). Les agents eux-mêmes ne sont JAMAIS supprimés : un
   * agent qui n'a plus aucun bot reste listé et devient simplement injoignable.
   *
   * ⚠️ Si le nettoyage ÉCHOUE, la suppression du bot aboutit quand même (un
   * nettoyage ne doit pas annuler une suppression déjà écrite) : l'échec est
   * journalisé (`bot.agents.detach_failed`).
   */
  retirerDesListesDAgents?: (botId: string) => number | void;
  /** Journal (le logger d'observabilité le satisfait). */
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export interface ResultatSuppressionBot {
  registre: RegistreBots;
  /** Dossier d'archive (`<state>/bots-supprimes/<slug>-<date>/`). */
  archive: string | null;
  /** Bot retiré du registre. */
  bot: BotRecord;
  /** Bot promu ACTIF si le supprimé l'était (`null` sinon). */
  botActifSuivant: string | null;
  /**
   * `true` quand le bot ACTIF de l'instance a été supprimé : le processus en
   * cours applique encore ses chemins ⇒ REDÉMARRAGE nécessaire.
   */
  rechargementRequis: boolean;
  /** Ce qu'il est advenu des SESSIONS Pi du bot (lot 35i). */
  sessionsPi: ResultatSessionsPi;
}

/**
 * Sort des SESSIONS Pi d'un bot supprimé (lot 35i).
 *
 *  - `deplace` : copiées dans `<archive>/sessions-pi/` puis supprimées de leur
 *    volume d'origine — rien n'est perdu ;
 *  - `absent` : il n'y avait aucune session (cas normal d'un bot jamais utilisé) ;
 *  - `echec`  : la copie a échoué ; ⚠️ l'origine est INTACTE, l'erreur est
 *    remontée et journalisée, et un marqueur dans l'archive la fait purger à
 *    l'échéance ;
 *  - `inconnu` : le volume `pi` n'a pas été fourni à la suppression.
 */
export interface ResultatSessionsPi {
  readonly etat: "deplace" | "absent" | "echec" | "inconnu";
  /** Dossier d'origine (`<pi>/agent/sessions/<id>`), `null` si volume inconnu. */
  readonly origine: string | null;
  /** Destination dans l'archive, `null` si rien n'a été déplacé. */
  readonly archive: string | null;
  /** Motif de l'échec (DIT à l'utilisateur), `null` sinon. */
  readonly erreur: string | null;
}

/** Horodatage de dossier d'archive : `AAAAMMJJ-HHMM` (UTC). */
export function horodatageArchive(maintenant: number): string {
  const date = new Date(maintenant);
  const deux = (valeur: number) => String(valeur).padStart(2, "0");
  const jour = `${date.getUTCFullYear()}${deux(date.getUTCMonth() + 1)}${deux(date.getUTCDate())}`;
  const heure = `${deux(date.getUTCHours())}${deux(date.getUTCMinutes())}`;
  return `${jour}-${heure}`;
}

/**
 * Date (ms) portée par un nom d'archive `<slug>-AAAAMMJJ-HHMM[-N]`, ou `null`.
 * ⚠️ Le suffixe `-N` est celui d'une seconde suppression dans la même minute :
 * il ne change pas la date. Un nom NON datable rend `null` (jamais deviné).
 */
export function dateArchive(nom: string): number | null {
  const match = /-(\d{8})-(\d{4})(?:-\d+)?$/.exec(nom);
  if (!match) return null;
  const jour = match[1] as string;
  const heure = match[2] as string;
  const annee = Number(jour.slice(0, 4));
  const mois = Number(jour.slice(4, 6));
  const jourDuMois = Number(jour.slice(6, 8));
  const heures = Number(heure.slice(0, 2));
  const minutes = Number(heure.slice(2, 4));
  if ([annee, mois, jourDuMois, heures, minutes].some((valeur) => Number.isNaN(valeur))) {
    return null;
  }
  const instant = Date.UTC(annee, mois - 1, jourDuMois, heures, minutes);
  return Number.isNaN(instant) ? null : instant;
}

/**
 * SUPPRIME un bot — ⚠️ **n'efface RIEN** : son dossier est DÉPLACÉ (même
 * volume, `rename` atomique) vers `bots-supprimes/`, puis l'entrée du registre
 * est retirée. Les fichiers restent lisibles tels quels.
 *
 * ⚠️ Refus `dernier_bot` : une instance sans aucun bot n'a pas de bot actif —
 * elle refuserait de démarrer (`AUCUN_BOT_ACTIF`).
 */
export function supprimerBot(options: OptionsSuppressionBot): ResultatSuppressionBot {
  const { stateDir, registre } = options;
  const botId = options.botId;
  const maintenant = options.maintenant ?? Date.now();
  const bot = registre.bots.find((entree) => entree.id === botId);
  if (!bot) {
    throw new AdminBotError("bot_inconnu", 404, `Bot inconnu : « ${botId} ».`);
  }
  if (registre.bots.length <= 1) {
    throw new AdminBotError(
      "dernier_bot",
      409,
      "Impossible de supprimer le DERNIER bot : une instance sans bot ne peut pas démarrer. " +
        "Créez d'abord un autre bot.",
    );
  }
  const restants = registre.bots
    .filter((entree) => entree.id !== botId)
    .sort((a, b) => a.ordre - b.ordre);
  // ⚠️ PROMOTION : si le bot supprimé était ACTIF, le premier bot restant le
  // devient. Sans cela, le prochain démarrage refuserait (« aucun bot actif »).
  const suivant: RegistreBots = {
    ...registre,
    bots: restants.map((entree, index) => ({
      ...entree,
      actif: bot.actif ? index === 0 : entree.actif,
    })),
  };
  const botActifSuivant = bot.actif ? (restants[0]?.id ?? null) : null;

  const racine = join(stateDir, SOUS_DOSSIER_BOTS, botId);
  const archives = join(stateDir, SOUS_DOSSIER_SUPPRIMES);
  // ⚠️ SESSIONS Pi (lot 35i) : `<pi>/agent/sessions/<botId>`, sur un AUTRE volume.
  const origineSessions = dossierSessionsPi(options.piSessionsDir, botId);
  const sessionsPresentes = origineSessions !== null && existsSync(origineSessions);
  let archive: string | null = null;
  let dossierCree = false;
  let archiveCreee = false;
  if (existsSync(racine) || sessionsPresentes) {
    mkdirSync(archives, { recursive: true, mode: 0o700 });
    archive = cheminArchiveLibre(archives, botId, maintenant);
    if (existsSync(racine)) {
      renameSync(racine, archive);
      dossierCree = true;
    } else {
      // Le bot n'a pas de dossier `state` mais a des conversations : l'archive
      // est créée quand même (elles ne doivent pas rester orphelines).
      mkdirSync(archive, { recursive: true, mode: 0o700 });
      archiveCreee = true;
    }
  }
  try {
    ecrireRegistreBots(cheminRegistreBots(stateDir), suivant);
  } catch (error) {
    // ⚠️ Rollback : le dossier revient à sa place, rien n'a été perdu.
    if (archive !== null && dossierCree) {
      try {
        renameSync(archive, racine);
      } catch {
        // Meilleur effort : l'archive reste inspectable dans `bots-supprimes/`.
      }
    } else if (archive !== null && archiveCreee) {
      try {
        rmSync(archive, { recursive: true, force: true });
      } catch {
        // Meilleur effort : une archive vide est inoffensive.
      }
    }
    throw traduireErreurFichier(error, "La suppression du bot a échoué");
  }
  // SESSIONS Pi (lot 35i) — APRÈS le registre : un échec de copie ne doit pas
  // annuler une suppression déjà écrite, et l'origine n'est jamais supprimée
  // sans une copie réussie.
  const sessionsPi = archiverSessionsPi({
    origine: origineSessions,
    archive,
    ...(options.copierSessions ? { copier: options.copierSessions } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  // DÉTACHEMENT DES AGENTS (voir `OptionsSuppressionBot.retirerDesListesDAgents`).
  // ⚠️ Jamais bloquant : le bot est DÉJÀ supprimé (dossier déplacé, registre
  // écrit) ; un échec de nettoyage serait un mensonge si on le renvoyait en
  // erreur à l'appelant. On journalise, et la suppression reste valable.
  if (options.retirerDesListesDAgents) {
    try {
      const nombre = options.retirerDesListesDAgents(botId);
      options.logger?.info("bot.agents.detached", {
        bot: botId,
        agents: typeof nombre === "number" ? nombre : null,
      });
    } catch (error) {
      options.logger?.warn("bot.agents.detach_failed", {
        bot: botId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    registre: suivant,
    archive,
    bot,
    botActifSuivant,
    rechargementRequis: bot.actif,
    sessionsPi,
  };
}

/** Dossier des sessions Pi d'un bot, ou `null` si le volume `pi` est inconnu. */
export function dossierSessionsPi(
  piSessionsDir: string | undefined,
  botId: string,
): string | null {
  if (typeof piSessionsDir !== "string" || piSessionsDir.trim() === "") return null;
  if (!estSlugBot(botId) && !/^[a-z][a-z0-9_-]{0,31}$/.test(botId)) {
    throw new AdminBotError("bot_inconnu", 404, `Identifiant de bot invalide : « ${botId} ».`);
  }
  return join(piSessionsDir, botId);
}

/**
 * ARCHIVE les sessions Pi d'un bot supprimé (lot 35i).
 *
 * ⚠️ Volumes DIFFÉRENTS (`state` ≠ `pi`) : `rename` échouerait en `EXDEV`, donc
 * COPIE puis suppression — et la suppression n'a lieu qu'après une copie dont on
 * a vérifié qu'elle existe. Une copie partielle est RETIRÉE (jamais un
 * demi-archivage) et un marqueur nomme le dossier resté en place, pour que la
 * purge des 90 jours l'efface à l'échéance.
 */
function archiverSessionsPi(options: {
  origine: string | null;
  archive: string | null;
  copier?: (origine: string, cible: string) => void;
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}): ResultatSessionsPi {
  if (options.origine === null) {
    return { etat: "inconnu", origine: null, archive: null, erreur: null };
  }
  if (!existsSync(options.origine)) {
    return { etat: "absent", origine: options.origine, archive: null, erreur: null };
  }
  const cible =
    options.archive === null ? null : join(options.archive, SOUS_DOSSIER_SESSIONS_PI);
  try {
    if (cible === null || options.archive === null) {
      throw new Error("aucune archive de bot n'a pu être créée");
    }
    mkdirSync(options.archive, { recursive: true, mode: 0o700 });
    if (options.copier) {
      options.copier(options.origine, cible);
    } else {
      cpSync(options.origine, cible, {
        recursive: true,
        force: true,
        preserveTimestamps: true,
      });
    }
    if (!existsSync(cible)) {
      throw new Error("la copie des sessions est introuvable après copie");
    }
    rmSync(options.origine, { recursive: true, force: true });
    options.logger?.info("bot.sessions.deplacees", {
      origine: options.origine,
      archive: cible,
    });
    return { etat: "deplace", origine: options.origine, archive: cible, erreur: null };
  } catch (error) {
    const erreur = error instanceof Error ? error.message : String(error);
    // ⚠️ Jamais un demi-archivage : la copie partielle est retirée, l'ORIGINE reste.
    if (cible !== null && existsSync(cible)) {
      try {
        rmSync(cible, { recursive: true, force: true });
      } catch {
        // Meilleur effort : le marqueur ci-dessous dit où sont les sessions.
      }
    }
    if (options.archive !== null) {
      try {
        mkdirSync(options.archive, { recursive: true, mode: 0o700 });
        writeFileSync(
          join(options.archive, MARQUEUR_SESSIONS_RESTANTES),
          `${JSON.stringify({ origine: options.origine, erreur }, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
      } catch {
        // Meilleur effort : le journal ci-dessous est la trace minimale.
      }
    }
    options.logger?.warn("bot.sessions.echec", {
      origine: options.origine,
      archive: options.archive,
      error: erreur,
    });
    return { etat: "echec", origine: options.origine, archive: null, erreur };
  }
}

/** Chemin d'archive libre (deux suppressions dans la même minute ⇒ suffixe). */
function cheminArchiveLibre(archivesDir: string, botId: string, maintenant: number): string {
  const base = join(archivesDir, `${botId}-${horodatageArchive(maintenant)}`);
  if (!existsSync(base)) return base;
  for (let suffixe = 2; suffixe < 100; suffixe += 1) {
    const candidat = `${base}-${suffixe}`;
    if (!existsSync(candidat)) return candidat;
  }
  throw new AdminBotError(
    "echec_fichier",
    500,
    `Impossible de trouver un nom d'archive libre pour « ${botId} ».`,
  );
}

// ── Compteurs (confirmation de suppression) ────────────────────────────────

export interface CompteursBot {
  /** Conversations ARCHIVÉES (fichiers JSON de `conversations-archive/`). */
  conversations: number;
  /** Souvenirs (lignes non vides de `memory.jsonl`). */
  souvenirs: number;
  /** Déclencheurs définis (`sources.json`). */
  declencheurs: number;
  /** Taille du dossier du bot, en octets. */
  octets: number;
}

/**
 * Compte ce qui sera ARCHIVÉ par une suppression. ⚠️ Lecture seule, tolérante :
 * un fichier illisible vaut 0 (le compteur ne doit jamais bloquer la modale).
 */
export function compterDonneesBot(stateDir: string, botId: string): CompteursBot {
  const racine = join(stateDir, SOUS_DOSSIER_BOTS, botId);
  return {
    conversations: compterFichiers(join(racine, "conversations-archive"), ".json"),
    souvenirs: compterLignes(join(racine, "memory.jsonl")),
    declencheurs: compterSources(join(racine, "sources.json")),
    octets: tailleDossier(racine),
  };
}

function compterFichiers(dir: string, extension: string): number {
  try {
    return readdirSync(dir).filter((nom) => nom.endsWith(extension)).length;
  } catch {
    return 0;
  }
}

/**
 * Nombre de fichiers (récursif) sous un dossier : compteur des SESSIONS Pi d'un
 * bot (lot 35i), qui vivent hors du volume `state`.
 *
 * ⚠️ Ces conversations ne sont PAS dans `CompteursBot` (qui ne décrit que le
 * dossier `<state>/bots/<id>` et dont la forme est verrouillée) : la route de
 * confirmation les ajoute sous la clé `sessions`.
 */
export function compterSessionsPi(
  piSessionsDir: string | undefined,
  botId: string,
): number {
  const dossier = dossierSessionsPi(piSessionsDir, botId);
  if (dossier === null) return 0;
  return compterFichiersRecursif(dossier);
}

function compterFichiersRecursif(dir: string): number {
  let entrees: string[];
  try {
    entrees = readdirSync(dir);
  } catch {
    return 0;
  }
  let total = 0;
  for (const entree of entrees) {
    const complet = join(dir, entree);
    try {
      total += statSync(complet).isDirectory() ? compterFichiersRecursif(complet) : 1;
    } catch {
      // Entrée disparue pendant le parcours : ignorée (un compteur ne bloque rien).
    }
  }
  return total;
}

function compterLignes(path: string): number {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((ligne) => ligne.trim() !== "").length;
  } catch {
    return 0;
  }
}

function compterSources(path: string): number {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { sources?: unknown };
    return Array.isArray(parsed.sources) ? parsed.sources.length : 0;
  } catch {
    return 0;
  }
}

function tailleDossier(path: string): number {
  let total = 0;
  let entrees: string[];
  try {
    entrees = readdirSync(path);
  } catch {
    return 0;
  }
  for (const entree of entrees) {
    const complet = join(path, entree);
    try {
      const stat = statSync(complet);
      total += stat.isDirectory() ? tailleDossier(complet) : stat.size;
    } catch {
      // Entrée disparue pendant le parcours : ignorée.
    }
  }
  return total;
}

// ── Rétention (3 mois) ─────────────────────────────────────────────────────

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface AdminBotLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

export interface OptionsPurgeArchives {
  stateDir: string;
  /** Instant de référence (injectable : les tests vieillissent les dossiers). */
  maintenant: number;
  /** Rétention en jours (défaut `RETENTION_ARCHIVES_JOURS`, soit 3 mois). */
  retentionJours?: number;
  /**
   * Volume `pi` (lot 35i) : une archive qui n'a pas pu recevoir les sessions
   * d'un bot garde un marqueur (`MARQUEUR_SESSIONS_RESTANTES`) nommant le
   * dossier resté sur ce volume. À l'échéance de la rétention, ce dossier est
   * effacé AUSSI — une conversation ne survit pas en silence à son archive.
   *
   * ⚠️ Le chemin lu dans le marqueur n'est suivi que s'il désigne exactement
   * `<piSessionsDir>/<identifiant valide>` : jamais une suppression arbitraire
   * dictée par le contenu d'un fichier.
   */
  piSessionsDir?: string;
  logger?: AdminBotLogger;
}

export interface ResultatPurgeArchives {
  /** Noms des archives RÉELLEMENT supprimées. */
  purges: string[];
  /** Noms des archives conservées (âge ≤ rétention, ou nom non datable). */
  conservees: string[];
  /** Dossiers de SESSIONS Pi effacés à l'échéance (lot 35i). */
  sessionsPurgees: string[];
}

/**
 * PURGE les archives de bots supprimés plus vieilles que la rétention (90 j).
 *
 * ⚠️ Appelée par le BALAYEUR EXISTANT (`DeclencheurBalayeur`) : aucun
 * `setInterval` nouveau, donc aucun second rythme dans le processus.
 * ⚠️ Un nom non datable n'est JAMAIS supprimé (on ne devine pas un âge).
 */
export function purgerArchivesBots(options: OptionsPurgeArchives): ResultatPurgeArchives {
  const retention = options.retentionJours ?? RETENTION_ARCHIVES_JOURS;
  const limite = retention * MS_PAR_JOUR;
  const dir = join(options.stateDir, SOUS_DOSSIER_SUPPRIMES);
  const resultat: ResultatPurgeArchives = { purges: [], conservees: [], sessionsPurgees: [] };
  let noms: string[];
  try {
    noms = readdirSync(dir);
  } catch {
    return resultat; // Aucune archive : rien à purger (cas normal).
  }
  for (const nom of noms) {
    const chemin = join(dir, nom);
    const date = dateArchive(nom);
    if (date === null) {
      resultat.conservees.push(nom);
      continue;
    }
    const age = options.maintenant - date;
    if (age <= limite) {
      resultat.conservees.push(nom);
      continue;
    }
    // ⚠️ SESSIONS Pi restées sur leur volume (copie impossible) : l'échéance de
    // la rétention vaut aussi pour elles (jamais une survie silencieuse).
    purgerSessionsRestantes({
      archive: chemin,
      piSessionsDir: options.piSessionsDir,
      resultat,
      ...(options.logger ? { logger: options.logger } : {}),
    });
    try {
      rmSync(chemin, { recursive: true, force: true });
    } catch (error) {
      options.logger?.warn?.("bot.archive.purge_failed", {
        archive: nom,
        error: error instanceof Error ? error.message : String(error),
      });
      resultat.conservees.push(nom);
      continue;
    }
    resultat.purges.push(nom);
    options.logger?.info("bot.archive.purged", {
      archive: nom,
      age_jours: Math.floor(age / MS_PAR_JOUR),
      retention_jours: retention,
    });
  }
  return resultat;
}

// ── Utilitaires ────────────────────────────────────────────────────────────

/**
 * Efface le dossier de sessions Pi qu'une archive EXPIRÉE n'avait pas pu
 * recevoir (lot 35i).
 *
 * ⚠️ Le marqueur n'est qu'une INDICATION : le chemin n'est suivi que s'il
 * désigne exactement `<piSessionsDir>/<identifiant valide>`. Un marqueur
 * incohérent (volume inconnu, chemin ailleurs, JSON illisible) est CONSERVÉ et
 * journalisé — on ne supprime jamais un dossier sur la foi d'un fichier.
 */
function purgerSessionsRestantes(options: {
  archive: string;
  piSessionsDir: string | undefined;
  resultat: ResultatPurgeArchives;
  logger?: AdminBotLogger;
}): void {
  const marqueur = join(options.archive, MARQUEUR_SESSIONS_RESTANTES);
  if (!existsSync(marqueur)) return;
  let origine: unknown;
  try {
    origine = (JSON.parse(readFileSync(marqueur, "utf8")) as { origine?: unknown }).origine;
  } catch (error) {
    options.logger?.warn?.("bot.sessions.marqueur_invalide", {
      archive: basename(options.archive),
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (typeof origine !== "string" || origine.trim() === "") return;
  if (typeof options.piSessionsDir !== "string" || options.piSessionsDir.trim() === "") {
    options.logger?.warn?.("bot.sessions.volume_inconnu", {
      archive: basename(options.archive),
      origine,
    });
    return;
  }
  const cible = resolve(origine);
  const attendu = dossierSessionsPi(options.piSessionsDir, basename(cible));
  if (attendu === null || resolve(attendu) !== cible) {
    options.logger?.warn?.("bot.sessions.marqueur_incoherent", {
      archive: basename(options.archive),
      origine,
    });
    return;
  }
  try {
    rmSync(cible, { recursive: true, force: true });
  } catch (error) {
    options.logger?.warn?.("bot.sessions.purge_failed", {
      origine: cible,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  options.resultat.sessionsPurgees.push(basename(cible));
  options.logger?.info?.("bot.sessions.purges", {
    origine: cible,
    archive: basename(options.archive),
  });
}

/** Traduit une erreur de fichier/registre en refus d'administration. */
function traduireErreurFichier(error: unknown, prefixe: string): AdminBotError {
  if (error instanceof AdminBotError) return error;
  return new AdminBotError(
    "echec_fichier",
    500,
    `${prefixe} : ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** Chemin ABSOLU du dossier d'un bot (contrôle anti-traversée, tests). */
export function dossierBot(stateDir: string, botId: string): string {
  if (!estSlugBot(botId) && !/^[a-z][a-z0-9_-]{0,31}$/.test(botId)) {
    throw new AdminBotError("bot_inconnu", 404, `Identifiant de bot invalide : « ${botId} ».`);
  }
  return join(stateDir, SOUS_DOSSIER_BOTS, botId);
}

/** Vrai si `chemin` est bien sous `<state>/bots/<slug>/` (jamais ailleurs). */
export function estDansDossierBot(stateDir: string, botId: string, chemin: string): boolean {
  const racine = resolve(dossierBot(stateDir, botId));
  const cible = resolve(chemin);
  return cible === racine || cible.startsWith(`${racine}${sep}`);
}
