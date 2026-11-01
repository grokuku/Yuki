/**
 * MIROIR et INGESTION (lot 18, lot 2) — idempotence, éditions, suppressions, bornes.
 *
 * Ce que ce fichier prouve :
 *  - IDEMPOTENCE STRICTE : deux `posted` identiques produisent UN message (la clé est
 *    `(platform, conversationId, remoteMessageId)`), et la seconde écriture n'a même pas
 *    lieu (l'index en mémoire est consulté AVANT) ;
 *  - un message ÉDITÉ tient dans UNE bulle (pas de seconde entrée) ;
 *  - un message SUPPRIMÉ garde son entrée, avec la mention « supprimé sur Mattermost » ;
 *  - le fichier est APPEND-ONLY, en 0600, et la relecture applique la DERNIÈRE ligne ;
 *  - les bornes sont EXPLICITES : 16 Kio par message (corps tronqué AVEC mention) et
 *    20 000 messages par canal ;
 *  - l'auteur `botUserId` devient `assistant` (et lui seul).
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/mirror/store.ts` et `ingest.ts` n'existent
 * pas.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ChatMirrorStore,
  DELETED_NOTICE,
  MAX_MESSAGE_BYTES,
  TRUNCATION_SUFFIX,
} from "../../src/chat/mirror/store.js";
import {
  conversationIdOfChannel,
  ingestPost,
  isOwnMessage,
  postToRemoteMessage,
} from "../../src/chat/mirror/ingest.js";
import type { MattermostPost } from "../../src/chat/mattermost/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function openStore(options: { maxMessageBytes?: number; maxMessages?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "yuki-mirror-"));
  dirs.push(root);
  const store = ChatMirrorStore.open({
    indexPath: join(root, "chat-mirror.json"),
    messagesDir: join(root, "chat-mirror"),
    ...(options.maxMessageBytes !== undefined ? { maxMessageBytes: options.maxMessageBytes } : {}),
    ...(options.maxMessages !== undefined ? { maxMessagesPerConversation: options.maxMessages } : {}),
  });
  return { root, store, conversationId: conversationIdOfChannel("canal-1") };
}

/** Post Mattermost minimal. */
function post(id: string, extra: Partial<MattermostPost> = {}): MattermostPost {
  return {
    id,
    channel_id: "canal-1",
    user_id: "humain-1",
    message: `message ${id}`,
    create_at: 1_700_000_000_000,
    ...extra,
  };
}

describe("ingestion — clé d'idempotence et rôles", () => {
  it("deux `posted` identiques ⇒ UN seul message (aucune seconde écriture)", () => {
    const { store, conversationId } = openStore();
    store.ensureConversation({
      conversationId,
      platform: "mattermost",
      remoteId: "canal-1",
      title: "Général",
    });
    const ctx = { platform: "mattermost" as const, conversationId, botUserId: "bot-1" };

    expect(ingestPost(store, post("m1"), ctx)).toBe("insere");
    const before = store.messages(conversationId).length;
    // ⚠️ Même contenu, même identifiant : c'est un DOUBLON, pas un second message.
    expect(ingestPost(store, post("m1"), ctx)).toBe("doublon");
    expect(store.messages(conversationId)).toHaveLength(before);
    expect(store.messages(conversationId)).toHaveLength(1);
  });

  it("deux messages de TEXTE identique mais d'identifiants différents sont DEUX messages", () => {
    // ⚠️ Aucune heuristique de hachage de texte : deux « ok » sont deux messages.
    const { store, conversationId } = openStore();
    store.ensureConversation({
      conversationId,
      platform: "mattermost",
      remoteId: "canal-1",
      title: "Général",
    });
    const ctx = { platform: "mattermost" as const, conversationId, botUserId: "bot-1" };
    expect(ingestPost(store, post("m1", { message: "ok" }), ctx)).toBe("insere");
    expect(ingestPost(store, post("m2", { message: "ok" }), ctx)).toBe("insere");
    expect(store.messages(conversationId)).toHaveLength(2);
  });

  it("l'auteur du BOT devient `assistant` ; un humain reste `user`", () => {
    const { store, conversationId } = openStore();
    store.ensureConversation({
      conversationId,
      platform: "mattermost",
      remoteId: "canal-1",
      title: "Général",
    });
    const ctx = { platform: "mattermost" as const, conversationId, botUserId: "bot-1" };
    ingestPost(store, post("bot-msg", { user_id: "bot-1" }), ctx);
    ingestPost(store, post("humain-msg", { user_id: "humain-1" }), ctx);
    const messages = store.messages(conversationId);
    const bot = messages.find((item) => item.remoteId === "bot-msg");
    const humain = messages.find((item) => item.remoteId === "humain-msg");
    expect(bot?.role).toBe("assistant");
    expect(bot?.author.estBot).toBe(true);
    expect(humain?.role).toBe("user");
    expect(humain?.author.estBot).toBe(false);
    // Et la reconnaissance « c'est Yuki » fonctionne aussi par le rôle seul.
    expect(isOwnMessage(bot!, "bot-1")).toBe(true);
    expect(isOwnMessage(humain!, "bot-1")).toBe(false);
  });

  it("le PARENT voyage avec le message (fils dépliables)", () => {
    const { store, conversationId } = openStore();
    store.ensureConversation({
      conversationId,
      platform: "mattermost",
      remoteId: "canal-1",
      title: "Général",
    });
    const ctx = { platform: "mattermost" as const, conversationId, botUserId: "bot-1" };
    ingestPost(store, post("racine"), ctx);
    ingestPost(store, post("reponse", { root_id: "racine" }), ctx);
    const reponse = store.messages(conversationId).find((item) => item.remoteId === "reponse");
    expect(reponse?.threadRootId).toBe("racine");
  });
});

describe("édition et suppression — une seule bulle, jamais un effacement", () => {
  it("un message ÉDITÉ met à jour l'entrée (aucune seconde bulle)", () => {
    const { store, conversationId } = openStore();
    store.ensureConversation({
      conversationId,
      platform: "mattermost",
      remoteId: "canal-1",
      title: "Général",
    });
    const ctx = { platform: "mattermost" as const, conversationId, botUserId: "bot-1" };
    ingestPost(store, post("m1", { message: "version 1" }), ctx);
    const outcome = ingestPost(
      store,
      post("m1", { message: "version 2", edit_at: 1_700_000_500_000 }),
      ctx,
    );
    expect(outcome).toBe("mis_a_jour");
    const messages = store.messages(conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("version 2");
    expect(messages[0]?.editedAt).toBe("2023-11-14T22:21:40.000Z");
  });

  it("un message SUPPRIMÉ garde son entrée ET son texte, avec la mention", () => {
    const { store, conversationId } = openStore();
    store.ensureConversation({
      conversationId,
      platform: "mattermost",
      remoteId: "canal-1",
      title: "Général",
    });
    const ctx = { platform: "mattermost" as const, conversationId, botUserId: "bot-1" };
    ingestPost(store, post("m1", { message: "texte d'origine" }), ctx);
    // Un `post_deleted` arrive avec une charge utile PARTIELLE (id, delete_at).
    const outcome = ingestPost(
      store,
      { id: "m1", channel_id: "canal-1", user_id: "humain-1", delete_at: 1_700_000_900_000 },
      ctx,
    );
    expect(outcome).toBe("mis_a_jour");
    const messages = store.messages(conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.deleted).toBe(true);
    // ⚠️ Le texte d'origine est CONSERVÉ : aucune suppression silencieuse.
    expect(messages[0]?.text).toBe("texte d'origine");
  });

  it("une suppression d'un message JAMAIS vu est tout de même conservée, avec la mention", () => {
    const { store, conversationId } = openStore();
    store.ensureConversation({
      conversationId,
      platform: "mattermost",
      remoteId: "canal-1",
      title: "Général",
    });
    const ctx = { platform: "mattermost" as const, conversationId, botUserId: "bot-1" };
    ingestPost(
      store,
      { id: "inconnu", channel_id: "canal-1", user_id: "humain-1", delete_at: 1_700_000_900_000 },
      ctx,
    );
    const messages = store.messages(conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.deleted).toBe(true);
    expect(messages[0]?.text).toContain(DELETED_NOTICE);
  });
});

describe("persistance — append-only, 0600, dernière ligne gagnante", () => {
  it("le fichier du canal ne fait que GROSSIR, et la relecture voit la dernière version", () => {
    const { root, store, conversationId } = openStore();
    store.ensureConversation({
      conversationId,
      platform: "mattermost",
      remoteId: "canal-1",
      title: "Général",
    });
    const ctx = { platform: "mattermost" as const, conversationId, botUserId: "bot-1" };
    ingestPost(store, post("m1", { message: "v1" }), ctx);
    const file = join(root, "chat-mirror", `${conversationId}.jsonl`);
    const first = readFileSync(file, "utf8").trim().split("\n").length;
    expect(first).toBe(1);
    ingestPost(store, post("m1", { message: "v2", edit_at: 1_700_000_500_000 }), ctx);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    // ⚠️ APPEND-ONLY : l'édition AJOUTE une ligne, elle ne réécrit pas le fichier.
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("v1");
    expect(lines[1]).toContain("v2");
    // Les permissions sont restrictives (le fichier peut contenur des échanges privés).
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // Relecture par une SECONDE instance : une seule bulle, la bonne version.
    const reopened = ChatMirrorStore.open({
      indexPath: join(root, "chat-mirror.json"),
      messagesDir: join(root, "chat-mirror"),
    });
    const messages = reopened.messages(conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe("v2");
  });

  it("l'index est écrit en 0600 et ne contient AUCUN jeton", () => {
    const { root, store, conversationId } = openStore();
    store.ensureConversation({
      conversationId,
      platform: "mattermost",
      remoteId: "canal-1",
      title: "Général",
    });
    store.setBaseUrl("https://mm.exemple.fr");
    store.setBot({ id: "bot-1", username: "yuki" });
    store.setReplyMode(conversationId, "auto");
    const index = readFileSync(join(root, "chat-mirror.json"), "utf8");
    expect(statSync(join(root, "chat-mirror.json")).mode & 0o777).toBe(0o600);
    expect(index).toContain("https://mm.exemple.fr");
    expect(index).toContain('"auto"');
    // ⚠️ Le jeton vit dans le COFFRE, jamais dans ce fichier.
    expect(index.toLowerCase()).not.toContain("token");
    expect(index.toLowerCase()).not.toContain("jeton");
  });
});

describe("bornes explicites", () => {
  it("un corps de plus de 16 Kio est TRONQUÉ avec mention (jamais coupé en silence)", () => {
    const { store, conversationId } = openStore({ maxMessageBytes: 200 });
    store.ensureConversation({
      conversationId,
      platform: "mattermost",
      remoteId: "canal-1",
      title: "Général",
    });
    const ctx = { platform: "mattermost" as const, conversationId, botUserId: "bot-1" };
    ingestPost(store, post("long", { message: "é".repeat(500) }), ctx);
    const message = store.messages(conversationId)[0];
    expect(message?.text.endsWith(TRUNCATION_SUFFIX)).toBe(true);
    expect(Buffer.byteLength(message?.text ?? "", "utf8")).toBeLessThanOrEqual(200);
    // La coupe ne casse pas un caractère (aucun « » de remplacement).
    expect(message?.text ?? "").not.toContain("\uFFFD");
    expect(MAX_MESSAGE_BYTES).toBe(16 * 1024);
  });

  it("au-delà du plafond de messages, l'ajout est REFUSÉ et le canal est marqué", () => {
    const { store, conversationId } = openStore({ maxMessages: 2 });
    store.ensureConversation({
      conversationId,
      platform: "mattermost",
      remoteId: "canal-1",
      title: "Général",
    });
    const ctx = { platform: "mattermost" as const, conversationId, botUserId: "bot-1" };
    expect(ingestPost(store, post("a"), ctx)).toBe("insere");
    expect(ingestPost(store, post("b"), ctx)).toBe("insere");
    expect(ingestPost(store, post("c"), ctx)).toBe("borne");
    expect(store.messages(conversationId)).toHaveLength(2);
    expect(store.record(conversationId)?.borneAtteinte).toBe(true);
  });

  it("au-delà de 50 canaux, un canal de plus est REFUSÉ (jamais ignoré en silence)", () => {
    const { store } = openStore();
    for (let index = 0; index < 50; index += 1) {
      expect(
        store.ensureConversation({
          conversationId: `mm-c${index}`,
          platform: "mattermost",
          remoteId: `c${index}`,
          title: `Canal ${index}`,
        }),
      ).toBe(true);
    }
    expect(
      store.ensureConversation({
        conversationId: "mm-c50",
        platform: "mattermost",
        remoteId: "c50",
        title: "Canal 50",
      }),
    ).toBe(false);
    expect(store.conversations()).toHaveLength(50);
  });
});

describe("conversations exposées — lecture seule, run possible", () => {
  it("`readOnly` est TOUJOURS vrai et `canRun` aussi (un canal répond aux messages)", () => {
    const { store, conversationId } = openStore();
    store.ensureConversation({
      conversationId,
      platform: "mattermost",
      remoteId: "canal-1",
      title: "Général",
    });
    const conversation = store.conversations()[0];
    expect(conversation).toMatchObject({
      id: conversationId,
      platform: "mattermost",
      remoteId: "canal-1",
      title: "Général",
      readOnly: true,
      canRun: true,
    });
    // Le mode de réponse n'est annoncé que s'il a été CHOISI.
    expect(conversation?.replyMode).toBeUndefined();
    store.setReplyMode(conversationId, "tout");
    expect(store.conversations()[0]?.replyMode).toBe("tout");
  });

  it("`postToRemoteMessage` ne devINE jamais l'instant d'envoi", () => {
    const ctx = { platform: "mattermost" as const, conversationId: "mm-1" };
    const message = postToRemoteMessage({ id: "x", channel_id: "canal-1" }, ctx);
    // Aucun `create_at` : on ne prétend pas connaître l'instant (époque 0 assumée).
    expect(message.sentAt).toBe(new Date(0).toISOString());
    expect(message.role).toBe("user");
  });
});
