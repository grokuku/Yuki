/**
 * Transport WS — flux de SECRET (`awaiting_secret`).
 *
 * Vérifie : trame de CONTRÔLE `secret_request` (aucun `seq` consommé, routée à la
 * SEULE conversation), JAMAIS dans le rejeu ni le snapshot (éphémère), envoi
 * d'une fourniture (`secret_submit`) et nettoyage (`secret_cleared`), et
 * ré-affichage des demandes en attente à la connexion.
 */

import { afterEach, describe, expect, it } from "vitest";

import type {
  PendingSecretView,
  SecretRequestGatewayPort,
  SecretRequestViewEvent,
  SecretSubmitOutcome,
} from "../../../src/agents/execution.js";
import type { ServerFrame } from "../../../src/gateway/ws/protocol.js";
import { startHarness, TestClient, type Harness } from "./harness.js";

const harnesses: Harness[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const h of harnesses.splice(0)) await h.close();
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class FakeSecretPort implements SecretRequestGatewayPort {
  private readonly listeners = new Set<(event: SecretRequestViewEvent) => void>();
  readonly submissions: Array<{ id: string; values: Record<string, string> }> = [];
  pending: PendingSecretView[] = [];

  subscribeSecrets(listener: (event: SecretRequestViewEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  pendingSecrets(sessionId: string): PendingSecretView[] {
    return this.pending.filter((r) => r.sessionId === sessionId);
  }

  async submitSecret(id: string, values: Record<string, string>): Promise<SecretSubmitOutcome> {
    this.submissions.push({ id, values });
    const request = this.pending.find((r) => r.id === id) ?? view({ id });
    return {
      ok: true,
      request,
      outcome: {
        status: "completed",
        agentId: request.agentId,
        command: request.command,
        destructive: false,
        destructiveIds: [],
        exitCode: 0,
        message: "Commande exécutée.",
      },
    };
  }

  emit(event: SecretRequestViewEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}

function view(overrides: Partial<PendingSecretView> = {}): PendingSecretView {
  return {
    id: "sec-1",
    sessionId: "sess-1",
    agentId: "agent-a",
    agentName: "nuc00",
    command: "mount -o ${YUKI_SECRET_NAS}",
    names: ["YUKI_SECRET_NAS"],
    createdAt: "2026-10-09T00:00:00.000Z",
    expiresAt: "2026-10-09T00:10:00.000Z",
    ttlSeconds: 600,
    ...overrides,
  };
}

type SecretFrame = Extract<ServerFrame, { type: "secret_request" }>;

function countType(c: TestClient, type: ServerFrame["type"]): number {
  return c.frames.filter((f) => f.type === type).length;
}

describe("awaiting_secret — trame de contrôle éphémère", () => {
  it("pousse la demande sans consommer de `seq`, avec machine + commande exacte", async () => {
    const port = new FakeSecretPort();
    const h = await startHarness({ secrets: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    const snapshot = await c.waitFor("snapshot");
    const seqAfterSnapshot = snapshot.seq;

    port.emit({ kind: "requested", request: view() });
    const frame = (await c.waitFor((f) => f.type === "secret_request")) as SecretFrame;

    expect(frame.request.names).toEqual(["YUKI_SECRET_NAS"]);
    expect(frame.request.command).toBe("mount -o ${YUKI_SECRET_NAS}");
    expect(frame.request.agentId).toBe("agent-a");
    // Trame de CONTRÔLE : réutilise le `seq` courant, n'en consomme aucun.
    expect(frame.seq).toBe(seqAfterSnapshot);
    expect(frame.sessionId).toBe("sess-1");
  });

  it("ne diffuse QU'À la conversation concernée", async () => {
    const port = new FakeSecretPort();
    const h = await startHarness({ secrets: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    await c.waitFor("snapshot");

    port.emit({ kind: "requested", request: view({ sessionId: "une-autre-session" }) });
    await delay(50);
    expect(countType(c, "secret_request")).toBe(0);
  });

  it("n'entre NI dans le rejeu NI dans le snapshot", async () => {
    const port = new FakeSecretPort();
    const h = await startHarness({ secrets: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    await c.waitFor("snapshot");
    port.emit({ kind: "requested", request: view() });
    await c.waitFor((f) => f.type === "secret_request");

    const welcomeBefore = countType(c, "welcome");
    const framesBefore = c.frames.length;
    c.send({ type: "resume", sessionId: "sess-1", fromSeq: 0 });
    await c.waitFor((f) => f.type === "welcome" && countType(c, "welcome") > welcomeBefore);
    await delay(30);

    const replayed = c.frames.slice(framesBefore);
    expect(replayed.some((f) => f.type === "secret_request")).toBe(false);
  });
});

describe("awaiting_secret — fourniture", () => {
  it("transmet la valeur au service puis retire la fenêtre", async () => {
    const port = new FakeSecretPort();
    port.pending = [view()];
    const h = await startHarness({ secrets: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    await c.waitFor("snapshot");
    // Ré-affichage des demandes en attente à la connexion.
    await c.waitFor((f) => f.type === "secret_request");

    c.send({ type: "secret_submit", id: "sec-1", values: { YUKI_SECRET_NAS: "s3cr3t-value" } });
    await c.waitFor((f) => f.type === "secret_cleared");
    await c.waitFor((f) => f.type === "approval_result");

    expect(port.submissions).toEqual([{ id: "sec-1", values: { YUKI_SECRET_NAS: "s3cr3t-value" } }]);
    // La trame de nettoyage ne porte jamais la valeur.
    expect(JSON.stringify(c.frames)).not.toContain("s3cr3t-value");
  });

  it("une demande inconnue renvoie une erreur honnête + nettoyage", async () => {
    const port = new FakeSecretPort();
    // `submitSecret` renvoie ok dans ce double ; on simule l'échec via un port dédié.
    const failing: SecretRequestGatewayPort = {
      subscribeSecrets: () => () => undefined,
      pendingSecrets: () => [],
      submitSecret: async () => ({
        ok: false,
        code: "secret_request_not_found",
        message: "Cette demande n'existe plus.",
      }),
    };
    const h = await startHarness({ secrets: failing });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    clients.push(c);
    c.send({ type: "hello" });
    await c.waitFor("snapshot");

    c.send({ type: "secret_submit", id: "inconnu", values: { YUKI_SECRET_X: "valeur" } });
    const err = (await c.waitFor((f) => f.type === "error")) as Extract<ServerFrame, { type: "error" }>;
    expect(err.code).toBe("secret_request_not_found");
    await c.waitFor((f) => f.type === "secret_cleared");
    void port;
  });
});
