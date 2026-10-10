/**
 * Erreurs du domaine `agents` (AUCUN import SDK/typebox).
 */

export type AgentErrorCode =
  | "AGENT_NOT_FOUND"
  | "AGENT_ALREADY_EXISTS"
  | "INVALID_LEVEL"
  | "INVALID_PRIVILEGE"
  | "INVALID_AGENT_ID"
  | "INVALID_AGENT_NAME"
  | "AGENT_NAME_TAKEN"
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
  | "pair_code_invalid"
  /**
   * Aucune session d'appairage ACTIVE ne correspond à la preuve : le code
   * saisi dans Yuki n'est pas celui qu'emploie l'agent (faute de frappe, code
   * périmé remplacé, ou code d'un autre agent). ⚠️ Conflit **récupérable** : la
   * trame est mise en attente, une saisie correcte ultérieure l'appariera.
   */
  | "pair_code_mismatch"
  /**
   * L'empreinte de CA revendiquée par l'agent ne correspond pas au CA courant
   * de Yuki : agent visant un autre serveur, ou CA régénéré depuis le dernier
   * appairage (état de l'agent à rafraîchir).
   */
  | "pair_fp_mismatch";

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

/**
 * Codes d'erreur du CANAL d'exécution (Lot 4, B6).
 *
 * ⚠️ `result_lost` : la commande va à son terme côté agent (D124) mais la
 * connexion s'est fermée avant que le résultat ne revienne — il est PERDU.
 * `agent_offline` : rejet immédiat (aucune mise en file, D124).
 */
export type ChannelErrorCode =
  | "agent_offline"
  | "send_failed"
  | "result_lost"
  | "agent_error"
  | "command_timeout";

/** Erreur du canal d'exécution (transport WebSocket ↔ agent). */
export class AgentChannelError extends Error {
  override readonly name = "AgentChannelError";
  readonly code: ChannelErrorCode;
  readonly agentId: string;
  /** Code applicatif renvoyé par l'agent (`error`), si applicable. */
  readonly agentCode?: string;

  constructor(
    code: ChannelErrorCode,
    message: string,
    options: { agentId: string; agentCode?: string } = { agentId: "" },
  ) {
    super(message);
    this.code = code;
    this.agentId = options.agentId;
    this.agentCode = options.agentCode;
  }
}

/** `true` si l'erreur est une erreur de canal. */
export function isChannelError(error: unknown): error is AgentChannelError {
  return error instanceof AgentChannelError;
}
