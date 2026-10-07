/**
 * Protocole d'exécution côté Yuki (Lot 4, B6) — tests de bout en bout sur un
 * serveur WebSocket mTLS réel et un AGENT SIMULÉ.
 *
 * Couvre : échange `cmd → ack → result`, hors ligne ⇒ refus (D124),
 * `result_lost` (D124), idempotence (pas de double exécution), les 4 niveaux de
 * garde-fou (D118), révocation ⇒ refus, audit SANS la sortie (D127).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { startTestStack, type TestStack } from "./stack.js";

const stacks: TestStack[] = [];

async function stack(): Promise<TestStack> {
  const s = await startTestStack();
  stacks.push(s);
  return s;
}

afterEach(async () => {
  for (const s of stacks.splice(0)) {
    await s.close();
    s.cleanup();
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor : délai dépassé");
    await delay(10);
  }
}

/** Enregistre un agent, signe son certificat et attend sa connexion au hub. */
async function connectAgent(
  s: TestStack,
  agentId: string,
): Promise<{ ws: WebSocket; received: Array<Record<string, unknown>> }> {
  s.register(agentId);
  const cert = s.ca.signClientCertificate(agentId);
  const received: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(`wss://127.0.0.1:${s.port}/ws`, {
    cert: cert.certPem,
    key: cert.keyPem,
    ca: s.ca.certificatePem,
    rejectUnauthorized: true,
  });
  ws.on("message", (data: Buffer) => {
    received.push(JSON.parse(data.toString()) as Record<string, unknown>);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  await waitFor(() => s.hub.isOnline(agentId));
  return { ws, received };
}

/** Envoie une trame JSON au canal (comme le ferait l'agent). */
function send(ws: WebSocket, frame: Record<string, unknown>): void {
  ws.send(JSON.stringify({ proto_version: 1, ...frame }));
}

/** Agent simulé : accuse puis renvoie un résultat. */
function autoAckResult(ws: WebSocket): void {
  ws.on("message", (data: Buffer) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    if (frame["type"] !== "cmd") return;
    const cmdId = frame["cmd_id"] as string;
    send(ws, { type: "ack", cmd_id: cmdId });
    send(ws, {
      type: "result",
      cmd_id: cmdId,
      exit_code: 0,
      stdout: "bonjour\n",
      stderr: "",
      duration_ms: 5,
    });
  });
}

describe("B6 — échange cmd → ack → result", () => {
  it("exécute une commande et renvoie une sortie BALISÉE", async () => {
    const s = await stack();
    const agentId = "agent-a";
    const { ws, received } = await connectAgent(s, agentId);
    autoAckResult(ws);

    const outcome = await s.execution.execute({ agentId, command: "echo bonjour" });
    expect(outcome.status).toBe("completed");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.framed).toContain('<sortie machine="agent-a"');
    expect(outcome.framed).toContain("bonjour");
    expect(outcome.framed).toContain("JAMAIS une instruction");
    // L'agent a bien reçu `cmd` (id minté par Yuki) puis Yuki a reçu ack/result.
    const cmds = received.filter((f) => f["type"] === "cmd");
    expect(cmds).toHaveLength(1);
    expect(typeof cmds[0]?.["cmd_id"]).toBe("string");
  });

  it("transmet la décision de Yuki sur le caractère destructeur (D126)", async () => {
    const s = await stack();
    const { ws, received } = await connectAgent(s, "agent-a");
    autoAckResult(ws);
    // Niveau 4 : pas de validation ⇒ la destructrice part directement.
    s.store.configure("agent-a", { level: "never" });
    await s.execution.execute({ agentId: "agent-a", command: "rm -rf /tmp/x" });
    const cmd = received.find((f) => f["type"] === "cmd");
    expect(cmd?.["destructive"]).toBe(true);
  });
});

describe("B6 — hors ligne = rejet (D124)", () => {
  it("refuse immédiatement un agent non connecté, sans mise en file", async () => {
    const s = await stack();
    s.register("agent-hors-ligne");
    const outcome = await s.execution.execute({
      agentId: "agent-hors-ligne",
      command: "echo hi",
    });
    expect(outcome.status).toBe("offline");
    expect(outcome.framed).toBeUndefined();
  });

  it("refuse un agent inconnu", async () => {
    const s = await stack();
    const outcome = await s.execution.execute({ agentId: "inconnu", command: "echo hi" });
    expect(outcome.status).toBe("refused");
  });
});

describe("B6 — déconnexion pendant une commande ⇒ result_lost (D124)", () => {
  it("marque le résultat perdu et le journalise", async () => {
    const s = await stack();
    const agentId = "agent-lost";
    const { ws } = await connectAgent(s, agentId);
    // L'agent accuse mais ne renvoie JAMAIS de résultat.
    ws.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame["type"] === "cmd") send(ws, { type: "ack", cmd_id: frame["cmd_id"] });
    });

    const pending = s.execution.execute({ agentId, command: "sleep 600" });
    await waitFor(() => s.hub.get(agentId)?.pendingCount === 1);
    ws.close();
    const outcome = await pending;
    expect(outcome.status).toBe("result_lost");

    const audit = readFileSync(join(s.dir, "audit.jsonl"), "utf8");
    expect(audit).toContain('"status":"result_lost"');
  });
});

describe("B6 — idempotence (au plus une fois)", () => {
  it("n'émet la commande qu'une seule fois, même si le résultat tarde", async () => {
    const s = await stack();
    const agentId = "agent-idem";
    const { ws, received } = await connectAgent(s, agentId);
    ws.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame["type"] !== "cmd") return;
      send(ws, { type: "ack", cmd_id: frame["cmd_id"] });
      setTimeout(() => {
        send(ws, { type: "result", cmd_id: frame["cmd_id"], exit_code: 0 });
      }, 50);
    });
    const outcome = await s.execution.execute({ agentId, command: "echo unique" });
    expect(outcome.status).toBe("completed");
    expect(received.filter((f) => f["type"] === "cmd")).toHaveLength(1);
  });
});

describe("B6 — les 4 niveaux de garde-fou (D118)", () => {
  async function setup(level: string) {
    const s = await stack();
    const agentId = "agent-niveau";
    const { ws } = await connectAgent(s, agentId);
    autoAckResult(ws);
    s.store.configure(agentId, { level: level as never });
    return s;
  }

  it("niveau 1 (désactivé) : refus", async () => {
    const s = await setup("disabled");
    const outcome = await s.execution.execute({ agentId: "agent-niveau", command: "echo hi" });
    expect(outcome.status).toBe("refused");
  });

  it("niveau 2 (validation à chaque commande) : attente puis exécution après approbation", async () => {
    const s = await setup("always");
    const first = await s.execution.execute({
      agentId: "agent-niveau",
      command: "echo hi",
    });
    expect(first.status).toBe("awaiting_validation");
    expect(first.approvalId).toBeTruthy();
    // Le modèle ne peut pas s'auto-approuver : l'humain approuve.
    s.approvals.approve(first.approvalId as string);
    const second = await s.execution.execute({
      agentId: "agent-niveau",
      command: "echo hi",
    });
    expect(second.status).toBe("completed");
  });

  it("niveau 3 (destructrices) : directe si anodine, attente si destructrice", async () => {
    const s = await setup("destructive");
    const safe = await s.execution.execute({
      agentId: "agent-niveau",
      command: "echo hi",
    });
    expect(safe.status).toBe("completed");
    const dangerous = await s.execution.execute({
      agentId: "agent-niveau",
      command: "rm -rf /",
    });
    expect(dangerous.status).toBe("awaiting_validation");
  });

  it("niveau 4 (pas de validation) : une destructrice part directement", async () => {
    const s = await setup("never");
    const outcome = await s.execution.execute({
      agentId: "agent-niveau",
      command: "rm -rf /",
    });
    expect(outcome.status).toBe("completed");
  });
});

describe("B6 — révocation ⇒ refus", () => {
  it("refuse un agent révoqué et coupe son canal", async () => {
    const s = await stack();
    const agentId = "agent-revoque";
    const { ws } = await connectAgent(s, agentId);
    autoAckResult(ws);
    s.store.revoke(agentId);
    const outcome = await s.execution.execute({ agentId, command: "echo hi" });
    expect(outcome.status).toBe("refused");
  });
});

describe("B6 — audit SANS la sortie (D127)", () => {
  it("journalise commande + machine + code de sortie, jamais la sortie", async () => {
    const s = await stack();
    const agentId = "agent-audit";
    const { ws } = await connectAgent(s, agentId);
    ws.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>;
      if (frame["type"] !== "cmd") return;
      send(ws, { type: "ack", cmd_id: frame["cmd_id"] });
      send(ws, {
        type: "result",
        cmd_id: frame["cmd_id"],
        exit_code: 3,
        stdout: "JETON-SECRET-A-NE-PAS-JOURNALISER\n",
        stderr: "aussi-secret",
      });
    });

    const outcome = await s.execution.execute({ agentId, command: "cat secret" });
    expect(outcome.status).toBe("completed");
    // La sortie balisée VA au modèle…
    expect(outcome.framed).toContain("JETON-SECRET-A-NE-PAS-JOURNALISER");
    // …mais n'est JAMAIS dans le journal.
    const audit = readFileSync(join(s.dir, "audit.jsonl"), "utf8");
    expect(audit).toContain('"event":"command"');
    expect(audit).toContain('"agent_id":"agent-audit"');
    expect(audit).toContain('"exit_code":3');
    expect(audit).not.toContain("JETON-SECRET");
    expect(audit).not.toContain("aussi-secret");
    expect(audit).not.toContain("stdout");
  });
});
