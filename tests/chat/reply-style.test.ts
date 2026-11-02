/**
 * COMMENT répondre dans un canal distant — `replyStyle` (fil / nouveau) et
 * `quoteAuthor` (citer l'auteur ou non), réglés PAR CANAL.
 *
 * Ce que ce fichier prouve, et qui ne peut pas être prouvé sur un simple double :
 *  - un `chat-mirror.json` EXISTANT, écrit avant l'ajout de ces clés, s'ouvre sans
 *    erreur : les défauts s'appliquent à la LECTURE (`fil`, `non`) et le fichier n'est
 *    PAS réécrit ;
 *  - `root_id` d'une réponse = la RACINE du fil (jamais le message lui-même, sinon
 *    Mattermost crée un fil imbriqué) ; en `nouveau`, il est ABSENT ;
 *  - `quoteAuthor = oui` pose une MENTION NATIVE de l'auteur (`@pseudo` chez Mattermost,
 *    `<@identifiant>` chez Discord) et NE RECOPIE PAS le texte du message d'origine ;
 *    le préfixe est BORNÉ, et jamais une mention de masse ni une mention de robot ;
 *  - les QUATRE combinaisons (fil/nouveau × citer/non) aboutissent au bon `POST /posts`
 *    contre un SERVEUR FIXTURE RÉEL.
 *
 * ⚠️ Échoue sur le code d'origine : ni `rootIdForReply`/`composeReply`/`mentionOfAuthor`, ni
 * `replyStyle`/`quoteAuthor` n'existent ; le `root_id` était toujours calculé de la même
 * façon (`threadRootId ?? remoteId`), et un éventuel préfixe citait le TEXTE du message.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import {
  RAPPORT_SYSTEME_AUTHOR_ID,
  RAPPORT_SYSTEME_AUTHOR_NAME,
} from "../../src/chat/reply/job-report.js";
import { ChatMirrorStore, effectiveQuoteAuthor, effectiveReplyStyle } from "../../src/chat/mirror/store.js";
import { conversationIdOfChannel } from "../../src/chat/mirror/ingest.js";
import {
  REPLY_MENTION_MAX_CHARS,
  composeReply,
  mentionOfAuthor,
  rootIdForReply,
} from "../../src/chat/reply/responder.js";
import type { RemoteMessage } from "../../src/chat/types.js";

const TOKEN = "jeton-bot-secret-0123456789";
const BOT_ID = "botidentifiant0123456789ab";
const CHANNEL = "canal-1";
const CONVERSATION = conversationIdOfChannel(CHANNEL);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "yuki-reply-style-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return { root, store: ChatMirrorStore.open({
    indexPath: join(root, "chat-mirror.json"),
    messagesDir: join(root, "chat-mirror"),
  }) };
}

/** Message distant minimal (ce que la décision lit). */
function messageOf(extra: Partial<RemoteMessage> = {}): RemoteMessage {
  return {
    remoteId: "m1",
    conversationId: CONVERSATION,
    author: { id: "humain-1", nom: "Camille", estBot: false },
    role: "user",
    text: "peux-tu regarder ça ?",
    sentAt: "2026-11-01T10:00:00.000Z",
    ...extra,
  };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé en attendant : ${label}`);
}

// ─── A1 — miroir existant : défauts à la lecture, jamais cassé ──────────────

describe("réglages par canal — compatibilité d'un miroir EXISTANT", () => {
  it("un `chat-mirror.json` sans `replyStyle`/`quoteAuthor` s'ouvre avec les DÉFAUTS, sans être réécrit", () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-reply-legacy-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const indexPath = join(root, "chat-mirror.json");
    // Exactement ce qu'écrivait la version PRÉCÉDENTE : aucune clé de style.
    const legacy = {
      schemaVersion: 1,
      settings: { baseUrl: "https://mattermost.exemple.fr" },
      conversations: {
        [CONVERSATION]: {
          platform: "mattermost",
          remoteId: CHANNEL,
          title: "Général",
          messageCount: 0,
          backfillDone: true,
          replyMode: "tout",
        },
      },
    };
    writeFileSync(indexPath, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
    const avant = readFileSync(indexPath, "utf8");

    const store = ChatMirrorStore.open({ indexPath, messagesDir: join(root, "chat-mirror") });
    // ⚠️ Défauts appliqués À LA LECTURE : comportement historique inchangé.
    expect(effectiveReplyStyle(store.record(CONVERSATION))).toBe("fil");
    expect(effectiveQuoteAuthor(store.record(CONVERSATION))).toBe("non");
    const vue = store.conversations();
    expect(vue[0]?.replyStyle).toBe("fil");
    expect(vue[0]?.quoteAuthor).toBe("non");
    expect(vue[0]?.replyMode).toBe("tout");
    // ⚠️ Le fichier n'a PAS été réécrit : aucune montée de version destructrice.
    expect(readFileSync(indexPath, "utf8")).toBe(avant);
  });

  it("une valeur INCONNUE est ignorée (défaut), jamais devinée", () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-reply-invalid-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const indexPath = join(root, "chat-mirror.json");
    writeFileSync(
      indexPath,
      JSON.stringify({
        schemaVersion: 1,
        settings: {},
        conversations: {
          [CONVERSATION]: {
            platform: "mattermost",
            remoteId: CHANNEL,
            title: "Général",
            messageCount: 0,
            backfillDone: true,
            replyStyle: "imbrique",
            quoteAuthor: "peut-etre",
          },
        },
      }),
      { mode: 0o600 },
    );
    const store = ChatMirrorStore.open({ indexPath, messagesDir: join(root, "chat-mirror") });
    expect(store.record(CONVERSATION)).not.toHaveProperty("replyStyle");
    expect(effectiveReplyStyle(store.record(CONVERSATION))).toBe("fil");
    expect(effectiveQuoteAuthor(store.record(CONVERSATION))).toBe("non");
  });

  it("persiste les réglages, canal par canal, et les relit au redémarrage", () => {
    const { root, store } = openStore();
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "mattermost",
      remoteId: CHANNEL,
      title: "Général",
    });
    expect(store.setReplySettings(CONVERSATION, { replyStyle: "nouveau", quoteAuthor: "oui" })).toBe(true);
    expect(store.setReplySettings("mm-inconnu", { replyStyle: "fil" })).toBe(false);

    const relu = ChatMirrorStore.open({
      indexPath: join(root, "chat-mirror.json"),
      messagesDir: join(root, "chat-mirror"),
    });
    expect(relu.record(CONVERSATION)?.replyStyle).toBe("nouveau");
    expect(relu.record(CONVERSATION)?.quoteAuthor).toBe("oui");

    // `null` = revenir au DÉFAUT (la clé disparaît de l'index).
    expect(relu.setReplySettings(CONVERSATION, { replyStyle: null, quoteAuthor: null })).toBe(true);
    expect(relu.record(CONVERSATION)).not.toHaveProperty("replyStyle");
    expect(relu.record(CONVERSATION)).not.toHaveProperty("quoteAuthor");
    expect(relu.conversations()[0]?.replyStyle).toBe("fil");
  });
});

// ─── A2 — racine du fil et citation ─────────────────────────────────────────

describe("fil ou nouveau message — la RACINE, jamais le message lui-même", () => {
  it("`fil` sur un message RACINE ouvre un fil SOUS lui", () => {
    expect(rootIdForReply({ replyStyle: "fil", message: messageOf() })).toBe("m1");
  });

  it("`fil` sur une RÉPONSE de fil repart de la RACINE (pas un fil imbriqué)", () => {
    expect(
      rootIdForReply({ replyStyle: "fil", message: messageOf({ threadRootId: "racine" }) }),
    ).toBe("racine");
  });

  it("`nouveau` n'envoie AUCUN `root_id`, même sur une réponse de fil", () => {
    expect(rootIdForReply({ replyStyle: "nouveau", message: messageOf() })).toBeUndefined();
    expect(
      rootIdForReply({ replyStyle: "nouveau", message: messageOf({ threadRootId: "racine" }) }),
    ).toBeUndefined();
  });
});

describe("mention de l'auteur — native, courte et sûre", () => {
  /** Message Discord minimal (identifiant « snowflake » réel). */
  function messageDiscord(extra: Partial<RemoteMessage> = {}): RemoteMessage {
    return messageOf({
      conversationId: "dc-323456789012345678",
      author: { id: "723456789012345678", nom: "humain", estBot: false },
      ...extra,
    });
  }

  it("`non` rend le texte EXACTEMENT inchangé (comportement de production)", () => {
    expect(composeReply({ text: "  bonjour  ", message: messageOf(), quoteAuthor: "non" })).toEqual(
      { text: "  bonjour  ", mentionUserIds: [] },
    );
  });

  it("`oui` pose une mention NATIVE et NE RECOPIE PAS le texte d'origine", () => {
    const compose = composeReply({
      text: "Oui, je regarde.",
      message: messageOf({ text: "tu peux jeter un œil ?" }),
      quoteAuthor: "oui",
    });
    // ⚠️ La demande : l'auteur est TAGUÉ, le message d'origine n'est PAS cité.
    expect(compose.text).toBe("@camille\n\nOui, je regarde.");
    expect(compose.text).not.toContain("tu peux jeter un œil");
    expect(compose.text).not.toContain("a écrit");
    // Plus aucun bloc de citation Markdown.
    expect(compose.text).not.toContain(">");
    // Mattermost n'a rien à autoriser : la mention est dans le texte du post.
    expect(compose.mentionUserIds).toEqual([]);
  });

  it("Discord : `<@identifiant>` ET autorisation explicite de CETTE personne", () => {
    const compose = composeReply({
      text: "Oui, je regarde.",
      message: messageDiscord({ text: "tu peux jeter un œil ?" }),
      quoteAuthor: "oui",
    });
    expect(compose.text).toBe("<@723456789012345678>\n\nOui, je regarde.");
    // ⚠️ Sans cette liste, le client Discord neutralise la mention : `<@id>` s'affiche
    // sans que personne ne soit notifié (`allowed_mentions: { parse: [] }`).
    expect(compose.mentionUserIds).toEqual(["723456789012345678"]);
    expect(compose.text).not.toContain("tu peux jeter un œil");
  });

  it("ne mentionne JAMAIS un robot, ni Yuki elle-même", () => {
    const robot = messageOf({ author: { id: "humain-1", nom: "camille", estBot: true } });
    expect(composeReply({ text: "ok", message: robot, quoteAuthor: "oui" })).toEqual({
      text: "ok",
      mentionUserIds: [],
    });
    // Le second filet : l'identifiant du bot, même quand `estBot` n'a pas été posé.
    expect(
      mentionOfAuthor({
        author: { id: "botidentifiant0123456789ab", nom: "yuki", estBot: false },
        platform: "mattermost",
        botUserId: "botidentifiant0123456789ab",
      }),
    ).toBeUndefined();
  });

  it("le préfixe reste BORNÉ : une mention, jamais un pavé", () => {
    const long = Array.from({ length: 40 }, (_, i) => `ligne ${i} ${"x".repeat(120)}`).join("\n");
    const compose = composeReply({
      text: "Voilà.",
      message: messageOf({ text: long }),
      quoteAuthor: "oui",
    });
    const [prefixe = ""] = compose.text.split("\n");
    expect(prefixe.length).toBeGreaterThan(0);
    expect(prefixe.length).toBeLessThanOrEqual(REPLY_MENTION_MAX_CHARS);
    // ⚠️ Le texte d'origine n'est pas repris DU TOUT (l'ancienne citation en reprenait 240).
    expect(compose.text).not.toContain("ligne 0");
    expect(compose.text.length).toBeLessThan(REPLY_MENTION_MAX_CHARS + 40);
  });

  it("un pseudo de MASSE (`channel`, `all`, `here`) ne produit AUCUNE mention", () => {
    for (const nom of ["channel", "all", "here", "CHANNEL"]) {
      expect(
        mentionOfAuthor({ author: { id: "humain-1", nom, estBot: false }, platform: "mattermost" }),
      ).toBeUndefined();
      expect(composeReply({ text: "ok", message: messageOf({ author: { id: "humain-1", nom, estBot: false } }), quoteAuthor: "oui" })).toEqual({
        text: "ok",
        mentionUserIds: [],
      });
    }
  });

  it("un nom qui n'est pas un pseudo exploitable ne produit AUCUNE mention", () => {
    // Surnom avec espaces, forme courte d'un auteur non résolu, identifiant non numérique
    // chez Discord : aucune de ces formes ne notifierait quelqu'un.
    for (const nom of ["Jean Dupont", "membre inconnu (g68pqn…)", "camille!", ""]) {
      expect(
        mentionOfAuthor({ author: { id: "humain-1", nom, estBot: false }, platform: "mattermost" }),
      ).toBeUndefined();
    }
    expect(
      mentionOfAuthor({ author: { id: "inconnu", nom: "humain", estBot: false }, platform: "discord" }),
    ).toBeUndefined();
  });

  it("assainit le pseudo : aucun caractère Markdown ne casse la mention", () => {
    const mention = mentionOfAuthor({
      author: { id: "humain-1", nom: "**@channel**", estBot: false },
      platform: "mattermost",
    });
    expect(mention).toBeUndefined();
    // Un pseudo conforme est rendu en MINUSCULES (règle serveur) et sans ornement.
    expect(
      mentionOfAuthor({ author: { id: "humain-1", nom: "Camille.Dev", estBot: false }, platform: "mattermost" }),
    ).toEqual({ mention: "@camille.dev", userIds: [] });
  });

  it("un rapport SYSTÈME n'est mentionné par personne", () => {
    // ⚠️ L'auteur d'un rapport de tâche n'est pas une personne (robot + nom avec espaces) :
    // le mentionner créerait une notification sans destinataire.
    const rapport = messageOf({
      conversationId: "mm-canal-1",
      author: {
        id: RAPPORT_SYSTEME_AUTHOR_ID,
        nom: RAPPORT_SYSTEME_AUTHOR_NAME,
        estBot: true,
      },
    });
    expect(composeReply({ text: "ok", message: rapport, quoteAuthor: "oui" })).toEqual({
      text: "ok",
      mentionUserIds: [],
    });
  });
});

// ─── A2 — les QUATRE combinaisons, contre un serveur fixture RÉEL ───────────

interface Fixture {
  baseUrl: string;
  created: Array<Record<string, unknown>>;
}

async function startFixture(): Promise<Fixture> {
  const created: Array<Record<string, unknown>> = [];
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
  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as { action?: string; data?: { token?: string } };
      if (frame.action !== "authentication_challenge" || frame.data?.token !== TOKEN) {
        socket.send(JSON.stringify({ status: "FAIL", seq_reply: 1, error: { id: "denied" } }));
        return;
      }
      socket.send(JSON.stringify({ status: "OK", seq_reply: 1 }));
      socket.send(JSON.stringify({ event: "hello", data: {}, seq: 1 }));
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
  return { baseUrl: `http://127.0.0.1:${address.port}`, created };
}

describe("adaptateur — les QUATRE combinaisons de réglages", () => {
  const cas: Array<{
    style: "fil" | "nouveau";
    quote: "oui" | "non";
    rootId?: string;
    prefixe: boolean;
  }> = [
    { style: "fil", quote: "non", rootId: "racine-du-fil", prefixe: false },
    { style: "fil", quote: "oui", rootId: "racine-du-fil", prefixe: true },
    { style: "nouveau", quote: "non", prefixe: false },
    { style: "nouveau", quote: "oui", prefixe: true },
  ];

  for (const attendu of cas) {
    it(`replyStyle=${attendu.style} + quoteAuthor=${attendu.quote}`, async () => {
      const fixture = await startFixture();
      const { store } = openStore();
      store.ensureConversation({
        conversationId: CONVERSATION,
        platform: "mattermost",
        remoteId: CHANNEL,
        title: "Général",
      });
      store.setReplySettings(CONVERSATION, {
        replyMode: "tout",
        replyStyle: attendu.style,
        quoteAuthor: attendu.quote,
      });
      const adapter = new MattermostChatAdapter({
        baseUrl: () => fixture.baseUrl,
        token: () => TOKEN,
        store,
        pollIntervalMs: 0,
        // Le message d'origine est une RÉPONSE de fil : c'est le cas qui distingue
        // vraiment `fil` (racine) de `nouveau` (aucun `root_id`).
        generateReply: async () => "Voilà, c'est fait.",
      });
      cleanups.push(() => adapter.disconnect());
      await adapter.connect();
      await waitFor(() => adapter.status().etat === "on", "la connexion temps réel");

      adapter.subscribe(CONVERSATION, () => undefined);
      // Diffusion temps réel d'une réponse de fil écrite par un humain.
      await waitFor(() => store.record(CONVERSATION) !== undefined, "le canal miroité");
      // ⚠️ On passe par la MÊME porte que le temps réel (`onNewMessage`), donc la chaîne
      // complète : décision → rédaction → envoi. Le message d'origine est une RÉPONSE de
      // fil, seul cas qui distingue vraiment `fil` (racine) de `nouveau` (aucun `root_id`).
      const onMessage = (adapter as unknown as { onNewMessage(m: RemoteMessage): void }).onNewMessage;
      onMessage.call(adapter, {
        remoteId: `humain-${attendu.style}-${attendu.quote}`,
        conversationId: CONVERSATION,
        threadRootId: "racine-du-fil",
        author: { id: "humain-1", nom: "Camille", estBot: false },
        role: "user",
        text: "merci de regarder",
        sentAt: "2026-11-01T10:00:00.000Z",
      });

      await waitFor(() => fixture.created.length === 1, "la réponse publiée");
      const body = fixture.created[0] ?? {};
      expect(body.channel_id).toBe(CHANNEL);
      if (attendu.rootId === undefined) {
        expect(body).not.toHaveProperty("root_id");
      } else {
        // ⚠️ JAMAIS le message lui-même : la racine, sinon fil imbriqué.
        expect(body.root_id).toBe(attendu.rootId);
      }
      const texte = String(body.message ?? "");
      if (attendu.prefixe) {
        // ⚠️ MENTION NATIVE seule : le texte du message d'origine n'est PAS recité.
        expect(texte.startsWith("@camille\n\n")).toBe(true);
        expect(texte).not.toContain("merci de regarder");
      } else {
        expect(texte).toBe("Voilà, c'est fait.");
      }
    });
  }
});
