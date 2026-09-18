/**
 * Domaine `jobs` — types, journal append-only, file bornée.
 *
 * AUCUN import du SDK Pi ni de typebox.
 */

export { JobError } from "./errors.js";
export type { JobErrorCode } from "./errors.js";

export {
  JOB_SCHEMA_VERSION,
  TERMINAL_STATUSES,
  emptyCounts,
  isTerminal,
  isTransitionAllowed,
  statusForKind,
} from "./types.js";
export type {
  JobCounts,
  JobErrorInfo,
  JobEvent,
  JobKind,
  JobPatch,
  JobRecord,
  JobResult,
  JobStatus,
  JobUsage,
} from "./types.js";

export { JobStore, applyEventToState } from "./store.js";
export type { JobEventListener, JobLogger, JobStoreOptions } from "./store.js";

export {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_QUEUE,
  JobQueue,
} from "./queue.js";
export type { Admission, JobQueueOptions } from "./queue.js";
