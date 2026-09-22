/**
 * API de configuration (Lot 11) — `node:http`, aucun framework.
 *
 * Routes (fonctionnent même en mode dégradé, sans clé, sans PiHost) :
 *   GET  /api/config          → valeurs effectives (jamais une clé en clair)
 *   PUT  /api/config          → patch partiel fusionnant
 *   POST /api/config/llm/test → test de connexion (endpoint OpenAI `/models`)
 *
 * Précédence : `défauts < store < env`. Un champ défini par l'environnement est
 * VERROUILLÉ : un `PUT` le visant est refusé (`locked_by_env`), jamais un no-op
 * silencieux.
 *
 * Précautions minimales (le durcissement complet est au Lot 9) : en-tête
 * personnalisé `X-Yuki-Config: 1` + contrôle `Origin`/`Host` sur les écritures,
 * journal d'audit sans valeur de secret.
 */

import type { IncomingHttpHeaders } from "node:http";

import {
  ConfigValidationError,
  LockedByEnvError,
  type ConfigRuntime,
} from "../../config/runtime.js";
import { ConfigStoreWriteError } from "../../config/store.js";
import { describeWriteFailure } from "../../config/paths.js";
import type { Logger } from "../../observability/logger.js";

export const CONFIG_WRITE_HEADER = "x-yuki-config";
export const CONFIG_HEADER_VALUE = "1";
/** Délai du test de connexion LLM. */
export const LLM_TEST_TIMEOUT_MS = 5_000;
/** Taille maximale acceptée pour un corps de requête. */
export const MAX_CONFIG_BODY_BYTES = 1_000_000;

export interface ConfigApiDeps {
  runtime: ConfigRuntime;
  logger: Logger;
  /** Injectable pour les tests. Défaut : `fetch` global. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface ConfigHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface ConfigRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  deps: ConfigApiDeps;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(status: number, body: unknown): ConfigHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

/**
 * Lit un en-tête de façon insensible à la casse. `node:http` minuscule déjà les
 * noms, mais l'API est aussi appelée avec des en-têtes forgés (tests, proxies).
 */
function headerString(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) return raw[0];
  }
  return undefined;
}

/**
 * Normalise un hôte (en-tête `Host` ou URL `Origin`) en `host[:port]` :
 * minuscules et port par défaut retiré. Le schéma est ignoré (couvre la
 * terminaison TLS derrière un reverse-proxy). Renvoie `null` si non analysable.
 */
function normalizeHost(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    const host = url.hostname.toLowerCase();
    return url.port === "" ? host : `${host}:${url.port}`;
  } catch {
    return null;
  }
}

/**
 * Contrôle `Origin`/`Host` : si un `Origin` est présent, son hôte doit
 * correspondre à celui de la requête (même origine).
 *
 * Couvre un accès légitime par IP LAN (`http://10.10.0.5:8083`), par nom
 * d'hôte (casse insensible) et derrière un reverse-proxy (port par défaut,
 * schéma TLS terminé en amont), SANS l'ouvrir à une origine étrangère.
 */
function sameOrigin(headers: IncomingHttpHeaders): boolean {
  const origin = headerString(headers, "origin");
  if (origin === undefined) return true; // pas d'Origin (ex. curl) : autorisé
  const host = headerString(headers, "host");
  if (host === undefined) return false;
  const originHost = normalizeHost(origin);
  const requestHost = normalizeHost(host);
  return originHost !== null && requestHost !== null && originHost === requestHost;
}

/** Applique les garde-fous des routes d'écriture. Renvoie une erreur ou `null`. */
export function requireWriteGuards(
  headers: IncomingHttpHeaders,
): ConfigHttpResponse | null {
  if (headerString(headers, CONFIG_WRITE_HEADER) !== CONFIG_HEADER_VALUE) {
    return json(403, {
      error: "forbidden",
      code: "missing_config_header",
      message: `En-tête ${CONFIG_WRITE_HEADER}: ${CONFIG_HEADER_VALUE} requis.`,
    });
  }
  if (!sameOrigin(headers)) {
    return json(403, {
      error: "forbidden",
      code: "bad_origin",
      message: "Origine de la requête refusée.",
    });
  }
  return null;
}

function guardWrite(input: ConfigRequestInput): ConfigHttpResponse | null {
  return requireWriteGuards(input.headers);
}

function audit(deps: ConfigApiDeps, changes: ReturnType<ConfigRuntime["update"]>["changes"]): void {
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  for (const change of changes) {
    deps.logger.info("config.changed", {
      at,
      field: change.path,
      kind: change.secret ? "secret" : "value",
      from: change.from,
      to: change.to,
    });
  }
}

function handleGet(deps: ConfigApiDeps): ConfigHttpResponse {
  const snapshot = deps.runtime.snapshot();
  return json(200, { fields: snapshot.fields, status: snapshot.status });
}

function handlePut(input: ConfigRequestInput): ConfigHttpResponse {
  const guard = guardWrite(input);
  if (guard) return guard;

  let patch: unknown;
  try {
    patch = input.body.trim() === "" ? {} : JSON.parse(input.body);
  } catch {
    return json(400, {
      error: "invalid_json",
      fields: [{ path: "", code: "invalid_json", message: "Corps JSON invalide." }],
    });
  }
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    return json(400, {
      error: "invalid_body",
      fields: [
        {
          path: "",
          code: "invalid_body",
          message: "Objet JSON attendu (patch de champs).",
        },
      ],
    });
  }

  try {
    const result = input.deps.runtime.update(patch as Record<string, unknown>);
    audit(input.deps, result.changes);
    return json(200, {
      fields: result.fields,
      status: result.status,
      applied: result.applied,
    });
  } catch (error) {
    if (error instanceof LockedByEnvError) {
      const variable = error.locked[0]?.variable;
      return json(400, {
        error: "locked_by_env",
        code: "locked_by_env",
        ...(variable ? { variable } : {}),
        fields: error.locked.map((entry) => ({
          path: entry.path,
          code: "locked_by_env",
          message: `Champ verrouillé par l'environnement (${entry.variable}).`,
        })),
      });
    }
    if (error instanceof ConfigValidationError) {
      return json(400, { error: "invalid_config", fields: error.fields });
    }
    if (error instanceof ConfigStoreWriteError) {
      // Cause journalisée ET renvoyée : un 500 muet rendrait le diagnostic
      // impossible (volume `state` non inscriptible, disque plein…).
      input.deps.logger.error("config.store.write_failed", {
        field: "store",
        path: error.path,
        code: error.code,
        reason: error.reason,
        error: error.cause instanceof Error ? error.cause.message : String(error.cause),
      });
      return json(500, {
        error: "config_store_unwritable",
        code: "config_store_unwritable",
        path: error.path,
        // Le conseil dépend de la CAUSE RÉELLE (code système) : « :ro » pour
        // EROFS, permissions pour EACCES/EPERM, absent pour ENOENT, honnête
        // (avec le code brut) sinon. Jamais de `chown` quand le montage est ro.
        message: `${error.message} ${describeWriteFailure({
          volume: "state",
          path: error.path,
          code: error.code,
          service: "gateway",
        })}`,
      });
    }
    throw error;
  }
}

async function handleLlmTest(input: ConfigRequestInput): Promise<ConfigHttpResponse> {
  const guard = guardWrite(input);
  if (guard) return guard;

  let body: Record<string, unknown>;
  try {
    const parsed = input.body.trim() === "" ? {} : JSON.parse(input.body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("objet attendu");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return json(400, {
      error: "invalid_json",
      fields: [{ path: "", code: "invalid_json", message: "Corps JSON invalide." }],
    });
  }

  const role = body.role;
  if (role !== "light" && role !== "heavy") {
    return json(400, {
      error: "invalid_role",
      fields: [
        {
          path: "role",
          code: "invalid_role",
          message: 'Rôle attendu : "light" ou "heavy".',
        },
      ],
    });
  }

  const prefix = `llm.${role}`;
  const baseUrl = input.deps.runtime.getString(`${prefix}.baseUrl`).replace(/\/+$/, "");
  const provided =
    typeof body.apiKey === "string" && body.apiKey.trim() !== ""
      ? body.apiKey.trim()
      : undefined;
  const key = provided ?? input.deps.runtime.getString(`${prefix}.apiKey`).trim();
  if (key.length === 0) {
    return json(200, {
      ok: false,
      error: "Aucune clé fournie ni configurée pour ce rôle.",
    });
  }

  const url = `${baseUrl}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const fetchImpl = input.deps.fetchImpl ?? fetch;
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      return json(200, {
        ok: false,
        status: response.status,
        error: `Le fournisseur a répondu ${response.status}.`,
      });
    }
    let models: string[] | undefined;
    try {
      const data = (await response.json()) as { data?: unknown };
      if (Array.isArray(data?.data)) {
        models = data.data
          .map((entry) => (entry as { id?: unknown } | null)?.id)
          .filter((id): id is string => typeof id === "string");
      }
    } catch {
      // Modèles indisponibles : le test reste OK.
    }
    return json(200, {
      ok: true,
      status: response.status,
      ...(models ? { models } : {}),
    });
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? `Délai dépassé (${LLM_TEST_TIMEOUT_MS / 1000} s).`
        : error instanceof Error
          ? error.message
          : String(error);
    return json(200, { ok: false, error: message });
  } finally {
    clearTimeout(timer);
  }
}

/** Vrai si le chemin relève de l'API de configuration. */
export function isConfigPath(path: string): boolean {
  return path === "/api/config" || path.startsWith("/api/config/");
}

/** Traite une requête de configuration et renvoie la réponse HTTP. */
export async function handleConfigRequest(
  input: ConfigRequestInput,
): Promise<ConfigHttpResponse> {
  const { method, path } = input;
  if (path === "/api/config") {
    if (method === "GET" || method === "HEAD") return handleGet(input.deps);
    if (method === "PUT") return handlePut(input);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/config/llm/test") {
    if (method === "POST") return handleLlmTest(input);
    return json(405, { error: "method_not_allowed", method });
  }
  return json(404, { error: "not_found", path });
}
