/**
 * Transport WS — SOURCES et suppression d'un fil qui les reçoit (point ③).
 *
 * Ce qui est verrouillé ici :
 *  - la trame `sessions` dit, pour chaque conversation, QUELLES sources y postent
 *    (`sources: [nom…]`) : c'est ce qui permet à la modale de suppression de les
 *    LISTER, donc de ne jamais supprimer un fil en silence ;
 *  - ⚠️ `delete` RÉAFFECTE ces sources (« nouvelle conversation à chaque fois ») :
 *    elles ne sont JAMAIS supprimées ni laissées à pointer dans le vide ;
 *  - un fil que personne n'alimente ne porte aucun marquage (rien à signaler).
 */

import { afterEach, describe, expect, it } from "vitest";

import type {
  ServerFrame,
  WireSession,
} from "../../../src/gateway/ws/protocol.js";
import type { SourcesGatewayPort } from "../../../src/gateway/ws/server.js";
import { startHarness, TestClient, type Harness } from "./harness.js";

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.close();
});

type SessionsFrame = Extract<ServerFrame, { type: "sessions" }>;

function asSessions(frame: ServerFrame): SessionsFrame {
  if (frame.type !== "sessions") throw new Error(`trame inattendue : ${frame.type}`);
  return frame;
}

function sessionById(frame: SessionsFrame, id: string): WireSession | undefined {
  return frame.sessions.find((session) => session.id === id);
}

/** Double du domaine `sources` : destinations en mémoire + journal des détachements. */
class FakeSourcesPort implements SourcesGatewayPort {
  /** `sessionId → [noms]`. */
  readonly destinations = new Map<string, string[]>();
  /** Appels reçus, dans l'ordre (le transport demande TOUJOURS, le domaine décide). */
  readonly calls: string[] = [];
  /** Fils dont des sources ont RÉELLEMENT été réaffectées. */
  readonly detached: string[] = [];

  sourcesForSession(sessionId: string): readonly string[] {
    return this.destinations.get(sessionId) ?? [];
  }

  detachSession(sessionId: string): readonly string[] {
    this.calls.push(sessionId);
    const noms = this.destinations.get(sessionId) ?? [];
    if (noms.length > 0) this.detached.push(sessionId);
    this.destinations.delete(sessionId);
    return noms;
  }
}

async function nextSessions(c: TestClient, afterCount: number): Promise<SessionsFrame> {
  const count = () => c.frames.filter((frame) => frame.type === "sessions").length;
  const frame = await c.waitFor((f) => f.type === "sessions" && count() > afterCount);
  return asSessions(frame);
}

describe("WS — les conversations disent quelles sources y postent", () => {
  it("marque le fil alimenté, et seulement lui", async () => {
    const port = new FakeSourcesPort();
    port.destinations.set("s1", ["veille-news"]);
    const h = await startHarness({ sessionId: "s1", sessions: [{ id: "s1" }, { id: "s2" }], sources: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });

    const frame = asSessions(await c.waitFor((f) => f.type === "sessions"));
    expect(sessionById(frame, "s1")?.sources).toEqual(["veille-news"]);
    // Un fil que personne n'alimente ne porte AUCUN tableau vide (bruit inutile).
    expect(sessionById(frame, "s2")?.sources).toBeUndefined();
    await c.close();
  });

  it("⚠️ `delete` RÉAFFECTE les sources du fil (jamais de suppression muette)", async () => {
    const port = new FakeSourcesPort();
    port.destinations.set("s2", ["veille-news", "mail"]);
    const h = await startHarness({
      sessionId: "s1",
      sessions: [{ id: "s1" }, { id: "s2" }],
      sources: port,
    });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    const initial = asSessions(await c.waitFor((f) => f.type === "sessions"));
    expect(sessionById(initial, "s2")?.sources).toEqual(["veille-news", "mail"]);

    c.send({ type: "delete", sessionId: "s2" });
    const after = await nextSessions(c, 1);
    expect(after.sessions.map((session) => session.id)).toEqual(["s1"]);
    // Le port a bien été appelé AVANT le rendu de la liste : les sources ont une
    // nouvelle destination (le domaine `sources` écrit en plus l'avis dans la boîte).
    expect(port.detached).toEqual(["s2"]);
    await c.close();
  });

  it("supprimer un fil sans source ne réaffecte rien", async () => {
    const port = new FakeSourcesPort();
    const h = await startHarness({ sessionId: "s1", sessions: [{ id: "s1" }, { id: "s2" }], sources: port });
    harnesses.push(h);
    const c = await TestClient.connect(h.url);
    c.send({ type: "hello" });
    await c.waitFor((f) => f.type === "sessions");

    c.send({ type: "delete", sessionId: "s2" });
    const after = await nextSessions(c, 1);
    expect(after.sessions.map((session) => session.id)).toEqual(["s1"]);
    // Le transport DEMANDE (le domaine répond « aucune source ») : personne n'est
    // réaffecté, donc aucune entrée d'alerte n'est écrite dans la boîte.
    expect(port.calls).toEqual(["s2"]);
    expect(port.detached).toEqual([]);
    await c.close();
  });
});
