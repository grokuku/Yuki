/**
 * Domaine « façade Pi embarqué » — surface publique.
 *
 * Ré-exporte uniquement des types JSON et l'interface `PiHost`. Aucun type du
 * SDK Pi ne figure ici : l'implémentation est confinée à `./sdk-host.ts`.
 */

export type { PiHost } from "./host.js";
export { createPiHost } from "./host.js";

export type {
  DeltaChannel,
  EnsureSessionOptions,
  PiEvent,
  PiEventListener,
  PiEventSource,
  PiHostOptions,
  PiJobEvent,
  PiJobTerminalStatus,
  PiLogger,
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
export { PI_THINKING_LEVELS } from "./types.js";

export { PiHostError } from "./errors.js";
export type { PiHostErrorCode } from "./errors.js";

export { SessionPinStore } from "./session-pins.js";
export type { SessionPinLogger, SessionPinStoreOptions } from "./session-pins.js";

export {
  applyPiEnvironment,
  ensurePiLayout,
  PI_SDK_ENV,
  resolvePiPaths,
  seedSettingsFile,
  writeModelsFile,
} from "./config.js";
export type { PiConfigInput, PiPaths } from "./config.js";

export { PHASE, RunInstrumentation, phaseEvent } from "./instrumentation.js";
export type { RunSummary } from "./instrumentation.js";

export {
  channelForAssistantEvent,
  contentTextFromMessage,
  deltaText,
  finishReasonForMessage,
  usageFromMessage,
} from "./events.js";

// ---------------------------------------------------------------------------
// Câblage Lot 2 — implémentations SDK exposées à la composition root.
//
// Ces fabriques n'exposent QUE des types purs (ports de `src/delegation`) :
// aucun type du SDK ne traverse `src/pi/index.ts`. La composition root
// (`src/index.ts`) reste ainsi hors de `src/pi/sdk/**`.
// ---------------------------------------------------------------------------
export {
  DEFAULT_TOOL_WATCHDOG_MS,
  createSdkHeavyWorker,
  idleTimeoutError,
  toolWatchdogError,
  totalTimeoutError,
  truncateCause,
} from "./sdk/heavy-worker.js";
export type { SdkHeavyWorkerConfig } from "./sdk/heavy-worker.js";
export { createDelegateTools, createRunContextTracker } from "./sdk/delegate-tools.js";
export type {
  DelegateToolsConfig,
  RunContextTracker,
} from "./sdk/delegate-tools.js";

// Lot 12 — mémoire durable : extracteur SDK (session éphémère isolée). Le port
// renvoyé (`MemoryExtractor`) est PUR : aucun type du SDK ne traverse la façade.
export { createSdkMemoryExtractor } from "./sdk/memory-extractor.js";
export type { SdkMemoryExtractorConfig } from "./sdk/memory-extractor.js";

// VISION — réduction À LA VOLÉE des images envoyées au modèle. Le port rendu
// (`VisionImageResizer`) est PUR : aucun type du SDK ne traverse la façade, et
// `src/files/**` reste sans dépendance au SDK.
export { sdkVisionImageResizer } from "./sdk/vision-resize.js";

// Récapitulatif « conversation dédiée » : écrivain SDK (session éphémère isolée).
// Le port renvoyé (`RecapWriter`) est PUR : aucun type du SDK ne traverse la façade.
export { createSdkRecapWriter } from "./sdk/recap-writer.js";
export type { SdkRecapWriterConfig } from "./sdk/recap-writer.js";
export { createSdkPromptWriter } from "./sdk/prompt-writer.js";
export type {
  SdkPromptWriter,
  SdkPromptWriterConfig,
  SdkToolEvent,
} from "./sdk/prompt-writer.js";

// Libraire de Pi-Web : rédacteur de synthèse d'archivage (session éphémère
// isolée). Le port renvoyé (`LibrarianSynthesizer`) est PUR.
export { createSdkLibrarianSynthesizer } from "./sdk/librarian-synthesizer.js";
export type { SdkLibrarianSynthesizerConfig } from "./sdk/librarian-synthesizer.js";

export { sanitizeErrorText } from "./events.js";

// RUN DISTANT (canal) : jeu d'outils d'une réponse rédigée hors de la
// conversation locale. Port PUR : la politique vient de `toolAllowlistForChat`
// et les définitions restent OPAQUES (`unknown[]`) — aucun type du SDK ne
// traverse cette façade.
export {
  assertNoApprovalTool,
  assertNoApprovalToolDefinition,
  createRemoteRunTools,
  REMOTE_APPROVAL_REFUSAL,
} from "./chat-run.js";
export type { RemoteRunTools, RemoteRunToolsOptions } from "./chat-run.js";
export type {
  RemoteRunImagePorts,
  RemoteRunLibrarianPorts,
  RemoteRunToolPorts,
  RemoteRunVision,
} from "./sdk/remote-run-tools.js";
// Publication inter-canal (décision A) : ce sont des TYPES seulement — la façade ne
// laisse passer aucun symbole du SDK.
export type {
  ChannelPostChannel,
  ChannelPostOutcome,
  ChannelPostPort,
  ChannelPostRequest,
} from "./sdk/channel-post-tool.js";
