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
import { isSyntheticOrigin } from "../../src/pi/synthetic.js";
import { PiHostError } from "../../src/pi/errors.js";
import { PHASE, RunInstrumentation, type RunTtsMetrics } from "../../src/pi/instrumentation.js";
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
  /** Origine du tour (report synthétique, résultat de commande validée…). */
  origin?: string;
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
  /** Sessions SUPPLÉMENTAIRES connues (bascule multi-fils), sans SDK. */
  sessions?: FakeSessionSeed[];
}

/** Session pré-remplie d'un double de host (id + fichier + titre + transcript). */
export interface FakeSessionSeed {
  id: string;
  file?: string;
  title?: string;
  transcript?: TranscriptEntry[];
}

interface FakeKnownSession {
  id: string;
  file: string;
  title?: string;
  transcript: TranscriptEntry[];
}

export class FakePiHost implements PiHost {
  private readonly listeners = new Set<PiEventListener>();
  private readonly sessionListeners = new Map<string, Set<PiEventListener>>();
  private readonly scripts: FakeScript[];
  private readonly logger: PiLogger;
  private readonly latencyScale: number;
  private readonly knownSessions: FakeKnownSession[];
  private readonly titles = new Map<string, string>();
  private readonly setAsideIds = new Set<string>();

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
    this.knownSessions = (options.sessions ?? []).map((seed) => ({
      id: seed.id,
      file: seed.file ?? `/fake/${seed.id}.jsonl`,
      ...(seed.title ? { title: seed.title } : {}),
      transcript: (seed.transcript ?? []).map((entry) => ({ ...entry })),
    }));
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

  async resume(sessionFile: string): Promise<SessionState> {
    const known = this.knownSessions.find((session) => session.file === sessionFile);
    if (!known) return this.newSession();
    this.sessionId = known.id;
    this.transcript = known.transcript.map((entry) => ({ ...entry }));
    this.partial = "";
    this.state = "idle";
    this.activeRunId = undefined;
    this.emit({ type: "state", sessionId: this.sessionId, state: "idle" });
    return this.buildState();
  }

  send(sessionId: string, text: string, opts?: SendOptions): RunHandle {
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
      ...(opts?.origin !== undefined ? { origin: opts.origin } : {}),
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

  recordRunStage(sessionId: string, runId: string, stage: string): void {
    void sessionId;
    const run = this.currentRun;
    if (run && run.runId === runId) run.instrumentation.markStage(stage);
  }

  recordRunTtsMetrics(
    sessionId: string,
    runId: string,
    metrics: RunTtsMetrics,
  ): void {
    void sessionId;
    const run = this.currentRun;
    if (run && run.runId === runId) run.instrumentation.recordTtsMetrics(metrics);
  }

  getState(sessionId?: string): SessionState | undefined {
    void sessionId;
    return this.buildState();
  }

  async listSessions(): Promise<SessionInfo[]> {
    const summaries: SessionInfo[] = this.knownSessions
      .filter((session) => !this.setAsideIds.has(session.id))
      .map((session) => this.summaryFor(session.id, session.file, session.transcript));
    if (!summaries.some((info) => info.sessionId === this.sessionId)) {
      summaries.unshift(
        this.summaryFor(this.sessionId, `/fake/${this.sessionId}.jsonl`, this.transcript),
      );
    }
    return summaries;
  }

  async renameSession(id: string, title: string): Promise<void> {
    const normalized = title.replace(/\s+/g, " ").trim();
    if (normalized.length > 0) {
      const needle = normalized.toLowerCase();
      const clash = (await this.listSessions()).find(
        (info) =>
          info.sessionId !== id &&
          (info.title ?? "").toLowerCase() === needle,
      );
      if (clash) {
        throw new PiHostError(
          "PI_SESSION_ERROR",
          `Le titre « ${normalized} » est déjà utilisé par une autre conversation.`,
          { sessionId: id },
        );
      }
    }
    this.titles.set(id, normalized);
  }

  async setAsideSession(id: string): Promise<void> {
    this.setAsideIds.add(id);
    const index = this.knownSessions.findIndex((session) => session.id === id);
    if (index >= 0) this.knownSessions.splice(index, 1);
    if (this.sessionId === id) {
      await this.newSession();
    }
  }

  async sessionFileFor(id: string): Promise<string | undefined> {
    if (this.sessionId === id) return `/fake/${id}.jsonl`;
    return this.knownSessions.find((session) => session.id === id)?.file;
  }

  private summaryFor(
    id: string,
    file: string,
    transcript: TranscriptEntry[],
  ): SessionInfo {
    const explicit = this.titles.get(id);
    const seed = this.knownSessions.find((session) => session.id === id)?.title;
    const firstUser = transcript.find((entry) => entry.role === "user")?.text;
    return {
      sessionId: id,
      sessionFile: file,
      ...(explicit || seed ? { name: explicit ?? seed } : {}),
      title: explicit ?? seed ?? "Conversation sans titre",
      messageCount: transcript.length,
      ...(firstUser ? { firstMessage: firstUser } : {}),
    };
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
    // ⚠️ Miroir du host réel : un prompt SYNTHÉTIQUE (report de job, résultat
    // de commande validée) n'ajoute PAS de bulle utilisateur au transcript et
    // ne diffuse PAS son texte dans `run_started`.
    const synthetic = isSyntheticOrigin(run.origin);
    if (!synthetic) {
      this.transcript.push({ role: "user", text: run.text });
    }
    this.setState("streaming", run.runId);

    run.instrumentation.markStage(PHASE.sendReceived);
    run.instrumentation.markStage(PHASE.promptAccepted);
    run.instrumentation.markStage(PHASE.runStarted);
    this.emit({
      type: "run_started",
      sessionId: this.sessionId,
      runId: run.runId,
      ...(synthetic ? {} : { userText: run.text }),
      ...(run.origin !== undefined ? { origin: run.origin } : {}),
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
    run.instrumentation.complete(
      reason,
      reason === "error" && run.errorMessage
        ? { error: run.errorMessage }
        : {},
    );
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
