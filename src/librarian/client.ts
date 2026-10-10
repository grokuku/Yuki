/**
 * Client HTTP du LIBRAIRE (Libry) — AUCUN import SDK/typebox.
 *
 * ⚠️ Libry n'a qu'UNE couche d'authentification : une clé acceptée
 * indifféremment en `Authorization: Bearer <clé>` OU en `X-API-Key: <clé>`
 * (au moins une des deux valide suffit). On envoie donc CHAQUE en-tête
 * disponible : `Authorization` seulement si `agentToken` est renseigné, et
 * `X-API-Key` seulement si `apiKey` est renseigné. ⚠️ `apiKey` est le champ de
 * RÉFÉRENCE ; `agentToken` est FACULTATIF (compatibilité : renseigné, il est
 * toujours envoyé).
 *
 * ⚠️ Aucun secret n'est journalisé (le logger de Yuki masque déjà les valeurs
 * issues de la config) ni renvoyé dans un message d'erreur : les messages sont
 * des PHRASES, jamais l'URL complète ni un en-tête.
 *
 * ⚠️ Yuki ne va JAMAIS chercher une page web elle-même SAUF via la capture
 * explicite de Libry (`screenshot`) : ce client ne parle qu'aux routes du
 * libraire (documentaires + capture).
 */

import {
  LibrarianError,
  librarianErrorFromStatus,
} from "./errors.js";
import {
  parseDoc,
  parseLibrary,
  parseScreenshot,
  parseSearchOutcome,
  parseStatus,
} from "./parse.js";
import type {
  LibrarianArchivePayload,
  LibrarianArchiveReceipt,
  LibrarianConfigProvider,
  LibrarianDoc,
  LibrarianLibrary,
  LibrarianLogger,
  LibrarianPort,
  LibrarianScreenshot,
  LibrarianScreenshotOptions,
  LibrarianScreenshotPort,
  LibrarianSearchOutcome,
  LibrarianShotImage,
  LibrarianStatus,
} from "./types.js";

/** Délai maximal d'un appel « lecture » (ms). */
export const DEFAULT_LIBRARIAN_TIMEOUT_MS = 15_000;
/** Délai maximal d'une RECHERCHE (le libraire peut interroger le web : plus long). */
export const DEFAULT_LIBRARIAN_SEARCH_TIMEOUT_MS = 30_000;
/** Délai maximal d'une CAPTURE de page web (Chromium headless côté Libry). */
export const DEFAULT_LIBRARIAN_SCREENSHOT_TIMEOUT_MS = 30_000;

export interface LibrarianClientOptions {
  config: LibrarianConfigProvider;
  /** Injectable pour les tests. Défaut : `fetch` global. */
  fetchImpl?: typeof fetch;
  logger?: LibrarianLogger;
  /** Délai des appels de lecture (défaut `DEFAULT_LIBRARIAN_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Délai des recherches (défaut `DEFAULT_LIBRARIAN_SEARCH_TIMEOUT_MS`). */
  searchTimeoutMs?: number;
  /** Délai des captures (défaut `DEFAULT_LIBRARIAN_SCREENSHOT_TIMEOUT_MS`). */
  screenshotTimeoutMs?: number;
}

interface RequestOptions {
  route:
    | "status"
    | "search"
    | "library"
    | "doc"
    | "archive"
    | "screenshot"
    | "shot";
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /**
   * Exige la clé libraire : routes PROTÉGÉES (recherche, bibliothèque, doc,
   * archive, capture). `false` pour `/status`, qui accepte n'importe laquelle
   * des deux clés.
   */
  requireKey: boolean;
  /** Type(s) MIME acceptés (défaut `application/json`). */
  accept?: string;
  /** `true` pour une réponse BINAIRE (image) : le corps n'est pas lu en JSON. */
  binary?: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

function joinBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * Client du libraire. La configuration (URL + clés) est relue à CHAQUE appel :
 * une modification dans `/config` s'applique à chaud, sans redémarrage.
 */
export class LibrarianClient implements LibrarianPort, LibrarianScreenshotPort {
  private readonly config: LibrarianConfigProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: LibrarianLogger | undefined;
  private readonly timeoutMs: number;
  private readonly searchTimeoutMs: number;
  private readonly screenshotTimeoutMs: number;

  constructor(options: LibrarianClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LIBRARIAN_TIMEOUT_MS;
    this.searchTimeoutMs = options.searchTimeoutMs ?? DEFAULT_LIBRARIAN_SEARCH_TIMEOUT_MS;
    this.screenshotTimeoutMs =
      options.screenshotTimeoutMs ?? DEFAULT_LIBRARIAN_SCREENSHOT_TIMEOUT_MS;
  }

  async status(signal?: AbortSignal): Promise<LibrarianStatus> {
    const { data } = await this.request({
      route: "status",
      method: "GET",
      path: "/status",
      requireKey: false,
      timeoutMs: this.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return parseStatus(data);
  }

  async search(query: string, signal?: AbortSignal): Promise<LibrarianSearchOutcome> {
    const { data } = await this.request({
      route: "search",
      method: "POST",
      path: "/search",
      body: { query },
      requireKey: true,
      timeoutMs: this.searchTimeoutMs,
      ...(signal ? { signal } : {}),
    });
    return parseSearchOutcome(data);
  }

  async library(signal?: AbortSignal): Promise<LibrarianLibrary> {
    const { data } = await this.request({
      route: "library",
      method: "GET",
      path: "/library",
      requireKey: true,
      timeoutMs: this.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return parseLibrary(data);
  }

  async doc(name: string, version?: string, signal?: AbortSignal): Promise<LibrarianDoc> {
    const suffix = version && version.trim() !== ""
      ? `?version=${encodeURIComponent(version.trim())}`
      : "";
    const { data } = await this.request({
      route: "doc",
      method: "GET",
      path: `/doc/${encodeURIComponent(name)}${suffix}`,
      requireKey: true,
      timeoutMs: this.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return parseDoc(data);
  }

  async archive(
    payload: LibrarianArchivePayload,
    signal?: AbortSignal,
  ): Promise<LibrarianArchiveReceipt> {
    const { status } = await this.request({
      route: "archive",
      method: "POST",
      path: "/archive",
      body: payload,
      requireKey: true,
      timeoutMs: this.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return { name: payload.name, version: payload.version, status };
  }

  /** Demande une CAPTURE de page web (Chromium headless côté Libry). */
  async screenshot(
    url: string,
    options: LibrarianScreenshotOptions = {},
    signal?: AbortSignal,
  ): Promise<LibrarianScreenshot> {
    const body: Record<string, unknown> = { url };
    if (options.width !== undefined) body.width = options.width;
    if (options.height !== undefined) body.height = options.height;
    if (options.timeoutMs !== undefined) body.timeoutMs = options.timeoutMs;
    if (options.inline !== undefined) body.inline = options.inline;
    const { data } = await this.request({
      route: "screenshot",
      method: "POST",
      path: "/screenshot",
      body,
      requireKey: true,
      timeoutMs: this.screenshotTimeoutMs,
      ...(signal ? { signal } : {}),
    });
    return parseScreenshot(data);
  }

  /** Télécharge l'image d'une capture (`GET /api/librarian/shot/:id.png`). */
  async shot(id: string, signal?: AbortSignal): Promise<LibrarianShotImage> {
    const { bytes, mimeType } = await this.requestBinary({
      route: "shot",
      method: "GET",
      path: `/shot/${encodeURIComponent(id)}.png`,
      requireKey: true,
      accept: "image/png, image/*;q=0.8",
      binary: true,
      timeoutMs: this.screenshotTimeoutMs,
      ...(signal ? { signal } : {}),
    });
    return { bytes, mimeType };
  }

  /** Cœur : construit la requête (en-têtes/URL/délai) puis lit le JSON. */
  private async request(options: RequestOptions): Promise<{ status: number; data: unknown }> {
    const response = await this.send(options);
    try {
      return { status: response.status, data: (await response.json()) as unknown };
    } catch (error) {
      throw new LibrarianError("invalid_response", { cause: error });
    }
  }

  /** Variante BINAIRE (image) : aucun parsing JSON. */
  private async requestBinary(
    options: RequestOptions,
  ): Promise<{ status: number; bytes: Uint8Array; mimeType: string }> {
    const response = await this.send(options);
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      throw new LibrarianError("invalid_response", { cause: error });
    }
    const rawType = response.headers.get("content-type") ?? "";
    const mimeType = rawType.split(";")[0]?.trim().toLowerCase() || "application/octet-stream";
    return { status: response.status, bytes, mimeType };
  }

  /**
   * Envoie la requête HTTP et traduit les statuts non-2xx en causes distinctes.
   * Aucune cause n'est inventée : la route est transmise pour que `403` (SSRF
   * sur capture vs jeton invalide ailleurs) soit lu correctement.
   */
  private async send(options: RequestOptions): Promise<Response> {
    const config = this.config();
    const baseUrl = joinBaseUrl(config.baseUrl);
    const token = config.agentToken.trim();
    const key = config.apiKey.trim();

    if (baseUrl === "") {
      throw new LibrarianError("not_configured");
    }
    // ⚠️ `agentToken` est FACULTATIF : on n'exige plus qu'il soit non vide.
    if (options.requireKey) {
      if (key === "") throw new LibrarianError("not_configured");
    } else if (token === "" && key === "") {
      // `/status` : au moins UNE des deux clés doit être disponible.
      throw new LibrarianError("not_configured");
    }

    const headers: Record<string, string> = {
      accept: options.accept ?? "application/json",
    };
    // ⚠️ Chaque en-tête n'est posé QUE si sa valeur existe : un agentToken vide
    // n'est PLUS envoyé (il ne peut donc plus masquer une clé valide).
    if (token !== "") headers["authorization"] = `Bearer ${token}`;
    if (key !== "") headers["x-api-key"] = key;
    if (options.body !== undefined) headers["content-type"] = "application/json";

    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    timer.unref?.();

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}/api/librarian${options.path}`, {
        method: options.method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      // ⚠️ Cause honnête : connexion impossible OU délai dépassé. On ne devine pas
      // laquelle (les deux sont regroupées sous « injoignable »).
      this.logger?.warn("librarian.request.failed", {
        route: options.route,
        reason: "unreachable",
      });
      throw new LibrarianError("unreachable", { cause: error });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onExternalAbort);
    }

    if (!response.ok) {
      const retryAfterSeconds = readRetryAfterSeconds(response);
      const mapped = librarianErrorFromStatus(response.status, {
        route: options.route,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      });
      this.logger?.warn("librarian.request.refused", {
        route: options.route,
        status: response.status,
        code: mapped.code,
      });
      throw mapped;
    }

    return response;
  }
}

/** Lit l'en-tête `Retry-After` (secondes), s'il est un entier positif. */
function readRetryAfterSeconds(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null) return undefined;
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return undefined;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

/** Fabrique du client du libraire. */
export function createLibrarianClient(options: LibrarianClientOptions): LibrarianClient {
  return new LibrarianClient(options);
}
