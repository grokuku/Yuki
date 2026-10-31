/**
 * STOCKAGE des fichiers échangés (volume `state`, surcharge `YUKI_FILES_DIR`).
 *
 * Organisation sur disque — un identifiant ALÉATOIRE par fichier, jamais un nom
 * fourni (aucune traversée de chemin possible) :
 *
 *   <dir>/<id>.bin   octets bruts (servis en téléchargement)
 *   <dir>/<id>.txt   texte d'ANALYSE conservé (borné) — supprimé avec le fichier
 *   <dir>/<id>.json  métadonnées + résultat d'analyse (jamais le contenu)
 *
 * ⚠️ RÉTENTION RÉELLE (PIÈGE ③) : `purgeExpired()` supprime les TROIS fichiers
 * (octets, analyse, métadonnées) et est appelée au démarrage puis périodiquement
 * par le câblage. Un fichier expiré qui traînerait rendrait le plafond inutile :
 * `get`/`list`/`readBytes` considèrent d'ailleurs un fichier expiré comme ABSENT
 * et le suppriment à la première lecture.
 *
 * ⚠️ PIÈGE ④ (secrets) : le contenu et l'analyse ne sont JAMAIS journalisés. Le
 * masquage des journaux de Yuki couvre les valeurs de configuration ; l'analyse
 * conservée, elle, vit sur le volume `state` — elle n'est pas masquable (même
 * statut que le journal de session), ce qui est dit dans le rapport.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { analyzeStoredFile, normalizeMimeType } from "./analyze.js";
import { extensionOf, sanitizeFileName } from "./name.js";
import { expiresAtIso, isExpired } from "./retention.js";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_RETENTION_DAYS,
  MAX_STORED_ANALYSIS_CHARS,
  type FileRejectionCode,
  type FileSaveInput,
  type FileSaveResult,
  type FileSink,
  type FilesPort,
  type StoredFileRecord,
  type WireFile,
} from "./types.js";

/** Journal minimal (compatible avec le logger de Yuki). */
export interface FilesLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface FilesStoreOptions {
  dir: string;
  logger?: FilesLogger;
  /** Horloge INJECTABLE (tests de rétention). Défaut : `Date.now`. */
  now?: () => number;
  /** Plafond par fichier (relu à chaque dépôt : `/config` à chaud). */
  maxBytes?: () => number;
  /** Rétention en jours (relue à chaque dépôt). */
  retentionDays?: () => number;
  /** Borne de caractères d'analyse conservés. */
  analysisChars?: () => number;
}

const ID_RE = /^[a-f0-9]{32}$/;

function isRecordId(id: string): boolean {
  return ID_RE.test(id);
}

/** Fiche de métadonnées telle qu'écrite sur disque (sans le texte d'analyse). */
type MetaFile = Omit<StoredFileRecord, "id">;

/** Chemin same-origin de service d'un fichier. */
export function fileUrl(id: string, ext: string): string {
  return `/fichiers/${id}.${ext}`;
}

/** Stockage sur disque des fichiers échangés. */
export class FilesStore implements FilesPort {
  private readonly dir: string;
  private readonly logger: FilesLogger | undefined;
  private readonly now: () => number;
  private readonly maxBytes: () => number;
  private readonly retentionDays: () => number;
  private readonly analysisChars: () => number;

  constructor(options: FilesStoreOptions) {
    this.dir = options.dir;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? (() => DEFAULT_MAX_FILE_BYTES);
    this.retentionDays = options.retentionDays ?? (() => DEFAULT_RETENTION_DAYS);
    this.analysisChars = options.analysisChars ?? (() => MAX_STORED_ANALYSIS_CHARS);
  }

  /** Crée le répertoire (idempotent). */
  ensureLayout(): void {
    mkdirSync(this.dir, { recursive: true });
  }

  private binPath(id: string): string {
    return join(this.dir, `${id}.bin`);
  }
  private metaPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }
  private textPath(id: string): string {
    return join(this.dir, `${id}.txt`);
  }

  /** Enregistre un flux d'octets BORNÉ (aucune accumulation en mémoire). */
  async saveStream(
    source: AsyncIterable<Uint8Array>,
    input: FileSaveInput,
  ): Promise<FileSaveResult> {
    const limit = Math.max(1, Math.trunc(this.maxBytes()));
    this.ensureLayout();
    const id = randomBytes(16).toString("hex");
    const part = join(this.dir, `${id}.bin.part`);
    let received = 0;
    let fd: number | undefined;
    try {
      fd = openSync(part, "w", 0o600);
      for await (const chunk of source) {
        received += chunk.byteLength;
        if (received > limit) {
          // ⚠️ On ARRÊTE d'écrire et on supprime le partiel : un fichier refusé
          // ne doit jamais occuper le disque.
          closeSync(fd);
          fd = undefined;
          rmSync(part, { force: true });
          this.logger?.warn("files.rejected.too_large", { received, limit });
          return { ok: false, code: "too_large", receivedBytes: received, limitBytes: limit };
        }
        writeSync(fd, chunk);
      }
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* déjà fermé */
        }
      }
      rmSync(part, { force: true });
      this.logger?.warn("files.upload.failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, code: "io_error", receivedBytes: received, limitBytes: limit };
    }
    if (fd !== undefined) closeSync(fd);
    if (received === 0) {
      rmSync(part, { force: true });
      return { ok: false, code: "empty", receivedBytes: 0, limitBytes: limit };
    }
    renameSync(part, this.binPath(id));
    const record = this.finalize(id, received, input);
    if (!record) {
      this.remove(id);
      return { ok: false, code: "io_error", receivedBytes: received, limitBytes: limit };
    }
    return { ok: true, record };
  }

  /**
   * Ouvre un ÉCRIVAIN BORNÉ pour un flux reçu PAR MORCEAUX (transfert depuis une
   * machine, cf. `src/agents/transfer.ts`).
   *
   * ⚠️ Écriture dans `<id>.bin.part` (jamais dans la destination finale) et
   * plafond vérifié à CHAQUE morceau : un flux trop gros est REFUSÉ sans laisser
   * de résidu, et la fiche n'existe qu'après `commit()`.
   */
  createSink(input: FileSaveInput): FileSink {
    const limit = Math.max(1, Math.trunc(this.maxBytes()));
    this.ensureLayout();
    const id = randomBytes(16).toString("hex");
    const part = join(this.dir, `${id}.bin.part`);
    let fd: number | undefined;
    let received = 0;
    let failed = false;
    let committed = false;
    try {
      fd = openSync(part, "w", 0o600);
    } catch (error) {
      failed = true;
      this.logger?.warn("files.sink.open_failed", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    /** Supprime le partiel et ferme le descripteur (idempotent). */
    const discard = (): void => {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* déjà fermé */
        }
        fd = undefined;
      }
      rmSync(part, { force: true });
    };
    const store = this;
    return {
      get receivedBytes(): number {
        return received;
      },
      write(chunk: Uint8Array) {
        if (failed || fd === undefined) {
          return { ok: false as const, code: "io_error" as FileRejectionCode, receivedBytes: received, limitBytes: limit };
        }
        received += chunk.byteLength;
        if (received > limit) {
          // ⚠️ On ARRÊTE d'écrire et on supprime le partiel : un fichier refusé
          // ne doit jamais occuper le disque.
          failed = true;
          discard();
          store.logger?.warn("files.rejected.too_large", { received, limit });
          return { ok: false as const, code: "too_large" as FileRejectionCode, receivedBytes: received, limitBytes: limit };
        }
        try {
          writeSync(fd, chunk);
        } catch (error) {
          failed = true;
          discard();
          store.logger?.warn("files.sink.write_failed", {
            reason: error instanceof Error ? error.message : String(error),
          });
          return { ok: false as const, code: "io_error" as FileRejectionCode, receivedBytes: received, limitBytes: limit };
        }
        return { ok: true as const };
      },
      commit(): FileSaveResult {
        if (failed || fd === undefined) {
          return { ok: false, code: "io_error", receivedBytes: received, limitBytes: limit };
        }
        try {
          // ⚠️ fsync AVANT le rename : une coupure d'alimentation ne doit pas
          // publier un fichier à la bonne taille mais au contenu incomplet.
          fsyncSync(fd);
        } catch {
          // Certains systèmes de fichiers refusent `fsync` : on continue, le
          // rename reste atomique.
        }
        closeSync(fd);
        fd = undefined;
        if (received === 0) {
          discard();
          return { ok: false, code: "empty", receivedBytes: 0, limitBytes: limit };
        }
        try {
          renameSync(part, store.binPath(id));
        } catch (error) {
          discard();
          store.logger?.warn("files.sink.rename_failed", {
            reason: error instanceof Error ? error.message : String(error),
          });
          return { ok: false, code: "io_error", receivedBytes: received, limitBytes: limit };
        }
        const record = store.finalize(id, received, input);
        if (!record) {
          store.remove(id);
          return { ok: false, code: "io_error", receivedBytes: received, limitBytes: limit };
        }
        committed = true;
        return { ok: true, record };
      },
      abort(): void {
        if (committed) return;
        failed = true;
        discard();
      },
    };
  }

  /** Enregistre des octets déjà en mémoire (outil, tests, déposant externe). */
  saveBytes(data: Uint8Array, input: FileSaveInput): FileSaveResult {
    const limit = Math.max(1, Math.trunc(this.maxBytes()));
    if (data.byteLength > limit) {
      this.logger?.warn("files.rejected.too_large", {
        received: data.byteLength,
        limit,
      });
      return {
        ok: false,
        code: "too_large",
        receivedBytes: data.byteLength,
        limitBytes: limit,
      };
    }
    if (data.byteLength === 0) {
      return { ok: false, code: "empty", receivedBytes: 0, limitBytes: limit };
    }
    this.ensureLayout();
    const id = randomBytes(16).toString("hex");
    writeFileSync(this.binPath(id), data, { mode: 0o600 });
    const record = this.finalize(id, data.byteLength, input);
    if (!record) {
      this.remove(id);
      return {
        ok: false,
        code: "io_error",
        receivedBytes: data.byteLength,
        limitBytes: limit,
      };
    }
    return { ok: true, record };
  }

  /**
   * Analyse le fichier écrit, écrit le texte d'analyse puis les métadonnées.
   * ⚠️ Aucune donnée EXTÉRIEURE (nom, type) n'est utilisée comme chemin.
   */
  private finalize(id: string, bytes: number, input: FileSaveInput): StoredFileRecord | null {
    const name = sanitizeFileName(input.name);
    if (name.trim() === "") {
      this.logger?.warn("files.rejected.empty_name", { id });
      return null;
    }
    const ext = extensionOf(name);
    const mimeType = normalizeMimeType(input.mimeType, ext);
    const at = this.now();
    let outcome;
    try {
      outcome = analyzeStoredFile(this.binPath(id), {
        name,
        ext,
        mimeType,
        maxChars: Math.max(1, Math.trunc(this.analysisChars())),
      });
    } catch (error) {
      this.logger?.warn("files.analyze.failed", {
        id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (outcome.text !== undefined) {
      writeFileSync(this.textPath(id), outcome.text, { mode: 0o600 });
    }
    const meta: MetaFile = {
      name,
      mimeType,
      ext,
      bytes,
      createdAt: new Date(at).toISOString(),
      // ⚠️ Règle PARTAGÉE avec les images générées et les captures du libraire
      // (`retention.ts`) : même réglage, même sémantique d'expiration.
      expiresAt: expiresAtIso(at, this.retentionDays()),
      origin: input.origin,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      analysis: outcome.analysis,
    };
    try {
      const tmp = `${this.metaPath(id)}.part`;
      writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
      renameSync(tmp, this.metaPath(id));
    } catch (error) {
      this.logger?.warn("files.meta.failed", {
        id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const record: StoredFileRecord = { id, ...meta };
    // ⚠️ Métadonnées SEULEMENT : jamais un extrait du contenu (PIÈGE ④).
    this.logger?.info("files.stored", {
      id,
      name,
      bytes,
      kind: outcome.analysis.kind,
      readable: outcome.analysis.readable,
      origin: input.origin,
      expiresAt: record.expiresAt,
    });
    return record;
  }

  /** Lit les métadonnées d'un fichier NON expiré. */
  get(id: string): StoredFileRecord | null {
    if (!isRecordId(id)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.metaPath(id), "utf8");
    } catch {
      return null;
    }
    let meta: MetaFile;
    try {
      meta = JSON.parse(raw) as MetaFile;
    } catch {
      return null;
    }
    if (isExpired(meta.expiresAt, this.now())) {
      // Expiré (ou date illisible) mais pas encore purgé : on le supprime et on
      // répond ABSENT (lire un expiré vaut 404, jamais un fichier périmé).
      this.remove(id);
      return null;
    }
    return { id, ...meta };
  }

  /** Octets bruts (service en téléchargement). */
  readBytes(id: string): Buffer | null {
    const record = this.get(id);
    if (!record) return null;
    try {
      const info = statSync(this.binPath(id));
      if (!info.isFile()) return null;
      return readFileSync(this.binPath(id));
    } catch {
      return null;
    }
  }

  /** Texte d'analyse conservé (borné à l'écriture). */
  readAnalysis(id: string): string | null {
    if (!this.get(id)) return null;
    try {
      return readFileSync(this.textPath(id), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Fichiers non expirés, du plus ancien au plus récent.
   *
   * ⚠️ L'ordre est un CONTRAT (l'interface et le modèle voient cette liste dans
   * cet ordre), donc il doit être TOTAL : `createdAt` seul ne départage pas deux
   * dépôts faits dans la MÊME milliseconde, et l'égalité laisserait l'ordre à
   * `readdirSync` — non garanti, variable d'un appel à l'autre. L'identifiant
   * (aléatoire, unique) tranche : même entrée ⇒ même sortie, toujours.
   */
  list(filter: { sessionId?: string } = {}): StoredFileRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const records: StoredFileRecord[] = [];
    for (const entry of names) {
      if (!entry.endsWith(".json")) continue;
      const id = entry.slice(0, -".json".length);
      const record = this.get(id);
      if (!record) continue;
      if (filter.sessionId !== undefined && record.sessionId !== filter.sessionId) continue;
      records.push(record);
    }
    records.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      // ⚠️ Départage DÉTERMINISTE : deux fichiers déposés dans la même
      // milliseconde n'ont pas d'ordre chronologique ; sans ce critère l'ordre
      // suivrait le répertoire (non garanti) et changerait d'un appel à l'autre.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return records;
  }

  /** Rattache un fichier à une conversation (posé à l'envoi du message). */
  attach(id: string, sessionId: string): StoredFileRecord | null {
    const record = this.get(id);
    if (!record) return null;
    if (record.sessionId === sessionId) return record;
    const { id: _id, ...meta } = record;
    const next: MetaFile = { ...meta, sessionId };
    try {
      const tmp = `${this.metaPath(id)}.part`;
      writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
      renameSync(tmp, this.metaPath(id));
    } catch (error) {
      this.logger?.warn("files.attach.failed", {
        id,
        reason: error instanceof Error ? error.message : String(error),
      });
      return record;
    }
    return { id, ...next };
  }

  /** Supprime le fichier, son ANALYSE et ses métadonnées. */
  remove(id: string): boolean {
    if (!isRecordId(id)) return false;
    let existed = false;
    for (const path of [this.binPath(id), this.textPath(id), this.metaPath(id)]) {
      try {
        statSync(path);
        existed = true;
      } catch {
        /* absent */
      }
      rmSync(path, { force: true });
    }
    return existed;
  }

  /** Purge TOUT ce qui a expiré (fichier + analyse + métadonnées). */
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
      if (!isRecordId(id)) continue;
      let expiresAt: string | undefined;
      try {
        const meta = JSON.parse(readFileSync(join(this.dir, entry), "utf8")) as MetaFile;
        expiresAt = meta.expiresAt;
      } catch {
        // Métadonnées illisibles : on considère le fichier orphelin et on purge
        // (aucun moyen de prouver sa date d'expiration → on ne le garde pas).
        expiresAt = undefined;
      }
      if (isExpired(expiresAt, now)) {
        if (this.remove(id)) removed += 1;
      }
    }
    if (removed > 0) this.logger?.info("files.purged", { removed });
    return removed;
  }

  /** Vue client (aucun contenu, aucun chemin absolu). */
  toWire(record: StoredFileRecord): WireFile {
    return {
      id: record.id,
      name: record.name,
      mimeType: record.mimeType,
      bytes: record.bytes,
      kind: record.analysis.kind,
      readable: record.analysis.readable,
      ...(record.analysis.reason !== undefined ? { reason: record.analysis.reason } : {}),
      ...(record.analysis.truncated !== undefined ? { truncated: record.analysis.truncated } : {}),
      url: fileUrl(record.id, record.ext),
      ...(record.analysis.kind === "image"
        ? { imageSrc: fileUrl(record.id, record.ext) }
        : {}),
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
    };
  }
}
