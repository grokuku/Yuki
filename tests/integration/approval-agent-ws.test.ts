/**
 * Intégration — validation humaine DANS la conversation, chemin RÉEL de bout en
 * bout : `AgentExecutionService` (store + registre réels) → registre → transport
 * WS → client. Ne réutilise AUCUN double d'approbation : c'est ce qui manquait
 * aux tests existants (le port y était toujours simulé).
 *
 * But : verrouiller non-régression du chemin signalé en usage réel —
 *   - niveau 3 (`destructive`) ⇒ une commande destructrice DÉCLENCHE la
 *     validation (trame `approval` routée vers la BONNE conversation) ;
 *   - cliquer Valider EXÉCUTE la commande immédiatement (une seule fois) ;
 *   - le niveau 1 (`disabled`, l'« off » du on/off) REFUSE au lieu de valider
 *     — distinct de « valider », et sans bloc de validation ;
 *   - le niveau réglé (comme le fera le menu contextuel via `agent_level`)
 *     partage le MÊME état que le on/off.
 */

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { startTestStack, type TestStack } from "../agents/stack.js";
import { startHarness, TestClient, type Harness } from "../gateway/ws/harness.js";

const stacks: TestStack[] = [];
const harnesses: Harness[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const h of harnesses.splice(0)) await h.close();
  for (const s of stacks.splice(0)) {
    await s.close();
    s.cleanup();
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Rig {
  stack: TestStack;
  client: TestClient;
  cmds: Array<Record<string, unknown>>;
}

/** Monte la pile réelle + l'agent simulé (auto-ack/result) + le transport WS. */
async function startRig(): Promise<Rig> {
  const stack = await startTestStack();
  stacks.push(stack);
  const agentId = "agent-nuc00";
  stack.register(agentId);
  const cert = stack.ca.signClientCertificate(agentId);
  const cmds: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(`wss://127.0.0.1:${stack.port}/ws`, {
    cert: cert.certPem,
    key: cert.keyPem,
    ca: stack.ca.certificatePem,
    rejectUnauthorized: true,
  });
  sockets.push(ws);
  ws.on("message", (data: Buffer) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    if (frame["type"] !== "cmd") return;
    cmds.push(frame);
    const id = frame["cmd_id"] as string;
    ws.send(JSON.stringify({ proto_version: 1, type: "ack", cmd_id: id }));
    ws.send(
      JSON.stringify({
        proto_version: 1,
        type: "result",
        cmd_id: id,
        exit_code: 0,
        stdout: "fait\n",
        stderr: "",
        duration_ms: 1,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  while (!stack.hub.isOnline(agentId)) await delay(10);

  const h = await startHarness({
    sessionId: "sess-1",
    approvals: stack.execution,
    agents: {
      list: () =>
        stack.store.list().map((record) => ({
          agentId: record.agentId,
          name: record.name !== "" ? record.name : record.agentId,
          level: record.level,
          revoked: record.revoked,
          online: stack.hub.isOnline(record.agentId),
        })),
      setEnabled: (agentId, enabled) => {
        stack.store.setEnabled(agentId, enabled);
      },
      setLevel: (agentId, level) => {
        stack.store.setLevel(agentId, level);
      },
      subscribe: (listener) => stack.store.subscribe(listener),
    },
  });
  harnesses.push(h);
  const client = await TestClient.connect(h.url);
  client.send({ type: "hello", clientVersion: "1" });
  await client.waitFor((f) => f.type === "welcome");
  await client.waitFor((f) => f.type === "snapshot");
  return { stack, client, cmds };
}

describe("validation en conversation — chemin réel service → WS → décision", () => {
  it("niveau 3 : une destructrice DÉCLENCHE la validation, routée vers le bon fil", async () => {
    const { stack, client, cmds } = await startRig();
    // Défaut d'un agent appairé = « validation des destructrices ».
    expect(stack.store.get("agent-nuc00")?.level).toBe("destructive");

    const out = await stack.execution.execute({
      agentId: "agent-nuc00",
      command: "rm -rf /srv/cache",
      sessionId: "sess-1",
      origin: "run_command",
    });
    expect(out.status).toBe("awaiting_validation");
    expect(out.framed).toBeUndefined();
    // Rien n'a été envoyé à l'agent tant que l'humain n'a pas validé.
    expect(cmds).toHaveLength(0);

    const frame = await client.waitFor((f) => f.type === "approval", 2000);
    if (frame.type !== "approval") throw new Error("trame `approval` attendue");
    expect(frame.approval.sessionId).toBe("sess-1");
    expect(frame.approval.command).toBe("rm -rf /srv/cache");
    expect(frame.approval.destructive).toBe(true);
    expect(frame.approval.destructiveReasons.length).toBeGreaterThan(0);
  });

  it("clic Valider : la commande s'exécute IMMÉDIATEMENT (une seule fois) et le résultat est éphémère", async () => {
    const { stack, client, cmds } = await startRig();
    const out = await stack.execution.execute({
      agentId: "agent-nuc00",
      command: "rm -rf /srv/cache",
      sessionId: "sess-1",
      origin: "run_command",
    });
    const approval = await client.waitFor(
      (f) => f.type === "approval" && f.approval.id === (out.approvalId ?? ""),
      2000,
    );
    expect(approval.type).toBe("approval");

    client.send({ type: "approval_decision", id: out.approvalId as string, decision: "approve" });
    const cleared = await client.waitFor(
      (f) => f.type === "approval_cleared" && f.id === out.approvalId,
      3000,
    );
    expect(cleared.type).toBe("approval_cleared");
    const result = await client.waitFor(
      (f) => f.type === "approval_result" && f.result.id === out.approvalId,
      3000,
    );
    if (result.type !== "approval_result") throw new Error("résultat attendu");
    expect(result.result.ok).toBe(true);
    expect(result.result.status).toBe("completed");
    expect(result.result.output).toContain("fait");
    // Une SEULE commande émise vers l'agent (pas de double exécution).
    expect(cmds).toHaveLength(1);
  });

  it("niveau 1 (`disabled`, l'« off ») : REFUS, distinct de « valider », sans bloc", async () => {
    const { stack, client, cmds } = await startRig();
    stack.store.setEnabled("agent-nuc00", false); // comme le bouton on/off
    expect(stack.store.get("agent-nuc00")?.level).toBe("disabled");

    const out = await stack.execution.execute({
      agentId: "agent-nuc00",
      command: "rm -rf /srv/cache",
      sessionId: "sess-1",
      origin: "run_command",
    });
    // Refus NET : ni validation, ni exécution.
    expect(out.status).toBe("refused");
    expect(out.approvalId).toBeUndefined();
    expect(cmds).toHaveLength(0);
    // Aucun bloc de validation n'a été diffusé pour ce fil.
    await delay(50);
    expect(client.frames.some((f) => f.type === "approval")).toBe(false);
  });

  it("le menu contextuel (agent_level → setLevel) partage le MÊME état que le on/off", async () => {
    const { stack } = await startRig();
    // Off via le on/off…
    stack.store.setEnabled("agent-nuc00", false);
    expect(stack.store.get("agent-nuc00")?.level).toBe("disabled");
    // … puis « Validation des commandes destructrices » via le menu.
    stack.store.setLevel("agent-nuc00", "destructive");
    expect(stack.store.get("agent-nuc00")?.level).toBe("destructive");
    // Redevenu actif : une destructrice redéclenche la validation.
    const out = await stack.execution.execute({
      agentId: "agent-nuc00",
      command: "rm -rf /srv/cache",
      sessionId: "sess-1",
      origin: "run_command",
    });
    expect(out.status).toBe("awaiting_validation");
    // … et le on/off restaure désormais le niveau CHOISI (un seul état).
    expect(stack.store.setEnabled("agent-nuc00", false).level).toBe("disabled");
    expect(stack.store.setEnabled("agent-nuc00", true).level).toBe("destructive");
  });

  it("la trame `agent_level` du menu règle le niveau du VRAI store et le rediffuse", async () => {
    const { stack, client } = await startRig();
    // La trame `agents` initiale reflète le vrai registre.
    const initial = await client.waitFor("agents", 2000);
    expect(initial.type === "agents" && initial.agents[0]?.level).toBe("destructive");

    client.send({ type: "agent_level", agentId: "agent-nuc00", level: "never" });
    const updated = await client.waitFor(
      (f) => f.type === "agents" && f.agents[0]?.level === "never",
      2000,
    );
    expect(updated.type === "agents" && updated.agents[0]?.level).toBe("never");
    // Le store (source de vérité) a bien changé — même état que le on/off.
    expect(stack.store.get("agent-nuc00")?.level).toBe("never");
    // Le on/off restaure maintenant CE niveau : un seul état.
    stack.store.setEnabled("agent-nuc00", false);
    expect(stack.store.setEnabled("agent-nuc00", true).level).toBe("never");
  });
});
