/**
 * Stockage LOCAL des IMAGES GÉNÉRÉES via ComfyUI (volume `state`).
 *
 * ⚠️ L'image doit s'afficher dans le fil sans élargir la CSP (`img-src 'self'
 * data:`) : elle est donc écrite sur disque puis servie par une route
 * SAME-ORIGIN (`/images/<id>.<ext>`), exactement comme les captures de pages
 * web (`/captures/`).
 *
 * Le nom de fichier est un identifiant ALÉATOIRE (jamais le `filename` renvoyé
 * par ComfyUI, qui est une donnée externe) : aucune traversée de chemin
 * possible. Aucune image n'est journalisée (ni base64, ni chemin).
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { ComfyLogger } from "./types.js";

/** Taille maximale d'une image conservée sur disque (garde-fou de volume). */
export const MAX_GENERATED_IMAGE_BYTES = 15 * 1024 * 1024;

/** Extensions servies (allowlist stricte, alignée sur les types acceptés). */
const ALLOWED_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
]);

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
  /** Identifiant du prompt ComfyUI (diagnostic). */
  promptId: string;
  width?: number;
  height?: number;
}

export interface GeneratedImageInput {
  data: Uint8Array;
  mimeType: string;
  promptId: string;
  width?: number;
  height?: number;
}

/** Port de stockage consommé par le générateur (tests : double). */
export interface GeneratedImagesPort {
  save(input: GeneratedImageInput): GeneratedImageRecord | null;
  read(id: string, ext: string): { bytes: Buffer; mimeType: string } | null;
}

export interface GeneratedImagesStoreOptions {
  dir: string;
  logger?: ComfyLogger;
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

  constructor(options: GeneratedImagesStoreOptions) {
    this.dir = options.dir;
    this.logger = options.logger;
  }

  get dirPath(): string {
    return this.dir;
  }

  /** Crée le répertoire (idempotent). */
  ensureLayout(): void {
    mkdirSync(this.dir, { recursive: true });
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
    const file = join(this.dir, `${id}.${ext}`);
    writeFileSync(file, input.data);
    const record: GeneratedImageRecord = {
      id,
      file,
      mimeType,
      ext,
      bytes: input.data.byteLength,
      imageSrc: `/images/${id}.${ext}`,
      createdAt: new Date().toISOString(),
      promptId: input.promptId,
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
    };
    this.logger?.info("comfy.image.stored", {
      id,
      bytes: record.bytes,
      mimeType,
      promptId: input.promptId,
      ...(record.width !== undefined ? { width: record.width } : {}),
      ...(record.height !== undefined ? { height: record.height } : {}),
    });
    return record;
  }

  /** Relit une image par identifiant + extension (allowlist). */
  read(id: string, ext: string): { bytes: Buffer; mimeType: string } | null {
    if (!/^[a-f0-9]{32}$/.test(id)) return null;
    const mimeType = ALLOWED_EXTENSIONS.get(ext.toLowerCase());
    if (!mimeType) return null;
    const file = join(this.dir, `${id}.${ext.toLowerCase()}`);
    try {
      const info = statSync(file);
      if (!info.isFile()) return null;
      return { bytes: readFileSync(file), mimeType };
    } catch {
      return null;
    }
  }
}
