import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentError, AgentStore, type AgentEvent } from "../../src/agents/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-agents-"));
  tempDirs.push(dir);
  return join(dir, "agents.jsonl");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function open(path: string, overrides: Partial<Parameters<typeof AgentStore.open>[0]> = {}) {
  return AgentStore.open({
    path,
    defaults: { level: "destructive", privilege: "normal" },
    logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }),
    ...overrides,
  });
}

describe("AgentStore — CRUD & révocation", () => {
  it("markSeen crée l'agent avec les défauts et renseigne last_seen", () => {
    const path = tempStorePath();
    const store = open(path);
    const rec = store.markSeen("agent-1", { lastSeen: "2026-01-01T00:00:00.000Z" });
    expect(rec).toMatchObject({
      agentId: "agent-1",
      level: "destructive",
      privilege: "normal",
      lastSeen: "2026-01-01T00:00:00.000Z",
      revoked: false,
    });
    expect(rec.schemaVersion).toBe(1);
    expect(store.size).toBe(1);
    expect(store.has("agent-1")).toBe(true);
    expect(store.get("agent-1")?.lastSeen).toBe("2026-01-01T00:00:00.000Z");
  });

  it("markSeen ré-appelé n'écrase pas le niveau configuré", () => {
    const store = open(tempStorePath());
    store.markSeen("agent-1", { lastSeen: "2026-01-01T00:00:00.000Z" });
    store.setLevel("agent-1", "never");
    const rec = store.markSeen("agent-1", { lastSeen: "2026-01-02T00:00:00.000Z" });
    expect(rec.level).toBe("never");
    expect(rec.lastSeen).toBe("2026-01-02T00:00:00.000Z");
  });

  it("configure exige un agent existant", () => {
    const store = open(tempStorePath());
    expect(() => store.configure("inconnu", { level: "always" })).toThrowError(AgentError);
    store.markSeen("agent-1");
    expect(store.configure("agent-1", { level: "always", privilege: "root" })).toMatchObject({
      level: "always",
      privilege: "root",
    });
  });

  it("refuse un niveau ou un privilège invalide", () => {
    const store = open(tempStorePath());
    store.markSeen("agent-1");
    expect(() => store.setLevel("agent-1", "bogus" as never)).toThrowError(/Niveau/);
    expect(() => store.setPrivilege("agent-1", "sudo" as never)).toThrowError(/Privilège/);
  });

  it("révoque et restaure un agent", () => {
    const store = open(tempStorePath());
    store.markSeen("agent-1");
    expect(store.isRevoked("agent-1")).toBe(false);
    expect(store.revoke("agent-1").revoked).toBe(true);
    expect(store.isRevoked("agent-1")).toBe(true);
    expect(store.restore("agent-1").revoked).toBe(false);
    expect(() => store.revoke("inconnu")).toThrowError(AgentError);
  });

  it("supprime un agent de la projection", () => {
    const store = open(tempStorePath());
    store.markSeen("agent-1");
    store.remove("agent-1");
    expect(store.has("agent-1")).toBe(false);
    expect(store.size).toBe(0);
  });

  it("refuse un identifiant vide", () => {
    const store = open(tempStorePath());
    expect(() => store.markSeen("  ")).toThrowError(/vide/);
  });
});

describe("AgentStore — nom personnalisé (alias)", () => {
  it("rétrocompatibilité : un enregistrement SANS `name` charge sans erreur (nom vide)", () => {
    const path = tempStorePath();
    // Journal écrit par une version ANTÉRIEURE : pas de champ `name`.
    writeFileSync(
      path,
      JSON.stringify({
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        eventId: "legacy-1",
        agentId: "agent-old",
        kind: "upsert",
        patch: { lastSeen: "2026-01-01T00:00:00.000Z" },
      }) + "\n",
    );
    const store = open(path);
    const rec = store.get("agent-old");
    expect(rec?.name).toBe("");
    expect(rec?.lastSeen).toBe("2026-01-01T00:00:00.000Z");
  });

  it("renomme un agent (espaces retirés) et impose l'UNICITÉ (insensible à la casse)", () => {
    const store = open(tempStorePath());
    store.markSeen("agent-1");
    store.markSeen("agent-2");
    expect(store.setName("agent-1", "  nuc00  ").name).toBe("nuc00");
    expect(() => store.setName("agent-2", "NUC00")).toThrowError(/déjà utilisé/);
    // Le premier agent garde son nom ; le second reste sans nom.
    expect(store.get("agent-1")?.name).toBe("nuc00");
    expect(store.get("agent-2")?.name).toBe("");
  });

  it("refuse un nom vide ou trop long (bornes 1..64)", () => {
    const store = open(tempStorePath());
    store.markSeen("agent-1");
    expect(() => store.setName("agent-1", "   ")).toThrowError(/vide/);
    expect(() => store.setName("agent-1", "x".repeat(65))).toThrowError(/trop long/);
    expect(store.setName("agent-1", "x".repeat(64)).name).toHaveLength(64);
  });

  it("configure exige un agent existant aussi pour le nom", () => {
    const store = open(tempStorePath());
    expect(() => store.setName("inconnu", "nuc00")).toThrowError(AgentError);
  });

  it("resolve : l'ID exact D'ABORD, puis le nom (insensible à la casse)", () => {
    const store = open(tempStorePath());
    store.markSeen("agent-1");
    store.setName("agent-1", "nuc00");
    expect(store.resolve("agent-1")?.agentId).toBe("agent-1");
    expect(store.resolve("nuc00")?.agentId).toBe("agent-1");
    expect(store.resolve("NUC00")?.agentId).toBe("agent-1");
    expect(store.resolve("inconnu")).toBeUndefined();
  });

  it("prefillName : ne remplit que si vide, n'écrase jamais, ignore doublon et valeur invalide", () => {
    const store = open(tempStorePath());
    store.markSeen("agent-1");
    store.markSeen("agent-2");
    expect(store.prefillName("agent-1", "nuc00")?.name).toBe("nuc00");
    expect(store.prefillName("agent-1", "autre")?.name).toBe("nuc00");
    expect(store.prefillName("agent-2", "nuc00")?.name).toBe("");
    expect(store.prefillName("agent-2", "   ")?.name).toBe("");
    expect(store.prefillName("inconnu", "x")).toBeUndefined();
  });

  it("le nom survit à un redémarrage (rejeu du journal)", () => {
    const path = tempStorePath();
    const store = open(path);
    store.markSeen("agent-1");
    store.setName("agent-1", "nuc00");
    const reopened = open(path);
    expect(reopened.get("agent-1")?.name).toBe("nuc00");
  });
});

describe("AgentStore — persistance & rejeu", () => {
  it("survit à un redémarrage (rejeu du journal)", () => {
    const path = tempStorePath();
    const store = open(path);
    store.markSeen("agent-1", { lastSeen: "2026-01-01T00:00:00.000Z" });
    store.setLevel("agent-1", "always");
    store.markSeen("agent-2");
    store.revoke("agent-2");

    const reopened = open(path);
    expect(reopened.size).toBe(2);
    expect(reopened.get("agent-1")).toMatchObject({ level: "always", revoked: false });
    expect(reopened.get("agent-2")).toMatchObject({ revoked: true });
  });

  it("écrit une ligne JSON par événement", () => {
    const path = tempStorePath();
    const store = open(path);
    store.markSeen("agent-1", { lastSeen: "2026-01-01T00:00:00.000Z" });
    store.setLevel("agent-1", "never");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ agentId: "agent-1", kind: "upsert" });
  });

  it("rejeu IDEMPOTENT : un eventId déjà appliqué est ignoré", () => {
    const event: AgentEvent = {
      seq: 1,
      ts: "2026-01-01T00:00:00.000Z",
      eventId: "evt-1",
      agentId: "agent-1",
      kind: "upsert",
      patch: { lastSeen: "2026-01-01T00:00:00.000Z" },
    };
    const store = AgentStore.fromEvents([event, event], {
      path: tempStorePath(),
      defaults: { level: "destructive", privilege: "normal" },
    });
    expect(store.size).toBe(1);
  });

  it("rejeu : un seq inférieur pour le même agent est ignoré", () => {
    const base = { ts: "2026-01-01T00:00:00.000Z", agentId: "agent-1" };
    const store = AgentStore.fromEvents(
      [
        { seq: 5, eventId: "e5", kind: "upsert", patch: { level: "never" }, ...base },
        { seq: 3, eventId: "e3", kind: "upsert", patch: { level: "always" }, ...base },
      ],
      { path: tempStorePath(), defaults: { level: "destructive", privilege: "normal" } },
    );
    expect(store.get("agent-1")?.level).toBe("never");
  });
});
