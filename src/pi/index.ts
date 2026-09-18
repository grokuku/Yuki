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

export {
  applyPiEnvironment,
  ensurePiLayout,
  PI_SDK_ENV,
  resolvePiPaths,
  seedModelsFile,
  seedSettingsFile,
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
export { createSdkHeavyWorker } from "./sdk/heavy-worker.js";
export type { SdkHeavyWorkerConfig } from "./sdk/heavy-worker.js";
export { createDelegateTools, createRunContextTracker } from "./sdk/delegate-tools.js";
export type {
  DelegateToolsConfig,
  RunContextTracker,
} from "./sdk/delegate-tools.js";

export { sanitizeErrorText } from "./events.js";
