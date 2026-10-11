/**
 * Service de délégation (AUCUN import SDK/typebox).
 *
 * Orchestre : admission dans la file bornée → création du job dans le
 * `JobStore` → démarrage du worker lourd → (E4) ticket IMMÉDIAT en mode tâche
 * de fond (défaut), ou attente inline bornée par la deadline en mode bloquant →
 * report du léger à la fin réelle du job, LOTISSÉ sur une fenêtre fixe.
 *
 * Le job n'est JAMAIS annulé du fait de la deadline : un Stop du léger pendant
 * un inline interrompt seulement l'attente, le job survit et sera rapporté.
 *
 * ⚠️ E4 — RÉSULTATS LOTIS : les fins de jobs d'UNE MÊME session sont regroupées
 * sur une fenêtre FIXE (`resultBatchWindowMs`, déclenchée par le PREMIER résultat
 * et NON repoussée) ⇒ UN lot = UN SEUL tour. C'est ce qui évite une pluie de
 * tours pour N tâches terminées rapprochées.
 */

import { JobQueue } from "../jobs/queue.js";
import { JobStore } from "../jobs/store.js";
import { isTerminal } from "../jobs/types.js";
import type { JobRecord, JobUsage } from "../jobs/types.js";
import { sanitizeErrorText } from "../pi/events.js";
import { PHASE } from "../pi/instrumentation.js";
import type { PiEvent, PiEventSource, PiJobTerminalStatus } from "../pi/types.js";
import type {
  AvailabilityRole,
  CancelOutcome,
  DelegateDispatched,
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
import { buildBatchReportPrompt } from "./report.js";

export const DEFAULT_DEADLINE_MS = 1_500;
export const MIN_DEADLINE_MS = 200;
export const MAX_DEADLINE_MS = 60_000;
export const DEFAULT_INLINE_MAX_BYTES = 32_768;
export const ORIGIN_JOB_REPORT = "job_report";
export const ORIGIN_USER = "user";
/** Taille maximale de l'extrait de progression porté par une trame d'activité. */
export const ACTIVITY_DETAIL_MAX = 280;
/**
 * E4 — Fenêtre de LOTISSEMENT des résultats (ms). FIXE : déclenchée par le
 * PREMIER résultat et NON repoussée (≠ debounce) ⇒ la latence est bornée.
 */
export const DEFAULT_RESULT_BATCH_WINDOW_MS = 3_000;
/**
 * E4 — Texte du ticket (accusé de LANCEMENT). ⚠️ N'affirme AUCUN résultat : il
 * annonce un lancement et l'arrivée ultérieure du résultat.
 */
export const DISPATCH_NOTE =
  "Tâche lancée en arrière-plan. Elle n'est PAS terminée : son résultat te sera " +
  "transmis automatiquement dès qu'elle sera finie. Ne prétends jamais qu'elle " +
  "est terminée avant d'avoir reçu ce résultat.";

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

/**
 * Extrait lisible (une seule ligne) du travail partiel d'un sous-agent, pour le
 * bloc d'ACTIVITÉ (E3). Tronqué sur une frontière de caractère, jamais au milieu
 * d'un point de code. Donnée d'AFFICHAGE uniquement : jamais prononcée (le bus
 * d'activité n'atteint pas le moteur TTS).
 */
export function excerptForActivity(
  text: string,
  max = ACTIVITY_DETAIL_MAX,
): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
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
  /** Valeur (ou fournisseur) de la deadline par défaut. Lue en direct si fonction. */
  defaultDeadlineMs?: number | (() => number);
  /** E4 — fenêtre de lotissement des résultats (défaut 3 000 ms). */
  resultBatchWindowMs?: number;
  now?: () => number;
  idFactory?: () => string;
  /** Horloges injectables (tests déterministes). */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (timer: unknown) => void;
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
  private readonly defaultDeadlineMs: number | (() => number);
  private readonly resultBatchWindowMs: number;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (timer: unknown) => void;

  private waker?: LightWaker;
  private readonly listeners = new Set<(event: PiEvent) => void>();
  private readonly completions = new Map<string, Completion>();
  private readonly handles = new Map<string, HeavyRunHandle>();
  /** E4 — lots de résultats en attente de livraison, PAR session légère. */
  private readonly reportBatches = new Map<
    string,
    { records: JobRecord[]; timer: unknown }
  >();

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
    this.resultBatchWindowMs = Math.max(
      0,
      options.resultBatchWindowMs ?? DEFAULT_RESULT_BATCH_WINDOW_MS,
    );
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn =
      options.clearTimeoutFn ??
      ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
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

  /** Résout la deadline par défaut (valeur figée ou fournisseur à chaud). */
  private resolveDefaultDeadline(): number {
    return typeof this.defaultDeadlineMs === "function"
      ? this.defaultDeadlineMs()
      : this.defaultDeadlineMs;
  }

  async delegate(request: DelegateRequest): Promise<DelegateOutcome> {
    const sessionId = request.lightSessionId;
    const runId = request.parentRunId ?? "";
    const deadlineMs = clampDeadline(
      request.deadlineMs ?? this.resolveDefaultDeadline(),
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

    // ⚠️ E4 — DÉFAUT NON BLOQUANT : la tâche de fond rend la main IMMÉDIATEMENT
    // (ticket honnête, AUCUNE attente). Le résultat sera réinjecté plus tard.
    const background = request.background !== false;
    if (background) {
      if (admission.admission === "start") {
        this.startJob(jobId);
      } else {
        this.logger.info("delegation.queued", {
          job_id: jobId,
          position: admission.position,
        });
      }
      this.emitPhase(PHASE.delegateDispatched, sessionId, runId, jobId, t0);
      const record = this.store.get(jobId);
      return this.dispatchedOutcome(record?.id ?? jobId);
    }

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

  /**
   * E5 — VÉRITÉ DE COMPLÉTION (lue dans le `JobStore`, jamais dans le texte du
   * modèle) : `true` s'il reste du travail NON achevé pour cette session — au
   * moins un job NON terminal, OU un job terminé dont le lot de résultats n'a
   * pas encore été livré.
   */
  hasPendingWork(sessionId: string): boolean {
    for (const record of this.store.list()) {
      if (record.lightSessionId === sessionId && !isTerminal(record.status)) {
        return true;
      }
    }
    const batch = this.reportBatches.get(sessionId);
    return batch !== undefined && batch.records.length > 0;
  }

  /**
   * E4 — Force la livraison IMMÉDIATE des lots en attente (arrêt propre, tests).
   * Idempotent.
   */
  flushPendingReports(): void {
    for (const batch of this.reportBatches.values()) {
      if (batch.timer !== null) {
        this.clearTimeoutFn(batch.timer);
        batch.timer = null;
      }
    }
    for (const sessionId of [...this.reportBatches.keys()]) {
      this.flushReportBatch(sessionId);
    }
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

  /**
   * E3 — étape d'ACTIVITÉ d'un sous-agent : trame ÉPHÉMÈRE (jamais un message),
   * rattachée à la session LÉGÈRE propriétaire. Le transport la route en trame
   * de CONTRÔLE et ne la remet JAMAIS au moteur TTS.
   */
  private emitJobActivity(
    sessionId: string,
    jobId: string,
    stage: string,
    extra: { task?: string; detail?: string; status?: PiJobTerminalStatus } = {},
  ): void {
    this.emitEvent({
      type: "job_activity",
      sessionId,
      jobId,
      stage,
      ...(extra.task !== undefined ? { task: extra.task } : {}),
      ...(extra.detail !== undefined ? { detail: extra.detail } : {}),
      ...(extra.status !== undefined ? { status: extra.status } : {}),
      at: new Date(this.now()).toISOString(),
    });
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
    this.emitJobActivity(record.lightSessionId, jobId, PHASE.jobStarted, {
      task: record.task,
    });

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
        this.emitJobActivity(record.lightSessionId, jobId, PHASE.jobFirstToken);
      },
      onProgress: (partial: string) => {
        this.store.append(jobId, "progress", { result: { partial } });
        this.emitJobActivity(record.lightSessionId, jobId, PHASE.jobProgress, {
          detail: excerptForActivity(partial),
        });
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
    this.emitJobActivity(record.lightSessionId, jobId, PHASE.jobFinished, {
      status: result.status,
    });

    if (status === "completed" || status === "failed") {
      this.enqueueReport(jobId);
    }
  }

  /**
   * E4 — Met un job terminé en LOT pour sa session. La fenêtre est ARMÉE une
   * seule fois (par le PREMIER résultat) et NON repoussée : un lot = UN SEUL
   * tour. Les jobs d'une même session sont regroupés ; deux sessions distinctes
   * ont chacune leur propre lot.
   */
  private enqueueReport(jobId: string): void {
    const record = this.store.get(jobId);
    if (!record) return;
    const sessionId = record.lightSessionId;
    let batch = this.reportBatches.get(sessionId);
    if (!batch) {
      batch = { records: [], timer: null };
      this.reportBatches.set(sessionId, batch);
    }
    if (!batch.records.some((item) => item.id === jobId)) {
      batch.records.push(record);
    }
    if (batch.timer === null) {
      batch.timer = this.setTimeoutFn(() => {
        const current = this.reportBatches.get(sessionId);
        if (current) current.timer = null;
        this.flushReportBatch(sessionId);
      }, this.resultBatchWindowMs);
      (batch.timer as { unref?: () => void } | null)?.unref?.();
    }
  }

  /**
   * E4 — Livre UN lot : UN SEUL `waker.send` (donc UN SEUL tour), marque chaque
   * job du lot comme `notified` et émet les trames de corrélation.
   */
  private flushReportBatch(sessionId: string): void {
    const batch = this.reportBatches.get(sessionId);
    if (!batch) return;
    this.reportBatches.delete(sessionId);
    const records = batch.records;
    if (records.length === 0) return;
    const head = records[0] as JobRecord;
    this.emitPhase(
      PHASE.reportRequested,
      sessionId,
      head.parentRunId ?? "",
      head.id,
      this.now(),
    );

    let runId: string | undefined;
    if (this.waker) {
      try {
        const handle = this.waker.send(
          sessionId,
          buildBatchReportPrompt(records),
          { origin: ORIGIN_JOB_REPORT, jobId: head.id },
        );
        if (handle && typeof handle.runId === "string") runId = handle.runId;
      } catch (error) {
        this.logger.warn("delegation.report.failed", {
          job_id: head.id,
          error: sanitizeErrorText(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
    }

    for (const record of records) {
      this.store.append(record.id, "notified", {
        notified: true,
        reportedAt: new Date(this.now()).toISOString(),
      });
      this.emitEvent({
        type: "job_report",
        sessionId,
        jobId: record.id,
        ...(runId ? { runId } : {}),
      });
    }
    this.emitPhase(
      PHASE.reportEmitted,
      sessionId,
      head.parentRunId ?? "",
      head.id,
      this.now(),
    );

    // Réservé Lot 10 (canal de notification sortant) : non implémenté.
    if (this.reporter) {
      for (const record of records) {
        void Promise.resolve(this.reporter.report(record)).catch((error: unknown) => {
          this.logger.warn("delegation.reporter.failed", {
            job_id: record.id,
            error: sanitizeErrorText(
              error instanceof Error ? error.message : String(error),
            ),
          });
        });
      }
    }
  }

  /**
   * E4 — Ticket d'ACCUSÉ DE LANCEMENT (jamais un résultat).
   */
  private dispatchedOutcome(jobId: string): DelegateDispatched {
    return { status: "dispatched", job_id: jobId, note: DISPATCH_NOTE };
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
