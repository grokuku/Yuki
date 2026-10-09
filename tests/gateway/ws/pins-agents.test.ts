/**
 * Transport WS — épinglage des conversations et encart agents.
 *
 * Vérifie : l'épinglage persiste et remonte en tête, la mise de côté nettoie
 * l'épingle orpheline, l'état des agents arrive à la connexion puis est
 * REDIFFUSÉ à chaque changement (aucun polling), et le on/off passe par le port
 * d'agents (le serveur décide du niveau).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { orderSessions, type AgentsGatewayPort } from "../../../src/gateway/ws/server.js";
import type { ServerFrame, WireAgent, WireSession } from "../../../src/gateway/ws/protocol.js";
import { SessionPinStore } from "../../../src/pi/session-pins.js";
import { createLogger } from "../../../src/observability/logger.js";
import { startHarness, TestClient, type Harness } from "./harness.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const dirs: string[] = [];
const harnesses: Harness[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-ws-pins-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type SessionsFrame = Extract<ServerFrame, { type: "sessions" }>;
type AgentsFrame = Extract<ServerFrame, { type: "agents" }>;

function asSessions(frame: ServerFrame): SessionsFrame {
  if (frame.type !== "sessions") throw new Error(`trame inattendue : ${frame.type}`);
  return frame;
}
function asAgents(frame: ServerFrame): AgentsFrame {
  if (frame.type !== "agents") throw new Error(`trame inattendue : ${frame.type}`);
  return frame;
}
function sessionById(frame: SessionsFrame, id: string): WireSession | undefined {
  return frame.sessions.find((session) => session.id === id);
}

/**
 * Attend la PROCHAINE trame `sessions` (au-delà de `afterCount` déjà reçues).
 * Indispensable pour distinguer la réponse d'une action du premier envoi : la
 * trame `sessions` est un CONTRÔLE (même `seq`), un prédicat sur son contenu
 * pourrait sinon matcher une trame antérieure.
 */
async function nextSessions(c: TestClient, afterCount: number): Promise<SessionsFrame> {
  const count = () => c.frames.filter((f) => f.type === "sessions").length;
  const frame = await c.waitFor(
    (f) => f.type === "sessions" && count() > afterCount,
  );
  return asSessions(frame);
}

class FakeAgentPort implements AgentsGatewayPort {
  agents: WireAgent[] = [];
  readonly setEnabledCalls: Array<[string, boolean]> = [];
  private readonly listeners = new Set<() => void>();

  list(): WireAgent[] {
    return this.agents.map((agent) => ({ ...agent }));
  }

  setEnabled(agentId: string, enabled: boolean): void {
    this.setEnabledCalls.push([agentId, enabled]);
    this.agents = this.agents.map((agent) =>
      agent.agentId === agentId
        ? { ...agent, level: enabled ? "destructive" : "disabled" }
        : agent,
    );
    for (const listener of [...this.listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

describe("orderSessions — épinglées d'abord, puis date décroissante", () => {
  it("place les épinglées en tête et trie le reste par date", () => {
    const sessions: WireSession[] = [
      { id: "a", title: "a", messageCount: 0, updatedAt: "2026-01-03T00:00:00.000Z" },
      { id: "b", title: "b", messageCount: 0, updatedAt: "2026-01-05T00:00:00.000Z", pinned: true },
      { id: "c", title: "c", messageCount: 0, updatedAt: "2026-01-04T00:00:00.000Z" },
      { id: "d", title: "d", messageCount: 0, updatedAt: "2026-01-01T00:00:00.000Z", pinned: true },
    ];
    expect(orderSessions(sessions).map((s) => s.id)).toEqual(["b", "d", "c", "a"]);
  });

  it("stable : à date égale, l'ordre d'entrée est conservé", () => {
    const sessions: WireSession[] = [
      { id: "a", title: "a", messageCount: 0 },
      { id: "b", title: "b", messageCount: 0 },
    ];
    expect(orderSessions(sessions).map((s) => s.id)).toEqual(["a", "b"]);
  });
});

describe("WS — épinglage des conversations", () => {
  it("épingle : la trame `sessions` porte `pinned` et remonte la conversation en tête", async () => {
    const pins = SessionPinStore.open({ path: join(tempDir(), "pins.json"), logger });
    const h = await startHarness({
      sessionId: "s1",
      sessions: [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
      pins,
    });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });

    const initial = asSessions(await c.waitFor((f) => f.type === "sessions"));
    expect(initial.sessions.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(initial.sessions.every((s) => s.pinned !== true)).toBe(true);

    c.send({ type: "pin", sessionId: "s3", pinned: true });
    const updated = await nextSessions(c, 1);
    expect(updated.sessions.map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
    expect(updated.sessions[0]?.pinned).toBe(true);
    expect(pins.isPinned("s3")).toBe(true);

    // Désépingler remet la liste dans l'ordre d'origine.
    c.send({ type: "pin", sessionId: "s3", pinned: false });
    const back = await nextSessions(c, 2);
    expect(back.sessions.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(pins.isPinned("s3")).toBe(false);
    await c.close();
  });

  it("met de côté : l'épingle orpheline est nettoyée", async () => {
    const pins = SessionPinStore.open({ path: join(tempDir(), "pins.json"), logger });
    const h = await startHarness({
      sessionId: "s1",
      sessions: [{ id: "s1" }, { id: "s2" }],
      pins,
    });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "sessions");

    c.send({ type: "pin", sessionId: "s2", pinned: true });
    const pinnedFrame = await nextSessions(c, 1);
    expect(sessionById(pinnedFrame, "s2")?.pinned).toBe(true);
    expect(pins.isPinned("s2")).toBe(true);

    c.send({ type: "setAside", sessionId: "s2" });
    const after = await nextSessions(c, 2);
    expect(after.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(pins.isPinned("s2")).toBe(false); // nettoyée
    await c.close();
  });
});

describe("WS — encart agents", () => {
  it("envoie l'état des agents à la connexion (révoqués inclus)", async () => {
    const port = new FakeAgentPort();
    port.agents = [
      { agentId: "a1", name: "nuc00", level: "destructive", revoked: false, online: true },
      { agentId: "a2", name: "", level: "disabled", revoked: true, online: false },
    ];
    const h = await startHarness({ agents: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    const frame = asAgents(await c.waitFor("agents"));
    expect(frame.agents).toEqual(port.agents);
    await c.close();
  });

  it("on/off passe par le port et est REDIFFUSÉ à tous les clients (aucun polling)", async () => {
    const port = new FakeAgentPort();
    port.agents = [
      { agentId: "a1", name: "nuc00", level: "never", revoked: false, online: true },
    ];
    const h = await startHarness({ agents: port });
    harnesses.push(h);
    const c1 = await TestClient.connect(h.url);
    const c2 = await TestClient.connect(h.url);
    c1.send({ type: "hello" });
    c2.send({ type: "hello" });
    await c1.waitFor("agents");
    await c2.waitFor("agents");

    c1.send({ type: "agent_enabled", agentId: "a1", enabled: false });
    // …LES DEUX clients reçoivent la nouvelle trame `agents`.
    const off1 = asAgents(
      await c1.waitFor((f) => f.type === "agents" && asAgents(f).agents[0]?.level === "disabled"),
    );
    const off2 = asAgents(
      await c2.waitFor((f) => f.type === "agents" && asAgents(f).agents[0]?.level === "disabled"),
    );
    // …et le port a reçu la bascule.
    expect(port.setEnabledCalls).toEqual([["a1", false]]);
    expect(off1.agents[0]?.level).toBe("disabled");
    expect(off2.agents[0]?.level).toBe("disabled");
    await c1.close();
    await c2.close();
  });
});
