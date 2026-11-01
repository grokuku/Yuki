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
import type { TransferServicePort } from "../../agents/transfer.js";
import { formatAttachmentsForPrompt, type FilesReadPort } from "../../files/index.js";
import type { SecretDirectoryPort } from "../../secrets/directory.js";
import type {
  HeavyRunHandle,
  HeavyRunRequest,
  HeavyRunResult,
  HeavySteerResult,
  HeavyWorker,
} from "../../delegation/ports.js";
import {
  MAX_DELEGATION_CONTEXT_CHARS,
  MAX_PENDING_STEERS,
  assertDelegationContext,
  composeFirstPrompt,
  DelegationContextTooLongError,
} from "../../delegation/steer.js";
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
  createFileTransferTools,
  createScreenshotTool,
  createSecretTools,
  type ActionToolOptions,
} from "./execution-tools.js";
import { getSharedModelRuntime, liveValue, resolveSdkModel, sdkModelSupportsImages } from "./model-runtime.js";
import { createListFilesTool } from "./list-files-tool.js";
import { createReadFileTool } from "./read-file-tool.js";
import { createEphemeralSession } from "./session-factory.js";

/**
 * Borne une cause d'erreur destinée au RAPPORT DE JOB (donc à l'utilisateur).
 *
 * ⚠️ La cause BRUTE est reprise telle quelle (assainie en amont) : une erreur
 * traduite sans sa source est indiagnosticable — un même message de façade peut
 * recouvrir plusieurs causes très différentes. On la borne pour qu'un corps
 * HTTP de plusieurs kilo-octets ne noie pas le rapport.
 */
const MAX_CAUSE_CHARS = 300;

export function truncateCause(text: string, max = MAX_CAUSE_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "(aucun détail)";
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

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
   * Service de TRANSFERT de fichiers (capacité `files`). Présent ⇒ le worker
   * porte `recuperer_fichier`/`deposer_fichier`. ⚠️ Même garde-fou par agent
   * que `run_command` ; l'agent sans la capacité est refusé AVANT émission.
   */
  transfers?: TransferServicePort;
  /**
   * Port de LECTURE des fichiers de la conversation (métadonnées ET contenu).
   * Présent ⇒ le worker porte `lister_fichiers`, `lire_fichier` ET reçoit
   * AUTOMATIQUEMENT, dans son premier message, la liste des pièces jointes de la
   * conversation propriétaire (identifiants compris).
   *
   * ⚠️ Avant `lire_fichier`, ce port ne rendait que des MÉTADONNÉES : le worker
   * savait qu'une image existait, en avait l'identifiant, et ne pouvait en lire
   * aucun octet (un fichier du store n'est pas sur un chemin de son espace de
   * travail : `read` ne l'atteint pas).
   */
  files?: FilesReadPort;
  /**
   * Port de consultation du coffre de secrets. Présent ⇒ le worker porte
   * `lister_secrets` (NOMS seulement), pour savoir QUELLES variables
   * `${YUKI_SECRET_…}` référencer dans `run_command`.
   */
  secrets?: SecretDirectoryPort;
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
/**
 * Vision du MODÈLE RÉSOLU pour un job — lue à l'exécution (`model.input`), jamais
 * supposée. Passée aux outils de transfert pour qu'ils disent la vérité quand une
 * image n'est pas jointe.
 */
export interface HeavyActionToolVision {
  /** Référence `provider/modelId` du modèle effectivement résolu. */
  modelLabel: string;
  /** Le modèle accepte-t-il les images ? (`model.input` de `models.json`) */
  imagesSupported: boolean;
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
  config: Pick<
    SdkHeavyWorkerConfig,
    "execution" | "screenshots" | "secrets" | "transfers" | "files"
  > & {
    /** Journal d'AUDIT des lectures de fichiers (facultatif : métadonnées seules). */
    logger?: PiLogger;
  },
  lightSessionId: string | undefined,
  vision?: HeavyActionToolVision,
): ToolDefinition[] {
  const options: ActionToolOptions = {
    approvalSessionId: () => lightSessionId,
  };
  const tools: ToolDefinition[] = [];
  if (config.execution) tools.push(...createExecutionTools(config.execution, options));
  if (config.screenshots) tools.push(...createScreenshotTool(config.screenshots, options));
  // ⚠️ TRANSFERT : c'est le lourd qui AGIT sur une machine (récupérer/déposer).
  // La CAPACITÉ VISION du modèle résolu lui est passée : une image récupérée n'est
  // jointe que si le modèle la reçoit, et le résultat le dit dans tous les cas.
  if (config.transfers) {
    tools.push(
      ...createFileTransferTools(
        config.transfers,
        options,
        vision !== undefined
          ? {
              imagesSupported: vision.imagesSupported,
              modelLabel: vision.modelLabel,
            }
          : undefined,
      ),
    );
  }
  if (config.secrets) tools.push(...createSecretTools(config.secrets));
  // ⚠️ LISTAGE : le worker doit pouvoir retrouver un IDENTIFIANT de fichier (ce
  // qu'exige `deposer_fichier`) sans dépendre du léger. La conversation est
  // FORCÉE à celle du léger (sa propre session est éphémère).
  if (config.files) {
    tools.push(
      ...createListFilesTool(config.files, { sessionId: () => lightSessionId }),
    );
    // ⚠️ LECTURE du CONTENU : sans elle, le worker sait qu'une image existe et
    // ne peut rien en faire (l'utilisateur resterait dans la boucle). MÊME
    // conversation forcée ; la capacité VISION du modèle résolu décide si une
    // image est réellement jointe, et le résultat le dit dans tous les cas.
    tools.push(
      ...createReadFileTool(config.files, {
        sessionId: () => lightSessionId,
        logger: config.logger,
        ...(vision !== undefined
          ? { imagesSupported: vision.imagesSupported, modelLabel: vision.modelLabel }
          : {}),
      }),
    );
  }
  return tools;
}

/**
 * Bloc « pièces jointes » joint AUTOMATIQUEMENT au premier message du worker
 * (le léger n'a rien à transmettre). Métadonnées seules, borné, explicite si
 * tronqué. Une erreur de lecture ne tue PAS le job : elle est DITE au worker.
 */
export function collectAttachmentBlock(
  files: FilesReadPort | undefined,
  sessionId: string,
  logger: PiLogger,
  jobId: string,
): string {
  if (!files) return "";
  try {
    const block = formatAttachmentsForPrompt(files.listForSession(sessionId));
    if (block.total > 0) {
      logger.info("heavy.attachments.listed", {
        job_id: jobId,
        total: block.total,
        shown: block.shown,
        omitted: block.omitted,
      });
    }
    return block.text;
  } catch (error) {
    logger.warn("heavy.attachments.failed", {
      job_id: jobId,
      error: sanitizeErrorText(error instanceof Error ? error.message : String(error)),
    });
    return (
      "PIÈCES JOINTES : la liste n'a pas pu être lue (erreur du stockage côté " +
      "Yuki). Appelle `lister_fichiers` ; s'il échoue aussi, dis-le dans ton " +
      "rapport au lieu de deviner un identifiant."
    );
  }
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
    // ⚠️ CONTEXTE de délégation (`delegate(task, context?)`) : VÉRIFIÉ AVANT
    // toute session, donc avant toute exécution. Au-delà du plafond, on REFUSE
    // le job avec un motif explicite — jamais de troncature muette (le worker
    // croirait avoir reçu la note entière).
    try {
      assertDelegationContext(request.context);
    } catch (error) {
      const chars =
        error instanceof DelegationContextTooLongError ? error.chars : undefined;
      config.logger.warn("heavy.context.too_long", {
        job_id: request.jobId,
        ...(chars !== undefined ? { chars } : {}),
      });
      return {
        status: "failed",
        error:
          "Contexte de délégation REFUSÉ : " +
          (chars !== undefined ? `${chars} caractères` : "taille inconnue") +
          " pour un plafond de " +
          `${MAX_DELEGATION_CONTEXT_CHARS}. Rien n'a été exécuté : le contexte ` +
          "doit rester une NOTE (faits, chemins, identifiants), pas une " +
          "conversation. Raccourcis-le, puis relance la tâche.",
      };
    }

    // ⚠️ PIÈCES JOINTES : jointes AUTOMATIQUEMENT (le léger n'a pas à y penser).
    // Métadonnées seules (identifiant, nom, genre, taille, date) — jamais le
    // contenu, jamais l'historique de la conversation.
    const attachments = collectAttachmentBlock(
      config.files,
      request.lightSessionId,
      config.logger,
      request.jobId,
    );

    let runtime: ModelRuntime;
    try {
      runtime = await getSharedModelRuntime({
        authPath: config.authPath,
        modelsPath: config.modelsPath,
      });
    } catch (error) {
      // ⚠️ La cause RÉELLE est reprise dans le message (assainie, bornée) : le
      // rapport de job est ce que lit l'utilisateur. « (voir les journaux) » sans
      // la cause a déjà coûté des heures de diagnostic.
      const runtimeCause = truncateCause(
        sanitizeErrorText(error instanceof Error ? error.message : String(error)),
      );
      config.logger.warn("heavy.runtime.failed", {
        job_id: request.jobId,
        error: runtimeCause,
      });
      return {
        status: "failed",
        error:
          "Le worker lourd n'a pas pu démarrer : configuration des modèles ou " +
          "authentification du fournisseur indisponible. Cause : " +
          runtimeCause,
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
      const actionTools = buildHeavyActionTools(config, request.lightSessionId, {
        modelLabel: modelReference,
        // ⚠️ Capacité lue sur le modèle RÉSOLU (donc sur `models.json` à cet
        // instant) : un modèle texte seul ne reçoit jamais d'image, même si le
        // réglage changeait en cours de route.
        imagesSupported: sdkModelSupportsImages(model),
      });
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
      const sessionCause = truncateCause(
        sanitizeErrorText(error instanceof Error ? error.message : String(error)),
      );
      config.logger.warn("heavy.session.failed", {
        job_id: request.jobId,
        error: sessionCause,
      });
      return {
        status: "failed",
        error:
          "La session du worker lourd n'a pas pu être créée. Cause : " + sessionCause,
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
            // ⚠️ ET ON LA JOURNALISE : une cause TRADUITE sans sa source reste
            // indiagnosticable (le motif le plus large — « indisponible » —
            // recouvre plusieurs causes distinctes). Le brut est borné et
            // assaini (jamais de clé).
            config.logger.warn("heavy.prompt.error", {
              job_id: request.jobId,
              model: liveValue(config.modelReference),
              error: truncateCause(
                raw ?? "(aucun détail fourni par le fournisseur)",
              ),
            });
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
      {
        ...(request.context !== undefined && request.context.trim() !== ""
          ? { context: request.context }
          : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
    );
    state.promptStarted = true;
    try {
      await session.prompt(firstPrompt, { expandPromptTemplates: false });
    } catch (error) {
      if (!sawError) {
        sawError = true;
        const cause = truncateCause(
          sanitizeErrorText(error instanceof Error ? error.message : String(error)),
        );
        config.logger.warn("heavy.prompt.error", {
          job_id: request.jobId,
          model: liveValue(config.modelReference),
          error: cause,
        });
        errorMessage = describeModelError(cause);
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
