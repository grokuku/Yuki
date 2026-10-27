/**
 * Extension SDK des STYLES d'images (confidentiel — `src/pi/sdk/**` uniquement).
 *
 * Enregistrée INLINE via `resourceLoaderOptions.extensionFactories`. Elle câble
 * la LISTE des workflows ComfyUI sur le cycle de vie du SDK :
 *
 *  - `before_agent_start` : INJECTION. On augmente le PROMPT SYSTÈME du tour
 *    (`systemPrompt`) — mécanisme le MOINS INTRUSIF : le résultat est « for this
 *    turn » et n'est JAMAIS persisté comme entrée de session, donc il n'apparaît
 *    ni dans le transcript, ni dans l'UI, ni dans le rejeu.
 *    ⚠️ Retourner `message` créerait au contraire un `CustomMessageEntry`
 *    PERSISTÉ (pollution) : on ne le fait jamais.
 *
 * ⚠️ CE QUE CETTE EXTENSION NE FAIT PAS, ET NE DOIT PAS FAIRE :
 *  - elle n'ouvre AUCUN tour (elle ne fait que lire la liste des workflows au
 *    moment où un tour est DÉJÀ déclenché par l'utilisateur) ;
 *  - elle n'appelle AUCUN réseau (elle lit le fichier local des workflows) ;
 *  - elle ne dit jamais QUEL style a été choisi : elle ne fait que proposer.
 *
 * La liste est relue À CHAQUE TOUR : un workflow importé depuis `/config` est
 * connu du modèle au tour suivant, sans redémarrage.
 */

import type {
  ExtensionAPI,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";

import {
  formatImageStylesBlock,
  type WorkflowCandidate,
} from "../../comfy/index.js";
import type { PiLogger } from "../types.js";

export interface ImageStylesPort {
  /** Workflows disponibles (nom d'usage + description + « par défaut »). */
  candidates(): WorkflowCandidate[];
  /** Faux ⇒ le bloc n'est pas injecté (serveur non configuré). */
  enabled(): boolean;
}

export interface ImageStylesExtensionOptions {
  logger?: PiLogger;
}

/** Nom de l'extension (verrouillé par les tests d'ordre). */
export const IMAGE_STYLES_EXTENSION_NAME = "yuki-image-styles";

/** Fabrique l'extension d'injection de la liste des styles. */
export function createImageStylesExtensionFactory(
  port: ImageStylesPort,
  options: ImageStylesExtensionOptions = {},
): InlineExtension {
  return {
    name: IMAGE_STYLES_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", async (event) => {
        let candidates: WorkflowCandidate[];
        let enabled: boolean;
        try {
          enabled = port.enabled();
          candidates = enabled ? port.candidates() : [];
        } catch (error) {
          // Un store indisponible ne casse JAMAIS un tour : le prompt part sans
          // la liste (dégradation silencieuse, même doctrine que la mémoire).
          options.logger?.warn?.("image.styles.unavailable", {
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
        const block = formatImageStylesBlock(candidates, { enabled });
        if (!block) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
      });
    },
  };
}
