/**
 * Extension SDK : signal d'EXISTENCE de l'archive « vie antérieure » (Lot 13).
 *
 * Enregistrée INLINE via `extensionFactories`. À CHAQUE tour, SI (et seulement
 * si) l'archive existe, elle AJOUTE au PROMPT SYSTÈME du tour **une seule ligne
 * courte** indiquant qu'une archive d'une vie antérieure existe, qu'elle n'est
 * pas fusionnée, et que l'outil `archive_vie_anterieure` permet de la consulter
 * à la demande. **Aucun contenu d'archive n'est jamais injecté.**
 *
 * Décision : cette ligne est un COMPROMIS assumé.
 *  - Sans elle, le modèle ignore l'existence de l'archive et ne la consulterait
 *    jamais → l'archive serait inutilisable.
 *  - Elle ne porte AUCUN contenu (aucun risque de fusion) et n'est PAS
 *    l'archive : c'est une simple métadonnée de ~1 ligne par tour.
 *  - Le prompt système est « for this turn » (non persisté) : il n'est ni dans le
 *    transcript, ni dans l'UI, ni lu par l'extracteur (qui ne lit que les
 *    messages). Aucun risque d'absorption.
 *
 * ⚠️ Comme pour l'annuaire d'agents : un échec de lecture ne doit JAMAIS faire
 * échouer le tour (l'extension est omise, le tour continue).
 */

import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

import { HERITAGE_LABEL, type HeritagePort } from "../../memory/heritage.js";

/** Ligne (unique) signalant l'existence de l'archive, sans son contenu. */
export const HERITAGE_NOTICE =
  `Une archive « vie antérieure » existe (${HERITAGE_LABEL}), séparée de la ` +
  "mémoire courante. Elle n'est consultable QU'À LA DEMANDE via l'outil " +
  "`archive_vie_anterieure` ; ne la mémorise JAMAIS et ne la fusionne JAMAIS " +
  "avec la mémoire courante.";

export interface HeritageExtensionOptions {
  /** Journal facultatif : un échec de lecture est signalé, le tour continue. */
  logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}

/**
 * Construit la fabrique d'extension du signal d'archive. Ne consomme que
 * `info()` (existence + compteur) : jamais le contenu.
 */
export function createHeritageExtensionFactory(
  archive: Pick<HeritagePort, "info">,
  options: HeritageExtensionOptions = {},
): InlineExtension {
  return {
    name: "yuki-heritage",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", (event) => {
        let present = false;
        try {
          present = archive.info().entries > 0;
        } catch (error) {
          options.logger?.warn("memory.heritage.inject.failed", {
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
        if (!present) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${HERITAGE_NOTICE}` };
      });
    },
  };
}
