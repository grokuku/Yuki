/**
 * Extension SDK : RÈGLES STRICTES de Yuki (première base du prompt de chaque
 * tour).
 *
 * Enregistrée INLINE via `extensionFactories`. À CHAQUE tour
 * (`before_agent_start`), elle relit le fichier `rules.md` et AJOUTE le bloc
 * encadré au PROMPT SYSTÈME du tour — mécanisme NON PERSISTÉ : on augmente
 * seulement `systemPrompt` (« Replace the system prompt for this turn » → le SDK
 * chaîne les extensions qui le modifient), JAMAIS `message` (qui créerait une
 * entrée de session persistée).
 *
 * ⚠️ Elle est enregistrée EN PREMIER (voir `sdk-host.ts`) : l'ordre final du
 * prompt est **règles → personnalité → mémoire → annuaire → heritage**. Chaque
 * extension CONCATÈNE au prompt courant, donc aucun bloc n'écrase un autre.
 *
 * ⚠️ LECTURE SEULE côté modèle : cette extension n'expose AUCUN outil et
 * n'utilise que `RulesPort.read()`. Yuki ne peut donc PAS écrire ses règles :
 * seule l'API HTTP gardée de l'interface `/config` le permet, à l'utilisateur.
 *
 * Fichier ABSENT ou VIDE ⇒ RIEN n'est injecté (aucun en-tête orphelin).
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import { frameRules } from "../../rules/rules.js";
import type { RulesPort } from "../../rules/types.js";

/** Nom d'extension (aussi utilisé pour vérifier l'ordre de chaînage). */
export const RULES_EXTENSION_NAME = "yuki-rules";

export interface RulesExtensionOptions {
  /** Journal facultatif : un échec de lecture est signalé, le tour continue. */
  logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}

/**
 * Construit la fabrique d'extension des règles. Le port est capturé par closure ;
 * la lecture est faite À CHAQUE tour (mise à jour à chaud, sans redémarrage).
 */
export function createRulesExtensionFactory(
  rules: RulesPort,
  options: RulesExtensionOptions = {},
): InlineExtension {
  return {
    name: RULES_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", (event) => {
        let block: string;
        try {
          block = frameRules(rules.read().text);
        } catch (error) {
          // Ne JAMAIS faire échouer le tour : des règles illisibles sont omises.
          options.logger?.warn("rules.inject.failed", {
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
