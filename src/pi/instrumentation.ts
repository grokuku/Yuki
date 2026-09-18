/**
 * Instrumentation par étage de latence.
 *
 * Un `stage` est une chaîne OUVRTE : les lots suivants (audio, ex. `asr_start`,
 * `tts_first_byte`) s'insèrent sans refonte, avec la même forme d'événement et
 * la même corrélation `session_id` puis `run_id`.
 *
 * Chaque étage produit un événement `phase` (diffusé aux clients) ET une ligne
 * JSON-lines `pi.phase`. La synthèse produit un `run_summary` et une ligne
 * `pi.run_summary`.
 */

import type {
  PiEvent,
  PiLogger,
  PiUsage,
  RunFinishReason,
} from "./types.js";

/** Étages connus (la liste n'est pas fermée — chaîne OUVERTE). */
export const PHASE = {
  // Lot 1 — noyau texte
  sendReceived: "send_received",
  promptAccepted: "prompt_accepted",
  runStarted: "run_started",
  firstToken: "first_token",
  turnEnd: "turn_end",
  runFinished: "run_finished",
  abort: "abort",
  error: "error",
  // Lot 2 — délégation
  delegateReceived: "delegate_received",
  delegateInlineWait: "delegate_inline_wait",
  delegateReturnedInline: "delegate_returned_inline",
  delegateReturnedPending: "delegate_returned_pending",
  jobEnqueued: "job_enqueued",
  jobStarted: "job_started",
  jobFirstToken: "job_first_token",
  jobFinished: "job_finished",
  jobInterrupted: "job_interrupted",
  reportRequested: "report_requested",
  reportEmitted: "report_emitted",
} as const;

/** Construit un événement `phase` (chaîne ouverte, corrélation `jobId` optionnelle). */
export function phaseEvent(params: {
  sessionId: string;
  runId: string;
  stage: string;
  jobId?: string;
  at?: number;
  t0?: number;
}): PiEvent {
  const at = params.at ?? Date.now();
  const sinceT0Ms = Math.max(0, at - (params.t0 ?? at));
  return {
    type: "phase",
    sessionId: params.sessionId,
    runId: params.runId,
    stage: params.stage,
    at: new Date(at).toISOString(),
    sinceT0Ms,
    ...(params.jobId ? { jobId: params.jobId } : {}),
  };
}

export interface RunSummary {
  ttftMs?: number;
  totalMs: number;
  tokensIn?: number;
  tokensOut?: number;
}

export interface RunInstrumentationParams {
  runId: string;
  sessionId: string;
  /** t0 = réception serveur du message. */
  t0: number;
  emit: (event: PiEvent) => void;
  logger: PiLogger;
  now?: () => number;
}

/**
 * Chronomètre d'un run : enregistre les étages, le premier token (TTFT) et la
 * consommation, puis produit la synthèse.
 */
export class RunInstrumentation {
  private readonly runId: string;
  private readonly sessionId: string;
  private readonly t0: number;
  private readonly emit: (event: PiEvent) => void;
  private readonly logger: PiLogger;
  private readonly now: () => number;

  private firstTokenAt: number | undefined;
  private usage: PiUsage | undefined;
  private completed = false;

  constructor(params: RunInstrumentationParams) {
    this.runId = params.runId;
    this.sessionId = params.sessionId;
    this.t0 = params.t0;
    this.emit = params.emit;
    this.logger = params.logger;
    this.now = params.now ?? Date.now;
  }

  /** Marque et émet un étage. Idempotent par étage (le premier gagne). */
  markStage(stage: string, options: { jobId?: string } = {}): void {
    const at = this.now();
    const sinceT0Ms = Math.max(0, at - this.t0);
    this.emit({
      type: "phase",
      sessionId: this.sessionId,
      runId: this.runId,
      stage,
      at: new Date(at).toISOString(),
      sinceT0Ms,
      ...(options.jobId ? { jobId: options.jobId } : {}),
    });
    this.logger.info("pi.phase", {
      session_id: this.sessionId,
      run_id: this.runId,
      ...(options.jobId ? { job_id: options.jobId } : {}),
      stage,
      at: new Date(at).toISOString(),
      since_t0_ms: sinceT0Ms,
    });
  }

  /** Marque le premier token streamé (TTFT). */
  markFirstToken(): void {
    if (this.firstTokenAt !== undefined) return;
    this.firstTokenAt = this.now();
    this.markStage(PHASE.firstToken);
  }

  setUsage(usage: PiUsage | undefined): void {
    if (usage) this.usage = usage;
  }

  /** Émet les étages terminaux : abort/error le cas échéant, puis run_finished. */
  complete(reason: RunFinishReason): void {
    if (this.completed) return;
    this.completed = true;
    if (reason === "abort") this.markStage(PHASE.abort);
    if (reason === "error") this.markStage(PHASE.error);
    this.markStage(PHASE.runFinished);
  }

  /** Construit la synthèse du run. */
  summarize(): RunSummary {
    const totalMs = Math.max(0, this.now() - this.t0);
    const summary: RunSummary = { totalMs };
    if (this.firstTokenAt !== undefined) {
      summary.ttftMs = Math.max(0, this.firstTokenAt - this.t0);
    }
    if (this.usage) {
      summary.tokensIn = this.usage.input;
      summary.tokensOut = this.usage.output;
    }
    return summary;
  }

  /** Émet `run_summary` et journalise la synthèse. */
  emitSummary(): RunSummary {
    const summary = this.summarize();
    this.emit({
      type: "run_summary",
      sessionId: this.sessionId,
      runId: this.runId,
      ...(summary.ttftMs !== undefined ? { ttftMs: summary.ttftMs } : {}),
      totalMs: summary.totalMs,
      ...(summary.tokensIn !== undefined ? { tokensIn: summary.tokensIn } : {}),
      ...(summary.tokensOut !== undefined ? { tokensOut: summary.tokensOut } : {}),
    });
    this.logger.info("pi.run_summary", {
      session_id: this.sessionId,
      run_id: this.runId,
      ttft_ms: summary.ttftMs,
      total_ms: summary.totalMs,
      usage_in: summary.tokensIn,
      usage_out: summary.tokensOut,
    });
    return summary;
  }
}
