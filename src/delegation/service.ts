/**
 * Service de délégation (AUCUN import SDK/typebox).
 *
 * Orchestre : admission dans la file bornée → création du job dans le
 * `JobStore` → démarrage du worker lourd → attente inline bornée par la
 * deadline → report du léger à la fin réelle du job.
 *
 * Le job n'est JAMAIS annulé du fait de la deadline : un Stop du léger pendant
 * un inline interrompt seulement l'attente, le job survit et sera rapporté.
 */

import { JobQueue } from "../jobs/queue.js";
import { JobStore } from "../jobs/store.js";
import type { JobRecord, JobUsage } from "../jobs/types.js";
import { sanitizeErrorText } from "../pi/events.js";
import { PHASE } from "../pi/instrumentation.js";
import type { PiEvent, PiEventSource } from "../pi/types.js";
import type {
  AvailabilityRole,
  CancelOutcome,
  DelegateOutcome,
  DelegateRequest,
  DelegateServicePort,
  HeavyRunHandle,
  HeavyRunRequest,
  HeavyWorker,
  JobReporter,
  LightWaker,
  ModelAvailability,
} from "./ports.js";
import { buildReportPrompt } from "./report.js";

export const DEFAULT_DEADLINE_MS = 1_500;
export const MIN_DEADLINE_MS = 200;
export const MAX_DEADLINE_MS = 60_000;
export const DEFAULT_INLINE_MAX_BYTES = 32_768;
export const ORIGIN_JOB_REPORT = "job_report";
export const ORIGIN_USER = "user";

/** Bornes la deadline et retombe sur la valeur par défaut si non numérique. */
export function clampDeadline(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    const rounded = Math.round(value);
    return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, rounded));
  }
  return DEFAULT_DEADLINE_MS;
}

/** Tronque une chaîne pour tenir dans `maxBytes` octets UTF-8. */
export function truncateToBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { text: text.slice(0, low), truncated: true };
}

export interface DelegationLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface DelegationServiceOptions {
  store: JobStore;
  queue: JobQueue;
  heavy: HeavyWorker;
  availability: ModelAvailability;
  logger: DelegationLogger;
  /** Réveil du léger (renseigné après création du host via `setWaker`). */
  waker?: LightWaker;
  /** Réservé Lot 10 : canal de notification sortant. */
  reporter?: JobReporter;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  inlineMaxBytes?: number;
  defaultDeadlineMs?: number;
  now?: () => number;
  idFactory?: () => string;
}

interface Completion {
  promise: Promise<JobRecord>;
  resolve: (record: JobRecord) => void;
}

export class DelegationService implements DelegateServicePort, PiEventSource {
  private readonly store: JobStore;
  private readonly queue: JobQueue;
  private readonly heavy: HeavyWorker;
  private readonly availability: ModelAvailability;
  private readonly logger: DelegationLogger;
  private readonly reporter?: JobReporter;
  private readonly idleTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly inlineMaxBytes: number;
  private readonly defaultDeadlineMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;

  private waker?: LightWaker;
  private readonly listeners = new Set<(event: PiEvent) => void>();
  private readonly completions = new Map<string, Completion>();
  private readonly handles = new Map<string, HeavyRunHandle>();

  constructor(options: DelegationServiceOptions) {
    this.store = options.store;
    this.queue = options.queue;
    this.heavy = options.heavy;
    this.availability = options.availability;
    this.logger = options.logger;
    if (options.reporter) this.reporter = options.reporter;
    this.idleTimeoutMs = options.idleTimeoutMs;
    this.totalTimeoutMs = options.totalTimeoutMs;
    this.inlineMaxBytes = options.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES;
    this.defaultDeadlineMs = options.defaultDeadlineMs ?? DEFAULT_DEADLINE_MS;
    this.now = options.now ?? Date.now;
    this.idFactory =
      options.idFactory ??
      (() => `job-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    if (options.waker) this.waker = options.waker;
  }

  /** Renseigne le réveil du léger une fois le host construit. */
  setWaker(waker: LightWaker): void {
    this.waker = waker;
  }

  /** Publie tous les événements (phases + lifecycle) sur le bus Pi. */
  subscribe(listener: (event: PiEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  counts() {
    return this.store.counts();
  }

  queuedCount(): number {
    return this.queue.queuedCount;
  }

  runningCount(): number {
    return this.queue.runningCount;
  }

  jobStatus(jobId: string): JobRecord | undefined {
    return this.store.get(jobId);
  }

  async delegate(request: DelegateRequest): Promise<DelegateOutcome> {
    const sessionId = request.lightSessionId;
    const runId = request.parentRunId ?? "";
    const deadlineMs = clampDeadline(
      request.deadlineMs ?? this.defaultDeadlineMs,
    );
    const t0 = this.now();

    this.emitPhase(PHASE.delegateReceived, sessionId, runId, undefined, t0);

    if (!this.availability.isAvailable("heavy" as AvailabilityRole)) {
      this.logger.warn("delegation.unavailable", { session_id: sessionId });
      return { status: "unavailable", reason: "heavy_unavailable" };
    }

    const jobId = this.idFactory();
    const admission = this.queue.admit(jobId);
    if (admission.admission === "rejected") {
      this.logger.warn("delegation.queue_full", { session_id: sessionId });
      return { status: "rejected", reason: "queue_full" };
    }

    const origin = request.origin ?? ORIGIN_USER;
    const createdAt = new Date(this.now()).toISOString();
    this.store.append(jobId, "created", {
      status: "queued",
      task: request.task,
      ...(request.context !== undefined ? { context: request.context } : {}),
      deadlineMs,
      lightSessionId: sessionId,
      ...(request.parentRunId !== undefined
        ? { parentRunId: request.parentRunId }
        : {}),
      origin,
      createdAt,
    });
    this.store.append(jobId, "queued", {});
    this.emitPhase(PHASE.jobEnqueued, sessionId, runId, jobId, t0);

    const completion = this.makeCompletion();
    this.completions.set(jobId, completion);

    if (admission.admission === "start") {
      this.startJob(jobId);
    } else {
      this.logger.info("delegation.queued", {
        job_id: jobId,
        position: admission.position,
      });
    }

    const outcome = await this.awaitInline(
      jobId,
      completion.promise,
      deadlineMs,
      t0,
      request.signal,
    );
    this.completions.delete(jobId);
    return outcome;
  }

  async cancelJob(jobId: string): Promise<CancelOutcome> {
    const record = this.store.get(jobId);
    if (!record) return { status: "not_found", job_id: jobId };
    if (record.status === "queued") {
      this.queue.remove(jobId);
      this.store.append(jobId, "cancelled", {
        status: "cancelled",
        finishedAt: new Date(this.now()).toISOString(),
      });
      this.settle(jobId);
      this.emitPhase(
        PHASE.jobFinished,
        record.lightSessionId,
        record.parentRunId ?? "",
        jobId,
        this.now(),
      );
      this.emitJobFinished(record.lightSessionId, jobId, "cancelled");
      return { status: "cancelled", job_id: jobId };
    }
    if (record.status === "running") {
      const handle = this.handles.get(jobId);
      try {
        await handle?.cancel();
      } catch (error) {
        this.logger.warn("delegation.cancel.failed", {
          job_id: jobId,
          error: sanitizeErrorText(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
      return { status: "cancelled", job_id: jobId };
    }
    return { status: "not_cancellable", job_id: jobId, job_status: record.status };
  }

  /* ------------------------------------------------------------------ */
  /* Interne                                                             */
  /* ------------------------------------------------------------------ */

  private makeCompletion(): Completion {
    let resolve!: (record: JobRecord) => void;
    const promise = new Promise<JobRecord>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  private settle(jobId: string): void {
    const completion = this.completions.get(jobId);
    const record = this.store.get(jobId);
    if (completion && record) completion.resolve(record);
  }

  private emitEvent(event: PiEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn("delegation.listener.error", {
          error: sanitizeErrorText(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
    }
  }

  private emitPhase(
    stage: string,
    sessionId: string,
    runId: string,
    jobId: string | undefined,
    t0: number,
  ): void {
    const at = this.now();
    const sinceT0Ms = Math.max(0, at - t0);
    this.emitEvent({
      type: "phase",
      sessionId,
      runId,
      stage,
      at: new Date(at).toISOString(),
      sinceT0Ms,
      ...(jobId ? { jobId } : {}),
    });
    this.logger.debug("pi.phase", {
      session_id: sessionId,
      run_id: runId,
      ...(jobId ? { job_id: jobId } : {}),
      stage,
      at: new Date(at).toISOString(),
      since_t0_ms: sinceT0Ms,
    });
  }

  private emitJobStarted(sessionId: string, jobId: string, task: string): void {
    this.emitEvent({ type: "job_started", sessionId, jobId, task });
  }

  private emitJobFinished(
    sessionId: string,
    jobId: string,
    status: "completed" | "failed" | "cancelled" | "interrupted",
  ): void {
    this.emitEvent({ type: "job_finished", sessionId, jobId, status });
  }

  private startJob(jobId: string): void {
    const record = this.store.get(jobId);
    if (!record || record.status !== "queued") return;
    this.store.append(jobId, "started", {
      status: "running",
      startedAt: new Date(this.now()).toISOString(),
    });
    this.emitPhase(
      PHASE.jobStarted,
      record.lightSessionId,
      record.parentRunId ?? "",
      jobId,
      this.now(),
    );
    this.emitJobStarted(record.lightSessionId, jobId, record.task);

    const request: HeavyRunRequest = {
      jobId,
      task: record.task,
      lightSessionId: record.lightSessionId,
      idleTimeoutMs: this.idleTimeoutMs,
      totalTimeoutMs: this.totalTimeoutMs,
      ...(record.context !== undefined ? { context: record.context } : {}),
      onFirstToken: () => {
        this.emitPhase(
          PHASE.jobFirstToken,
          record.lightSessionId,
          record.parentRunId ?? "",
          jobId,
          this.now(),
        );
      },
      onProgress: (partial: string) => {
        this.store.append(jobId, "progress", { result: { partial } });
      },
      onSession: (heavySessionId: string) => {
        this.store.append(jobId, "progress", { heavySessionId });
      },
    };

    let handle: HeavyRunHandle;
    try {
      handle = this.heavy.run(request);
    } catch (error) {
      this.finishJob(jobId, {
        status: "failed",
        error: sanitizeErrorText(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return;
    }
    this.handles.set(jobId, handle);
    handle.promise
      .then((result) => this.finishJob(jobId, result))
      .catch((error: unknown) => {
        this.finishJob(jobId, {
          status: "failed",
          error: sanitizeErrorText(
            error instanceof Error ? error.message : String(error),
          ),
        });
      });
  }

  private finishJob(
    jobId: string,
    result: {
      status: "completed" | "failed" | "cancelled";
      text?: string;
      partial?: string;
      usage?: JobUsage;
      error?: string;
    },
  ): void {
    this.handles.delete(jobId);
    const record = this.store.get(jobId);
    if (!record) return;

    const finishedAt = new Date(this.now()).toISOString();
    if (result.status === "completed") {
      this.store.append(jobId, "completed", {
        status: "completed",
        finishedAt,
        result: { text: result.text ?? "", usage: result.usage ?? { input: 0, output: 0 } },
      });
    } else if (result.status === "cancelled") {
      this.store.append(jobId, "cancelled", {
        status: "cancelled",
        finishedAt,
        ...(result.partial !== undefined
          ? { result: { partial: result.partial } }
          : {}),
      });
    } else {
      this.store.append(jobId, "failed", {
        status: "failed",
        finishedAt,
        result: {
          ...(result.text !== undefined ? { text: result.text } : {}),
          ...(result.partial !== undefined ? { partial: result.partial } : {}),
          ...(result.usage !== undefined ? { usage: result.usage } : {}),
        },
        error: { message: sanitizeErrorText(result.error ?? "échec du worker lourd") },
      });
    }

    const next = this.queue.release(jobId);
    if (next) this.startJob(next);

    this.settle(jobId);

    const updated = this.store.get(jobId);
    const status = updated?.status ?? result.status;
    this.emitPhase(
      PHASE.jobFinished,
      record.lightSessionId,
      record.parentRunId ?? "",
      jobId,
      this.now(),
    );
    this.emitJobFinished(record.lightSessionId, jobId, result.status);

    if (status === "completed" || status === "failed") {
      this.reportJob(jobId);
    }
  }

  private reportJob(jobId: string): void {
    const record = this.store.get(jobId);
    if (!record) return;
    this.emitPhase(
      PHASE.reportRequested,
      record.lightSessionId,
      record.parentRunId ?? "",
      jobId,
      this.now(),
    );

    let runId: string | undefined;
    if (this.waker) {
      try {
        const handle = this.waker.send(record.lightSessionId, buildReportPrompt(record), {
          origin: ORIGIN_JOB_REPORT,
          jobId,
        });
        if (handle && typeof handle.runId === "string") runId = handle.runId;
      } catch (error) {
        this.logger.warn("delegation.report.failed", {
          job_id: jobId,
          error: sanitizeErrorText(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
    }

    this.store.append(jobId, "notified", {
      notified: true,
      reportedAt: new Date(this.now()).toISOString(),
    });
    this.emitEvent({
      type: "job_report",
      sessionId: record.lightSessionId,
      jobId,
      ...(runId ? { runId } : {}),
    });
    this.emitPhase(
      PHASE.reportEmitted,
      record.lightSessionId,
      record.parentRunId ?? "",
      jobId,
      this.now(),
    );

    // Réservé Lot 10 (canal de notification sortant) : non implémenté.
    if (this.reporter) {
      void Promise.resolve(this.reporter.report(record)).catch((error: unknown) => {
        this.logger.warn("delegation.reporter.failed", {
          job_id: jobId,
          error: sanitizeErrorText(
            error instanceof Error ? error.message : String(error),
          ),
        });
      });
    }
  }

  private awaitInline(
    jobId: string,
    completion: Promise<JobRecord>,
    deadlineMs: number,
    t0: number,
    signal?: AbortSignal,
  ): Promise<DelegateOutcome> {
    return new Promise<DelegateOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: DelegateOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        this.emitPhase(
          PHASE.delegateReturnedPending,
          this.store.get(jobId)?.lightSessionId ?? "",
          this.store.get(jobId)?.parentRunId ?? "",
          jobId,
          t0,
        );
        finish(this.pendingOutcome(jobId, deadlineMs));
      }, Math.max(0, deadlineMs));

      const onAbort = (): void => {
        // Un Stop du léger n'annule PAS le job : on rend la main immédiatement.
        this.emitPhase(
          PHASE.delegateReturnedPending,
          this.store.get(jobId)?.lightSessionId ?? "",
          this.store.get(jobId)?.parentRunId ?? "",
          jobId,
          t0,
        );
        finish(this.pendingOutcome(jobId, deadlineMs, "run_aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      this.emitPhase(
        PHASE.delegateInlineWait,
        this.store.get(jobId)?.lightSessionId ?? "",
        this.store.get(jobId)?.parentRunId ?? "",
        jobId,
        t0,
      );

      void completion.then((record) => {
        const outcome = this.recordOutcome(record, t0);
        this.emitPhase(
          PHASE.delegateReturnedInline,
          record.lightSessionId,
          record.parentRunId ?? "",
          record.id,
          t0,
        );
        finish(outcome);
      });
    });
  }

  private recordOutcome(record: JobRecord, t0: number): DelegateOutcome {
    switch (record.status) {
      case "completed": {
        const { text, truncated } = truncateToBytes(
          record.result.text ?? "",
          this.inlineMaxBytes,
        );
        const outcome: DelegateOutcome = {
          status: "completed",
          result: text,
          duration_ms: Math.max(0, this.now() - t0),
          truncated,
          ...(record.result.usage
            ? {
                usage_input: record.result.usage.input,
                usage_output: record.result.usage.output,
              }
            : {}),
        };
        return outcome;
      }
      case "failed": {
        const message = record.error?.message ?? "échec du worker lourd";
        const partial = record.result.partial;
        if (message === "timeout" || message === "idle_timeout") {
          return {
            status: "timeout",
            error: "timeout",
            ...(partial !== undefined ? { partial } : {}),
          };
        }
        return {
          status: "failed",
          error: message,
          ...(partial !== undefined ? { partial } : {}),
        };
      }
      case "cancelled":
        return { status: "cancelled", job_id: record.id };
      default:
        return this.pendingOutcome(record.id, record.deadlineMs);
    }
  }

  private pendingOutcome(
    jobId: string,
    deadlineMs: number,
    reason = "deadline",
  ): DelegateOutcome {
    return {
      status: "pending",
      job_id: jobId,
      deadline_ms: deadlineMs,
      note:
        reason === "run_aborted"
          ? "Le job continue en arrière-plan ; le run courant s'est arrêté."
          : "La deadline inline est dépassée ; le job continue en arrière-plan.",
    };
  }
}

/** Fabrique du service de délégation. */
export function createDelegationService(
  options: DelegationServiceOptions,
): DelegationService {
  return new DelegationService(options);
}
