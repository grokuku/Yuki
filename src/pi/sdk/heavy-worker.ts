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
import { createImageTools, type ImageToolPort } from "./image-tools.js";
import { createImageBudgetExtensionFactory } from "./image-budget-extension.js";
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

/**
 * CHIEN DE GARDE d'un OUTIL (ms) — 16 minutes (valeur PLANCHER).
 *
 * ⚠️ Ce n'est QUE le plancher de `resolveToolWatchdogMs` : avec le plafond de
 * génération par défaut (1 h), le chien de garde RÉELLEMENT appliqué vaut
 * 3 660 000 ms (plafond + `TOOL_WATCHDOG_MARGIN_MS`), donc toujours AU-DESSUS
 * de `images.timeoutMs`.
 *
 * ⚠️ Ce plancher reste nécessaire pour le plus long délai de commande possible
 * (`MAX_COMMAND_TIMEOUT_MS` = 900 s + `COMMAND_SAFETY_MARGIN_MS` = 30 s d'attente
 * côté Yuki, `src/agents/execution.ts` / `src/agents/connection.ts`) : une
 * commande ne peut pas être tuée par le chien de garde AVANT sa propre borne.
 *
 * ⚠️ Le chien de garde RÉELLEMENT appliqué est calculé par
 * `resolveToolWatchdogMs` à partir du plafond de génération courant, et passé
 * par `src/index.ts` (relu à chaque job). Relever `images.timeoutMs` sans
 * relever le chien de garde était le piège à éviter : il se relève TOUT SEUL.
 * ⚠️ Et il doit rester AU-DESSOUS de `delegation.totalTimeoutMs` (75 min,
 * 4_500_000 ms, `src/config/schema.ts`) comme de la borne du tour de canal
 * (61 min 30 s) : le chien de garde est donc le PREMIER à parler quand un outil
 * ne rend jamais la main.
 */
export const DEFAULT_TOOL_WATCHDOG_MS = 960_000;

/**
 * MARGE entre le plafond de génération et le chien de garde (ms).
 *
 * ⚠️ Elle n'est pas décorative : la génération rend la main à son plafond, puis
 * il faut encore TÉLÉCHARGER le fichier et l'enregistrer. Sans marge, le chien
 * de garde couperait le job exactement au moment où la génération finit.
 */
export const TOOL_WATCHDOG_MARGIN_MS = 60_000;

/**
 * Chien de garde EFFECTIF : jamais sous `DEFAULT_TOOL_WATCHDOG_MS`, et toujours
 * `marge` au-dessus du plafond de génération configuré.
 *
 * ⚠️ C'est ce qui fait tenir l'invariant « aucune limite ne coupe un travail
 * encore légitime » SANS dépendre de la vigilance de qui règle les valeurs :
 * relever `images.timeoutMs` dans `/config` relève le chien de garde du job
 * suivant, à chaud.
 */
export function resolveToolWatchdogMs(
  generationCeilingMs: number,
  baseMs: number = DEFAULT_TOOL_WATCHDOG_MS,
): number {
  const ceiling = Number.isFinite(generationCeilingMs)
    ? Math.max(0, Math.trunc(generationCeilingMs))
    : 0;
  return Math.max(baseMs, ceiling + TOOL_WATCHDOG_MARGIN_MS);
}

/** Secondes lisibles d'une durée (jamais 0). */
function secondsUntil(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}

/**
 * Motif d'échec d'un job dont l'OUTIL n'a pas rendu la main.
 *
 * ⚠️ Le code lisible (`tool_timeout`) reste en tête pour que la délégation le
 * CLASSE (`src/delegation/service.ts`), et la phrase en français suit : sans
 * elle, le rapport ne portait que le mot « timeout » et le modèle léger
 * INVENTAIT une cause (« la machine n'a pas répondu »).
 */
export function toolWatchdogError(tool: string, ms: number): string {
  return (
    `tool_timeout : l'outil « ${tool} » n'a pas rendu la main en ${secondsUntil(ms)} s — ` +
    "le job a été interrompu pour ne pas rester bloqué. L'action a peut-être continué " +
    "côté machine : son état final n'est pas connu."
  );
}

/** Motif d'échec d'un job dont le délai d'INACTIVITÉ a expiré. */
export function idleTimeoutError(ms: number, lastTool = ""): string {
  const outil = lastTool !== "" ? ` (dernier outil : « ${lastTool} »)` : "";
  return (
    `idle_timeout : la tâche n'a plus donné signe de vie pendant ${secondsUntil(ms)} s${outil} — ` +
    "elle a été interrompue. Ce n'est PAS un échec de la machine distante."
  );
}

/** Motif d'échec d'un job ayant atteint son délai TOTAL. */
export function totalTimeoutError(ms: number): string {
  return (
    `timeout : délai total de la tâche dépassé (${secondsUntil(ms)} s) — la tâche a été ` +
    "interrompue. Une action lancée sur une machine a pu continuer : son état final " +
    "n'est pas connu."
  );
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
   * Port de génération d'IMAGES (serveur ComfyUI). Présent ⇒ le worker porte
   * `generer_image` et `consulter_workflow`.
   *
   * ⚠️ POURQUOI LE LOURD LES PORTE (lot 23) : une génération prend jusqu'à
   * `images.timeoutMs` (1 h par défaut), alors qu'un run de CANAL est borné
   * (`CHAT_REPLY_TIMEOUT_MS`, 90 s) ⇒ l'image y était avortée en plein vol, SANS
   * message. Le job, lui, n'a pas de borne de tour : c'est donc sa place.
   *
   * ⚠️ La conversation est FORCÉE à celle du léger (la session du job est
   * éphémère) : l'image copiée va dans le store du CANAL, et son identifiant
   * remonte jusqu'au rapport (`HeavyRunResult.fichiers`) qui la publie.
   */
  images?: HeavyImagePorts;
  /**
   * Fabrique de session éphémère. Injectable pour les TESTS (défaut :
   * `createEphemeralSession`). Permet d'exercer le câblage des outils d'action
   * sans modèle ni réseau.
   */
  createSession?: typeof createEphemeralSession;
  /**
   * BORNE des images transmises à CHAQUE appel modèle de la tâche (réglage
   * `files.imageRequestBudgetBytes`, relu à chaque job quand c'est une fonction).
   *
   * ⚠️ Une tâche peut lire PLUSIEURS images (`lire_fichier`, `recuperer_fichier`) :
   * sans cette borne, chacune repart dans chaque appel modèle de la boucle
   * d'outils, et le fournisseur finit par répondre `500 request entity too large`.
   * La vision reste active : l'image FRAÎCHE est toujours vue, les précédentes
   * deviennent un texte qui dit comment les revoir. Absent ⇒ pas de borne.
   */
  imageRequestBudgetBytes?: () => number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  /**
   * CHIEN DE GARDE d'un OUTIL : durée maximale pendant laquelle un seul appel
   * d'outil peut rester sans rendre la main (ms). Défaut
   * `DEFAULT_TOOL_WATCHDOG_MS` (16 min).
   *
   * ⚠️ Un FOURNISSEUR est accepté (et attendu du câblage) : il est relu à chaque
   * job, ce qui permet au chien de garde de suivre `images.timeoutMs` à chaud
   * (`resolveToolWatchdogMs`) sans redémarrage.
   *
   * ⚠️ POURQUOI IL EXISTE (production, 2026-11-02) : pendant qu'un outil
   * s'exécute, la session n'émet AUCUN événement — et le délai d'INACTIVITÉ
   * (`idleTimeoutMs`, 120 s) abattait donc tout job lançant une commande un peu
   * longue (« la tâche s'est interrompue sans jamais rendre la main »). Le délai
   * d'inactivité est maintenant SUSPENDU pendant un outil, et remplacé par cette
   * borne : un outil qui ne rend jamais fait ÉCHOUER le job PROPREMENT, avec un
   * message nommant l'outil et la durée, au lieu de le laisser bloqué.
   */
  toolWatchdogMs?: number | (() => number);
  logger: PiLogger;
}

/**
 * Ports d'IMAGE du worker lourd : MÊMES ports que le léger, à ceci près que la
 * conversation n'est pas lue du contexte de l'outil — elle est FORCÉE (la
 * session du job est ÉPHÉMÈRE), et la capacité VISION est celle du modèle
 * RÉSOLU du job (lue à l'exécution, jamais supposée).
 *
 * ⚠️ `onImage`/`onImageFinalPrompt` sont ABSENTS à dessein : il n'y a aucune
 * interface web à alimenter pour un job. Le LIVRABLE remonte par
 * `HeavyRunResult.fichiers` (copie dans le store de la conversation), sinon
 * l'image serait générée puis perdue.
 */
export type HeavyImagePorts = Omit<
  ImageToolPort,
  "sessionId" | "logger" | "consultation" | "onImage" | "onImageFinalPrompt" | "receivesImages"
>;

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
    "execution" | "screenshots" | "secrets" | "transfers" | "files" | "images"
  > & {
    /** Journal d'AUDIT des lectures de fichiers (facultatif : métadonnées seules). */
    logger?: PiLogger;
  },
  lightSessionId: string | undefined,
  vision?: HeavyActionToolVision,
  /**
   * Receveur des FICHIERS produits (image copiée dans le store de la conversation).
   * ⚠️ Sans lui, le worker générerait une image que le rapport ne transporterait
   * jamais : elle serait invisible pour la personne qui a demandé la tâche.
   */
  onFileProduced?: (fileId: string) => void,
  /**
   * ORIGINE du job (`declencheur:<nom>` pour une tâche de fond née d'un
   * déclencheur, absente sinon). 
   *
   * ⚠️ Elle est transmise aux outils d'ACTION, donc au garde-fou : c'est ce qui
   * permet à une tâche de fond de consommer une PRÉ-AUTORISATION (lot 26, lot
   * 4/4). Absente ⇒ un tour humain, qui ne consomme jamais rien.
   */
  origine?: string,
): ToolDefinition[] {
  const options: ActionToolOptions = {
    approvalSessionId: () => lightSessionId,
    ...(origine !== undefined ? { origine: () => origine } : {}),
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
  // ⚠️ AUCUN OUTIL DE PUBLICATION, et c'est STRUCTUREL : dans un canal il n'y a
  // qu'UN rédacteur, le tour de Yuki (`docs/lot18-chat.md`). Le worker REND un
  // résultat ; c'est Yuki qui décide quoi publier et où, et elle a pour cela
  // `publier_dans_canal` (`REMOTE_SAFE_TOOLS`) — pas lui.
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
  // ⚠️ IMAGES : la génération est une ACTION LONGUE (jusqu'à 1 h), donc sans
  // place dans un tour de canal mais parfaitement à sa place dans un job. La
  // conversation est FORCÉE à celle du léger : l'image est copiée dans le store
  // du CANAL, et l'identifiant produit REMONTE au rapport par `onFileProduced`.
  // ⚠️ Aucun outil à approbation n'est ajouté ici : `generer_image` n'en exige
  // aucune (`APPROVAL_REQUIRED_TOOLS`, `src/llm/tool-policy.ts`).
  if (config.images) {
    const archive = config.images.archive;
    tools.push(
      ...createImageTools({
        ...config.images,
        sessionId: () => lightSessionId,
        // ⚠️ Journal du worker : c'est là que le COMPTEUR de consultations
        // (`comfy.workflow.consulted`) est exposé en production. Sans lui, une
        // génération de job serait silencieuse côté observabilité.
        ...(config.logger ? { logger: config.logger } : {}),
        ...(vision !== undefined
          ? { receivesImages: () => vision.imagesSupported }
          : {}),
        ...(archive
          ? {
              archive: {
                archive: (input) => {
                  const outcome = archive.archive(input);
                  if (outcome.ok) onFileProduced?.(outcome.file.id);
                  return outcome;
                },
              },
            }
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
    // ⚠️ FICHIERS produits par CE job : ils sont rendus au service de délégation
    // (`HeavyRunResult.fichiers`), journalisés avec le résultat, puis publiés
    // dans le canal par le réveil. Sans ce fil, `generer_image` produirait une
    // image dans le store que personne ne verrait jamais.
    const fichiers: string[] = [];
    const onFileProduced = (fileId: string): void => {
      if (fileId === "" || fichiers.includes(fileId)) return;
      fichiers.push(fileId);
    };
    try {
      // Outils d'ACTION rattachés à la CONVERSATION PROPRIÉTAIRE (jamais à
      // l'ID éphémère) : la validation humaine remonte donc dans la bonne
      // conversation.
      const actionTools = buildHeavyActionTools(
        config,
        request.lightSessionId,
        {
          modelLabel: modelReference,
          // ⚠️ Capacité lue sur le modèle RÉSOLU (donc sur `models.json` à cet
          // instant) : un modèle texte seul ne reçoit jamais d'image, même si le
          // réglage changeait en cours de route.
          imagesSupported: sdkModelSupportsImages(model),
        },
        onFileProduced,
        request.origine,
      );
      ephemeral = await (config.createSession ?? createEphemeralSession)({
        cwd: config.cwd,
        agentDir: config.agentDir,
        systemPrompt: config.systemPrompt,
        modelRuntime: runtime,
        model,
        thinkingLevel: liveValue(config.thinking),
        tools: config.tools,
        ...(actionTools.length > 0 ? { customTools: actionTools } : {}),
        // ⚠️ MÊME BORNE D'IMAGES QUE LA SESSION LÉGÈRE (`sdk-host.ts`) : une
        // tâche qui lit trois images les ferait sinon repartir toutes les trois
        // dans chaque appel modèle de sa boucle d'outils.
        ...(config.imageRequestBudgetBytes !== undefined
          ? {
              extensionFactories: [
                createImageBudgetExtensionFactory({
                  budgetBytes: config.imageRequestBudgetBytes,
                  logger: config.logger,
                }),
              ],
            }
          : {}),
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
    /** Outil qui a dépassé le chien de garde (nom + borne appliquée). */
    let toolTimedOut: { name: string; ms: number } | undefined;

    let idleTimer: NodeJS.Timeout | undefined;
    const clearIdle = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    // ── Outils EN COURS : l'inactivité est SUSPENDUE, un chien de garde la remplace
    // ⚠️ Un outil en vol n'est pas de l'inactivité : `run_command` peut durer
    // `MAX_COMMAND_TIMEOUT_MS` (15 min, `src/agents/execution.ts`) sans qu'aucun
    // événement de session ne soit émis. Suspendre `idleTimeoutMs` pendant ce
    // temps est ce qui rend une commande longue POSSIBLE ; le chien de garde
    // garde la garantie « ça ne reste jamais bloqué ».
    let toolsInFlight = 0;
    let lastToolName = "";
    let toolWatchdog: NodeJS.Timeout | undefined;
    // ⚠️ Peut être un NOMBRE ou un FOURNISSEUR (relu à chaque job) : le câblage
    // (`src/index.ts`) y met `resolveToolWatchdogMs(images.timeoutMs)`, qui suit
    // donc à chaud le plafond de génération.
    const toolWatchdogMs = Math.max(
      1,
      Math.trunc(
        typeof config.toolWatchdogMs === "function"
          ? config.toolWatchdogMs()
          : (config.toolWatchdogMs ?? DEFAULT_TOOL_WATCHDOG_MS),
      ),
    );
    const clearToolWatchdog = (): void => {
      if (toolWatchdog) {
        clearTimeout(toolWatchdog);
        toolWatchdog = undefined;
      }
    };
    const armToolWatchdog = (name: string): void => {
      clearToolWatchdog();
      toolWatchdog = setTimeout(() => {
        toolTimedOut = { name, ms: toolWatchdogMs };
        config.logger.warn("heavy.tool.watchdog", {
          job_id: request.jobId,
          tool: name,
          tool_watchdog_ms: toolWatchdogMs,
        });
        abort();
      }, toolWatchdogMs);
      toolWatchdog.unref?.();
    };
    const beginTool = (name: string): void => {
      toolsInFlight += 1;
      lastToolName = name;
      // ⚠️ Plus d'inactivité du modèle à mesurer : c'est le MODÈLE qui attend
      // l'outil, pas l'inverse.
      clearIdle();
      armToolWatchdog(name);
    };
    const endTool = (): void => {
      toolsInFlight = Math.max(0, toolsInFlight - 1);
      if (toolsInFlight > 0) return;
      clearToolWatchdog();
      // Le tour reprend : le compte d'inactivité repart de zéro à partir d'ici.
      resetIdle();
    };

    const resetIdle = (): void => {
      // ⚠️ Pendant un outil, `idleTimeoutMs` ne s'applique PAS (voir ci-dessus).
      if (toolsInFlight > 0) return;
      clearIdle();
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
        toolName?: unknown;
      };
      switch (event.type) {
        // ⚠️ OUTILS : suivis AVANT tout autre traitement (ils suspendent le
        // délai d'inactivité). `heavy.tool.start/end` est journalisé pour que
        // l'attente longue soit traçable côté serveur.
        case "tool_execution_start": {
          const name = typeof event.toolName === "string" ? event.toolName : "(outil inconnu)";
          config.logger.info("heavy.tool.start", {
            job_id: request.jobId,
            tool: name,
          });
          beginTool(name);
          return;
        }
        case "tool_execution_end": {
          const name = typeof event.toolName === "string" ? event.toolName : "(outil inconnu)";
          config.logger.info("heavy.tool.end", {
            job_id: request.jobId,
            tool: name,
            outils_en_cours: toolsInFlight - 1,
          });
          endTool();
          return;
        }
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
      clearIdle();
      clearToolWatchdog();
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
    }

    const finalText = lastText || currentText;
    state.finished = true;
    session.dispose();

    // ⚠️ Le worker ne PUBLIE RIEN (invariant « un seul rédacteur ») : tout ce qu'il a
    // produit sort par le RÉSULTAT (`HeavyRunResult.fichiers`), et c'est le tour de
    // Yuki — réveillé par le rapport — qui décide de le publier ici ou ailleurs.
    const texteFinal = finalText;
    const partial = texteFinal.length > 0 ? texteFinal : undefined;
    // ⚠️ Les fichiers produits sortent quel que soit le statut final : un job
    // interrompu après une génération réussie ne doit pas perdre l'image (le serveur
    // ComfyUI l'a bien produite).
    const produits = fichiers.length > 0 ? { fichiers: [...fichiers] } : {};
    if (isCancelled()) {
      return {
        status: "cancelled",
        ...(partial ? { partial } : {}),
        ...produits,
      };
    }
    if (totalTimedOut) {
      return {
        status: "failed",
        error: totalTimeoutError(config.totalTimeoutMs),
        ...(partial ? { partial } : {}),
        ...(usage ? { usage } : {}),
        ...produits,
      };
    }
    if (toolTimedOut) {
      return {
        status: "failed",
        error: toolWatchdogError(toolTimedOut.name, toolTimedOut.ms),
        ...(partial ? { partial } : {}),
        ...(usage ? { usage } : {}),
        ...produits,
      };
    }
    if (idleTimedOut) {
      return {
        status: "failed",
        error: idleTimeoutError(config.idleTimeoutMs, lastToolName),
        ...(partial ? { partial } : {}),
        ...(usage ? { usage } : {}),
        ...produits,
      };
    }
    if (sawError) {
      return {
        status: "failed",
        error: errorMessage ?? "erreur du worker lourd",
        ...(partial ? { partial } : {}),
        ...(usage ? { usage } : {}),
        ...produits,
      };
    }
    return {
      status: "completed",
      text: texteFinal,
      ...(usage ? { usage } : {}),
      ...produits,
    };
  }
}
