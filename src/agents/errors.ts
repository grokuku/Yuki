/**
 * Erreurs du domaine `agents` (AUCUN import SDK/typebox).
 */

export type AgentErrorCode =
  | "AGENT_NOT_FOUND"
  | "AGENT_ALREADY_EXISTS"
  | "INVALID_LEVEL"
  | "INVALID_PRIVILEGE"
  | "INVALID_AGENT_ID"
  | "STORE_IO";

/**
 * Codes d'erreur de l'appairage (Lot 4, B3). ⚠️ Valeurs **identiques** aux
 * codes du protocole Go (`agent/internal/proto/errors.go`) : c'est ce qui
 * permet aux tests d'attaque des deux côtés d'attendre le même code.
 */
export type PairErrorCode =
  | "invalid_json"
  | "malformed_message"
  | "unknown_type"
  | "unsupported_version"
  | "internal_error"
  | "proof_invalid"
  | "pair_code_expired"
  | "pair_code_used"
  | "pair_rate_limited"
  | "pair_replay"
  | "pair_decrypt_failed"
  | "pair_payload_malformed"
  | "pair_code_invalid";

export class AgentError extends Error {
  override readonly name = "AgentError";
  readonly code: AgentErrorCode;
  readonly agentId?: string;
  override readonly cause?: unknown;

  constructor(
    code: AgentErrorCode,
    message: string,
    options: { cause?: unknown; agentId?: string } = {},
  ) {
    super(message);
    this.code = code;
    this.cause = options.cause;
    this.agentId = options.agentId;
  }
}

/**
 * Erreur d'appairage typée (Lot 4). Le `code` est aligné sur le protocole Go et
 * destiné au code appelant (jamais à l'affichage brut).
 */
export class PairError extends Error {
  override readonly name = "PairError";
  readonly code: PairErrorCode;
  override readonly cause?: unknown;

  constructor(code: PairErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.code = code;
    this.cause = options.cause;
  }
}

/** Extrait le code d'une erreur d'appairage, ou `null` si ce n'en est pas une. */
export function pairCodeOf(error: unknown): PairErrorCode | null {
  return error instanceof PairError ? error.code : null;
}
