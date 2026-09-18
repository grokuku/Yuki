/**
 * Domaine `delegation` — ports, service, report.
 *
 * AUCUN import du SDK Pi ni de typebox : `src/pi/sdk/*` implémente les ports,
 * `src/index.ts` câble le tout.
 */

export {
  ORIGIN_JOB_REPORT,
  ORIGIN_USER,
  DEFAULT_DEADLINE_MS,
  DEFAULT_INLINE_MAX_BYTES,
  MAX_DEADLINE_MS,
  MIN_DEADLINE_MS,
  DelegationService,
  clampDeadline,
  createDelegationService,
  truncateToBytes,
} from "./service.js";
export type { DelegationLogger, DelegationServiceOptions } from "./service.js";

export { REPORT_HEADER, REPORT_INSTRUCTION, REPORT_MAX_CHARS, buildReportPrompt } from "./report.js";

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
  HeavyWorker,
  JobReporter,
  LightWaker,
  ModelAvailability,
  PiEvent,
  PiEventSource,
} from "./ports.js";
