/**
 * Client HTTP du LIBRAIRE de Pi-Web — AUCUN import SDK/typebox.
 *
 * ⚠️ Deux en-têtes sur chaque appel protégé : `Authorization: Bearer <jeton
 * agent>` ET `X-API-Key: <clé libraire>`. Seule `/status` est EXEMPTÉE de la clé
 * libraire (mais reste soumise à l'authentification globale) : on n'envoie donc
 * que le jeton pour elle.
 *
 * ⚠️ Aucun secret n'est journalisé (le logger de Yuki masque déjà les valeurs
 * issues de la config) ni renvoyé dans un message d'erreur : les messages sont
 * des PHRASES, jamais l'URL complète ni un en-tête.
 *
 * ⚠️ Yuki ne va JAMAIS chercher une page web elle-même : ce client ne parle
 * QU'aux routes documentaires du libraire.
 */

import {
  LibrarianError,
  librarianErrorFromStatus,
} from "./errors.js";
import { parseDoc, parseLibrary, parseSearchOutcome, parseStatus } from "./parse.js";
import type {
  LibrarianArchivePayload,
  LibrarianArchiveReceipt,
  LibrarianConfigProvider,
  LibrarianDoc,
  LibrarianLibrary,
  LibrarianLogger,
  LibrarianPort,
  LibrarianSearchOutcome,
  LibrarianStatus,
} from "./types.js";

/** Délai maximal d'un appel « lecture » (ms). */
export const DEFAULT_LIBRARIAN_TIMEOUT_MS = 15_000;
/** Délai maximal d'une RECHERCHE (le libraire peut interroger le web : plus long). */
export const DEFAULT_LIBRARIAN_SEARCH_TIMEOUT_MS = 30_000;

export interface LibrarianClientOptions {
  config: LibrarianConfigProvider;
  /** Injectable pour les tests. Défaut : `fetch` global. */
  fetchImpl?: typeof fetch;
  logger?: LibrarianLogger;
  /** Délai des appels de lecture (défaut `DEFAULT_LIBRARIAN_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Délai des recherches (défaut `DEFAULT_LIBRARIAN_SEARCH_TIMEOUT_MS`). */
  searchTimeoutMs?: number;
}

interface RequestOptions {
  route: "status" | "search" | "library" | "doc" | "archive";
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  /** Envoyer la clé libraire (`X-API-Key`). `false` pour `/status`. */
  withKey: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}

function joinBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * Client du libraire. La configuration (URL + jetons) est relue à CHAQUE appel :
 * une modification dans `/config` s'applique à chaud, sans redémarrage.
 */
export class LibrarianClient implements LibrarianPort {
  private readonly config: LibrarianConfigProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: LibrarianLogger | undefined;
  private readonly timeoutMs: number;
  private readonly searchTimeoutMs: number;

  constructor(options: LibrarianClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LIBRARIAN_TIMEOUT_MS;
    this.searchTimeoutMs = options.searchTimeoutMs ?? DEFAULT_LIBRARIAN_SEARCH_TIMEOUT_MS;
  }

  async status(signal?: AbortSignal): Promise<LibrarianStatus> {
    const { data } = await this.request({
      route: "status",
      method: "GET",
      path: "/status",
      withKey: false,
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
      withKey: true,
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
      withKey: true,
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
      withKey: true,
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
      withKey: true,
      timeoutMs: this.timeoutMs,
      ...(signal ? { signal } : {}),
    });
    return { name: payload.name, version: payload.version, status };
  }

  /** Cœur : construit la requête, borne le délai, traduit les erreurs. */
  private async request(options: RequestOptions): Promise<{ status: number; data: unknown }> {
    const config = this.config();
    const baseUrl = joinBaseUrl(config.baseUrl);
    const token = config.agentToken.trim();
    const key = config.apiKey.trim();

    if (baseUrl === "") {
      throw new LibrarianError("not_configured");
    }
    if (token === "") {
      throw new LibrarianError("not_configured");
    }
    if (options.withKey && key === "") {
      throw new LibrarianError("not_configured");
    }

    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
    if (options.withKey) headers["x-api-key"] = key;
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
      const mapped = librarianErrorFromStatus(response.status, { route: options.route });
      this.logger?.warn("librarian.request.refused", {
        route: options.route,
        status: response.status,
        code: mapped.code,
      });
      throw mapped;
    }

    try {
      return { status: response.status, data: (await response.json()) as unknown };
    } catch (error) {
      throw new LibrarianError("invalid_response", { cause: error });
    }
  }
}

/** Fabrique du client du libraire. */
export function createLibrarianClient(options: LibrarianClientOptions): LibrarianClient {
  return new LibrarianClient(options);
}
