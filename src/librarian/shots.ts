/**
 * Stockage LOCAL des captures de pages web obtenues via Libry.
 *
 * ⚠️ Libry renvoie les octets PNG d'une capture ; Yuki les enregistre sur un
 * volume dédié (`librarianShotsDir`, sous `state`) afin que l'interface puisse
 * les SERVIR sur une route same-origin (`/captures/<id>.<ext>`). Le nom de
 * fichier est un identifiant ALÉATOIRE (jamais l'identifiant fourni par Libry,
 * qui est une donnée externe non fiable) : aucune traversée de chemin possible.
 *
 * ⚠️ Aucune image n'est journalisée (ni base64, ni chemin de secret). Seules
 * des métadonnées (dimensions, taille, type) peuvent l'être.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { LibrarianLogger } from "./types.js";

/** Taille maximale d'une capture conservée sur disque (garde-fou). */
export const MAX_LIBRARIAN_SHOT_BYTES = 15 * 1024 * 1024;

/** Extensions autorisées pour une capture servie (aligné sur Libry : PNG). */
const ALLOWED_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
]);

interface ShotExtension {
  ext: string;
  mimeType: string;
}

/** Déduit une extension sûre (allowlist) depuis un type MIME. */
function extensionFor(mimeType: string): ShotExtension {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "image/jpeg":
    case "image/jpg":
      return { ext: "jpg", mimeType: "image/jpeg" };
    case "image/webp":
      return { ext: "webp", mimeType: "image/webp" };
    case "image/gif":
      return { ext: "gif", mimeType: "image/gif" };
    case "image/png":
    default:
      return { ext: "png", mimeType: "image/png" };
  }
}

/** Entrée de stockage d'une capture. */
export interface LibrarianShotInput {
  data: Uint8Array;
  mimeType: string;
  /** URL de la page capturée (pour l'affichage). */
  pageUrl: string;
  width?: number;
  height?: number;
}

/** Capture enregistrée (métadonnées + chemin servi). */
export interface LibrarianShotRecord {
  id: string;
  /** Chemin ABSOLU sur disque (jamais exposé au modèle). */
  file: string;
  mimeType: string;
  ext: string;
  bytes: number;
  pageUrl: string;
  width?: number;
  height?: number;
  /** Chemin same-origin servable par l'interface (`/captures/<id>.<ext>`). */
  imageSrc: string;
  capturedAt: string;
}

/** Vue d'une capture destinée à l'interface (trame de contrôle WS). */
export interface LibrarianShotView {
  id: string;
  host: string;
  pageUrl: string;
  /** Chemin same-origin servable (`/captures/<id>.<ext>`). */
  imageSrc: string;
  mimeType: string;
  width?: number;
  height?: number;
  bytes: number;
  capturedAt: string;
  /** Conversation demandeuse (routage de la trame WS). */
  sessionId?: string;
}

/** Port de stockage consommé par l'outil de capture (tests : double). */
export interface LibrarianShotsPort {
  save(input: LibrarianShotInput): LibrarianShotRecord | null;
  read(id: string, ext: string): { bytes: Buffer; mimeType: string } | null;
}

export interface LibrarianShotsStoreOptions {
  dir: string;
  logger?: LibrarianLogger;
}

/** Hôte lisible d'une URL (jamais l'URL entière dans un libellé court). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Stockage sur disque des captures de pages web. */
export class LibrarianShotsStore implements LibrarianShotsPort {
  private readonly dir: string;
  private readonly logger: LibrarianLogger | undefined;

  constructor(options: LibrarianShotsStoreOptions) {
    this.dir = options.dir;
    this.logger = options.logger;
  }

  /** Crée le répertoire (idempotent). */
  ensureLayout(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  /** Enregistre une capture ; renvoie `null` si elle dépasse le plafond. */
  save(input: LibrarianShotInput): LibrarianShotRecord | null {
    if (input.data.byteLength > MAX_LIBRARIAN_SHOT_BYTES) {
      this.logger?.warn("librarian.shot.too_large", {
        bytes: input.data.byteLength,
        limit: MAX_LIBRARIAN_SHOT_BYTES,
      });
      return null;
    }
    this.ensureLayout();
    const { ext, mimeType } = extensionFor(input.mimeType);
    const id = randomBytes(16).toString("hex");
    const file = join(this.dir, `${id}.${ext}`);
    writeFileSync(file, input.data);
    const host = hostOf(input.pageUrl);
    const record: LibrarianShotRecord = {
      id,
      file,
      mimeType,
      ext,
      bytes: input.data.byteLength,
      pageUrl: input.pageUrl,
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      imageSrc: `/captures/${id}.${ext}`,
      capturedAt: new Date().toISOString(),
    };
    this.logger?.info("librarian.shot.stored", {
      id,
      host,
      bytes: record.bytes,
      ...(record.width !== undefined ? { width: record.width } : {}),
      ...(record.height !== undefined ? { height: record.height } : {}),
    });
    return record;
  }

  /** Relit une capture par identifiant + extension (allowlist). */
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

/** Hôte lisible d'une capture (réutilisé par l'outil pour la réponse au modèle). */
export function librarianShotHost(url: string): string {
  return hostOf(url);
}
