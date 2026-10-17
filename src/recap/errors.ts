/**
 * Erreurs du domaine « récapitulatif de conversation dédiée ».
 *
 * Chaque cause a un CODE STABLE, traduit par le transport en code de trame
 * (`recap_*`). Aucun message ne contient de secret ni de contenu de conversation.
 */

export type RecapErrorCode =
  | "recap_unavailable"
  | "recap_too_long"
  | "recap_empty"
  | "recap_failed"
  | "recap_busy"
  | "recap_not_found";

export class RecapError extends Error {
  readonly code: RecapErrorCode;

  constructor(code: RecapErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RecapError";
    this.code = code;
  }
}
