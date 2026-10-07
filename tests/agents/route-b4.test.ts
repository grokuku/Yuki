/**
 * API HUMAINE des agents (Lot 4, B4) — fiche, historique, révocation REST,
 * validations en attente.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentHub,
  AgentStore,
  ApprovalRegistry,
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
  approvals: ApprovalRegistry;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "yuki-agents-b4-"));
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
  const approvals = new ApprovalRegistry({ logger });
  return {
    deps: { pairing, store, logger, hub, audit, approvals },
    store,
    audit,
    hub,
    approvals,
  };
}

const HEADERS = { host: "yuki.local", "content-type": "application/json" };
const WRITE = { ...HEADERS, [AGENTS_WRITE_HEADER]: AGENTS_HEADER_VALUE };

function request(method: string, path: string, deps: AgentsApiDeps, body = "", headers = HEADERS) {
  return handleAgentsRequest({ method, path, headers, body, ip: "1.1.1.1", deps });
}

describe("B4 — liste et fiche", () => {
  it("expose l'état en ligne (hors ligne par défaut)", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    const res = request("GET", "/api/agents", f.deps);
    expect(res.status).toBe(200);
    expect((res.body as { agents: Array<{ online: boolean }> }).agents[0]?.online).toBe(false);
  });

  it("GET /api/agents/<id> renvoie la fiche + l'historique sans la sortie", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    f.audit.append({
      event: "command",
      agentId: "agent-1",
      command: "ls /tmp",
      exitCode: 0,
      meta: { status: "completed", stdout: "NE-DOIT-PAS-APPARAITRE" },
    });
    const res = request("GET", "/api/agents/agent-1", f.deps);
    expect(res.status).toBe(200);
    const body = res.body as { agent: unknown; history: Array<Record<string, unknown>> };
    expect(body.history).toHaveLength(1);
    expect(body.history[0]?.["command"]).toBe("ls /tmp");
    expect(body.history[0]?.["exitCode"]).toBe(0);
    expect(JSON.stringify(body)).not.toContain("NE-DOIT-PAS-APPARAITRE");
  });

  it("GET /api/agents/<id> inconnu ⇒ 404", () => {
    const f = fixture();
    expect(request("GET", "/api/agents/inconnu", f.deps).status).toBe(404);
  });
});

describe("B4 — révocation REST (DELETE)", () => {
  it("DELETE /api/agents/<id> révoque (certificat refusé ensuite)", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    const res = request("DELETE", "/api/agents/agent-1", f.deps, "", WRITE);
    expect(res.status).toBe(200);
    expect(f.store.isRevoked("agent-1")).toBe(true);
    expect((res.body as { agent: { revoked: boolean } }).agent.revoked).toBe(true);
  });

  it("DELETE sans en-tête d'écriture ⇒ 403", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    expect(request("DELETE", "/api/agents/agent-1", f.deps).status).toBe(403);
  });
});

describe("B4 — validations en attente (niveaux 2/3)", () => {
  it("liste, approuve, refuse", () => {
    const f = fixture();
    const pending = f.approvals.request({
      agentId: "agent-1",
      command: "rm -rf /tmp/x",
      destructive: true,
    });
    const list = request("GET", "/api/agents/approvals", f.deps);
    expect(list.status).toBe(200);
    expect((list.body as { count: number }).count).toBe(1);

    const approved = request("POST", `/api/agents/approvals/${pending.id}/approve`, f.deps, "", WRITE);
    expect(approved.status).toBe(200);
    expect((approved.body as { approval: { status: string } }).approval.status).toBe("approved");

    const denied = request("POST", `/api/agents/approvals/${pending.id}/deny`, f.deps, "", WRITE);
    expect(denied.status).toBe(200);
    expect((denied.body as { approval: { status: string } }).approval.status).toBe("denied");
  });

  it("décision sans en-tête ⇒ 403", () => {
    const f = fixture();
    expect(request("POST", "/api/agents/approvals/x/approve", f.deps).status).toBe(403);
  });
});
