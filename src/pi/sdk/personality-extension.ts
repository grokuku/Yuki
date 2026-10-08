/**
 * Extension SDK : personnalité de Yuki (base du prompt de chaque tour).
 *
 * Enregistrée INLINE via `extensionFactories`. À CHAQUE tour
 * (`before_agent_start`), elle relit le fichier de personnalité et AJOUTE le
 * bloc encadré au PROMPT SYSTÈME du tour — mécanisme NON PERSISTÉ : on
 * augmente seulement `systemPrompt` (« Replace the system prompt for this turn »
 * → le SDK chaîne les extensions qui le modifient), JAMAIS `message` (qui
 * créerait une entrée de session persistée).
 *
 * ⚠️ Elle est enregistrée EN PREMIER (voir `sdk-host.ts`) : l'ordre final du
 * prompt est **personnalité → mémoire → annuaire → heritage**. Chaque extension
 * CONCATÈNE au prompt courant, donc aucun bloc n'écrase un autre.
 *
 * Fichier ABSENT ou VIDE ⇒ RIEN n'est injecté (aucun bloc vide).
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import { framePersonality } from "../../personality/personality.js";
import type { PersonalityPort } from "../../personality/types.js";

/** Nom d'extension (aussi utilisé pour vérifier l'ordre de chaînage). */
export const PERSONALITY_EXTENSION_NAME = "yuki-personality";

export interface PersonalityExtensionOptions {
  /** Journal facultatif : un échec de lecture est signalé, le tour continue. */
  logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}

/**
 * Construit la fabrique d'extension de personnalité. Le port est capturé par
 * closure ; la lecture est faite À CHAQUE tour (mise à jour à chaud, sans
 * redémarrage).
 */
export function createPersonalityExtensionFactory(
  personality: PersonalityPort,
  options: PersonalityExtensionOptions = {},
): InlineExtension {
  return {
    name: PERSONALITY_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", (event) => {
        let block: string;
        try {
          block = framePersonality(personality.read().text);
        } catch (error) {
          // Ne JAMAIS faire échouer le tour : une personnalité illisible est omise.
          options.logger?.warn("personality.inject.failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
        if (block.length === 0) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
      });
    },
  };
}
