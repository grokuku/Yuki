/**
 * Intégration WS — validations humaines (D118) DANS la conversation.
 *
 * Vérifie le ROUTAGE par conversation (la trame ne part qu'aux clients du bon
 * fil), la diffusion temps réel, la décision par WebSocket, la ré-apparition à
 * la reconnexion tant que la demande est vivante, et — contrainte explicite —
 * que la demande n'entre NI dans le transcript NI dans le snapshot (trame de
 * CONTRÔLE : aucun `seq` consommé, jamais bufferisée).
 */

import { afterEach, describe, expect, it } from "vitest";

import { startHarness, TestClient, type Harness } from "../gateway/ws/harness.js";
import type {
  ApprovalDecisionOutcome,
  ApprovalGatewayPort,
  ExecutionOutcome,
  PendingApprovalView,
} from "../../src/agents/execution.js";
import type { ApprovalViewEvent } from "../../src/agents/execution.js";

function view(overrides: Partial<PendingApprovalView> = {}): PendingApprovalView {
  return {
    id: "ap-1",
    sessionId: "sess-1",
    agentId: "agent-1",
    agentName: "nuc00",
    command: "rm -rf /tmp/x",
    destructive: true,
    destructiveIds: ["rm"],
    destructiveReasons: ["suppression (rm)"],
    createdAt: new Date(0).toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    ttlSeconds: 300,
    ...overrides,
  };
}

function outcomeFor(approval: PendingApprovalView): ExecutionOutcome {
  return {
    status: "completed",
    agentId: approval.agentId,
    agentName: approval.agentName,
    command: approval.command,
    destructive: approval.destructive,
    destructiveIds: approval.destructiveIds,
    exitCode: 0,
    framed: '<sortie machine="agent-1" code="0">bonjour</sortie>',
    message: "Commande exécutée (code de sortie 0).",
    durationMs: 5,
  };
}

/** Port d'approbations EN MÉMOIRE (piloté par le test). */
class FakeApprovalPort implements ApprovalGatewayPort {
  private readonly listeners = new Set<(event: ApprovalViewEvent) => void>();
  private readonly pending = new Map<string, PendingApprovalView>();

  add(approval: PendingApprovalView): void {
    this.pending.set(approval.id, approval);
  }

  emit(event: ApprovalViewEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribeApprovals(listener: (event: ApprovalViewEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  pendingApprovals(sessionId: string): PendingApprovalView[] {
    return [...this.pending.values()].filter((a) => a.sessionId === sessionId);
  }

  async decideApproval(
    id: string,
    decision: "approve" | "deny",
  ): Promise<ApprovalDecisionOutcome> {
    const approval = this.pending.get(id);
    if (!approval) {
      return {
        ok: false,
        code: "approval_not_found",
        message: "Cette demande n'existe plus.",
      };
    }
    this.pending.delete(id);
    if (decision === "deny") return { ok: true, decision: "deny", approval };
    return { ok: true, decision: "approve", approval, outcome: outcomeFor(approval) };
  }
}

let harness: Harness | undefined;
const clients: TestClient[] = [];
const ports: FakeApprovalPort[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await harness?.close();
  harness = undefined;
  ports.splice(0);
});

function newPort(): FakeApprovalPort {
  const port = new FakeApprovalPort();
  ports.push(port);
  return port;
}

async function start(port: FakeApprovalPort, current = "sess-1"): Promise<Harness> {
  harness = await startHarness({
    sessionId: current,
    sessions: [
      { id: "sess-1", file: "/fake/sess-1.jsonl" },
      { id: "sess-2", file: "/fake/sess-2.jsonl" },
    ],
    approvals: port,
  });
  return harness;
}

async function hello(h: Harness): Promise<TestClient> {
  const c = await TestClient.connect(h.url);
  clients.push(c);
  c.send({ type: "hello", clientVersion: "1" });
  await c.waitFor((frame) => frame.type === "welcome");
  await c.waitFor((frame) => frame.type === "snapshot");
  return c;
}

describe("WS — validation humaine routée par conversation", () => {
  it("n'envoie la demande qu'aux clients du BON fil", async () => {
    const port = newPort();
    // Session courante = sess-2 ; la demande vit dans sess-1 (routage strict).
    const h = await start(port, "sess-2");
    port.add(view());

    // Client sur sess-2 (session courante) : ne reçoit RIEN.
    const onOther = await hello(h);
    expect(onOther.frames.some((f) => f.type === "approval")).toBe(false);

    // Bascule vers sess-1 : la demande apparaît, avec la BONNE session d'enveloppe.
    onOther.send({ type: "switch", sessionId: "sess-1" });
    const approval = await onOther.waitFor((f) => f.type === "approval");
    expect(approval.type === "approval" && approval.approval.id).toBe("ap-1");
    expect(approval.sessionId).toBe("sess-1");
    expect(approval.type === "approval" && approval.approval.command).toBe("rm -rf /tmp/x");
    expect(approval.type === "approval" && approval.approval.destructiveReasons).toEqual([
      "suppression (rm)",
    ]);
  });

  it("la demande est une trame de CONTRÔLE : ni transcript, ni snapshot, ni seq consommé", async () => {
    const port = newPort();
    const h = await start(port);
    port.add(view());
    const client = await hello(h);

    const snapshot = client.frames.find((f) => f.type === "snapshot");
    const approval = await client.waitFor((f) => f.type === "approval");
    expect(snapshot?.type).toBe("snapshot");
    // Le transcript du snapshot ne contient AUCUNE trace de la demande.
    if (snapshot?.type === "snapshot") {
      expect(snapshot.transcript).toHaveLength(0);
      expect(JSON.stringify(snapshot.transcript)).not.toContain("ap-1");
    }
    // Aucun `seq` consommé : la trame réutilise le seq courant du snapshot.
    expect(approval.seq).toBe(snapshot?.seq);
  });

  it("diffuse la demande en temps réel (subscribe) puis le retrait (decided)", async () => {
    const port = newPort();
    const h = await start(port);
    const client = await hello(h);
    expect(client.frames.some((f) => f.type === "approval")).toBe(false);

    port.emit({ kind: "requested", approval: view({ id: "ap-rt" }) });
    const shown = await client.waitFor((f) => f.type === "approval" && f.approval.id === "ap-rt");
    expect(shown.type).toBe("approval");

    port.emit({ kind: "decided", approval: view({ id: "ap-rt" }), decision: "approve" });
    const cleared = await client.waitFor(
      (f) => f.type === "approval_cleared" && f.id === "ap-rt",
    );
    expect(cleared.type).toBe("approval_cleared");
  });

  it("décider par WebSocket : retrait du bloc + résultat éphémère", async () => {
    const port = newPort();
    const h = await start(port);
    port.add(view({ id: "ap-decide" }));
    const client = await hello(h);
    await client.waitFor((f) => f.type === "approval" && f.approval.id === "ap-decide");

    client.send({ type: "approval_decision", id: "ap-decide", decision: "approve" });
    const cleared = await client.waitFor(
      (f) => f.type === "approval_cleared" && f.id === "ap-decide",
    );
    expect(cleared.type).toBe("approval_cleared");
    const result = await client.waitFor(
      (f) => f.type === "approval_result" && f.result.id === "ap-decide",
    );
    if (result.type !== "approval_result") throw new Error("résultat attendu");
    expect(result.result.ok).toBe(true);
    expect(result.result.exitCode).toBe(0);
    expect(result.result.output).toContain("bonjour");
    // Le résultat est lui aussi une trame de contrôle (aucun seq consommé).
    expect(result.seq).toBe(cleared.seq);
  });

  it("refuser : retrait SANS résultat, et aucune exécution déclenchée", async () => {
    const port = newPort();
    const h = await start(port);
    port.add(view({ id: "ap-deny" }));
    const client = await hello(h);
    await client.waitFor((f) => f.type === "approval" && f.approval.id === "ap-deny");

    client.send({ type: "approval_decision", id: "ap-deny", decision: "deny" });
    await client.waitFor((f) => f.type === "approval_cleared" && f.id === "ap-deny");
    expect(client.frames.some((f) => f.type === "approval_result")).toBe(false);
  });

  it("ré-affichée à la reconnexion tant qu'elle est en attente", async () => {
    const port = newPort();
    const h = await start(port);
    port.add(view({ id: "ap-alive" }));

    const first = await hello(h);
    await first.waitFor((f) => f.type === "approval" && f.approval.id === "ap-alive");
    await first.close();

    const second = await hello(h);
    const again = await second.waitFor((f) => f.type === "approval" && f.approval.id === "ap-alive");
    expect(again.type).toBe("approval");

    // Une fois décidée : plus JAMAIS ré-affichée.
    second.send({ type: "approval_decision", id: "ap-alive", decision: "approve" });
    await second.waitFor((f) => f.type === "approval_cleared" && f.id === "ap-alive");
    await second.close();

    const third = await hello(h);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      third.frames.some((f) => f.type === "approval" && f.approval.id === "ap-alive"),
    ).toBe(false);
  });

  it("un clic tardif (demande inconnue) échoue PROPREMENT", async () => {
    const port = newPort();
    const h = await start(port);
    const client = await hello(h);

    client.send({ type: "approval_decision", id: "disparue", decision: "approve" });
    const error = await client.waitFor(
      (f) => f.type === "error" && f.code === "approval_not_found",
    );
    expect(error.type === "error" && error.message.length > 0).toBe(true);
    // Le bloc obsolète est aussi retiré côté client.
    expect(
      client.frames.some((f) => f.type === "approval_cleared" && f.id === "disparue"),
    ).toBe(true);
  });
});
