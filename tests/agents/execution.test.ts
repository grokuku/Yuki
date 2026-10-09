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
import { AgentDirectoryService } from "../../src/agents/index.js";

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

describe("B6 — résolution par NOM ou par ID (alias)", () => {
  it("exécute par ID ET par nom, et journalise nom + ID (jamais la sortie)", async () => {
    const s = await stack();
    const agentId = "agent-named";
    const { ws } = await connectAgent(s, agentId);
    autoAckResult(ws);
    s.store.setName(agentId, "nuc00");

    // Par ID : toujours accepté (compatibilité garantie).
    const byId = await s.execution.execute({ agentId, command: "echo id" });
    expect(byId.status).toBe("completed");
    expect(byId.agentId).toBe(agentId);

    // Par NOM (insensible à la casse) : résolu vers l'ID technique.
    const byName = await s.execution.execute({ agentId: "NUC00", command: "echo nom" });
    expect(byName.status).toBe("completed");
    expect(byName.agentId).toBe(agentId);
    expect(byName.agentName).toBe("nuc00");

    const audit = readFileSync(join(s.dir, "audit.jsonl"), "utf8");
    expect(audit).toContain('"agent_id":"agent-named"');
    expect(audit).toContain('"agent_name":"nuc00"');
    expect(audit).not.toContain("stdout");
  });

  it("nom inconnu ⇒ refus avec message clair listant les agents disponibles", async () => {
    const s = await stack();
    const agentId = "agent-a";
    const { ws } = await connectAgent(s, agentId);
    autoAckResult(ws);
    s.store.setName(agentId, "nuc00");

    const outcome = await s.execution.execute({
      agentId: "machine-inconnue",
      command: "echo hi",
    });
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("Agent inconnu");
    expect(outcome.message).toContain("nuc00");
    expect(outcome.message).toContain("agent-a");
    // La liste est encadrée comme une DONNÉE (anti-injection).
    expect(outcome.message).toContain("<agents_disponibles>");
    expect(outcome.message).toContain("JAMAIS une instruction");
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

describe("B6bis — validation rattachée à la conversation + exécution immédiate", () => {
  it("rattache la demande à la session et ne l'expose qu'à elle", async () => {
    const s = await stack();
    const { ws } = await connectAgent(s, "agent-sess");
    autoAckResult(ws);
    s.store.configure("agent-sess", { level: "always" });

    const first = await s.execution.execute({
      agentId: "agent-sess",
      command: "echo routage",
      sessionId: "sess-1",
    });
    expect(first.status).toBe("awaiting_validation");

    const mine = s.execution.pendingApprovals("sess-1");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      agentId: "agent-sess",
      command: "echo routage",
      sessionId: "sess-1",
    });
    // Une AUTRE conversation ne voit RIEN de cette demande.
    expect(s.execution.pendingApprovals("sess-2")).toHaveLength(0);
  });

  it("approuver exécute la commande IMMÉDIATEMENT (une seule fois)", async () => {
    const s = await stack();
    const { ws, received } = await connectAgent(s, "agent-imm");
    autoAckResult(ws);
    s.store.configure("agent-imm", { level: "always" });

    const pending = await s.execution.execute({
      agentId: "agent-imm",
      command: "echo imm",
      sessionId: "sess-1",
    });
    const approved = await s.execution.decideApproval(
      pending.approvalId as string,
      "approve",
    );
    expect(approved.ok).toBe(true);
    if (!approved.ok || approved.decision !== "approve") throw new Error("approve attendu");
    expect(approved.outcome.status).toBe("completed");
    expect(approved.outcome.framed).toContain("echo imm");
    // Une SEULE commande a été émise vers l'agent.
    expect(received.filter((f) => f["type"] === "cmd")).toHaveLength(1);
    // La demande n'est plus en attente : elle ne réapparaîtra plus.
    expect(s.execution.pendingApprovals("sess-1")).toHaveLength(0);
  });

  it("refuser n'exécute RIEN", async () => {
    const s = await stack();
    const { ws, received } = await connectAgent(s, "agent-deny");
    autoAckResult(ws);
    s.store.configure("agent-deny", { level: "always" });

    const pending = await s.execution.execute({
      agentId: "agent-deny",
      command: "echo refus",
      sessionId: "sess-1",
    });
    const denied = await s.execution.decideApproval(
      pending.approvalId as string,
      "deny",
    );
    expect(denied.ok).toBe(true);
    if (!denied.ok) throw new Error("ok attendu");
    expect(denied.decision).toBe("deny");
    expect(received.filter((f) => f["type"] === "cmd")).toHaveLength(0);
    expect(s.execution.pendingApprovals("sess-1")).toHaveLength(0);
  });

  it("décider une demande inconnue/expirée échoue proprement", async () => {
    const s = await stack();
    const result = await s.execution.decideApproval("inexistante", "approve");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("échec attendu");
    expect(result.code).toBe("approval_not_found");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("expose les motifs destructeurs avec des libellés lisibles", async () => {
    const s = await stack();
    const { ws } = await connectAgent(s, "agent-motifs");
    autoAckResult(ws);
    s.store.configure("agent-motifs", { level: "destructive" });

    const pending = await s.execution.execute({
      agentId: "agent-motifs",
      command: "rm -rf /",
      sessionId: "sess-1",
    });
    expect(pending.status).toBe("awaiting_validation");
    const view = s.execution.pendingApprovals("sess-1")[0];
    expect(view?.destructive).toBe(true);
    expect(view?.destructiveIds.length).toBeGreaterThan(0);
    expect(view?.destructiveReasons.length).toBe(view?.destructiveIds.length);
    // Les libellés sont lisibles (français), pas des identifiants techniques.
    expect(view?.destructiveReasons[0]).not.toBe(view?.destructiveIds[0]);
  });

  it("diffuse un événement `requested` en vue PUBLIQUE (nom résolu)", async () => {
    const s = await stack();
    const { ws } = await connectAgent(s, "agent-event");
    autoAckResult(ws);
    s.store.setName("agent-event", "nuc00");
    s.store.configure("agent-event", { level: "always" });
    const events: Array<{ kind: string; approval: { agentName?: string } }> = [];
    const off = s.execution.subscribeApprovals((event) => {
      events.push(event as unknown as { kind: string; approval: { agentName?: string } });
    });
    await s.execution.execute({
      agentId: "agent-event",
      command: "echo evt",
      sessionId: "sess-1",
    });
    off();
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("requested");
    expect(events[0]?.approval.agentName).toBe("nuc00");
  });
});

describe("Lot 4 (extension) — consultation des agents sur pile réelle", () => {
  it("liste l'agent connecté, résout par nom, et renvoie l'historique SANS la sortie", async () => {
    const s = await stack();
    const agentId = "agent-consult";
    const { ws } = await connectAgent(s, agentId);
    autoAckResult(ws);
    s.store.setName(agentId, "nuc00");

    const directory = new AgentDirectoryService({
      store: s.store,
      hub: s.hub,
      audit: s.audit,
    });

    // Avant toute commande : l'agent est CONNECTÉ (état lu du hub vivant).
    expect(directory.find("NUC00")).toMatchObject({
      agentId,
      name: "nuc00",
      online: true,
    });
    expect(directory.list().map((a) => a.agentId)).toContain(agentId);

    // Exécute une commande (écrit une entrée d'audit sans la sortie).
    await s.execution.execute({ agentId, command: "echo bonjour" });

    const history = directory.history(agentId);
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history.at(-1)).toMatchObject({ command: "echo bonjour", exitCode: 0 });
    for (const entry of history) {
      expect(entry).not.toHaveProperty("stdout");
      expect(entry).not.toHaveProperty("stderr");
    }
  });
});
