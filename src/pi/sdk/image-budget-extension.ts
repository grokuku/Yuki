/**
 * Extension SDK : BORNE des images TRANSMISES à chaque appel modèle.
 *
 * ⚠️ Point d'ancrage choisi — l'événement `context` du SDK (« Fired before each
 * LLM call. Can modify messages »). C'est le SEUL endroit qui voit TOUS les
 * appels modèle d'un run : le premier tour, CHAQUE itération de la boucle
 * d'outils, un `steer`, un `followUp`. Le handler reçoit une COPIE des messages
 * (`core/extensions/runner.js` clone avant de le notifier) : ce qu'il renvoie
 * n'est envoyé QU'À CE tour et n'est JAMAIS persisté — l'historique du JSONL et
 * l'affichage de l'UI restent intacts.
 *
 * ⚠️ Ce que ça change concrètement : sans cette extension, une image rendue par
 * `lire_fichier` au tour 3 repart dans le corps HTTP des tours 4, 5, 6… et le
 * fournisseur finit par répondre `500 « request entity too large »` alors que le
 * contexte TEXTE est petit. Avec elle, la même image part une fois (le tour qui
 * l'a produite) puis devient un bloc texte explicite au tour suivant.
 *
 * ⚠️ La VISION n'est PAS désactivée : le modèle voit toujours l'image FRAÎCHE
 * (celle que l'outil vient de rendre, celle que l'utilisateur vient de joindre).
 * Seule la RÉPÉTITION est bornée, et le remplacement DIT comment la revoir.
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import { limitContextImages, type ContextImageStats } from "./context-images.js";

export const IMAGE_BUDGET_EXTENSION_NAME = "yuki-image-budget";

export interface ImageBudgetExtensionOptions {
  /**
   * Plafond, relu À CHAQUE appel modèle (réglage `apply: hot` : un changement
   * dans /config s'applique au tour suivant, sans redémarrage).
   */
  budgetBytes: () => number;
  /** Journal facultatif : une borne qui retire une image se DIT, jamais en silence. */
  logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  /** Étiquette de session pour le journal (facultative). */
  sessionId?: () => string | undefined;
}

/**
 * Fabrique l'extension de borne des images. Le budget est lu à chaque appel :
 * aucune valeur n'est figée à la construction de la session.
 */
export function createImageBudgetExtensionFactory(
  options: ImageBudgetExtensionOptions,
): InlineExtension {
  return {
    name: IMAGE_BUDGET_EXTENSION_NAME,
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("context", (event) => {
        // ⚠️ Une erreur ici ne doit JAMAIS casser un tour : on renvoie `undefined`
        // (le SDK garde alors le contexte tel quel, comme avant le correctif).
        let budgetBytes: number;
        try {
          budgetBytes = options.budgetBytes();
        } catch (error) {
          options.logger?.warn("pi.context_images.budget.failed", {
            ...(options.sessionId?.() !== undefined
              ? { session_id: options.sessionId?.() }
              : {}),
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
        if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) return undefined;

        const messages = event.messages;
        const { messages: limited, stats } = limitContextImages(messages, {
          budgetBytes,
        });
        if (stats.dropped === 0) return undefined;

        const fields = {
          ...(options.sessionId?.() !== undefined
            ? { session_id: options.sessionId?.() }
            : {}),
          budget_bytes: budgetBytes,
          kept_images: stats.kept,
          dropped_images: stats.dropped,
          stale_images: stats.stale,
          overflow_images: stats.overflow,
          kept_bytes: stats.keptBytes,
          dropped_bytes: stats.droppedBytes,
          messages: limited.length,
        };
        options.logger?.info("pi.context_images.limited", fields);
        // Ré-avertissement UNE fois quand des images ont été retirées sans
        // qu'aucune ne survive : le modèle doit savoir qu'il ne « revoit » rien.
        warnIfNothingKept(stats, budgetBytes, options);
        return { messages: limited };
      });
    },
  };
}

/**
 * ⚠️ CAS MUET À NE PAS LAISSER PASSER : si le budget est trop petit pour la
 * MOINDRE image, le modèle ne reçoit plus aucune image du tout et pourrait
 * affirmer l'inverse. On le journalise une fois par appel (le message est
 * borné, le journal est horodaté) — c'est la seule trace exploitable.
 */
function warnIfNothingKept(
  stats: ContextImageStats,
  budgetBytes: number,
  options: ImageBudgetExtensionOptions,
): void {
  if (stats.dropped === 0 || stats.kept > 0) return;
  options.logger?.warn("pi.context_images.empty", {
    ...(options.sessionId?.() !== undefined
      ? { session_id: options.sessionId?.() }
      : {}),
    budget_bytes: budgetBytes,
    dropped_images: stats.dropped,
    dropped_bytes: stats.droppedBytes,
    hint:
      "budget d'images par requête trop bas : aucune image n'est transmise. " +
      "Augmenter `files.imageRequestBudgetBytes` (ou baisser `files.imageMaxWireBytes`).",
  });
}
