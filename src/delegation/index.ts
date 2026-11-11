/**
 * Domaine `delegation` — ports, service, report.
 *
 * AUCUN import du SDK Pi ni de typebox : `src/pi/sdk/*` implémente les ports,
 * `src/index.ts` câble le tout.
 */

export {
  ORIGIN_JOB_REPORT,
  ORIGIN_USER,
  ACTIVITY_DETAIL_MAX,
  DEFAULT_DEADLINE_MS,
  DEFAULT_INLINE_MAX_BYTES,
  DEFAULT_RESULT_BATCH_WINDOW_MS,
  DISPATCH_NOTE,
  MAX_DEADLINE_MS,
  MIN_DEADLINE_MS,
  STEER_BUFFERED_NOTE,
  STEER_INJECTED_NOTE,
  DelegationService,
  clampDeadline,
  createDelegationService,
  excerptForActivity,
  grouperParBot,
  truncateToBytes,
} from "./service.js";
export type { DelegationLogger, DelegationServiceOptions } from "./service.js";

export {
  REPORT_HEADER,
  REPORT_INSTRUCTION,
  REPORT_INSTRUCTION_BATCH,
  REPORT_MAX_CHARS,
  buildBatchReportPrompt,
  buildReportPrompt,
} from "./report.js";

export {
  DELEGATION_CONTEXT_HEADER,
  DelegationContextTooLongError,
  MAX_DELEGATION_CONTEXT_CHARS,
  MAX_PENDING_STEERS,
  ORCHESTRATOR_STEER_HEADER,
  assertDelegationContext,
  composeFirstPrompt,
  orchestratorSteerBlock,
} from "./steer.js";
export type { FirstPromptExtras } from "./steer.js";

export { evenementsDuBot, portDelegationBot } from "./par-bot.js";

export { DelegationError } from "./errors.js";
export type { DelegationErrorCode } from "./errors.js";

export type {
  AvailabilityRole,
  CancelNotPossible,
  CancelNotFound,
  CancelOutcome,
  CancelSucceeded,
  DelegateCancelled,
  DelegateCompleted,
  DelegateDispatched,
  DelegateFailed,
  DelegateOutcome,
  DelegatePending,
  DelegateRejected,
  DelegateRequest,
  DelegateServicePort,
  DelegateTimeout,
  DelegateUnavailable,
  HeavyRunHandle,
  HeavyRunRequest,
  HeavyRunResult,
  HeavySteerResult,
  HeavyWorker,
  JobReporter,
  LightWaker,
  ModelAvailability,
  PendingJobSummary,
  PiEvent,
  PiEventSource,
  SteerAccepted,
  SteerBufferFull,
  SteerNotFound,
  SteerNotPossible,
  SteerOutcome,
} from "./ports.js";
export { TIMEOUT_CODES } from "./ports.js";
export type { TimeoutCode } from "./ports.js";
