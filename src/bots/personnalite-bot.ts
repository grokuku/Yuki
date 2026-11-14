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
 * origine, et c'est ce texte que `composerPromptSysteme` compose.
 *
 * Le fichier `personality.md` SURVIT sur le disque : il devient un simple
 * **défaut d'amorçage**, lu une fois par bot, utilisé SEULEMENT si aucune
 * personnalité n'a été RENSEIGNÉE. Rien n'est perdu :
 *   - fichier rempli + aucune personnalité enregistrée ⇒ le texte du fichier
 *     devient la personnalité du bot (et le journal le DIT) ;
 *   - personnalité enregistrée ⇒ c'est elle, le fichier n'est PAS ajouté (et le
 *     journal le DIT aussi, avec l'action pour récupérer son texte).
 *
 * ⚠️ `rules.md` n'est PAS concerné : ce ne sont pas des personnalités mais des
 * RÈGLES DURES, injectées séparément (voir `src/rules/`).
 */

import type { ConfigRuntime } from "../config/runtime.js";
import {
  personnaliteEffective,
  type OriginePersonnaliteEffective,
} from "../personality/personality.js";
import type { PersonalityPort } from "../personality/types.js";

/** Clé de configuration — la SEULE source de personnalité d'un bot. */
export const CLE_PERSONNALITE = "prompts.personnalite";

/** Journal minimal (le vrai logger d'observabilité en est un sur-ensemble). */
export interface LoggerPersonnaliteBot {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface OptionsPersonnaliteBot {
  /** Bot concerné (journalisation, diagnostic). */
  readonly botId: string;
  /**
   * Configuration de CE bot (`ConfigRuntime` de son overlay). Absente ⇒ aucune
   * personnalité n'a pu être renseignée : le fichier d'amorçage est le recours.
   */
  readonly config: ConfigRuntime | undefined;
  /**
   * Store du fichier `personality.md` de CE bot — l'AUTRE candidat, en lecture
   * seule. Absent ⇒ pas d'amorçage possible.
   */
  readonly store: PersonalityPort | undefined;
  /** Chemin du fichier, pour le journal (jamais le contenu). */
  readonly cheminFichier?: string;
  readonly logger?: LoggerPersonnaliteBot;
}

export interface PersonnaliteBot {
  /** Texte retenu (vide ⇒ aucune personnalité : aucun bloc composé). */
  readonly texte: string;
  /** `champ` (configuration), `fichier` (amorçage) ou `aucune`. */
  readonly origine: OriginePersonnaliteEffective;
}

/** Lit le fichier d'amorçage sans jamais lever (une lecture ratée = pas de texte). */
function lireFichier(store: PersonalityPort | undefined): string {
  if (store === undefined) return "";
  try {
    return store.read().text;
  } catch {
    return "";
  }
}

/**
 * Résout la personnalité d'un bot : UN texte, jamais deux.
 *
 * ⚠️ `champRenseigne` se lit avec `originOf` : `"default"` signifie « l'utilisateur
 * n'a jamais rien enregistré » (la valeur effective est alors le texte LIVRÉ, qui
 * n'est la personnalité de personne). Toute autre origine (`store`, `env`) est un
 * choix explicite, qui l'emporte sur le fichier.
 */
export function resoudrePersonnaliteBot(options: OptionsPersonnaliteBot): PersonnaliteBot {
  const config = options.config;
  const champ = config === undefined ? "" : config.getString(CLE_PERSONNALITE);
  const champRenseigne =
    config !== undefined && config.originOf(CLE_PERSONNALITE) !== "default";
  const fichier = lireFichier(options.store);

  const effective = personnaliteEffective({ champ, champRenseigne, fichier });

  // ⚠️ Ce que le démarrage doit DIRE : sans ces deux lignes, un texte d'identité
  // disparaîtrait (ou changerait) en silence — exactement ce que ce lot interdit.
  if (effective.origine === "fichier" && options.logger !== undefined) {
    options.logger.info("personality.amorcee_depuis_fichier", {
      bot: options.botId,
      ...(options.cheminFichier !== undefined ? { fichier: options.cheminFichier } : {}),
      chars: Array.from(effective.texte).length,
      consequence:
        "aucune personnalité n'était enregistrée pour ce bot : le texte du fichier d'amorçage est utilisé",
      action:
        "pour le figer (et cesser de dépendre du fichier), collez-le dans « Personnalité » du bot puis videz le fichier",
    });
  }
  if (effective.origine === "champ" && fichier.trim() !== "" && options.logger !== undefined) {
    options.logger.warn("personality.fichier_ignore", {
      bot: options.botId,
      ...(options.cheminFichier !== undefined ? { fichier: options.cheminFichier } : {}),
      champ: CLE_PERSONNALITE,
      origineChamp: config?.originOf(CLE_PERSONNALITE),
      consequence:
        "la personnalité enregistrée du bot est utilisée ; le fichier personality.md n'est PLUS injecté dans le prompt",
      action:
        "si ce texte du fichier doit être conservé, collez-le dans « Personnalité » du bot ; sinon le fichier peut rester sur le disque (il ne sert plus qu'à amorcer un bot sans personnalité)",
    });
  }

  return { texte: effective.texte, origine: effective.origine };
}
