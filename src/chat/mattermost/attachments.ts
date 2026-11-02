/**
 * PIÈCES JOINTES Mattermost — liaison de la couche GÉNÉRIQUE (lot 21).
 *
 * ⚠️ Depuis le lot 21, la mécanique commune (garde d'appartenance, cache LRU borné,
 * détection par octets, politique de vision partagée, `notes`) vit dans
 * `src/chat/attachments.ts`. Ce fichier ne contient plus que ce qui est PROPRE à
 * Mattermost : comment on demande les métadonnées (`GET /files/<id>/info`) et comment on
 * télécharge les octets (`GET /files/<id>`), avec le MÊME débit et le MÊME backoff que le
 * reste du client REST.
 *
 * ⚠️ Le nom `MattermostAttachmentCache` et les réexports ci-dessous sont CONSERVÉS : des
 * appels existants (câblage, tests) les utilisent, et un renommage n'apporterait rien.
 */

import type { ChatAttachmentPort, AttachmentReadOutcome } from "../attachments.js";
import { ChatAttachmentCache } from "../attachments.js";
import type { ChatMirrorStore } from "../mirror/store.js";
import type { MattermostClient } from "./client.js";

export {
  ATTACHMENT_CACHE_MAX_BYTES,
  ATTACHMENT_CACHE_MAX_ENTRIES,
  ChatAttachmentCache,
  prepareMessageImages,
  type AttachmentReadOutcome,
  type ChatAttachmentPort,
  type PrepareMessageImagesInput,
  type PrepareMessageImagesResult,
} from "../attachments.js";

export interface MattermostAttachmentCacheOptions {
  client: MattermostClient;
  store: ChatMirrorStore;
  logger?: { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void };
  /** Taille maximale téléchargée (octets), relue à chaque appel. */
  maxBytes?: () => number;
  /** Horloge injectée (tests). */
  now?: () => number;
}

/** Port Mattermost : métadonnées d'un fichier, puis ses octets (jamais son contenu en trop). */
export function mattermostAttachmentPort(client: MattermostClient): ChatAttachmentPort {
  return {
    platform: "mattermost",
    async metadata(fileId: string) {
      const info = await client.fileInfo(fileId);
      return {
        ...(typeof info.name === "string" && info.name !== "" ? { nom: info.name } : {}),
        ...(typeof info.size === "number" ? { taille: info.size } : {}),
        ...(typeof info.mime_type === "string" && info.mime_type !== ""
          ? { mime: info.mime_type }
          : {}),
      };
    },
    download(fileId: string, request) {
      return client.downloadFile(fileId, { maxBytes: request.maxBytes });
    },
  };
}

/**
 * Cache de pièces jointes Mattermost (même objet qu'avant, branché sur le port).
 *
 * ⚠️ Le cache ne dispense JAMAIS de la garde d'appartenance : celle-ci est revérifiée à
 * chaque appel, avant toute lecture du cache.
 */
export class MattermostAttachmentCache extends ChatAttachmentCache {
  constructor(options: MattermostAttachmentCacheOptions) {
    super({
      port: mattermostAttachmentPort(options.client),
      store: options.store,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }
}

/** Type d'issue d'une lecture, réexporté pour les appelants historiques. */
export type { AttachmentReadOutcome as MattermostAttachmentOutcome };
