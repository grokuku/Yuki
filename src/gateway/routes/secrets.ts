/**
 * API de gestion du COFFRE DE SECRETS (`/api/secrets`) — `node:http`, aucun
 * framework.
 *
 * Routes (mêmes garde-fous d'écriture que `/api/config`) :
 *   GET    /api/secrets          → LISTE des NOMS (jamais une valeur)
 *   POST   /api/secrets          → ajoute/remplace un secret `{ name, value, label? }`
 *   DELETE /api/secrets/<nom>    → supprime un secret
 *
 * ⚠️ L'API ne renvoie JAMAIS la valeur d'un secret, ni à l'ajout (on renvoie la
 * vue publique), ni en lecture. Les écritures sont protégées par l'en-tête
 * personnalisé `X-Yuki-Config` + contrôle d'origine (CSRF), comme `/api/config`.
 * Le journal ne mentionne QUE le nom, jamais la valeur.
 */

import type { IncomingHttpHeaders } from "node:http";

import { requireWriteGuards } from "./config.js";
import type { Logger } from "../../observability/logger.js";
import type { SecretDirectoryPort, SecretEntryView } from "../../secrets/directory.js";
import {
  VaultError,
  VaultKeyMissingError,
  VaultNameError,
  VaultValueError,
} from "../../secrets/vault.js";

/** Chemin racine de l'API des secrets. */
export const SECRETS_PATH = "/api/secrets";
/** Préfixe d'une route de suppression (`/api/secrets/<nom>`). */
export const SECRETS_PREFIX = `${SECRETS_PATH}/`;

/** Port consommé : lecture (noms) + mutation. Structurellement `SecretStore`. */
export interface SecretMutatorPort extends SecretDirectoryPort {
  /** Ajoute/remplace un secret, persiste. Lève si le coffre est verrouillé. */
  set(name: string, value: string, label?: string): unknown;
  /** Supprime un secret. Renvoie `true` s'il existait. Lève si verrouillé. */
  delete(name: string): boolean;
}

export interface SecretsApiDeps {
  store: SecretMutatorPort;
  logger: Logger;
}

export interface SecretsHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface SecretsRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  deps: SecretsApiDeps;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(status: number, body: unknown): SecretsHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

/** Le chemin relève-t-il de l'API des secrets ? */
export function isSecretsPath(path: string): boolean {
  return path === SECRETS_PATH || path.startsWith(SECRETS_PREFIX);
}

/** Traduit une erreur du coffre en réponse HTTP honnête (jamais un secret). */
function vaultErrorResponse(error: unknown): SecretsHttpResponse | null {
  if (error instanceof VaultKeyMissingError) {
    return json(503, {
      error: "vault_locked",
      code: "vault_locked",
      message: error.message,
    });
  }
  if (error instanceof VaultNameError || error instanceof VaultValueError) {
    return json(400, { error: "invalid_secret", code: "invalid_secret", message: error.message });
  }
  if (error instanceof VaultError) {
    return json(500, { error: "vault_error", code: "vault_error", message: error.message });
  }
  return null;
}

function handleGet(deps: SecretsApiDeps): SecretsHttpResponse {
  if (!deps.store.isConfigured()) {
    return json(200, {
      configured: false,
      entries: [],
      message:
        "Coffre verrouillé : la clé maître (YUKI_VAULT_KEY) n'est pas définie. " +
        "Aucun secret n'est disponible.",
    });
  }
  try {
    const entries: SecretEntryView[] = deps.store.list();
    return json(200, { configured: true, entries });
  } catch (error) {
    return vaultErrorResponse(error) ?? json(500, { error: "internal_error" });
  }
}

function handlePost(input: SecretsRequestInput): SecretsHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return json(guard.status, guard.body);

  let parsed: unknown;
  try {
    parsed = input.body.trim() === "" ? {} : JSON.parse(input.body);
  } catch {
    return json(400, { error: "invalid_json", code: "invalid_json", message: "Corps JSON invalide." });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json(400, {
      error: "invalid_body",
      code: "invalid_body",
      message: "Objet JSON attendu ({ name, value, label? }).",
    });
  }
  const record = parsed as Record<string, unknown>;
  const name = typeof record["name"] === "string" ? record["name"].trim() : "";
  const value = typeof record["value"] === "string" ? record["value"] : "";
  const label = typeof record["label"] === "string" ? record["label"] : undefined;
  if (name === "" || value === "") {
    return json(400, {
      error: "invalid_body",
      code: "invalid_body",
      message: "Champs `name` et `value` requis.",
    });
  }
  try {
    const view = input.deps.store.set(name, value, label);
    // ⚠️ Journal SANS la valeur : uniquement le nom.
    input.deps.logger.info("secrets.api.saved", { name });
    return json(200, { entry: view });
  } catch (error) {
    return vaultErrorResponse(error) ?? json(500, { error: "internal_error" });
  }
}

function handleDelete(input: SecretsRequestInput): SecretsHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return json(guard.status, guard.body);
  const name = decodeURIComponent(input.path.slice(SECRETS_PREFIX.length));
  if (name.trim() === "") {
    return json(400, { error: "invalid_name", code: "invalid_name", message: "Nom de secret manquant." });
  }
  try {
    const deleted = input.deps.store.delete(name);
    input.deps.logger.info("secrets.api.deleted", { name, deleted });
    if (!deleted) {
      return json(404, { error: "not_found", code: "not_found", message: `Secret « ${name} » inconnu.` });
    }
    return json(200, { deleted: true, name });
  } catch (error) {
    return vaultErrorResponse(error) ?? json(500, { error: "internal_error" });
  }
}

/** Traite une requête de l'API des secrets. Ne lève jamais. */
export function handleSecretsRequest(input: SecretsRequestInput): SecretsHttpResponse {
  const { method, path } = input;
  if (path === SECRETS_PATH) {
    if (method === "GET" || method === "HEAD") return handleGet(input.deps);
    if (method === "POST") return handlePost(input);
    if (method === "PUT") return handlePost(input);
    return json(405, { error: "method_not_allowed", method });
  }
  // Route de suppression : `/api/secrets/<nom>`.
  if (method === "DELETE") return handleDelete(input);
  return json(405, { error: "method_not_allowed", method });
}
