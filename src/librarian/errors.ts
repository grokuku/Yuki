/**
 * Erreurs du LIBRAIRE (recherche documentaire + web) — messages HONNÊTES et
 * DISTINCTS (aucune cause inventée).
 *
 * ⚠️ Le libraire (Libry) est un service EXTERNE, joint en HTTP. Chaque cause
 * d'échec a un code DISTINCT, traduit en une phrase française qui dit ce qui a
 * RÉELLEMENT été observé — jamais un message générique « échec du libraire » :
 *  - `not_configured`    : URL/liaison absente de la configuration de Yuki ;
 *  - `unauthorized_key`  : 401 — aucune clé valide (ni X-API-Key, ni Authorization) ;
 *  - `unauthorized_token`: 403 — jeton agent (`Authorization`) refusé sur une route hors capture ;
 *  - `target_refused`    : 403 sur une CAPTURE — URL refusée par la protection SSRF ;
 *  - `rate_limited`      : 429 — trop de requêtes (ou trop de captures simultanées) ;
 *  - `not_found`         : 404 — document absent de la bibliothèque ;
 *  - `bad_request`       : 400 — requête non conforme (nom/version, ou URL de capture invalide) ;
 *  - `web_unavailable`   : 502/500 sur `/search` — moteurs web indisponibles ;
 *  - `capture_failed`    : 502 sur une CAPTURE — page non capturable ;
 *  - `capture_timeout`   : 504 sur une CAPTURE — délai de capture dépassé ;
 *  - `server_error`      : autre 5xx ;
 *  - `unreachable`       : connexion impossible / délai dépassé (⚠️ réseau) ;
 *  - `invalid_response`  : corps illisible (JSON attendu).
 *
 * AUCUN secret n'entre dans un message : seuls des codes et des libellés.
 */

/** Cause d'échec d'un appel au libraire. */
export type LibrarianErrorCode =
  | "not_configured"
  | "unauthorized_key"
  | "unauthorized_token"
  | "target_refused"
  | "rate_limited"
  | "not_found"
  | "bad_request"
  | "web_unavailable"
  | "capture_failed"
  | "capture_timeout"
  | "server_error"
  | "unreachable"
  | "invalid_response";

/** Message français associé à chaque cause (jamais une cause inventée). */
export const LIBRARIAN_ERROR_MESSAGES: Readonly<Record<LibrarianErrorCode, string>> = {
  not_configured:
    "Le libraire n'est pas configuré : renseignez l'URL de base et la clé libraire " +
    "(X-API-Key) dans /config (onglet Système → Libraire). Le jeton agent " +
    "(Authorization) est facultatif.",
  unauthorized_key:
    "Le libraire a refusé la requête (401) : aucune clé valide n'a été acceptée. " +
    "Vérifiez la clé libraire (X-API-Key) — et, si vous en utilisez un, le jeton " +
    "agent (Authorization).",
  unauthorized_token:
    "Le libraire a refusé la requête (403) : le jeton agent (en-tête Authorization) " +
    "est invalide ou refusé.",
  target_refused:
    "Le libraire a refusé cette URL (403) : adresse interne/privée ou schéma non " +
    "autorisé. Seules les URL http/https publiques peuvent être capturées.",
  rate_limited:
    "Le libraire a répondu « trop de requêtes » (429) : réessayez dans un instant.",
  not_found: "Document absent de la bibliothèque du libraire (404).",
  bad_request:
    "Le libraire a rejeté la requête (400) : le nom ou la version ne sont pas " +
    "des composants de chemin valides (aucun « / », « \\ » ni « .. »).",
  web_unavailable:
    "Le libraire est joignable mais ses moteurs de recherche web sont " +
    "indisponibles (502) : la bibliothèque locale peut rester consultable.",
  capture_failed:
    "Le libraire n'a pas pu capturer la page (502) : la cible est peut-être " +
    "inaccessible ou refuse la connexion.",
  capture_timeout:
    "La capture a dépassé le délai imparti (504) : réessayez ou augmentez « timeoutMs ».",
  server_error:
    "Le libraire a renvoyé une erreur interne (5xx) : réessayez plus tard.",
  unreachable:
    "Le libraire est INJOIGNABLE depuis Yuki (connexion impossible ou délai " +
    "dépassé) : vérifiez l'URL de base et le réseau entre les deux conteneurs.",
  invalid_response: "Réponse illisible du libraire (JSON attendu).",
};

/** Erreur du libraire : porte un CODE stable et un `status` HTTP optionnel. */
export class LibrarianError extends Error {
  override readonly name = "LibrarianError";
  readonly code: LibrarianErrorCode;
  readonly status: number | undefined;

  constructor(
    code: LibrarianErrorCode,
    options: { message?: string; status?: number; cause?: unknown } = {},
  ) {
    super(options.message ?? LIBRARIAN_ERROR_MESSAGES[code], {
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.code = code;
    this.status = options.status;
  }
}

/** Vrai si l'erreur (inconnue) est une erreur du libraire. */
export function isLibrarianError(error: unknown): error is LibrarianError {
  return error instanceof LibrarianError;
}

/**
 * Traduit un statut HTTP en cause DISTINCTE, selon la ROUTE appelée.
 *
 * `/search` est un cas particulier : sur cette route, un `500` signifie
 * « Webclaw ET Tavily indisponibles » (cf. contrat d'API) → `web_unavailable`.
 *
 * ⚠️ Les routes de CAPTURE (`screenshot`/`shot`) ont leur propre lecture du
 * contrat : `403` y désigne un REFUS SSRF (URL interne/privée), `502` un échec
 * de capture et `504` un dépassement de délai. On ne réutilise donc pas les
 * causes d'authentification sur ces routes.
 */
export function librarianErrorFromStatus(
  status: number,
  context: { route: string; retryAfterSeconds?: number },
): LibrarianError {
  const isCapture = context.route === "screenshot" || context.route === "shot";
  if (isCapture) {
    switch (status) {
      case 400:
        return new LibrarianError("bad_request", {
          status,
          message:
            "Le libraire a rejeté la capture (400) : l'URL est absente ou invalide " +
            "(seules les URL http/https sont acceptées).",
        });
      case 401:
        return new LibrarianError("unauthorized_key", { status });
      // 403 sur une capture = protection SSRF (message GÉNÉRIQUE côté Libry :
      // c'est voulu, on ne divulgue pas la cause exacte).
      case 403:
        return new LibrarianError("target_refused", { status });
      case 429:
        return rateLimitedError(status, context.retryAfterSeconds);
      case 502:
        return new LibrarianError("capture_failed", { status });
      case 504:
        return new LibrarianError("capture_timeout", { status });
      default:
        return new LibrarianError("server_error", { status });
    }
  }

  const isSearch = context.route === "search";
  switch (status) {
    case 400:
      return new LibrarianError("bad_request", { status });
    case 401:
      return new LibrarianError("unauthorized_key", { status });
    case 403:
      return new LibrarianError("unauthorized_token", { status });
    case 404:
      return new LibrarianError("not_found", { status });
    case 429:
      return rateLimitedError(status, context.retryAfterSeconds);
    case 500:
    case 502:
      return isSearch
        ? new LibrarianError("web_unavailable", { status })
        : new LibrarianError("server_error", { status });
    default:
      return new LibrarianError("server_error", { status });
  }
}

/** 429 : message enrichi de `Retry-After` quand l'en-tête est présent. */
function rateLimitedError(status: number, retryAfterSeconds?: number): LibrarianError {
  const base = LIBRARIAN_ERROR_MESSAGES.rate_limited;
  const suffix =
    retryAfterSeconds !== undefined && retryAfterSeconds >= 0
      ? ` Nouvelle tentative conseillée dans ${retryAfterSeconds} seconde(s).`
      : "";
  return new LibrarianError("rate_limited", { status, message: base + suffix });
}

/** Message lisible d'une erreur quelconque (jamais `[object Object]`). */
export function messageOfLibrarianError(error: unknown): string {
  if (isLibrarianError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}
