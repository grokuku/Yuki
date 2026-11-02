/**
 * RÉPONSES dans un salon Discord (lot 21) — mêmes règles que Mattermost, mêmes fonctions.
 *
 * Ce que ce fichier prouve :
 *  - **`replyMode` par défaut = `mention` POUR DISCORD** (`defaultReplyModeFor("discord")`),
 *    explicitement, alors que le défaut Mattermost vient du lot 18 : la résolution est PAR
 *    PLATEFORME, donc les deux valeurs peuvent diverger sans que l'une suive l'autre ;
 *  - les TROIS modes fonctionnent contre la plateforme : `tout` (répond), `mention`
 *    (citation ⇒ répond, sinon silence), `auto` (le juge tranche UNE seule fois) ;
 *  - **anti-boucle** : un message du bot ne déclenche rien ;
 *  - `send()` ne pose `message_reference` QUE si `replyStyle = "fil"` (avec
 *    `fail_if_not_exists: false`), et joint les fichiers en multipart `files[0]` ;
 *  - un texte plus long que 2 000 caractères est TRONQUÉ en le disant (jamais un 400 qui
 *    perdrait la réponse entière) ;
 *  - un fichier au-delà de la borne est REFUSÉ avant tout appel réseau, et le texte part
 *    quand même (échec visible, non fatal).
 *
 * ⚠️ Échoue sur le code d'origine : il n'existe aucun adaptateur Discord (le stub ne
 * répond pas, n'envoie rien et n'a même pas de `send`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiscordChatAdapter, fitDiscordContent } from "../../src/chat/discord/adapter.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import { conversationIdOfDiscordChannel } from "../../src/chat/mirror/ingest.js";
import {
  DEFAULT_REPLY_MODE,
  DEFAULT_REPLY_MODE_BY_PLATFORM,
  defaultReplyModeFor,
} from "../../src/chat/reply/responder.js";
import type { FilesPort } from "../../src/files/types.js";
import {
  BOT_ID,
  CHANNEL,
  THREAD,
  TOKEN,
  messageFixture,
  startDiscordFixture,
} from "./discord-fixture.js";

const CONVERSATION = conversationIdOfDiscordChannel(CHANNEL);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé en attendant : ${label}`);
}

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "yuki-discord-reply-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return ChatMirrorStore.open({
    indexPath: join(root, "chat-mirror.json"),
    messagesDir: join(root, "chat-mirror"),
  });
}

/** Adaptateur câblé sur la fixture, prêt à répondre. */
async function startAdapter(
  store: ChatMirrorStore,
  options: Partial<ConstructorParameters<typeof DiscordChatAdapter>[0]> = {},
) {
  const fixture = await startDiscordFixture({ heartbeatIntervalMs: 5_000 });
  const adapter = new DiscordChatAdapter({
    token: () => TOKEN,
    store,
    pollIntervalMs: 0,
    apiBase: fixture.apiBase,
    gatewayUrl: fixture.gatewayUrl,
    generateReply: async ({ message }) => `Réponse à « ${message.text} »`,
    ...options,
  });
  cleanups.push(() => adapter.disconnect());
  await adapter.connect();
  await waitFor(() => adapter.status().etat === "on", "la session");
  await waitFor(() => store.conversations().length > 0, "les salons");
  return { fixture, adapter };
}

/** Contenu JSON d'un `POST /channels/<id>/messages` (texte simple ou multipart). */
function payloadOf(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    const match = /"payload_json"\s*\r?\n\r?\n(.*?)\r?\n--/s.exec(body);
    return match ? (JSON.parse(match[1] ?? "{}") as Record<string, unknown>) : {};
  }
}

describe("défaut de mode de réponse — PAR PLATEFORME", () => {
  it("Discord est à `mention` par défaut (et la table le dit explicitement)", () => {
    expect(defaultReplyModeFor("discord")).toBe("mention");
    expect(DEFAULT_REPLY_MODE_BY_PLATFORM.discord).toBe("mention");
    // ⚠️ La table existe pour que les deux plateformes puissent DIVERGER : Mattermost
    // garde le défaut du lot 18, et le test le dit au lieu de le supposer.
    expect(DEFAULT_REPLY_MODE_BY_PLATFORM.mattermost).toBe(DEFAULT_REPLY_MODE);
    // Discord est le défaut le plus PRUDENT : un bot qui répond à tout dans un serveur
    // actif est insupportable.
    expect(defaultReplyModeFor("discord")).toBe("mention");
  });

  it("sans réglage de canal, un message SANS citation ne déclenche AUCUNE réponse", async () => {
    const store = openStore();
    const { fixture } = await startAdapter(store);
    // Aucun `setReplyMode` : on observe le DÉFAUT.
    fixture.dispatch("MESSAGE_CREATE", messageFixture({ id: "111111111111111110", content: "coucou" }), 2);
    await waitFor(
      () => store.message(CONVERSATION, "111111111111111110") !== undefined,
      "l'ingestion",
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fixture.posts).toHaveLength(0);
  });
});

describe("les trois modes", () => {
  it("`tout` répond à un message humain", async () => {
    const store = openStore();
    const { fixture } = await startAdapter(store);
    store.setReplyMode(CONVERSATION, "tout");
    fixture.dispatch("MESSAGE_CREATE", messageFixture({ id: "111111111111111111", content: "salut" }), 2);
    await waitFor(() => fixture.posts.length === 1, "la réponse");
    expect(payloadOf(fixture.posts[0]?.body ?? "").content).toBe("Réponse à « salut »");
  });

  it("`mention` répond SEULEMENT si Yuki est citée, et cite l'auteur si demandé", async () => {
    const store = openStore();
    const { fixture } = await startAdapter(store);
    store.setReplySettings(CONVERSATION, { replyMode: "mention", quoteAuthor: "oui" });

    // ① Pas de citation : silence.
    fixture.dispatch("MESSAGE_CREATE", messageFixture({ id: "111111111111111112", content: "quelqu'un ?" }), 2);
    await waitFor(
      () => store.message(CONVERSATION, "111111111111111112") !== undefined,
      "l'ingestion du message non cité",
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fixture.posts).toHaveLength(0);

    // ② Citation du pseudo du bot : réponse, avec la MENTION de l'auteur (pas de citation
    // de son texte : la plateforme affiche déjà le message d'origine).
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({ id: "111111111111111113", content: "@yuki tu peux m'aider ?" }),
      3,
    );
    await waitFor(() => fixture.posts.length === 1, "la réponse au message cité");
    const corps = payloadOf(fixture.posts[0]?.body ?? "");
    const contenu = String(corps.content);
    // ⚠️ Mention NATIVE Discord : `<@identifiant>`, forme moderne (`<@!…>` est dépréciée).
    expect(contenu).toBe('<@723456789012345678>\n\nRéponse à « @yuki tu peux m\'aider ? »');
    expect(contenu).not.toContain("a écrit");
    // Aucun bloc de citation Markdown (le seul `>` restant est celui de la mention).
    expect(contenu).not.toContain("> **");
    // ⚠️ Sans cette autorisation, le client neutralise la mention (`parse: []`) :
    // `<@id>` s'afficherait sans notifier la personne. `parse` reste VIDE : jamais
    // `@everyone`, `@here` ou un rôle.
    expect(corps.allowed_mentions).toEqual({
      parse: [],
      users: ["723456789012345678"],
    });
  });

  it("`auto` fait juger UNE seule fois, même si le message est rejoué", async () => {
    const store = openStore();
    let jugements = 0;
    const { fixture } = await startAdapter(store, {
      judge: async () => {
        jugements += 1;
        return false;
      },
    });
    store.setReplyMode(CONVERSATION, "auto");

    fixture.dispatch("MESSAGE_CREATE", messageFixture({ id: "111111111111111114" }), 2);
    await waitFor(() => jugements === 1, "le jugement");
    // ⚠️ Rejeu du même message (le temps réel peut répéter) : AUCUN second jugement.
    fixture.dispatch("MESSAGE_CREATE", messageFixture({ id: "111111111111111114" }), 3);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(jugements).toBe(1);
    expect(fixture.posts).toHaveLength(0);
  });
});

describe("envoi — référence, fichiers, bornes", () => {
  it("`replyStyle = fil` (défaut) référence le message ; `nouveau` n'envoie AUCUNE référence", async () => {
    const store = openStore();
    const { fixture } = await startAdapter(store);
    store.setReplyMode(CONVERSATION, "tout");

    fixture.dispatch("MESSAGE_CREATE", messageFixture({ id: "111111111111111115", content: "dans le fil" }), 2);
    await waitFor(() => fixture.posts.length === 1, "la première réponse");
    const premier = payloadOf(fixture.posts[0]?.body ?? "");
    // ⚠️ Par défaut (`fil`) : référence au message d'origine, sans échouer s'il a disparu.
    expect(premier.message_reference).toEqual({
      message_id: "111111111111111115",
      channel_id: CHANNEL,
      fail_if_not_exists: false,
    });

    // `nouveau` : la réponse part à la racine du salon, sans référence.
    store.setReplyStyle(CONVERSATION, "nouveau");
    fixture.dispatch("MESSAGE_CREATE", messageFixture({ id: "111111111111111116", content: "à la racine" }), 3);
    await waitFor(() => fixture.posts.length === 2, "la seconde réponse");
    expect(payloadOf(fixture.posts[1]?.body ?? "")).not.toHaveProperty("message_reference");
  });

  it("une réponse à un message de FIL part DANS le fil, sans référence (autre salon)", async () => {
    const store = openStore();
    const { fixture } = await startAdapter(store);
    store.setReplyMode(CONVERSATION, "tout");
    // Le message arrive DANS un fil (type 11) : l'adaptateur résout le salon parent et
    // retient que ce fil EST un salon.
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({ id: THREAD, channel_id: THREAD, channel_type: 11, content: "dans un fil" }),
      2,
    );
    await waitFor(() => store.message(CONVERSATION, THREAD) !== undefined, "le message du fil");
    await waitFor(() => fixture.posts.length === 1, "la réponse au message du fil");
    const post = fixture.posts[0];
    // ⚠️ La réponse est publiée DANS le fil (son identifiant de salon), et SANS
    // `message_reference` : référencer un message d'un autre salon serait refusé.
    expect(post?.path).toBe(`/channels/${THREAD}/messages`);
    expect(payloadOf(post?.body ?? "")).not.toHaveProperty("message_reference");
  });

  it("joint un fichier du store Yuki en multipart `files[0]`", async () => {
    const store = openStore();
    const fichiers = new Map([
      [
        "f-1",
        {
          id: "f-1",
          name: "image.png",
          mimeType: "image/png",
          bytes: new Uint8Array([1, 2, 3, 4]),
          createdAt: new Date().toISOString(),
          size: 4,
          conversationId: CONVERSATION,
        },
      ],
    ]);
    const files = {
      get: (id: string) => fichiers.get(id),
      readBytes: (id: string) => fichiers.get(id)?.bytes,
    } as unknown as Pick<FilesPort, "get" | "readBytes">;

    const { fixture, adapter } = await startAdapter(store, { files });
    store.setReplyMode(CONVERSATION, "tout");
    await adapter.send(CONVERSATION, {
      kind: "texte",
      text: "voici l'image",
      fichiers: ["f-1"],
    });
    const post = fixture.posts.at(-1);
    // ⚠️ Discord accepte le fichier dans le MÊME appel (`files[0]`), sans `POST /files`.
    expect(post?.contentType).toContain("multipart/form-data");
    expect(post?.body).toContain('name="files[0]"');
    expect(payloadOf(post?.body ?? "").content).toBe("voici l'image");
    expect(
      fixture.requests.filter((req) => req.path.endsWith("/files")),
    ).toHaveLength(0);
  });

  it("un fichier trop lourd est REFUSÉ avant réseau, et le TEXTE part quand même", async () => {
    const store = openStore();
    const fichiers = new Map([
      [
        "f-2",
        {
          id: "f-2",
          name: "gros.bin",
          mimeType: "application/octet-stream",
          bytes: new Uint8Array(2048),
          createdAt: new Date().toISOString(),
          size: 2048,
          conversationId: CONVERSATION,
        },
      ],
    ]);
    const files = {
      get: (id: string) => fichiers.get(id),
      readBytes: (id: string) => fichiers.get(id)?.bytes,
    } as unknown as Pick<FilesPort, "get" | "readBytes">;

    const { fixture, adapter } = await startAdapter(store, {
      files,
      maxUploadBytes: () => 1024,
    });
    const envoye = await adapter.send(CONVERSATION, {
      kind: "texte",
      text: "texte qui doit partir",
      fichiers: ["f-2"],
    });
    expect(envoye.text).toContain("texte qui doit partir");
    const post = fixture.posts.at(-1);
    // ⚠️ Aucun multipart : le fichier n'est même pas monté.
    expect(post?.contentType).not.toContain("multipart/form-data");
    const contenu = String(payloadOf(post?.body ?? "").content);
    expect(contenu).toContain("texte qui doit partir");
    // ⚠️ L'échec est VISIBLE dans le message publié ET dans le statut.
    expect(contenu).toContain("borne d'envoi");
    expect(String(adapter.status().raison)).toContain("Pièce jointe non envoyée");
  });

  it("tronque un texte trop long en le DISANT (limite Discord : 2 000 caractères)", () => {
    const court = "bonjour";
    expect(fitDiscordContent(court)).toBe(court);
    const long = "a".repeat(2_500);
    const tronque = fitDiscordContent(long);
    expect([...tronque].length).toBeLessThanOrEqual(2_000);
    expect(tronque).toContain("message tronqué");
  });

  it("refuse l'envoi d'une demande d'approbation (aucun relais dans un canal)", async () => {
    const store = openStore();
    const { adapter } = await startAdapter(store);
    await expect(
      adapter.send(CONVERSATION, {
        kind: "approbation",
        approval: { id: "a", titre: "t", detail: "d", options: [] },
      }),
    ).rejects.toThrow(/pas disponible/);
  });
});

describe("identité du bot — deux plateformes, deux identités", () => {
  it("le bot Discord n'est pas confondu avec le bot Mattermost", async () => {
    const store = openStore();
    const { adapter } = await startAdapter(store);
    const identite = await adapter.identity();
    expect(identite.id).toBe(BOT_ID);
    // ⚠️ Le miroir garde UNE identité PAR PLATEFORME : sans cela, les messages de Yuki sur
    // Discord passeraient pour ceux d'un humain (ou l'inverse) et l'anti-boucle céderait.
    expect(store.bot("discord").id).toBe(BOT_ID);
    expect(store.bot("mattermost").id).toBeUndefined();
  });
});

describe("D1 — le BACKFILL Discord ne rejoue pas l'historique dans le moteur de réponse", () => {
  it("trois mentions de l'historique ⇒ ZÉRO réponse, même en mode `tout` ; puis UN message réel ⇒ UNE", async () => {
    const store = openStore();
    const demandes: string[] = [];
    // ⚠️ État RÉEL d'un redémarrage : le salon est déjà connu AVEC le mode `tout`.
    store.ensureConversation({
      conversationId: CONVERSATION,
      platform: "discord",
      remoteId: CHANNEL,
      title: "général",
    });
    store.setReplyMode(CONVERSATION, "tout");
    // ⚠️ Horodatages RÉCENTS : la fenêtre du backfill est de 14 jours.
    const recent = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const fixture = await startDiscordFixture({
      heartbeatIntervalMs: 5_000,
      pages: () => [
        messageFixture({ id: "111111111111111140", content: "@yuki vieux 1", timestamp: recent(60) }),
        messageFixture({ id: "111111111111111141", content: "@yuki vieux 2", timestamp: recent(50) }),
        messageFixture({ id: "111111111111111142", content: "@yuki vieux 3", timestamp: recent(40) }),
      ],
    });
    const adapter = new DiscordChatAdapter({
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      apiBase: fixture.apiBase,
      gatewayUrl: fixture.gatewayUrl,
      generateReply: async ({ message }) => {
        demandes.push(message.remoteId);
        return "bonjour";
      },
    });
    cleanups.push(() => adapter.disconnect());
    await adapter.connect();
    await waitFor(() => adapter.status().etat === "on", "la session");

    // ① L'historique est VISIBLE (l'interface le reçoit)…
    await waitFor(() => store.messages(CONVERSATION).length === 3, "le backfill des trois mentions");
    // … et il n'a lancé AUCUNE réponse.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(demandes).toEqual([]);
    expect(fixture.posts).toHaveLength(0);

    // ② Un message TEMPS RÉEL est servi, UNE fois.
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({
        id: "111111111111111150",
        content: "@yuki bonjour",
        timestamp: recent(1),
      }),
      2,
    );
    await waitFor(() => demandes.length === 1, "la réponse au message temps réel");
    expect(demandes).toEqual(["111111111111111150"]);
  });
});
