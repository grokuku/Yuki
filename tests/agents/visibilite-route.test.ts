/**
 * API des agents — VISIBILITÉ PAR BOT (lot 35g), côté route HUMAINE.
 *
 * Ce que ce fichier VERROUILLE :
 *  - `GET /api/agents` rend la liste `bots` de chaque agent (`[]` = neutralisé)
 *    et rend `["yuki"]` pour un journal antérieur au champ (jamais `[]`) ;
 *  - `PATCH /api/agents/<id>` écrit la liste (avec la borne `MAX_BOTS`, 400) ;
 *  - l'ADMINISTRATION voit TOUS les agents, y compris neutralisés : /config doit
 *    pouvoir les réactiver (la visibilité ne filtre que le côté MODEL/bot).
 */

import { mkdtempSync, rmSync } from "node:fs";
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
import {
  AGENTS_HEADER_VALUE,
  AGENTS_WRITE_HEADER,
  handleAgentsRequest,
  type AgentsApiDeps,
} from "../../src/gateway/routes/agents.js";
import { createLogger } from "../../src/observability/logger.js";
import { MAX_BOTS } from "../../src/bots/registry.js";

/** Bot EXPLICITE des constructions de store (aucun défaut implicite). */
const BOT_TEST = "yuki";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const HEADERS = {
  host: "yuki.local",
  "content-type": "application/json",
  [AGENTS_WRITE_HEADER]: AGENTS_HEADER_VALUE,
};

interface Fixture {
  deps: AgentsApiDeps;
  store: AgentStore;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "yuki-agents-visibilite-route-"));
  dirs.push(dir);
  const store = AgentStore.open({
    path: join(dir, "agents.jsonl"),
    botCourant: () => BOT_TEST,
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
  return { deps: { pairing, store, logger }, store };
}

function patchAgent(f: Fixture, agentId: string, body: unknown) {
  return handleAgentsRequest({
    method: "PATCH",
    path: `/api/agents/${agentId}`,
    headers: HEADERS,
    body: JSON.stringify(body),
    ip: "1.1.1.1",
    deps: f.deps,
  });
}

describe("API des agents — visibilité (lot 35g)", () => {
  it("rend la liste `bots` dans la liste ET la fiche d'un agent", () => {
    const f = fixture();
    f.store.markSeen("a1");
    f.store.setBots("a1", ["yuki", "kohai"]);

    const liste = handleAgentsRequest({
      method: "GET",
      path: "/api/agents",
      headers: HEADERS,
      body: "",
      ip: "1.1.1.1",
      deps: f.deps,
    });
    expect(liste.status).toBe(200);
    const agents = (liste.body as { agents: Array<Record<string, unknown>> }).agents;
    expect(agents[0]?.["bots"]).toEqual(["yuki", "kohai"]);

    const fiche = handleAgentsRequest({
      method: "GET",
      path: "/api/agents/a1",
      headers: HEADERS,
      body: "",
      ip: "1.1.1.1",
      deps: f.deps,
    });
    expect(fiche.status).toBe(200);
    expect((fiche.body as { agent: Record<string, unknown> }).agent["bots"]).toEqual([
      "yuki",
      "kohai",
    ]);
  });

  it("ADMINISTRATION : un agent neutralisé reste LISTÉ (on garde sa trace)", () => {
    const f = fixture();
    f.store.markSeen("a1");
    f.store.setBots("a1", []);
    const liste = handleAgentsRequest({
      method: "GET",
      path: "/api/agents",
      headers: HEADERS,
      body: "",
      ip: "1.1.1.1",
      deps: f.deps,
    });
    const agents = (liste.body as { agents: Array<Record<string, unknown>> }).agents;
    expect(agents).toHaveLength(1);
    expect(agents[0]?.["bots"]).toEqual([]);
  });

  it("écrit la liste avec PATCH (et la relit)", () => {
    const f = fixture();
    f.store.markSeen("a1");
    const res = patchAgent(f, "a1", { bots: ["kohai"] });
    expect(res.status).toBe(200);
    expect((res.body as { agent: Record<string, unknown> }).agent["bots"]).toEqual(["kohai"]);
    expect(f.store.get("a1")?.bots).toEqual(["kohai"]);
  });

  it("accepte `[]` (neutralisation explicite)", () => {
    const f = fixture();
    f.store.markSeen("a1");
    const res = patchAgent(f, "a1", { bots: [] });
    expect(res.status).toBe(200);
    expect(f.store.get("a1")?.bots).toEqual([]);
  });

  it(`refuse plus de ${MAX_BOTS} bots (400, message qui nomme la borne)`, () => {
    const f = fixture();
    f.store.markSeen("a1");
    const trop = Array.from({ length: MAX_BOTS + 1 }, (_, index) => `bot${index}`);
    const res = patchAgent(f, "a1", { bots: trop });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("INVALID_BOTS");
    expect((res.body as { message: string }).message).toContain(String(MAX_BOTS));
  });

  it("refuse un identifiant de bot invalide et un type non-tableau", () => {
    const f = fixture();
    f.store.markSeen("a1");
    expect(patchAgent(f, "a1", { bots: "../evasion" }).status).toBe(400);
    const invalide = patchAgent(f, "a1", { bots: ["../evasion"] });
    expect(invalide.status).toBe(400);
    expect((invalide.body as { code: string }).code).toBe("INVALID_BOTS");
  });
});
