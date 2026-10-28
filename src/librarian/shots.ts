/**
 * Stockage LOCAL des captures de pages web obtenues via Libry.
 *
 * ⚠️ Libry renvoie les octets PNG d'une capture ; Yuki les enregistre sur un
 * volume dédié (`librarianShotsDir`, sous `state`) afin que l'interface puisse
 * les SERVIR sur une route same-origin (`/captures/<id>.<ext>`). Le nom de
 * fichier est un identifiant ALÉATOIRE (jamais l'identifiant fourni par Libry,
 * qui est une donnée externe non fiable) : aucune traversée de chemin possible.
 *
 * ⚠️ RÉTENTION (PIÈGE ④) : une capture n'est plus ÉPHÉMÈRE. Elle est gardée
 * comme une PIÈCE JOINTE — même réglage (`files.retentionDays`, voir
 * `files/retention.ts`), même sémantique :
 *  - `expiresAt` calculé À L'ÉCRITURE ;
 *  - `read()` d'une capture expirée la SUPPRIME et répond ABSENT (⇒ 404) ;
 *  - `purgeExpired()` au démarrage puis périodiquement (câblage).
 *
 * ⚠️ Aucune image n'est journalisée (ni base64, ni chemin de secret). Seules
 * des métadonnées (dimensions, taille, type) peuvent l'être.
 *
 *   <dir>/<id>.<ext>   octets de la capture (servis en same-origin)
 *   <dir>/<id>.json    métadonnées (page, date, expiration, conversation)
 */

import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { expiresAtIso, isExpired } from "../files/retention.js";
import { DEFAULT_RETENTION_DAYS } from "../files/types.js";
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

const ID_RE = /^[a-f0-9]{32}$/;

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
  /** Conversation demandeuse (restauration après rechargement). */
  sessionId?: string;
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
  /** Instant d'expiration (ISO 8601), même règle que les pièces jointes. */
  expiresAt: string;
  /** Conversation demandeuse (routage de la trame WS, puis restauration). */
  sessionId?: string;
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
  /** Instant d'expiration (ISO 8601) : même rétention que les pièces jointes. */
  expiresAt?: string;
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
  /** Horloge INJECTABLE (tests de rétention). Défaut : `Date.now`. */
  now?: () => number;
  /** Rétention en jours, RELUE à chaque dépôt (`files.retentionDays`). */
  retentionDays?: () => number;
}

/** Métadonnées telles qu'écrites sur disque (chemins et URL dérivés). */
type ShotMeta = Omit<LibrarianShotRecord, "file" | "imageSrc">;

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
  private readonly now: () => number;
  private readonly retention: () => number;

  constructor(options: LibrarianShotsStoreOptions) {
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

  private shotPath(id: string, ext: string): string {
    return join(this.dir, `${id}.${ext.toLowerCase()}`);
  }

  private metaPath(id: string): string {
    return join(this.dir, `${id}.json`);
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
    writeFileSync(this.shotPath(id, ext), input.data);
    const at = this.now();
    const meta: ShotMeta = {
      id,
      mimeType,
      ext,
      bytes: input.data.byteLength,
      pageUrl: input.pageUrl,
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      capturedAt: new Date(at).toISOString(),
      // ⚠️ MÊME réglage et MÊME calcul que les pièces jointes et les images
      // générées : une seule règle de rétention pour le volume `state`.
      expiresAt: expiresAtIso(at, this.retention()),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    };
    if (!this.writeMeta(meta)) {
      this.remove(id, ext);
      return null;
    }
    const host = hostOf(input.pageUrl);
    const record = this.toRecord(meta);
    this.logger?.info("librarian.shot.stored", {
      id,
      host,
      bytes: record.bytes,
      ...(record.width !== undefined ? { width: record.width } : {}),
      ...(record.height !== undefined ? { height: record.height } : {}),
      expiresAt: record.expiresAt,
    });
    return record;
  }

  private toRecord(meta: ShotMeta): LibrarianShotRecord {
    return {
      ...meta,
      file: this.shotPath(meta.id, meta.ext),
      imageSrc: `/captures/${meta.id}.${meta.ext}`,
    };
  }

  private writeMeta(meta: ShotMeta): boolean {
    try {
      const tmp = `${this.metaPath(meta.id)}.part`;
      writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
      renameSync(tmp, this.metaPath(meta.id));
      return true;
    } catch (error) {
      this.logger?.warn("librarian.shot.meta.failed", {
        id: meta.id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Lit les métadonnées d'une capture NON expirée (un expiré est supprimé). */
  get(id: string): LibrarianShotRecord | null {
    if (!ID_RE.test(id)) return null;
    let meta: ShotMeta;
    try {
      meta = JSON.parse(readFileSync(this.metaPath(id), "utf8")) as ShotMeta;
    } catch {
      return null;
    }
    if (typeof meta.ext !== "string" || !ALLOWED_EXTENSIONS.has(meta.ext.toLowerCase())) {
      return null;
    }
    if (isExpired(meta.expiresAt, this.now())) {
      // ⚠️ PIÈGE ④ : une capture expirée est supprimée à la première lecture et
      // traitée comme ABSENTE (⇒ 404), jamais servie périmée.
      this.remove(id, meta.ext);
      return null;
    }
    return this.toRecord(meta);
  }

  /**
   * Captures NON expirées, de la plus ancienne à la plus récente.
   *
   * ⚠️ Ordre TOTAL : `capturedAt` seul ne départage pas deux captures de la même
   * milliseconde ; sans départage, l'égalité laisserait l'ordre à `readdirSync`
   * (non garanti, variable d'un appel à l'autre). L'identifiant tranche.
   */
  list(filter: { sessionId?: string } = {}): LibrarianShotRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const records: LibrarianShotRecord[] = [];
    for (const entry of names) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      const record = this.get(id);
      if (!record) continue;
      if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) continue;
      records.push(record);
    }
    records.sort((a, b) => {
      if (a.capturedAt !== b.capturedAt) return a.capturedAt < b.capturedAt ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return records;
  }

  /** Relit une capture par identifiant + extension (allowlist + non expirée). */
  read(id: string, ext: string): { bytes: Buffer; mimeType: string } | null {
    if (!ID_RE.test(id)) return null;
    const normalized = ext.toLowerCase();
    const mimeType = ALLOWED_EXTENSIONS.get(normalized);
    if (!mimeType) return null;
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

  /** Supprime la capture ET ses métadonnées. */
  remove(id: string, ext?: string): boolean {
    if (!ID_RE.test(id)) return false;
    const knownExt = ext ?? this.readExtFromMeta(id);
    let existed = false;
    if (knownExt !== undefined) {
      const file = this.shotPath(id, knownExt);
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
      const meta = JSON.parse(readFileSync(this.metaPath(id), "utf8")) as ShotMeta;
      return typeof meta.ext === "string" && ALLOWED_EXTENSIONS.has(meta.ext.toLowerCase())
        ? meta.ext.toLowerCase()
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Purge TOUTES les captures expirées (image + métadonnées). */
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
      let meta: ShotMeta | undefined;
      try {
        meta = JSON.parse(readFileSync(join(this.dir, entry), "utf8")) as ShotMeta;
      } catch {
        meta = undefined;
      }
      if (isExpired(meta?.expiresAt, now)) {
        if (this.remove(id, meta?.ext)) removed += 1;
      }
    }
    if (removed > 0) this.logger?.info("librarian.shot.purged", { removed });
    return removed;
  }

  /** Vue d'affichage (aucun octet, aucun chemin absolu) — trame WS. */
  toView(record: LibrarianShotRecord): LibrarianShotView {
    return {
      id: record.id,
      host: hostOf(record.pageUrl),
      pageUrl: record.pageUrl,
      imageSrc: record.imageSrc,
      mimeType: record.mimeType,
      bytes: record.bytes,
      capturedAt: record.capturedAt,
      expiresAt: record.expiresAt,
      ...(record.width !== undefined ? { width: record.width } : {}),
      ...(record.height !== undefined ? { height: record.height } : {}),
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
    };
  }
}

/** Hôte lisible d'une capture (réutilisé par l'outil pour la réponse au modèle). */
export function librarianShotHost(url: string): string {
  return hostOf(url);
}
