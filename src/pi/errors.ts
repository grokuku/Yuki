/**
 * Erreurs de la façade Pi.
 *
 * RÈGLE : aucun message d'erreur brut du SDK ne franchit la façade. Toute
 * exception, tout timeout ou tout abort du SDK est traduit en `PiHostError`
 * portant un code stable et un message propre.
 */

import type { PiLogger } from "./types.js";

/** Codes d'erreur exposés par la façade. */
export type PiHostErrorCode =
  | "PI_NOT_READY"
  | "PI_PROMPT_REJECTED"
  | "PI_ABORTED"
  | "PI_TIMEOUT"
  | "PI_SESSION_ERROR"
  | "PI_RESOURCE_ERROR"
  | "LLM_UNAVAILABLE"
  | "PI_UNKNOWN";

export interface PiHostErrorContext {
  runId?: string;
  sessionId?: string;
  logger?: PiLogger;
}

export class PiHostError extends Error {
  override readonly name = "PiHostError";
  readonly code: PiHostErrorCode;
  readonly runId?: string;
  readonly sessionId?: string;
  override readonly cause?: unknown;

  constructor(
    code: PiHostErrorCode,
    message: string,
    options: { cause?: unknown; runId?: string; sessionId?: string } = {},
  ) {
    super(message);
    this.code = code;
    this.cause = options.cause;
    this.runId = options.runId;
    this.sessionId = options.sessionId;
  }
}

/** Motifs du SDK associés à un rejet de prompt (avant toute génération). */
const REJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /no model/i,
  /no api key/i,
  /authentication failed/i,
  /not authenticated/i,
  /already processing/i,
  /compaction is in progress/i,
  /cannot be queued/i,
];

/** Motifs associés à une ressource indisponible ou non inscriptible. */
const RESOURCE_PATTERNS: ReadonlyArray<RegExp> = [
  /read-only file system/i,
  /permission denied/i,
  /EACCES/,
  /EROFS/,
  /ENOSPC/,
];

function rawMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  return /abort/i.test(rawMessage(error));
}

/**
 * Traduit une erreur quelconque (SDK, Node, inconnue) en `PiHostError` à code
 * stable. Le message d'origine est conservé dans `cause`, jamais exposé brut
 * comme message de façade.
 */
export function toPiHostError(
  error: unknown,
  context: PiHostErrorContext = {},
): PiHostError {
  if (error instanceof PiHostError) return error;

  const raw = rawMessage(error);
  const { runId, sessionId, logger } = context;

  if (isAbortError(error)) {
    return new PiHostError("PI_ABORTED", "Run interrompu.", {
      cause: error,
      runId,
      sessionId,
    });
  }

  if (error instanceof Error && error.name === "TimeoutError") {
    return new PiHostError("PI_TIMEOUT", "Délai dépassé.", {
      cause: error,
      runId,
      sessionId,
    });
  }

  if (RESOURCE_PATTERNS.some((pattern) => pattern.test(raw))) {
    return new PiHostError(
      "PI_RESOURCE_ERROR",
      "Ressource de l'agent Pi indisponible (écriture impossible ?).",
      { cause: error, runId, sessionId },
    );
  }

  if (REJECTION_PATTERNS.some((pattern) => pattern.test(raw))) {
    return new PiHostError(
      "PI_PROMPT_REJECTED",
      "Le prompt a été refusé avant génération (modèle ou authentification manquant).",
      { cause: error, runId, sessionId },
    );
  }

  // Les erreurs de session/runtime (remplacement, ouverture) sont fréquentes :
  // on les distingue des erreurs strictement inconnues.
  if (/session|runtime|switch|resume/i.test(raw)) {
    return new PiHostError("PI_SESSION_ERROR", "Erreur de session Pi.", {
      cause: error,
      runId,
      sessionId,
    });
  }

  if (logger) {
    logger.debug("pi.error.unmapped", {
      session_id: sessionId,
      run_id: runId,
      error: raw,
    });
  }

  return new PiHostError("PI_UNKNOWN", "Erreur Pi inattendue.", {
    cause: error,
    runId,
    sessionId,
  });
}
