/**
 * API des agents d'exécution (Lot 4, B3/B4) — routes HUMAINES servies par le
 * gateway (derrière Caddy + authentik, D113), séparées du port « machines ».
 *
 * Routes :
 *   GET    /api/agents                       → liste des agents (+ état en ligne)
 *   GET    /api/agents/<id>                  → fiche d'un agent + historique
 *   POST   /api/agents/pair                  → soumission du code d'appairage (D119)
 *   PATCH  /api/agents/<id>                  → niveau (D118) + privilège (D120)
 *   POST   /api/agents/<id>/revoke           → dé-appairage (révocation, D118)
 *   POST   /api/agents/<id>/restore          → annulation d'une révocation
 *   POST   /api/agents/<id>/remove           → SUPPRESSION DÉFINITIVE de la fiche
 *   POST   /api/agents/<id>/unlock           → DÉVERROUILLAGE (mot de passe d'instance)
 *   POST   /api/agents/<id>/lock             → reverrouillage immédiat (agent sensible)
 *   DELETE /api/agents/<id>                  → révocation (alias REST de `revoke`)
 *   GET    /api/agents/approvals             → validations en attente (niveaux 2/3)
 *   POST   /api/agents/approvals/<id>/approve|deny → décision humaine
 *
 * Précautions minimales : en-tête `X-Yuki-Agents: 1` + contrôle `Origin`/`Host`
 * sur les écritures (même logique que `routes/config.ts`). Le code d'appairage
 * n'est JAMAIS journalisé ; l'historique ne contient JAMAIS la sortie (D127).
 */

import type { IncomingHttpHeaders } from "node:http";

import type { ApprovalRegistry } from "../../agents/approvals.js";
import type { AuditLog } from "../../agents/audit.js";
import type { AgentHub } from "../../agents/connection.js";
import { AgentError } from "../../agents/errors.js";
import type { AgentLockService } from "../../agents/lock.js";
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
  /** Registre des canaux (B6) : état de connexion par agent. */
  hub?: AgentHub;
  /** Journal d'audit (B6) : historique des commandes (jamais la sortie). */
  audit?: AuditLog;
  /** Validations humaines en attente (B6bis). */
  approvals?: ApprovalRegistry;
  /**
   * Verrou « matériel sensible » (état EN MÉMOIRE). Absent ⇒ aucun agent n'est
   * jamais verrouillé et les actions de déverrouillage répondent `unavailable`.
   */
  lock?: AgentLockService;
  /**
   * Notification d'un mot de passe REÇU (jamais journalisé) : sert à l'ajouter
   * à la liste des valeurs à masquer, pour qu'une fuite accidentelle ultérieure
   * (log/audit) soit masquée elle aussi.
   */
  onSecretSeen?: (value: string) => void;
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

function serialize(
  record: ReturnType<AgentStore["list"]>[number],
  deps: AgentsApiDeps,
): Record<string, unknown> {
  // ⚠️ État SÉPARÉ du niveau : `sensitive` est le RÉGLAGE (persisté) et `locked`
  // l'état éphémère (en mémoire). `level` n'est JAMAIS modifié par un
  // reverrouillage. Aucune valeur secrète ici (jamais de mot de passe).
  const lockStatus = deps.lock?.status(record.agentId);
  return {
    agentId: record.agentId,
    name: record.name,
    level: record.level,
    privilege: record.privilege,
    lastSeen: record.lastSeen,
    revoked: record.revoked,
    online: deps.hub?.isOnline(record.agentId) ?? false,
    sensitive: record.sensitive === true,
    locked: lockStatus ? lockStatus.locked : false,
    ...(lockStatus?.remainingMs !== undefined
      ? { unlockRemainingMs: lockStatus.remainingMs }
      : {}),
  };
}

function handleList(deps: AgentsApiDeps): AgentsHttpResponse {
  const agents = deps.store.list().map((record) => serialize(record, deps));
  return json(200, {
    agents,
    count: agents.length,
    pendingCodes: deps.pairing.activeSessionCount(),
  });
}

/** Historique récent d'un agent : commande + horodatage + code de sortie. */
function historyOf(deps: AgentsApiDeps, agentId: string, limit = 20): Record<string, unknown>[] {
  return (deps.audit?.recent({ agentId, event: "command", limit }) ?? []).map((entry) => ({
    ts: entry["ts"] ?? null,
    command: entry["command"] ?? null,
    exitCode: entry["exit_code"] ?? null,
    status: (entry["meta"] as Record<string, unknown> | undefined)?.["status"] ?? null,
  }));
}

function handleGet(deps: AgentsApiDeps, agentId: string): AgentsHttpResponse {
  const record = deps.store.get(agentId);
  if (!record) {
    return json(404, {
      error: "agent_not_found",
      code: "agent_not_found",
      message: `Agent inconnu : ${agentId}.`,
    });
  }
  return json(200, { agent: serialize(record, deps), history: historyOf(deps, agentId) });
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
    // `matched` : une trame d'agent EN ATTENTE a-t-elle été appariée à ce code ?
    // L'interface s'en sert pour dire la vérité (« aucun agent en attente »
    // plutôt qu'un succès trompeur).
    return json(200, {
      ok: true,
      code: result.code,
      expiresAt: result.expiresAt,
      matched: result.matched,
    });
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
    // Révocation = le canal vivant est coupé (le certificat sera refusé à la
    // reconnexion par `authorizedAgent`).
    input.deps.hub?.disconnect(agentId);
    input.deps.logger.info("agents.revoked", { agent_id: agentId });
    return json(200, { ok: true, agent: serialize(record, input.deps) });
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
    return json(200, { ok: true, agent: serialize(record, input.deps) });
  } catch (error) {
    if (error instanceof AgentError) {
      return json(404, { error: error.code, code: error.code, message: error.message });
    }
    throw error;
  }
}

/**
 * Suppression DÉFINITIVE de la fiche d'un agent.
 *
 * Retire l'enregistrement de la projection : `authorizedAgent` (`server.ts`)
 * exige `store.has(agentId)`, donc l'agent ne peut PLUS se reconnecter — même
 * avec un certificat signé par le CA interne (il n'y a PAS de liste de
 * révocation : l'absence de fiche EST le refus). Le journal d'audit N'EST PAS
 * touché (trace immuable) ; l'agent supprimé devra être RÉ-APPARIÉ pour revenir.
 */
function handleRemove(input: AgentsRequestInput, agentId: string): AgentsHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  if (!input.deps.store.has(agentId)) {
    return json(404, {
      error: "agent_not_found",
      code: "agent_not_found",
      message: `Agent inconnu : ${agentId}.`,
    });
  }
  input.deps.store.remove(agentId);
  // Coupe le canal vivant s'il existait (comme la révocation).
  input.deps.hub?.disconnect(agentId);
  input.deps.logger.info("agents.removed", { agent_id: agentId });
  return json(200, { ok: true, removed: true, agentId });
}

function handlePatch(input: AgentsRequestInput, agentId: string): AgentsHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  const body = parseJsonBody(input.body);
  if ("status" in body) return body;
  const patch: {
    level?: AgentLevel;
    privilege?: AgentPrivilege;
    name?: string;
    sensitive?: boolean;
  } = {};
  const level = body.value["level"];
  const privilege = body.value["privilege"];
  const name = body.value["name"];
  const sensitive = body.value["sensitive"];
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
  if (name !== undefined) {
    if (typeof name !== "string") {
      return json(400, {
        error: "invalid_name",
        code: "invalid_name",
        message: "Nom d'agent : texte attendu.",
      });
    }
    // La normalisation (espaces) et l'unicité sont imposées par le store, qui
    // lève `INVALID_AGENT_NAME` ou `AGENT_NAME_TAKEN` (message honnête).
    patch.name = name;
  }
  if (sensitive !== undefined) {
    if (typeof sensitive !== "boolean") {
      return json(400, {
        error: "invalid_sensitive",
        code: "invalid_sensitive",
        message: "Indicateur « matériel sensible » : booléen attendu.",
      });
    }
    patch.sensitive = sensitive;
  }
  try {
    const record = input.deps.store.configure(agentId, patch);
    input.deps.logger.info("agents.configured", {
      agent_id: agentId,
      name: record.name,
      level: record.level,
      privilege: record.privilege,
      sensitive: record.sensitive,
    });
    // ⚠️ Décocher « matériel sensible » ne doit pas laisser un déverrouillage
    // fantôme en mémoire pour un agent redevenu ordinaire.
    if (patch.sensitive === false) input.deps.lock?.lock(agentId, "sensitive_removed");
    return json(200, { ok: true, agent: serialize(record, input.deps) });
  } catch (error) {
    if (error instanceof AgentError) {
      if (error.code === "AGENT_NAME_TAKEN") {
        return json(409, { error: error.code, code: error.code, message: error.message });
      }
      if (error.code === "INVALID_AGENT_NAME" || error.code === "INVALID_SENSITIVE") {
        return json(400, { error: error.code, code: error.code, message: error.message });
      }
      // ⚠️ Coche « matériel sensible » sans mot de passe d'instance : CONFLIT
      // explicite (409) avec le message qui dit quoi faire — jamais un refus muet.
      if (error.code === "SENSITIVE_REQUIRES_PASSWORD") {
        return json(409, { error: error.code, code: error.code, message: error.message });
      }
      return json(404, { error: error.code, code: error.code, message: error.message });
    }
    throw error;
  }
}

/**
 * `POST /api/agents/<id>/unlock` — DÉVERROUILLAGE d'un agent sensible.
 *
 * ⚠️ Le mot de passe vient du NAVIGATEUR (saisie de l'utilisateur) et ne quitte
 * jamais ce couple requête/réponse : il n'est ni journalisé, ni audité, ni
 * transmis au modèle. La réponse ne dit que « déverrouillé » + le temps restant.
 */
function handleUnlock(input: AgentsRequestInput, agentId: string): AgentsHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  const lock = input.deps.lock;
  if (!lock) {
    return json(503, {
      error: "lock_unavailable",
      code: "lock_unavailable",
      message: "Verrouillage des agents indisponible sur cette instance.",
    });
  }
  const body = parseJsonBody(input.body);
  if ("status" in body) return body;
  const password = body.value["password"];
  if (typeof password !== "string" || password.length === 0) {
    return json(400, {
      error: "password_missing",
      code: "password_missing",
      message: "Mot de passe d'instance requis.",
    });
  }
  // Défensif : la valeur reçue rejoint la liste des valeurs à MASQUER (logs +
  // audit). On ne l'écrit nulle part.
  input.deps.onSecretSeen?.(password);
  const outcome = lock.unlock(agentId, password);
  if (!outcome.ok) {
    const status = outcome.code === "agent_not_found" ? 404 : outcome.code === "invalid_password" ? 403 : 400;
    return json(status, { error: outcome.code, code: outcome.code, message: outcome.message });
  }
  input.deps.logger.info("agents.unlocked", { agent_id: agentId });
  const record = input.deps.store.get(agentId);
  return json(200, {
    ok: true,
    agent: record ? serialize(record, input.deps) : { agentId },
    remainingMs: outcome.remainingMs,
  });
}

/** `POST /api/agents/<id>/lock` — reverrouillage IMMÉDIAT (action explicite). */
function handleLock(input: AgentsRequestInput, agentId: string): AgentsHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  const lock = input.deps.lock;
  if (!lock) {
    return json(503, {
      error: "lock_unavailable",
      code: "lock_unavailable",
      message: "Verrouillage des agents indisponible sur cette instance.",
    });
  }
  if (!input.deps.store.has(agentId)) {
    return json(404, {
      error: "agent_not_found",
      code: "agent_not_found",
      message: `Agent inconnu : ${agentId}.`,
    });
  }
  lock.lock(agentId, "manual");
  input.deps.logger.info("agents.locked", { agent_id: agentId });
  const record = input.deps.store.get(agentId);
  return json(200, { ok: true, agent: record ? serialize(record, input.deps) : { agentId } });
}

function handleApprovalList(deps: AgentsApiDeps): AgentsHttpResponse {
  if (!deps.approvals) return json(200, { approvals: [], count: 0 });
  const approvals = deps.approvals.list().map((entry) => ({
    id: entry.id,
    agentId: entry.agentId,
    command: entry.command,
    destructive: entry.destructive,
    status: entry.status,
    createdAt: entry.createdAt,
    expiresAt: entry.expiresAt,
  }));
  return json(200, { approvals, count: approvals.length });
}

function handleApprovalDecision(
  input: AgentsRequestInput,
  id: string,
  decision: "approve" | "deny",
): AgentsHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  if (!input.deps.approvals) {
    return json(404, { error: "not_found", code: "not_found", message: "Aucune validation." });
  }
  try {
    const entry =
      decision === "approve"
        ? input.deps.approvals.approve(id)
        : input.deps.approvals.deny(id);
    input.deps.logger.info("agents.approval.decided", {
      approval_id: entry.id,
      agent_id: entry.agentId,
      decision,
    });
    return json(200, {
      ok: true,
      approval: { id: entry.id, status: entry.status, agentId: entry.agentId },
    });
  } catch (error) {
    return json(404, {
      error: "approval_not_found",
      code: "approval_not_found",
      message: error instanceof Error ? error.message : "Validation inconnue.",
    });
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
  if (path === "/api/agents/approvals") {
    if (method === "GET" || method === "HEAD") return handleApprovalList(input.deps);
    return json(405, { error: "method_not_allowed", method });
  }
  const approval = /^\/api\/agents\/approvals\/([^/]+)\/(approve|deny)$/.exec(path);
  if (approval) {
    if (method !== "POST") return json(405, { error: "method_not_allowed", method });
    const id = decodeURIComponent(approval[1] as string);
    return handleApprovalDecision(input, id, approval[2] as "approve" | "deny");
  }

  const match = /^\/api\/agents\/([^/]+)$/.exec(path);
  if (match) {
    const agentId = decodeURIComponent(match[1] as string);
    if (method === "GET" || method === "HEAD") return handleGet(input.deps, agentId);
    if (method === "PATCH") return handlePatch(input, agentId);
    if (method === "DELETE") return handleRevoke(input, agentId);
    return json(405, { error: "method_not_allowed", method });
  }
  const action = /^\/api\/agents\/([^/]+)\/(revoke|restore|remove|unlock|lock)$/.exec(path);
  if (action) {
    const agentId = decodeURIComponent(action[1] as string);
    if (method !== "POST") return json(405, { error: "method_not_allowed", method });
    if (action[2] === "revoke") return handleRevoke(input, agentId);
    if (action[2] === "restore") return handleRestore(input, agentId);
    if (action[2] === "unlock") return handleUnlock(input, agentId);
    if (action[2] === "lock") return handleLock(input, agentId);
    return handleRemove(input, agentId);
  }
  return json(404, { error: "not_found", path });
}
