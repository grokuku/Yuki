/**
 * PROMPT DU WORKER LOURD — LE BOT PROPRIÉTAIRE, PAS UN EXÉCUTEUR ANONYME.
 *
 * ⚠️ LE DÉFAUT QUE CE MODULE FERME (audit 2026-11-20) : un run PLANIFIÉ (tâche
 * de `planifier_tache`, étape de chaîne, déclencheur) s'exécute par le worker
 * lourd, et ce worker ne recevait que `{nom, prompt: prompts.heavy, outils}`.
 * `composerPromptSysteme` excluait même la personnalité pour le rôle `heavy` :
 * un bot exécutait SA tâche sans savoir qui il était, sans ses consignes, sans
 * ses faits, sans ses règles. Le nom seul ne fait pas une identité.
 *
 * ⚠️ L'ORDRE DES BLOCS est celui de la conversation
 * (`src/consignes/injection.ts`, `src/llm/prompt-du-tour.ts`) :
 *
 *     identité → personnalité → consignes/faits → prompt lourd → outils → règles
 *
 * `<regles>` reste EN DERNIER et prime (décision du 2026-11-14). Ce module ne
 * réécrit AUCUN texte : il assemble des blocs, comme le fait le tour léger.
 *
 * ⚠️ SOURCES PAR BOT, JAMAIS PAR DÉFAUT :
 *  - personnalité : `resoudrePersonnaliteBot` (champ du bot → fichiers
 *    d'amorçage → défaut livré), la MÊME résolution que la conversation ;
 *  - consignes/faits : `consignes.md` DU BOT (aucune cascade : un bot n'hérite
 *    pas des consignes d'un autre) ;
 *  - règles : fichier DU BOT puis fichier d'instance, même résolution que le
 *    host de conversation.
 *
 * ⚠️ RELU À CHAQUE JOB : l'appelant fournit `config` et les ports ; `reload()`
 * est fait ici, car le cache d'un `ConfigRuntime` de bot NON-pile est figé au
 * démarrage (l'overlay est écrit par la route d'un autre bot).
 *
 * ⚠️ CE QUE LE LOURD NE DOIT PAS AVOIR n'est pas décidé ici : la publication, la
 * délégation et `capture_libraire` sont fermées par `TOOL_POLICY.heavy` et par
 * l'allowlist (`heavyToolOptions`). Ce module ne fait qu'annoncer la liste reçue.
 *
 * Aucun import SDK/typebox : données pures, testable sans SDK.
 */

import type { ConfigRuntime } from "../config/runtime.js";
import {
  blocsConsignes,
  insererConsignes,
  type PortConsignes,
} from "../consignes/index.js";
import { composerPromptSysteme } from "../llm/prompt-systeme.js";
import type { CandidatFichierPersonnalite } from "./personnalite-bot.js";
import { resoudrePersonnaliteBot } from "./personnalite-bot.js";
import type { PortReglesBot } from "../rules/regles-bot.js";
import { frameRules } from "../rules/rules.js";

/** Journal minimal attendu (le `Logger` de l'application le satisfait). */
export interface LoggerPromptLourd {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface OptionsPromptLourd {
  /** Bot PROPRIÉTAIRE du run (journalisation, personnalité). */
  readonly botId: string;
  /** Nom AFFICHÉ du bot (registre) — l'identité injectée. */
  readonly nom: string;
  /** Configuration DU BOT (relue sur le disque avant composition). */
  readonly config: ConfigRuntime;
  /**
   * Fichiers d'amorçage de la personnalité, du PLUS SPÉCIFIQUE au plus général
   * (`<state>/bots/<id>/personality.md`, puis `<state>/personality.md`).
   */
  readonly fichiersPersonnalite?: readonly CandidatFichierPersonnalite[];
  /** Consignes durables DU BOT (`<state>/bots/<id>/consignes.md`). */
  readonly consignes?: PortConsignes;
  /** Règles DU BOT (fichier du bot, puis fichier d'instance). */
  readonly regles?: PortReglesBot;
  /** Allowlist FINALE du bot (la même que sa politique d'outils). */
  readonly outils: readonly string[];
  readonly logger?: LoggerPromptLourd;
}

/** Lit les consignes sans jamais faire échouer le job (listes omises). */
function lireConsignes(
  port: PortConsignes | undefined,
  botId: string,
  logger: LoggerPromptLourd | undefined,
): string {
  if (port === undefined) return "";
  try {
    return blocsConsignes(port.lire());
  } catch (error) {
    logger?.warn("consignes.inject.failed", {
      bot: botId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

/** Lit les règles sans jamais faire échouer le job (bloc omis). */
function lireRegles(
  port: PortReglesBot | undefined,
  botId: string,
  logger: LoggerPromptLourd | undefined,
): string {
  if (port === undefined) return "";
  try {
    return frameRules(port.read().text);
  } catch (error) {
    logger?.warn("rules.inject.failed", {
      bot: botId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  }
}

/**
 * Ajoute un bloc EN DERNIER (règles), sans réécrire le prompt ni créer de bloc
 * vide. Exporté pour que l'ordre soit verrouillé par un test isolé.
 */
export function ajouterReglesEnDernier(prompt: string, bloc: string): string {
  const texte = bloc.trim();
  if (texte === "") return prompt;
  const base = prompt.trim();
  return base === "" ? texte : `${base}\n\n${texte}`;
}

/**
 * Compose le prompt système d'un run LOURD pour UN bot.
 *
 * ⚠️ Échoue sur le code d'origine : la personnalité n'était pas composée pour
 * le rôle lourd, et ni les consignes ni les règles n'étaient lues. Un run
 * planifié de `grolaf` ne contenait donc ni « Grolaf », ni sa personnalité.
 */
export function composerPromptLourd(options: OptionsPromptLourd): string {
  // ⚠️ RELECTURE DISQUE : l'overlay d'un bot non-pile est figé au démarrage.
  options.config.reload();

  const personnalite = resoudrePersonnaliteBot({
    botId: options.botId,
    config: options.config,
    ...(options.fichiersPersonnalite !== undefined
      ? { fichiers: options.fichiersPersonnalite }
      : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  }).texte;

  // identité → personnalité → prompt lourd → outils
  const base = composerPromptSysteme({
    nom: options.nom,
    personnalite,
    prompt: options.config.getString("prompts.heavy"),
    outils: options.outils,
    role: "heavy",
  });

  // consignes/faits APRÈS la personnalité, AVANT le prompt lourd
  const avecConsignes = insererConsignes(
    base,
    lireConsignes(options.consignes, options.botId, options.logger),
  );

  // règles EN DERNIER (elles priment)
  return ajouterReglesEnDernier(
    avecConsignes,
    lireRegles(options.regles, options.botId, options.logger),
  );
}
