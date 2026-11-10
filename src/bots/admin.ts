/**
 * ADMINISTRATION DES BOTS (lot 35e) — AJOUTER, CLONER, SUPPRIMER, PURGER.
 *
 * Ce module est le SEUL endroit qui manipule les DOSSIERS des bots :
 *
 *  - `creerBot`      : `mkdir <state>/bots/<slug>/` + entrée du registre
 *    (+ copie des éléments choisis quand on clone un bot existant) ;
 *  - `supprimerBot`  : ⚠️ **n'efface RIEN** — `rename` du dossier vers
 *    `<state>/bots-supprimes/<slug>-<AAAAMMJJ-HHMM>/` (même volume, donc
 *    atomique) puis retrait de l'entrée du registre ;
 *  - `purgerArchivesBots` : purge RÉELLE des archives de plus de 90 jours,
 *    appelée par le BALAYEUR EXISTANT (`src/sources/scheduler.ts`) ;
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
 * ⚠️ Les SESSIONS Pi ne sont jamais copiées non plus : elles vivent sur un
 * AUTRE volume (`<pi>/agent/sessions/<slug>`), hors de ce module.
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
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { AvatarRefusal, AvatarStore } from "../identity/avatar.js";
import { ConfigOverlayStore } from "../config/overlay.js";
import { resolveConfigOverlayPath } from "../config/paths.js";

import {
  MAX_BOTS,
  PROFILS_BOT,
  ecrireRegistreBots,
  estSlugBot,
  cheminRegistreBots,
  type BotRecord,
  type ProfilBot,
  type RegistreBots,
} from "./registry.js";
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
  | "profil_inconnu"
  | "bot_inconnu"
  | "dernier_bot"
  | "avatar_invalide"
  | "echec_fichier";

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
    libelle: "Capacités",
    aide: "Profil du bot et réglages de configuration (config.overlay.json).",
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
  nom: unknown;
  slug: unknown;
  profil?: unknown;
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

/** Profil : `complet | lecture | accueil` (défaut `complet`). */
export function validerProfilBot(profil: unknown): ProfilBot {
  if (profil === undefined || profil === null || profil === "") return "complet";
  if (!PROFILS_BOT.includes(profil as ProfilBot)) {
    throw new AdminBotError(
      "profil_inconnu",
      400,
      `Profil inconnu : ${JSON.stringify(profil)} (attendu : ${PROFILS_BOT.join(" | ")}).`,
    );
  }
  return profil as ProfilBot;
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
 * ⚠️ Ordre : le DOSSIER d'abord, le REGISTRE en dernier. Une coupure entre les
 * deux laisse un dossier orphelin (inoffensif, jamais listé) plutôt qu'un bot
 * déclaré dont les chemins n'existent pas. Si l'écriture du registre échoue, la
 * copie est ANNULÉE (le dossier vient d'être créé : rien d'autre n'y vit).
 */
export function creerBot(options: OptionsCreationBot): ResultatCreationBot {
  const nom = validerNomBot(options.nom);
  const slug = validerSlugBot(options.slug);
  const profil = validerProfilBot(options.profil);
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
  if (registre.bots.some((bot) => bot.id === slug)) {
    throw new AdminBotError("slug_deja_pris", 409, `Le slug « ${slug} » est déjà utilisé.`);
  }

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
    throw new AdminBotError(
      "slug_deja_pris",
      409,
      `Un dossier existe déjà pour « ${slug} » (${racine}) : choisissez un autre slug.`,
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
  const bot: BotRecord = {
    id: slug,
    nom,
    profil,
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
  let archive: string | null = null;
  let dossierCree = false;
  if (existsSync(racine)) {
    mkdirSync(archives, { recursive: true, mode: 0o700 });
    archive = cheminArchiveLibre(archives, botId, maintenant);
    renameSync(racine, archive);
    dossierCree = true;
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
    }
    throw traduireErreurFichier(error, "La suppression du bot a échoué");
  }
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
  };
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
  logger?: AdminBotLogger;
}

export interface ResultatPurgeArchives {
  /** Noms des archives RÉELLEMENT supprimées. */
  purges: string[];
  /** Noms des archives conservées (âge ≤ rétention, ou nom non datable). */
  conservees: string[];
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
  const resultat: ResultatPurgeArchives = { purges: [], conservees: [] };
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
