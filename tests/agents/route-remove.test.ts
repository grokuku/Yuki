/**
 * Suppression DÉFINITIVE d'un agent (POST /api/agents/<id>/remove).
 *
 * Vérifie : garde d'écriture, 404 inconnu, retrait de la fiche (donc l'agent ne
 * peut plus se connecter), coupure du canal vivant, et surtout IMMUTABILITÉ du
 * journal d'audit (la trace de l'agent reste).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentHub,
  AgentStore,
  AuditLog,
  caDirectoryIn,
  CertificateAuthority,
  maxSizeBytesFromMb,
  PairingManager,
} from "../../src/agents/index.js";
import {
  AGENTS_HEADER_VALUE,
  AGENTS_WRITE_HEADER,
  handleAgentsRequest,
  type AgentsApiDeps,
} from "../../src/gateway/routes/agents.js";
import { createLogger } from "../../src/observability/logger.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  deps: AgentsApiDeps;
  store: AgentStore;
  audit: AuditLog;
  hub: AgentHub;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "yuki-agents-remove-"));
  dirs.push(dir);
  const store = AgentStore.open({
    path: join(dir, "agents.jsonl"),
    defaults: { level: "destructive", privilege: "normal" },
    logger,
  });
  const audit = AuditLog.open({
    path: join(dir, "audit.jsonl"),
    maxSizeBytes: maxSizeBytesFromMb(1),
    retentionDays: 30,
    logger,
  });
  const ca = CertificateAuthority.open({ dir: caDirectoryIn(dir), logger });
  const pairing = new PairingManager({ ca, store, audit, logger });
  const hub = new AgentHub({ logger });
  return { deps: { pairing, store, logger, hub, audit }, store, audit, hub };
}

const HEADERS = { host: "yuki.local", "content-type": "application/json" };
const WRITE = { ...HEADERS, [AGENTS_WRITE_HEADER]: AGENTS_HEADER_VALUE };

function request(method: string, path: string, deps: AgentsApiDeps, body = "", headers = HEADERS) {
  return handleAgentsRequest({ method, path, headers, body, ip: "1.1.1.1", deps });
}

describe("Suppression définitive d'un agent", () => {
  it("POST /remove retire la fiche du store (donc l'agent ne peut plus se connecter)", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    expect(f.store.has("agent-1")).toBe(true);

    const res = request("POST", "/api/agents/agent-1/remove", f.deps, "", WRITE);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, removed: true, agentId: "agent-1" });
    // `authorizedAgent` (server.ts) exige `store.has(agentId)` : la fiche absente
    // EST le refus — il n'y a pas de liste de révocation séparée.
    expect(f.store.has("agent-1")).toBe(false);
    expect(f.store.get("agent-1")).toBeUndefined();
    // La fiche a disparu de la liste.
    const list = request("GET", "/api/agents", f.deps);
    expect((list.body as { agents: unknown[] }).agents).toHaveLength(0);
  });

  it("coupe le canal vivant (disconnect)", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    const spy = vi.spyOn(f.hub, "disconnect");
    request("POST", "/api/agents/agent-1/remove", f.deps, "", WRITE);
    expect(spy).toHaveBeenCalledWith("agent-1");
  });

  it("exige l'en-tête d'écriture ⇒ 403", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    expect(request("POST", "/api/agents/agent-1/remove", f.deps).status).toBe(403);
    expect(f.store.has("agent-1")).toBe(true);
  });

  it("agent inconnu ⇒ 404", () => {
    const f = fixture();
    expect(request("POST", "/api/agents/inconnu/remove", f.deps, "", WRITE).status).toBe(404);
  });

  it("la suppression ne touche PAS le journal d'audit (trace immuable)", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    f.audit.append({
      event: "command",
      agentId: "agent-1",
      command: "uname -a",
      exitCode: 0,
      meta: { status: "completed" },
    });
    request("POST", "/api/agents/agent-1/remove", f.deps, "", WRITE);
    // La fiche a disparu…
    expect(f.store.has("agent-1")).toBe(false);
    // …mais l'historique d'audit de cet agent est TOUJOURS là.
    const history = f.audit.recent({ agentId: "agent-1", event: "command", limit: 20 });
    expect(history).toHaveLength(1);
    expect(history[0]?.["command"]).toBe("uname -a");
  });

  it("DELETE /api/agents/<id> reste la RÉVOCATION (alias, pas une suppression)", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    request("DELETE", "/api/agents/agent-1", f.deps, "", WRITE);
    expect(f.store.has("agent-1")).toBe(true);
    expect(f.store.isRevoked("agent-1")).toBe(true);
  });
});
