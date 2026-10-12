/**
 * Worker lourd (confidentiel — `src/pi/sdk/**` uniquement).
 *
 * Implémente le port `HeavyWorker` : une tâche = une session ÉPHÉMÈRE en
 * mémoire = un prompt = une réponse finale. Aucune fuite de contexte entre
 * jobs. Thinking `high`. Capture du texte final (deltas `content` uniquement,
 * `thinking` IGNORÉ) et de l'`usage`. Timeouts : inactivité (`idleTimeoutMs`) et
 * global (`totalTimeoutMs`) → `abort()` + job `failed` avec `partial`.
 */

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type {
  HeavyRunHandle,
  HeavyRunRequest,
  HeavyRunResult,
  HeavySteerResult,
  HeavyWorker,
} from "../../delegation/ports.js";
import { MAX_PENDING_STEERS, composeFirstPrompt } from "../../delegation/steer.js";
import type { JobUsage } from "../../jobs/types.js";
import {
  channelForAssistantEvent,
  contentTextFromMessage,
  deltaText,
  finishReasonForMessage,
  sanitizeErrorText,
  usageFromMessage,
  type RawAgentMessage,
} from "../events.js";
import type { PiLogger, PiThinkingLevel } from "../types.js";
import { getSharedModelRuntime, resolveSdkModel } from "./model-runtime.js";
import { createEphemeralSession } from "./session-factory.js";

export interface SdkHeavyWorkerConfig {
  cwd: string;
  agentDir: string;
  authPath: string;
  modelsPath: string;
  systemPrompt: string;
  /** Référence `provider/modelId` du modèle lourd. */
  modelReference: string;
  thinking: PiThinkingLevel;
  /** Allowlist d'outils du lourd (lecture seule). */
  tools: readonly string[];
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  logger: PiLogger;
}

function toJobUsage(usage: ReturnType<typeof usageFromMessage>): JobUsage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    ...(usage.total !== undefined ? { total: usage.total } : {}),
  };
}

/** Vue minimale d'une session éphémère permettant de la steer. */
type SteerableSession = { steer(text: string): Promise<void> };

/** État partagé entre la poignée (`steer`) et l'exécution du job. */
interface RunSteerState {
  session?: SteerableSession;
  /** Le premier prompt a-t-il été envoyé ? (avant : tampon) */
  promptStarted: boolean;
  /** Le job est-il achevé ? (après : plus steerable) */
  finished: boolean;
  /** Consignes de l'orchestrateur en attente d'intégration au premier prompt. */
  pendingSteers: string[];
}

/** Fabrique l'implémentation SDK du worker lourd. */
export function createSdkHeavyWorker(config: SdkHeavyWorkerConfig): HeavyWorker {
  return {
    run(request: HeavyRunRequest): HeavyRunHandle {
      const controller = new AbortController();
      let cancelled = false;
      let sessionDispose: (() => void) | undefined;
      // ⚠️ Tampon des consignes de l'orchestrateur : tant que le PREMIER prompt
      // n'est pas parti (session en cours de création), un `steer` serait
      // ignoré. On TAMPONNE, puis on INTÈGRE au premier message (jamais perdu).
      const state: RunSteerState = {
        promptStarted: false,
        finished: false,
        pendingSteers: [...(request.initialSteers ?? [])].slice(
          0,
          MAX_PENDING_STEERS,
        ),
      };

      const task = execute(
        request,
        controller.signal,
        () => controller.abort(),
        () => cancelled,
        state,
        (session, dispose) => {
          state.session = session;
          sessionDispose = dispose;
        },
      );
      // Toute issue (succès, échec précoce, annulation) rend le job non
      // steerable : on le reflète sur l'état partagé sans jamais rejeter.
      void task.then(
        () => {
          state.finished = true;
        },
        () => {
          state.finished = true;
        },
      );

      return {
        promise: task,
        async cancel(): Promise<void> {
          cancelled = true;
          controller.abort();
          try {
            await task;
          } catch {
            // Ignoré : l'issue est déjà classée.
          }
          sessionDispose?.();
        },
        async steer(text: string): Promise<HeavySteerResult> {
          if (state.finished) return "finished";
          const session = state.session;
          if (!state.promptStarted || !session) {
            if (state.pendingSteers.length >= MAX_PENDING_STEERS) return "full";
            state.pendingSteers.push(text);
            return "buffered";
          }
          try {
            await session.steer(text);
            return "injected";
          } catch {
            return "finished";
          }
        },
      };
    },
  };

  async function execute(
    request: HeavyRunRequest,
    signal: AbortSignal,
    abort: () => void,
    isCancelled: () => boolean,
    state: RunSteerState,
    onSessionCreated: (session: SteerableSession, dispose: () => void) => void,
  ): Promise<HeavyRunResult> {
    let runtime: ModelRuntime;
    try {
      runtime = await getSharedModelRuntime({
        authPath: config.authPath,
        modelsPath: config.modelsPath,
      });
    } catch (error) {
      config.logger.warn("heavy.runtime.failed", {
        job_id: request.jobId,
        error: sanitizeErrorText(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return { status: "failed", error: "model_runtime_unavailable" };
    }

    const model = resolveSdkModel(runtime, config.modelReference);
    if (!model) {
      config.logger.warn("heavy.model.unresolved", {
        job_id: request.jobId,
        model: config.modelReference,
      });
      return { status: "failed", error: "model_unresolved" };
    }

    let ephemeral;
    try {
      ephemeral = await createEphemeralSession({
        cwd: config.cwd,
        agentDir: config.agentDir,
        systemPrompt: config.systemPrompt,
        modelRuntime: runtime,
        model,
        thinkingLevel: config.thinking,
        tools: config.tools,
      });
    } catch (error) {
      config.logger.warn("heavy.session.failed", {
        job_id: request.jobId,
        error: sanitizeErrorText(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return { status: "failed", error: "session_creation_failed" };
    }

    const { session } = ephemeral;
    onSessionCreated(session, () => {
      try {
        session.dispose();
      } catch {
        // Ignoré.
      }
    });
    request.onSession?.(session.sessionId);

    let currentText = "";
    let lastText = "";
    let usage: JobUsage | undefined;
    let firstTokenEmitted = false;
    let sawError = false;
    let errorMessage: string | undefined;
    let idleTimedOut = false;
    let totalTimedOut = false;

    let idleTimer: NodeJS.Timeout | undefined;
    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        abort();
      }, config.idleTimeoutMs);
      idleTimer.unref?.();
    };

    const onAbort = (): void => {
      void session.abort().catch(() => undefined);
    };
    if (signal.aborted) onAbort();
    signal.addEventListener("abort", onAbort, { once: true });

    const totalTimer = setTimeout(() => {
      totalTimedOut = true;
      abort();
    }, config.totalTimeoutMs);
    totalTimer.unref?.();

    const unsubscribe = session.subscribe((raw) => {
      resetIdle();
      const event = raw as {
        type?: unknown;
        message?: unknown;
        assistantMessageEvent?: unknown;
      };
      switch (event.type) {
        case "message_update": {
          const assistantEvent = event.assistantMessageEvent as
            | { type?: unknown; delta?: unknown }
            | undefined;
          if (!assistantEvent) return;
          const channel = channelForAssistantEvent(assistantEvent);
          if (channel !== "content") return; // `thinking` explicitement ignoré.
          const delta = deltaText(assistantEvent);
          if (delta.length === 0) return;
          currentText += delta;
          if (!firstTokenEmitted) {
            firstTokenEmitted = true;
            request.onFirstToken?.();
          }
          return;
        }
        case "turn_end": {
          const message = event.message as RawAgentMessage | undefined;
          if (message) {
            const captured = toJobUsage(usageFromMessage(message));
            if (captured) usage = captured;
          }
          const partial = currentText || lastText;
          if (partial.length > 0) request.onProgress?.(partial);
          return;
        }
        case "message_end": {
          const message = event.message as RawAgentMessage | undefined;
          if (!message || message.role !== "assistant") return;
          const content = contentTextFromMessage(message);
          if (content.length > 0) lastText = content;
          currentText = "";
          const captured = toJobUsage(usageFromMessage(message));
          if (captured) usage = captured;
          const reason = finishReasonForMessage(message);
          if (reason === "error") {
            sawError = true;
            errorMessage =
              typeof message.errorMessage === "string"
                ? sanitizeErrorText(message.errorMessage)
                : "erreur du worker lourd";
          }
          return;
        }
        default:
          return;
      }
    });

    resetIdle();
    // ⚠️ Les consignes tamponnées (file d'admission + fenêtre de création de la
    // session) sont INTÉGRÉES au PREMIER message, sous un cadrage explicite : le
    // sous-agent comprend qu'elles viennent de l'orchestrateur, pas de
    // l'utilisateur. Le tampon est vidé (jamais rejoué).
    const firstPrompt = composeFirstPrompt(
      request.task,
      state.pendingSteers.splice(0),
    );
    state.promptStarted = true;
    try {
      await session.prompt(firstPrompt, { expandPromptTemplates: false });
    } catch (error) {
      if (!sawError) {
        sawError = true;
        errorMessage = sanitizeErrorText(
          error instanceof Error ? error.message : String(error),
        );
      }
    } finally {
      clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }

    const finalText = lastText || currentText;
    const partial = finalText.length > 0 ? finalText : undefined;
    state.finished = true;
    session.dispose();

    if (isCancelled()) {
      return { status: "cancelled", ...(partial ? { partial } : {}) };
    }
    if (totalTimedOut) {
      return {
        status: "failed",
        error: "timeout",
        ...(partial ? { partial } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    if (idleTimedOut) {
      return {
        status: "failed",
        error: "idle_timeout",
        ...(partial ? { partial } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    if (sawError) {
      return {
        status: "failed",
        error: errorMessage ?? "erreur du worker lourd",
        ...(partial ? { partial } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    return {
      status: "completed",
      text: finalText,
      ...(usage ? { usage } : {}),
    };
  }
}
