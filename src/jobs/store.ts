/**
 * `JobStore` — journal append-only JSONL + projection en mémoire.
 *
 * AUCUN import SDK/typebox.
 *
 * Invariants :
 *  - écritures purement append-only (une ligne JSON par événement) ;
 *  - projection reconstruite en rejouant le journal (survit à un redémarrage) ;
 *  - rejeu IDEMPOTENT : un `eventId` déjà appliqué est ignoré ;
 *  - « dernier seq gagnant » : un événement de `seq` strictement inférieur au
 *    dernier appliqué pour ce job est ignoré ;
 *  - toute transition de statut illégale est REJETÉE (à l'écriture : erreur ;
 *    au rejeu : ignorée + avertissement, le journal corrompu ne bloque pas).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { JobError } from "./errors.js";
import {
  JOB_SCHEMA_VERSION,
  emptyCounts,
  isTransitionAllowed,
  statusForKind,
  type JobCounts,
  type JobEvent,
  type JobKind,
  type JobPatch,
  type JobRecord,
  type JobResult,
  type JobStatus,
} from "./types.js";

export interface JobLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface JobStoreOptions {
  path: string;
  logger?: JobLogger;
  now?: () => number;
  /** Fabrique d'`eventId` (injectable pour des tests déterministes). */
  idFactory?: () => string;
}

export type JobEventListener = (event: JobEvent, record: JobRecord) => void;

let fallbackCounter = 0;

function defaultIdFactory(): string {
  fallbackCounter += 1;
  return `evt-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

function mergeResult(
  base: JobResult | undefined,
  patch: JobResult | undefined,
): JobResult | undefined {
  if (!patch) return base;
  const merged: JobResult = { ...(base ?? {}) };
  if (patch.text !== undefined) merged.text = patch.text;
  if (patch.partial !== undefined) merged.partial = patch.partial;
  if (patch.usage !== undefined) merged.usage = patch.usage;
  if (patch.truncated !== undefined) merged.truncated = patch.truncated;
  return merged;
}

function mergePatch(record: JobRecord, patch: JobPatch): JobRecord {
  const next: JobRecord = { ...record };
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.task !== undefined) next.task = patch.task;
  if (patch.context !== undefined) next.context = patch.context;
  if (patch.deadlineMs !== undefined) next.deadlineMs = patch.deadlineMs;
  if (patch.lightSessionId !== undefined) next.lightSessionId = patch.lightSessionId;
  if (patch.parentRunId !== undefined) next.parentRunId = patch.parentRunId;
  if (patch.heavySessionId !== undefined) next.heavySessionId = patch.heavySessionId;
  if (patch.error !== undefined) next.error = patch.error;
  if (patch.notified !== undefined && patch.notified) next.notified = true;
  if (patch.createdAt !== undefined) next.createdAt = patch.createdAt;
  if (patch.startedAt !== undefined) next.startedAt = patch.startedAt;
  if (patch.finishedAt !== undefined) next.finishedAt = patch.finishedAt;
  if (patch.reportedAt !== undefined) next.reportedAt = patch.reportedAt;
  if (patch.origin !== undefined) next.origin = patch.origin;
  const mergedResult = mergeResult(next.result, patch.result);
  if (mergedResult) next.result = mergedResult;
  return next;
}

function recordFromCreated(
  event: JobEvent,
  patch: JobPatch,
): JobRecord {
  return {
    schemaVersion: JOB_SCHEMA_VERSION,
    id: event.jobId,
    status: patch.status ?? "queued",
    task: patch.task ?? "",
    ...(patch.context !== undefined ? { context: patch.context } : {}),
    deadlineMs: patch.deadlineMs ?? 0,
    lightSessionId: patch.lightSessionId ?? "",
    ...(patch.parentRunId !== undefined ? { parentRunId: patch.parentRunId } : {}),
    ...(patch.heavySessionId !== undefined
      ? { heavySessionId: patch.heavySessionId }
      : {}),
    result: patch.result ?? {},
    ...(patch.error !== undefined ? { error: patch.error } : {}),
    notified: patch.notified ?? false,
    createdAt: patch.createdAt ?? event.ts,
    ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
    ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
    ...(patch.reportedAt !== undefined ? { reportedAt: patch.reportedAt } : {}),
    origin: patch.origin ?? "user",
  };
}

/**
 * Applique un événement à la projection. Lève une `JobError` (hors rejeu) si la
 * transition est illégale. Renvoie `true` si appliqué, `false` si ignoré.
 */
export function applyEventToState(
  state: {
    byId: Map<string, JobRecord>;
    appliedEventIds: Set<string>;
    seqByJob: Map<string, number>;
    lastSeq: number;
  },
  event: JobEvent,
  options: { replay?: boolean; logger?: JobLogger } = {},
): boolean {
  const { replay = false, logger } = options;
  if (state.appliedEventIds.has(event.eventId)) return false;

  const prevSeq = state.seqByJob.get(event.jobId) ?? 0;
  if (event.seq <= prevSeq) return false;

  const reject = (message: string): false => {
    if (replay) {
      logger?.warn("job.store.replay.skipped", {
        job_id: event.jobId,
        kind: event.kind,
        reason: message,
      });
      return false;
    }
    throw new JobError("ILLEGAL_TRANSITION", message, { jobId: event.jobId });
  };

  const record = state.byId.get(event.jobId);
  const targetStatus: JobStatus | undefined = statusForKind(event.kind);

  if (event.kind === "created") {
    if (record) return reject(`job ${event.jobId} déjà créé`);
  } else if (!record) {
    return reject(`événement ${event.kind} pour un job inconnu ${event.jobId}`);
  }

  if (targetStatus !== undefined) {
    if (!isTransitionAllowed(record?.status, targetStatus)) {
      return reject(
        `transition illégale ${record?.status ?? "∅"} → ${targetStatus} (kind=${event.kind})`,
      );
    }
  }

  if (event.kind === "progress") {
    if (record && record.status !== "queued" && record.status !== "running") {
      return reject(`progress sur un job ${record.status}`);
    }
  }

  if (event.kind === "notified") {
    if (record && record.status !== "completed" && record.status !== "failed") {
      return reject(`notified sur un job ${record.status}`);
    }
  }

  // Mutation (après validation).
  const next =
    event.kind === "created"
      ? recordFromCreated(event, event.patch)
      : mergePatch(record as JobRecord, event.patch);
  state.byId.set(event.jobId, next);
  state.appliedEventIds.add(event.eventId);
  state.seqByJob.set(event.jobId, event.seq);
  state.lastSeq = Math.max(state.lastSeq, event.seq);
  return true;
}

export class JobStore {
  private readonly path: string;
  private readonly logger?: JobLogger;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  private readonly byId = new Map<string, JobRecord>();
  private readonly appliedEventIds = new Set<string>();
  private readonly seqByJob = new Map<string, number>();
  private readonly log: JobEvent[] = [];
  private readonly listeners = new Set<JobEventListener>();
  private lastSeq = 0;
  private lastEventId: string | undefined;

  private constructor(options: JobStoreOptions) {
    this.path = options.path;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

  /** Ouvre (ou crée) le journal et reconstruit la projection en le rejouant. */
  static open(options: JobStoreOptions): JobStore {
    const store = new JobStore(options);
    store.replayFromDisk();
    return store;
  }

  /**
   * Construit un store purement en mémoire à partir d'événements (tests de
   * rejeu déterministe). Aucune écriture disque.
   */
  static fromEvents(
    events: readonly JobEvent[],
    options: JobStoreOptions,
  ): JobStore {
    const store = new JobStore(options);
    store.applyMany(events, true);
    return store;
  }

  get filePath(): string {
    return this.path;
  }

  get events(): readonly JobEvent[] {
    return this.log;
  }

  get size(): number {
    return this.byId.size;
  }

  get sequence(): number {
    return this.lastSeq;
  }

  private replayFromDisk(): void {
    if (!existsSync(this.path)) return;
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch (error) {
      throw new JobError(
        "STORE_IO",
        `Lecture impossible du journal de jobs (${this.path}).`,
        { cause: error },
      );
    }
    const events: JobEvent[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        events.push(JSON.parse(trimmed) as JobEvent);
      } catch {
        this.logger?.warn("job.store.line.invalid", { path: this.path });
      }
    }
    this.applyMany(events, true);
  }

  private applyMany(events: readonly JobEvent[], replay: boolean): void {
    for (const event of events) {
      const applied = applyEventToState(
        {
          byId: this.byId,
          appliedEventIds: this.appliedEventIds,
          seqByJob: this.seqByJob,
          lastSeq: this.lastSeq,
        },
        event,
        { replay, ...(this.logger ? { logger: this.logger } : {}) },
      );
      this.lastSeq = Math.max(this.lastSeq, event.seq);
      this.lastEventId = event.eventId;
      if (applied) {
        // Conserve le journal tel qu'il a été lu (rejeu déterministe).
        this.log.push(event);
      }
    }
  }

  /**
   * Applique un événement déjà construit (rejeu ou injection). En écriture
   * normale, préférer `append`.
   */
  apply(event: JobEvent): boolean {
    const applied = applyEventToState(
      {
        byId: this.byId,
        appliedEventIds: this.appliedEventIds,
        seqByJob: this.seqByJob,
        lastSeq: this.lastSeq,
      },
      event,
      { ...(this.logger ? { logger: this.logger } : {}) },
    );
    this.lastSeq = Math.max(this.lastSeq, event.seq);
    this.lastEventId = event.eventId;
    if (applied) this.log.push(event);
    return applied;
  }

  /**
   * Ajoute un événement au journal. Valide la transition AVANT toute écriture
   * disque : un événement illégal ne laisse aucune trace.
   */
  append(
    jobId: string,
    kind: JobKind,
    patch: JobPatch = {},
    meta: { eventId?: string; ts?: string } = {},
  ): JobEvent {
    const seq = this.lastSeq + 1;
    const event: JobEvent = {
      seq,
      ts: meta.ts ?? new Date(this.now()).toISOString(),
      eventId: meta.eventId ?? this.idFactory(),
      jobId,
      kind,
      patch,
    };
    // Peut lever une JobError (transition illégale) — sans avoir écrit.
    const applied = applyEventToState(
      {
        byId: this.byId,
        appliedEventIds: this.appliedEventIds,
        seqByJob: this.seqByJob,
        lastSeq: this.lastSeq,
      },
      event,
      {},
    );
    this.lastSeq = seq;
    this.lastEventId = event.eventId;
    if (!applied) {
      // Idempotence : événement déjà connu, on ne réécrit pas.
      return event;
    }
    this.log.push(event);
    this.persist(event);
    const record = this.byId.get(jobId);
    if (record) {
      for (const listener of this.listeners) {
        listener(event, record);
      }
    }
    return event;
  }

  private persist(event: JobEvent): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      // L'état mémoire est autoritatif pour la session courante ; on signale
      // l'échec d'écriture sans corrompre le reste.
      this.logger?.error("job.store.write.failed", {
        path: this.path,
        job_id: event.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new JobError(
        "STORE_IO",
        `Écriture impossible du journal de jobs (${this.path}).`,
        { cause: error, jobId: event.jobId },
      );
    }
  }

  get(id: string): JobRecord | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  list(): JobRecord[] {
    return [...this.byId.values()];
  }

  counts(): JobCounts {
    const counts = emptyCounts();
    for (const record of this.byId.values()) {
      switch (record.status) {
        case "queued":
          counts.queued += 1;
          break;
        case "running":
          counts.running += 1;
          break;
        case "completed":
          counts.completed += 1;
          break;
        case "failed":
          counts.failed += 1;
          break;
        case "interrupted":
          counts.interrupted += 1;
          break;
        case "cancelled":
          break;
      }
    }
    return counts;
  }

  /** Dernier identifiant d'événement (diagnostic). */
  get lastAppliedEventId(): string | undefined {
    return this.lastEventId;
  }

  subscribe(listener: JobEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
