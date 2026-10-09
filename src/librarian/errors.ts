/**
 * Erreurs du LIBRAIRE (recherche documentaire + web) — messages HONNÊTES et
 * DISTINCTS (aucune cause inventée).
 *
 * ⚠️ Le libraire est un service EXTERNE, joint en HTTP. Chaque cause d'échec a
 * un code DISTINCT, traduit en une phrase française qui dit ce qui a RÉELLEMENT
 * été observé — jamais un message générique « échec du libraire » :
 *  - `not_configured`    : URL/jetons absents de la configuration de Yuki ;
 *  - `unauthorized_key`  : 401 — clé libraire (`X-API-Key`) manquante ou invalide ;
 *  - `unauthorized_token`: 403 — jeton agent (`Authorization`) invalide ;
 *  - `rate_limited`      : 429 — limite ~600 req/min/IP dépassée ;
 *  - `not_found`         : 404 — document absent de la bibliothèque ;
 *  - `bad_request`       : 400 — `name`/`version` non conformes ;
 *  - `web_unavailable`   : 502/500 sur `/search` — moteurs web indisponibles ;
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
  | "rate_limited"
  | "not_found"
  | "bad_request"
  | "web_unavailable"
  | "server_error"
  | "unreachable"
  | "invalid_response";

/** Message français associé à chaque cause (jamais une cause inventée). */
export const LIBRARIAN_ERROR_MESSAGES: Readonly<Record<LibrarianErrorCode, string>> = {
  not_configured:
    "Le libraire n'est pas configuré : renseignez l'URL de base, le jeton agent " +
    "et la clé libraire dans /config (onglet Système → Libraire).",
  unauthorized_key:
    "Le libraire a refusé la requête (401) : la clé libraire (en-tête X-API-Key) " +
    "est manquante ou invalide.",
  unauthorized_token:
    "Le libraire a refusé la requête (403) : le jeton agent (en-tête Authorization) " +
    "est invalide ou refusé.",
  rate_limited:
    "Le libraire a répondu « trop de requêtes » (429, limite ~600/min) : " +
    "réessayez dans une minute.",
  not_found: "Document absent de la bibliothèque du libraire (404).",
  bad_request:
    "Le libraire a rejeté la requête (400) : le nom ou la version ne sont pas " +
    "des composants de chemin valides (aucun « / », « \\ » ni « .. »).",
  web_unavailable:
    "Le libraire est joignable mais ses moteurs de recherche web sont " +
    "indisponibles (502) : la bibliothèque locale peut rester consultable.",
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
 * Traduit un statut HTTP en cause DISTINCTE.
 *
 * `search` est un cas particulier : sur la route `/search`, un `500` signifie
 * « Webclaw ET Tavily indisponibles » (cf. contrat d'API) — on le classe donc en
 * `web_unavailable`, pas en `server_error`.
 */
export function librarianErrorFromStatus(
  status: number,
  context: { route: string },
): LibrarianError {
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
      return new LibrarianError("rate_limited", { status });
    case 500:
    case 502:
      return isSearch
        ? new LibrarianError("web_unavailable", { status })
        : new LibrarianError("server_error", { status });
    default:
      return status >= 500
        ? new LibrarianError("server_error", { status })
        : new LibrarianError("server_error", { status });
  }
}

/** Message lisible d'une erreur quelconque (jamais `[object Object]`). */
export function messageOfLibrarianError(error: unknown): string {
  if (isLibrarianError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}
