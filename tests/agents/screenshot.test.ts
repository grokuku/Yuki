/**
 * Capture d'écran par l'agent (Lot 4, extension) — test de bout en bout sur un
 * serveur WebSocket mTLS réel et un AGENT SIMULÉ.
 *
 * Couvre : capacité `screenshot` RÉELLE exigée (sinon refus HONNÊTE), garde-fou
 * par agent (niveau 1 = refus, niveau 2 = validation, niveau 3 = passe), image
 * ÉPHÉMÈRE (jamais dans le résultat, l'image ne part que par l'événement
 * `captured`) et audit SANS contenu d'image.
 */

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { parseAgentFrame, type CapturedScreenshotView } from "../../src/agents/index.js";
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

interface AgentSim {
  ws: WebSocket;
  /** Trammes `screenshot` reçues du serveur. */
  shots: Array<Record<string, unknown>>;
}

/** Connecte un agent simulé et lui fait annoncer ses capacités (`hello`). */
async function connectAgent(
  s: TestStack,
  agentId: string,
  caps: string[],
): Promise<AgentSim> {
  s.register(agentId);
  const cert = s.ca.signClientCertificate(agentId);
  const shots: Array<Record<string, unknown>> = [];
  const ws = new WebSocket(`wss://127.0.0.1:${s.port}/ws`, {
    cert: cert.certPem,
    key: cert.keyPem,
    ca: s.ca.certificatePem,
    rejectUnauthorized: true,
  });
  ws.on("message", (data: Buffer) => {
    const frame = JSON.parse(data.toString()) as Record<string, unknown>;
    if (frame["type"] !== "screenshot") return;
    shots.push(frame);
    // Réponse : image JPEG de 1 octet, encodée en base64 (données factices).
    ws.send(
      JSON.stringify({
        proto_version: 1,
        type: "screenshot_data",
        cmd_id: frame["cmd_id"],
        format: "jpeg",
        width: 1280,
        height: 720,
        bytes: 1,
        data: "QQ==",
        duration_ms: 12,
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  // `hello` : c'est LUI qui rend les capacités visibles de Yuki.
  ws.send(
    JSON.stringify({
      proto_version: 1,
      type: "hello",
      agent_id: agentId,
      agent_version: "test",
      euid: 1000,
      caps,
    }),
  );
  await waitFor(() => s.hub.isOnline(agentId) && s.hub.hasCapability(agentId, "screenshot") === caps.includes("screenshot"));
  return { ws, shots };
}

function lastAudit(s: TestStack, event: string): Record<string, unknown> | undefined {
  const records = s.audit.recent({ event, limit: 10 });
  return records[0];
}

const SCREENSHOT_CAPS = ["exec", "shell", "classify", "screenshot"];

describe("parseAgentFrame — trame screenshot_data", () => {
  it("décode une capture (métadonnées + base64)", () => {
    const parsed = parseAgentFrame(
      JSON.stringify({
        proto_version: 1,
        type: "screenshot_data",
        cmd_id: "s-1",
        format: "jpeg",
        width: 1280,
        height: 720,
        bytes: 3,
        data: "QUJD",
        duration_ms: 8,
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frame.type).toBe("screenshot_data");
    if (parsed.frame.type !== "screenshot_data") return;
    expect(parsed.frame.width).toBe(1280);
    expect(parsed.frame.data).toBe("QUJD");
  });
});

describe("capture d'écran — garde-fous et éphémérité", () => {
  it("capture, affiche (événement) et ne renvoie QUE des métadonnées", async () => {
    const s = await stack();
    const agentId = "agent-shot";
    const sim = await connectAgent(s, agentId, SCREENSHOT_CAPS);
    s.store.setLevel(agentId, "destructive");

    const captured: CapturedScreenshotView[] = [];
    s.execution.subscribeScreenshots((event) => captured.push(event.screenshot));

    const outcome = await s.execution.capture({ agentId, sessionId: "sess-1" });
    expect(outcome.status).toBe("captured");
    expect(outcome.width).toBe(1280);
    expect(outcome.height).toBe(720);
    // ⚠️ ANTI-EXFILTRATION : le résultat (donc le modèle) ne porte AUCUNE image.
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain("data:image");
    expect(serialized).not.toContain("QQ==");

    // L'image part par l'interface (humain).
    await waitFor(() => captured.length === 1);
    expect(captured[0]?.dataUrl).toBe("data:image/jpeg;base64,QQ==");
    expect(captured[0]?.sessionId).toBe("sess-1");

    // La demande a bien été émise vers l'agent.
    await waitFor(() => sim.shots.length === 1);
    expect(sim.shots[0]?.["type"]).toBe("screenshot");

    // Audit : trace SANS contenu d'image.
    const entry = lastAudit(s, "screenshot");
    expect(entry).toBeDefined();
    expect(JSON.stringify(entry)).not.toContain("QQ==");
    expect(JSON.stringify(entry)).not.toContain("data:image");
    expect((entry?.["meta"] as Record<string, unknown>)["status"]).toBe("captured");

    sim.ws.close();
  });

  it("refuse HONNÊTEMENT sans capacité (pas d'écran ou d'outil)", async () => {
    const s = await stack();
    const agentId = "agent-noscreen";
    const sim = await connectAgent(s, agentId, ["exec", "shell", "classify"]);
    s.store.setLevel(agentId, "never");

    const captured: CapturedScreenshotView[] = [];
    s.execution.subscribeScreenshots((event) => captured.push(event.screenshot));

    const outcome = await s.execution.capture({ agentId });
    expect(outcome.status).toBe("unsupported");
    expect(outcome.message).toContain("affichage");
    expect(outcome.message).toContain("outil de capture");
    // Aucune demande n'a été envoyée : on ne fait pas semblant.
    await delay(50);
    expect(sim.shots.length).toBe(0);
    expect(captured.length).toBe(0);
    expect((lastAudit(s, "screenshot")?.["meta"] as Record<string, unknown>)["status"]).toBe(
      "unsupported",
    );
    sim.ws.close();
  });

  it("un agent `disabled` BLOQUE la mesure (niveau 1)", async () => {
    const s = await stack();
    const agentId = "agent-off";
    const sim = await connectAgent(s, agentId, SCREENSHOT_CAPS);
    s.store.setLevel(agentId, "disabled");

    const outcome = await s.execution.capture({ agentId });
    expect(outcome.status).toBe("refused");
    expect(outcome.message).toContain("désactivé");
    await delay(50);
    expect(sim.shots.length).toBe(0);
    sim.ws.close();
  });

  it("au niveau 3 (destructive), la capture N'EST PAS destructrice ⇒ pas de validation", async () => {
    const s = await stack();
    const agentId = "agent-lvl3";
    const sim = await connectAgent(s, agentId, SCREENSHOT_CAPS);
    s.store.setLevel(agentId, "destructive");

    const outcome = await s.execution.capture({ agentId, sessionId: "sess-3" });
    // Aucune demande de validation : capture immédiate.
    expect(outcome.status).toBe("captured");
    expect(s.approvals.list().length).toBe(0);
    await waitFor(() => sim.shots.length === 1);
    sim.ws.close();
  });

  it("au niveau 2 (always), une validation humaine est requise", async () => {
    const s = await stack();
    const agentId = "agent-lvl2";
    const sim = await connectAgent(s, agentId, SCREENSHOT_CAPS);
    s.store.setLevel(agentId, "always");

    const outcome = await s.execution.capture({ agentId, sessionId: "sess-2" });
    expect(outcome.status).toBe("awaiting_validation");
    expect(outcome.approvalId).toBeDefined();
    expect(s.approvals.list().length).toBe(1);
    await delay(50);
    expect(sim.shots.length).toBe(0);
    sim.ws.close();
  });

  it("un agent hors ligne est refusé (D124)", async () => {
    const s = await stack();
    const agentId = "agent-gone";
    s.register(agentId);
    s.store.setLevel(agentId, "never");
    const outcome = await s.execution.capture({ agentId });
    expect(outcome.status).toBe("offline");
  });
});
