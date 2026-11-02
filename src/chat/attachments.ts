/**
 * PIÈCES JOINTES d'une conversation DISTANTE — téléchargement À LA DEMANDE, cache, et
 * préparation pour le modèle de vision (lot 21 : couche GÉNÉRIQUE, partagée par Mattermost
 * et Discord).
 *
 * ⚠️ POURQUOI CE MODULE EST GÉNÉRIQUE : au lot 19, cette mécanique vivait dans
 * `src/chat/mattermost/attachments.ts` et nommait Mattermost partout. Rien n'y était
 * propre à Mattermost SAUF la façon de télécharger (deux appels REST) : tout le reste —
 * garde d'appartenance, cache LRU borné, détection par octets, politique de vision
 * partagée, `notes` — est COMMUN. Le lot 21 a donc remonté la partie commune ici, et
 * chaque plateforme n'apporte plus qu'un PORT (`ChatAttachmentPort`).
 *
 * TROIS RÈGLES, dans cet ordre :
 *
 *  1. **SÉCURITÉ — un identifiant deviné ne lit RIEN.** Les deux plateformes servent un
 *     fichier à quiconque possède l'identifiant/l'URL. On exige donc que le fichier soit
 *     référencé par un message du canal DEMANDÉ, et que ce canal soit dans le miroir des
 *     canaux SUIVIS. Sans cette garde, connaître un identifiant suffirait pour lire
 *     n'importe quel fichier.
 *
 *  2. **PAS DE TÉLÉCHARGEMENT EN ARRIÈRE-PLAN.** Rien n'est lu pendant la
 *     synchronisation : un backfill de 1 000 messages déclencherait des milliers de
 *     requêtes. On télécharge au moment où l'image sert (un message auquel Yuki doit
 *     répondre), et le résultat est gardé en mémoire par identifiant.
 *
 *  3. **BORNES EXPLICITES.** Taille maximale téléchargée (refus explicite, connexion
 *     coupée dès dépassement) et politique de VISION PARTAGÉE (`src/files/vision.ts`).
 *     Aucune image n'est jamais transmise « en silence » : ce qui n'est pas joint est
 *     DIT (`notes`).
 *
 * ⚠️ DÉTECTION PAR OCTETS : ni Mattermost ni Discord ne fournissent un type MIME fiable
 * à 100 % (Discord peut l'omettre, Mattermost peut le déduire d'une extension). Le type
 * d'image est donc déduit de la SIGNATURE des octets (`imageMimeFromBytes`).
 */

import { imageMimeFromBytes, imageSize } from "../files/analyze.js";
import { prepareVisionImage, type VisionImageResizer } from "../files/vision.js";
import type { FileImageContent } from "../files/types.js";
import type { ChatMirrorStore } from "./mirror/store.js";
import type { RemoteAttachment, RemoteMessage, RemotePlatform } from "./types.js";

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface ChatAttachmentsLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Nombre maximal d'entrées gardées en cache (borne mémoire explicite). */
export const ATTACHMENT_CACHE_MAX_ENTRIES = 32;

/** Octets maximaux gardés en cache, toutes entrées confondues (48 Mio). */
export const ATTACHMENT_CACHE_MAX_BYTES = 48 * 1024 * 1024;

/**
 * Issue d'une lecture de pièce jointe.
 *
 * ⚠️ Un refus n'est jamais silencieux : il porte un CODE stable et une phrase française.
 */
export type AttachmentReadOutcome =
  | {
      ok: true;
      bytes: Buffer;
      /** Nom d'affichage (métadonnées distantes, ou l'identifiant à défaut). */
      nom: string;
      mime?: string;
      taille?: number;
      /** `true` quand les octets venaient du cache (aucun appel réseau). */
      cached: boolean;
    }
  | {
      ok: false;
      code: "canal_inconnu" | "non_reference" | "trop_lourd" | "indisponible";
      message: string;
    };

/**
 * PORT de fichiers d'une plateforme (la SEULE chose qui lui soit propre).
 *
 * ⚠️ `download` reçoit la pièce jointe TELLE QU'ELLE EST DANS LE MIROIR (`attachment`) et
 * le message qui la porte (`message`) : une plateforme dont les URL sont signées et
 * expirantes (Discord) peut ainsi rafraîchir le lien sans jamais accepter d'URL venue de
 * l'appelant.
 */
export interface ChatAttachmentPort {
  /** Plateforme servie : la conversation DEMANDÉE doit lui appartenir. */
  readonly platform: RemotePlatform;
  /**
   * Renseigne les MÉTADONNÉES (nom, taille, MIME) quand la plateforme ne les fournit pas
   * dans le message. ⚠️ Absent = elles sont déjà dans le miroir (cas de Discord).
   */
  metadata?(fileId: string): Promise<{ nom?: string; taille?: number; mime?: string }>;
  /** Octets BORNÉS (la borne est vérifiée par la lecture, pas seulement annoncée). */
  download(
    fileId: string,
    request: { maxBytes: number; attachment?: RemoteAttachment; message?: RemoteMessage },
  ): Promise<Buffer>;
}

export interface ChatAttachmentCacheOptions {
  port: ChatAttachmentPort;
  store: ChatMirrorStore;
  logger?: ChatAttachmentsLogger;
  /** Taille maximale téléchargée (octets), relue à chaque appel. */
  maxBytes?: () => number;
  /** Horloge injectée (tests). */
  now?: () => number;
}

interface CacheEntry {
  bytes: Buffer;
  nom: string;
  mime?: string;
  taille?: number;
}

/**
 * Cache de pièces jointes, PAR identifiant distant.
 *
 * ⚠️ Le cache ne dispense JAMAIS de la garde d'appartenance : celle-ci est revérifiée à
 * chaque appel, avant toute lecture du cache. Un fichier retiré d'un canal ne doit pas
 * rester lisible depuis ce canal parce qu'il était en mémoire.
 */
export class ChatAttachmentCache {
  private readonly port: ChatAttachmentPort;
  private readonly store: ChatMirrorStore;
  private readonly logger: ChatAttachmentsLogger | undefined;
  private readonly maxBytes: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private cachedBytes = 0;
  private downloads = 0;

  constructor(options: ChatAttachmentCacheOptions) {
    this.port = options.port;
    this.store = options.store;
    this.logger = options.logger;
    this.maxBytes = options.maxBytes ?? (() => 20 * 1024 * 1024);
  }

  /** Taille du cache (mesure ; jamais un contenu). */
  get size(): number {
    return this.cache.size;
  }

  /** Nombre de TÉLÉCHARGEMENTS réels effectués (mesure, tests). */
  get downloadCount(): number {
    return this.downloads;
  }

  /** Vide le cache (le disque et le miroir ne sont pas touchés). */
  clear(): void {
    this.cache.clear();
    this.cachedBytes = 0;
  }

  /**
   * Lit une pièce jointe d'un canal suivi.
   *
   * @param conversationId identifiant Yuki du canal (`mm-…` / `dc-…`) — c'est lui qui
   *   porte la garde de sûreté : le fichier doit y être référencé.
   * @param fileId identifiant distant de la pièce jointe.
   */
  async read(conversationId: string, fileId: string): Promise<AttachmentReadOutcome> {
    if (typeof fileId !== "string" || fileId === "") {
      return { ok: false, code: "non_reference", message: "Identifiant de pièce jointe vide." };
    }
    const record = this.store.record(conversationId);
    if (!record || record.platform !== this.port.platform) {
      return {
        ok: false,
        code: "canal_inconnu",
        message:
          "Ce canal n'est pas un canal suivi de cette plateforme : aucune pièce jointe n'en " +
          "est lue.",
      };
    }
    // ⚠️ GARDE DE SÛRETÉ : le fichier doit être référencé par un message de CE canal.
    // Sans elle, un identifiant deviné permettrait de lire n'importe quel fichier.
    const porteur = this.store.attachmentMessage(conversationId, fileId);
    if (!porteur) {
      this.logger?.warn("chat.attachments.unreferenced", {
        platform: this.port.platform,
        conversation: conversationId,
        file: fileId,
      });
      return {
        ok: false,
        code: "non_reference",
        message:
          "Cette pièce jointe n'appartient à aucun message de ce canal : elle n'est pas lue.",
      };
    }
    const attachment = porteur.attachments?.find((item) => item.id === fileId);

    const cached = this.cache.get(fileId);
    if (cached) {
      // Réinsertion : le cache se comporte comme une LRU (les plus récents à la fin).
      this.cache.delete(fileId);
      this.cache.set(fileId, cached);
      return { ok: true, bytes: cached.bytes, nom: cached.nom, cached: true, ...metaOf(cached) };
    }

    const limite = Math.max(1, Math.trunc(this.maxBytes()));
    let nom = attachment?.nom ?? fileId;
    let mime = attachment?.mime;
    let taille = attachment?.taille;
    // Métadonnées : UN appel, à la demande, SEULEMENT si la plateforme ne les fournit pas
    // déjà (Discord les fournit : aucun appel). Un échec n'empêche pas la lecture des
    // octets, mais il est journalisé.
    if (this.port.metadata) {
      try {
        const info = await this.port.metadata(fileId);
        if (typeof info.nom === "string" && info.nom !== "") nom = info.nom;
        if (typeof info.mime === "string" && info.mime !== "") mime = info.mime;
        if (typeof info.taille === "number" && Number.isFinite(info.taille)) taille = info.taille;
        this.store.setAttachmentMeta(conversationId, fileId, {
          nom,
          ...(taille !== undefined ? { taille } : {}),
          ...(mime !== undefined ? { mime } : {}),
        });
      } catch (error) {
        this.logger?.warn("chat.attachments.meta_failed", {
          platform: this.port.platform,
          conversation: conversationId,
          file: fileId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (taille !== undefined && taille > limite) {
      return {
        ok: false,
        code: "trop_lourd",
        message:
          `La pièce jointe « ${nom} » (${taille} octets) dépasse la borne de téléchargement ` +
          `(${limite} octets) : elle n'est pas lue.`,
      };
    }
    let bytes: Buffer;
    try {
      this.downloads += 1;
      bytes = await this.port.download(fileId, {
        maxBytes: limite,
        ...(attachment !== undefined ? { attachment } : {}),
        message: porteur,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.warn("chat.attachments.download_failed", {
        platform: this.port.platform,
        conversation: conversationId,
        file: fileId,
        error: message,
      });
      return {
        ok: false,
        code: "indisponible",
        message: `La pièce jointe « ${nom} » n'a pas pu être téléchargée (${message}).`,
      };
    }
    this.remember(fileId, {
      bytes,
      nom,
      ...(mime !== undefined ? { mime } : {}),
      ...(taille !== undefined ? { taille } : {}),
    });
    return {
      ok: true,
      bytes,
      nom,
      cached: false,
      ...(mime !== undefined ? { mime } : {}),
      ...(taille !== undefined ? { taille } : {}),
    };
  }

  /** Met une entrée en cache en respectant les deux bornes (entrées ET octets). */
  private remember(fileId: string, entry: CacheEntry): void {
    if (entry.bytes.length > ATTACHMENT_CACHE_MAX_BYTES) return;
    this.cache.set(fileId, entry);
    this.cachedBytes += entry.bytes.length;
    while (
      this.cache.size > ATTACHMENT_CACHE_MAX_ENTRIES ||
      this.cachedBytes > ATTACHMENT_CACHE_MAX_BYTES
    ) {
      const premier = this.cache.keys().next();
      if (premier.done === true) break;
      const ancien = this.cache.get(premier.value);
      this.cache.delete(premier.value);
      if (ancien) this.cachedBytes -= ancien.bytes.length;
    }
  }
}

/** Métadonnées optionnelles d'une entrée de cache (spread conditionnel). */
function metaOf(entry: CacheEntry): { mime?: string; taille?: number } {
  return {
    ...(entry.mime !== undefined ? { mime: entry.mime } : {}),
    ...(entry.taille !== undefined ? { taille: entry.taille } : {}),
  };
}

/** Extension attendue par la politique de vision, déduite du type MIME réel. */
const EXT_OF_MIME: ReadonlyMap<string, string> = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

export interface PrepareMessageImagesInput {
  cache: ChatAttachmentCache;
  /** Canal Yuki (`mm-…` / `dc-…`) — porte la garde d'appartenance de chaque fichier. */
  conversationId: string;
  /** Message dont on veut montrer les images au modèle. */
  message: Pick<RemoteMessage, "attachments">;
  /** Plafond en OCTETS BRUTS (`files.imageMaxBytes`). */
  maxBytes: number;
  /** Plafond en OCTETS TRANSMIS, base64 (`files.imageMaxWireBytes`). */
  maxWireBytes: number;
  /** Réducteur injecté (`sdkVisionImageResizer`) ; absent ⇒ pas de réduction possible. */
  resize?: VisionImageResizer;
}

export interface PrepareMessageImagesResult {
  /** Images prêtes pour le modèle (`ImageContent` : base64 + type MIME). */
  images: FileImageContent[];
  /**
   * Phrases françaises sur ce qui n'a PAS été transmis (fichier non image, trop lourd,
   * illisible). ⚠️ Jamais un silence : le rédacteur les reçoit, et elles finissent dans
   * le prompt du modèle.
   */
  notes: string[];
}

/**
 * Prépare les images d'un message distant pour le MODÈLE (politique de vision partagée).
 *
 * ⚠️ Une pièce jointe qui n'est pas une image n'est pas une erreur : elle n'est pas
 * transmise au modèle et c'est DIT (`notes`), parce qu'un modèle ne lit pas un PDF par ce
 * chemin.
 */
export async function prepareMessageImages(
  input: PrepareMessageImagesInput,
): Promise<PrepareMessageImagesResult> {
  const images: FileImageContent[] = [];
  const notes: string[] = [];
  for (const attachment of input.message.attachments ?? []) {
    const lecture = await input.cache.read(input.conversationId, attachment.id);
    if (!lecture.ok) {
      notes.push(lecture.message);
      continue;
    }
    // ⚠️ Détection par OCTETS : le type MIME annoncé peut manquer ou mentir.
    const mime = imageMimeFromBytes(lecture.bytes.subarray(0, 64));
    if (mime === undefined) {
      notes.push(
        `La pièce jointe « ${lecture.nom} » n'est pas une image (ou pas dans un format de ` +
          "vision : PNG, JPEG, GIF, WebP) : elle n'est pas transmise au modèle.",
      );
      continue;
    }
    const ext = EXT_OF_MIME.get(mime) ?? "bin";
    const dimensions = imageSize(lecture.bytes.subarray(0, 512 * 1024));
    const prepare = await prepareVisionImage({
      name: lecture.nom,
      bytes: lecture.bytes,
      ext,
      mimeType: mime,
      ...(dimensions !== undefined ? { width: dimensions.width, height: dimensions.height } : {}),
      maxBytes: input.maxBytes,
      maxWireBytes: input.maxWireBytes,
      ...(input.resize !== undefined ? { resize: input.resize } : {}),
    });
    if (!prepare.ok) {
      notes.push(prepare.message);
      continue;
    }
    images.push(prepare.image);
  }
  return { images, notes };
}
