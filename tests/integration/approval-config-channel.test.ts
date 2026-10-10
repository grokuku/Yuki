/**
 * Intégration WS — CANAL d'approbations de la page `/config`.
 *
 * ⚠️ Le test CLÉ : un client qui se connecte ALORS qu'une validation est EN
 * ATTENTE la REÇOIT (c'est ce qui garantit que la fenêtre flottante ne
 * disparaît PAS en passant de `/` à `/config`). On exerce le VRAI module
 * navigateur `public/ui/approval-channel.js` contre le transport WS réel : même
 * protocole (aucun second protocole), `hello` puis `approval_decision`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { startHarness, type Harness } from "../gateway/ws/harness.js";
import { createApprovalChannel } from "../../public/ui/approval-channel.js";
import type {
  ApprovalDecisionOutcome,
  ApprovalGatewayPort,
  ApprovalViewEvent,
  ExecutionOutcome,
  PendingApprovalView,
} from "../../src/agents/execution.js";

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
    framed: "<sortie>bonjour</sortie>",
    message: "Commande exécutée (code de sortie 0).",
    durationMs: 5,
  };
}

/** Port d'approbations EN MÉMOIRE (piloté par le test). */
class StubPort implements ApprovalGatewayPort {
  private readonly entries = new Map<string, PendingApprovalView>();
  private readonly listeners = new Set<(event: ApprovalViewEvent) => void>();

  add(approval: PendingApprovalView): void {
    this.entries.set(approval.id, approval);
  }

  expire(id: string): void {
    this.entries.delete(id);
  }

  subscribeApprovals(listener: (event: ApprovalViewEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  pendingApprovals(sessionId: string): PendingApprovalView[] {
    return [...this.entries.values()].filter((a) => a.sessionId === sessionId);
  }

  async decideApproval(
    id: string,
    decision: "approve" | "deny",
  ): Promise<ApprovalDecisionOutcome> {
    const approval = this.entries.get(id);
    if (!approval) {
      return { ok: false, code: "approval_not_found", message: "Cette demande n'existe plus." };
    }
    this.entries.delete(id);
    if (decision === "deny") return { ok: true, decision: "deny", approval };
    return { ok: true, decision: "approve", approval, outcome: outcomeFor(approval) };
  }
}

let harness: Harness | undefined;
const channels: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const channel of channels.splice(0)) channel.close();
  await harness?.close();
  harness = undefined;
});

async function start(port: StubPort): Promise<Harness> {
  harness = await startHarness({
    sessionId: "sess-1",
    sessions: [
      { id: "sess-1", file: "/fake/sess-1.jsonl" },
      { id: "sess-2", file: "/fake/sess-2.jsonl" },
    ],
    approvals: port,
  });
  return harness;
}

/** Canal branché sur le harnais (même module que la page `/config`). */
function channel(h: Harness, callbacks: Record<string, (...args: unknown[]) => void>) {
  const ch = createApprovalChannel({
    url: h.url,
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    ...callbacks,
  });
  channels.push(ch);
  ch.connect();
  return ch;
}

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition non satisfaite à temps");
};

describe("canal d'approbations /config (WS réel)", () => {
  it("reçoit une validation EN ATTENTE dès la connexion (le test clé)", async () => {
    const port = new StubPort();
    const h = await start(port);
    port.add(view());

    const received: PendingApprovalView[] = [];
    channel(h, { onApproval: (approval) => received.push(approval as PendingApprovalView) });

    await waitFor(() => received.length === 1);
    expect(received[0].id).toBe("ap-1");
    expect(received[0].command).toBe("rm -rf /tmp/x");
    expect(received[0].ttlSeconds).toBe(300);
  });

  it("décider par le canal retire la fenêtre (approval_cleared) et reçoit le résultat", async () => {
    const port = new StubPort();
    const h = await start(port);
    port.add(view({ id: "ap-cfg" }));

    const cleared: string[] = [];
    const results: Array<Record<string, unknown>> = [];
    let pending: PendingApprovalView | undefined;
    const ch = channel(h, {
      onApproval: (approval) => {
        pending = approval as PendingApprovalView;
      },
      onCleared: (id) => cleared.push(String(id)),
      onResult: (result) => results.push(result as Record<string, unknown>),
    });

    await waitFor(() => pending?.id === "ap-cfg");
    expect(ch.decide("ap-cfg", "approve")).toBe(true);
    await waitFor(() => cleared.includes("ap-cfg"));
    await waitFor(() => results.some((r) => r.id === "ap-cfg"));
  });

  it("diffuse le retrait à TOUS les clients de la conversation (chat + /config)", async () => {
    const port = new StubPort();
    const h = await start(port);
    port.add(view({ id: "ap-both" }));

    const clearedA: string[] = [];
    const clearedB: string[] = [];
    const a = channel(h, { onCleared: (id) => clearedA.push(String(id)) });
    channel(h, { onCleared: (id) => clearedB.push(String(id)) });

    await waitFor(() => clearedA.length === 0 && clearedB.length === 0);
    // Laisse les deux `hello` atteindre le serveur avant de décider.
    await waitFor(() => a.isOpen());
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(a.decide("ap-both", "deny")).toBe(true);

    await waitFor(() => clearedA.includes("ap-both") && clearedB.includes("ap-both"));
  });

  it("une demande EXPIRÉE (retirée du registre) ne réapparaît PAS à la reconnexion", async () => {
    const port = new StubPort();
    const h = await start(port);
    port.add(view({ id: "ap-exp" }));

    const first: string[] = [];
    const c1 = channel(h, { onApproval: (a) => first.push((a as PendingApprovalView).id) });
    await waitFor(() => first.includes("ap-exp"));
    c1.close();

    // Expiration : la demande n'est plus dans le registre.
    port.expire("ap-exp");

    const second: string[] = [];
    channel(h, { onApproval: (a) => second.push((a as PendingApprovalView).id) });
    await vi.waitFor(() => expect(second).toEqual([]), { timeout: 400 });
    expect(second).toEqual([]);
  });
});
