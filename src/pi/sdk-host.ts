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
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, join } from "node:path";

import {
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionRuntime,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { REPORT_HEADER } from "../delegation/report.js";

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
  messageTimestamp,
  transcriptFromEntries,
  unstreamedContentSuffix,
  usageFromMessage,
  type RawAgentMessage,
  type RawAssistantMessageEvent,
} from "./events.js";
import { PiHostError, toPiHostError } from "./errors.js";
import { buildStoredUserText } from "./timestamp.js";
import type { PiHost } from "./host.js";
import { PHASE, RunInstrumentation, type RunTtsMetrics } from "./instrumentation.js";
import { createDelegateTools, createRunContextTracker } from "./sdk/delegate-tools.js";
import {
  createAgentDirectoryTools,
  createExecutionTools,
  createScreenshotTool,
} from "./sdk/execution-tools.js";
import {
  getSharedModelRuntime,
  resolveSdkModel,
  resolveSdkThinking,
  type SdkModel,
} from "./sdk/model-runtime.js";
import { createLightRuntime } from "./sdk/session-factory.js";
import { createAgentRosterExtensionFactory } from "./sdk/agent-roster-extension.js";
import { createMemoryExtensionFactory } from "./sdk/memory-extension.js";
import { createPersonalityExtensionFactory } from "./sdk/personality-extension.js";
import { createHeritageExtensionFactory } from "./sdk/heritage-extension.js";
import { createHeritageTools } from "./sdk/heritage-tools.js";
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

/**
 * Sous-dossier de MISE DE CÔTÉ d'une conversation supprimée. `SessionManager.list`
 * et `findMostRecentSession` font un `readdir` NON récursif : ce dossier est donc
 * invisible à la liste ET jamais repris au démarrage — un fil écarté ne peut pas
 * réapparaître, et reste récupérable à la main (chemin horodaté).
 */
const ASIDE_DIR = "conversations-supprimees";

/** Plafond de `listSessions()` : les N sessions les plus récentes suffisent à l'UI. */
const MAX_SESSIONS = 50;

/** Longueur maximale d'un titre dérivé des premiers mots du premier message. */
const MAX_TITLE_CHARS = 60;

/** Repli d'affichage quand aucune conversation n'a de titre exploitable. */
const UNTITLED = "Conversation sans titre";

/** Sentinelle du SDK pour un fil sans message (anglais) : jamais affichée telle quelle. */
const NO_MESSAGES = "(no messages)";

/**
 * Titre d'affichage PRÊT À L'EMPLOI (jamais vide, jamais « (no messages) ») :
 * nom natif explicite, sinon les premiers mots du premier message utilisateur,
 * sinon « Conversation sans titre ».
 */
function titleFrom(name: string | undefined, firstMessage: string | undefined): string {
  const explicit = name?.replace(/\s+/g, " ").trim();
  if (explicit) return explicit;
  const first = firstMessage?.replace(/\s+/g, " ").trim();
  if (first && first !== NO_MESSAGES) {
    return first.length <= MAX_TITLE_CHARS
      ? first
      : `${first.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
  }
  return UNTITLED;
}

/** Horodatage sûr pour un nom de dossier (`:` et `.` remplacés). */
function timestampSlug(now: Date = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

/**
 * Préfixes des prompts SYNTHÉTIQUES (prompt de report d'un job). Ils ne sont
 * jamais affichés comme messages utilisateur — ni sur le flux temps réel (via
 * `ORIGIN_JOB_REPORT`), ni à la restauration du transcript (via ce filtre).
 */
const SYNTHETIC_USER_PREFIXES: readonly string[] = [REPORT_HEADER];

interface RunItem {
  runId: string;
  /** Texte AFFICHÉ (transcript de l'UI) : sans le préfixe d'horodatage. */
  text: string;
  /** Texte réellement TRANSMIS au SDK (donc STOCKÉ) : horodaté pour un message utilisateur. */
  storedText: string;
  /** Instant de l'envoi (ms Unix) — horodate l'entrée de transcript. */
  sentAt: number;
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
  // Horodatage du message UTILISATEUR : posé AVANT stockage (le préfixe part
  // dans le prompt transmis au SDK, donc dans le JSONL de session et dans la
  // mémoire qui en dérive). Un prompt SYNTHÉTIQUE (report de job) n'est jamais
  // horodaté : ce n'est pas un message de l'utilisateur.
  const sentAt = Date.now();
  const storedText = buildStoredUserText(text, {
    at: new Date(sentAt),
    ...(opts.timezone !== undefined ? { timeZone: opts.timezone } : {}),
    ...(opts.origin === ORIGIN_JOB_REPORT ? { synthetic: true } : {}),
  });
  return {
    runId,
    text,
    storedText,
    sentAt,
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
 * Construit la liste ORDONNÉE des extensions INLINE injectées à chaque tour.
 *
 * L'ORDRE est le contrat : **personnalité (base) → mémoire → annuaire des
 * agents → heritage**. Le SDK chaîne les extensions qui renvoient
 * `systemPrompt` ; chacune CONCATÈNE au prompt courant, donc un ordre inversé
 * ferait passer un bloc APRÈS un autre sans l'écraser (mais changerait le sens
 * donné au modèle). Cette fonction est extraite pour être VERROUILLÉE par un
 * test d'ordre (voir `tests/pi/personality-extension.test.ts`).
 */
export function buildInlineExtensions(
  options: Pick<
    PiHostOptions,
    "personality" | "memory" | "directory" | "heritage" | "logger"
  >,
): InlineExtension[] {
  const extensionFactories: InlineExtension[] = [];
  if (options.personality) {
    extensionFactories.push(
      createPersonalityExtensionFactory(options.personality, {
        logger: options.logger,
      }),
    );
  }
  if (options.memory) {
    extensionFactories.push(
      createMemoryExtensionFactory(options.memory, {
        syntheticUserPrefixes: SYNTHETIC_USER_PREFIXES,
      }),
    );
  }
  if (options.directory) {
    // La liste des machines pilotables est visible dès le départ ; l'état
    // (connecté/hors ligne), trop changeant, reste dans les outils.
    extensionFactories.push(
      createAgentRosterExtensionFactory(options.directory, {
        logger: options.logger,
      }),
    );
  }
  if (options.heritage) {
    // Signale l'EXISTENCE de l'archive (une ligne, jamais le contenu)
    // uniquement quand elle contient au moins une entrée.
    extensionFactories.push(
      createHeritageExtensionFactory(options.heritage, { logger: options.logger }),
    );
  }
  return extensionFactories;
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
      ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
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
        // Rattrapage : le contenu autoritatif du message peut contenir un
        // suffixe JAMAIS streamé (`text_delta` absent chez certains
        // fournisseurs). Sans ce delta, l'UI **live** resterait vide et le TTS
        // muet, alors que la réponse existe. On ne réémet que le suffixe
        // manquant (aucun doublon dans le cas normal où `partial === content`).
        const suffix = unstreamedContentSuffix(record.partial, content);
        if (suffix.length > 0) {
          run.instrumentation.markFirstToken();
          record.partial += suffix;
          emitEvent({
            type: "delta",
            sessionId: record.sessionId,
            runId: run.runId,
            channel: "content",
            text: suffix,
          });
        }
        const text = content.length > 0 ? content : record.partial;
        if (text.length > 0) {
          record.transcript.push({
            role: "assistant",
            text,
            timestamp: messageTimestamp(message) ?? Date.now(),
          });
        }
        record.partial = "";
        return;
      }
      default:
        return;
    }
  }

  /**
   * Reconstruit le transcript de l'UI depuis la session reprise. Le SDK a déjà
   * hydraté le contexte du modèle (`agent.state.messages`) : sans cela, l'UI
   * repartirait VIDE alors que le modèle a gardé l'historique (bug corrigé ici).
   *
   * Source : la branche ACTIVE du `SessionManager` (racine → feuille), qui
   * contient tout l'historique — y compris les messages résumés par une
   * compaction, comme le scrollback live qui n'est jamais tronqué. Un échec de
   * lecture ne doit pas empêcher le démarrage : on journalise et on repart vide.
   */
  function restoreTranscript(session: AgentSession): TranscriptEntry[] {
    try {
      return transcriptFromEntries(session.sessionManager.getBranch(), {
        syntheticUserPrefixes: SYNTHETIC_USER_PREFIXES,
      });
    } catch (error) {
      logger.warn("pi.transcript.restore.failed", {
        session_id: session.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  function attachRecord(session: AgentSession): SessionRecord {
    const record: SessionRecord = {
      sessionId: session.sessionId,
      session,
      unsubscribe: () => undefined,
      state: "idle",
      transcript: restoreTranscript(session),
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
      record.transcript.push({
        role: "user",
        text: run.text,
        timestamp: run.sentAt,
      });
    }
    runContext.set({ sessionId: record.sessionId, runId: run.runId });
    emitEvent({
      type: "state",
      sessionId: record.sessionId,
      state: "streaming",
      activeRunId: run.runId,
    });

    try {
      await record.session.prompt(run.storedText, {
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

  /** Résumé de la session COURANTE (même si son fichier n'est pas encore écrit). */
  function currentSessionSummary(record: SessionRecord): SessionInfo {
    let name: string | undefined;
    try {
      name = record.session.sessionManager.getSessionName();
    } catch {
      name = undefined;
    }
    const firstUser = record.transcript.find((entry) => entry.role === "user")?.text;
    const sessionFile = record.session.sessionManager.getSessionFile();
    return {
      sessionId: record.sessionId,
      ...(sessionFile ? { sessionFile } : {}),
      ...(name ? { name } : {}),
      title: titleFrom(name, firstUser),
      cwd: paths.cwd,
      updatedAt: new Date().toISOString(),
      messageCount: record.transcript.length,
      ...(firstUser ? { firstMessage: firstUser } : {}),
    };
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
    if (options.execution) {
      // Lot 4, B6bis : outil d'exécution déléguée (`run_command`). Le garde-fou
      // par agent (D118) est appliqué côté Yuki AVANT l'envoi.
      customTools.push(...createExecutionTools(options.execution));
    }
    if (options.directory) {
      // Lot 4 (extension) : outils de CONSULTATION des agents (`lister_agents`,
      // `etat_agent`), en LECTURE SEULE. Actifs même quand l'exécution est
      // désactivée : consulter n'est pas exécuter.
      customTools.push(...createAgentDirectoryTools(options.directory));
    }
    if (options.screenshots) {
      // Lot 4 (extension) : capture d'écran déléguée (`capturer_ecran`). Le
      // garde-fou par agent est appliqué côté Yuki, comme pour `run_command`.
      customTools.push(...createScreenshotTool(options.screenshots));
    }
    if (options.heritage) {
      // Lot 13 : outil de CONSULTATION de l'archive « vie antérieure » (LECTURE
      // SEULE). L'archive n'est jamais injectée ; on la consulte à la demande.
      customTools.push(...createHeritageTools(options.heritage));
    }

    // Extensions INLINE, dans l'ORDRE D'APPLICATION voulu du prompt du tour :
    // PERSONNALITÉ (base) → MÉMOIRE → ANNUAIRE des agents → HERITAGE (voir
    // `buildInlineExtensions`, verrouillé par un test d'ordre).
    const extensionFactories = buildInlineExtensions(options);

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
      ...(extensionFactories.length > 0 ? { extensionFactories } : {}),
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
      // Une session PÉRIMÉE (l'utilisateur a basculé ailleurs) ne doit JAMAIS
      // être ré-acheminée silencieusement vers la session courante : on refuse.
      if (record.sessionId !== sessionId) {
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

    recordRunStage(sessionId: string, runId: string, stage: string): void {
      const record = recordFor(sessionId);
      const run = record?.currentRun;
      if (run && run.runId === runId) {
        run.instrumentation.markStage(stage);
      }
    },

    recordRunTtsMetrics(
      sessionId: string,
      runId: string,
      metrics: RunTtsMetrics,
    ): void {
      const record = recordFor(sessionId);
      const run = record?.currentRun;
      if (run && run.runId === runId) {
        run.instrumentation.recordTtsMetrics(metrics);
      }
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
      const mapped: SessionInfo[] = list.map((info) => ({
        sessionId: info.id,
        sessionFile: info.path,
        ...(info.name ? { name: info.name } : {}),
        title: titleFrom(info.name, info.firstMessage),
        cwd: info.cwd,
        createdAt: info.created.toISOString(),
        updatedAt: info.modified.toISOString(),
        messageCount: info.messageCount,
        firstMessage: info.firstMessage,
      }));
      // Fusionne la session COURANTE si son fichier n'est pas encore persisté
      // (un fil neuf ne s'écrit qu'à la première réponse assistant) : sinon
      // « Nouvelle conversation » n'apparaîtrait pas dans la liste.
      const current = currentRecord;
      if (current && !mapped.some((info) => info.sessionId === current.sessionId)) {
        mapped.unshift(currentSessionSummary(current));
      }
      return mapped.slice(0, MAX_SESSIONS);
    },

    async renameSession(id: string, title: string): Promise<void> {
      if (!ready) {
        throw new PiHostError("PI_NOT_READY", "Host Pi non démarré.");
      }
      // Titre normalisé sur UNE ligne : le SDK refuse déjà les sauts de ligne.
      const normalized = title.replace(/\s+/g, " ").trim();
      if (normalized.length > 0) {
        // Doublons REFUSÉS (insensible à la casse/aux espaces) : message honnête.
        const existing = await host.listSessions();
        const needle = normalized.toLowerCase();
        const clash = existing.find(
          (info) =>
            info.sessionId !== id &&
            (info.title ?? "").trim().toLowerCase() === needle,
        );
        if (clash) {
          throw new PiHostError(
            "PI_SESSION_ERROR",
            `Le titre « ${normalized} » est déjà utilisé par une autre conversation.`,
            { sessionId: id },
          );
        }
      }
      // Session courante attachée : renommage NATIF sur le SessionManager vivant
      // (persisté dès que le fil a un premier message assistant).
      const live =
        sessions.get(id) ?? (currentRecord?.sessionId === id ? currentRecord : undefined);
      if (live) {
        live.session.sessionManager.appendSessionInfo(normalized);
        return;
      }
      // Sinon : ouverture du JSONL et ajout d'une entrée `session_info`.
      const file = await host.sessionFileFor(id);
      if (!file || !existsSync(file)) {
        throw new PiHostError("PI_SESSION_ERROR", "Conversation introuvable.", {
          sessionId: id,
        });
      }
      const manager = SessionManager.open(file, paths.sessionsDir, paths.cwd);
      manager.appendSessionInfo(normalized);
    },

    async setAsideSession(id: string): Promise<void> {
      if (!ready) {
        throw new PiHostError("PI_NOT_READY", "Host Pi non démarré.");
      }
      const isCurrent = currentRecord?.sessionId === id;
      const file = await host.sessionFileFor(id);
      if (!isCurrent && (!file || !existsSync(file))) {
        throw new PiHostError("PI_SESSION_ERROR", "Conversation introuvable.", {
          sessionId: id,
        });
      }
      // ⚠️ ORDRE OBLIGATOIRE quand c'est la session OUVERTE : on détache la
      // session vivante AVANT de déplacer son fichier, sinon le prochain
      // `_persist` du SDK recréerait le JSONL au chemin déplacé (fil fantôme).
      if (isCurrent) {
        if (currentRecord) {
          await host.abort(id).catch(() => undefined);
          detachRecord(currentRecord);
          currentRecord = undefined;
        }
        // Session de remplacement FRÂCHE, en mémoire : son fichier ne s'écrit
        // qu'à la première réponse — l'UI affiche donc l'état vide jusque-là.
        const activeRuntime = runtime;
        if (activeRuntime) {
          try {
            await activeRuntime.newSession();
          } catch (error) {
            throw toPiHostError(error, { logger, sessionId: id });
          }
        }
      }
      // Déplacement horodaté : récupérable à la main, invisible à la liste.
      if (file && existsSync(file)) {
        const asideDir = join(paths.sessionsDir, ASIDE_DIR, timestampSlug());
        try {
          mkdirSync(asideDir, { recursive: true });
          renameSync(file, join(asideDir, basename(file)));
        } catch (error) {
          throw toPiHostError(error, { logger, sessionId: id });
        }
      }
      logger.info("pi.session.set_aside", {
        session_id: id,
        was_current: isCurrent,
        aside_dir: file ? join(paths.sessionsDir, ASIDE_DIR) : null,
      });
    },

    async sessionFileFor(id: string): Promise<string | undefined> {
      if (currentRecord?.sessionId === id) {
        return currentRecord.session.sessionManager.getSessionFile();
      }
      const list = await SessionManager.list(
        paths.cwd,
        paths.sessionsDir,
      ).catch(() => []);
      return list.find((info) => info.id === id)?.path;
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
