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
 *  - `read_blocked`      : 403 sur une LECTURE — URL interne/privée ou schéma refusé ;
 *  - `read_too_large`    : 413 sur une LECTURE — page au-delà du plafond (3 Mio) ;
 *  - `read_not_text`     : 415 sur une LECTURE — la ressource n'est pas du texte ;
 *  - `read_failed`       : 502 sur une LECTURE — DNS, réseau, page d'erreur, redirections ;
 *  - `read_timeout`      : 504 sur une LECTURE — délai de lecture dépassé ;
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
  | "read_blocked"
  | "read_too_large"
  | "read_not_text"
  | "read_failed"
  | "read_timeout"
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
  read_blocked:
    "Le libraire a refusé de lire cette page (403) : adresse interne/privée ou schéma " +
    "non autorisé. Seules les URL http/https publiques sont lisibles.",
  read_too_large:
    "La page est trop volumineuse pour être lue (413) : le libraire refuse de " +
    "télécharger au-delà de 3 Mio. Cette page ne peut pas être lue en entier.",
  read_not_text:
    "Cette adresse ne renvoie pas du TEXTE (415) : le contenu n'est pas lisible " +
    "comme du texte (binaire, image, archive…). Une capture d'écran ne le rendrait " +
    "pas lisible non plus.",
  read_failed:
    "Le libraire n'a pas pu lire la page (502) : nom de domaine introuvable, réseau " +
    "indisponible, page en erreur (404/403 côté site) ou trop de redirections.",
  read_timeout:
    "La lecture de la page a dépassé le délai imparti (504) : le site n'a pas " +
    "répondu à temps. Réessayez, ou demandez moins de texte (« limit » plus petit).",
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
  /**
   * Code TYPÉ renvoyé par Libry lui-même quand il en fournit un (`TOO_LARGE`,
   * `NOT_TEXT`, `HTTP_403`, `TIMEOUT`, `BLOCKED_URL`, …). ⚠️ C'est la cause
   * PRÉCISE du service, pas une déduction de Yuki : elle est transmise au modèle
   * telle quelle (texte ET `details`).
   */
  readonly upstreamCode: string | undefined;

  constructor(
    code: LibrarianErrorCode,
    options: { message?: string; status?: number; cause?: unknown; upstreamCode?: string } = {},
  ) {
    super(options.message ?? LIBRARIAN_ERROR_MESSAGES[code], {
      ...(options.cause !== undefined ? { cause: options.cause } : {}),
    });
    this.code = code;
    this.status = options.status;
    this.upstreamCode = options.upstreamCode;
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
 *
 * ⚠️ La route de LECTURE (`/read`) a la SIENNE, plus fine encore : `413`
 * (`TOO_LARGE`), `415` (`NOT_TEXT`), `504` (`TIMEOUT`) et `502` (DNS, réseau,
 * `HTTP_404`/`HTTP_403` du site, redirections) sont des causes DISTINCTES qui
 * doivent parvenir au modèle comme une RAISON, jamais comme « échec générique ».
 * Le code typé renvoyé par Libry est conservé (`upstreamCode`).
 */
export function librarianErrorFromStatus(
  status: number,
  context: { route: string; retryAfterSeconds?: number; upstreamCode?: string },
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

  if (context.route === "read") {
    return readErrorFromStatus(status, context);
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

/**
 * Traduit un statut de `POST /api/librarian/read` en cause DISTINCTE.
 *
 * ⚠️ Le `code` du service (`upstreamCode` : `TOO_LARGE`, `NOT_TEXT`,
 * `HTTP_403`, `DNS`, `TIMEOUT`, …) est CONSERVÉ : le modèle reçoit la raison
 * exacte, pas seulement « le libraire a échoué ».
 */
function readErrorFromStatus(
  status: number,
  context: { retryAfterSeconds?: number; upstreamCode?: string },
): LibrarianError {
  const upstreamCode = context.upstreamCode;
  const raise = (code: LibrarianErrorCode, extra?: string): LibrarianError =>
    new LibrarianError(code, {
      status,
      ...(upstreamCode !== undefined ? { upstreamCode } : {}),
      message: [
        LIBRARIAN_ERROR_MESSAGES[code],
        upstreamCode !== undefined ? `Code du libraire : ${upstreamCode}.` : "",
        extra ?? "",
      ]
        .filter((part) => part !== "")
        .join(" "),
    });

  switch (status) {
    case 400:
      return raise(
        "bad_request",
        "Paramètres attendus : `url` (http/https) et, en option, `offset` (entier ≥ 0) " +
          "et `limit` (entier ≥ 1).",
      );
    case 401:
      return raise("unauthorized_key");
    // 403 sur /read = protection SSRF de Libry (message volontairement générique).
    // ⚠️ Cause PROPRE à la lecture (`read_blocked`) : `target_refused` parle de
    // « pages capturées », ce qui n'est pas ce qu'on vient de demander.
    case 403:
      return raise("read_blocked");
    case 413:
      return raise("read_too_large");
    case 415:
      return raise("read_not_text");
    case 429:
      return rateLimitedError(status, context.retryAfterSeconds);
    case 502:
      return raise("read_failed", REFINEMENT_502[upstreamCode ?? ""] ?? "");
    case 504:
      return raise("read_timeout");
    default:
      return raise("server_error");
  }
}

/**
 * Précisions HONNÊTES ajoutées au 502 de `/read`, selon le code du libraire.
 * Aucune n'invente une cause : chacune reformule le code reçu.
 */
const REFINEMENT_502: Readonly<Record<string, string>> = {
  DNS: "Le nom de domaine de cette adresse n'existe pas (DNS).",
  NETWORK: "La connexion au site a échoué (réseau).",
  HTTP_404: "Le site répond « page introuvable » (404) : cette adresse n'existe pas.",
  HTTP_403: "Le site refuse l'accès à cette page (403).",
  TOO_MANY_REDIRECTS: "La page redirige trop de fois (5 redirections maximum).",
};

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
