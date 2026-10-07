/**
 * API HUMAINE des agents (Lot 4, B3) — route de soumission du code (derrière les
 * garde-fous du gateway), liste et dé-appairage/révocation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentStore,
  AuditLog,
  caDirectoryIn,
  CertificateAuthority,
  maxSizeBytesFromMb,
  PairingManager,
} from "../../src/agents/index.js";
import type { Env } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import {
  AGENTS_HEADER_VALUE,
  AGENTS_WRITE_HEADER,
  handleAgentsRequest,
  isAgentsPath,
  type AgentsApiDeps,
} from "../../src/gateway/routes/agents.js";
import { createLogger } from "../../src/observability/logger.js";
import type { GpuReport } from "../../src/types/gpu.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const dirs: string[] = [];
const servers: Array<ReturnType<typeof createHttpServer>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  deps: AgentsApiDeps;
  store: AgentStore;
  pairing: PairingManager;
  cleanup(): void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "yuki-agents-route-"));
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
  return { deps: { pairing, store, logger }, store, pairing, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const HEADERS = { host: "yuki.local", "content-type": "application/json" };

describe("API des agents — reconnaissance de chemin", () => {
  it("reconnaît /api/agents et ses sous-chemins uniquement", () => {
    expect(isAgentsPath("/api/agents")).toBe(true);
    expect(isAgentsPath("/api/agents/pair")).toBe(true);
    expect(isAgentsPath("/api/agents/x/revoke")).toBe(true);
    expect(isAgentsPath("/api/agentsx")).toBe(false);
    expect(isAgentsPath("/api/config")).toBe(false);
  });
});

describe("API des agents — liste (lecture)", () => {
  it("renvoie une liste vide au départ", () => {
    const f = fixture();
    const res = handleAgentsRequest({ method: "GET", path: "/api/agents", headers: HEADERS, body: "", ip: "1.1.1.1", deps: f.deps });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ count: 0, agents: [] });
  });

  it("liste les agents enregistrés", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    const res = handleAgentsRequest({ method: "GET", path: "/api/agents", headers: HEADERS, body: "", ip: "1.1.1.1", deps: f.deps });
    expect(res.status).toBe(200);
    expect((res.body as { agents: unknown[] }).agents).toHaveLength(1);
  });
});

describe("API des agents — garde-fous d'écriture", () => {
  it("refuse la soumission sans en-tête dédié", () => {
    const f = fixture();
    const res = handleAgentsRequest({ method: "POST", path: "/api/agents/pair", headers: HEADERS, body: '{"code":"ABCD-2345-6789"}', ip: "1.1.1.1", deps: f.deps });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe("missing_agents_header");
  });

  it("refuse une origine étrangère", () => {
    const f = fixture();
    const res = handleAgentsRequest({
      method: "POST",
      path: "/api/agents/pair",
      headers: { ...HEADERS, [AGENTS_WRITE_HEADER]: AGENTS_HEADER_VALUE, origin: "https://evil.example" },
      body: '{"code":"ABCD-2345-6789"}',
      ip: "1.1.1.1",
      deps: f.deps,
    });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe("bad_origin");
  });
});

describe("API des agents — appairage", () => {
  const writeHeaders = { ...HEADERS, [AGENTS_WRITE_HEADER]: AGENTS_HEADER_VALUE };

  it("accepte un code valide", () => {
    const f = fixture();
    const res = handleAgentsRequest({ method: "POST", path: "/api/agents/pair", headers: writeHeaders, body: '{"code":"abcd 2345 6789"}', ip: "1.1.1.1", deps: f.deps });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, code: "ABCD-2345-6789" });
    expect(f.pairing.activeSessionCount()).toBe(1);
  });

  it("refuse un code invalide avec pair_code_invalid", () => {
    const f = fixture();
    const res = handleAgentsRequest({ method: "POST", path: "/api/agents/pair", headers: writeHeaders, body: '{"code":"nope"}', ip: "1.1.1.1", deps: f.deps });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("pair_code_invalid");
  });
});

describe("API des agents — révocation & configuration", () => {
  const writeHeaders = { ...HEADERS, [AGENTS_WRITE_HEADER]: AGENTS_HEADER_VALUE };

  it("révoque puis restaure un agent", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    const revoked = handleAgentsRequest({ method: "POST", path: "/api/agents/agent-1/revoke", headers: writeHeaders, body: "", ip: "1.1.1.1", deps: f.deps });
    expect(revoked.status).toBe(200);
    expect(f.store.isRevoked("agent-1")).toBe(true);
    const restored = handleAgentsRequest({ method: "POST", path: "/api/agents/agent-1/restore", headers: writeHeaders, body: "", ip: "1.1.1.1", deps: f.deps });
    expect(restored.status).toBe(200);
    expect(f.store.isRevoked("agent-1")).toBe(false);
  });

  it("révocation d'un agent inconnu ⇒ 404", () => {
    const f = fixture();
    const res = handleAgentsRequest({ method: "POST", path: "/api/agents/inconnu/revoke", headers: writeHeaders, body: "", ip: "1.1.1.1", deps: f.deps });
    expect(res.status).toBe(404);
  });

  it("change le niveau et le privilège (D118/D120)", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    const res = handleAgentsRequest({ method: "PATCH", path: "/api/agents/agent-1", headers: writeHeaders, body: '{"level":"never","privilege":"root"}', ip: "1.1.1.1", deps: f.deps });
    expect(res.status).toBe(200);
    expect(f.store.get("agent-1")).toMatchObject({ level: "never", privilege: "root" });
  });

  it("refuse un niveau invalide", () => {
    const f = fixture();
    f.store.markSeen("agent-1");
    const res = handleAgentsRequest({ method: "PATCH", path: "/api/agents/agent-1", headers: writeHeaders, body: '{"level":"yes"}', ip: "1.1.1.1", deps: f.deps });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("invalid_level");
  });
});

describe("gateway humain — /api/agents (bout en bout, gateway non cassé)", () => {
  it("expose la liste (lecture) et accepte la soumission du code", async () => {
    const f = fixture();
    const context: AppContext = {
      env: { version: "test" } as unknown as Env,
      report: {} as unknown as GpuReport,
      gatePassed: true,
      startedAt: Date.now(),
      volumes: [],
      publicDir: "public/ui",
      agents: f.deps,
    };
    const server = createHttpServer(createApp(context));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;

    const list = await fetch(`http://127.0.0.1:${port}/api/agents`);
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ count: 0 });

    const pair = await fetch(`http://127.0.0.1:${port}/api/agents/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", [AGENTS_WRITE_HEADER]: AGENTS_HEADER_VALUE },
      body: JSON.stringify({ code: "abcd 2345 6789" }),
    });
    expect(pair.status).toBe(200);
    expect(await pair.json()).toMatchObject({ ok: true, code: "ABCD-2345-6789" });

    // Le reste du gateway reste servi (404 pour un chemin inconnu, pas de fuite).
    const unknown = await fetch(`http://127.0.0.1:${port}/api/agentsx`);
    expect(unknown.status).toBe(404);
  });
});
