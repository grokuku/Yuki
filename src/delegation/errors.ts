/**
 * Erreurs du domaine `delegation` (AUCUN import SDK/typebox).
 */

export type DelegationErrorCode = "DELEGATION_CONFIG" | "DELEGATION_STATE";

export class DelegationError extends Error {
  override readonly name = "DelegationError";
  readonly code: DelegationErrorCode;
  override readonly cause?: unknown;

  constructor(
    code: DelegationErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.code = code;
    this.cause = options.cause;
  }
}
