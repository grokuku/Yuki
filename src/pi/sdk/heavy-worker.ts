/**
 * Worker lourd (confidentiel — `src/pi/sdk/**` uniquement).
 *
 * Implémente le port `HeavyWorker` : une tâche = une session ÉPHÉMÈRE en
 * mémoire = un prompt = une réponse finale. Aucune fuite de contexte entre
 * jobs. Thinking `high`. Capture du texte final (deltas `content` uniquement,
 * `thinking` IGNORÉ) et de l'`usage`. Timeouts : inactivité (`idleTimeoutMs`) et
 * global (`totalTimeoutMs`) → `abort()` + job `failed` avec `partial`.
 */

import type { ModelRuntime, ToolDefinition } from "@earendil-works/pi-coding-agent";

import type {
  ExecutionServicePort,
  ScreenshotServicePort,
} from "../../agents/execution.js";
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
  errorTextFromMessage,
  finishReasonForMessage,
  sanitizeErrorText,
  usageFromMessage,
  type RawAgentMessage,
} from "../events.js";
import { describeModelError } from "../errors.js";
import type { PiLogger, PiThinkingLevel } from "../types.js";
import {
  createExecutionTools,
  createScreenshotTool,
  type ActionToolOptions,
} from "./execution-tools.js";
import { getSharedModelRuntime, liveValue, resolveSdkModel } from "./model-runtime.js";
import { createEphemeralSession } from "./session-factory.js";

export interface SdkHeavyWorkerConfig {
  cwd: string;
  agentDir: string;
  authPath: string;
  modelsPath: string;
  systemPrompt: string;
  /**
   * Référence `provider/modelId` du modèle lourd. Une FONCTION est relue à
   * CHAQUE job : un changement de modèle (`apply: hot`) s'applique donc aux
   * NOUVEAUX jobs sans redémarrer Yuki (un job en vol garde son modèle).
   */
  modelReference: string | (() => string);
  /** Niveau de réflexion du lourd (une fonction est relue à chaque job). */
  thinking: PiThinkingLevel | (() => PiThinkingLevel);
  /** Allowlist d'outils du lourd (lecture + outils d'action). */
  tools: readonly string[];
  /**
   * Service d'exécution déléguée (agents appairés). Présent ⇒ le worker porte
   * `run_command` (outil d'ACTION). ⚠️ Le garde-fou par agent (D118) reste
   * appliqué côté Yuki ; ici on ne fait que RATTACHER la validation à la
   * CONVERSATION propriétaire (`HeavyRunRequest.lightSessionId`).
   */
  execution?: ExecutionServicePort;
  /** Service de capture d'écran. Présent ⇒ le worker porte `capturer_ecran`. */
  screenshots?: ScreenshotServicePort;
  /**
   * Fabrique de session éphémère. Injectable pour les TESTS (défaut :
   * `createEphemeralSession`). Permet d'exercer le câblage des outils d'action
   * sans modèle ni réseau.
   */
  createSession?: typeof createEphemeralSession;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  logger: PiLogger;
}

/**
 * Outils d'ACTION du worker lourd (`run_command` + `capturer_ecran`).
 *
 * ⚠️ La session du worker est ÉPHÉMÈRE : son propre identifiant ne doit JAMAIS
 * rattacher une validation (la fenêtre s'afficherait dans une conversation
 * invisible — trou de sécurité). On FORCE donc `approvalSessionId` à l'ID de la
 * conversation propriétaire (`lightSessionId`). Extrait pour être VERROUILLÉ par
 * un test.
 */
export function buildHeavyActionTools(
  config: Pick<SdkHeavyWorkerConfig, "execution" | "screenshots">,
  lightSessionId: string | undefined,
): ToolDefinition[] {
  const options: ActionToolOptions = {
    approvalSessionId: () => lightSessionId,
  };
  const tools: ToolDefinition[] = [];
  if (config.execution) tools.push(...createExecutionTools(config.execution, options));
  if (config.screenshots) tools.push(...createScreenshotTool(config.screenshots, options));
  return tools;
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
      return {
        status: "failed",
        error:
          "Le worker lourd n'a pas pu démarrer : configuration des modèles ou " +
          "authentification du fournisseur indisponible (voir les journaux).",
      };
    }

    const modelReference = liveValue(config.modelReference);
    const model = resolveSdkModel(runtime, modelReference);
    if (!model) {
      config.logger.warn("heavy.model.unresolved", {
        job_id: request.jobId,
        model: modelReference,
      });
      return {
        status: "failed",
        error:
          `Le modèle lourd « ${modelReference} » est introuvable dans ` +
          "models.json : vérifiez « llm.heavy.model » et « llm.heavy.baseUrl ».",
      };
    }

    let ephemeral;
    try {
      // Outils d'ACTION rattachés à la CONVERSATION PROPRIÉTAIRE (jamais à
      // l'ID éphémère) : la validation humaine remonte donc dans la bonne
      // conversation.
      const actionTools = buildHeavyActionTools(config, request.lightSessionId);
      ephemeral = await (config.createSession ?? createEphemeralSession)({
        cwd: config.cwd,
        agentDir: config.agentDir,
        systemPrompt: config.systemPrompt,
        modelRuntime: runtime,
        model,
        thinkingLevel: liveValue(config.thinking),
        tools: config.tools,
        ...(actionTools.length > 0 ? { customTools: actionTools } : {}),
      });
    } catch (error) {
      config.logger.warn("heavy.session.failed", {
        job_id: request.jobId,
        error: sanitizeErrorText(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return {
        status: "failed",
        error:
          "La session du worker lourd n'a pas pu être créée (voir les journaux).",
      };
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
            // ⚠️ La cause BRUTE du fournisseur (statut HTTP + corps) est traduite
            // en français ACTIONNABLE, comme le fait la session légère
            // (`sdk-host.ts`). Sans cette traduction, le rapport de job porterait
            // le jargon anglais/JSON brut, ce qui pousse le léger à INVENTER une
            // cause (« le worker n'est pas disponible ») au lieu de la citer.
            const raw = errorTextFromMessage(message);
            if (raw !== undefined) {
              errorMessage = describeModelError(raw);
            }
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
        errorMessage = describeModelError(
          sanitizeErrorText(error instanceof Error ? error.message : String(error)),
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
