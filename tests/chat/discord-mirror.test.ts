/**
 * MIROIR — ingestion Discord (lot 21).
 *
 * Ce que ce fichier prouve, sans réseau :
 *  - **idempotence** : deux ingestions du même message produisent UNE bulle ;
 *  - **édition ≠ nouvelle bulle** : `edited_timestamp` met à jour l'entrée existante ;
 *  - **suppression ≠ disparition** : l'entrée reste, marquée, avec la mention « supprimé
 *    sur Discord » et le TEXTE d'origine conservé ;
 *  - un message de FIL rejoint la conversation du salon parent, avec `threadRootId` ;
 *  - l'identité du bot est rangée PAR PLATEFORME : un bot Discord n'écrase pas Mattermost ;
 *  - `MESSAGE_CONTENT` absent ⇒ contenu VIDE : c'est stocké tel quel (aucun texte inventé).
 *
 * ⚠️ Échoue sur le code d'origine : `ingestDiscordMessage` n'existe pas, `RemoteAttachment`
 * n'a pas d'`url`, et le miroir ne connaît qu'une seule identité de bot.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  conversationIdOfChannel,
  conversationIdOfDiscordChannel,
  discordAttachmentsOf,
  ingestDiscordMessage,
} from "../../src/chat/mirror/ingest.js";
import { ChatMirrorStore, deletedNoticeOf } from "../../src/chat/mirror/store.js";
import type { DiscordMessage } from "../../src/chat/discord/types.js";

const CHANNEL = "323456789012345678";
const THREAD = "523456789012345678";
const BOT_ID = "123456789012345678";
const CONVERSATION = conversationIdOfDiscordChannel(CHANNEL);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function openStore(): ChatMirrorStore {
  const root = mkdtempSync(join(tmpdir(), "yuki-discord-mirror-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = ChatMirrorStore.open({
    indexPath: join(root, "chat-mirror.json"),
    messagesDir: join(root, "chat-mirror"),
  });
  store.ensureConversation({
    conversationId: CONVERSATION,
    platform: "discord",
    remoteId: CHANNEL,
    title: "général",
  });
  return store;
}

function message(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: "111111111111111111",
    channel_id: CHANNEL,
    content: "bonjour",
    timestamp: "2026-01-02T10:00:00.000Z",
    author: { id: "723456789012345678", username: "humain", bot: false },
    ...overrides,
  };
}

describe("ingestion Discord — idempotence, édition, suppression", () => {
  it("deux ingestions identiques ⇒ UNE seule bulle", () => {
    const store = openStore();
    const ctx = { conversationId: CONVERSATION };
    expect(ingestDiscordMessage(store, message(), ctx)).toBe("insere");
    expect(ingestDiscordMessage(store, message(), ctx)).toBe("doublon");
    expect(store.messages(CONVERSATION)).toHaveLength(1);
  });

  it("une ÉDITION met à jour la même entrée (jamais une seconde bulle)", () => {
    const store = openStore();
    const ctx = { conversationId: CONVERSATION };
    ingestDiscordMessage(store, message(), ctx);
    const outcome = ingestDiscordMessage(
      store,
      message({ content: "bonjour (édité)", edited_timestamp: "2026-01-02T11:00:00.000Z" }),
      ctx,
    );
    expect(outcome).toBe("mis_a_jour");
    expect(store.messages(CONVERSATION)).toHaveLength(1);
    expect(store.message(CONVERSATION, "111111111111111111")?.text).toBe("bonjour (édité)");
    expect(store.message(CONVERSATION, "111111111111111111")?.editedAt).toBe(
      "2026-01-02T11:00:00.000Z",
    );
  });

  it("une SUPPRESSION garde l'entrée, la marque et CONSERVE le texte d'origine", () => {
    const store = openStore();
    const ctx = { conversationId: CONVERSATION };
    ingestDiscordMessage(store, message(), ctx);
    // ⚠️ L'événement `MESSAGE_DELETE` ne transporte que `{ id, channel_id }`.
    ingestDiscordMessage(store, { id: "111111111111111111", channel_id: CHANNEL }, ctx);
    const supprime = store.message(CONVERSATION, "111111111111111111");
    expect(supprime?.deleted).toBe(true);
    expect(supprime?.text).toBe("bonjour");
    expect(store.messages(CONVERSATION)).toHaveLength(1);

    // Un message jamais vu, supprimé : l'entrée apparaît avec la mention de la PLATEFORME.
    ingestDiscordMessage(store, { id: "111111111111111112", channel_id: CHANNEL }, ctx);
    expect(store.message(CONVERSATION, "111111111111111112")?.text).toBe(deletedNoticeOf("discord"));
    expect(deletedNoticeOf("discord")).toBe("(supprimé sur Discord)");
  });

  it("un MESSAGE_CREATE sans `content` (intent manquant) n'invente AUCUN texte", () => {
    const store = openStore();
    ingestDiscordMessage(
      store,
      {
        id: "111111111111111113",
        channel_id: CHANNEL,
        timestamp: "2026-01-02T10:00:00.000Z",
        author: { id: "723456789012345678", username: "humain" },
      },
      { conversationId: CONVERSATION },
    );
    // ⚠️ Vide, mais présent : c'est la vérité de ce que Discord a envoyé.
    expect(store.message(CONVERSATION, "111111111111111113")?.text).toBe("");
    expect(store.message(CONVERSATION, "111111111111111113")?.deleted).toBeUndefined();
  });
});

describe("ingestion Discord — fils et pièces jointes", () => {
  it("un message de FIL rejoint son salon parent, avec `threadRootId` = le fil", () => {
    const store = openStore();
    ingestDiscordMessage(store, message({ id: "222222222222222222", channel_id: THREAD }), {
      conversationId: CONVERSATION,
      threadRootId: THREAD,
    });
    const dansLeFil = store.message(CONVERSATION, "222222222222222222");
    expect(dansLeFil?.conversationId).toBe(CONVERSATION);
    expect(dansLeFil?.threadRootId).toBe(THREAD);
    // ⚠️ Le fil lui-même n'est PAS une conversation.
    expect(store.record(conversationIdOfDiscordChannel(THREAD))).toBeUndefined();
  });

  it("une réponse (`message_reference`) porte son message parent", () => {
    const store = openStore();
    ingestDiscordMessage(
      store,
      message({
        id: "222222222222222223",
        message_reference: { message_id: "111111111111111111", channel_id: CHANNEL },
      }),
      { conversationId: CONVERSATION },
    );
    expect(store.message(CONVERSATION, "222222222222222223")?.threadRootId).toBe(
      "111111111111111111",
    );
  });

  it("les pièces jointes gardent nom, taille, type ET url (aucun appel d'API)", () => {
    const attachments = discordAttachmentsOf({
      attachments: [
        {
          id: "a-1",
          filename: "photo.png",
          size: 1234,
          content_type: "image/png",
          url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
        },
        { id: "a-2" }, // sans métadonnées : le nom retombe sur l'identifiant
      ],
    });
    expect(attachments).toEqual([
      {
        id: "a-1",
        nom: "photo.png",
        taille: 1234,
        mime: "image/png",
        url: "https://cdn.discordapp.com/attachments/1/2/photo.png",
      },
      { id: "a-2", nom: "a-2" },
    ]);
  });
});

describe("miroir — deux plateformes, deux identités de bot", () => {
  it("l'identité du bot est rangée PAR PLATEFORME (aucun écrasement)", () => {
    const store = openStore();
    store.setBot({ id: "bot-mattermost", username: "yuki" }, "mattermost");
    store.setBot({ id: BOT_ID, username: "yuki-discord" }, "discord");
    expect(store.bot("mattermost")).toEqual({ id: "bot-mattermost", username: "yuki" });
    expect(store.bot("discord")).toEqual({ id: BOT_ID, username: "yuki-discord" });
    // Un appel SANS plateforme (compatibilité lot 18) écrit l'identité Mattermost.
    store.setBot({ id: "bot-mattermost-2" });
    expect(store.bot().id).toBe("bot-mattermost-2");
    expect(store.bot("discord").id).toBe(BOT_ID);
  });

  it("un message du bot Discord est classé `assistant` (donc JAMAIS répondu)", () => {
    const store = openStore();
    ingestDiscordMessage(
      store,
      message({ id: "333333333333333333", author: { id: BOT_ID, username: "yuki", bot: true } }),
      { conversationId: CONVERSATION, botUserId: BOT_ID },
    );
    const duBot = store.message(CONVERSATION, "333333333333333333");
    expect(duBot?.role).toBe("assistant");
    expect(duBot?.author.estBot).toBe(true);
  });

  it("un canal Mattermost n'est PAS vu comme un canal Discord", () => {
    const store = openStore();
    store.ensureConversation({
      conversationId: conversationIdOfChannel("canal-1"),
      platform: "mattermost",
      remoteId: "canal-1",
      title: "canal mattermost",
    });
    const conversations = store.conversations();
    expect(conversations.map((item) => item.platform).sort()).toEqual(["discord", "mattermost"]);
    for (const conversation of conversations) {
      // ⚠️ `readOnly` et `canRun` disent deux choses DIFFÉRENTES : un miroir est en lecture
      // seule côté interface web, mais il peut produire des runs.
      expect(conversation.readOnly).toBe(true);
      expect(conversation.canRun).toBe(true);
    }
  });
});
