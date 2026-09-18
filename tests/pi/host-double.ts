/**
 * `FakePiHost` — double déterministe du PiHost, sans SDK.
 *
 * Rejoue des scripts d'événements (`tests/fixtures/pi/*.json`) avec une latence
 * simulée, un abort programmable et une file FIFO. Sert de socle aux tests de
 * transport, de rejeu `seq`, d'abort/concurrence et d'UI.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import type { PiHost } from "../../src/pi/host.js";
import { PHASE, RunInstrumentation } from "../../src/pi/instrumentation.js";
import type {
  EnsureSessionOptions,
  PiEvent,
  PiEventListener,
  PiLogger,
  PiSessionStateName,
  RunHandle,
  SendOptions,
  SessionInfo,
  SessionState,
  TranscriptEntry,
} from "../../src/pi/types.js";

export interface FakeDeltaStep {
  kind: "delta";
  channel: "content" | "thinking";
  text: string;
  delayMs?: number;
}

export interface FakeErrorStep {
  kind: "error";
  message: string;
  delayMs?: number;
}

export type FakeStep = FakeDeltaStep | FakeErrorStep;

export interface FakeScript {
  name?: string;
  steps: FakeStep[];
}

export function loadScript(path: string): FakeScript {
  return JSON.parse(readFileSync(path, "utf8")) as FakeScript;
}

interface FakeRun {
  runId: string;
  text: string;
  script: FakeScript;
  abortController: AbortController;
  aborted: boolean;
  sawError: boolean;
  errorMessage?: string;
  instrumentation: RunInstrumentation;
  done: Promise<void>;
  resolveDone: () => void;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

const noopLogger: PiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface FakePiHostOptions {
  sessionId?: string;
  scripts?: FakeScript[];
  logger?: PiLogger;
  /** Multiplicateur des délais de script (0 = instantané). */
  latencyScale?: number;
}

export class FakePiHost implements PiHost {
  private readonly listeners = new Set<PiEventListener>();
  private readonly sessionListeners = new Map<string, Set<PiEventListener>>();
  private readonly scripts: FakeScript[];
  private readonly logger: PiLogger;
  private readonly latencyScale: number;

  private sessionId: string;
  private ready = false;
  private state: PiSessionStateName = "idle";
  private activeRunId?: string;
  private transcript: TranscriptEntry[] = [];
  private partial = "";
  private currentRun?: FakeRun;
  private queue: Array<{ text: string; run: FakeRun }> = [];

  constructor(options: FakePiHostOptions = {}) {
    this.sessionId = options.sessionId ?? "fake-session";
    this.scripts = options.scripts ?? [];
    this.logger = options.logger ?? noopLogger;
    this.latencyScale = options.latencyScale ?? 1;
  }

  /** Ajoute un script à rejouer au prochain `send`. */
  pushScript(script: FakeScript): void {
    this.scripts.push(script);
  }

  async start(): Promise<void> {
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  currentSessionId(): string | undefined {
    return this.sessionId;
  }

  async ensureSession(target?: EnsureSessionOptions): Promise<SessionState> {
    if (target?.sessionFile || target?.new) {
      return this.newSession();
    }
    return this.buildState();
  }

  async newSession(): Promise<SessionState> {
    this.sessionId = randomUUID();
    this.transcript = [];
    this.partial = "";
    this.state = "idle";
    this.activeRunId = undefined;
    this.emit({ type: "state", sessionId: this.sessionId, state: "idle" });
    return this.buildState();
  }

  async continueRecent(): Promise<SessionState> {
    return this.buildState();
  }

  async resume(): Promise<SessionState> {
    return this.newSession();
  }

  send(sessionId: string, text: string, _opts?: SendOptions): RunHandle {
    if (!this.ready) {
      throw new Error("PI_NOT_READY");
    }
    void sessionId;
    const runId = randomUUID();
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const script = this.scripts.shift() ?? { steps: [] };
    const run: FakeRun = {
      runId,
      text,
      script,
      abortController: new AbortController(),
      aborted: false,
      sawError: false,
      instrumentation: new RunInstrumentation({
        runId,
        sessionId: this.sessionId,
        t0: Date.now(),
        emit: (event) => this.emit(event),
        logger: this.logger,
      }),
      done,
      resolveDone,
    };

    if (this.currentRun) {
      this.queue.push({ text, run });
      return { runId, sessionId: this.sessionId, queued: true };
    }
    void this.run(run);
    return { runId, sessionId: this.sessionId, queued: false };
  }

  async abort(sessionId: string, runId?: string): Promise<void> {
    void sessionId;
    const cleared = this.queue.splice(0);
    for (const queued of cleared) {
      queued.run.instrumentation.complete("abort");
      this.emit({
        type: "run_finished",
        sessionId: this.sessionId,
        runId: queued.run.runId,
        reason: "abort",
      });
      queued.run.instrumentation.emitSummary();
      queued.run.resolveDone();
    }
    const run = this.currentRun;
    if (!run) return;
    if (runId && run.runId !== runId) return;
    run.aborted = true;
    run.abortController.abort();
    await run.done;
  }

  subscribe(sessionId: string, listener: PiEventListener): () => void {
    void sessionId;
    let set = this.sessionListeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionListeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  subscribeAll(listener: PiEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(sessionId?: string): SessionState | undefined {
    void sessionId;
    return this.buildState();
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [
      {
        sessionId: this.sessionId,
        sessionFile: `/fake/${this.sessionId}.jsonl`,
        messageCount: this.transcript.length,
      },
    ];
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.currentRun?.abortController.abort();
    this.listeners.clear();
    this.sessionListeners.clear();
  }

  // --- interne ---------------------------------------------------------------

  private buildState(): SessionState {
    const transcript = this.transcript.map((entry) => ({ ...entry }));
    if (this.partial.length > 0) {
      transcript.push({ role: "assistant", text: this.partial });
    }
    return {
      sessionId: this.sessionId,
      state: this.state,
      ...(this.activeRunId ? { activeRunId: this.activeRunId } : {}),
      transcript,
    };
  }

  private emit(event: PiEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
    const set = this.sessionListeners.get(event.sessionId);
    if (set) {
      for (const listener of set) listener(event);
    }
  }

  private setState(state: PiSessionStateName, activeRunId?: string): void {
    this.state = state;
    this.activeRunId = activeRunId;
    this.emit({
      type: "state",
      sessionId: this.sessionId,
      state,
      ...(activeRunId ? { activeRunId } : {}),
    });
  }

  private async run(run: FakeRun): Promise<void> {
    this.currentRun = run;
    this.partial = "";
    this.transcript.push({ role: "user", text: run.text });
    this.setState("streaming", run.runId);

    run.instrumentation.markStage(PHASE.sendReceived);
    run.instrumentation.markStage(PHASE.promptAccepted);
    run.instrumentation.markStage(PHASE.runStarted);
    this.emit({
      type: "run_started",
      sessionId: this.sessionId,
      runId: run.runId,
      userText: run.text,
    });

    let contentText = "";
    for (const step of run.script.steps) {
      if (run.aborted) break;
      await sleep((step.delayMs ?? 1) * this.latencyScale, run.abortController.signal);
      if (run.aborted) break;
      if (step.kind === "error") {
        run.sawError = true;
        run.errorMessage = step.message;
        break;
      }
      run.instrumentation.markFirstToken();
      if (step.channel === "content") {
        contentText += step.text;
        this.partial += step.text;
      }
      this.emit({
        type: "delta",
        sessionId: this.sessionId,
        runId: run.runId,
        channel: step.channel,
        text: step.text,
      });
    }

    run.instrumentation.markStage(PHASE.turnEnd);
    const reason = run.aborted
      ? "abort"
      : run.sawError
        ? "error"
        : "done";
    run.instrumentation.setUsage({ input: 12, output: contentText.length });
    if (contentText.length > 0) {
      this.transcript.push({ role: "assistant", text: contentText });
    }
    this.partial = "";
    run.instrumentation.complete(reason);
    this.emit({
      type: "run_finished",
      sessionId: this.sessionId,
      runId: run.runId,
      reason,
      usage: { input: 12, output: contentText.length },
      ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
    });
    run.instrumentation.emitSummary();

    this.currentRun = undefined;
    this.setState(reason === "error" ? "error" : "idle");
    run.resolveDone();

    const next = this.queue.shift();
    if (next) {
      void this.run(next.run);
    }
  }
}
