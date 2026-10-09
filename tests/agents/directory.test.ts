/**
 * Consultation des agents (Lot 4, extension) — `AgentDirectoryService`.
 *
 * Prouve que la consultation est en LECTURE SEULE, résolue par `store.resolve`,
 * et que l'historique ne contient JAMAIS la sortie (D127 : pas de `stdout`/
 * `stderr`/`output`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentDirectoryService,
  AgentStore,
  AGENT_LEVEL_LABELS,
  AGENT_PRIVILEGE_LABELS,
} from "../../src/agents/index.js";

const dirs: string[] = [];

function makeStore(): AgentStore {
  const dir = mkdtempSync(join(tmpdir(), "yuki-agent-directory-"));
  dirs.push(dir);
  return AgentStore.open({
    path: join(dir, "agents.jsonl"),
    defaults: { level: "destructive", privilege: "normal" },
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Capture {
  online: Set<string>;
  calls: Array<{ agentId?: string; event?: string; limit?: number }>;
  records: Record<string, unknown>[];
  caps: Map<string, string[]>;
}

function makeService(store: AgentStore): { service: AgentDirectoryService; capture: Capture } {
  const capture: Capture = { online: new Set(), calls: [], records: [], caps: new Map() };
  const service = new AgentDirectoryService({
    store,
    hub: {
      isOnline: (agentId) => capture.online.has(agentId),
      // Capacités annoncées par l'agent connecté (rendues visibles au modèle).
      caps: (agentId) => capture.caps.get(agentId) ?? [],
    },
    audit: {
      recent: (options = {}) => {
        capture.calls.push({
          ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
          ...(options.event !== undefined ? { event: options.event } : {}),
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        });
        return capture.records;
      },
    },
  });
  return { service, capture };
}

describe("agents — consultation (lecture seule)", () => {
  it("liste les agents NON révoqués avec leur état, niveau et privilège", () => {
    const store = makeStore();
    store.markSeen("a1");
    store.configure("a1", { name: "nuc00" });
    store.markSeen("a2");
    store.configure("a2", { level: "never", privilege: "root" });
    store.markSeen("a3");
    store.revoke("a3");
    const { service, capture } = makeService(store);
    capture.online.add("a1");

    const agents = service.list();
    const ids = agents.map((a) => a.agentId).sort();
    expect(ids).toEqual(["a1", "a2"]);
    const a1 = agents.find((a) => a.agentId === "a1");
    expect(a1).toMatchObject({
      name: "nuc00",
      online: true,
      level: "destructive",
      privilege: "normal",
    });
    const a2 = agents.find((a) => a.agentId === "a2");
    expect(a2).toMatchObject({ name: "", online: false, level: "never", privilege: "root" });
  });

  it("résout par NOM (insensible à la casse) et par ID, sinon `undefined`", () => {
    const store = makeStore();
    store.markSeen("a1");
    store.configure("a1", { name: "Nuc00" });
    const { service } = makeService(store);

    expect(service.find("a1")?.agentId).toBe("a1");
    expect(service.find("nuc00")?.agentId).toBe("a1");
    expect(service.find("NUC00")?.agentId).toBe("a1");
    expect(service.find("inconnu")).toBeUndefined();
  });

  it("ne résout PAS un agent révoqué", () => {
    const store = makeStore();
    store.markSeen("a1");
    store.configure("a1", { name: "nuc00" });
    store.revoke("a1");
    const { service } = makeService(store);
    expect(service.find("a1")).toBeUndefined();
    expect(service.find("nuc00")).toBeUndefined();
  });

  it("l'historique ne recopie QUE horodatage/commande/code de sortie (jamais la sortie)", () => {
    const store = makeStore();
    store.markSeen("a1");
    const { service, capture } = makeService(store);
    capture.records = [
      {
        ts: "2026-01-01T00:00:00.000Z",
        event: "command",
        agent_id: "a1",
        command: "echo bonjour",
        exit_code: 0,
        // ⚠️ Champs interdits : ils ne doivent PAS ressortir.
        stdout: "SECRET-STDOUT",
        stderr: "SECRET-STDERR",
        output: "SECRET-OUTPUT",
        result: "SECRET-RESULT",
      } as unknown as Record<string, unknown>,
      {
        ts: "2026-01-02T00:00:00.000Z",
        event: "command",
        agent_id: "a1",
        command: "rm /tmp/x",
        exit_code: null,
      },
    ];

    const history = service.history("a1");
    expect(history).toHaveLength(2);
    for (const entry of history) {
      expect(Object.keys(entry).sort()).toEqual(
        expect.arrayContaining(["ts"]),
      );
      for (const forbidden of ["stdout", "stderr", "output", "result"]) {
        expect(entry).not.toHaveProperty(forbidden);
      }
      expect(JSON.stringify(entry)).not.toContain("SECRET");
    }
    expect(history[0]).toMatchObject({ command: "echo bonjour", exitCode: 0 });
    expect(history[1]).toMatchObject({ command: "rm /tmp/x", exitCode: null });
    // Le service demande l'événement « command » (jamais les connexions).
    expect(capture.calls[0]).toMatchObject({ agentId: "a1", event: "command" });
  });

  it("borne la taille de l'historique (limite passée et plafond dur)", () => {
    const store = makeStore();
    store.markSeen("a1");
    const { service, capture } = makeService(store);
    capture.records = [];
    service.history("a1");
    expect(capture.calls.at(-1)?.limit).toBe(10);
    service.history("a1", 3);
    expect(capture.calls.at(-1)?.limit).toBe(3);
    service.history("a1", 1000);
    expect(capture.calls.at(-1)?.limit).toBe(50);
    service.history("a1", 0);
    expect(capture.calls.at(-1)?.limit).toBe(1);
  });

  it("les libellés couvrent TOUS les niveaux et privilèges", () => {
    expect(Object.keys(AGENT_LEVEL_LABELS).sort()).toEqual([
      "always",
      "destructive",
      "disabled",
      "never",
    ]);
    expect(Object.keys(AGENT_PRIVILEGE_LABELS).sort()).toEqual(["normal", "root"]);
  });

  it("expose les capacités DÉCLARÉES par l'agent (screenshot visible du modèle)", () => {
    const store = makeStore();
    store.markSeen("a1");
    store.markSeen("a2");
    const { service, capture } = makeService(store);
    capture.online.add("a1");
    capture.caps.set("a1", ["exec", "shell", "classify", "screenshot"]);
    // a2 est hors ligne : aucune capacité (l'agent n'a pas annoncé de hello).
    const list = service.list();
    expect(list.find((a) => a.agentId === "a1")?.caps).toEqual([
      "exec",
      "shell",
      "classify",
      "screenshot",
    ]);
    expect(list.find((a) => a.agentId === "a2")?.caps).toEqual([]);
    expect(service.find("a1")?.caps).toContain("screenshot");
  });

  it("sans port de capacités (double de test), renvoie une liste VIDE", () => {
    const store = makeStore();
    store.markSeen("a1");
    const service = new AgentDirectoryService({
      store,
      hub: { isOnline: () => true },
      audit: { recent: () => [] },
    });
    expect(service.list()[0]?.caps).toEqual([]);
  });
});
