/**
 * LOT 40 — VISIBILITÉ DES AGENTS PAR LE BOT DE LA CONNEXION.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : la trame `agents` était
 * fabriquée UNE fois (`agentPort.list()` sans bot) avec `botActif` = bot du
 * PROCESSUS. Une page ouverte sur `/?b=kohai` recevait donc les agents du bot
 * de la pile (« yuki ») : le bot voyait des machines qu'il n'a pas le droit
 * d'utiliser.
 *
 * Ce qui est verrouillé ici :
 *  ① deux bots, deux connexions ⇒ chaque client ne reçoit QUE les agents
 *    autorisés pour SON bot, et `botActif` nomme ce bot-là ;
 *  ② la rediffusion (changement du registre) respecte la même règle, par
 *    client — jamais une trame unique recopiée à tous ;
 *  ③ non-régression : une connexion SANS `botId` (client d'avant L4) reçoit les
 *    agents du bot par défaut du port, comme avant.
 */

import { afterEach, describe, expect, it } from "vitest";

import type { AgentsGatewayPort } from "../../../src/gateway/ws/server.js";
import type { ServerFrame, WireAgent } from "../../../src/gateway/ws/protocol.js";
import type { AgentLevel } from "../../../src/agents/types.js";
import { FakePiHost } from "../../pi/host-double.js";
import { startHarness, TestClient, type Harness } from "./harness.js";

type AgentsFrame = Extract<ServerFrame, { type: "agents" }>;

function asAgents(frame: ServerFrame): AgentsFrame {
  if (frame.type !== "agents") throw new Error(`trame inattendue : ${frame.type}`);
  return frame;
}

/**
 * Port d'agents SEMBLABLE AU RÉEL : `list(botId)` filtre sur `agent.bots`, et
 * l'absence de bot retombe sur `botActif()` — exactement `listPourBot`.
 */
class FakeAgentPort implements AgentsGatewayPort {
  agents: WireAgent[] = [];
  readonly appels: Array<string | undefined> = [];
  private readonly listeners = new Set<() => void>();

  list(botId?: string): WireAgent[] {
    this.appels.push(botId);
    const bot = botId ?? this.botActif();
    return this.agents
      .filter((agent) => !Array.isArray(agent.bots) || agent.bots.includes(bot))
      .map((agent) => ({ ...agent }));
  }

  botActif(): string {
    return "yuki";
  }

  setEnabled(): void {
    /* sans effet ici */
  }

  setLevel(_agentId: string, _level: AgentLevel): void {
    /* sans effet ici */
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Simule un changement du registre (connexion d'un agent). */
  change(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

let harness: Harness | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  while (clients.length > 0) await clients.pop()?.close();
  await harness?.close();
  harness = undefined;
});

async function hostKohai(): Promise<FakePiHost> {
  const kohai = new FakePiHost({
    sessionId: "sess-kohai",
    sessions: [{ id: "sess-kohai", title: "kohai-conv" }],
  });
  await kohai.start();
  return kohai;
}

/** Deux agents : `a1` pour `yuki` seulement, `a2` pour `kohai` seulement. */
function portDeuxBots(): FakeAgentPort {
  const port = new FakeAgentPort();
  port.agents = [
    { agentId: "a1", name: "nuc-yuki", level: "never", revoked: false, online: true, bots: ["yuki"] },
    { agentId: "a2", name: "nuc-kohai", level: "never", revoked: false, online: true, bots: ["kohai"] },
  ];
  return port;
}

describe("LOT 40 — trame `agents` : visibilité du bot de la CONNEXION", () => {
  it("un agent non autorisé pour le bot sélectionné n'est PAS dans sa trame", async () => {
    const port = portDeuxBots();
    harness = await startHarness({ agents: port, autresHosts: { kohai: await hostKohai() } });

    // Page ouverte sur `/?b=kohai` (le bot secondaire), puis page du principal.
    const clientKohai = await TestClient.connect(harness.urlBot("kohai"));
    clients.push(clientKohai);
    clientKohai.send({ type: "hello", botId: "kohai" });
    const kohai = asAgents(await clientKohai.waitFor("agents"));
    expect(kohai.botActif).toBe("kohai");
    expect(kohai.agents.map((agent) => agent.agentId)).toEqual(["a2"]);

    const clientYuki = await TestClient.connect(harness.url);
    clients.push(clientYuki);
    clientYuki.send({ type: "hello" });
    const yuki = asAgents(await clientYuki.waitFor("agents"));
    expect(yuki.botActif).toBe("yuki");
    expect(yuki.agents.map((agent) => agent.agentId)).toEqual(["a1"]);
  });

  it("la rediffusion respecte la même règle, PAR CLIENT", async () => {
    const port = portDeuxBots();
    harness = await startHarness({ agents: port, autresHosts: { kohai: await hostKohai() } });

    const clientKohai = await TestClient.connect(harness.urlBot("kohai"));
    clients.push(clientKohai);
    clientKohai.send({ type: "hello", botId: "kohai" });
    await clientKohai.waitFor("agents");

    const clientYuki = await TestClient.connect(harness.url);
    clients.push(clientYuki);
    clientYuki.send({ type: "hello" });
    await clientYuki.waitFor("agents");

    // Un agent de PLUS apparaît côté « yuki » : `kohai` ne doit pas le voir.
    port.agents = [
      ...port.agents,
      { agentId: "a3", name: "nuc-yuki-2", level: "never", revoked: false, online: true, bots: ["yuki"] },
    ];
    port.change();

    const yuki = asAgents(
      await clientYuki.waitFor((f) => f.type === "agents" && asAgents(f).agents.length === 2),
    );
    expect(yuki.agents.map((agent) => agent.agentId)).toEqual(["a1", "a3"]);

    const kohai = asAgents(
      await clientKohai.waitFor(
        (f) => f.type === "agents" && asAgents(f).agents.every((agent) => agent.agentId !== "a3"),
      ),
    );
    expect(kohai.botActif).toBe("kohai");
    expect(kohai.agents.map((agent) => agent.agentId)).toEqual(["a2"]);
  });

  it("connexion SANS `botId` : le bot par défaut du port, comportement inchangé", async () => {
    const port = portDeuxBots();
    harness = await startHarness({ agents: port });

    const client = await TestClient.connect(harness.url);
    clients.push(client);
    client.send({ type: "hello" });
    const frame = asAgents(await client.waitFor("agents"));
    expect(frame.botActif).toBe("yuki");
    expect(frame.agents.map((agent) => agent.agentId)).toEqual(["a1"]);
  });
});
