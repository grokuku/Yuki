/**
 * Erreurs du domaine `jobs` (AUCUN import SDK/typebox).
 */

export type JobErrorCode =
  | "JOB_NOT_FOUND"
  | "ILLEGAL_TRANSITION"
  | "DUPLICATE_JOB"
  | "STORE_IO"
  | "QUEUE_FULL";

export class JobError extends Error {
  override readonly name = "JobError";
  readonly code: JobErrorCode;
  readonly jobId?: string;
  override readonly cause?: unknown;

  constructor(
    code: JobErrorCode,
    message: string,
    options: { cause?: unknown; jobId?: string } = {},
  ) {
    super(message);
    this.code = code;
    this.cause = options.cause;
    this.jobId = options.jobId;
  }
}
