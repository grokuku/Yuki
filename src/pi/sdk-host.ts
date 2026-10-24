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
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionRuntime,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  isSyntheticOrigin,
  ORIGIN_RECAP,
  SYNTHETIC_USER_PREFIXES,
} from "./synthetic.js";
import { parseRecapPrompt } from "../recap/prompt.js";

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
  errorTextFromMessage,
  finishReasonForMessage,
  messageTimestamp,
  RUN_METRICS_CUSTOM_TYPE,
  sanitizeErrorText,
  transcriptFromEntries,
  unstreamedContentSuffix,
  usageFromMessage,
  type RawAgentMessage,
  type RawAssistantMessageEvent,
} from "./events.js";
import { describeModelError, PiHostError, toPiHostError } from "./errors.js";
import { buildStoredUserText, stripTimestampPrefix } from "./timestamp.js";
import type { PiHost } from "./host.js";
import { PHASE, RunInstrumentation, type RunSummary, type RunTtsMetrics } from "./instrumentation.js";
import { createDelegateTools, createRunContextTracker } from "./sdk/delegate-tools.js";
import {
  createDelegationExtensionFactory,
  type PendingJobEntry,
} from "./sdk/delegation-extension.js";
import {
  createAgentDirectoryTools,
  createExecutionTools,
  createScreenshotTool,
  createSecretRequestTool,
  createSecretTools,
} from "./sdk/execution-tools.js";
import {
  getSharedModelRuntime,
  refreshSharedModelRuntime,
  resolveSdkModel,
  resolveSdkThinking,
  type SdkModel,
} from "./sdk/model-runtime.js";
import { createLightRuntime } from "./sdk/session-factory.js";
import { createAgentRosterExtensionFactory } from "./sdk/agent-roster-extension.js";
import { createMemoryExtensionFactory } from "./sdk/memory-extension.js";
import { createReactionsExtensionFactory } from "./sdk/reactions-extension.js";
import { createPersonalityExtensionFactory } from "./sdk/personality-extension.js";
import { createRulesExtensionFactory } from "./sdk/rules-extension.js";
import { createHeritageExtensionFactory } from "./sdk/heritage-extension.js";
import { createHeritageTools } from "./sdk/heritage-tools.js";
import { createConversationArchiveTools } from "./sdk/conversation-archive-tools.js";
import type {
  ArchivedConversation,
  ArchivedMessage,
} from "../memory/conversation-archive.js";
import { createLibrarianTools } from "./sdk/librarian-tools.js";
import type {
  ApplyLlmConfigOptions,
  CompactOptions,
  CompactOutcome,
  PiEvent,
  PiEventListener,
  PiHostOptions,
  PiSessionStateName,
  PiThinkingLevel,
  PiUsage,
  RunFinishReason,
  RunHandle,
  RunMetrics,
  SendOptions,
  SessionInfo,
  SessionState,
  TranscriptEntry,
} from "./types.js";

/** Bornes de sérialisation de l'abort derrière l'envoi en vol. */
const ABORT_SERIALIZE_TIMEOUT_MS = 2_000;

/**
 * Sous-dossier de MISE DE CÔTÉ d'une conversation supprimée. `SessionManager.list`
 * et `findMostRecentSession` font un `readdir` NON récursif : ce dossier est donc
 * invisible à la liste ET jamais repris au démarrage — un fil écarté ne peut pas
 * réapparaître, et reste récupérable à la main (chemin horodaté).
 */
const ASIDE_DIR = "conversations-supprimees";

/** Plafond de `listSessions()` : les N sessions les plus récentes suffisent à l'UI. */
const MAX_SESSIONS = 50;

/**
 * Nombre minimal de messages pour qu'une compaction forcée ait un sens : sans au
 * moins un échange, il n'y a RIEN à résumer. On le refuse AVANT toute passe de
 * mémoire (message clair plutôt qu'un succès vide).
 */
const COMPACT_MIN_MESSAGES = 2;

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
  /**
   * Le message utilisateur a DÉJÀ été versé au transcript (cas d'un message
   * livré en `steer` à un run en cours). Évite une double bulle si le message
   * doit finalement repasser par un tour normal (repli).
   */
  transcriptPushed?: boolean;
  /** Message d'erreur AFFICHABLE (français, mappé) pour l'UI. */
  errorMessage?: string;
  /** Cause BRUTE du fournisseur (assainie, sans secret) pour les journaux. */
  rawError?: string;
  usage?: PiUsage;
  /**
   * Dernière entrée de transcript ASSISTANT produite par ce run (contenu non
   * vide). Sert à rattacher les statistiques d'exécution (`run_metrics`) à
   * l'entrée de session réellement persistée dont elle est le miroir. Reste
   * `undefined` quand le run n'a rien produit d'affichable (erreur, abandon,
   * réponse vide) ⇒ aucune métrique n'est écrite (jamais d'entrée orpheline).
   *
   * ⚠️ Un MÊME run peut produire PLUSIEURS messages assistant (suite après un
   * steer UTILISATEUR, tour d'outil). Le client ne crée qu'UN SEUL bloc par run
   * (le flux n'expose aucune frontière de message) : `assistantEntry` est donc
   * FUSIONNÉE (texte concaténé) pour que le snapshot et le rechargement
   * racontent la MÊME chose que le direct. `lastAssistantText`, lui, porte le
   * texte du DERNIER message persisté par le SDK (contrôle d'intégrité de
   * `persistRunMetrics`).
   */
  assistantEntry?: TranscriptEntry;
  /** Texte du DERNIER message assistant persisté par le SDK au titre de ce run. */
  lastAssistantText?: string;
  resolveStart?: () => void;
  startPromise: Promise<void>;
}

interface SessionRecord {
  sessionId: string;
  /**
   * Runtime PROPRE à cette conversation (E0). Chaque session vivante possède
   * SON `AgentSessionRuntime` (donc ses services et ses extensions inline) :
   * c'est ce qui permet à plusieurs conversations d'avoir un run EN VOL
   * simultanément sans qu'aucune ne soit tuée au changement de focus.
   */
  runtime: AgentSessionRuntime;
  session: AgentSession;
  unsubscribe: () => void;
  state: PiSessionStateName;
  activeRunId?: string;
  transcript: TranscriptEntry[];
  partial: string;
  listeners: Set<PiEventListener>;
  queue: RunItem[];
  currentRun?: RunItem;
  /**
   * ⚠️ FILET « PAS DE STEER ORPHELIN » (parité Pi-Web) : messages UTILISATEUR
   * livrés en `steer` à un run EN COURS et pas encore connus comme consommés.
   * À la fin du run, ceux encore présents dans la file du SDK sont REJOUÉS
   * immédiatement comme un tour neuf (jamais attendre le rapport d'un job).
   */
  pendingUserSteers: RunItem[];
}

function newRunId(): string {
  return randomUUID();
}

/**
 * Cause BRUTE d'une erreur, assainie (jamais de clé/token) et non vide, ou
 * `undefined`. Utilisée pour journaliser le motif réel d'un rejet de prompt.
 */
function sanitizedCause(error: unknown): string | undefined {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : undefined;
  if (raw === undefined) return undefined;
  const sanitized = sanitizeErrorText(raw).trim();
  return sanitized.length > 0 ? sanitized : undefined;
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
    ...(isSyntheticOrigin(opts.origin) ? { synthetic: true } : {}),
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
 * L'ORDRE est le contrat : **règles (consignes de l'utilisateur) → personnalité
 * (base) → mémoire → annuaire des agents → heritage**. Le SDK chaîne les
 * extensions qui renvoient `systemPrompt` ; chacune CONCATÈNE au prompt courant,
 * donc un ordre inversé ferait passer un bloc APRÈS un autre sans l'écraser
 * (mais changerait le sens donné au modèle). Cette fonction est extraite pour
 * être VERROUILLÉE par un test d'ordre (voir
 * `tests/pi/personality-extension.test.ts`).
 */
export function buildInlineExtensions(
  options: Pick<
    PiHostOptions,
    "rules" | "personality" | "memory" | "directory" | "heritage" | "reactions" | "logger"
  >,
): InlineExtension[] {
  const extensionFactories: InlineExtension[] = [];
  if (options.rules) {
    // EN PREMIER : les règles strictes de l'utilisateur précèdent tout le reste
    // (priorité règles > personnalité > mémoire).
    extensionFactories.push(
      createRulesExtensionFactory(options.rules, {
        logger: options.logger,
      }),
    );
  }
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
  if (options.reactions) {
    // RÉACTIONS de l'utilisateur : DONNÉE de retour injectée dans le prompt
    // système du tour suivant (bornée aux N dernières). En DERNIER : elle
    // n'écrase rien, elle s'ajoute après la mémoire, l'annuaire et l'archive.
    extensionFactories.push(createReactionsExtensionFactory(options.reactions));
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

  let settingsManager: SettingsManager | undefined;
  let modelRuntime: Awaited<ReturnType<typeof getSharedModelRuntime>> | undefined;
  let resolvedModel: SdkModel | undefined;
  let resolvedThinking: PiThinkingLevel | undefined;
  /** Config PARTAGÉE par tous les runtimes (résolue une fois dans `doStart`). */
  let customTools: ToolDefinition[] = [];
  let extensionFactories: InlineExtension[] = [];
  /**
   * Conversation FOCALISÉE (celle que l'UI suit). E0 : le focus n'est qu'un
   * POINTEUR — le changer ne tue plus le run d'une autre conversation.
   */
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
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
      ...(entry.metrics !== undefined ? { metrics: entry.metrics } : {}),
      ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
      ...(entry.subject !== undefined ? { subject: entry.subject } : {}),
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
            // ⚠️ Un prompt synthétique (report de job, résultat de commande
            // validée) ne diffuse JAMAIS son texte comme `userText` : il
            // entrerait sinon dans le buffer de rejeu / le snapshot et
            // ferait fuiter la sortie d'une machine dans l'historique.
            ...(isSyntheticOrigin(run.origin) ? {} : { userText: run.text }),
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
        if (finishReason === "error") {
          run.sawError = true;
          // ⚠️ LA CAUSE EST ICI. Le SDK pose le message BRUT du fournisseur
          // (statut HTTP + corps) sur `message.errorMessage` ; sans cette
          // reprise, l'échec sortait sans AUCUNE cause (`stage=error` muet,
          // UI générique). On assainit (jamais de clé/token) et on journalise
          // la cause brute ; le message d'affichage est mappé en français.
          const rawError = errorTextFromMessage(message);
          if (rawError && !run.rawError) {
            run.rawError = rawError;
            run.errorMessage = describeModelError(rawError);
            logger.warn("pi.run.error", {
              session_id: record.sessionId,
              run_id: run.runId,
              error: rawError,
            });
          }
        }
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
          // ⚠️ CONTINUITÉ D'UN MÊME RUN — le client ne crée qu'UN SEUL bloc par
          // run : le flux de deltas n'expose AUCUNE frontière de message, donc
          // un 2e message assistant du même run (suite après un steer
          // UTILISATEUR, tour d'outil) serait rendu dans le MÊME bloc que le
          // précédent. Le snapshot/rechargement DOIT refléter exactement ce
          // bloc unique : on FUSIONNE le texte dans la même entrée de
          // transcript (au lieu d'en pousser une seconde, qui afficherait deux
          // bulles et couperait une fence de code ouverte).
          const previous = record.transcript[record.transcript.length - 1];
          if (run.assistantEntry && previous === run.assistantEntry) {
            run.assistantEntry.text += text;
          } else {
            const assistantEntry: TranscriptEntry = {
              role: "assistant",
              text,
              timestamp: messageTimestamp(message) ?? Date.now(),
            };
            record.transcript.push(assistantEntry);
            // Miroir de l'entrée de session que le SDK vient de persister : elle
            // recevra les statistiques (`run_metrics`) si le run se termine bien.
            run.assistantEntry = assistantEntry;
          }
          // Texte du DERNIER message persisté : contrôle d'intégrité séparé de
          // l'entrée d'affichage (qui peut être une FUSION de plusieurs messages).
          run.lastAssistantText = text;
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

  function attachRecord(runtime: AgentSessionRuntime): SessionRecord {
    const session = runtime.session;
    const record: SessionRecord = {
      sessionId: session.sessionId,
      runtime,
      session,
      unsubscribe: () => undefined,
      state: "idle",
      transcript: restoreTranscript(session),
      partial: "",
      listeners: new Set(),
      queue: [],
      pendingUserSteers: [],
    };
    record.unsubscribe = session.subscribe((event) => {
      handleSdkEvent(record, event);
    });
    sessions.set(record.sessionId, record);
    return record;
  }

  /**
   * Retire une session du registre et FERME son runtime (services, extensions,
   * ressources) ⇒ aucun runtime orphelin. Asynchrone : `dispose()` l'est.
   */
  async function detachRecord(record: SessionRecord): Promise<void> {
    try {
      record.unsubscribe();
    } catch {
      // ignore
    }
    sessions.delete(record.sessionId);
    try {
      await record.runtime.dispose();
    } catch (error) {
      logger.warn("pi.session.dispose.failed", {
        session_id: record.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * E5 — Interroge la VÉRITÉ de complétion (port de délégation → `JobStore`).
   * Ne lève JAMAIS : une erreur de lecture est journalisée et traitée comme
   * « pas de travail en attente » (on ne bloque pas un tour pour un diagnostic).
   */
  function hasPendingWork(sessionId: string): boolean {
    try {
      return options.delegation?.hasPendingWork(sessionId) ?? false;
    } catch (error) {
      logger.warn("pi.pending_work.query.failed", {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * E5 — Quand un job atteint un état terminal, on recalcule l'état de sa
   * session SI aucun run n'est en vol (un run en vol reprendra la main à sa fin
   * via `finalizeRun`). Différé d'une microtâche : le report du job (qui reste
   * « du travail non achevé » tant qu'il n'est pas livré) est mis en lot JUSTE
   * APRÈS l'événement terminal.
   */
  function scheduleWaitingRefresh(event: PiEvent): void {
    if (event.type !== "job_finished") return;
    const sessionId = event.sessionId;
    queueMicrotask(() => {
      const record = sessions.get(sessionId);
      if (!record || record.currentRun) return;
      const next: PiSessionStateName = hasPendingWork(record.sessionId)
        ? "waiting"
        : record.state === "error"
          ? "error"
          : "idle";
      if (record.state === next) return;
      record.state = next;
      if (next !== "waiting") record.activeRunId = undefined;
      emitEvent({ type: "state", sessionId: record.sessionId, state: next });
    });
  }

  /**
   * E4/relais — Jobs d'arrière-plan NON terminaux de CETTE conversation, lus
   * dans le `JobStore` (source de vérité : `job_id`, intitulé, statut
   * `queued`/`running`). C'est cette information qui est injectée dans le prompt
   * du léger (via l'extension de relais) pour qu'il sache QUOI relayer. Une
   * lecture en échec est journalisée et traitée comme « aucun job ».
   */
  function activeJobsFor(sessionId: string): PendingJobEntry[] {
    if (!options.delegation) return [];
    try {
      return options.delegation.pendingJobs(sessionId).map((job) => ({
        jobId: job.jobId,
        task: job.task,
        status: job.status,
      }));
    } catch (error) {
      logger.warn("delegation.pending_jobs.query.failed", {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * ⚠️ FILET DÉTERMINISTE « PAS DE STEER ORPHELIN » — le correctif qui aurait
   * sauvé le scénario réel : la demande de l'utilisateur arrivée PENDANT un run
   * n'était lue qu'au rapport du job, donc trop tard.
   *
   * Un message UTILISATEUR livré en `steer` peut ne PAS être consommé avant la
   * fin du run (`runLoop` ne polle la file de steering qu'au début d'un tour et
   * entre deux tours). Sans ce filet, il ne serait lu qu'au PROCHAIN tour — en
   * pratique le rapport d'un job, donc après la fin du travail. On le détecte
   * ICI, à la fin du run, et on le REJOUE immédiatement comme un tour neuf.
   *
   * Source de vérité : la file de steering du SDK (`getSteeringMessages`), purgée
   * à la livraison de chaque message. La livraison étant FIFO, les messages
   * ENCORE en attente sont la QUEUE des steers suivis : on ne rejoue jamais un
   * steer déjà consommé.
   */
  function drainOrphanUserSteers(record: SessionRecord): RunItem[] {
    const tracked = record.pendingUserSteers;
    record.pendingUserSteers = [];
    if (tracked.length === 0) return [];
    let pending: readonly string[] | undefined;
    try {
      pending = record.session.getSteeringMessages();
    } catch {
      // Session de test sans file de steering : rien d'orphelin à récupérer.
      pending = undefined;
    }
    if (!pending || pending.length === 0) return [];
    const count = Math.min(pending.length, tracked.length);
    const orphans = tracked.slice(tracked.length - count);
    // Purge la file du SDK : ces textes vont être REJOUÉS comme tours neufs ; les
    // laisser en file les injecterait DEUX fois (prompt + steer).
    try {
      record.session.clearQueue();
    } catch {
      // ignore : on a déjà nos textes, la purge est une optimisation.
    }
    return orphans;
  }

  /**
   * Rejoue un message UTILISATEUR orphané comme un TOUR NEUF : nouvel `runId` et
   * instrumentation FRAÎCHE (le temps d'attente ne doit pas gonfler les stats du
   * tour rejoué). Le message reste UN VRAI message : `transcriptPushed` est
   * conservé (déjà versé au transcript à l'instant du steer, jamais dupliqué) et
   * `storedText`/`sentAt` d'origine sont repris (même horodatage), de sorte que le
   * SDK le persiste une seule fois, inchangé, à sa consommation.
   */
  function reissueUserRun(record: SessionRecord, run: RunItem): RunItem {
    const next = makeRunItem(
      newRunId(),
      run.text,
      record.sessionId,
      logger,
      emitEvent,
      run.origin !== undefined ? { origin: run.origin } : {},
    );
    next.storedText = run.storedText;
    next.sentAt = run.sentAt;
    next.transcriptPushed = true;
    return next;
  }

  function finalizeRun(
    record: SessionRecord,
    run: RunItem,
    reason: RunFinishReason,
  ): void {
    run.instrumentation.setUsage(run.usage);
    // ⚠️ Un `stage=error` DOIT porter sa cause (brute, assainie) : c'est ce qui
    // manquait et qui a rendu un échec réel indiagnosticable.
    run.instrumentation.complete(
      reason,
      run.rawError ? { error: run.rawError } : {},
    );
    // ⚠️ IDENTIFIANT DE CORRÉLATION (réactions) : celui de l'entrée de session
    // RÉELLEMENT persistée par ce run — le MÊME dont les statistiques sont
    // l'enfant (`parentId`). Aucun second identifiant n'est inventé : c'est ce
    // qui garantit qu'une réaction reste attachée au BON message.
    if (run.assistantEntry && !run.assistantEntry.id) {
      const entryId = resolveAssistantEntryId(record, run);
      if (entryId) run.assistantEntry.id = entryId;
    }
    emitEvent({
      type: "run_finished",
      sessionId: record.sessionId,
      runId: run.runId,
      reason,
      ...(run.usage ? { usage: run.usage } : {}),
      ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
      ...(run.assistantEntry?.id ? { entryId: run.assistantEntry.id } : {}),
    });
    // Les statistiques temps réel (`run_summary`) et celles PERSISTÉES doivent
    // être EXACTEMENT les mêmes : on réutilise la synthèse déjà émise.
    const summary = run.instrumentation.emitSummary();
    persistRunMetrics(record, run, reason, summary);

    record.currentRun = undefined;
    record.activeRunId = undefined;
    record.partial = "";
    // ⚠️ E5 — VERROU ANTI-MENSONGE : la vérité de complétion vit dans le
    // `JobStore`, JAMAIS dans le texte du modèle. Tant qu'il reste du travail
    // NON achevé pour cette session (job non terminal ou résultat pas encore
    // livré), l'état affiché est `waiting` — même si l'assistant vient d'écrire
    // « c'est fait ». Le badge UI ne disparaît qu'à la livraison du résultat.
    const outstanding = hasPendingWork(record.sessionId);
    record.state =
      reason === "error" ? "error" : outstanding ? "waiting" : "idle";
    runContext.clear(record.sessionId);
    emitEvent({
      type: "state",
      sessionId: record.sessionId,
      state: record.state,
    });

    // ⚠️ FILET « PAS DE STEER ORPHELIN » : un message utilisateur non consommé à
    // la fin du run rouvre un tour TOUT DE SUITE (jamais attendre le rapport du
    // job). PRIORITAIRE sur la file : c'est ce que l'utilisateur vient d'écrire.
    const orphans = drainOrphanUserSteers(record);
    if (orphans.length > 0) {
      const reissued = orphans.map((orphan) => reissueUserRun(record, orphan));
      const [first, ...rest] = reissued;
      if (rest.length > 0) record.queue.unshift(...rest);
      void startRun(record, first);
      return;
    }

    const next = record.queue.shift();
    if (next) {
      void startRun(record, next);
    }
  }

  /**
   * Identifiant de l'ENTRÉE DE SESSION qui porte le message assistant affiché par
   * ce run, ou `undefined`.
   *
   * ⚠️ C'est la SEULE corrélation admise pour une réaction : le même identifiant
   * que celui dont les statistiques sont l'enfant via `parentId`. On le lit dans
   * la branche RÉELLE du SDK, jamais dans un compteur local (un index d'affichage
   * se décale dès qu'un message est ajouté).
   *
   * Le message au bout de la branche est d'abord essayé (cas normal : le SDK
   * vient de le persister). À défaut — fin de tour sur un appel d'outil sans
   * texte, entrée `custom` ajoutée après coup, compaction automatique — on
   * remonte la branche pour retrouver le DERNIER message assistant dont le
   * contenu est EXACTEMENT celui qui est affiché. Aucune correspondance ⇒
   * `undefined` (jamais d'identifiant approximatif : une réaction sur le mauvais
   * message apprendrait au modèle le contraire).
   */
  function resolveAssistantEntryId(
    record: SessionRecord,
    run: RunItem,
  ): string | undefined {
    const expected = run.lastAssistantText ?? run.assistantEntry?.text;
    if (expected === undefined) return undefined;
    const manager = record.session.sessionManager;
    const matchOf = (raw: unknown): string | undefined => {
      if (!raw || typeof raw !== "object") return undefined;
      const entry = raw as { type?: unknown; id?: unknown; message?: unknown };
      if (entry.type !== "message" || typeof entry.id !== "string") {
        return undefined;
      }
      const message = entry.message as RawAgentMessage | undefined;
      if (!message || message.role !== "assistant") return undefined;
      return contentTextFromMessage(message) === expected ? entry.id : undefined;
    };
    try {
      const fromLeaf = matchOf(manager.getLeafEntry());
      if (fromLeaf) return fromLeaf;
      const branch: readonly unknown[] = manager.getBranch();
      for (let index = branch.length - 1; index >= 0; index -= 1) {
        const id = matchOf(branch[index]);
        if (id) return id;
      }
    } catch (error) {
      logger.warn("pi.run.entry_id.failed", {
        session_id: record.sessionId,
        run_id: run.runId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
    return undefined;
  }

  /**
   * Persiste les statistiques d'exécution du run dans le JSONL de session, sous
   * forme d'une entrée `custom` (`yuki.run_metrics`) ENFANT (`parentId`) de
   * l'entrée de message assistant que le SDK vient d'écrire.
   *
   * ⚠️ GARDE D'ÉPHÉMÉRITÉ — on n'écrit QUE si un message assistant a été
   * RÉELLEMENT persisté par ce run :
   *   - `reason === "done"` (pas d'erreur, pas d'abandon) ;
   *   - `run.assistantEntry` existe (le run a produit un contenu d'affichage) ;
   *   - le dernier enfant de la branche est BIEN ce message assistant, avec le
   *     même texte que celui affiché. Sinon l'entrée serait ORPHELINE (une
   *     métrique sans message) : on n'écrit rien.
   *
   * Le `data` ne contient QUE des NOMBRES (`ttftMs`, `totalMs`, `tokensOut`) :
   * jamais le prompt, jamais de texte. Un échec d'écriture est journalisé et
   * n'interrompt JAMAIS le run.
   */
  function persistRunMetrics(
    record: SessionRecord,
    run: RunItem,
    reason: RunFinishReason,
    summary: RunSummary,
  ): void {
    if (reason !== "done") return;
    const assistant = run.assistantEntry;
    if (!assistant) return;
    try {
      const manager = record.session.sessionManager;
      const leaf = manager.getLeafEntry() as
        | { type?: unknown; id?: unknown; message?: unknown }
        | undefined;
      if (!leaf || leaf.type !== "message") return;
      const message = leaf.message as RawAgentMessage | undefined;
      if (!message || message.role !== "assistant") return;
      // Le message au bout de la branche DOIT être celui de ce run : on compare
      // le contenu autoritatif au DERNIER message persisté du run (jamais au
      // texte d'affichage FUSIONNÉ, qui peut concaténer plusieurs messages). Une
      // divergence (message antérieur, réponse vide, extension) ⇒ on n'écrit
      // rien plutôt qu'une métrique orpheline.
      const expected = run.lastAssistantText ?? assistant.text;
      if (contentTextFromMessage(message) !== expected) return;
      if (!Number.isFinite(summary.totalMs)) return;
      const data: RunMetrics = { totalMs: summary.totalMs };
      if (summary.ttftMs !== undefined && Number.isFinite(summary.ttftMs)) {
        data.ttftMs = summary.ttftMs;
      }
      if (summary.tokensOut !== undefined && Number.isFinite(summary.tokensOut)) {
        data.tokensOut = summary.tokensOut;
      }
      manager.appendCustomEntry(RUN_METRICS_CUSTOM_TYPE, data);
      // Le miroir en mémoire porte les mêmes statistiques : un snapshot de la
      // session COURANTE les affiche sans attendre un rechargement.
      assistant.metrics = data;
    } catch (error) {
      logger.warn("pi.run.metrics.persist.failed", {
        session_id: record.sessionId,
        run_id: run.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function startRun(record: SessionRecord, run: RunItem): Promise<void> {
    record.currentRun = run;
    record.activeRunId = run.runId;
    record.state = "streaming";
    // Un prompt synthétique (report de job, résultat de commande validée) ne
    // doit pas produire de bulle utilisateur dans le transcript de l'UI.
    if (!isSyntheticOrigin(run.origin) && !run.transcriptPushed) {
      record.transcript.push({
        role: "user",
        text: run.text,
        timestamp: run.sentAt,
      });
      run.transcriptPushed = true;
    } else if (run.origin === ORIGIN_RECAP && !run.transcriptPushed) {
      // ⚠️ RÉCAPITULATIF GÉNÉRÉ : il ne produit PAS de bulle utilisateur, mais il
      // doit être VISIBLE dans la nouvelle conversation. On pousse un bloc dédié
      // (`role: "recap"`) portant le corps VERBATIM et la référence à l'origine.
      const parsed = parseRecapPrompt(run.storedText ?? run.text);
      if (parsed) {
        record.transcript.push({
          role: "recap",
          text: parsed.recap,
          timestamp: run.sentAt,
          ...(parsed.originTitle ? { origin: parsed.originTitle } : {}),
          ...(parsed.subject ? { subject: parsed.subject } : {}),
        });
      }
      run.transcriptPushed = true;
    }
    runContext.set({ sessionId: record.sessionId, runId: run.runId });
    emitEvent({
      type: "state",
      sessionId: record.sessionId,
      state: "streaming",
      activeRunId: run.runId,
    });

    try {
      // Modèle à jour pour CE run : un changement de modèle (apply: hot) prend
      // effet ICI, entre deux runs — sans jamais interrompre le run précédent.
      // Condition SYNCHRONE : aucun surcoût quand rien n'a changé.
      if (needsModelSwitch(record)) {
        await ensureRecordModel(record);
      }
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
      // Cause BRUTE du SDK/du fournisseur : `toPiHostError` la conserve dans
      // `cause` sous forme d'objet `Error`. On la remonte (assainie) car c'est
      // elle qui rend l'échec diagnosticable.
      const rawCause = sanitizedCause(piError.cause);
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
        ...(rawCause ? { error: rawCause } : {}),
      });
      run.sawError = true;
      // Message d'affichage UTILE : la cause brute du SDK est mappée en français
      // (crédit/auth/débit/indisponibilité) ; à défaut, le message de façade.
      run.rawError = rawCause ?? piError.message;
      run.errorMessage = rawCause
        ? describeModelError(rawCause)
        : piError.message;
      finalizeRun(record, run, "error");
      return;
    }

    if (run.sawError && !run.errorMessage) {
      // Erreur signalée par le flux SDK sans message exploitable : on dit ce
      // qu'on SAIT (le modèle n'a rien produit), sans inventer de cause.
      run.errorMessage = describeModelError(run.rawError);
    }

    const reason: RunFinishReason =
      run.abortRequested || run.sawAbort
        ? "abort"
        : run.sawError
          ? "error"
          : "done";
    finalizeRun(record, run, reason);
  }

  /**
   * STEER UTILISATEUR — injecte un message DÉJÀ versé au transcript dans le run
   * EN COURS (`session.steer`). Le message est un VRAI échange : il est affiché
   * (bulle client), transcripté (fait par l'appelant) et persisté par le SDK (donc
   * mémorisable). Il n'est JAMAIS envoyé au TTS et n'ouvre pas de nouveau run.
   *
   * ⚠️ En cas d'échec (run terminé entre-temps), le message repasse en tour
   * normal : il n'est jamais perdu (et jamais dupliqué dans le transcript, grâce
   * à `run.transcriptPushed`).
   */
  async function steerRun(record: SessionRecord, run: RunItem): Promise<void> {
    try {
      await record.session.steer(run.storedText);
    } catch (error) {
      const piError = toPiHostError(error, {
        runId: run.runId,
        sessionId: record.sessionId,
        logger,
      });
      logger.warn("pi.steer.rejected", {
        session_id: record.sessionId,
        run_id: run.runId,
        code: piError.code,
      });
      if (record.currentRun) {
        // Un run tourne encore : on remet le message en file derrière lui.
        record.queue.push(run);
        return;
      }
      void startRun(record, run);
    }
  }

  /**
   * Session du REGISTRE pour `sessionId`. Sans identifiant, la session
   * FOCALISÉE. ⚠️ E0 : plus de repli silencieux sur la session courante quand
   * un identifiant inconnu est fourni (sinon un `abort` viserait le mauvais
   * fil) — un identifiant inconnu est simplement introuvable.
   */
  function recordFor(sessionId?: string): SessionRecord | undefined {
    if (sessionId) {
      return sessions.get(sessionId);
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

  /**
   * Messages d'une session (rôle + horodatage + texte), dans l'ORDRE du fichier.
   * Le repère temporel `[horodatage] …` du message utilisateur est RETIRÉ (c'est
   * une métadonnée : l'horodatage de l'entrée la porte déjà).
   */
  function messagesFromEntries(entries: readonly unknown[]): ArchivedMessage[] {
    const messages: ArchivedMessage[] = [];
    for (const raw of entries) {
      if (!raw || typeof raw !== "object") continue;
      const entry = raw as { type?: unknown; message?: unknown; timestamp?: unknown };
      if (entry.type !== "message") continue;
      const message = entry.message as RawAgentMessage | undefined;
      if (!message || typeof message !== "object") continue;
      const role = message.role;
      if (role !== "user" && role !== "assistant") continue;
      const rawText = contentTextFromMessage(message);
      const text = role === "user" ? stripTimestampPrefix(rawText) : rawText;
      if (text.trim().length === 0) continue;
      const at =
        typeof entry.timestamp === "string" && entry.timestamp.length > 0
          ? entry.timestamp
          : new Date(messageTimestamp(message) ?? Date.now()).toISOString();
      messages.push({ at, role, text });
    }
    return messages;
  }

  /**
   * Relit une conversation AVANT son déplacement : messages complets + titre.
   * ⚠️ LECTURE SEULE et JAMAIS fatale : une erreur (fichier illisible, session
   * disparue) renvoie `null` et n'empêche JAMAIS la mise de côté.
   *
   * ⚠️ Lecture du JSONL par `SessionManager.open` quand la session n'est pas
   * vivante : la conversation est complète (le journal est append-only, la
   * compaction n'efface rien).
   */
  function captureConversation(
    sessionId: string,
    live: SessionRecord | undefined,
    file: string | undefined,
  ): ArchivedConversation | null {
    try {
      const manager = live
        ? live.session.sessionManager
        : file && existsSync(file)
          ? SessionManager.open(file, paths.sessionsDir, paths.cwd)
          : undefined;
      if (!manager) return null;
      let name: string | undefined;
      try {
        name = manager.getSessionName();
      } catch {
        name = undefined;
      }
      const messages = messagesFromEntries(manager.getEntries());
      const firstUser = messages.find((message) => message.role === "user")?.text;
      return {
        v: 1,
        id: sessionId,
        title: titleFrom(name, firstUser),
        archivedAt: new Date().toISOString(),
        messages,
      };
    } catch (error) {
      logger.warn("pi.session.set_aside.capture.failed", {
        session_id: sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Travail d'ARRIÈRE-PLAN après une mise de côté réussie :
   *  1. ARCHIVE la conversation ENTIÈRE (`options.conversationArchive`) — une
   *     donnée, jamais injectée dans le prompt ;
   *  2. PASSE DE MÉMOIRE silencieuse sur la conversation entière
   *     (`MemoryPort.onSessionSetAside`), mêmes règles que la consolidation.
   *
   * ⚠️ Appelé SANS `await` par `setAsideSession` : la mise de côté est immédiate.
   * ⚠️ IDEMPOTENT : si la conversation est DÉJÀ archivée, ni réécriture ni
   * nouvelle passe (sinon chaque mise de côté réécrirait tout).
   * ⚠️ Toute erreur est journalisée, jamais propagée.
   */
  async function afterSetAside(conversation: ArchivedConversation): Promise<void> {
    const archive = options.conversationArchive;
    try {
      if (archive) {
        const result = archive.archiveConversation(conversation);
        logger.info("pi.session.set_aside.archived", {
          session_id: conversation.id,
          messages: result.messages,
          created: result.archived,
          path: result.path,
        });
        if (!result.archived) {
          // Déjà archivée ⇒ ne PAS relancer la passe (idempotence).
          logger.info("pi.session.set_aside.skipped", {
            session_id: conversation.id,
            reason: "already_archived",
          });
          return;
        }
      }
      options.memory?.onSessionSetAside?.({
        sessionId: conversation.id,
        title: conversation.title,
        messages: conversation.messages,
      });
    } catch (error) {
      // ⚠️ « Échec silencieux » : l'utilisateur ne voit RIEN (voulu), les journaux
      // le montrent. La conversation reste mise de côté et archivée.
      logger.warn("pi.session.set_aside.backfill.failed", {
        session_id: conversation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * PASSE DE REMPLISSAGE DE MÉMOIRE exécutée AVANT une compaction forcée.
   *
   * ⚠️ ATTENDUE (contrairement à la mise de côté) : l'utilisateur a demandé que
   * la mémoire soit remplie AVANT la compression, et l'ordre doit être PROUVÉ.
   * ⚠️ ÉCHEC NON BLOQUANT : on renvoie `reason: "failed"` — la compaction aura
   * quand même lieu, et l'interface le dira (jamais un succès fabriqué).
   */
  async function runMemoryPassBeforeCompact(
    sessionId: string,
    captured: ArchivedConversation | null,
    onProgress: ((part: number, parts: number) => void) | undefined,
  ): Promise<CompactOutcome["memory"]> {
    const none = (reason: string, error?: string): CompactOutcome["memory"] => ({
      ran: false,
      reason,
      ...(error !== undefined ? { error } : {}),
      added: 0,
      updated: 0,
      removed: 0,
      skipped: 0,
      chunks: 0,
    });
    const port = options.memory;
    if (!port?.onSessionCompact) return none("unsupported");
    // Conversation illisible (fichier disparu, JSONL corrompu) : rien à relire.
    if (!captured) return none("unreadable");
    logger.info("pi.session.compact.memory.begin", {
      session_id: sessionId,
      messages: captured.messages.length,
    });
    try {
      const result = await port.onSessionCompact({
        sessionId,
        title: captured.title,
        messages: captured.messages,
        ...(onProgress ? { onProgress } : {}),
      });
      logger.info("pi.session.compact.memory.done", {
        session_id: sessionId,
        ran: result.ran,
        reason: result.reason ?? null,
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        skipped: result.skipped,
        chunks: result.chunks,
      });
      return {
        ran: result.ran,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        added: result.added,
        updated: result.updated,
        removed: result.removed,
        skipped: result.skipped,
        chunks: result.chunks,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("pi.session.compact.memory.failed", {
        session_id: sessionId,
        error: message,
      });
      return none("failed", message);
    }
  }

  /**
   * Traduit l'échec BRUT de la compaction SDK en `PiHostError` franche.
   * ⚠️ Aucun message anglais du SDK ne sort d'ici, et aucun échec n'est maquillé
   * en succès : « trop court », « déjà compacté », « interrompu », « pas de
   * modèle » et « échec du modèle » sont des situations DIFFÉRENTES.
   */
  function compactFailure(error: unknown, sessionId: string): PiHostError {
    if (error instanceof PiHostError) return error;
    const raw = error instanceof Error ? error.message : String(error);
    const prefixed = raw.match(/compaction failed:\s*(.+)$/i);
    const detail = (prefixed?.[1] ?? raw).trim();
    const make = (code: PiHostError["code"], message: string): PiHostError =>
      new PiHostError(code, message, { cause: error, sessionId });
    if (/already compacted/i.test(detail)) {
      return make(
        "PI_SESSION_ERROR",
        "Cette conversation vient d'être compactée : il n'y a rien de plus à compacter.",
      );
    }
    if (/nothing to compact|too small/i.test(detail)) {
      return make(
        "PI_SESSION_ERROR",
        "Conversation trop courte : il n'y a pas assez d'échanges à résumer.",
      );
    }
    if (/cancel|abort/i.test(detail)) {
      return make("PI_ABORTED", "La compaction a été interrompue.");
    }
    if (/no model|no api key|not authenticated|authentication failed/i.test(detail)) {
      return make(
        "LLM_UNAVAILABLE",
        "Aucun modèle utilisable : la compaction nécessite un appel au modèle.",
      );
    }
    const clean = sanitizeErrorText(detail).trim();
    return make(
      "PI_SESSION_ERROR",
      `La compaction a échoué${clean.length > 0 ? ` : ${clean}` : "."}`,
    );
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

    customTools = [
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
    if (options.secrets) {
      // Coffre de secrets (extension) : outil de CONSULTATION `lister_secrets`
      // (LECTURE SEULE, NOMS seulement). Indépendant de l'exécution.
      customTools.push(...createSecretTools(options.secrets));
    }
    if (options.secretRequests) {
      // DEMANDE de secret (`demander_secret`) : ouvre une fenêtre de saisie DANS
      // la conversation. La valeur va du navigateur au serveur SANS passer par le
      // modèle. ⚠️ RÉSERVÉ au léger (le lourd n'a pas ce port).
      customTools.push(...createSecretRequestTool(options.secretRequests));
    }
    if (options.heritage) {
      // Lot 13 : outil de CONSULTATION de l'archive « vie antérieure » (LECTURE
      // SEULE). L'archive n'est jamais injectée ; on la consulte à la demande.
      customTools.push(...createHeritageTools(options.heritage));
    }
    if (options.conversationArchive) {
      // Archive des conversations MISES DE CÔTÉ : RECHERCHE PLEIN TEXTE en
      // LECTURE SEULE, utilisable UNIQUEMENT sur demande explicite de
      // l'utilisateur (voir la description de l'outil). Aucune extension :
      // l'archive n'est JAMAIS injectée dans le prompt.
      customTools.push(...createConversationArchiveTools(options.conversationArchive));
    }
    if (options.librarian) {
      // Libraire de Pi-Web : recherche documentaire + web, bibliothèque, relecture
      // et archivage EN TÂCHE DE FOND (rend la main immédiatement). ⚠️ Aucun outil
      // ne va chercher une page web : tout passe par le libraire.
      customTools.push(...createLibrarianTools(options.librarian));
    }

    // Extensions INLINE, dans l'ORDRE D'APPLICATION voulu du prompt du tour :
    // RÈGLES (consignes de l'utilisateur) → PERSONNALITÉ (base) → MÉMOIRE →
    // ANNUAIRE des agents → HERITAGE (voir `buildInlineExtensions`, verrouillé
    // par un test d'ordre). Rejoué à l'identique pour CHAQUE runtime : chaque
    // conversation applique l'ordre verrouillé.
    extensionFactories = buildInlineExtensions(options);
    if (options.delegation) {
      // ⚠️ RELAIS + jobs EN COURS (parité Pi-Web) : consigne FERME « l'utilisateur
      // ne parle qu'à toi » + liste des jobs de CETTE conversation, injectées dans
      // le prompt du léger à chaque tour (mécanisme NON PERSISTÉ, comme la
      // mémoire). Sans la liste, l'orchestrateur ne saurait pas QUOI relayer.
      extensionFactories = [
        ...extensionFactories,
        createDelegationExtensionFactory({ activeJobs: activeJobsFor, logger }),
      ];
    }

    // Session initiale : la plus récente si elle existe, sinon une neuve.
    const sessionManager =
      existing.length > 0
        ? SessionManager.continueRecent(paths.cwd, paths.sessionsDir)
        : SessionManager.create(paths.cwd, paths.sessionsDir);
    // Abonnement posé IMMÉDIATEMENT, avant tout prompt.
    currentRecord = attachRecord(await createRuntimeFor(sessionManager));
    // Relaye les événements de la couche délégation sur le bus de la façade.
    unsubscribeExternal = options.eventSource?.subscribe((event) => {
      emitEvent(event);
      scheduleWaitingRefresh(event);
    });
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

  /**
   * Fabrique le runtime d'UNE conversation persistante (fichier-backed).
   *
   * ⚠️ C'est la VARIANTE PERSISTANTE de `createEphemeralSession` : au lieu d'un
   * `SessionManager.inMemory`, le `SessionManager` fourni EST le fichier JSONL
   * de la conversation, et les extensions INLINE (règles → personnalité →
   * mémoire → annuaire → héritage) sont ré-appliquées à CHAQUE runtime. Chaque
   * conversation vivante possède donc SON `AgentSessionRuntime` — donc SES
   * services et SES extensions — condition de l'isolation inter-fils (E0).
   */
  async function createRuntimeFor(
    sessionManager: SessionManager,
  ): Promise<AgentSessionRuntime> {
    if (!settingsManager || !modelRuntime) {
      throw new PiHostError("PI_NOT_READY", "Host Pi non démarré.");
    }
    return createLightRuntime({
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
  }

  /**
   * Deux « références de modèle » désignent-elles la MÊME cible d'exécution ?
   * On compare AUSSI `baseUrl` : un changement de FOURNISSEUR (`llm.*.baseUrl`,
   * `apply: hot`) garde le même `provider`/`id` mais une URL différente — sans
   * cette comparaison, les sessions existantes conserveraient une capture
   * FIGÉE de l'ancien endpoint (le prochain run partirait vers l'ancien).
   */
  function sameModelRef(
    current: SdkModel | undefined,
    next: SdkModel,
  ): boolean {
    return (
      current !== undefined &&
      current.provider === next.provider &&
      current.id === next.id &&
      current.baseUrl === next.baseUrl
    );
  }

  /**
   * Vrai si ce fil doit changer de modèle ou de niveau de réflexion. PRÉDICAT
   * SYNCHRONE (aucune attente) : permet à `startRun` de ne PAS introduire de
   * microtâche avant l'émission de `run_started` quand rien ne change.
   */
  function needsModelSwitch(record: SessionRecord): boolean {
    if (!resolvedModel) return false;
    if (!sameModelRef(record.session.model, resolvedModel)) return true;
    return Boolean(
      resolvedThinking && record.session.thinkingLevel !== resolvedThinking,
    );
  }

  /**
   * Aligne le modèle (et le niveau de réflexion) d'UNE conversation sur l'état
   * COURANT (`resolvedModel`/`resolvedThinking`). Appelé AU DÉBUT de chaque run :
   * c'est ce qui rend un changement de modèle effectif SANS redémarrage — le
   * prochain run de chaque fil prend le nouveau modèle, sans jamais interrompre
   * un run en vol (on ne touche pas au modèle au milieu d'un tour). Un échec de
   * bascule (clé absente…) est journalisé et NE fait PAS échouer le run : on
   * garde le modèle courant plutôt que de casser la conversation.
   */
  async function ensureRecordModel(record: SessionRecord): Promise<void> {
    if (!resolvedModel) return;
    const current = record.session.model;
    const sameModel = sameModelRef(current, resolvedModel);
    try {
      if (!sameModel) {
        await record.session.setModel(resolvedModel);
        logger.info("pi.model.switched", {
          session_id: record.sessionId,
          model: `${resolvedModel.provider}/${resolvedModel.id}`,
        });
      }
      // `setModel` applique le thinking DÉDUIT du modèle ; la config fait foi.
      if (resolvedThinking && record.session.thinkingLevel !== resolvedThinking) {
        record.session.setThinkingLevel(resolvedThinking);
      }
    } catch (error) {
      logger.warn("pi.model.switch.failed", {
        session_id: record.sessionId,
        model: `${resolvedModel.provider}/${resolvedModel.id}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Ouvre une conversation : fabrique son runtime, s'y abonne et l'enregistre
   * dans le REGISTRE. Aucun run n'est TUE : on AJOUTE une session vivante.
   */
  async function openRecord(sessionManager: SessionManager): Promise<SessionRecord> {
    return attachRecord(await createRuntimeFor(sessionManager));
  }

  /** Conversation VIVANTE (au registre) dont le fichier est `sessionFile`. */
  function liveRecordForFile(sessionFile: string): SessionRecord | undefined {
    const target = resolve(sessionFile);
    for (const record of sessions.values()) {
      let file: string | undefined;
      try {
        file = record.session.sessionManager.getSessionFile();
      } catch {
        file = undefined;
      }
      if (file && resolve(file) === target) return record;
    }
    return undefined;
  }

  /**
   * Bascule le FOCUS sur `record` SANS tuer aucun run (E0). Le run des autres
   * conversations continue d'avancer en arrière-plan ; seule la conversation
   * focalisée reste visible pour le client.
   */
  function focus(record: SessionRecord): SessionState {
    currentRecord = record;
    emitEvent({
      type: "state",
      sessionId: record.sessionId,
      state: record.state,
      ...(record.activeRunId ? { activeRunId: record.activeRunId } : {}),
    });
    return buildState(record);
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
        return host.resume(target.sessionFile);
      }
      if (target?.new) {
        return host.newSession();
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
      const record = await openRecord(
        SessionManager.create(paths.cwd, paths.sessionsDir),
      );
      return focus(record);
    },

    async continueRecent(): Promise<SessionState> {
      if (!ready) {
        throw new PiHostError("PI_NOT_READY", "Host Pi non démarré.");
      }
      const existing = await SessionManager.list(
        paths.cwd,
        paths.sessionsDir,
      ).catch(() => []);
      const mostRecent = existing[0];
      if (!mostRecent) {
        return host.newSession();
      }
      return host.resume(mostRecent.path);
    },

    async resume(sessionFile: string): Promise<SessionState> {
      if (!ready) {
        throw new PiHostError("PI_NOT_READY", "Host Pi non démarré.");
      }
      // Fichier DÉJÀ OUVERT : on se contente de BASCULER LE FOCUS — aucun run
      // n'est tué, aucune session n'est reconstruite (cœur de E0).
      const live = liveRecordForFile(sessionFile);
      if (live) {
        return focus(live);
      }
      let manager: SessionManager;
      try {
        manager = SessionManager.open(sessionFile, paths.sessionsDir, paths.cwd);
      } catch (error) {
        throw toPiHostError(error, { logger });
      }
      const record = await openRecord(manager);
      return focus(record);
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
        // ⚠️ DEUX NATURES DE MESSAGE PENDANT UN RUN — NE PAS LES CONFONDRE :
        //
        //  1) Un prompt SYNTHÉTIQUE (report de job, résultat de commande
        //     validée) ne doit JAMAIS interrompre le tour de l'utilisateur : il
        //     reste en FILE et démarrera après la fin du tour (comportement E4).
        //
        //  2) Un VRAI message UTILISATEUR est INJECTÉ dans le run EN COURS
        //     (`session.steer`) : il infléchit le travail immédiatement, sans
        //     attendre la fin du tour. C'est un vrai échange : sa bulle est
        //     affichée (client), il entre dans le transcript (ci-dessous) et
        //     sera persisté par le SDK (donc mémorisable, recharg_able). Il n'est
        //     JAMAIS envoyé au TTS (comportement normal).
        if (isSyntheticOrigin(opts?.origin)) {
          record.queue.push(run);
          return { runId, sessionId: record.sessionId, queued: true };
        }
        // Le transcript reçoit le message À L'INSTANT, comme un vrai message.
        // ⚠️ ORDRE COHÉRENT AVEC LE RENDU CLIENT : le message est placé JUSTE
        // AVANT l'entrée assistant du run en cours (le client insère sa bulle
        // avant le bloc assistant affiché). Sans cela, un steer arrivé APRÈS le
        // premier message assistant du run (fenêtre étroite entre deux
        // messages) se retrouverait APRÈS — le snapshot et le rechargement
        // divergeraient alors du direct.
        const active = record.currentRun;
        const userEntry: TranscriptEntry = {
          role: "user",
          text,
          timestamp: run.sentAt,
        };
        const at = active.assistantEntry
          ? record.transcript.indexOf(active.assistantEntry)
          : -1;
        if (at >= 0) record.transcript.splice(at, 0, userEntry);
        else record.transcript.push(userEntry);
        run.transcriptPushed = true;
        // ⚠️ FILET « PAS DE STEER ORPHELIN » : on retient ce message utilisateur
        // pour pouvoir le REJOUER immédiatement s'il n'est pas consommé avant la
        // fin du run (voir `drainOrphanUserSteers`).
        record.pendingUserSteers.push(run);
        void steerRun(record, run);
        return { runId, sessionId: record.sessionId, queued: false };
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

    async applyLlmConfig(options: ApplyLlmConfigOptions): Promise<void> {
      if (!modelRuntime) return; // Host non démarré : rien à recharger.
      // 1) Réécrit `models.json` (nouveau FOURNISSEUR `baseUrl`/`api` et/ou
      //    nouveau modèle) puis rafraîchit le runtime PARTAGÉ (léger ET lourd)
      //    EN PLACE. Le worker lourd, qui re-résout sa référence à chaque job,
      //    voit ainsi le nouveau fournisseur/modèle.
      if (options.modelsConfig !== undefined) {
        writeModelsFile(paths, options.modelsConfig, logger);
      }
      await refreshSharedModelRuntime({
        authPath: join(paths.agentDir, "auth.json"),
        modelsPath: paths.modelsPath,
      });
      // 2) Re-résout le modèle de conversation + son thinking.
      const nextModel = resolveSdkModel(modelRuntime, options.conversationModel);
      if (!nextModel) {
        logger.warn("pi.model.reload.unresolved", {
          model: options.conversationModel,
        });
        return;
      }
      resolvedModel = nextModel;
      resolvedThinking =
        options.conversationThinking ??
        resolveSdkThinking(modelRuntime, options.conversationModel) ??
        resolvedThinking;
      logger.info("pi.model.reloaded", {
        model: `${nextModel.provider}/${nextModel.id}`,
        thinking: resolvedThinking ?? null,
      });
      // 3) Applique AUX SESSIONS INACTIVES ; un run EN VOL gardera son modèle
      //    jusqu'à sa fin (la bascule se fait au prochain `startRun`). On ATTEND
      //    l'application pour que `applyLlmConfig` soit terminée à son retour.
      await Promise.all(
        [...sessions.values()]
          .filter((record) => !record.currentRun)
          .map((record) => ensureRecordModel(record)),
      );
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
      // Fusionne TOUTE session VIVANTE dont le fichier n'est pas encore
      // persisté (un fil neuf ne s'écrit qu'à la première réponse assistant) :
      // sinon « Nouvelle conversation » (et tout fil en cours d'écriture)
      // n'apparaîtrait pas dans la liste. La session FOCALISÉE passe en tête.
      const extra: SessionInfo[] = [];
      for (const record of sessions.values()) {
        if (mapped.some((info) => info.sessionId === record.sessionId)) continue;
        if (record === currentRecord) {
          extra.unshift(currentSessionSummary(record));
        } else {
          extra.push(currentSessionSummary(record));
        }
      }
      mapped.unshift(...extra);
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
      const live = sessions.get(id);
      const isCurrent = currentRecord?.sessionId === id;
      const file = await host.sessionFileFor(id);
      if (!live && (!file || !existsSync(file))) {
        throw new PiHostError("PI_SESSION_ERROR", "Conversation introuvable.", {
          sessionId: id,
        });
      }
      // ⚠️ CAPTURE AVANT DÉPLACEMENT : l'archive et la passe de mémoire ont
      // besoin de la conversation ENTIÈRE (messages + titre). Lecture seule et
      // non fatale : un échec de capture n'empêche JAMAIS la mise de côté.
      const captured = captureConversation(id, live, file);
      // ⚠️ ORDRE OBLIGATOIRE quand c'est une session VIVANTE : on la retire du
      // registre et on FERME son runtime AVANT de déplacer son fichier, sinon
      // le prochain `_persist` du SDK recréerait le JSONL au chemin déplacé
      // (fil fantôme). La session OUVERTE bascule alors sur « état vide »
      // (`currentRecord = undefined`), comme avant E0.
      if (live) {
        if (currentRecord === live) currentRecord = undefined;
        await host.abort(id).catch(() => undefined);
        await detachRecord(live);
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
      // ⚠️ APRÈS le succès du déplacement, et SANS `await` : la mise de côté est
      // IMMÉDIATE (piège n°1 : « ça mouline 30 s sur téléphone »). Archive +
      // passe de mémoire tournent DERRIÈRE, silencieusement, et un échec ne
      // remonte JAMAIS à l'appelant.
      if (captured) void afterSetAside(captured);
    },

    /**
     * SUPPRESSION DÉFINITIVE (aucune corbeille, aucune annulation).
     *
     * ⚠️ La MÉMOIRE n'est pas concernée : on n'écrit rien, on ne supprime aucun
     * souvenir. Seul le fichier de la conversation est effacé.
     */
    async deleteSession(id: string): Promise<void> {
      if (!ready) {
        throw new PiHostError("PI_NOT_READY", "Host Pi non démarré.");
      }
      const live = sessions.get(id) ?? (currentRecord?.sessionId === id ? currentRecord : undefined);
      const file = await host.sessionFileFor(id);
      if (!live && (!file || !existsSync(file))) {
        throw new PiHostError("PI_SESSION_ERROR", "Conversation introuvable.", {
          sessionId: id,
        });
      }
      const isCurrent = currentRecord?.sessionId === id;
      // ⚠️ ORDRE IMPÉRATIF : (1) arrêt du run EN COURS et vidage de la file,
      // (2) fermeture du runtime, (3) EFFACEMENT. Effacer avant de fermer
      // laisserait le prochain `_persist` du SDK recréer le fichier supprimé
      // (fil fantôme) — même piège que la mise de côté.
      if (live) {
        if (currentRecord === live) currentRecord = undefined;
        await host.abort(id).catch((error: unknown) => {
          logger.warn("pi.session.delete.abort.failed", {
            session_id: id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        await detachRecord(live);
      }
      let fileDeleted = false;
      if (file && existsSync(file)) {
        try {
          unlinkSync(file);
          fileDeleted = true;
        } catch (error) {
          throw toPiHostError(error, { logger, sessionId: id });
        }
      }
      logger.info("pi.session.deleted", {
        session_id: id,
        was_current: isCurrent,
        file_deleted: fileDeleted,
      });
    },

    /**
     * COMPACTION FORCÉE : PASSE DE MÉMOIRE **puis** compression du fil.
     *
     * ⚠️ L'ORDRE est la demande explicite de l'utilisateur : la passe de
     * remplissage tourne jusqu'au bout AVANT que la compaction ne rassemble le fil.
     * ⚠️ La compaction est celle du SDK (`AgentSession.compact()`), donc le MÊME
     * mécanisme qu'une compaction naturelle (même découpage, même prompt de
     * résumé, même entrée `CompactionEntry`), pas une imitation.
     */
    async compactSession(id: string, opts: CompactOptions = {}): Promise<CompactOutcome> {
      if (!ready) {
        throw new PiHostError("PI_NOT_READY", "Host Pi non démarré.");
      }
      const file = await host.sessionFileFor(id);
      let record =
        sessions.get(id) ?? (currentRecord?.sessionId === id ? currentRecord : undefined);
      if (!record) {
        // Conversation NON VIVANTE : on l'OUVRE sans changer le focus (aucun run
        // n'est tué, aucun fil n'est volé à l'utilisateur).
        if (!file || !existsSync(file)) {
          throw new PiHostError("PI_SESSION_ERROR", "Conversation introuvable.", {
            sessionId: id,
          });
        }
        let manager: SessionManager;
        try {
          manager = SessionManager.open(file, paths.sessionsDir, paths.cwd);
        } catch (error) {
          throw toPiHostError(error, { logger, sessionId: id });
        }
        record = await openRecord(manager);
      }
      // 1) LECTURE de la conversation ENTIÈRE (LECTURE SEULE, non fatale) : c'est
      // la matière de la passe de mémoire. La compaction n'en dépend pas.
      const captured = captureConversation(id, record, file);
      const messageCount = captured?.messages.length ?? record.transcript.length;
      if (messageCount < COMPACT_MIN_MESSAGES) {
        // Message CLAIR plutôt qu'un succès vide (piège de la demande).
        throw new PiHostError(
          "PI_SESSION_ERROR",
          "Cette conversation est vide ou trop courte : il n'y a rien à compacter.",
          { sessionId: id },
        );
      }
      // 2) PASSE DE MÉMOIRE D'ABORD — attendue, progression annoncée.
      opts.onProgress?.({ phase: "memory" });
      const memory = await runMemoryPassBeforeCompact(
        id,
        captured,
        opts.onProgress
          ? (part, parts) => opts.onProgress?.({ phase: "memory", part, parts })
          : undefined,
      );
      // 3) Le run EN COURS (s'il y en a un) est arrêté PROPREMENT avant la
      // compaction : `compact()` du SDK appelle `abort()`, mais la FILE d'attente
      // du host doit aussi être vidée, sinon un message repartirait après.
      await host.abort(id).catch((error: unknown) => {
        logger.warn("pi.session.compact.abort.failed", {
          session_id: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      // 4) COMPACTION (même chemin que `/compact` : hook `session_before_compact`
      // inclus, donc la consolidation habituelle de la mémoire s'applique aussi).
      opts.onProgress?.({ phase: "compact" });
      logger.info("pi.session.compact.begin", { session_id: id });
      let result: { tokensBefore: number; estimatedTokensAfter?: number; summary: string };
      try {
        result = await record.session.compact();
      } catch (error) {
        throw compactFailure(error, id);
      }
      logger.info("pi.session.compact", {
        session_id: id,
        tokens_before: result.tokensBefore,
        tokens_after: result.estimatedTokensAfter ?? null,
        summary_chars: result.summary.length,
        memory_ran: memory.ran,
        memory_reason: memory.reason ?? null,
        memory_added: memory.added,
        memory_updated: memory.updated,
        memory_skipped: memory.skipped,
      });
      return {
        memory,
        tokensBefore: result.tokensBefore,
        ...(result.estimatedTokensAfter !== undefined
          ? { tokensAfter: result.estimatedTokensAfter }
          : {}),
      };
    },

    async sessionFileFor(id: string): Promise<string | undefined> {
      // Session VIVANTE (focalisée OU en arrière-plan) : son fichier est connu
      // même s'il n'est pas encore persisté sur disque.
      const live = sessions.get(id);
      if (live) {
        try {
          return live.session.sessionManager.getSessionFile();
        } catch {
          // ignore : repli sur la liste persistée
        }
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
      // ⚠️ E0 : FERMER TOUS les runtimes (un par conversation vivante), pas
      // seulement le dernier — sinon des runtimes orphelins survivraient à
      // l'arrêt de l'hôte.
      const toDispose = [...sessions.values()];
      sessions.clear();
      currentRecord = undefined;
      for (const record of toDispose) {
        try {
          await record.runtime.dispose();
        } catch (error) {
          logger.warn("pi.stop.failed", {
            session_id: record.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      restoreEnv?.();
      restoreEnv = undefined;
      startPromise = undefined;
    },
  };

  return host;
}
