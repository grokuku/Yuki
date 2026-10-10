/**
 * `AgentHub` — état de CONNEXION par agent (source de la pastille de l'encart).
 *
 * Vérifie que le hub DIFFUSE ses changements de connexion (abonnement) et qu'il
 * rompt les connexions SILENCIEUSES au-delà du seuil aligné sur le heartbeat de
 * l'agent (ping 15 s / hors ligne 45 s). C'est ce qui rend la pastille fidèle :
 * sans abonnement, une déconnexion ne touchait pas le store et n'était jamais
 * diffusée.
 */

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";
import type { WebSocket } from "ws";

import {
  AGENT_OFFLINE_AFTER_MS,
  AgentConnection,
  AgentHub,
} from "../../src/agents/connection.js";
import { encodePingFrame } from "../../src/agents/protocol.js";
import { createLogger } from "../../src/observability/logger.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/** Socket factice : suffit à `AgentConnection` (`on`/`send`/`close`/`readyState`). */
function fakeSocket(): WebSocket {
  const socket = new EventEmitter() as unknown as EventEmitter & { readyState: number };
  socket.readyState = 1; // WebSocket.OPEN
  (socket as unknown as { send: () => boolean }).send = () => true;
  (socket as unknown as { close: () => void }).close = () => socket.emit("close", 1000);
  return socket as unknown as WebSocket;
}

/** Crée une connexion comme le fait le serveur : `onClose` ⇒ `hub.unregister`. */
function connect(hub: AgentHub, agentId: string, now?: () => number): AgentConnection {
  const connection = new AgentConnection({
    ws: fakeSocket(),
    agentId,
    logger,
    onClose: (closed) => hub.unregister(closed),
    ...(now ? { now } : {}),
  });
  hub.register(connection);
  return connection;
}

describe("AgentHub — abonnement aux changements de connexion", () => {
  it("notifie à l'enregistrement (connecté) puis à la fermeture (déconnecté)", () => {
    const hub = new AgentHub({ logger });
    const events: boolean[] = [];
    hub.subscribe(() => events.push(hub.isOnline("a1")));

    const connection = connect(hub, "a1");
    expect(events).toEqual([true]);

    connection.dispose("test");
    expect(hub.isOnline("a1")).toBe(false);
    expect(events).toEqual([true, false]);
  });

  it("notifie AUSSI à la coupure forcée (`disconnect`, révocation)", () => {
    const hub = new AgentHub({ logger });
    const events: boolean[] = [];
    hub.subscribe(() => events.push(hub.isOnline("a1")));
    connect(hub, "a1");

    expect(hub.disconnect("a1")).toBe(true);
    expect(events).toEqual([true, false]);
  });

  it("se désabonne proprement (plus aucune notification)", () => {
    const hub = new AgentHub({ logger });
    let count = 0;
    const off = hub.subscribe(() => (count += 1));
    off();
    connect(hub, "a1");
    expect(count).toBe(0);
  });
});

describe("AgentHub.sweepStale — socket silencieuse (demi-ouverte)", () => {
  it("rompt la connexion à partir du seuil (45 s) et diffuse la déconnexion", () => {
    let clock = 1_000;
    const hub = new AgentHub({ logger });
    const events: boolean[] = [];
    hub.subscribe(() => events.push(hub.isOnline("a1")));
    connect(hub, "a1", () => clock);
    expect(hub.isOnline("a1")).toBe(true);

    // Juste AVANT le seuil : rien.
    clock += AGENT_OFFLINE_AFTER_MS - 1;
    expect(hub.sweepStale(AGENT_OFFLINE_AFTER_MS)).toEqual([]);
    expect(hub.isOnline("a1")).toBe(true);

    // Seuil atteint : la connexion est rompue et signalée déconnectée.
    clock += 1;
    expect(hub.sweepStale(AGENT_OFFLINE_AFTER_MS)).toEqual(["a1"]);
    expect(hub.isOnline("a1")).toBe(false);
    expect(events).toEqual([true, false]);
  });

  it("maintient la connexion tant que le heartbeat arrive (ping < 45 s)", () => {
    let clock = 0;
    const hub = new AgentHub({ logger });
    const connection = connect(hub, "a1", () => clock);
    for (let i = 0; i < 10; i += 1) {
      clock += 15_000; // heartbeat de l'agent
      connection.handleMessage(JSON.stringify(encodePingFrame(clock)));
      expect(hub.sweepStale(AGENT_OFFLINE_AFTER_MS)).toEqual([]);
    }
    expect(hub.isOnline("a1")).toBe(true);
  });
});
