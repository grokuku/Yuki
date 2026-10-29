/**
 * SERVICE des fichiers échangés — ce que le transport WS et l'outil du modèle
 * consomment (aucune connaissance du disque, du HTTP ni du SDK).
 *
 * Deux responsabilités :
 *  1. `attach()` : au moment où un message utilisateur part, résoudre les
 *     identifiants reçus du navigateur, les RATTACHER à la conversation, et
 *     produire (a) les MARQUEURS insérés dans le message (cartes cliquables) et
 *     (b) le BLOC `<fichiers>` borné transmis au modèle ;
 *  2. `send()` : Yuki ENVOIE un fichier de la conversation (fichier reçu, ou
 *     fichier venu d'un agent déposé dans le même stockage) — il est diffusé en
 *     trame de CONTRÔLE vers la conversation (affiché dans le fil).
 *
 * ⚠️ Aucun contenu n'est journalisé ; le service ne manipule que des
 * métadonnées et le texte d'analyse déjà borné.
 */

import {
  formatFileMarker,
  frameFiles,
  frameInputFromWire,
  type FileFrameInput,
} from "./frame.js";
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_MAX_ATTACHMENTS,
  DEFAULT_PROMPT_CHARS_PER_FILE,
  DEFAULT_PROMPT_TOTAL_CHARS,
  type FileImageContent,
  type FileImagesOutcome,
  type FileRejectionCode,
  type FileSaveInput,
  type FilesPort,
  type FilesGatewayPort,
  type FilesSendPort,
  type StoredFileRecord,
  type WireFile,
} from "./types.js";
import type { FilesLogger } from "./store.js";
import { prepareVisionImage, type VisionImageResizer } from "./vision.js";

const ID_RE = /^[a-f0-9]{32}$/;

export interface FilesServiceOptions {
  store: FilesPort;
  logger?: FilesLogger;
  /** Nombre maximal de fichiers PAR message (relu à chaud). */
  maxAttachments?: () => number;
  /** Caractères transmis au modèle par fichier (relu à chaud). */
  promptChars?: () => number;
  /** Caractères transmis au modèle pour tous les fichiers d'un message. */
  promptTotalChars?: () => number;
  /** Plafond en OCTETS d'une image transmise au modèle (relu à chaud). */
  imageMaxBytes?: () => number;
  /**
   * Réducteur d'image INJECTÉ (`sdkVisionImageResizer` du SDK, exposé par la
   * façade `src/pi` : ce domaine n'importe jamais le SDK).
   *
   * ⚠️ Absent ⇒ aucune réduction possible : une image hors bornes est REFUSÉE.
   * La composition root le branche donc TOUJOURS (`src/index.ts`), sinon le
   * chemin de vision serait incomplet. Les tests fournissent un double
   * déterministe et instantané.
   */
  imageResizer?: VisionImageResizer;
}

export interface AttachOutcome {
  files: WireFile[];
  markers: string[];
  block?: string;
  /** Identifiants demandés qui n'ont pas pu être joints (inconnus, expirés, trop nombreux). */
  missing: string[];
}

/** Issue d'un dépôt de fichier (refus compris, jamais silencieux). */
export type SaveUploadOutcome =
  | { ok: true; file: WireFile }
  | {
      ok: false;
      code: FileRejectionCode;
      receivedBytes: number;
      limitBytes: number;
    };

/** Service des fichiers (ports consommés par le transport et par l'outil). */
export class FilesService implements FilesGatewayPort, FilesSendPort {
  private readonly store: FilesPort;
  private readonly logger: FilesLogger | undefined;
  private readonly maxAttachments: () => number;
  private readonly promptChars: () => number;
  private readonly promptTotalChars: () => number;
  private readonly imageMaxBytes: () => number;
  private readonly imageResizer: VisionImageResizer | undefined;
  private readonly sentListeners = new Set<(view: WireFile & { sessionId: string }) => void>();

  constructor(options: FilesServiceOptions) {
    this.store = options.store;
    this.logger = options.logger;
    this.maxAttachments = options.maxAttachments ?? (() => DEFAULT_MAX_ATTACHMENTS);
    this.promptChars = options.promptChars ?? (() => DEFAULT_PROMPT_CHARS_PER_FILE);
    this.promptTotalChars = options.promptTotalChars ?? (() => DEFAULT_PROMPT_TOTAL_CHARS);
    this.imageMaxBytes = options.imageMaxBytes ?? (() => DEFAULT_IMAGE_MAX_BYTES);
    this.imageResizer = options.imageResizer;
  }

  /** Résout, rattache et cadre les fichiers d'un message utilisateur. */
  attach(sessionId: string, ids: readonly string[]): AttachOutcome {
    const limit = Math.max(0, Math.trunc(this.maxAttachments()));
    const missing: string[] = [];
    const files: WireFile[] = [];
    const markers: string[] = [];
    const entries: FileFrameInput[] = [];
    const seen = new Set<string>();

    for (const raw of ids) {
      const id = typeof raw === "string" ? raw.trim() : "";
      if (!ID_RE.test(id) || seen.has(id)) {
        missing.push(id);
        continue;
      }
      seen.add(id);
      if (files.length >= limit) {
        // ⚠️ Jamais un dépassement silencieux : l'identifiant est signalé.
        missing.push(id);
        continue;
      }
      const record = this.store.attach(id, sessionId);
      if (!record) {
        missing.push(id);
        continue;
      }
      const wire = this.store.toWire(record);
      files.push(wire);
      markers.push(formatFileMarker(wire));
      entries.push(this.frameInput(record, wire));
    }

    const block = frameFiles(entries, {
      promptChars: this.promptChars(),
      promptTotalChars: this.promptTotalChars(),
    });
    if (missing.length > 0) {
      this.logger?.warn("files.attach.missing", {
        sessionId,
        requested: ids.length,
        attached: files.length,
      });
    }
    return { files, markers, ...(block !== undefined ? { block } : {}), missing };
  }

  /**
   * Prépare les IMAGES d'un message pour le MODÈLE : base64 + type MIME, dans la
   * forme `ImageContent` que le SDK attend (`sdk-host.ts` la projette).
   *
   * ⚠️ Les fichiers d'un autre genre sont ignorés : leur contenu part dans le
   * bloc `<fichiers>`, jamais en pièce jointe.
   *
   * ⚠️ RÉDUCTION À LA VOLÉE (et seulement ici) : une image trop grande ou trop
   * définie est réduite au moment de construire le message. La version réduite
   * est ÉPHÉMÈRE (aucune écriture, aucun cache, aucune base) ; l'ORIGINAL stocké
   * — celui qu'on télécharge — n'est jamais touché.
   *
   * ⚠️ GARDE-FOU ULTIME `files.imageMaxBytes` : si la réduction n'aboutit pas
   * (ou rendrait l'image illisible), l'appelant reçoit un refus explicite et
   * n'envoie RIEN — jamais de troncature ni d'envoi muet d'une image démesurée.
   *
   * ⚠️ Aucun octet d'image n'est journalisé : seuls les POIDS, la durée de
   * réduction et les dimensions le sont (`files.image.prepared`) — c'est la
   * charge réseau et le TTFT qu'on surveille, pas le contenu.
   */
  async prepareImages(files: readonly WireFile[]): Promise<FileImagesOutcome> {
    const limit = Math.max(1, Math.trunc(this.imageMaxBytes()));
    const images: FileImageContent[] = [];
    for (const file of files) {
      if (file.kind !== "image") continue;
      const record = this.store.get(file.id);
      const bytes = record ? this.store.readBytes(file.id) : null;
      if (!record || !bytes || bytes.length === 0) {
        return {
          ok: false,
          code: "file_image_unreadable",
          message:
            `L'image « ${file.name} » n'a pas pu être relue : elle n'est pas ` +
            "transmise au modèle. Le message n'a pas été envoyé.",
        };
      }
      const outcome = await prepareVisionImage({
        name: file.name,
        bytes,
        ext: record.ext,
        mimeType: record.mimeType,
        ...(record.analysis.width !== undefined ? { width: record.analysis.width } : {}),
        ...(record.analysis.height !== undefined ? { height: record.analysis.height } : {}),
        maxBytes: limit,
        ...(this.imageResizer ? { resize: this.imageResizer } : {}),
      });
      if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };
      images.push(outcome.image);
      this.logger?.info("files.image.prepared", {
        id: file.id,
        bytesIn: bytes.length,
        bytesOut: outcome.bytes,
        resized: outcome.resized,
        resizeMs: outcome.resizeMs,
        ...(outcome.width !== undefined ? { width: outcome.width } : {}),
        ...(outcome.height !== undefined ? { height: outcome.height } : {}),
        limitBytes: limit,
      });
    }
    return { ok: true, images };
  }

  /**
   * Fichiers d'une conversation (métadonnées seules), du plus ancien au plus
   * récent — ordre TOTAL garanti par le stockage (départage par identifiant),
   * car c'est l'ordre que voient l'interface et le modèle.
   */
  listForSession(sessionId: string): WireFile[] {
    return this.store.list({ sessionId }).map((record) => this.store.toWire(record));
  }

  /**
   * Dépôt d'un flux d'octets (relais du stockage). La vue renvoyée est celle du
   * client : le CONTENU n'y est jamais répété (il vit sur disque et se sert par
   * `/fichiers/<id>.<ext>`).
   */
  async saveUpload(
    stream: AsyncIterable<Uint8Array>,
    input: FileSaveInput,
  ): Promise<SaveUploadOutcome> {
    const result = await this.store.saveStream(stream, input);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        receivedBytes: result.receivedBytes,
        limitBytes: result.limitBytes,
      };
    }
    return { ok: true, file: this.store.toWire(result.record) };
  }

  /** Fiche d'un fichier non expiré (métadonnées + analyse). */
  get(id: string): StoredFileRecord | null {
    return this.store.get(id);
  }

  /** Octets bruts (service same-origin). */
  readBytes(id: string): Buffer | null {
    return this.store.readBytes(id);
  }

  /** Supprime le fichier ET son analyse. */
  remove(id: string): boolean {
    return this.store.remove(id);
  }

  /**
   * Envoi par Yuki : identifiant EXACT, sinon nom EXACT (insensible à la casse)
   * parmi les fichiers DE CETTE conversation. Aucune recherche globale : Yuki ne
   * peut pas envoyer un fichier d'une autre conversation (fuite entre fils).
   */
  send(sessionId: string, reference: string): WireFile | null {
    const wanted = reference.trim();
    if (wanted === "") return null;
    const records = this.store.list({ sessionId });
    const byId = records.find((record) => record.id === wanted.toLowerCase());
    const byName =
      byId ??
      records.find((record) => record.name.toLowerCase() === wanted.toLowerCase());
    if (!byName) {
      this.logger?.info("files.send.unknown", { sessionId });
      return null;
    }
    const wire = this.store.toWire(byName);
    this.emitSent({ ...wire, sessionId });
    this.logger?.info("files.send.sent", {
      sessionId,
      id: wire.id,
      bytes: wire.bytes,
      kind: wire.kind,
    });
    return wire;
  }

  /** S'abonne aux fichiers envoyés PAR YUKI (trame de contrôle). */
  subscribeSent(listener: (view: WireFile & { sessionId: string }) => void): () => void {
    this.sentListeners.add(listener);
    return () => {
      this.sentListeners.delete(listener);
    };
  }

  private emitSent(view: WireFile & { sessionId: string }): void {
    for (const listener of [...this.sentListeners]) {
      try {
        listener(view);
      } catch (error) {
        this.logger?.warn("files.send.listener_failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private frameInput(record: StoredFileRecord, wire: WireFile): FileFrameInput {
    const text = record.analysis.readable
      ? (this.store.readAnalysis(record.id) ?? undefined)
      : undefined;
    return frameInputFromWire(wire, record.analysis, text);
  }
}

/** Fabrique du service des fichiers. */
export function createFilesService(options: FilesServiceOptions): FilesService {
  return new FilesService(options);
}
