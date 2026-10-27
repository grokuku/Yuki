/**
 * Stockage LOCAL des IMAGES GÉNÉRÉES via ComfyUI (volume `state`).
 *
 * ⚠️ L'image doit s'afficher dans le fil sans élargir la CSP (`img-src 'self'`) :
 * elle est donc écrite sur disque puis servie par une route SAME-ORIGIN
 * (`/images/<id>.<ext>`), exactement comme les captures de pages web
 * (`/captures/`).
 *
 * ⚠️ POURQUOI YUKI GARDE UNE COPIE : le nœud du workflow reste `PreviewImage` et
 * ComfyUI peut PURGER son répertoire `temp/` quand il le veut. L'image est donc
 * copiée sur le disque de Yuki IMMÉDIATEMENT après sa récupération (PIÈGE ③) :
 * c'est cette copie — jamais l'URL de ComfyUI — qui est servie à l'interface.
 *
 * ⚠️ RÉTENTION (PIÈGE ④) : une image est gardée comme une PIÈCE JOINTE — même
 * réglage (`files.retentionDays`, voir `files/retention.ts`), même sémantique :
 *  - `expiresAt` est calculé À L'ÉCRITURE (un changement de réglage ne supprime
 *    pas rétroactivement ce qui est déjà là) ;
 *  - `read()` d'une image expirée la SUPPRIME et répond ABSENT (⇒ 404) ;
 *  - `purgeExpired()` est appelée au démarrage puis périodiquement par le
 *    câblage : sans balayage, une image que personne ne relit resterait sur le
 *    disque pour toujours.
 *
 * Le nom de fichier est un identifiant ALÉATOIRE (jamais le `filename` renvoyé
 * par ComfyUI, qui est une donnée externe) : aucune traversée de chemin
 * possible. Aucune image n'est journalisée (ni base64, ni chemin).
 *
 * Fichiers d'une image (tous supprimés ensemble à l'expiration) :
 *
 *   <dir>/<id>.<ext>   octets de l'image (servis en same-origin)
 *   <dir>/<id>.json    métadonnées (date, expiration, dimensions, conversation)
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_RETENTION_DAYS } from "../files/types.js";
import { expiresAtIso, isExpired } from "../files/retention.js";
import type { ComfyFinalPromptText, ComfyImageView, ComfyLogger } from "./types.js";

/** Taille maximale d'une image conservée sur disque (garde-fou de volume). */
export const MAX_GENERATED_IMAGE_BYTES = 15 * 1024 * 1024;

/** Extensions servies (allowlist stricte, alignée sur les types acceptés). */
const ALLOWED_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
]);

const ID_RE = /^[a-f0-9]{32}$/;

interface Extension {
  ext: string;
  mimeType: string;
}

/** Déduit une extension sûre (allowlist) depuis un type MIME. */
function extensionFor(mimeType: string): Extension {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "image/jpeg":
    case "image/jpg":
      return { ext: "jpg", mimeType: "image/jpeg" };
    case "image/webp":
      return { ext: "webp", mimeType: "image/webp" };
    case "image/png":
    default:
      return { ext: "png", mimeType: "image/png" };
  }
}

/** Image enregistrée (métadonnées + chemin servi). */
export interface GeneratedImageRecord {
  id: string;
  /** Chemin ABSOLU sur disque (jamais exposé au modèle). */
  file: string;
  mimeType: string;
  ext: string;
  bytes: number;
  /** Chemin same-origin servable (`/images/<id>.<ext>`). */
  imageSrc: string;
  createdAt: string;
  /** Instant d'expiration (ISO 8601), même règle que les pièces jointes. */
  expiresAt: string;
  /** Identifiant du prompt ComfyUI (diagnostic). */
  promptId: string;
  /** Conversation demandeuse (rattachée à l'émission de la vue). */
  sessionId?: string;
  width?: number;
  height?: number;
  /**
   * FICHE de l'image (prompt final publié par le workflow), quand elle a été
   * lue. Persistée AVEC l'image : la carte revient complète après rechargement.
   */
  finalPrompt?: ComfyFinalPromptText;
}

export interface GeneratedImageInput {
  data: Uint8Array;
  mimeType: string;
  promptId: string;
  width?: number;
  height?: number;
}

/** Métadonnées telles qu'écrites sur disque (chemins et URL dérivés). */
type ImageMeta = Omit<GeneratedImageRecord, "file" | "imageSrc">;

/** Port de stockage consommé par le générateur (tests : double). */
export interface GeneratedImagesPort {
  save(input: GeneratedImageInput): GeneratedImageRecord | null;
  read(id: string, ext: string): { bytes: Buffer; mimeType: string } | null;
}

export interface GeneratedImagesStoreOptions {
  dir: string;
  logger?: ComfyLogger;
  /** Horloge INJECTABLE (tests de rétention). Défaut : `Date.now`. */
  now?: () => number;
  /** Rétention en jours, RELUE à chaque dépôt (`files.retentionDays`). */
  retentionDays?: () => number;
}

/**
 * Dimensions réelles d'un PNG (en-tête IHDR), `undefined` pour les autres
 * formats : on n'INVENTE jamais une taille. Sert uniquement à l'affichage.
 */
export function pngDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (bytes.byteLength < 24) return undefined;
  // Signature PNG : 89 50 4E 47 0D 0A 1A 0A ; IHDR commence à l'octet 8.
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[index] !== signature[index]) return undefined;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

/** Store sur disque des images générées. */
export class GeneratedImagesStore implements GeneratedImagesPort {
  private readonly dir: string;
  private readonly logger: ComfyLogger | undefined;
  private readonly now: () => number;
  private readonly retention: () => number;

  constructor(options: GeneratedImagesStoreOptions) {
    this.dir = options.dir;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.retention = options.retentionDays ?? (() => DEFAULT_RETENTION_DAYS);
  }

  get dirPath(): string {
    return this.dir;
  }

  /** Crée le répertoire (idempotent). */
  ensureLayout(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  private imagePath(id: string, ext: string): string {
    return join(this.dir, `${id}.${ext.toLowerCase()}`);
  }

  private metaPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Enregistre une image ; renvoie `null` si elle dépasse le plafond. */
  save(input: GeneratedImageInput): GeneratedImageRecord | null {
    if (input.data.byteLength > MAX_GENERATED_IMAGE_BYTES) {
      this.logger?.warn("comfy.image.too_large", {
        bytes: input.data.byteLength,
        limit: MAX_GENERATED_IMAGE_BYTES,
      });
      return null;
    }
    this.ensureLayout();
    const { ext, mimeType } = extensionFor(input.mimeType);
    const id = randomBytes(16).toString("hex");
    const file = this.imagePath(id, ext);
    writeFileSync(file, input.data);
    const at = this.now();
    const meta: ImageMeta = {
      id,
      mimeType,
      ext,
      bytes: input.data.byteLength,
      createdAt: new Date(at).toISOString(),
      // ⚠️ MÊME réglage que les pièces jointes (`files.retentionDays`) et MÊME
      // calcul (module `files/retention.ts`) : une seule règle de rétention.
      expiresAt: expiresAtIso(at, this.retention()),
      promptId: input.promptId,
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
    };
    if (!this.writeMeta(meta)) {
      this.remove(id, ext);
      return null;
    }
    const record = this.toRecord(meta);
    // ⚠️ Métadonnées seulement : ni base64, ni chemin, ni contenu.
    this.logger?.info("comfy.image.stored", {
      id,
      bytes: record.bytes,
      mimeType,
      promptId: input.promptId,
      ...(record.width !== undefined ? { width: record.width } : {}),
      ...(record.height !== undefined ? { height: record.height } : {}),
      expiresAt: record.expiresAt,
    });
    return record;
  }

  private toRecord(meta: ImageMeta): GeneratedImageRecord {
    return {
      ...meta,
      file: this.imagePath(meta.id, meta.ext),
      imageSrc: `/images/${meta.id}.${meta.ext}`,
    };
  }

  private writeMeta(meta: ImageMeta): boolean {
    try {
      const tmp = `${this.metaPath(meta.id)}.part`;
      writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
      renameSync(tmp, this.metaPath(meta.id));
      return true;
    } catch (error) {
      this.logger?.warn("comfy.image.meta.failed", {
        id: meta.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Lit les métadonnées d'une image NON expirée (un expiré est supprimé). */
  get(id: string): GeneratedImageRecord | null {
    if (!ID_RE.test(id)) return null;
    let meta: ImageMeta;
    try {
      meta = JSON.parse(readFileSync(this.metaPath(id), "utf8")) as ImageMeta;
    } catch {
      return null;
    }
    if (typeof meta.ext !== "string" || !ALLOWED_EXTENSIONS.has(meta.ext.toLowerCase())) {
      return null;
    }
    if (isExpired(meta.expiresAt, this.now())) {
      // ⚠️ PIÈGE ④ : un expiré qui traîne rendrait la rétention inutile. On le
      // supprime à la PREMIÈRE lecture et on répond ABSENT (⇒ 404).
      this.remove(id, meta.ext);
      return null;
    }
    return this.toRecord(meta);
  }

  /**
   * Complète une image DÉJÀ enregistrée par sa FICHE (prompt final). Le texte
   * n'est connu qu'après la récupération de l'image : il est écrit À PART, et
   * une image sans fiche reste parfaitement valable (workflow sans étiquette).
   */
  attachFinalPrompt(id: string, finalPrompt: ComfyFinalPromptText): GeneratedImageRecord | null {
    const record = this.get(id);
    if (!record) return null;
    const { file: _file, imageSrc: _src, ...meta } = record;
    const next: ImageMeta = { ...meta, finalPrompt };
    if (!this.writeMeta(next)) return record;
    return this.toRecord(next);
  }

  /** Rattache l'image à une CONVERSATION (restauration après rechargement). */
  attach(id: string, sessionId: string): GeneratedImageRecord | null {
    const record = this.get(id);
    if (!record) return null;
    if (record.sessionId === sessionId) return record;
    const { file: _file, imageSrc: _src, ...meta } = record;
    const next: ImageMeta = { ...meta, sessionId };
    if (!this.writeMeta(next)) return record;
    return this.toRecord(next);
  }

  /** Images NON expirées, de la plus ancienne à la plus récente. */
  list(filter: { sessionId?: string } = {}): GeneratedImageRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const records: GeneratedImageRecord[] = [];
    for (const entry of names) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      const record = this.get(id);
      if (!record) continue;
      if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) continue;
      records.push(record);
    }
    records.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return records;
  }

  /** Relit une image par identifiant + extension (allowlist + non expirée). */
  read(id: string, ext: string): { bytes: Buffer; mimeType: string } | null {
    if (!ID_RE.test(id)) return null;
    const normalized = ext.toLowerCase();
    const mimeType = ALLOWED_EXTENSIONS.get(normalized);
    if (!mimeType) return null;
    // ⚠️ L'expiration est vérifiée AVANT de servir : une image expirée vaut 404
    // même si le balayage périodique n'est pas encore passé.
    const record = this.get(id);
    if (!record || record.ext !== normalized) return null;
    try {
      const info = statSync(record.file);
      if (!info.isFile()) return null;
      return { bytes: readFileSync(record.file), mimeType };
    } catch {
      return null;
    }
  }

  /** Supprime l'image ET ses métadonnées. */
  remove(id: string, ext?: string): boolean {
    if (!ID_RE.test(id)) return false;
    const knownExt = ext ?? this.readExtFromMeta(id);
    let existed = false;
    if (knownExt !== undefined) {
      const file = this.imagePath(id, knownExt);
      try {
        statSync(file);
        existed = true;
      } catch {
        /* absent */
      }
      rmSync(file, { force: true });
    }
    rmSync(this.metaPath(id), { force: true });
    return existed;
  }

  private readExtFromMeta(id: string): string | undefined {
    try {
      const meta = JSON.parse(readFileSync(this.metaPath(id), "utf8")) as ImageMeta;
      return typeof meta.ext === "string" && ALLOWED_EXTENSIONS.has(meta.ext.toLowerCase())
        ? meta.ext.toLowerCase()
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Purge TOUTES les images expirées (image + métadonnées). */
  purgeExpired(): number {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    const now = this.now();
    let removed = 0;
    for (const entry of names) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      if (!ID_RE.test(id)) continue;
      let meta: ImageMeta | undefined;
      try {
        meta = JSON.parse(readFileSync(join(this.dir, entry), "utf8")) as ImageMeta;
      } catch {
        // Métadonnées illisibles : aucun moyen de prouver la date d'expiration,
        // on ne garde pas un fichier qu'on ne sait pas dater.
        meta = undefined;
      }
      if (isExpired(meta?.expiresAt, now)) {
        if (this.remove(id, meta?.ext)) removed += 1;
      }
    }
    if (removed > 0) this.logger?.info("comfy.image.purged", { removed });
    return removed;
  }

  /** Vue d'affichage (aucun octet, aucun chemin absolu) — trame WS `image`. */
  toView(record: GeneratedImageRecord): ComfyImageView {
    return {
      id: record.id,
      imageSrc: record.imageSrc,
      mimeType: record.mimeType,
      bytes: record.bytes,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      promptId: record.promptId,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      ...(record.width !== undefined ? { width: record.width } : {}),
      ...(record.height !== undefined ? { height: record.height } : {}),
      // ⚠️ La fiche est JOINTE à la vue restaurée : après rechargement, la carte
      // revient complète (image ET texte), comme une pièce jointe garde son nom.
      ...(record.finalPrompt !== undefined ? { finalPrompt: record.finalPrompt } : {}),
    };
  }
}
