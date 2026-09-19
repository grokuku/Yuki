/**
 * Implémentation v1 de `PiHost`, in-process sur le SDK Pi embarqué.
 *
 * ⚠️ SEUL fichier racine de `src/` autorisé à importer `@earendil-works/...`
 * (avec `src/pi/sdk/**`). Un test de frontière échoue sinon.
 *
 * Le host encapsule le SDK : aucun objet ni type du SDK ne franchit cette
 * frontière. Tout sort par des événements sérialisables ou des méthodes
 * asynchrones renvoyant du JSON.
 *
 * Lot 2 : la politique d'outils et les outils custom sont INJECTÉS (plus de
 * `noTools: "all"`), le runtime de modèles est partagé, et les événements de
 * délégation sont relayés sur le bus de la façade.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  applyPiEnvironment,
  ensurePiLayout,
  resolvePiPaths,
  seedSettingsFile,
  writeModelsFile,
  type PiPaths,
} from "./config.js";
import {
  channelForAssistantEvent,
  contentTextFromMessage,
  deltaText,
  finishReasonForMessage,
  usageFromMessage,
  type RawAgentMessage,
  type RawAssistantMessageEvent,
} from "./events.js";
import { PiHostError, toPiHostError } from "./errors.js";
import type { PiHost } from "./host.js";
import { PHASE, RunInstrumentation } from "./instrumentation.js";
import { createDelegateTools, createRunContextTracker } from "./sdk/delegate-tools.js";
import {
  getSharedModelRuntime,
  resolveSdkModel,
  resolveSdkThinking,
  type SdkModel,
} from "./sdk/model-runtime.js";
import { createLightRuntime } from "./sdk/session-factory.js";
import type {
  PiEvent,
  PiEventListener,
  PiHostOptions,
  PiSessionStateName,
  PiThinkingLevel,
  PiUsage,
  RunFinishReason,
  RunHandle,
  SendOptions,
  SessionInfo,
  SessionState,
  TranscriptEntry,
} from "./types.js";

/** Bornes de sérialisation de l'abort derrière l'envoi en vol. */
const ABORT_SERIALIZE_TIMEOUT_MS = 2_000;

/** Origine d'un prompt synthétique de report (pas de bulle utilisateur). */
const ORIGIN_JOB_REPORT = "job_report";

interface RunItem {
  runId: string;
  text: string;
  origin?: string;
  jobId?: string;
  instrumentation: RunInstrumentation;
  abortController: AbortController;
  abortRequested: boolean;
  agentStarted: boolean;
  emittedRunStarted: boolean;
  sawError: boolean;
  sawAbort: boolean;
  errorMessage?: string;
  usage?: PiUsage;
  resolveStart?: () => void;
  startPromise: Promise<void>;
}

interface SessionRecord {
  sessionId: string;
  session: AgentSession;
  unsubscribe: () => void;
  state: PiSessionStateName;
  activeRunId?: string;
  transcript: TranscriptEntry[];
  partial: string;
  listeners: Set<PiEventListener>;
  queue: RunItem[];
  currentRun?: RunItem;
}

function newRunId(): string {
  return randomUUID();
}

function makeRunItem(
  runId: string,
  text: string,
  sessionId: string,
  logger: PiHostOptions["logger"],
  emit: (event: PiEvent) => void,
  opts: SendOptions,
): RunItem {
  let resolveStart: (() => void) | undefined;
  const startPromise = new Promise<void>((resolve) => {
    resolveStart = resolve;
  });
  return {
    runId,
    text,
    ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
    ...(opts.jobId !== undefined ? { jobId: opts.jobId } : {}),
    abortController: new AbortController(),
    abortRequested: false,
    agentStarted: false,
    emittedRunStarted: false,
    sawError: false,
    sawAbort: false,
    startPromise,
    resolveStart,
    instrumentation: new RunInstrumentation({
      runId,
      sessionId,
      t0: Date.now(),
      emit,
      logger,
    }),
  };
}

/**
 * Fabrique le host embarqué à partir du SDK Pi.
 */
export function createSdkPiHost(options: PiHostOptions): PiHost {
  const logger = options.logger;
  const llmAvailable =
    typeof options.llmAvailable === "function"
      ? options.llmAvailable
      : () => options.llmAvailable ?? true;
  const paths: PiPaths = resolvePiPaths({
    agentDir: options.agentDir,
    cwd: options.cwd,
    home: options.home ?? join(options.agentDir, "..", "home"),
    ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}),
    ...(options.settingsSeedPath
      ? { settingsSeedPath: options.settingsSeedPath }
      : {}),
  });

  const sessions = new Map<string, SessionRecord>();
  const globalListeners = new Set<PiEventListener>();
  const runContext = createRunContextTracker();

  let runtime: AgentSessionRuntime | undefined;
  let settingsManager: SettingsManager | undefined;
  let modelRuntime: Awaited<ReturnType<typeof getSharedModelRuntime>> | undefined;
  let resolvedModel: SdkModel | undefined;
  let resolvedThinking: PiThinkingLevel | undefined;
  let currentRecord: SessionRecord | undefined;
  let ready = false;
  let startPromise: Promise<void> | undefined;
  let restoreEnv: (() => void) | undefined;
  let unsubscribeExternal: (() => void) | undefined;

  function emitEvent(event: PiEvent): void {
    for (const listener of globalListeners) {
      safeCall(listener, event);
    }
    const record = sessions.get(event.sessionId);
    if (record) {
      for (const listener of record.listeners) {
        safeCall(listener, event);
      }
    }
  }

  function safeCall(listener: PiEventListener, event: PiEvent): void {
    try {
      listener(event);
    } catch (error) {
      logger.warn("pi.listener.error", {
        session_id: event.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function resolveStart(run: RunItem): void {
    run.resolveStart?.();
    run.resolveStart = undefined;
  }

  function currentState(record: SessionRecord): PiSessionStateName {
    return record.state;
  }

  function buildState(record: SessionRecord): SessionState {
    const transcript: TranscriptEntry[] = record.transcript.map((entry) => ({
      role: entry.role,
      text: entry.text,
    }));
    if (record.partial.length > 0) {
      transcript.push({ role: "assistant", text: record.partial });
    }
    return {
      sessionId: record.sessionId,
      state: currentState(record),
      ...(record.activeRunId ? { activeRunId: record.activeRunId } : {}),
      transcript,
    };
  }

  function handleSdkEvent(record: SessionRecord, raw: unknown): void {
    const event = raw as { type?: unknown };
    switch (event.type) {
      case "agent_start": {
        const run = record.currentRun;
        if (!run) return;
        run.agentStarted = true;
        resolveStart(run);
        if (!run.emittedRunStarted) {
          run.emittedRunStarted = true;
          run.instrumentation.markStage(PHASE.runStarted);
          emitEvent({
            type: "run_started",
            sessionId: record.sessionId,
            runId: run.runId,
            userText: run.text,
            ...(run.origin !== undefined ? { origin: run.origin } : {}),
            ...(run.jobId !== undefined ? { jobId: run.jobId } : {}),
          });
        }
        // Abort demandé avant que le run ne démarre réellement.
        if (run.abortRequested) {
          void record.session.abort().catch(() => undefined);
        }
        return;
      }
      case "message_start":
        return;
      case "message_update": {
        const run = record.currentRun;
        if (!run) return;
        const assistantEvent = (raw as {
          assistantMessageEvent?: RawAssistantMessageEvent;
        }).assistantMessageEvent;
        if (!assistantEvent) return;
        const channel = channelForAssistantEvent(assistantEvent);
        if (!channel) return;
        const text = deltaText(assistantEvent);
        if (text.length === 0) return;
        run.instrumentation.markFirstToken();
        if (channel === "content") {
          record.partial += text;
        }
        emitEvent({
          type: "delta",
          sessionId: record.sessionId,
          runId: run.runId,
          channel,
          text,
        });
        return;
      }
      case "turn_end": {
        const run = record.currentRun;
        if (!run) return;
        run.instrumentation.markStage(PHASE.turnEnd);
        const message = (raw as { message?: RawAgentMessage }).message;
        if (message) {
          const usage = usageFromMessage(message);
          if (usage) {
            run.usage = usage;
            run.instrumentation.setUsage(usage);
          }
        }
        return;
      }
      case "message_end": {
        const run = record.currentRun;
        const message = (raw as { message?: RawAgentMessage }).message;
        if (!run || !message || message.role !== "assistant") return;
        const finishReason = finishReasonForMessage(message);
        if (finishReason === "error") run.sawError = true;
        if (finishReason === "abort") run.sawAbort = true;
        const usage = usageFromMessage(message);
        if (usage) {
          run.usage = usage;
          run.instrumentation.setUsage(usage);
        }
        // Transcript = CONTENU SEUL : les blocs `thinking` sont exclus.
        const content = contentTextFromMessage(message);
        const text = content.length > 0 ? content : record.partial;
        if (text.length > 0) {
          record.transcript.push({ role: "assistant", text });
        }
        record.partial = "";
        return;
      }
      default:
        return;
    }
  }

  function attachRecord(session: AgentSession): SessionRecord {
    const record: SessionRecord = {
      sessionId: session.sessionId,
      session,
      unsubscribe: () => undefined,
      state: "idle",
      transcript: [],
      partial: "",
      listeners: new Set(),
      queue: [],
    };
    record.unsubscribe = session.subscribe((event) => {
      handleSdkEvent(record, event);
    });
    sessions.set(record.sessionId, record);
    return record;
  }

  function detachRecord(record: SessionRecord): void {
    try {
      record.unsubscribe();
    } catch {
      // ignore
    }
    sessions.delete(record.sessionId);
  }

  function finalizeRun(
    record: SessionRecord,
    run: RunItem,
    reason: RunFinishReason,
  ): void {
    run.instrumentation.setUsage(run.usage);
    run.instrumentation.complete(reason);
    emitEvent({
      type: "run_finished",
      sessionId: record.sessionId,
      runId: run.runId,
      reason,
      ...(run.usage ? { usage: run.usage } : {}),
      ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
    });
    run.instrumentation.emitSummary();

    record.currentRun = undefined;
    record.activeRunId = undefined;
    record.partial = "";
    record.state = reason === "error" ? "error" : "idle";
    runContext.clear(record.sessionId);
    emitEvent({
      type: "state",
      sessionId: record.sessionId,
      state: record.state,
    });

    const next = record.queue.shift();
    if (next) {
      void startRun(record, next);
    }
  }

  async function startRun(record: SessionRecord, run: RunItem): Promise<void> {
    record.currentRun = run;
    record.activeRunId = run.runId;
    record.state = "streaming";
    // Un prompt de report est SYNTHÉTIQUE : il ne doit pas produire de bulle
    // utilisateur dans le transcript de l'UI.
    if (run.origin !== ORIGIN_JOB_REPORT) {
      record.transcript.push({ role: "user", text: run.text });
    }
    runContext.set({ sessionId: record.sessionId, runId: run.runId });
    emitEvent({
      type: "state",
      sessionId: record.sessionId,
      state: "streaming",
      activeRunId: run.runId,
    });

    try {
      await record.session.prompt(run.text, {
        expandPromptTemplates: false,
        preflightResult: (accepted: boolean) => {
          if (accepted) {
            run.instrumentation.markStage(PHASE.promptAccepted);
          }
        },
      });
    } catch (error) {
      const piError = toPiHostError(error, {
        runId: run.runId,
        sessionId: record.sessionId,
        logger,
      });
      // Un prompt qui rejette À CAUSE d'un abort doit être normalisé en
      // `run_finished(reason:"abort")`, jamais en erreur (spec Lot 1).
      if (run.abortRequested || piError.code === "PI_ABORTED") {
        logger.debug("pi.prompt.aborted", {
          session_id: record.sessionId,
          run_id: run.runId,
        });
        run.sawAbort = true;
        finalizeRun(record, run, "abort");
        return;
      }
      logger.warn("pi.prompt.rejected", {
        session_id: record.sessionId,
        run_id: run.runId,
        code: piError.code,
      });
      run.sawError = true;
      run.errorMessage = piError.message;
      finalizeRun(record, run, "error");
      return;
    }

    const reason: RunFinishReason =
      run.abortRequested || run.sawAbort
        ? "abort"
        : run.sawError
          ? "error"
          : "done";
    finalizeRun(record, run, reason);
  }

  function recordFor(sessionId?: string): SessionRecord | undefined {
    if (sessionId) {
      return sessions.get(sessionId) ?? currentRecord;
    }
    return currentRecord;
  }

  async function doStart(): Promise<void> {
    restoreEnv = applyPiEnvironment(paths);
    ensurePiLayout(paths);
    seedSettingsFile(paths, logger);
    if (options.modelsConfig !== undefined) {
      writeModelsFile(paths, options.modelsConfig, logger);
    }

    settingsManager = SettingsManager.create(paths.cwd, paths.agentDir);
    modelRuntime = await getSharedModelRuntime({
      authPath: join(paths.agentDir, "auth.json"),
      modelsPath: paths.modelsPath,
    });

    if (options.model) {
      resolvedModel = resolveSdkModel(modelRuntime, options.model);
      if (!resolvedModel) {
        logger.warn("pi.model.unresolved", { model: options.model });
      } else {
        resolvedThinking = resolveSdkThinking(modelRuntime, options.model);
      }
    }
    if (options.thinking) {
      resolvedThinking = options.thinking;
    }

    const existing = await SessionManager.list(
      paths.cwd,
      paths.sessionsDir,
    ).catch(() => []);
    const sessionManager =
      existing.length > 0
        ? SessionManager.continueRecent(paths.cwd, paths.sessionsDir)
        : SessionManager.create(paths.cwd, paths.sessionsDir);

    const customTools: ToolDefinition[] = [
      ...((options.customTools ?? []) as readonly ToolDefinition[]),
    ];
    if (options.delegation) {
      customTools.push(
        ...createDelegateTools({
          service: options.delegation,
          tracker: runContext,
        }),
      );
    }

    runtime = await createLightRuntime({
      cwd: paths.cwd,
      agentDir: paths.agentDir,
      settingsManager,
      modelRuntime,
      sessionManager,
      systemPrompt: options.systemPrompt,
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(resolvedThinking ? { thinkingLevel: resolvedThinking } : {}),
      ...(options.tools ? { tools: options.tools } : {}),
      ...(customTools.length > 0 ? { customTools } : {}),
    });

    // Abonnement posé IMMÉDIATEMENT, avant tout prompt.
    currentRecord = attachRecord(runtime.session);
    // Relaye les événements de la couche délégation sur le bus de la façade.
    unsubscribeExternal = options.eventSource?.subscribe((event) =>
      emitEvent(event),
    );
    ready = true;
    logger.info("pi.ready", {
      cwd: paths.cwd,
      agent_dir: paths.agentDir,
      sessions_dir: paths.sessionsDir,
      session_id: currentRecord.sessionId,
      model: options.model ?? null,
      tools: options.tools ? [...options.tools] : null,
      delegation: Boolean(options.delegation),
      llm_available: llmAvailable(),
    });
  }

  async function replaceSession(
    action: () => Promise<{ cancelled?: boolean }>,
  ): Promise<SessionState> {
    if (!runtime) {
      throw new PiHostError("PI_NOT_READY", "Host Pi non démarré.");
    }
    const previous = currentRecord;
    if (previous) {
      await host.abort(previous.sessionId).catch(() => undefined);
      detachRecord(previous);
      currentRecord = undefined;
    }
    try {
      const result = await action();
      if (result?.cancelled) {
        throw new PiHostError(
          "PI_SESSION_ERROR",
          "Remplacement de session annulé.",
        );
      }
    } catch (error) {
      throw toPiHostError(error, { logger });
    }
    // Ré-abonnement immédiat de la NOUVELLE session (exigé par le SDK).
    currentRecord = attachRecord(runtime.session);
    emitEvent({
      type: "state",
      sessionId: currentRecord.sessionId,
      state: "idle",
    });
    return buildState(currentRecord);
  }

  const host: PiHost = {
    async start(): Promise<void> {
      if (ready) return;
      if (startPromise) return startPromise;
      startPromise = doStart().catch((error) => {
        startPromise = undefined;
        throw toPiHostError(error, { logger });
      });
      return startPromise;
    },

    isReady(): boolean {
      return ready;
    },

    currentSessionId(): string | undefined {
      return currentRecord?.sessionId;
    },

    async ensureSession(target): Promise<SessionState> {
      if (!ready) {
        throw new PiHostError("PI_NOT_READY", "Host Pi non démarré.");
      }
      if (target?.sessionFile) {
        return replaceSession(() => runtime!.switchSession(target.sessionFile!));
      }
      if (target?.new) {
        return replaceSession(() => runtime!.newSession());
      }
      if (!currentRecord) {
        return host.continueRecent();
      }
      return buildState(currentRecord);
    },

    async newSession(): Promise<SessionState> {
      if (!ready) {
        throw new PiHostError("PI_NOT_READY", "Host Pi non démarré.");
      }
      return replaceSession(() => runtime!.newSession());
    },

    async continueRecent(): Promise<SessionState> {
      if (!ready) {
        throw new PiHostError("PI_NOT_READY", "Host Pi non démarré.");
      }
      const existing = await SessionManager.list(
        paths.cwd,
        paths.sessionsDir,
      ).catch(() => []);
      if (existing.length === 0) {
        return replaceSession(() => runtime!.newSession());
      }
      const mostRecent = existing[0];
      if (!mostRecent) {
        return replaceSession(() => runtime!.newSession());
      }
      return replaceSession(() => runtime!.switchSession(mostRecent.path));
    },

    async resume(sessionFile: string): Promise<SessionState> {
      if (!ready) {
        throw new PiHostError("PI_NOT_READY", "Host Pi non démarré.");
      }
      return replaceSession(() => runtime!.switchSession(sessionFile));
    },

    send(sessionId: string, text: string, opts?: SendOptions): RunHandle {
      if (!ready) {
        throw new PiHostError(
          "PI_NOT_READY",
          "Le host Pi n'est pas prêt : start() doit être appelé et l'abonnement posé.",
          { sessionId },
        );
      }
      if (!llmAvailable()) {
        throw new PiHostError(
          "LLM_UNAVAILABLE",
          "Aucun LLM léger configuré : la clé correspondante est absente.",
          { sessionId },
        );
      }
      const record = recordFor(sessionId);
      if (!record) {
        throw new PiHostError("PI_SESSION_ERROR", "Session inconnue.", {
          sessionId,
        });
      }
      const runId = newRunId();
      const run = makeRunItem(
        runId,
        text,
        record.sessionId,
        logger,
        emitEvent,
        opts ?? {},
      );
      run.instrumentation.markStage(PHASE.sendReceived);

      if (record.currentRun) {
        record.queue.push(run);
        return { runId, sessionId: record.sessionId, queued: true };
      }
      void startRun(record, run);
      return { runId, sessionId: record.sessionId, queued: false };
    },

    async abort(sessionId: string, runId?: string): Promise<void> {
      const record = recordFor(sessionId);
      if (!record) return;

      // Le Stop vide la file (arrêt net).
      const cleared = record.queue.splice(0);
      for (const queued of cleared) {
        queued.instrumentation.complete("abort");
        emitEvent({
          type: "run_finished",
          sessionId: record.sessionId,
          runId: queued.runId,
          reason: "abort",
        });
        queued.instrumentation.emitSummary();
      }

      const run = record.currentRun;
      if (!run) return; // abort en idle = no-op idempotent
      if (runId && run.runId !== runId) return;

      run.abortRequested = true;
      run.abortController.abort();

      // Sérialisation : on attend que le run soit réellement en vol avant
      // d'appeler l'abort du SDK, sinon l'abort serait perdu (race).
      if (!run.agentStarted) {
        await Promise.race([
          run.startPromise,
          new Promise<void>((resolve) =>
            setTimeout(resolve, ABORT_SERIALIZE_TIMEOUT_MS).unref(),
          ),
        ]);
      }
      try {
        await record.session.abort();
      } catch (error) {
        logger.warn("pi.abort.failed", {
          session_id: record.sessionId,
          run_id: run.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },

    subscribe(sessionId: string, listener: PiEventListener): () => void {
      const record = sessions.get(sessionId);
      if (!record) return () => undefined;
      record.listeners.add(listener);
      return () => {
        record.listeners.delete(listener);
      };
    },

    subscribeAll(listener: PiEventListener): () => void {
      globalListeners.add(listener);
      return () => {
        globalListeners.delete(listener);
      };
    },

    getState(sessionId?: string): SessionState | undefined {
      const record = recordFor(sessionId);
      if (!record) return undefined;
      return buildState(record);
    },

    async listSessions(): Promise<SessionInfo[]> {
      const list = await SessionManager.list(
        paths.cwd,
        paths.sessionsDir,
      ).catch(() => []);
      return list.map((info) => ({
        sessionId: info.id,
        sessionFile: info.path,
        ...(info.name ? { name: info.name } : {}),
        cwd: info.cwd,
        createdAt: info.created.toISOString(),
        updatedAt: info.modified.toISOString(),
        messageCount: info.messageCount,
        firstMessage: info.firstMessage,
      }));
    },

    async stop(): Promise<void> {
      ready = false;
      unsubscribeExternal?.();
      unsubscribeExternal = undefined;
      globalListeners.clear();
      for (const record of sessions.values()) {
        try {
          record.unsubscribe();
        } catch {
          // ignore
        }
      }
      sessions.clear();
      currentRecord = undefined;
      if (runtime) {
        try {
          await runtime.dispose();
        } catch (error) {
          logger.warn("pi.stop.failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        runtime = undefined;
      }
      restoreEnv?.();
      restoreEnv = undefined;
      startPromise = undefined;
    },
  };

  return host;
}
