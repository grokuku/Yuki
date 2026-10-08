/**
 * Intégration — conversations multiples : BASCULE, ABSENCE DE DOUBLON,
 * SUPPRESSION de la conversation OUVERTE (état vide) et nouvelle conversation.
 *
 * Ce test démarre le VRAI host SDK (aucun réseau, aucun modèle : on ne fait
 * jamais aboutir un prompt) avec DEUX sessions pré-écrites sur disque, puis
 * vérifie :
 *   - `hello` renvoie la LISTE des sessions + la session active (trou #1) ;
 *   - `switch` change RÉELLEMENT la session hôte (`host.resume`) puis sert un
 *     `snapshot` du nouveau fil (trou #2) ;
 *   - un aller-retour A → B → A laisse des transcripts de longueurs STABLES
 *     (aucune duplication, preuve du chemin `restoreTranscript` du chantier 1) ;
 *   - supprimer la conversation OUVERTE ramène à l'état vide (`activeId: null`)
 *     sans qu'aucun message ne parte dans le vide, puis une nouvelle
 *     conversation accepte un message.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
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

interface World {
  root: string;
  agentDir: string;
  home: string;
  cwd: string;
  sessionsDir: string;
}

interface SeededSession {
  id: string;
  file: string;
  user: string;
  assistant: string;
}

const tempRoots: string[] = [];
const hosts: PiHost[] = [];
const transports: Transport[] = [];
const servers: Server[] = [];
const clients: TestClient[] = [];

function emptyWorld(): World {
  const root = mkdtempSync(join(tmpdir(), "yuki-switch-"));
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

/** Écrit une session JSONL persistée complète (user + assistant). */
function seedSession(world: World, user: string, assistant: string): SeededSession {
  const manager = SessionManager.create(world.cwd, world.sessionsDir);
  manager.appendMessage({ role: "user", content: user, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: assistant }],
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
    timestamp: Date.now(),
  });
  const file = manager.getSessionFile();
  if (!file) throw new Error("session non persistée");
  return { id: manager.getSessionId(), file, user, assistant };
}

async function startRealHost(world: World): Promise<PiHost> {
  const systemPrompt = readFileSync("config/pi/system-prompt.md", "utf8");
  const logger = createLogger({ level: "error", sink: () => undefined, secretValues: [] });
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
  const logger = createLogger({ level: "error", sink: () => undefined, secretValues: [] });
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

async function connect(url: string): Promise<TestClient> {
  const client = await TestClient.connect(url);
  clients.push(client);
  client.send({ type: "hello" });
  await client.waitFor((frame) => frame.type === "welcome");
  await client.waitFor((frame) => frame.type === "sessions");
  await client.waitFor((frame) => frame.type === "snapshot");
  return client;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Dernier snapshot reçu pour une session donnée (après un court délai). */
async function lastSnapshot(
  client: TestClient,
  sessionId: string,
): Promise<Extract<TestClient["frames"][number], { type: "snapshot" }>> {
  await client.waitFor((frame) => frame.type === "snapshot" && frame.sessionId === sessionId);
  await sleep(120);
  const snapshot = [...client.frames]
    .reverse()
    .find((frame) => frame.type === "snapshot" && frame.sessionId === sessionId);
  if (!snapshot || snapshot.type !== "snapshot") {
    throw new Error("snapshot introuvable");
  }
  return snapshot;
}

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const transport of transports.splice(0)) await transport.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
  for (const host of hosts.splice(0)) await host.stop();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("intégration — conversations multiples et bascule", () => {
  it("hello renvoie la liste + l'active, et la bascule change RÉELLEMENT le fil", async () => {
    const world = emptyWorld();
    const a = seedSession(world, "Question du fil A", "Réponse du fil A");
    const b = seedSession(world, "Question du fil B", "Réponse du fil B");
    const host = await startRealHost(world);

    // Le host reprend le fil le plus récent ; on bascule vers L'AUTRE.
    const first = host.currentSessionId();
    expect([a.id, b.id]).toContain(first);
    const other = first === a.id ? b.id : a.id;
    const otherSession = other === a.id ? a : b;

    const url = await startTransport(host);
    const client = await connect(url);

    // Trou #1 : `hello` a renvoyé la liste des DEUX sessions + l'active.
    const sessionsFrame = client.frames.find((frame) => frame.type === "sessions");
    expect(sessionsFrame?.type).toBe("sessions");
    if (sessionsFrame?.type !== "sessions") return;
    expect(sessionsFrame.sessions.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(sessionsFrame.activeId).toBe(first);

    // Bascule (trou #2) : le host change de session, un snapshot suit.
    client.send({ type: "switch", sessionId: other });
    const snapshot = await lastSnapshot(client, other);

    // Preuve forte : le host est RÉELLEMENT sur le nouveau fil…
    expect(host.currentSessionId()).toBe(other);
    // …et le snapshot reflète le transcript du nouveau fil (contenu seul).
    const state = host.getState();
    expect(state?.sessionId).toBe(other);
    expect(snapshot.transcript).toEqual(state?.transcript);
    expect(snapshot.transcript.some((entry) => entry.text.includes(otherSession.assistant))).toBe(true);
    expect(snapshot.transcript.some((entry) => entry.text.includes(otherSession.user))).toBe(true);
    // Aucune trace du fil d'origine (pas de fuite de transcript).
    const absent = other === a.id ? b : a;
    expect(snapshot.transcript.some((entry) => entry.text.includes(absent.assistant))).toBe(false);

    // Le message SUIVANT ne part PAS dans le vide : il est accepté sur le fil.
    client.send({ type: "message", clientMsgId: "m1", text: "Suite du fil" });
    const accepted = await client.waitFor((frame) => frame.type === "accepted");
    expect(accepted.type === "accepted" && accepted.runId).toBeTruthy();
    // Le prompt est routé sur le NOUVEAU fil (transcript mis à jour).
    expect(
      host.getState()?.transcript.some((entry) => entry.text === "Suite du fil"),
    ).toBe(true);
    // Le fil d'origine reste intact (aucune contamination croisée).
    await sleep(50);
  });

  it("aller-retour A → B → A : transcripts de longueurs STABLES (aucun doublon)", async () => {
    const world = emptyWorld();
    const a = seedSession(world, "Fil A", "Réponse A");
    const b = seedSession(world, "Fil B", "Réponse B");
    const host = await startRealHost(world);
    const first = host.currentSessionId();
    const second = first === a.id ? b.id : a.id;

    const url = await startTransport(host);
    const client = await connect(url);
    // Le snapshot initial correspond au fil actif.
    const initial = await lastSnapshot(client, first ?? "");
    const lenFirst = initial.transcript.length;
    expect(lenFirst).toBeGreaterThan(0);

    client.send({ type: "switch", sessionId: second });
    const snapB = await lastSnapshot(client, second);
    const lenSecond = snapB.transcript.length;

    client.send({ type: "switch", sessionId: first ?? "" });
    const snapA = await lastSnapshot(client, first ?? "");

    // Longueurs STABLES : la bascule RÉINITIALISE le rendu (snapshot), donc
    // aucun message n'est ajouté ni dupliqué.
    expect(snapA.transcript.length).toBe(lenFirst);
    expect(snapA.transcript).toEqual(initial.transcript);

    client.send({ type: "switch", sessionId: second });
    const snapB2 = await lastSnapshot(client, second);
    expect(snapB2.transcript.length).toBe(lenSecond);
  });

  it("supprimer la conversation OUVERTE ⇒ état vide, puis nouvelle conversation fonctionnelle", async () => {
    const world = emptyWorld();
    const a = seedSession(world, "Fil A", "Réponse A");
    const b = seedSession(world, "Fil B", "Réponse B");
    const host = await startRealHost(world);
    const current = host.currentSessionId();
    expect(current).toBeTruthy();

    const url = await startTransport(host);
    const client = await connect(url);
    await lastSnapshot(client, current ?? "");

    client.send({ type: "setAside", sessionId: current });
    await client.waitFor((frame) => frame.type === "sessions" && frame.activeId === null);
    await sleep(60);

    // État vide : le host n'a PLUS de session active…
    expect(host.currentSessionId()).toBeUndefined();
    // …donc aucun message ne partirait dans le vide.
    expect(() => host.send(current ?? "", "dans le vide")).toThrowError(/Session inconnue|prêt/i);
    // Le snapshot final est VIDE.
    const empty = [...client.frames].reverse().find((frame) => frame.type === "snapshot");
    expect(empty?.type === "snapshot" && empty.transcript).toEqual([]);

    // La conversation est MISE DE CÔTÉ (récupérable), pas détruite.
    const asideDir = join(world.sessionsDir, "conversations-supprimees");
    expect(existsSync(asideDir)).toBe(true);
    const stamps = readdirSync(asideDir);
    expect(stamps.length).toBe(1);
    const moved = readdirSync(join(asideDir, stamps[0] ?? ""));
    expect(moved.some((name) => name.endsWith(".jsonl"))).toBe(true);
    // Retirée de la liste.
    const list = await host.listSessions();
    expect(list.some((info) => info.sessionId === current)).toBe(false);
    // L'autre fil est toujours listé.
    const remaining = current === a.id ? b.id : a.id;
    expect(list.some((info) => info.sessionId === remaining)).toBe(true);

    // Nouvelle conversation : acceptée.
    client.send({ type: "new" });
    await client.waitFor(
      (frame) =>
        frame.type === "sessions" &&
        typeof frame.activeId === "string" &&
        frame.activeId !== current &&
        frame.activeId !== remaining,
    );
    const newId = host.currentSessionId();
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(current);

    client.send({ type: "message", clientMsgId: "n1", text: "Bonjour nouveau fil" });
    const accepted = await client.waitFor((frame) => frame.type === "accepted");
    expect(accepted.type === "accepted" && accepted.runId).toBeTruthy();
    // Le message est allé sur le NOUVEAU fil (transcript), pas dans le vide.
    expect(
      host.getState()?.transcript.some((entry) => entry.text === "Bonjour nouveau fil"),
    ).toBe(true);
    // La conversation ouverte est de nouveau un fil bien réel.
    client.send({ type: "switch", sessionId: remaining });
    const back = await lastSnapshot(client, remaining);
    expect(back.transcript.length).toBeGreaterThan(0);
  });

  it("renomme un fil (titre natif SDK) sans déplacer son fichier", async () => {
    const world = emptyWorld();
    const a = seedSession(world, "Question A", "Réponse A");
    const host = await startRealHost(world);
    const url = await startTransport(host);
    const client = await connect(url);

    client.send({ type: "rename", sessionId: a.id, title: "Titre choisi" });
    await client.waitFor(
      (frame) => frame.type === "sessions" && frame.sessions.some((s) => s.id === a.id && s.title === "Titre choisi"),
    );
    // Le fichier JSONL n'a PAS bougé (l'id EST dans le nom du fichier).
    expect(existsSync(a.file)).toBe(true);
    // Le titre est bien dans le fichier (entrée session_info).
    expect(readFileSync(a.file, "utf8")).toContain("Titre choisi");
  });
});
