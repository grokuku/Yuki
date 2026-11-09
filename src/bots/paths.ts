/**
 * RÉSOLUTION DES CHEMINS PAR BOT (lot 35a, multi-bot étape 1).
 *
 * ⚠️ PRINCIPE : on ne REMPLACE pas `env` (`src/config/env.ts:379-591`), on le
 * **SURCHARGE**. `pathsForBot(env, botId)` renvoie une COPIE d'`Env` dont seuls
 * les chemins PROPRES À UN BOT pointent sous `<state>/bots/<botId>/` (et
 * `<pi>/agent/sessions/<botId>` pour les sessions). Tout le reste — configuration
 * (`configStorePath`), coffre, mot de passe d'instance, fichiers échangés,
 * journaux d'audit, workflows ComfyUI, push — reste GLOBAL à l'instance : ces
 * fichiers n'appartiennent à aucun bot.
 *
 * ⚠️ Résolution INJECTÉE (pas de variable globale) : l'appelant reçoit les
 * chemins et les passe au reste du câblage. La couche est donc testable sans
 * démarrer le gateway.
 *
 * ## Surcharges de déploiement
 * Chaque chemin possède une variable de câblage (`YUKI_MEMORY_STORE_PATH`…).
 * ⚠️ Une surcharge qui pointe **hors de son volume** n'est PAS déplacée : elle
 * est SAUTÉE (le chemin surchargé reste utilisé) et un AVERTISSEMENT est remonté
 * au démarrage — une surcharge de déploiement ne se déplace pas toute seule.
 *
 * Aucun import SDK/typebox.
 */

import { dirname, join, resolve, sep } from "node:path";

import type { Env } from "../config/env.js";

/** Sous-dossier des bots, sous le volume `state`. */
export const SOUS_DOSSIER_BOTS = "bots";

/** Volume porteur d'un chemin : `state` (la plupart) ou `pi` (sessions). */
export type VolumeChemin = "state" | "pi";

/** Clés d'`Env` qui appartiennent à UN bot (et sont donc surchargées). */
export type CleCheminBot =
  | "memoryStorePath"
  | "memoryIndexPath"
  | "memoryConsolidationDir"
  | "memoryConsolidationStatePath"
  | "heritageDir"
  | "conversationArchiveDir"
  | "conversationArchiveIndexPath"
  | "personalityPath"
  | "rulesPath"
  | "sessionPinsPath"
  | "reactionsStorePath"
  | "jobsStorePath"
  | "librarianJobsPath"
  | "librarianShotsDir"
  | "sourcesStorePath"
  | "sourcesInboxPath"
  | "declencheursJournalPath"
  | "preAutorisationsPath"
  | "envoisProgrammesPath"
  | "avatarDir"
  | "chatMirrorPath"
  | "chatMirrorDir"
  | "piSessionsDir";

/**
 * Chemins DÉRIVÉS (pas des champs d'`Env`) : les stores de document
 * (`personality.md`, `rules.md`) posent leur historique et leur journal à côté
 * du fichier (`src/state/text-document-store.ts:192-194`). Ils suivent donc le
 * bot et doivent être DÉPLACÉS avec lui — sinon l'historique et le journal
 * resteraient orphelins à l'ancien emplacement (perte silencieuse).
 */
export type CleCheminDerive =
  | "personalityHistoryDir"
  | "personalityJournalPath"
  | "rulesHistoryDir"
  | "rulesJournalPath";

/** Toute clé de chemin (base ou dérivée). */
export type CleChemin = CleCheminBot | CleCheminDerive;

/**
 * Nature d'un chemin dérivé : `repertoire` ou `fichier`. Le déplacement est le
 * même (`rename`), mais le diagnostic et le journal restent lisibles.
 */
export type NatureChemin = "fichier" | "repertoire";

/** Définition d'un champ d'`Env` propre à un bot. */
export interface DefinitionCheminBot {
  readonly cle: CleCheminBot;
  /** Variable de câblage qui surcharge ce chemin (voir `src/config/env.ts`). */
  readonly variable: string;
  readonly volume: VolumeChemin;
  /**
   * Chemin RELATIF à la racine du bot. Chaîne vide pour `piSessionsDir` : les
   * sessions s'empilent sous le dossier de sessions existant
   * (`<pi>/agent/sessions/<botId>`), pas sous `<state>/bots/<botId>`.
   */
  readonly relatif: string;
  readonly nature: NatureChemin;
}

/**
 * LES CHEMINS PAR BOT — table UNIQUE, source de vérité de la résolution ET de la
 * migration. Ordre = ordre de déplacement pendant la migration.
 *
 * ⚠️ `piSessionsDir` est EN DERNIER : il vit sur un AUTRE volume (`/data/pi`),
 * son `rename` n'est donc PAS atomique avec les précédents.
 */
export const CHEMINS_BOT: readonly DefinitionCheminBot[] = [
  { cle: "memoryStorePath", variable: "YUKI_MEMORY_STORE_PATH", volume: "state", relatif: "memory.jsonl", nature: "fichier" },
  { cle: "memoryIndexPath", variable: "YUKI_MEMORY_INDEX_PATH", volume: "state", relatif: "memory-index.sqlite", nature: "fichier" },
  { cle: "memoryConsolidationDir", variable: "YUKI_MEMORY_CONSOLIDATION_DIR", volume: "state", relatif: join("memory-archive", "consolidation"), nature: "repertoire" },
  { cle: "memoryConsolidationStatePath", variable: "YUKI_MEMORY_CONSOLIDATION_STATE_PATH", volume: "state", relatif: "memory-consolidation.json", nature: "fichier" },
  { cle: "heritageDir", variable: "YUKI_HERITAGE_DIR", volume: "state", relatif: "memory-heritage", nature: "repertoire" },
  { cle: "conversationArchiveDir", variable: "YUKI_CONVERSATION_ARCHIVE_DIR", volume: "state", relatif: "conversations-archive", nature: "repertoire" },
  { cle: "conversationArchiveIndexPath", variable: "YUKI_CONVERSATION_ARCHIVE_INDEX_PATH", volume: "state", relatif: "conversations-archive-index.sqlite", nature: "fichier" },
  { cle: "personalityPath", variable: "YUKI_PERSONALITY_PATH", volume: "state", relatif: "personality.md", nature: "fichier" },
  { cle: "rulesPath", variable: "YUKI_RULES_PATH", volume: "state", relatif: "rules.md", nature: "fichier" },
  { cle: "sessionPinsPath", variable: "YUKI_SESSION_PINS_PATH", volume: "state", relatif: "session-pins.json", nature: "fichier" },
  { cle: "reactionsStorePath", variable: "YUKI_REACTIONS_STORE_PATH", volume: "state", relatif: "reactions.jsonl", nature: "fichier" },
  { cle: "jobsStorePath", variable: "YUKI_JOBS_STORE_PATH", volume: "state", relatif: "jobs.jsonl", nature: "fichier" },
  { cle: "librarianJobsPath", variable: "YUKI_LIBRARIAN_JOBS_PATH", volume: "state", relatif: "librarian-jobs.jsonl", nature: "fichier" },
  { cle: "librarianShotsDir", variable: "YUKI_LIBRARIAN_SHOTS_DIR", volume: "state", relatif: "librarian-shots", nature: "repertoire" },
  { cle: "sourcesStorePath", variable: "YUKI_SOURCES_STORE_PATH", volume: "state", relatif: "sources.json", nature: "fichier" },
  { cle: "sourcesInboxPath", variable: "YUKI_SOURCES_INBOX_PATH", volume: "state", relatif: "sources-inbox.json", nature: "fichier" },
  { cle: "declencheursJournalPath", variable: "YUKI_DECLENCHEURS_JOURNAL_PATH", volume: "state", relatif: "declencheurs-journal.jsonl", nature: "fichier" },
  { cle: "preAutorisationsPath", variable: "YUKI_PREAUTORISATIONS_PATH", volume: "state", relatif: "preautorisations.json", nature: "fichier" },
  { cle: "envoisProgrammesPath", variable: "YUKI_ENVOIS_PROGRAMMES_PATH", volume: "state", relatif: "envois-programmes.json", nature: "fichier" },
  { cle: "avatarDir", variable: "YUKI_AVATAR_DIR", volume: "state", relatif: "avatar", nature: "repertoire" },
  { cle: "chatMirrorPath", variable: "YUKI_CHAT_MIRROR_PATH", volume: "state", relatif: "chat-mirror.json", nature: "fichier" },
  { cle: "chatMirrorDir", variable: "YUKI_CHAT_MIRROR_DIR", volume: "state", relatif: "chat-mirror", nature: "repertoire" },
  { cle: "piSessionsDir", variable: "YUKI_PI_SESSIONS_DIR", volume: "pi", relatif: "", nature: "repertoire" },
];

/**
 * Définition d'un chemin DÉRIVÉ : `origine(env)` donne son emplacement
 * historique (mono-bot), `relatif` sa place sous la racine du bot.
 */
export interface DefinitionCheminDerive {
  readonly cle: CleCheminDerive;
  readonly volume: "state";
  readonly relatif: string;
  readonly nature: NatureChemin;
  readonly origine: (env: Env) => string;
}

/**
 * ⚠️ Ces quatre chemins ne sont PAS des champs d'`Env` : ils se déduisent du
 * dossier du document (`src/state/text-document-store.ts:187-194`).
 */
export const CHEMINS_DERIVES: readonly DefinitionCheminDerive[] = [
  {
    cle: "personalityHistoryDir",
    volume: "state",
    relatif: "personality-history",
    nature: "repertoire",
    origine: (env) => join(dirname(env.personalityPath), "personality-history"),
  },
  {
    cle: "personalityJournalPath",
    volume: "state",
    relatif: "personality-journal.jsonl",
    nature: "fichier",
    origine: (env) => join(dirname(env.personalityPath), "personality-journal.jsonl"),
  },
  {
    cle: "rulesHistoryDir",
    volume: "state",
    relatif: "rules-history",
    nature: "repertoire",
    origine: (env) => join(dirname(env.rulesPath), "rules-history"),
  },
  {
    cle: "rulesJournalPath",
    volume: "state",
    relatif: "rules-journal.jsonl",
    nature: "fichier",
    origine: (env) => join(dirname(env.rulesPath), "rules-journal.jsonl"),
  },
];

/** Chemins effectifs d'un bot. */
export interface CheminsBot {
  readonly botId: string;
  /** `<state>/bots/<botId>`. */
  readonly racine: string;
  /** Dossier de sessions HISTORIQUE (`<pi>/agent/sessions`), partagé. */
  readonly sessionsOrigine: string;
  /** Dossier de sessions DU BOT (`<pi>/agent/sessions/<botId>`). */
  readonly sessions: string;
  readonly fichiers: Readonly<Record<CleCheminBot, string>>;
  readonly derives: Readonly<Record<CleCheminDerive, string>>;
}

/** Une surcharge d'environnement volontairement IGNORÉE (hors volume). */
export interface SurchargeIgnoree {
  readonly cle: CleChemin;
  readonly variable: string;
  readonly valeur: string;
  readonly volume: VolumeChemin;
}

/** Résultat de `pathsForBot`. */
export interface ResultatPathsForBot {
  /** Copie d'`Env` avec les chemins du bot surchargés. */
  readonly env: Env;
  readonly chemins: CheminsBot;
  readonly surchargesIgnorees: readonly SurchargeIgnoree[];
}

/** Vrai si `chemin` est à l'intérieur (ou égal à) `volume`. */
export function estDansVolume(chemin: string, volume: string): boolean {
  const c = resolve(chemin);
  const v = resolve(volume);
  if (c === v) return true;
  return c.startsWith(v.endsWith(sep) ? v : `${v}${sep}`);
}

/** Racine du bot : `<state>/bots/<botId>`. */
export function racineBot(env: Env, botId: string): string {
  return join(env.mountPoints.state, SOUS_DOSSIER_BOTS, botId);
}

/** Calcule les chemins d'un bot, SANS lire ni écrire le disque. */
export function cheminsBot(env: Env, botId: string): CheminsBot {
  const racine = racineBot(env, botId);
  const sessionsOrigine = env.piSessionsDir;
  const sessions = join(sessionsOrigine, botId);
  const fichiers = {} as Record<CleCheminBot, string>;
  for (const definition of CHEMINS_BOT) {
    fichiers[definition.cle] =
      definition.volume === "pi" ? sessions : join(racine, definition.relatif);
  }
  const derives = {} as Record<CleCheminDerive, string>;
  for (const definition of CHEMINS_DERIVES) {
    derives[definition.cle] = join(racine, definition.relatif);
  }
  return { botId, racine, sessionsOrigine, sessions, fichiers, derives };
}

/** Valeur de surcharge d'une variable de câblage (`undefined` si absente/vide). */
function surchargeBrute(
  processEnv: NodeJS.ProcessEnv,
  variable: string,
): string | undefined {
  const raw = processEnv[variable];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** Volume porteur d'un chemin, tel que `env` le définit. */
function volumeDe(env: Env, volume: VolumeChemin): string {
  return volume === "pi" ? env.piSessionsDir : env.mountPoints.state;
}

/**
 * Surcharges de déploiement IGNORÉES : leur valeur sort du volume du chemin.
 * ⚠️ On ne déplace JAMAIS un chemin qu'un déploiement a placé ailleurs.
 */
export function surchargesIgnorees(
  env: Env,
  processEnv: NodeJS.ProcessEnv = process.env,
): SurchargeIgnoree[] {
  const ignorees: SurchargeIgnoree[] = [];
  for (const definition of CHEMINS_BOT) {
    const valeur = surchargeBrute(processEnv, definition.variable);
    if (valeur === undefined) continue;
    if (estDansVolume(valeur, volumeDe(env, definition.volume))) continue;
    ignorees.push({
      cle: definition.cle,
      variable: definition.variable,
      valeur,
      volume: definition.volume,
    });
  }
  return ignorees;
}

/**
 * Copie d'`Env` dont les chemins PROPRES AU BOT sont surchargés.
 *
 * ⚠️ `env` doit avoir été construit depuis le MÊME environnement que
 * `processEnv` (c'est le cas en production : `loadEnv()` lit `process.env`).
 * Une surcharge hors volume est CONSERVÉE telle quelle (le déploiement a choisi
 * cet emplacement) et signalée dans `surchargesIgnorees`.
 */
export function pathsForBot(
  env: Env,
  botId: string,
  options: { processEnv?: NodeJS.ProcessEnv } = {},
): ResultatPathsForBot {
  const chemins = cheminsBot(env, botId);
  const ignorees = surchargesIgnorees(env, options.processEnv ?? process.env);
  const ignoreesCles = new Set(ignorees.map((entree) => entree.cle));
  const surcharge: Env = { ...env };
  for (const definition of CHEMINS_BOT) {
    if (ignoreesCles.has(definition.cle)) continue;
    surcharge[definition.cle] = chemins.fichiers[definition.cle];
  }
  return { env: surcharge, chemins, surchargesIgnorees: ignorees };
}

/** Message d'avertissement (français) d'une surcharge ignorée. */
export function messageSurchargeIgnoree(surcharge: SurchargeIgnoree): string {
  return (
    `Surcharge de déploiement CONSERVÉE : ${surcharge.variable}=${surcharge.valeur} ` +
    `pointe hors du volume « ${surcharge.volume} » — le chemin n'est pas déplacé ` +
    `vers le dossier du bot (aucun déplacement sauvage).`
  );
}
