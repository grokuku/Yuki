/**
 * Validations humaines (D118) — registre UNITAIRE.
 *
 * Couvre : rattachement à la CONVERSATION (`sessionId`), dédoublonnage par
 * (agent, commande, conversation), diffusion d'événements (demande/décision),
 * expiration (TTL) et « consume-once » inchangé (agent, commande).
 */

import { describe, expect, it, vi } from "vitest";

import { ApprovalRegistry, APPROVAL_TTL_MS } from "../../src/agents/approvals.js";

describe("ApprovalRegistry — routage par conversation", () => {
  it("conserve le sessionId, les motifs destructeurs et les détails d'exécution", () => {
    const registry = new ApprovalRegistry({ idFactory: () => "apr-1" });
    const entry = registry.request({
      agentId: "agent-1",
      command: "rm -rf /tmp/x",
      destructive: true,
      destructiveIds: ["rm-rf"],
      sessionId: "sess-A",
      shell: "/bin/bash",
      cwd: "/tmp",
      timeoutMs: 1200,
      origin: "run_command",
    });
    expect(entry.sessionId).toBe("sess-A");
    expect(entry.destructiveIds).toEqual(["rm-rf"]);
    expect(entry.shell).toBe("/bin/bash");
    expect(entry.cwd).toBe("/tmp");
    expect(entry.timeoutMs).toBe(1200);
    expect(entry.origin).toBe("run_command");
  });

  it("dédoublonne la MÊME demande dans la MÊME conversation", () => {
    let n = 0;
    const registry = new ApprovalRegistry({ idFactory: () => `apr-${++n}` });
    const first = registry.request({ agentId: "a", command: "echo", destructive: false, sessionId: "s" });
    const again = registry.request({ agentId: "a", command: "echo", destructive: false, sessionId: "s" });
    expect(again.id).toBe(first.id);
    expect(registry.list()).toHaveLength(1);
  });

  it("ne dédoublonne PAS entre DEUX conversations (routage distinct)", () => {
    let n = 0;
    const registry = new ApprovalRegistry({ idFactory: () => `apr-${++n}` });
    const a = registry.request({ agentId: "a", command: "echo", destructive: false, sessionId: "sess-A" });
    const b = registry.request({ agentId: "a", command: "echo", destructive: false, sessionId: "sess-B" });
    expect(b.id).not.toBe(a.id);
    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.sessionId).sort()).toEqual(["sess-A", "sess-B"]);
  });
});

describe("ApprovalRegistry — événements", () => {
  it("diffuse `requested` (nouvelle demande) et `decided` (approve/deny)", () => {
    const registry = new ApprovalRegistry({ idFactory: () => "apr-1" });
    const events: Array<Record<string, unknown>> = [];
    const unsubscribe = registry.subscribe((event) => {
      events.push(event as unknown as Record<string, unknown>);
    });
    const entry = registry.request({ agentId: "a", command: "echo", destructive: false, sessionId: "s" });
    expect(events).toHaveLength(1);
    expect(events[0]?.["kind"]).toBe("requested");

    registry.approve(entry.id);
    expect(events.at(-1)).toMatchObject({ kind: "decided", decision: "approve" });

    unsubscribe();
    registry.deny(entry.id);
    // Plus d'événement après désabonnement.
    expect(events.filter((e) => e["decision"] === "deny")).toHaveLength(0);
  });
});

describe("ApprovalRegistry — expiration (TTL)", () => {
  it("une demande expirée disparaît (liste, get, approbation refusée)", () => {
    let now = 1_000_000;
    const registry = new ApprovalRegistry({ now: () => now, idFactory: () => "apr-1" });
    const entry = registry.request({ agentId: "a", command: "echo", destructive: false, sessionId: "s" });
    expect(registry.list()).toHaveLength(1);

    now += APPROVAL_TTL_MS + 1;
    expect(registry.list()).toHaveLength(0);
    expect(registry.get(entry.id)).toBeUndefined();
    expect(() => registry.approve(entry.id)).toThrow();
  });
});

describe("ApprovalRegistry — consume-once (agent, commande) inchangé", () => {
  it("consomme une approbation UNE seule fois, pour la commande IDENTIQUE", () => {
    const registry = new ApprovalRegistry({ idFactory: () => "apr-1" });
    const entry = registry.request({
      agentId: "a",
      command: "echo",
      destructive: false,
      sessionId: "s",
    });
    registry.approve(entry.id);
    expect(registry.consume("a", "echo")).toBe(true);
    // Deuxième consommation : refusée (déjà consommée).
    expect(registry.consume("a", "echo")).toBe(false);
    // Commande différente : jamais servie par cette approbation.
    expect(registry.consume("a", "autre")).toBe(false);
  });

  it("une demande expirée ne peut PAS être consommée", () => {
    let now = 0;
    const registry = new ApprovalRegistry({ now: () => now, idFactory: () => "apr-1" });
    const entry = registry.request({ agentId: "a", command: "echo", destructive: false });
    registry.approve(entry.id);
    now += APPROVAL_TTL_MS + 1;
    expect(registry.consume("a", "echo")).toBe(false);
  });
});

describe("ApprovalRegistry — bornes", () => {
  it("ignore un listener qui lève (les autres restent servis)", () => {
    const registry = new ApprovalRegistry({ idFactory: () => "apr-1" });
    const seen = vi.fn();
    registry.subscribe(() => {
      throw new Error("boom");
    });
    registry.subscribe(seen);
    registry.request({ agentId: "a", command: "echo", destructive: false });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
