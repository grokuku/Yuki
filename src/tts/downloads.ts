/**
 * Téléchargeur de modèles TTS + registre de tâches DURABLE (Lot 9, étape 2).
 *
 * Patron repris des jobs de délégation (`src/jobs/store.ts`) : **store JSON
 * durable**, écriture **atomique**, projection en mémoire — mais **module
 * distinct** (le TTS n'est pas couplé à la file de délégation).
 *
 * Garanties :
 *   - **source fermée** : le client ne fournit qu'un `catalogId` ; l'URL est
 *     construite par le serveur (`src/tts/catalog-data.ts`) ;
 *   - **destination imposée** : `/models/downloads/<id>/model.gguf` ;
 *   - **écriture `.part` puis `rename` atomique** (jamais de fichier final
 *     tronqué) ;
 *   - **vérification de taille** systématique, **vérification d'intégrité**
 *     (SHA-256) quand l'API HF expose l'`oid` — sinon le SHA-256 calculé est
 *     **enregistré** sans prétendre l'avoir vérifié ;
 *   - **reprise par `Range`** uniquement si le serveur l'annonce (`206`) et que
 *     la taille totale est inchangée ;
 *   - **contrôle d'espace disque** avant démarrage ;
 *   - **un seul téléchargement à la fois** (les autres restent `queued`) ;
 *   - **annulation** via `AbortController` ;
 *   - registre **persistant** : au démarrage du gateway, toute tâche non
 *     terminale passe en `interrupted` — **jamais** `done`.
 *
 * ⚠️ `POST /api/admin/restart` tue le processus : c'est pour cela que le
 * registre est persistant et réconcilié au démarrage.
 */

import { createHash, randomBytes, type Hash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  writeFileSync,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { describeWriteFailure, probeWritable } from "../config/paths.js";
import {
  CATALOG_ENTRIES,
  CATALOG_REJECTIONS,
  DOWNLOAD_FILE_NAME,
  DOWNLOAD_PART_SUFFIX,
  findCatalogEntry,
  resolveCatalogPackage,
  type CatalogEntry,
  type CatalogRejection,
  type ResolvedCatalogPackage,
  type ResolvedPackage,
} from "./catalog-data.js";

/** Version du schéma du registre des téléchargements. */
export const DOWNLOAD_SCHEMA_VERSION = 1;

/** Marge d'espace disque exigée en plus du fichier (64 Mio par défaut). */
export const DEFAULT_DISK_MARGIN_BYTES = 64 * 1024 * 1024;
/** Période minimale entre deux écritures de progression (ms). */
export const DEFAULT_PROGRESS_INTERVAL_MS = 1_000;
/** Délai de résolution de l'API Hugging Face (court). */
export const DEFAULT_RESOLVE_TIMEOUT_MS = 10_000;

/** États d'une tâche de téléchargement. */
export type DownloadStatus =
  | "queued"
  | "downloading"
  | "verifying"
  | "done"
  | "failed"
  | "cancelled"
  | "interrupted";

/** Statuts terminaux (plus aucune évolution possible). */
export const DOWNLOAD_TERMINAL_STATUSES: readonly DownloadStatus[] = [
  "done",
  "failed",
  "cancelled",
  "interrupted",
];

/** Vrai si le statut est terminal. */
export function isDownloadTerminal(status: DownloadStatus): boolean {
  return DOWNLOAD_TERMINAL_STATUSES.includes(status);
}

/** Enregistrement durable d'une tâche. */
export interface DownloadTask {
  schemaVersion: number;
  /** Identifiant de catalogue = valeur de `tts.engine`. */
  catalogId: string;
  label: string;
  status: DownloadStatus;
  /** Chemin VU PAR LE MOTEUR (`/models/downloads/<id>/model.gguf`). */
  enginePath: string;
  /** Fichier VU PAR LE GATEWAY. */
  gatewayPath: string;
  /** URL construite CÔTÉ SERVEUR (jamais fournie par le client). */
  url: string | null;
  fileName: string | null;
  totalBytes: number | null;
  bytesDownloaded: number;
  /** SHA-256 CALCULÉ sur le fichier téléchargé (`null` tant qu'incomplet). */
  sha256: string | null;
  /** `true` UNIQUEMENT si le SHA-256 annoncé par HF a été retrouvé. */
  sha256Verified: boolean;
  expectedSha256: string | null;
  /** Provenance de la résolution (`hf` = API vivante, `fallback` = repli). */
  source: "hf" | "fallback";
  /** Avertissement honnête (repli, reprise, taille non annoncée…). */
  warning: string | null;
  error: string | null;
  code: string | null;
  /** Taille du fichier partiel repris (0 si aucun). */
  resumedFromBytes: number;
  etag: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** Erreur métier d'un téléchargement (porte un statut HTTP). */
export class TtsDownloadError extends Error {
  override readonly name = "TtsDownloadError";
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface DownloadLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface TtsDownloadManagerOptions {
  /** Fichier JSON du registre (dans le volume `state`). */
  registryPath: string;
  /** Dossier des modèles VU PAR LE GATEWAY (`/models`, montage `rw`). */
  modelsDir: string;
  /** Dossier des modèles VU PAR LE MOTEUR (`/models`). */
  engineModelsDir: string;
  /** Catalogue fermé (injectable pour les tests). */
  catalog?: readonly CatalogEntry[];
  logger?: DownloadLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Espace libre (octets) du dossier, `null` si indéterminable. Injectable. */
  freeBytes?: (dir: string) => number | null;
  /** Résolution d'un paquet (injectable pour les tests). */
  resolve?: (entry: CatalogEntry) => Promise<ResolvedCatalogPackage>;
  diskMarginBytes?: number;
  progressIntervalMs?: number;
  resolveTimeoutMs?: number;
}

interface RegistryFile {
  schemaVersion: number;
  tasks: DownloadTask[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

/** Erreur interne d'annulation (jamais exposée au client). */
class DownloadCancelled extends Error {
  override readonly name = "DownloadCancelled";
}

/** Écrit un fichier JSON de façon atomique (`tmp` + `rename`). */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, path);
}

/** Espace libre (octets) d'un dossier via `statfs` ; `null` si indéterminable. */
function statfsFreeBytes(dir: string): number | null {
  try {
    const stats = statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function copyTask(task: DownloadTask): DownloadTask {
  return { ...task };
}

/**
 * Vrai si la tâche a été annulée. Helper dédié : dans `runTask`, TypeScript
 * restreint `task.status` à `"downloading"` après l'affectation, alors que
 * `cancel()` peut le changer de façon asynchrone.
 */
function isCancelled(task: DownloadTask): boolean {
  return task.status === "cancelled";
}

/** Parse le total d'un en-tête `Content-Range: bytes <start>-<end>/<total>`. */
export function contentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const match = /^bytes\s+\d+-\d+\/(\d+)\s*$/i.exec(header.trim());
  if (!match) return null;
  const total = Number.parseInt(match[1]!, 10);
  return Number.isFinite(total) ? total : null;
}

/** Rejoue le contenu d'un fichier dans un hash SHA-256 (reprise / vérif). */
export async function hashFileInto(hash: Hash, path: string): Promise<void> {
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
}

/**
 * Téléchargeur + registre durable. Une instance par processus (câblée dans
 * `src/index.ts`).
 */
export class TtsDownloadManager {
  readonly registryPath: string;
  readonly modelsDir: string;
  readonly engineModelsDir: string;

  private readonly catalog: readonly CatalogEntry[];
  private readonly logger?: DownloadLogger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly freeBytesFn: (dir: string) => number | null;
  private readonly resolveFn: (entry: CatalogEntry) => Promise<ResolvedCatalogPackage>;
  private readonly diskMarginBytes: number;
  private readonly progressIntervalMs: number;
  private readonly resolveTimeoutMs: number;

  private readonly tasks = new Map<string, DownloadTask>();
  private readonly queue: string[] = [];
  private readonly cancelRequested = new Set<string>();
  private running = false;
  private activeDownloadId: string | null = null;
  private controller: AbortController | null = null;
  private lastProgressPersist = 0;

  constructor(options: TtsDownloadManagerOptions) {
    this.registryPath = options.registryPath;
    this.modelsDir = resolve(options.modelsDir);
    this.engineModelsDir = resolve(options.engineModelsDir);
    this.catalog = options.catalog ?? CATALOG_ENTRIES;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.freeBytesFn = options.freeBytes ?? statfsFreeBytes;
    this.resolveTimeoutMs = options.resolveTimeoutMs ?? DEFAULT_RESOLVE_TIMEOUT_MS;
    this.resolveFn =
      options.resolve ??
      ((entry) =>
        resolveCatalogPackage(entry, {
          fetchImpl: this.fetchImpl,
          timeoutMs: this.resolveTimeoutMs,
        }));
    this.diskMarginBytes = options.diskMarginBytes ?? DEFAULT_DISK_MARGIN_BYTES;
    this.progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.loadRegistry();
    this.reconcile();
  }

  /* ── Catalogue ─────────────────────────────────────────────────────────── */

  catalogEntries(): readonly CatalogEntry[] {
    return this.catalog;
  }

  notIncluded(): readonly CatalogRejection[] {
    return CATALOG_REJECTIONS;
  }

  /** Chemin de destination VU PAR LE GATEWAY. */
  gatewayPathFor(catalogId: string): string {
    return join(this.modelsDir, "downloads", catalogId, DOWNLOAD_FILE_NAME);
  }

  /** Chemin de destination VU PAR LE MOTEUR. */
  enginePathFor(catalogId: string): string {
    return `${this.engineModelsDir}/downloads/${catalogId}/${DOWNLOAD_FILE_NAME}`;
  }

  /* ── Registre durable ──────────────────────────────────────────────────── */

  private loadRegistry(): void {
    if (!existsSync(this.registryPath)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.registryPath, "utf8"));
    } catch (error) {
      this.logger?.warn("tts.download.registry.unreadable", {
        path: this.registryPath,
        error: messageOf(error),
      });
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const tasks = (parsed as RegistryFile).tasks;
    if (!Array.isArray(tasks)) return;
    for (const raw of tasks) {
      if (!raw || typeof raw !== "object") continue;
      const task = raw as DownloadTask;
      if (typeof task.catalogId !== "string" || task.catalogId.length === 0) continue;
      this.tasks.set(task.catalogId, {
        ...task,
        schemaVersion: DOWNLOAD_SCHEMA_VERSION,
        bytesDownloaded: Number.isFinite(task.bytesDownloaded) ? task.bytesDownloaded : 0,
        resumedFromBytes: Number.isFinite(task.resumedFromBytes) ? task.resumedFromBytes : 0,
      });
    }
  }

  /**
   * Réconcilie au démarrage : une tâche non terminale laissée par un processus
   * tué (redémarrage du gateway) devient `interrupted` — JAMAIS `done`.
   */
  reconcile(): void {
    const at = new Date(this.now()).toISOString();
    let changed = false;
    for (const task of this.tasks.values()) {
      if (isDownloadTerminal(task.status)) continue;
      task.status = "interrupted";
      task.error =
        "Téléchargement interrompu par l'arrêt du gateway. Le fichier partiel est conservé : " +
        "relancez le téléchargement pour reprendre là où il s'était arrêté.";
      task.code = "interrupted";
      task.finishedAt = at;
      task.updatedAt = at;
      changed = true;
    }
    if (changed) this.persist();
  }

  private persist(): void {
    const payload: RegistryFile = {
      schemaVersion: DOWNLOAD_SCHEMA_VERSION,
      tasks: [...this.tasks.values()],
    };
    try {
      writeJsonAtomic(this.registryPath, payload);
    } catch (error) {
      this.logger?.error("tts.download.registry.write_failed", {
        path: this.registryPath,
        error: messageOf(error),
      });
    }
  }

  /* ── Lecture ───────────────────────────────────────────────────────────── */

  list(): DownloadTask[] {
    return [...this.tasks.values()].map(copyTask);
  }

  get(catalogId: string): DownloadTask | undefined {
    const task = this.tasks.get(catalogId);
    return task ? copyTask(task) : undefined;
  }

  /** Vrai si au moins une tâche est `queued`, `downloading` ou `verifying`. */
  hasActive(): boolean {
    for (const task of this.tasks.values()) {
      if (!isDownloadTerminal(task.status)) return true;
    }
    return false;
  }

  /** Id de la tâche réellement en cours (`downloading`/`verifying`), sinon `null`. */
  activeId(): string | null {
    for (const task of this.tasks.values()) {
      if (task.status === "downloading" || task.status === "verifying") {
        return task.catalogId;
      }
    }
    return null;
  }

  /* ── Démarrage ─────────────────────────────────────────────────────────── */

  /**
   * Enregistre et met en file un téléchargement.
   *
   * Refuse AVANT toute écriture si : identifiant inconnu (`400`), téléchargement
   * déjà en cours pour ce modèle (`409`), dossier des modèles non inscriptible
   * (`503`, message exact via `describeWriteFailure`), espace disque insuffisant
   * (`507`), résolution HF impossible (`502`).
   */
  async start(catalogId: string): Promise<DownloadTask> {
    const entry = findCatalogEntry(catalogId, this.catalog);
    if (!entry) {
      throw new TtsDownloadError(
        "unknown_catalog_id",
        400,
        `Modèle inconnu du catalogue : « ${catalogId} ».`,
      );
    }
    const existing = this.tasks.get(catalogId);
    if (existing && !isDownloadTerminal(existing.status)) {
      throw new TtsDownloadError(
        "download_in_progress",
        409,
        `Un téléchargement est déjà en cours ou en attente pour « ${catalogId} » ` +
          `(état : ${existing.status}).`,
      );
    }

    // Résolution HF AVANT toute écriture (source de vérité : nom, taille, SHA).
    let resolved: ResolvedPackage;
    let source: "hf" | "fallback";
    let warning: string | null;
    try {
      const outcome = await this.resolveFn(entry);
      resolved = outcome.resolved;
      source = outcome.source;
      warning = outcome.warning;
    } catch (error) {
      throw new TtsDownloadError(
        "catalog_resolve_failed",
        502,
        `Résolution du paquet « ${catalogId} » impossible : ${messageOf(error)}`,
      );
    }

    const dir = join(this.modelsDir, "downloads", catalogId);
    const probe = probeWritable(dir);
    if (!probe.writable) {
      throw new TtsDownloadError(
        "models_dir_unwritable",
        503,
        "Le dossier des modèles n'est pas inscriptible par le gateway : " +
          describeWriteFailure({
            volume: "models",
            path: dir,
            code: probe.code,
            service: "gateway",
          }) +
          (probe.error ? ` Détail brut : ${probe.error}.` : ""),
      );
    }

    const gatewayPath = join(dir, DOWNLOAD_FILE_NAME);
    const partPath = `${gatewayPath}${DOWNLOAD_PART_SUFFIX}`;
    const partBytes = existsSync(partPath) ? safeSize(partPath) : 0;
    const resumeBytes = resolved.bytes > 0 && partBytes > 0 && partBytes < resolved.bytes ? partBytes : 0;
    const needed = Math.max(0, resolved.bytes - resumeBytes);
    const free = this.freeBytesFn(this.modelsDir);
    if (free !== null && free < needed + this.diskMarginBytes) {
      throw new TtsDownloadError(
        "insufficient_disk_space",
        507,
        `Espace disque insuffisant pour « ${catalogId} » : ${formatBytes(needed)} requis ` +
          `(+ ${formatBytes(this.diskMarginBytes)} de marge), ${formatBytes(free)} disponibles ` +
          `dans « ${this.modelsDir} ».`,
      );
    }

    const at = new Date(this.now()).toISOString();
    const task: DownloadTask = {
      schemaVersion: DOWNLOAD_SCHEMA_VERSION,
      catalogId,
      label: entry.label,
      status: "queued",
      enginePath: this.enginePathFor(catalogId),
      gatewayPath,
      url: resolved.url,
      fileName: resolved.fileName,
      totalBytes: resolved.bytes > 0 ? resolved.bytes : null,
      bytesDownloaded: resumeBytes,
      sha256: null,
      sha256Verified: false,
      expectedSha256: resolved.sha256,
      source,
      warning,
      error: null,
      code: null,
      resumedFromBytes: resumeBytes,
      etag: null,
      createdAt: at,
      startedAt: null,
      finishedAt: null,
      updatedAt: at,
    };
    this.tasks.set(catalogId, task);
    this.persist();
    this.queue.push(catalogId);
    this.logger?.info("tts.download.queued", {
      catalog_id: catalogId,
      total_bytes: task.totalBytes,
      source,
    });
    this.schedulePump();
    return copyTask(task);
  }

  /* ── Annulation ────────────────────────────────────────────────────────── */

  /** Annule une tâche en attente ou en cours. Refuse si déjà terminale. */
  cancel(catalogId: string): DownloadTask {
    const task = this.tasks.get(catalogId);
    if (!task) {
      throw new TtsDownloadError(
        "unknown_download",
        404,
        `Aucun téléchargement pour « ${catalogId} ».`,
      );
    }
    if (isDownloadTerminal(task.status)) {
      throw new TtsDownloadError(
        "download_not_active",
        409,
        `Le téléchargement « ${catalogId} » est déjà terminé (état : ${task.status}).`,
      );
    }
    const at = new Date(this.now()).toISOString();
    task.status = "cancelled";
    task.error = null;
    task.code = "cancelled";
    task.finishedAt = at;
    task.updatedAt = at;
    this.cancelRequested.add(catalogId);
    const queuedAt = this.queue.indexOf(catalogId);
    if (queuedAt >= 0) this.queue.splice(queuedAt, 1);
    // N'interrompt QUE la tâche réellement en cours.
    if (this.activeDownloadId === catalogId) {
      this.controller?.abort();
    }
    this.persist();
    this.logger?.info("tts.download.cancelled", { catalog_id: catalogId });
    return copyTask(task);
  }

  /* ── Boucle ────────────────────────────────────────────────────────────── */

  private schedulePump(): void {
    if (this.running) return;
    if (this.queue.length === 0) return;
    void this.pump().catch((error: unknown) => {
      this.logger?.error("tts.download.pump_failed", { error: messageOf(error) });
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    const next = this.queue.shift();
    if (next === undefined) return;
    this.running = true;
    try {
      await this.runTask(next);
    } finally {
      this.running = false;
      this.activeDownloadId = null;
      this.controller = null;
      if (this.queue.length > 0) {
        void this.pump().catch((error: unknown) => {
          this.logger?.error("tts.download.pump_failed", { error: messageOf(error) });
        });
      }
    }
  }

  private touch(task: DownloadTask): void {
    task.updatedAt = new Date(this.now()).toISOString();
  }

  private async runTask(catalogId: string): Promise<void> {
    const task = this.tasks.get(catalogId);
    if (!task) return;
    // Annulée avant démarrage : rien à faire.
    if (task.status === "cancelled" || this.cancelRequested.has(catalogId)) return;

    const entry = findCatalogEntry(catalogId, this.catalog);
    if (!entry || task.url === null) {
      this.finalizeFailed(task, "catalog_resolve_failed", "Paquet non résolu.");
      return;
    }

    const controller = new AbortController();
    this.controller = controller;
    this.activeDownloadId = catalogId;
    task.status = "downloading";
    task.startedAt = task.startedAt ?? new Date(this.now()).toISOString();
    this.touch(task);
    this.persist();
    this.logger?.info("tts.download.started", {
      catalog_id: catalogId,
      url: task.url,
      resumed_from: task.resumedFromBytes,
    });

    const gatewayPath = task.gatewayPath;
    const partPath = `${gatewayPath}${DOWNLOAD_PART_SUFFIX}`;
    const total = task.totalBytes ?? 0;

    try {
      mkdirSync(dirname(gatewayPath), { recursive: true });
      // Reprise : uniquement si un `.part` exploitable existe.
      let offset = 0;
      if (existsSync(partPath)) {
        const size = safeSize(partPath);
        if (total > 0 && size === total) {
          // Déjà complet : on ne re-télécharge pas, on vérifie et publie.
          const hash = createHash("sha256");
          await hashFileInto(hash, partPath);
          await this.finalizeFromPart(task, partPath, gatewayPath, size, hash.digest("hex"));
          return;
        }
        if (total > 0 && size > total) {
          // Trop gros (corrompu / taille distante réduite) : on repart de zéro.
          rmSync(partPath, { force: true });
        } else if (total > 0 && size > 0) {
          offset = size;
        } else {
          rmSync(partPath, { force: true });
        }
      }

      const headers: Record<string, string> = { accept: "application/octet-stream" };
      if (offset > 0) {
        headers.range = `bytes=${offset}-`;
        if (task.etag) headers["if-range"] = task.etag;
      }
      const response = await this.fetchImpl(task.url, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "follow",
      });

      let append = false;
      if (offset > 0) {
        if (response.status === 206) {
          const totalFromRange = contentRangeTotal(response.headers.get("content-range"));
          if (totalFromRange !== null && total > 0 && totalFromRange !== total) {
            throw new TtsDownloadError(
              "size_changed",
              409,
              `La taille distante a changé (${totalFromRange} ≠ ${total}) : reprise impossible, ` +
                "relancez le téléchargement.",
            );
          }
          append = true;
        } else if (response.status === 200) {
          // Le serveur ignore `Range` : on repart de zéro.
          offset = 0;
        } else {
          throw new TtsDownloadError(
            "http_error",
            502,
            `Téléchargement refusé par le serveur (HTTP ${response.status}).`,
          );
        }
      } else if (!response.ok) {
        throw new TtsDownloadError(
          "http_error",
          502,
          `Téléchargement refusé par le serveur (HTTP ${response.status}).`,
        );
      }

      const etag = response.headers.get("etag");
      if (etag) task.etag = etag;
      if (!append && existsSync(partPath)) rmSync(partPath, { force: true });

      const hash = createHash("sha256");
      if (append && existsSync(partPath)) {
        // Reprise : rejoue le préfixe pour un SHA-256 complet et exact.
        await hashFileInto(hash, partPath);
      }

      task.bytesDownloaded = append ? offset : 0;
      task.resumedFromBytes = append ? offset : 0;
      this.lastProgressPersist = this.now();

      const body = response.body;
      if (!body) {
        throw new TtsDownloadError("empty_response", 502, "Réponse du serveur sans corps.");
      }
      const handle: FileHandle = await open(partPath, append ? "a" : "w");
      try {
        for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
          if (this.cancelRequested.has(catalogId) || isCancelled(task)) {
            throw new DownloadCancelled();
          }
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          await handle.write(buffer);
          hash.update(buffer);
          task.bytesDownloaded += buffer.length;
          this.maybePersistProgress();
        }
      } finally {
        await handle.close();
      }

      if (this.cancelRequested.has(catalogId) || isCancelled(task)) return;

      const actual = safeSize(partPath);
      if (total > 0 && actual !== total) {
        rmSync(partPath, { force: true });
        throw new TtsDownloadError(
          "size_mismatch",
          502,
          `Taille du fichier reçu (${actual} octets) différente de la taille annoncée (${total}).`,
        );
      }
      await this.finalizeFromPart(task, partPath, gatewayPath, actual, hash.digest("hex"));
    } catch (error) {
      if (
        this.cancelRequested.has(catalogId) ||
        isCancelled(task) ||
        error instanceof DownloadCancelled ||
        isAbortError(error)
      ) {
        if (!isDownloadTerminal(task.status)) {
          task.status = "cancelled";
          task.code = "cancelled";
          task.finishedAt = new Date(this.now()).toISOString();
          this.touch(task);
          this.persist();
        }
        return;
      }
      this.finalizeFailed(
        task,
        error instanceof TtsDownloadError ? error.code : "download_failed",
        messageOf(error),
      );
    }
  }

  /**
   * Vérifie (`verifying`) puis publie (`rename` atomique) le fichier partiel.
   * Le SHA-256 est calculé sur le fichier complet ; il n'est marqué « vérifié »
   * que s'il correspond à celui annoncé par Hugging Face.
   */
  private async finalizeFromPart(
    task: DownloadTask,
    partPath: string,
    gatewayPath: string,
    size: number,
    digest: string,
  ): Promise<void> {
    task.status = "verifying";
    task.bytesDownloaded = size;
    this.touch(task);
    this.persist();
    // Intégrité : vérifiée SEULEMENT si HF a annoncé un SHA-256.
    if (task.expectedSha256) {
      if (digest !== task.expectedSha256) {
        rmSync(partPath, { force: true });
        this.finalizeFailed(
          task,
          "integrity_mismatch",
          `SHA-256 du fichier téléchargé (${digest}) différent de celui annoncé ` +
            `(${task.expectedSha256}) : le fichier a été supprimé.`,
        );
        return;
      }
      task.sha256Verified = true;
    }
    try {
      renameSync(partPath, gatewayPath);
    } catch (error) {
      this.finalizeFailed(
        task,
        "publish_failed",
        `Impossible de publier « ${gatewayPath} » : ${messageOf(error)}`,
      );
      return;
    }
    task.sha256 = digest;
    task.status = "done";
    task.error = null;
    task.code = null;
    task.bytesDownloaded = size;
    if (task.totalBytes === null || task.totalBytes === 0) task.totalBytes = size;
    task.finishedAt = new Date(this.now()).toISOString();
    this.touch(task);
    this.persist();
    this.logger?.info("tts.download.done", {
      catalog_id: task.catalogId,
      bytes: size,
      sha256_verified: task.sha256Verified,
    });
  }

  private finalizeFailed(task: DownloadTask, code: string, message: string): void {
    task.status = "failed";
    task.code = code;
    task.error = message;
    task.finishedAt = new Date(this.now()).toISOString();
    this.touch(task);
    this.persist();
    this.logger?.error("tts.download.failed", {
      catalog_id: task.catalogId,
      code,
      error: message,
    });
  }

  private maybePersistProgress(): void {
    const now = this.now();
    if (now - this.lastProgressPersist < this.progressIntervalMs) return;
    this.lastProgressPersist = now;
    const task = this.activeTask();
    if (task) this.touch(task);
    this.persist();
  }

  private activeTask(): DownloadTask | undefined {
    for (const task of this.tasks.values()) {
      if (task.status === "downloading") return task;
    }
    return undefined;
  }
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function safeSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} Gio`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} Mio`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} Kio`;
  return `${bytes} o`;
}
