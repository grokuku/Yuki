/**
 * PERSONNALITÉ D'UN BOT — LA SEULE SOURCE (`prompts.personnalite`).
 *
 * ⚠️ DÉCISION UTILISATEUR (2026-11-14) : « évidemment qu'il ne faut qu'UNE
 * personnalité ». Avant ce lot, deux textes d'identité entraient dans le prompt :
 *  - `prompts.personnalite` (la clé de configuration, composée par
 *    `src/llm/prompt-systeme.ts`) ;
 *  - le fichier `personality.md` du bot, CONCATÉNÉ À LA FIN du `systemPrompt`
 *    par une extension SDK — donc il GAGNAIT sur la clé de configuration.
 *
 * Ce module est le point UNIQUE de résolution : il rend UN texte, avec son
 * origine ET sa provenance, et c'est ce texte que `composerPromptSysteme`
 * compose.
 *
 * ## Les fichiers d'amorçage (⚠️ DEUX emplacements, aucun n'est un vestige)
 *  ① `<state>/bots/<id>/personality.md` — le fichier DU BOT (multi-bot) ;
 *  ② `<state>/personality.md` — le fichier HISTORIQUE de l'instance (ancien
 *     emplacement mono-bot), que la migration a pu déplacer… ou pas (surcharge
 *     de déploiement hors volume, migration partielle, restauration de sauvegarde).
 *
 * ⚠️ RÉGRESSION CORRIGÉE (2026-11-14 12:10) : ce module ne cherchait QUE ①. Sur
 * une instance dont le texte vivait dans ② (ou dont ① n'existait pas encore), le
 * repli tombait sur le DÉFAUT LIVRÉ — l'utilisateur voyait « la personnalité de
 * base générique » à la place de la sienne. Les deux emplacements sont désormais
 * lus, du PLUS SPÉCIFIQUE au plus général (① puis ②), et pour TOUS les bots
 * (aucun `botId` particulier). Aucune migration destructive : on LIT ②, on ne le
 * déplace pas et on ne l'écrase pas.
 *
 * Rien n'est perdu :
 *   - fichier rempli + aucune personnalité enregistrée ⇒ le texte du fichier
 *     devient la personnalité du bot (et le journal le DIT, avec le chemin) ;
 *   - personnalité enregistrée ⇒ c'est elle, aucun fichier n'est ajouté (et le
 *     journal le DIT aussi, avec l'action pour récupérer son texte).
 *
 * ⚠️ `rules.md` n'est PAS concerné : ce ne sont pas des personnalités mais des
 * RÈGLES DURES, injectées séparément (voir `src/rules/`).
 */

import { readFileSync } from "node:fs";
import { resolve as resoudreChemin } from "node:path";

import type { ConfigRuntime } from "../config/runtime.js";
import {
  clampPersonalityText,
  personnaliteEffective,
  type FichierPersonnalite,
  type OriginePersonnaliteEffective,
  type ProvenancePersonnalite,
} from "../personality/personality.js";
import type { PersonalityPort } from "../personality/types.js";

/** Clé de configuration — la SEULE source de personnalité d'un bot. */
export const CLE_PERSONNALITE = "prompts.personnalite";

/** Journal minimal (le vrai logger d'observabilité en est un sur-ensemble). */
export interface LoggerPersonnaliteBot {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Un fichier candidat DÉSIGNÉ par son chemin (lu par ce module) ou par un port
 * déjà ouvert (tests, stores existants).
 */
export interface CandidatFichierPersonnalite {
  /** `bot` = fichier du bot ; `instance` = fichier historique de l'instance. */
  readonly portee: "bot" | "instance";
  /** Chemin du fichier (diagnostic, journal, interface). */
  readonly chemin: string;
  /**
   * Port de lecture déjà ouvert (facultatif) : évite de relire un store existant
   * (`outils.personnalite`, `personalityStore`) et rend le module testable sans
   * disque. Absent ⇒ le fichier est lu directement sur `chemin`.
   */
  readonly store?: PersonalityPort;
}

export interface OptionsPersonnaliteBot {
  /** Bot concerné (journalisation, diagnostic). */
  readonly botId: string;
  /**
   * Configuration de CE bot (`ConfigRuntime` de son overlay). Absente ⇒ aucune
   * personnalité n'a pu être renseignée : les fichiers d'amorçage sont le recours.
   */
  readonly config: ConfigRuntime | undefined;
  /**
   * ⚠️ Fichiers d'amorçage candidats, du PLUS SPÉCIFIQUE au plus GÉNÉRAL :
   * `[{ portee: "bot" }, { portee: "instance" }]`. Le premier non vide gagne.
   */
  readonly fichiers?: readonly CandidatFichierPersonnalite[];
  /** (compat) port du fichier DU BOT — ignoré si `fichiers` est fourni. */
  readonly store?: PersonalityPort;
  /** (compat) chemin du fichier du bot (journal). */
  readonly cheminFichier?: string;
  readonly logger?: LoggerPersonnaliteBot;
}

export interface PersonnaliteBot {
  /** Texte retenu (vide ⇒ aucune personnalité : aucun bloc composé). */
  readonly texte: string;
  /** `champ` (configuration), `fichier` (amorçage) ou `aucune`. */
  readonly origine: OriginePersonnaliteEffective;
  /** Provenance FINE : `bot` | `fichier-bot` | `fichier-instance` | `defaut` | `aucune`. */
  readonly provenance: ProvenancePersonnalite;
  /** Chemin du fichier qui a servi (provenance `fichier-*`), sinon `null`. */
  readonly fichier: string | null;
}

/**
 * Lit un fichier de personnalité sans jamais lever (une lecture ratée = pas de
 * texte, comme le store : la borne de caractères est la même).
 */
export function lireFichierPersonnalite(chemin: string): string {
  if (chemin.trim() === "") return "";
  try {
    return clampPersonalityText(readFileSync(chemin, "utf8")).text;
  } catch {
    return "";
  }
}

/** Contenu d'un candidat : port déjà ouvert, sinon lecture directe du chemin. */
function lireCandidat(candidat: CandidatFichierPersonnalite): string {
  const store = candidat.store;
  if (store !== undefined) {
    // ⚠️ Un port dont le fichier n'est PAS celui du candidat ne dit rien de ce
    // fichier : le store d'INSTANCE du bot de la pile porte le chemin d'instance
    // alors que le candidat « bot » porte le chemin du bot. On lit alors le
    // chemin DEMANDÉ (jamais le fichier d'un autre).
    const cheminDuStore = (store as { filePath?: unknown }).filePath;
    const memeFichier =
      typeof cheminDuStore !== "string" ||
      resoudreChemin(cheminDuStore) === resoudreChemin(candidat.chemin);
    if (memeFichier) {
      try {
        return store.read().text;
      } catch {
        return "";
      }
    }
  }
  return lireFichierPersonnalite(candidat.chemin);
}

/**
 * Construit la liste des candidats, SANS doublon : quand le fichier du bot et le
 * fichier d'instance sont le MÊME fichier (`pathsForBot` en mono-bot, ou
 * surcharge de déploiement qui garde le chemin d'instance), il n'est lu qu'une
 * fois — et il est alors désigné par sa portée la plus spécifique.
 */
export function candidatsPersonnalite(
  ...listes: readonly (CandidatFichierPersonnalite | undefined)[]
): CandidatFichierPersonnalite[] {
  const vus = new Set<string>();
  const candidats: CandidatFichierPersonnalite[] = [];
  for (const candidat of listes) {
    if (candidat === undefined) continue;
    const cle = resoudreChemin(candidat.chemin);
    if (vus.has(cle)) continue;
    vus.add(cle);
    candidats.push(candidat);
  }
  return candidats;
}

/** Candidats d'un bot : son fichier d'abord, le fichier historique ensuite. */
function candidatsDesOptions(options: OptionsPersonnaliteBot): CandidatFichierPersonnalite[] {
  if (options.fichiers !== undefined) return candidatsPersonnalite(...options.fichiers);
  if (options.store === undefined) return [];
  return candidatsPersonnalite({
    portee: "bot",
    chemin: options.cheminFichier ?? "",
    store: options.store,
  });
}

/**
 * Résout la personnalité d'un bot : UN texte, jamais deux.
 *
 * ⚠️ `champRenseigne` se lit avec `originOf` : `"default"` signifie « l'utilisateur
 * n'a jamais rien enregistré » (la valeur effective est alors le texte LIVRÉ, qui
 * n'est la personnalité de personne). Toute autre origine (`store`, `env`) est un
 * choix explicite, qui l'emporte sur les fichiers.
 */
export function resoudrePersonnaliteBot(options: OptionsPersonnaliteBot): PersonnaliteBot {
  const config = options.config;
  const champ = config === undefined ? "" : config.getString(CLE_PERSONNALITE);
  const champRenseigne =
    config !== undefined && config.originOf(CLE_PERSONNALITE) !== "default";

  const candidats = candidatsDesOptions(options);
  const fichiers: FichierPersonnalite[] = candidats.map((candidat) => ({
    portee: candidat.portee,
    chemin: candidat.chemin,
    texte: lireCandidat(candidat),
  }));
  // Le fichier le PLUS SPÉCIFIQUE qui contient du texte : celui qui a servi, ou
  // celui qu'une valeur enregistrée rend inutile (le journal doit dire lequel).
  const fichierRempli = fichiers.find((fichier) => fichier.texte.trim() !== "");

  const effective = personnaliteEffective({ champ, champRenseigne, fichiers });
  const cheminServi = effective.fichier?.chemin ?? null;

  // ⚠️ Ce que le démarrage doit DIRE : sans ces lignes, un texte d'identité
  // disparaîtrait (ou changerait) en silence — exactement ce que ce lot interdit.
  if (effective.origine === "fichier" && options.logger !== undefined) {
    options.logger.info("personality.amorcee_depuis_fichier", {
      bot: options.botId,
      portee: effective.fichier?.portee,
      ...(cheminServi !== null ? { fichier: cheminServi } : {}),
      chars: Array.from(effective.texte).length,
      consequence:
        effective.provenance === "fichier-instance"
          ? "aucune personnalité n'était enregistrée pour ce bot : le texte du fichier HISTORIQUE de l'instance est utilisé"
          : "aucune personnalité n'était enregistrée pour ce bot : le texte du fichier d'amorçage du bot est utilisé",
      action:
        "pour le figer (et cesser de dépendre du fichier), collez-le dans « Personnalité » du bot puis videz le fichier",
    });
  }
  if (
    effective.origine === "champ" &&
    champRenseigne &&
    fichierRempli !== undefined &&
    options.logger !== undefined
  ) {
    options.logger.warn("personality.fichier_ignore", {
      bot: options.botId,
      portee: fichierRempli.portee,
      ...(fichierRempli.chemin !== "" ? { fichier: fichierRempli.chemin } : {}),
      champ: CLE_PERSONNALITE,
      origineChamp: config?.originOf(CLE_PERSONNALITE),
      consequence:
        "la personnalité enregistrée du bot est utilisée ; aucun fichier personality.md n'est injecté dans le prompt",
      action:
        "si ce texte du fichier doit être conservé, collez-le dans « Personnalité » du bot ; sinon le fichier peut rester sur le disque (il ne sert plus qu'à amorcer un bot sans personnalité)",
    });
  }
  if (effective.provenance === "defaut" && options.logger !== undefined) {
    // Dernière ligne de défense : aucun fichier rempli, aucune valeur enregistrée.
    // L'utilisateur doit savoir que le texte composé est le DÉFAUT LIVRÉ.
    options.logger.info("personality.defaut_livre", {
      bot: options.botId,
      fichiersLus: fichiers.length,
      chars: Array.from(effective.texte).length,
      consequence:
        "aucune personnalité enregistrée et aucun fichier d'amorçage rempli : le défaut livré est utilisé",
      action: "collez la personnalité voulue dans « Personnalité » du bot",
    });
  }

  return {
    texte: effective.texte,
    origine: effective.origine,
    provenance: effective.provenance,
    fichier: effective.origine === "fichier" ? cheminServi : null,
  };
}
