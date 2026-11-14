/**
 * Extension SDK : PROMPT DU TOUR — identité, personnalité, prompt du rôle et
 * liste d'outils RELUS À CHAQUE TOUR.
 *
 * Enregistrée INLINE via `extensionFactories`. À CHAQUE tour
 * (`before_agent_start`), elle demande le prompt du tour au port
 * (`PortPromptDuTour`) et REMPLACE le prompt système de base du host.
 *
 * ⚠️ POURQUOI CE REMPLACEMENT (bug du 2026-11-14) : le `systemPrompt` était FIGÉ
 * au démarrage. Éditer la personnalité d'un bot — ou un prompt, ou les règles —
 * n'avait donc AUCUN effet avant un redémarrage : `grolaf` avait sa personnalité
 * saisie et répondait « je suis là — Yuki ». Ici, le texte est recomposé à chaque
 * tour : le message SUIVANT porte la modification.
 *
 * ⚠️ ELLE PASSE EN PREMIER dans la chaîne (`sdk-host.ts`) : le prompt qu'elle
 * pose est la BASE des autres extensions. Les consignes/faits s'y insèrent après
 * `</personnalite>` (`src/consignes/injection.ts`) et `<regles>` est concaténé
 * EN DERNIER — l'ordre des blocs ne change pas.
 *
 * ⚠️ ELLE N'EXPOSE AUCUN OUTIL et n'écrit rien : elle ne fait que lire des
 * sources (configuration et fichiers) et composer.
 *
 * ⚠️ UN ÉCHEC DE RELECTURE N'ÉCHOUE PAS LE TOUR : le port rend la DERNIÈRE valeur
 * connue (jamais un prompt vide) et le journal le dit. Si même cette valeur
 * manque, l'extension ne modifie RIEN et le host garde son prompt d'origine.
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import type { PortPromptDuTour } from "../../llm/prompt-du-tour.js";

/** Nom d'extension (aussi utilisé pour vérifier l'ordre de chaînage). */
export const PROMPT_DU_TOUR_EXTENSION_NAME = "yuki-prompt-du-tour";

export interface PromptDuTourExtensionOptions {
  /** Journal facultatif : un échec de relecture est signalé, le tour continue. */
  logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}

/**
 * Construit la fabrique d'extension du prompt du tour. Le port est capturé par
 * closure ; la LECTURE est faite à chaque tour.
 */
export function createPromptDuTourExtensionFactory(
  port: PortPromptDuTour,
  options: PromptDuTourExtensionOptions = {},
): InlineExtension {
  return {
    name: PROMPT_DU_TOUR_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", () => {
        let prompt: string;
        try {
          prompt = port.lire();
        } catch (error) {
          // Le port ne lève pas (il a sa dernière valeur connue) ; ce filet évite
          // qu'une future implémentation fasse échouer le tour.
          options.logger?.warn("prompt.du_tour.inject.failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
        // Rien à poser : le host garde SON prompt (aucun prompt vide envoyé).
        if (prompt.trim() === "") return undefined;
        return { systemPrompt: prompt };
      });
    },
  };
}
