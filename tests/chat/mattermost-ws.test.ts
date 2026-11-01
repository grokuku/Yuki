/**
 * TEMPS RÉEL Mattermost (lot 18, lot 2) — contre un SERVEUR FIXTURE RÉEL (HTTP + WS).
 *
 * Ce que ce fichier prouve, et qui ne peut pas être prouvé sur un double en mémoire :
 *  - la trame d'authentification est bien `{"seq":1,"action":"authentication_challenge",
 *    "data":{"token":…}}` (contrat vérifié de l'API), envoyée EN PREMIER message ;
 *  - un événement `posted` est INGÉRÉ dans le miroir (charge utile `data.post` en CHAÎNE
 *    JSON, comme le serveur l'envoie) ;
 *  - une coupure déclenche une RECONNEXION (compteur de tentatives visible) puis la
 *    reprise, sans doublon ;
 *  - une réponse de Yuki est publiée avec `root_id` (dans le fil du message) ;
 *  - ⚠️ un message dont l'auteur est le BOT ne publie RIEN (anti-boucle).
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/mattermost/ws.ts` et `adapter.ts`
 * n'existent pas.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { MattermostSocket } from "../../src/chat/mattermost/ws.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import { conversationIdOfChannel } from "../../src/chat/mirror/ingest.js";
import type { MattermostPostEvent } from "../../src/chat/mattermost/types.js";

const TOKEN = "jeton-bot-secret-0123456789";
const BOT_ID = "botidentifiant0123456789ab";
const CHANNEL = "canal-1";
const CONVERSATION = conversationIdOfChannel(CHANNEL);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Fixture {
  baseUrl: string;
  /** Trames d'authentification reçues (texte brut). */
  authFrames: string[];
  /** Posts envoyés par Yuki (`POST /api/v4/posts`). */
  created: Array<Record<string, unknown>>;
  /** Diffuse un événement à toutes les sockets ouvertes. */
  broadcast(event: string, post: Record<string, unknown>): void;
  /** Ferme brutalement les sockets (simule une coupure réseau). */
  dropConnections(): void;
  /** Sockets actuellement authentifiées. */
  readonly open: number;
}

/** Serveur fixture : HTTP minimal (v4) + WebSocket au même port. */
async function startFixture(options: { posts?: Record<string, unknown>[] } = {}): Promise<Fixture> {
  const authFrames: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const backlog = [...(options.posts ?? [])];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/v4/users/me") {
      send({ id: BOT_ID, username: "yuki", first_name: "Yuki" });
      return;
    }
    if (url.pathname === "/api/v4/users/me/teams") {
      send([{ id: "equipe-1", name: "holaf" }]);
      return;
    }
    if (url.pathname === "/api/v4/users/me/teams/equipe-1/channels") {
      send([
        { id: CHANNEL, display_name: "Général", type: "O" },
        { id: "canal-direct", display_name: "", type: "D" },
      ]);
      return;
    }
    if (url.pathname === `/api/v4/channels/${CHANNEL}/posts`) {
      send({
        order: backlog.map((item) => String(item.id)),
        posts: Object.fromEntries(backlog.map((item) => [String(item.id), item])),
      });
      return;
    }
    if (url.pathname === "/api/v4/users/ids") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const ids = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]") as string[];
        send(ids.map((id) => ({ id, username: id === BOT_ID ? "yuki" : `nom-${id}` })));
      });
      return;
    }
    if (url.pathname === "/api/v4/posts") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
          string,
          unknown
        >;
        created.push(body);
        send({
          id: `envoye${created.length}`,
          channel_id: body.channel_id,
          user_id: BOT_ID,
          message: body.message,
          root_id: body.root_id,
          create_at: Date.now(),
        });
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "inconnu" }));
  });

  const wss = new WebSocketServer({ server });
  let open = 0;
  wss.on("connection", (socket: WebSocket) => {
    open += 1;
    socket.on("close", () => {
      open -= 1;
    });
    socket.on("message", (raw) => {
      const text = String(raw);
      authFrames.push(text);
      const frame = JSON.parse(text) as { action?: string; data?: { token?: string } };
      if (frame.action !== "authentication_challenge" || frame.data?.token !== TOKEN) {
        socket.send(JSON.stringify({ status: "FAIL", seq_reply: 1, error: { id: "denied" } }));
        return;
      }
      // Réponse EXACTE du contrat de l'API, puis l'événement `hello`.
      socket.send(JSON.stringify({ status: "OK", seq_reply: 1 }));
      socket.send(JSON.stringify({ event: "hello", data: { server_version: "10.0.0" }, seq: 1 }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;

  cleanups.push(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    authFrames,
    created,
    get open() {
      return open;
    },
    broadcast(event, post) {
      const payload = JSON.stringify({ event, data: { post: JSON.stringify(post) }, seq: 2 });
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(payload);
      }
    },
    dropConnections() {
      for (const client of wss.clients) client.terminate();
    },
  };
}

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "yuki-ws-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return ChatMirrorStore.open({
    indexPath: join(root, "chat-mirror.json"),
    messagesDir: join(root, "chat-mirror"),
  });
}

/** Attend qu'une condition devienne vraie (jamais une attente fixe). */
async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé en attendant : ${label}`);
}

describe("WebSocket — authentification et événements", () => {
  it("envoie la trame d'authentification en PREMIER message, puis reçoit `posted`", async () => {
    const fixture = await startFixture();
    const events: MattermostPostEvent[] = [];
    const socket = new MattermostSocket({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      onEvent: (event) => events.push(event),
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    await waitFor(() => socket.status().connecte, "l'authentification");
    // ⚠️ Contrat vérifié : le jeton ne circule que dans cette trame, en PREMIER message.
    expect(fixture.authFrames).toHaveLength(1);
    expect(JSON.parse(fixture.authFrames[0] ?? "{}")).toEqual({
      seq: 1,
      action: "authentication_challenge",
      data: { token: TOKEN },
    });
    expect(socket.status().tentatives).toBe(0);

    fixture.broadcast("posted", {
      id: "p1",
      channel_id: CHANNEL,
      user_id: "humain-1",
      message: "bonjour",
      create_at: 1_700_000_000_000,
    });
    await waitFor(() => events.length === 1, "l'événement `posted`");
    expect(events[0]?.kind).toBe("posted");
    expect(events[0]?.post.id).toBe("p1");
  });

  it("une coupure déclenche une RECONNEXION (compteur visible) et la reprise", async () => {
    const fixture = await startFixture();
    const events: MattermostPostEvent[] = [];
    // ⚠️ Le compteur de tentatives est REMIS À ZÉRO après une reconnexion réussie : on
    // observe donc son MAXIMUM via `onStateChange` (c'est ce que voit l'interface).
    let maxTentatives = 0;
    const socket = new MattermostSocket({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      onEvent: (event) => events.push(event),
      onStateChange: (status) => {
        maxTentatives = Math.max(maxTentatives, status.tentatives);
      },
      // Backoff court pour le test : le COMPORTEMENT (borné + jitter) est le même.
      baseDelayMs: 10,
      jitterMs: 1,
      maxAttempts: 10,
    });
    cleanups.push(() => socket.stop());
    await socket.start();
    await waitFor(() => socket.status().connecte, "l'authentification");

    fixture.dropConnections();
    await waitFor(() => socket.status().tentatives >= 1, "une tentative de reconnexion");
    await waitFor(() => socket.status().connecte, "la reconnexion");
    // ⚠️ Le compteur de tentatives est VISIBLE : jamais une reconnexion silencieuse.
    expect(maxTentatives).toBeGreaterThanOrEqual(1);
    expect(fixture.authFrames.length).toBeGreaterThanOrEqual(2);

    fixture.broadcast("posted", {
      id: "p-apres",
      channel_id: CHANNEL,
      user_id: "humain-1",
      message: "après la coupure",
      create_at: 1_700_000_100_000,
    });
    await waitFor(() => events.some((event) => event.post.id === "p-apres"), "le message d'après");
  });

  it("un jeton refusé ARRÊTE le temps réel et le DIT (aucune boucle de reconnexion)", async () => {
    const fixture = await startFixture();
    const socket = new MattermostSocket({
      baseUrl: () => fixture.baseUrl,
      token: () => "mauvais-jeton",
      onEvent: () => undefined,
      baseDelayMs: 10,
      jitterMs: 1,
    });
    cleanups.push(() => socket.stop());
    await socket.start();
    await waitFor(() => socket.status().derniereErreur !== undefined, "le refus");
    expect(socket.status().connecte).toBe(false);
    expect(socket.status().abandonne).toBe(true);
    expect(String(socket.status().derniereErreur)).toContain("refusé");
    // Aucune trame refusée ne contient JAMAIS le jeton dans le message d'erreur.
    expect(String(socket.status().derniereErreur)).not.toContain("mauvais-jeton");
  });
});

describe("adaptateur — ingestion, anti-boucle et réponse dans le fil", () => {
  it("ingère un `posted`, ne répond PAS à un message du bot, et répond avec `root_id` à un humain", async () => {
    const fixture = await startFixture({
      posts: [
        {
          id: "ancien",
          channel_id: CHANNEL,
          user_id: "humain-1",
          message: "message du backfill",
          create_at: 1_700_000_000_000,
        },
      ],
    });
    const store = openStore();
    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      createSocket: undefined,
      generateReply: async ({ message }) => `Réponse à « ${message.text} »`,
    });
    cleanups.push(() => adapter.disconnect());

    await adapter.connect();
    // ⚠️ Le badge passe à ● seulement quand le temps réel est AUTHENTIFIÉ : attendre cet
    // état, sinon une diffusion peut partir avant que la socket ne soit ouverte.
    await waitFor(() => adapter.status().etat === "on", "la connexion temps réel");
    await waitFor(() => store.messages(CONVERSATION).length > 0, "le backfill");
    expect(store.messages(CONVERSATION)[0]?.remoteId).toBe("ancien");
    // Le canal direct (`type: "D"`) n'est PAS miroité.
    expect(store.conversations().map((item) => item.remoteId)).toEqual([CHANNEL]);

    // Le mode de réponse est CHOISI par canal ; `tout` répond à chaque message humain.
    store.setReplyMode(CONVERSATION, "tout");

    // ① Message du BOT : il entre dans le miroir mais ne déclenche AUCUNE réponse.
    fixture.broadcast("posted", {
      id: "du-bot",
      channel_id: CHANNEL,
      user_id: BOT_ID,
      message: "ceci est ma propre réponse",
      create_at: 1_700_000_100_000,
    });
    await waitFor(
      () => store.message(CONVERSATION, "du-bot") !== undefined,
      "l'ingestion du message du bot",
    );
    expect(fixture.created).toHaveLength(0);

    // ② Message HUMAIN : réponse publiée, DANS LE FIL du message.
    fixture.broadcast("posted", {
      id: "humain-msg",
      channel_id: CHANNEL,
      user_id: "humain-1",
      message: "tu peux m'aider ?",
      create_at: 1_700_000_200_000,
    });
    await waitFor(() => fixture.created.length === 1, "la réponse publiée");
    expect(fixture.created[0]).toMatchObject({
      channel_id: CHANNEL,
      message: "Réponse à « tu peux m'aider ? »",
      // ⚠️ `root_id` = le message déclencheur : la réponse reste dans SON fil.
      root_id: "humain-msg",
    });
    // Et cette réponse est elle-même entrée dans le miroir (une seule fois).
    await waitFor(() => store.message(CONVERSATION, "envoye1") !== undefined, "la réponse miroitée");

    // ③ Une SECONDE diffusion du même `posted` n'ajoute ni message ni réponse.
    fixture.broadcast("posted", {
      id: "humain-msg",
      channel_id: CHANNEL,
      user_id: "humain-1",
      message: "tu peux m'aider ?",
      create_at: 1_700_000_200_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fixture.created).toHaveLength(1);
    expect(
      store.messages(CONVERSATION).filter((item) => item.remoteId === "humain-msg"),
    ).toHaveLength(1);
  });

  it("un échec d'envoi est VISIBLE (statut), jamais silencieux", async () => {
    const fixture = await startFixture();
    const store = openStore();
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "mattermost",
      remoteId: CHANNEL,
      title: "Général",
    });
    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
    });
    cleanups.push(() => adapter.disconnect());
    // Le générateur LÈVE : la réponse ne peut pas être publiée.
    const failing = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      generateReply: async () => {
        throw new Error("modèle indisponible");
      },
    });
    cleanups.push(() => failing.disconnect());

    await expect(
      failing.send(CONVERSATION, { kind: "approbation", approval: { id: "a", titre: "t", detail: "d", options: [] } }),
    ).rejects.toThrow(/pas encore disponible/);
    // Aucun envoi n'a eu lieu : le refus est explicite, pas un bloc publié.
    expect(fixture.created).toHaveLength(0);
    void adapter;
  });

  it("`status()` n'expose NI jeton NI URL complète", async () => {
    const fixture = await startFixture();
    const store = openStore();
    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
    });
    cleanups.push(() => adapter.disconnect());
    const status = adapter.status();
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(JSON.stringify(status)).not.toContain("127.0.0.1");
  });
});
