/**
 * Extension SDK : CONSIGNES DURABLES du bot (`<consignes>` et `<faits>`).
 *
 * Enregistrée INLINE via `extensionFactories`. À CHAQUE tour
 * (`before_agent_start`), elle RELIT le fichier `consignes.md` du bot et INSÈRE
 * ses deux blocs dans le prompt système du tour :
 *
 *     identité → personnalité → **consignes/faits** → prompt système → outils
 *
 * ⚠️ L'INSERTION SE FAIT APRÈS `</personnalite>` (voir `insererConsignes`,
 * `src/consignes/injection.ts`). Ce n'est PAS une concaténation en fin de
 * prompt : les consignes doivent précéder le prompt système du rôle, sans jamais
 * écraser un bloc existant.
 *
 * ⚠️ `<regles>` reste EN DERNIER (extension suivante dans la chaîne) et prime :
 * les règles communes sont au-dessus des consignes d'un bot.
 *
 * ⚠️ LECTURE FRAÎCHE à chaque tour : une consigne enregistrée par l'outil
 * `memoriser_consigne` est donc active AU TOUR SUIVANT, sans redémarrage. Un
 * échec de lecture n'échoue JAMAIS le tour (les listes sont alors omises).
 *
 * ⚠️ L'extension n'expose AUCUN outil : l'écriture passe par les outils des
 * consignes (`src/pi/sdk/consignes-tools.ts`), qui écrivent dans LE fichier du
 * bot.
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import { blocsConsignes, insererConsignes } from "../../consignes/injection.js";
import type { PortConsignes } from "../../consignes/index.js";

/** Nom d'extension (aussi utilisé pour vérifier l'ordre de chaînage). */
export const CONSIGNES_EXTENSION_NAME = "yuki-consignes";

export interface ConsignesExtensionOptions {
  /** Journal facultatif : un échec de lecture est signalé, le tour continue. */
  logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}

/**
 * Construit la fabrique d'extension des consignes. Le port est capturé par
 * closure ; la lecture est faite À CHAQUE tour.
 */
export function createConsignesExtensionFactory(
  consignes: PortConsignes,
  options: ConsignesExtensionOptions = {},
): InlineExtension {
  return {
    name: CONSIGNES_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", (event) => {
        let blocs: string;
        try {
          blocs = blocsConsignes(consignes.lire());
        } catch (error) {
          // Ne JAMAIS faire échouer le tour : des consignes illisibles sont omises.
          options.logger?.warn("consignes.inject.failed", {
            error: error instanceof Error ? error.message : String(error),
            fichier: consignes.chemin(),
          });
          return undefined;
        }
        if (blocs === "") return undefined;
        return { systemPrompt: insererConsignes(event.systemPrompt, blocs) };
      });
    },
  };
}
