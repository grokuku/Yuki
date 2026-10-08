/**
 * Intégration — réparation de l'affichage de l'historique après redémarrage.
 *
 * Ce test démarre le VRAI host SDK (aucun réseau, aucun modèle : on ne fait
 * jamais de `send`) avec une session pré-écrite sur disque, puis vérifie que :
 *   - la session reprise reconstruit un transcript NON vide (contenu seul) ;
 *   - ce transcript est servi par le `snapshot` WS à la connexion ;
 *   - la restauration n'émet AUCUN événement temps réel (`run_started`/`delta`/
 *     `run_finished`) : elle ne peut donc pas créer de doublon avec le flux ;
 *   - sans session, le transcript reste vide (comportement propre).
 */

import { createServer as createHttpServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { createWsTransport } from "../../src/gateway/ws/server.js";
import type { Transport } from "../../src/gateway/ws/transport.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost, type PiHost } from "../../src/pi/host.js";
import { TestClient } from "../gateway/ws/harness.js";

const REPORT_HEADER = "[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]";

interface World {
  root: string;
  agentDir: string;
  home: string;
  cwd: string;
  sessionsDir: string;
}

const tempRoots: string[] = [];
const hosts: PiHost[] = [];
const transports: Transport[] = [];
const servers: Server[] = [];
const clients: TestClient[] = [];

function emptyWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "yuki-restore-"));
  tempRoots.push(root);
  const world: World = {
    root,
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    cwd: join(root, "workspace"),
    sessionsDir: join(root, "agent", "sessions"),
  };
  for (const dir of [world.agentDir, world.home, world.cwd, world.sessionsDir]) {
    mkdirSync(dir, { recursive: true });
  }
  return world;
}

/** Écrit une session JSONL persistée (comme après un véritable échange). */
const T0 = Date.parse("2026-10-07T15:39:00.000Z");
function seedSession(world: World): void {
  const manager = SessionManager.create(world.cwd, world.sessionsDir);
  manager.appendMessage({
    role: "user",
    // Message utilisateur STOCKÉ avec son préfixe d'horodatage (comme le fait
    // désormais le host) : la restauration doit le MASQUER et conserver l'heure.
    content: "[horodatage] 2026-10-07 15:39 (heure locale) Bonjour, qui es-tu ?",
    timestamp: T0,
  });
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "raisonnement secret" },
      { type: "text", text: "Je suis Yuki." },
    ],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: T0 + 1000,
  });
  // Prompt SYNTHÉTIQUE de report de job : masqué du transcript (comme en direct).
  manager.appendMessage({
    role: "user",
    content: `${REPORT_HEADER}\njob_id: abc\n--- résultat brut ---\nok`,
    timestamp: T0 + 2000,
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "Le job est terminé." }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: T0 + 3000,
  });
}

async function startRealHost(world: World): Promise<PiHost> {
  const systemPrompt = readFileSync("config/pi/system-prompt.md", "utf8");
  const logger = createLogger({
    level: "error",
    sink: () => undefined,
    secretValues: [],
  });
  const host = createPiHost({
    agentDir: world.agentDir,
    cwd: world.cwd,
    home: world.home,
    sessionsDir: world.sessionsDir,
    systemPrompt,
    settingsSeedPath: "config/pi/settings.json",
    logger,
  });
  hosts.push(host);
  await host.start();
  return host;
}

async function startTransport(host: PiHost): Promise<string> {
  const logger = createLogger({
    level: "error",
    sink: () => undefined,
    secretValues: [],
  });
  const transport = createWsTransport({
    host,
    logger,
    serverVersion: "test-0.1.0",
    replayBufferSize: 1000,
    replayBufferBytes: 1_000_000,
  });
  transports.push(transport);
  const server = createHttpServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  servers.push(server);
  transport.attach(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return `ws://127.0.0.1:${address.port}/ws`;
}

async function connectAndSnapshot(url: string): Promise<TestClient> {
  const client = await TestClient.connect(url);
  clients.push(client);
  client.send({ type: "hello" });
  await client.waitFor((frame) => frame.type === "welcome");
  await client.waitFor((frame) => frame.type === "snapshot");
  return client;
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const transport of transports.splice(0)) {
    await transport.close();
  }
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
  for (const host of hosts.splice(0)) {
    await host.stop();
  }
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("intégration — reprise de session restaure le transcript", () => {
  it("reprend la session la plus récente et reconstruit un transcript non vide (contenu seul)", async () => {
    const world = emptyWorld();
    seedSession(world);
    const host = await startRealHost(world);

    const state = host.getState();
    expect(state).toBeDefined();
    // Le prompt synthétique de report est masqué ; « thinking » est exclu ; le
    // préfixe d'horodatage n'est PAS visible ; l'instant du message est conservé.
    expect(state?.transcript).toEqual([
      { role: "user", text: "Bonjour, qui es-tu ?", timestamp: T0 },
      { role: "assistant", text: "Je suis Yuki.", timestamp: T0 + 1000 },
      { role: "assistant", text: "Le job est terminé.", timestamp: T0 + 3000 },
    ]);
    expect(JSON.stringify(state?.transcript)).not.toContain("raisonnement secret");
    expect(JSON.stringify(state?.transcript)).not.toContain(REPORT_HEADER);
    expect(JSON.stringify(state?.transcript)).not.toContain("horodatage");
  });

  it("sert le transcript restauré via le snapshot WS, sans rejeu temps réel (idempotence)", async () => {
    const world = emptyWorld();
    seedSession(world);
    const host = await startRealHost(world);
    const url = await startTransport(host);

    const first = await connectAndSnapshot(url);
    const snapshot = first.frames.find((frame) => frame.type === "snapshot");
    expect(snapshot?.type).toBe("snapshot");
    if (snapshot?.type !== "snapshot") return;
    expect(snapshot.transcript).toEqual(host.getState()?.transcript);
    expect(snapshot.transcript.length).toBeGreaterThan(0);

    // Preuve d'idempotence : l'historique restauré n'est servi QUE par le
    // snapshot. Aucun événement temps réel n'est émis au démarrage, donc le
    // flux à venir (nouveaux `seq`) ne peut PAS reproduire ces messages.
    const live = first.frames.filter((frame) =>
      ["run_started", "delta", "run_finished"].includes(frame.type),
    );
    expect(live).toEqual([]);

    // Un SECOND client reçoit exactement le même transcript (aucune croissance).
    const second = await connectAndSnapshot(url);
    const snapshot2 = second.frames.find((frame) => frame.type === "snapshot");
    expect(snapshot2?.type).toBe("snapshot");
    if (snapshot2?.type !== "snapshot") return;
    expect(snapshot2.transcript).toEqual(snapshot.transcript);
  });

  it("sans session, le transcript et le snapshot restent vides (propre)", async () => {
    const world = emptyWorld();
    const host = await startRealHost(world);
    expect(host.getState()?.transcript).toEqual([]);

    const url = await startTransport(host);
    const client = await connectAndSnapshot(url);
    const snapshot = client.frames.find((frame) => frame.type === "snapshot");
    expect(snapshot?.type).toBe("snapshot");
    if (snapshot?.type !== "snapshot") return;
    expect(snapshot.transcript).toEqual([]);
  });
});
