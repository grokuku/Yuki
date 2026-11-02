/**
 * CORRESPONDANCE ID → NOM D'UTILISATEUR (correction du défaut de production du
 * 2026-11-02 : un auteur s'affichait `g68pqnp8pykm89pj3eqn1khhe` dans un canal).
 *
 * Ce que ce fichier prouve, contre un VRAI serveur fixture (HTTP + WS) :
 *  - un message TEMPS RÉEL dont l'auteur n'est pas encore connu est ingéré avec son
 *    NOM, résolu en UN appel groupé `POST /api/v4/users/ids` ;
 *  - le second message du même auteur ne produit AUCUN appel réseau (annuaire) ;
 *  - un miroir DÉJÀ écrit avec l'identifiant nu affiche le nom (annuaire consulté à la
 *    LECTURE, sans réécrire le `.jsonl`) ;
 *  - un auteur introuvable (utilisateur supprimé) ne casse rien et s'affiche sous une
 *    forme COURTE et lisible, jamais comme 26 caractères bruts ;
 *  - Discord : `global_name` puis `username` sont bien lus ;
 *  - `estBot` lit `is_bot` de l'API (défaut D2 de l'audit : un autre robot passait pour
 *    un humain et pouvait déclencher une réponse).
 *
 * ⚠️ Échoue sur le code d'origine : `onSocketEvent` n'avait aucune table d'utilisateurs,
 * `authorOf` ignorait `is_bot`, et rien ne consultait de nom à la lecture.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import {
  conversationIdOfChannel,
  discordMessageToRemoteMessage,
  postToRemoteMessage,
} from "../../src/chat/mirror/ingest.js";
import { auteurAffichable, formeCourteAuteur } from "../../src/chat/mirror/names.js";
import { remoteMessageToTranscript } from "../../src/chat/mirror.js";
import { decideReply } from "../../src/chat/reply/responder.js";
import type { RemoteMessage } from "../../src/chat/types.js";

const TOKEN = "jeton-bot-secret-0123456789";
const BOT_ID = "botidentifiant0123456789ab";
const CHANNEL = "canal-1";
const CONVERSATION = conversationIdOfChannel(CHANNEL);
const HUMAIN = "g68pqnp8pykm89pj3eqn1khhe";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Fixture {
  baseUrl: string;
  /** Identifiants reçus par `POST /api/v4/users/ids`, requête par requête. */
  demandes: string[][];
  broadcast(event: string, post: Record<string, unknown>): void;
}

/**
 * Serveur fixture. `utilisateurs` = ce que le serveur CONNAÎT : un identifiant absent
 * simule un utilisateur supprimé (l'API rend alors un tableau plus court, sans erreur).
 */
async function startFixture(
  options: { utilisateurs?: Record<string, Record<string, unknown>> } = {},
): Promise<Fixture> {
  const utilisateurs: Record<string, Record<string, unknown>> = options.utilisateurs ?? {
    [BOT_ID]: { id: BOT_ID, username: "yuki", first_name: "Yuki" },
    [HUMAIN]: { id: HUMAIN, username: "camille", nickname: "Camille D." },
  };
  const demandes: string[][] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/v4/users/me") {
      send(utilisateurs[BOT_ID]);
      return;
    }
    if (url.pathname === "/api/v4/users/me/teams") {
      send([{ id: "equipe-1", name: "holaf" }]);
      return;
    }
    if (url.pathname === "/api/v4/users/me/teams/equipe-1/channels") {
      send([{ id: CHANNEL, display_name: "Général", type: "O" }]);
      return;
    }
    if (url.pathname === `/api/v4/channels/${CHANNEL}/posts`) {
      send({ order: [], posts: {} });
      return;
    }
    if (url.pathname === "/api/v4/users/ids") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const ids = JSON.parse(Buffer.concat(chunks).toString("utf8") || "[]") as string[];
        demandes.push(ids);
        // ⚠️ Un identifiant inconnu n'est PAS une erreur : il est simplement absent.
        send(ids.map((id) => utilisateurs[id]).filter((user) => user !== undefined));
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
        send({
          id: `envoye-${body.message ?? ""}`,
          channel_id: body.channel_id,
          user_id: BOT_ID,
          message: body.message,
          create_at: Date.now(),
        });
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "inconnu" }));
  });

  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { action?: string; data?: { token?: string } };
      if (frame.action !== "authentication_challenge" || frame.data?.token !== TOKEN) {
        socket.send(JSON.stringify({ status: "FAIL", seq_reply: 1, error: { id: "denied" } }));
        return;
      }
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
    demandes,
    broadcast(event, post) {
      const payload = JSON.stringify({ event, data: { post: JSON.stringify(post) }, seq: 2 });
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) client.send(payload);
      }
    },
  };
}

function openStore(root = mkdtempSync(join(tmpdir(), "yuki-noms-")), index = 0) {
  if (index === 0) cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return ChatMirrorStore.open({
    indexPath: join(root, "chat-mirror.json"),
    messagesDir: join(root, "chat-mirror"),
  });
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé en attendant : ${label}`);
}

async function connecter(fixture: Fixture, store: ChatMirrorStore): Promise<MattermostChatAdapter> {
  const adapter = new MattermostChatAdapter({
    baseUrl: () => fixture.baseUrl,
    token: () => TOKEN,
    store,
    pollIntervalMs: 0,
  });
  cleanups.push(() => adapter.disconnect());
  await adapter.connect();
  await waitFor(() => adapter.status().etat === "on", "la connexion temps réel");
  return adapter;
}

describe("ingestion — résolution du nom de l'auteur", () => {
  it("un message temps réel d'un auteur inconnu est ingéré AVEC son nom (appel groupé)", async () => {
    const fixture = await startFixture();
    const store = openStore();
    await connecter(fixture, store);

    fixture.broadcast("posted", {
      id: "m1",
      channel_id: CHANNEL,
      user_id: HUMAIN,
      message: "bonjour",
      create_at: 1_700_000_000_000,
    });
    await waitFor(() => store.message(CONVERSATION, "m1") !== undefined, "l'ingestion");
    const message = store.message(CONVERSATION, "m1");
    expect(message?.author.id).toBe(HUMAIN);
    // ⚠️ Le nom, PAS l'identifiant : c'est le défaut de production corrigé.
    expect(message?.author.nom).toBe("camille");
    expect(fixture.demandes).toHaveLength(1);
    expect(fixture.demandes[0]).toEqual([HUMAIN]);
  });

  it("second message du MÊME auteur : aucun appel réseau supplémentaire", async () => {
    const fixture = await startFixture();
    const store = openStore();
    await connecter(fixture, store);

    fixture.broadcast("posted", {
      id: "m1",
      channel_id: CHANNEL,
      user_id: HUMAIN,
      message: "bonjour",
      create_at: 1_700_000_000_000,
    });
    await waitFor(() => store.message(CONVERSATION, "m1") !== undefined, "l'ingestion m1");

    fixture.broadcast("posted", {
      id: "m2",
      channel_id: CHANNEL,
      user_id: HUMAIN,
      message: "encore moi",
      create_at: 1_700_000_060_000,
    });
    await waitFor(() => store.message(CONVERSATION, "m2") !== undefined, "l'ingestion m2");

    expect(store.message(CONVERSATION, "m2")?.author.nom).toBe("camille");
    // Une SEULE requête de résolution pour deux messages.
    expect(fixture.demandes).toHaveLength(1);
  });

  it("auteur SUPPRIMÉ : repli lisible, aucun crash, aucune réponse", async () => {
    const fixture = await startFixture();
    const store = openStore();
    await connecter(fixture, store);

    const supprime = "supprime0000000000000000";
    fixture.broadcast("posted", {
      id: "m-supprime",
      channel_id: CHANNEL,
      user_id: supprime,
      message: "je ne suis plus là",
      create_at: 1_700_000_000_000,
    });
    await waitFor(
      () => store.message(CONVERSATION, "m-supprime") !== undefined,
      "l'ingestion du message orphelin",
    );

    const message = store.message(CONVERSATION, "m-supprime");
    expect(message).toBeDefined();
    // Le nom reste l'identifiant (marqueur d'échec) mais l'AFFICHAGE est court et explicite.
    const entry = remoteMessageToTranscript(message as RemoteMessage);
    expect(entry.author?.nom).toBe("membre inconnu (suppri…)");
    expect(entry.author?.nom).not.toBe(supprime);
  });
});

describe("miroir déjà écrit — le nom est appliqué à la LECTURE", () => {
  it("une entrée ancienne sans nom s'affiche avec le nom appris ensuite", () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-noms-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    // ① Miroir « ancien » : l'entrée porte l'IDENTIFIANT dans `nom`.
    const ancien = openStore(root, 0);
    ancien.ensureConversation({
      conversationId: CONVERSATION,
      platform: "mattermost",
      remoteId: CHANNEL,
      title: "Général",
    });
    ancien.upsert({
      remoteId: "vieux",
      conversationId: CONVERSATION,
      author: { id: HUMAIN, nom: HUMAIN, estBot: false },
      role: "user",
      text: "message d'avant la correction",
      sentAt: "2026-11-01T10:00:00.000Z",
    });
    expect(remoteMessageToTranscript(ancien.message(CONVERSATION, "vieux")!)).toMatchObject({
      author: { nom: "membre inconnu (g68pqn…)" },
    });

    // ② Nouveau démarrage : le fichier est relu tel quel (append-only, jamais réécrit).
    const nouveau = openStore(root, 1);
    expect(nouveau.message(CONVERSATION, "vieux")?.author.nom).toBe(HUMAIN);

    // ③ L'annuaire apprend le nom : la LECTURE le restitue, sans toucher au `.jsonl`.
    expect(nouveau.rememberAuthorNames(CONVERSATION, [[HUMAIN, "camille"]])).toBe(1);
    const message = nouveau.message(CONVERSATION, "vieux");
    expect(message?.author.nom).toBe("camille");
    expect(nouveau.messages(CONVERSATION)[0]?.author.nom).toBe("camille");
    expect(remoteMessageToTranscript(message!).author?.nom).toBe("camille");

    // ④ Le nom est PERSISTÉ : un troisième démarrage le connaît déjà.
    const troisieme = openStore(root, 1);
    expect(troisieme.authorName(CONVERSATION, HUMAIN)).toBe("camille");
    expect(troisieme.message(CONVERSATION, "vieux")?.author.nom).toBe("camille");
  });

  it("l'annuaire ne redemande jamais un identifiant déjà connu", () => {
    const store = openStore();
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "mattermost",
      remoteId: CHANNEL,
      title: "Général",
    });
    store.upsert({
      remoteId: "m1",
      conversationId: CONVERSATION,
      author: { id: HUMAIN, nom: HUMAIN, estBot: false },
      role: "user",
      text: "bonjour",
      sentAt: "2026-11-01T10:00:00.000Z",
    });
    expect(store.authorIdsWithoutName(CONVERSATION)).toEqual([HUMAIN]);
    store.rememberAuthorNames(CONVERSATION, [[HUMAIN, "camille"]]);
    expect(store.authorIdsWithoutName(CONVERSATION)).toEqual([]);
  });
});

describe("Discord — les noms fournis par la charge utile sont lus", () => {
  it("`global_name` d'abord, puis `username`", () => {
    const base = {
      id: "42",
      channel_id: "salon-1",
      timestamp: "2026-11-01T10:00:00.000Z",
      content: "salut",
    };
    const avecGlobal = discordMessageToRemoteMessage(
      { ...base, author: { id: "h-1", username: "camille", global_name: "Camille D." } },
      { conversationId: "dc-salon-1" },
    );
    expect(avecGlobal.author.nom).toBe("Camille D.");

    const sansGlobal = discordMessageToRemoteMessage(
      { ...base, author: { id: "h-1", username: "camille", global_name: null } },
      { conversationId: "dc-salon-1" },
    );
    expect(sansGlobal.author.nom).toBe("camille");
  });

  it("un autre ROBOT est `estBot` (et ne déclenche aucune réponse)", async () => {
    const message = discordMessageToRemoteMessage(
      {
        id: "9",
        channel_id: "salon-1",
        timestamp: "2026-11-01T10:00:00.000Z",
        content: "je suis un robot",
        author: { id: "robot-1", username: "autre-bot", bot: true },
      },
      { conversationId: "dc-salon-1" },
    );
    expect(message.author.estBot).toBe(true);
    const decision = await decideReply({
      message,
      replyMode: "tout",
      botUserId: BOT_ID,
      aliases: [],
      channelTitle: "Général",
    });
    expect(decision.repondre).toBe(false);
  });
});

describe("Mattermost — `is_bot` est lu (défaut D2)", () => {
  it("un compte bot de l'API devient `estBot` et ne déclenche aucune réponse", async () => {
    const autreRobot = "robotcompte00000000000000";
    const message = postToRemoteMessage(
      {
        id: "p-bot",
        channel_id: CHANNEL,
        user_id: autreRobot,
        message: "rapport automatique",
        create_at: 1_700_000_000_000,
      },
      {
        platform: "mattermost",
        conversationId: CONVERSATION,
        botUserId: BOT_ID,
        users: new Map([
          [autreRobot, { id: autreRobot, username: "robot-ci", is_bot: true }],
        ]),
      },
    );
    expect(message.author.nom).toBe("robot-ci");
    expect(message.author.estBot).toBe(true);
    const decision = await decideReply({
      message,
      replyMode: "tout",
      botUserId: BOT_ID,
      aliases: [],
      channelTitle: "Général",
    });
    expect(decision.repondre).toBe(false);
  });
});

describe("repli d'affichage", () => {
  it("forme courte : jamais 26 caractères bruts", () => {
    expect(formeCourteAuteur(HUMAIN)).toBe("membre inconnu (g68pqn…)");
    expect(formeCourteAuteur("")).toBe("membre inconnu");
    expect(formeCourteAuteur("inconnu")).toBe("membre inconnu");
    expect(auteurAffichable({ id: HUMAIN, nom: "camille" })).toBe("camille");
    expect(auteurAffichable({ id: HUMAIN, nom: HUMAIN })).toBe("membre inconnu (g68pqn…)");
    expect(auteurAffichable({ id: HUMAIN, nom: "  " })).toBe("membre inconnu (g68pqn…)");
  });
});
