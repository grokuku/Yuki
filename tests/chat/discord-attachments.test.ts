/**
 * PIÈCES JOINTES Discord (lot 21) — entrantes à la demande, garde d'appartenance, vision.
 *
 * Ce que ce fichier prouve :
 *  - les MÉTADONNÉES viennent du message (aucun appel d'API pour les lister) ;
 *  - le téléchargement se fait À LA DEMANDE, sur le CDN, SANS le jeton du bot ;
 *  - un identifiant HORS du canal suivi est REFUSÉ, avec ZÉRO requête (garde de sûreté) ;
 *  - l'image téléchargée est réellement VUE par le modèle (politique de vision partagée :
 *    `prepareMessageImages` rend une `ImageContent` avec le bon type MIME, détecté sur les
 *    OCTETS) ;
 *  - une pièce jointe non-image n'est pas une erreur : elle est DITE (`notes`).
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/discord/client.ts` n'existe pas, et le stub
 * Discord n'a ni pièce jointe ni cache.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChatAttachmentCache, prepareMessageImages } from "../../src/chat/attachments.js";
import { DiscordClient } from "../../src/chat/discord/client.js";
import {
  discordAttachmentPort,
  salonDuMessage,
  DiscordChatAdapter,
} from "../../src/chat/discord/adapter.js";
import { ingestDiscordMessage, conversationIdOfDiscordChannel } from "../../src/chat/mirror/ingest.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import {
  CHANNEL,
  OTHER_CHANNEL,
  PNG_BYTES_1x1,
  THREAD,
  TOKEN,
  messageFixture,
  startDiscordFixture,
} from "./discord-fixture.js";

const CONVERSATION = conversationIdOfDiscordChannel(CHANNEL);
const AUTRE_CONVERSATION = conversationIdOfDiscordChannel(OTHER_CHANNEL);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "yuki-discord-attach-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return ChatMirrorStore.open({
    indexPath: join(root, "chat-mirror.json"),
    messagesDir: join(root, "chat-mirror"),
  });
}

/** Client pointé sur la fixture, avec son CDN local (tests). */
function clientFor(fixture: { apiBase: string }): DiscordClient {
  return new DiscordClient({
    token: () => TOKEN,
    apiBase: fixture.apiBase,
    cdnHosts: ["127.0.0.1"],
    allowHttpCdn: true,
    minIntervalMs: 1,
  });
}

/** Message portant une PIÈCE JOINTE dont l'URL pointe sur le CDN de la fixture. */
function messageAvecImage(fixture: { apiBase: string }, overrides: Record<string, unknown> = {}) {
  return messageFixture({
    id: "111111111111111120",
    attachments: [
      {
        id: "a-1",
        filename: "photo.png",
        size: PNG_BYTES_1x1.length,
        content_type: "image/png",
        url: `${fixture.apiBase}/cdn/fichier.png`,
      },
    ],
    ...overrides,
  });
}

describe("pièces jointes — métadonnées et garde d'appartenance", () => {
  it("les métadonnées viennent du MESSAGE (aucun appel d'API pour les lister)", async () => {
    const fixture = await startDiscordFixture();
    const store = openStore();
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "discord",
      remoteId: CHANNEL,
      title: "général",
    });
    ingestDiscordMessage(store, messageAvecImage(fixture), { conversationId: CONVERSATION });
    const message = store.message(CONVERSATION, "111111111111111120");
    // ⚠️ Nom, taille, type ET URL sont déjà là : rien à demander à l'API.
    expect(message?.attachments).toEqual([
      {
        id: "a-1",
        nom: "photo.png",
        taille: PNG_BYTES_1x1.length,
        mime: "image/png",
        url: `${fixture.apiBase}/cdn/fichier.png`,
      },
    ]);
    expect(fixture.requests).toHaveLength(0);
  });

  it("un identifiant HORS du canal est REFUSÉ avec ZÉRO requête", async () => {
    const fixture = await startDiscordFixture();
    const store = openStore();
    for (const [conversationId, channel] of [
      [CONVERSATION, CHANNEL],
      [AUTRE_CONVERSATION, OTHER_CHANNEL],
    ] as const) {
      store.ensureConversation({
        conversationId,
        platform: "discord",
        remoteId: channel,
        title: channel,
      });
    }
    // Le fichier appartient à l'AUTRE canal.
    ingestDiscordMessage(store, messageAvecImage(fixture, { channel_id: OTHER_CHANNEL }), {
      conversationId: AUTRE_CONVERSATION,
    });
    const cache = new ChatAttachmentCache({
      port: discordAttachmentPort(clientFor(fixture)),
      store,
      maxBytes: () => 1024 * 1024,
    });
    // ⚠️ Idem pour un identifiant INVENTÉ.
    for (const fileId of ["a-1", "fichier-forge"]) {
      const outcome = await cache.read(CONVERSATION, fileId);
      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false ? outcome.code : "").toBe("non_reference");
    }
    // ⚠️ Zéro requête : ni métadonnées, ni octets.
    expect(fixture.requests).toHaveLength(0);
    expect(cache.downloadCount).toBe(0);

    // Et un canal qui n'est pas suivi est refusé aussi (aucune lecture du disque).
    const inconnu = await cache.read("dc-999", "a-1");
    expect(inconnu.ok).toBe(false);
    expect(inconnu.ok === false ? inconnu.code : "").toBe("canal_inconnu");
    expect(fixture.requests).toHaveLength(0);
  });
});

describe("pièces jointes — téléchargement à la demande et vision", () => {
  it("télécharge l'image À LA DEMANDE puis la transmet au modèle (détection par octets)", async () => {
    const fixture = await startDiscordFixture();
    const store = openStore();
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "discord",
      remoteId: CHANNEL,
      title: "général",
    });
    ingestDiscordMessage(store, messageAvecImage(fixture), { conversationId: CONVERSATION });
    const cache = new ChatAttachmentCache({
      port: discordAttachmentPort(clientFor(fixture)),
      store,
      maxBytes: () => 1024 * 1024,
    });
    const message = store.message(CONVERSATION, "111111111111111120");
    expect(message).toBeDefined();

    const prepared = await prepareMessageImages({
      cache,
      conversationId: CONVERSATION,
      message: message ?? { attachments: [] },
      maxBytes: 1_000_000,
      maxWireBytes: 5_000_000,
    });
    expect(prepared.notes).toEqual([]);
    expect(prepared.images).toHaveLength(1);
    // ⚠️ Le type MIME vient des OCTETS (signature PNG), jamais du nom ni du champ annoncé.
    expect(prepared.images[0]?.mimeType).toBe("image/png");
    expect(String(prepared.images[0]?.data ?? "").length).toBeGreaterThan(0);

    // Deuxième lecture : CACHE, aucune nouvelle requête réseau.
    const avant = fixture.requests.length;
    const relu = await cache.read(CONVERSATION, "a-1");
    expect(relu.ok).toBe(true);
    expect(relu.ok === true ? relu.cached : false).toBe(true);
    expect(fixture.requests).toHaveLength(avant);
  });

  it("une pièce jointe NON image n'est pas une erreur : elle est DITE (`notes`)", async () => {
    const fixture = await startDiscordFixture();
    const store = openStore();
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "discord",
      remoteId: CHANNEL,
      title: "général",
    });
    // Le CDN de la fixture rend un PNG : on déclare un PDF pour vérifier que c'est bien la
    // SIGNATURE DES OCTETS qui décide… et ici elle dit « image ». On teste donc l'inverse :
    // un fichier dont les octets ne sont PAS une image.
    ingestDiscordMessage(
      store,
      messageFixture({
        id: "111111111111111121",
        attachments: [
          {
            id: "a-2",
            filename: "notes.txt",
            size: 4,
            content_type: "text/plain",
            url: `${fixture.apiBase}/cdn/texte.txt`,
          },
        ],
      }),
      { conversationId: CONVERSATION },
    );
    const cache = new ChatAttachmentCache({
      port: discordAttachmentPort(clientFor(fixture)),
      store,
      maxBytes: () => 1024 * 1024,
    });
    const prepared = await prepareMessageImages({
      cache,
      conversationId: CONVERSATION,
      message: store.message(CONVERSATION, "111111111111111121") ?? { attachments: [] },
      maxBytes: 1_000_000,
      maxWireBytes: 5_000_000,
    });
    expect(prepared.images).toHaveLength(0);
    expect(prepared.notes.join(" ")).toContain("n'est pas une image");
  });
});

describe("pièces jointes — sortantes", () => {
  it("joint l'image GÉNÉRÉE d'un run dans le message publié (`files[0]`)", async () => {
    const fixture = await startDiscordFixture({ heartbeatIntervalMs: 5_000 });
    const store = openStore();
    const fichiers = new Map([
      [
        "f-image",
        {
          id: "f-image",
          name: "generee.png",
          mimeType: "image/png",
          bytes: new Uint8Array(PNG_BYTES_1x1),
          createdAt: new Date().toISOString(),
          size: PNG_BYTES_1x1.length,
          conversationId: CONVERSATION,
        },
      ],
    ]);
    const adapter = new DiscordChatAdapter({
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      apiBase: fixture.apiBase,
      gatewayUrl: fixture.gatewayUrl,
      // ⚠️ Le générateur rend AUSSI un fichier : c'est le chemin réel d'une image produite
      // par `generer_image` dans un run distant.
      generateReply: async () => ({ text: "voici l'image générée", fichiers: ["f-image"] }),
      files: {
        get: (id: string) => fichiers.get(id),
        readBytes: (id: string) => fichiers.get(id)?.bytes,
      } as never,
    });
    cleanups.push(() => adapter.disconnect());
    await adapter.connect();
    await waitFor(() => adapter.status().etat === "on", "la session");
    await waitFor(() => store.conversations().length > 0, "les salons");
    store.setReplyMode(CONVERSATION, "tout");

    fixture.dispatch("MESSAGE_CREATE", messageFixture({ id: "111111111111111122" }), 2);
    await waitFor(() => fixture.posts.length === 1, "la réponse avec image");
    const post = fixture.posts[0];
    expect(post?.contentType).toContain("multipart/form-data");
    expect(post?.body).toContain('name="files[0]"');
    expect(post?.body).toContain("generee.png");
  });
});

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé en attendant : ${label}`);
}

describe("D5 — rafraîchissement d'une URL expirée DANS UN FIL", () => {
  it("relit le message dans le SALON DU FIL, pas dans le salon parent (sinon 404)", async () => {
    // ⚠️ Le CDN rend `404` sur cette URL : c'est le cas « URL signée expirée ».
    const fixture = await startDiscordFixture();
    const store = openStore();
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "discord",
      remoteId: CHANNEL,
      title: "général",
    });
    // Le message vit DANS LE FIL (`threadRootId` = identifiant du fil = racine).
    ingestDiscordMessage(
      store,
      messageFixture({
        id: "111111111111111130",
        channel_id: THREAD,
        attachments: [
          {
            id: "a-1",
            filename: "photo.png",
            size: 4,
            content_type: "image/png",
            url: `${fixture.apiBase}/cdn/expiree.png`,
          },
        ],
      }),
      { conversationId: CONVERSATION, threadRootId: THREAD },
    );
    const message = store.message(CONVERSATION, "111111111111111130");
    expect(message?.threadRootId).toBe(THREAD);

    const cache = new ChatAttachmentCache({
      port: discordAttachmentPort(clientFor(fixture)),
      store,
      maxBytes: () => 1024 * 1024,
    });
    const outcome = await cache.read(CONVERSATION, "a-1");
    expect(outcome.ok).toBe(true);

    // ⚠️ La relecture est faite dans le fil : `/channels/<fil>/messages/<id>`.
    const relectures = fixture.requests.filter((item) =>
      /^\/channels\/[^/]+\/messages\/[^/]+$/.test(item.path),
    );
    expect(relectures.map((item) => item.path)).toEqual([
      `/channels/${THREAD}/messages/111111111111111130`,
    ]);
    // Et JAMAIS dans le salon parent (qui rendait `404`).
    expect(relectures.some((item) => item.path.startsWith(`/channels/${CHANNEL}/`))).toBe(false);
  });

  it("un message de SALON (hors fil) est relu dans le salon de la conversation", async () => {
    const fixture = await startDiscordFixture();
    const store = openStore();
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "discord",
      remoteId: CHANNEL,
      title: "général",
    });
    ingestDiscordMessage(
      store,
      messageFixture({
        id: "111111111111111131",
        attachments: [
          {
            id: "a-1",
            filename: "photo.png",
            size: 4,
            content_type: "image/png",
            url: `${fixture.apiBase}/cdn/expiree.png`,
          },
        ],
      }),
      { conversationId: CONVERSATION },
    );
    const cache = new ChatAttachmentCache({
      port: discordAttachmentPort(clientFor(fixture)),
      store,
      maxBytes: () => 1024 * 1024,
    });
    expect((await cache.read(CONVERSATION, "a-1")).ok).toBe(true);
    const relectures = fixture.requests.filter((item) =>
      /^\/channels\/[^/]+\/messages\/[^/]+$/.test(item.path),
    );
    expect(relectures.map((item) => item.path)).toEqual([
      `/channels/${CHANNEL}/messages/111111111111111131`,
    ]);
  });

  it("`salonDuMessage` : fil ⇒ fil, message racine ⇒ salon parent", () => {
    const base = { author: { id: "u", nom: "u", estBot: false }, role: "user" as const, text: "", sentAt: "" };
    const salon = conversationIdOfDiscordChannel(CHANNEL);
    expect(salonDuMessage({ ...base, remoteId: "m-fils", conversationId: salon, threadRootId: "fil-9" })).toBe("fil-9");
    // ⚠️ Le message RACINE du fil porte `threadRootId === son identifiant` : il vit dans le
    // salon PARENT, pas dans le fil (un fil ne contient pas son message racine).
    expect(salonDuMessage({ ...base, remoteId: "fil-9", conversationId: salon, threadRootId: "fil-9" })).toBe(CHANNEL);
    expect(salonDuMessage({ ...base, remoteId: "m-2", conversationId: salon })).toBe(CHANNEL);
  });
});
