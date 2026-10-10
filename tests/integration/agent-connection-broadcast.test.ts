/**
 * Intégration — l'état de CONNEXION des agents (source de la pastille de
 * l'encart) est diffusé EN DIRECT à TOUS les clients, sans rechargement.
 *
 * Chemin RÉEL : serveur machines mTLS (`startTestStack`) → `AgentHub` → port
 * d'agents du transport (abonné AU STORE **ET** AU HUB, exactement comme
 * `src/index.ts`) → trames `agents` poussées à chaque client.
 *
 * On prouve : connexion mTLS authentifiée ⇒ `online:true` ; fermeture ⇒
 * `online:false` ; et que l'état `online` est INDÉPENDANT du niveau (un agent
 * `disabled` reste `online:true`) : c'est le DÉCOUPLAGE demandé.
 */

import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { AgentsGatewayPort } from "../../src/gateway/ws/server.js";
import type { ServerFrame } from "../../src/gateway/ws/protocol.js";
import { startHarness, TestClient, type Harness } from "../gateway/ws/harness.js";
import { startTestStack, type TestStack } from "../agents/stack.js";

const stacks: TestStack[] = [];
const harnesses: Harness[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try {
      ws.close();
    } catch {
      // déjà fermée
    }
  }
  for (const h of harnesses.splice(0)) await h.close();
  for (const s of stacks.splice(0)) {
    await s.close();
    s.cleanup();
  }
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const AGENT_ID = "agent-live";

type AgentsFrame = Extract<ServerFrame, { type: "agents" }>;

function agentsCount(client: TestClient): number {
  return client.frames.filter((frame) => frame.type === "agents").length;
}

/** Attend une NOUVELLE trame `agents` (au-delà de `after`) portant l'état visé. */
async function nextAgents(
  client: TestClient,
  after: number,
  predicate: (frame: AgentsFrame) => boolean,
): Promise<AgentsFrame> {
  const frame = await client.waitFor((candidate) => {
    if (candidate.type !== "agents") return false;
    if (agentsCount(client) <= after) return false;
    return predicate(candidate as AgentsFrame);
  });
  return frame as AgentsFrame;
}

/** Monte la pile réelle + le transport dont le port d'agents suit store ET hub. */
async function startRig(): Promise<{ stack: TestStack; h: Harness }> {
  const stack = await startTestStack();
  stacks.push(stack);
  stack.register(AGENT_ID);
  const agents: AgentsGatewayPort = {
    list: () =>
      stack.store.list().map((record) => ({
        agentId: record.agentId,
        name: record.name !== "" ? record.name : record.agentId,
        level: record.level,
        revoked: record.revoked,
        online: stack.hub.isOnline(record.agentId),
      })),
    setEnabled: (agentId, enabled) => stack.store.setEnabled(agentId, enabled),
    setLevel: (agentId, level) => stack.store.setLevel(agentId, level),
    subscribe: (listener) => {
      const offStore = stack.store.subscribe(listener);
      const offHub = stack.hub.subscribe(listener);
      return () => {
        offStore();
        offHub();
      };
    },
  };
  const h = await startHarness({ sessionId: "sess-1", agents });
  harnesses.push(h);
  return { stack, h };
}

/** Connecte un agent mTLS RÉEL au port machines et attend son enregistrement. */
async function connectAgent(stack: TestStack): Promise<WebSocket> {
  const cert = stack.ca.signClientCertificate(AGENT_ID);
  const ws = new WebSocket(`wss://127.0.0.1:${stack.port}/ws`, {
    cert: cert.certPem,
    key: cert.keyPem,
    ca: stack.ca.certificatePem,
    rejectUnauthorized: true,
  });
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  while (!stack.hub.isOnline(AGENT_ID)) await delay(10);
  return ws;
}

describe("encart agents — la connexion est diffusée EN DIRECT à tous les clients", () => {
  it("connexion mTLS ⇒ `online:true` puis fermeture ⇒ `online:false` (2 clients)", async () => {
    const { stack, h } = await startRig();
    const c1 = await TestClient.connect(h.url);
    const c2 = await TestClient.connect(h.url);
    c1.send({ type: "hello", clientVersion: "1" });
    c2.send({ type: "hello", clientVersion: "1" });
    await c1.waitFor((f) => f.type === "agents");
    await c2.waitFor((f) => f.type === "agents");
    // État initial : déconnecté.
    const initial1 = await c1.waitFor((f) => f.type === "agents");
    expect((initial1 as AgentsFrame).agents.find((a) => a.agentId === AGENT_ID)?.online).toBe(false);

    const after1 = agentsCount(c1);
    const after2 = agentsCount(c2);
    const ws = await connectAgent(stack);

    // LES DEUX clients apprennent la CONNEXION, sans rechargement.
    const online1 = await nextAgents(c1, after1, (f) =>
      f.agents.some((a) => a.agentId === AGENT_ID && a.online === true),
    );
    const online2 = await nextAgents(c2, after2, (f) =>
      f.agents.some((a) => a.agentId === AGENT_ID && a.online === true),
    );
    expect(online1.agents.find((a) => a.agentId === AGENT_ID)?.online).toBe(true);
    expect(online2.agents.find((a) => a.agentId === AGENT_ID)?.online).toBe(true);

    // La FERMETURE est diffusée tout aussi vite.
    const beforeClose1 = agentsCount(c1);
    const beforeClose2 = agentsCount(c2);
    ws.close();
    const offline1 = await nextAgents(c1, beforeClose1, (f) =>
      f.agents.some((a) => a.agentId === AGENT_ID && a.online === false),
    );
    const offline2 = await nextAgents(c2, beforeClose2, (f) =>
      f.agents.some((a) => a.agentId === AGENT_ID && a.online === false),
    );
    expect(offline1.agents.find((a) => a.agentId === AGENT_ID)?.online).toBe(false);
    expect(offline2.agents.find((a) => a.agentId === AGENT_ID)?.online).toBe(false);

    await c1.close();
    await c2.close();
  });

  it("agent DÉSACTIVÉ mais CONNECTÉ ⇒ `online:true` (la pastille ignore le niveau)", async () => {
    const { stack, h } = await startRig();
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello", clientVersion: "1" });
    await c.waitFor((f) => f.type === "agents");

    await connectAgent(stack);
    // Le niveau `disabled` est refusé à l'exécution, mais le canal reste OUVERT.
    stack.store.setLevel(AGENT_ID, "disabled");

    const frame = await nextAgents(c, 0, (f) => {
      const agent = f.agents.find((a) => a.agentId === AGENT_ID);
      return agent !== undefined && agent.level === "disabled" && agent.online === true;
    });
    const agent = frame.agents.find((a) => a.agentId === AGENT_ID);
    expect(agent?.level).toBe("disabled");
    expect(agent?.online).toBe(true); // découplé du niveau

    await c.close();
  });
});
