/**
 * API des agents d'exécution (Lot 4, B3) — routes HUMAINES servies par le
 * gateway (derrière Caddy + authentik, D113), séparées du port « machines ».
 *
 * Routes :
 *   GET  /api/agents                 → liste des agents appairés (jamais de secret)
 *   POST /api/agents/pair            → soumission du code d'appairage (D119)
 *   POST /api/agents/<id>/revoke     → dé-appairage (révocation, D118)
 *   POST /api/agents/<id>/restore    → annulation d'une révocation
 *   PATCH /api/agents/<id>           → niveau (D118) + privilège (D120)
 *
 * Précautions minimales : en-tête `X-Yuki-Agents: 1` + contrôle `Origin`/`Host`
 * sur les écritures (même logique que `routes/config.ts`). Le code d'appairage
 * n'est JAMAIS journalisé.
 */

import type { IncomingHttpHeaders } from "node:http";

import { AgentError } from "../../agents/errors.js";
import type { PairingManager } from "../../agents/pairing.js";
import type { AgentStore } from "../../agents/store.js";
import { isAgentLevel, isAgentPrivilege, type AgentLevel, type AgentPrivilege } from "../../agents/types.js";
import type { Logger } from "../../observability/logger.js";

export const AGENTS_WRITE_HEADER = "x-yuki-agents";
export const AGENTS_HEADER_VALUE = "1";

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export interface AgentsApiDeps {
  pairing: PairingManager;
  store: AgentStore;
  logger: Logger;
  now?: () => number;
}

export interface AgentsHttpResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface AgentsRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
  ip: string;
  deps: AgentsApiDeps;
}

function json(status: number, body: unknown): AgentsHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

function headerString(headers: IncomingHttpHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) return raw[0];
  }
  return undefined;
}

function normalizeHost(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `http://${value}`);
    const host = url.hostname.toLowerCase();
    return url.port === "" ? host : `${host}:${url.port}`;
  } catch {
    return null;
  }
}

function sameOrigin(headers: IncomingHttpHeaders): boolean {
  const origin = headerString(headers, "origin");
  if (origin === undefined) return true;
  const host = headerString(headers, "host");
  if (host === undefined) return false;
  const originHost = normalizeHost(origin);
  const requestHost = normalizeHost(host);
  return originHost !== null && requestHost !== null && originHost === requestHost;
}

/** `true` si le chemin relève de l'API des agents. */
export function isAgentsPath(path: string): boolean {
  return path === "/api/agents" || path.startsWith("/api/agents/");
}

function requireWriteGuards(headers: IncomingHttpHeaders): AgentsHttpResponse | null {
  if (headerString(headers, AGENTS_WRITE_HEADER) !== AGENTS_HEADER_VALUE) {
    return json(403, {
      error: "forbidden",
      code: "missing_agents_header",
      message: `En-tête ${AGENTS_WRITE_HEADER}: ${AGENTS_HEADER_VALUE} requis.`,
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

function serialize(record: ReturnType<AgentStore["list"]>[number]): Record<string, unknown> {
  return {
    agentId: record.agentId,
    level: record.level,
    privilege: record.privilege,
    lastSeen: record.lastSeen,
    revoked: record.revoked,
  };
}

function handleList(deps: AgentsApiDeps): AgentsHttpResponse {
  const agents = deps.store.list().map(serialize);
  return json(200, {
    agents,
    count: agents.length,
    pendingCodes: deps.pairing.activeSessionCount(),
  });
}

function parseJsonBody(body: string): { ok: true; value: Record<string, unknown> } | AgentsHttpResponse {
  if (body.trim() === "") return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json(400, { error: "invalid_json", code: "invalid_json", message: "Corps JSON invalide." });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json(400, { error: "invalid_body", code: "invalid_body", message: "Objet JSON attendu." });
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

function handlePair(input: AgentsRequestInput): AgentsHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  const body = parseJsonBody(input.body);
  if ("status" in body) return body;
  const code = body.value["code"];
  if (typeof code !== "string") {
    return json(400, {
      error: "invalid_body",
      code: "invalid_body",
      message: "Champ `code` (texte) requis.",
    });
  }
  try {
    const result = input.deps.pairing.submitCode(code, { ip: input.ip });
    return json(200, { ok: true, code: result.code, expiresAt: result.expiresAt });
  } catch (error) {
    if (error instanceof AgentError) {
      return json(400, { error: error.code, code: error.code, message: error.message });
    }
    const code2 =
      error && typeof error === "object" && "code" in error
        ? String((error as { code: unknown }).code)
        : "internal_error";
    const message = error instanceof Error ? error.message : "Appairage impossible.";
    const status = code2 === "pair_rate_limited" ? 429 : code2 === "internal_error" ? 500 : 400;
    return json(status, { error: code2, code: code2, message });
  }
}

function handleRevoke(input: AgentsRequestInput, agentId: string): AgentsHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  try {
    const record = input.deps.store.revoke(agentId);
    input.deps.logger.info("agents.revoked", { agent_id: agentId });
    return json(200, { ok: true, agent: serialize(record) });
  } catch (error) {
    if (error instanceof AgentError) {
      return json(404, { error: error.code, code: error.code, message: error.message });
    }
    throw error;
  }
}

function handleRestore(input: AgentsRequestInput, agentId: string): AgentsHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  try {
    const record = input.deps.store.restore(agentId);
    input.deps.logger.info("agents.restored", { agent_id: agentId });
    return json(200, { ok: true, agent: serialize(record) });
  } catch (error) {
    if (error instanceof AgentError) {
      return json(404, { error: error.code, code: error.code, message: error.message });
    }
    throw error;
  }
}

function handlePatch(input: AgentsRequestInput, agentId: string): AgentsHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  const body = parseJsonBody(input.body);
  if ("status" in body) return body;
  const patch: { level?: AgentLevel; privilege?: AgentPrivilege } = {};
  const level = body.value["level"];
  const privilege = body.value["privilege"];
  if (level !== undefined) {
    if (!isAgentLevel(level)) {
      return json(400, { error: "invalid_level", code: "invalid_level", message: "Niveau invalide." });
    }
    patch.level = level;
  }
  if (privilege !== undefined) {
    if (!isAgentPrivilege(privilege)) {
      return json(400, {
        error: "invalid_privilege",
        code: "invalid_privilege",
        message: "Privilège invalide.",
      });
    }
    patch.privilege = privilege;
  }
  try {
    const record = input.deps.store.configure(agentId, patch);
    input.deps.logger.info("agents.configured", {
      agent_id: agentId,
      level: record.level,
      privilege: record.privilege,
    });
    return json(200, { ok: true, agent: serialize(record) });
  } catch (error) {
    if (error instanceof AgentError) {
      return json(404, { error: error.code, code: error.code, message: error.message });
    }
    throw error;
  }
}

/** Traite une requête de l'API des agents. */
export function handleAgentsRequest(input: AgentsRequestInput): AgentsHttpResponse {
  const method = input.method.toUpperCase();
  const path = input.path;

  if (path === "/api/agents") {
    if (method === "GET" || method === "HEAD") return handleList(input.deps);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/agents/pair") {
    if (method !== "POST") return json(405, { error: "method_not_allowed", method });
    return handlePair(input);
  }

  const match = /^\/api\/agents\/([^/]+)$/.exec(path);
  if (match) {
    const agentId = decodeURIComponent(match[1] as string);
    if (method === "PATCH") return handlePatch(input, agentId);
    return json(405, { error: "method_not_allowed", method });
  }
  const action = /^\/api\/agents\/([^/]+)\/(revoke|restore)$/.exec(path);
  if (action) {
    const agentId = decodeURIComponent(action[1] as string);
    if (method !== "POST") return json(405, { error: "method_not_allowed", method });
    return action[2] === "revoke"
      ? handleRevoke(input, agentId)
      : handleRestore(input, agentId);
  }
  return json(404, { error: "not_found", path });
}
