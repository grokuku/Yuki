/**
 * PASSERELLE Discord (lot 21) — contre un SERVEUR FIXTURE RÉEL (WebSocket).
 *
 * Ce que ce fichier prouve, et qui ne peut pas l'être sur un double en mémoire :
 *  - `HELLO` (op 10) ⇒ le client envoie `IDENTIFY` (op 2) avec `token`, `intents`
 *    (dont `MESSAGE_CONTENT`, `1 << 15`) et `properties` — puis des `HEARTBEAT` (op 1)
 *    à la cadence annoncée, avec le dernier `s` reçu ;
 *  - `MESSAGE_CREATE` est INGÉRÉ dans le miroir, avec l'auteur et le fil (`threadRootId`) ;
 *  - `MESSAGE_UPDATE` met à jour UNE bulle, `MESSAGE_DELETE` laisse une mention ;
 *  - une coupure déclenche une REPRISE (`RESUME`, op 6, avec `session_id` + `seq`), et le
 *    rejeu ne produit AUCUN doublon (le miroir est idempotent) ;
 *  - un jeton invalide (`4004`) ARRÊTE NET : une seule tentative, aucune boucle ;
 *  - l'intent refusé (`4014`) réessaie UNE fois SANS l'intent privilégié, et l'état DIT
 *    que `MESSAGE_CONTENT` manque ;
 *  - aucun jeton n'apparaît dans l'état du socket.
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/discord/ws.ts` n'existe pas.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiscordChatAdapter } from "../../src/chat/discord/adapter.js";
import { DiscordSocket } from "../../src/chat/discord/ws.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import { conversationIdOfDiscordChannel } from "../../src/chat/mirror/ingest.js";
import {
  BOT_ID,
  CHANNEL,
  GUILD_ID,
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

/** Attend qu'une condition devienne vraie (jamais une attente fixe). */
async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé en attendant : ${label}`);
}

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "yuki-discord-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return ChatMirrorStore.open({
    indexPath: join(root, "chat-mirror.json"),
    messagesDir: join(root, "chat-mirror"),
  });
}

describe("passerelle — HELLO, IDENTIFY et battements", () => {
  it("s'identifie après HELLO et battement avec le dernier `s` reçu", async () => {
    const fixture = await startDiscordFixture({ heartbeatIntervalMs: 100 });
    const socket = new DiscordSocket({
      token: () => TOKEN,
      gatewayUrl: fixture.gatewayUrl,
      onEvent: () => undefined,
      random: () => 0,
    });
    cleanups.push(() => socket.stop());

    await socket.start();
    await waitFor(() => fixture.identifies.length === 1, "l'IDENTIFY");

    const identify = fixture.identifies[0];
    expect(identify?.token).toBe(TOKEN);
    // ⚠️ Intents : GUILDS (1<<0) + GUILD_MESSAGES (1<<9) + MESSAGE_CONTENT (1<<15).
    expect(identify?.intents).toBe((1 << 0) | (1 << 9) | (1 << 15));
    expect(identify?.properties).toMatchObject({ browser: "Yuki", device: "Yuki" });

    // La session devient PRÊTE avec le `READY` que le serveur envoie après l'IDENTIFY.
    await waitFor(() => socket.status().connecte, "READY");

    // ⚠️ Battements : op 1, avec le DERNIER `s` reçu (null avant tout événement).
    await waitFor(
      () => fixture.frames.some((frame) => frame.includes('"op":1')),
      "un battement",
      5_000,
    );
    const premier = fixture.frames
      .map((frame) => JSON.parse(frame) as { op?: number; d?: unknown })
      .filter((payload) => payload.op === 1)[0];
    expect(premier?.d === null || premier?.d === 1).toBe(true);

    // Après un événement (s = 2), le battement suivant porte ce numéro.
    fixture.dispatch("MESSAGE_CREATE", messageFixture({ id: "511111111111111111" }), 2);
    await waitFor(
      () =>
        fixture.frames
          .map((frame) => JSON.parse(frame) as { op?: number; d?: unknown })
          .some((payload) => payload.op === 1 && payload.d === 2),
      "un battement portant la séquence 2",
      5_000,
    );
  });

  it("l'ordre du premier battement est GIGUÉ (jamais collé à HELLO)", async () => {
    const fixture = await startDiscordFixture({ heartbeatIntervalMs: 1_000 });
    const socket = new DiscordSocket({
      token: () => TOKEN,
      gatewayUrl: fixture.gatewayUrl,
      onEvent: () => undefined,
      // Gigue maximale : le premier battement doit arriver ~1 s après HELLO, pas tout de suite.
      random: () => 0.99,
    });
    cleanups.push(() => socket.stop());
    await socket.start();
    await waitFor(() => fixture.identifies.length === 1, "l'IDENTIFY");
    expect(fixture.frames.some((frame) => frame.includes('"op":1'))).toBe(false);
  });
});

describe("passerelle — reprise après coupure", () => {
  it("reprend avec `RESUME` (session_id + seq) et ne produit AUCUN doublon", async () => {
    const fixture = await startDiscordFixture({ heartbeatIntervalMs: 5_000 });
    const store = openStore();
    const adapter = new DiscordChatAdapter({
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      apiBase: fixture.apiBase,
      gatewayUrl: fixture.gatewayUrl,
      generateReply: async ({ message }) => `Réponse à « ${message.text} »`,
    });
    cleanups.push(() => adapter.disconnect());

    await adapter.connect();
    await waitFor(() => adapter.status().etat === "on", "la session");
    await waitFor(
      () => store.conversations().length > 0,
      "la liste des salons (backfill)",
    );
    // ⚠️ Défaut Discord = `mention` : sans ce réglage, « bonjour » ne déclenche RIEN.
    store.setReplyMode(CONVERSATION, "tout");

    fixture.dispatch("MESSAGE_CREATE", messageFixture({ id: "111111111111111111" }), 2);
    await waitFor(
      () => store.message(CONVERSATION, "111111111111111111") !== undefined,
      "le message temps réel",
    );

    // Coupure brutale : le client doit REPRENDRE (et non ré-identifier).
    fixture.drop();
    await waitFor(() => fixture.resumes.length === 1, "la reprise");
    expect(fixture.resumes[0]?.session_id).toBe("session-1");
    expect(typeof fixture.resumes[0]?.seq).toBe("number");

    // Le rejeu du MÊME message après reprise n'ajoute rien (idempotence du miroir).
    fixture.dispatch("MESSAGE_CREATE", messageFixture({ id: "111111111111111111" }), 3);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      store.messages(CONVERSATION).filter((message) => message.remoteId === "111111111111111111"),
    ).toHaveLength(1);
    // Une seule réponse a été publiée pour ce message.
    expect(
      fixture.posts.filter((post) => post.body.includes("Réponse à « bonjour »")),
    ).toHaveLength(1);
  });
});

describe("passerelle — arrêt net et intent manquant", () => {
  it("un jeton invalide (4004) ARRÊTE le temps réel (aucune boucle)", async () => {
    const fixture = await startDiscordFixture({ expectedToken: "autre-jeton" });
    const socket = new DiscordSocket({
      token: () => "mauvais-jeton",
      gatewayUrl: fixture.gatewayUrl,
      onEvent: () => undefined,
      baseDelayMs: 5,
      jitterMs: 1,
      maxAttempts: 20,
    });
    cleanups.push(() => socket.stop());
    await socket.start();
    await waitFor(() => fixture.identifies.length >= 1, "un IDENTIFY");
    fixture.closeWith(4004, "Authentication failed");
    await waitFor(() => socket.status().abandonne, "l'arrêt net");
    const status = socket.status();
    expect(status.connecte).toBe(false);
    expect(String(status.derniereErreur)).toContain("4004");
    // ⚠️ Le message d'état ne recopie JAMAIS le jeton refusé.
    expect(String(status.derniereErreur)).not.toContain("mauvais-jeton");
    // ⚠️ Aucune boucle : une seule identification, puis plus rien.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fixture.identifies).toHaveLength(1);
  });

  it("un intent refusé (4014) réessaie SANS MESSAGE_CONTENT et le DIT", async () => {
    const fixture = await startDiscordFixture();
    const socket = new DiscordSocket({
      token: () => TOKEN,
      gatewayUrl: fixture.gatewayUrl,
      onEvent: () => undefined,
      baseDelayMs: 5,
      jitterMs: 1,
      random: () => 0,
      maxAttempts: 3,
    });
    cleanups.push(() => socket.stop());
    await socket.start();
    await waitFor(() => fixture.identifies.length === 1, "le premier IDENTIFY");
    expect(fixture.identifies[0]?.intents).toBe((1 << 0) | (1 << 9) | (1 << 15));

    fixture.closeWith(4014, "Disallowed intent(s).");
    await waitFor(() => fixture.identifies.length === 2, "la nouvelle identification");
    // ⚠️ La seconde identification ne demande PLUS l'intent privilégié.
    expect(fixture.identifies[1]?.intents).toBe((1 << 0) | (1 << 9));
    expect(socket.status().intentContentManquant).toBe(true);
    expect(String(socket.status().derniereErreur)).toContain("MESSAGE_CONTENT");
  });

  it("un RECONNECT (op 7) déclenche une reprise immédiate", async () => {
    const fixture = await startDiscordFixture({ heartbeatIntervalMs: 5_000 });
    const socket = new DiscordSocket({
      token: () => TOKEN,
      gatewayUrl: fixture.gatewayUrl,
      onEvent: () => undefined,
      baseDelayMs: 5,
      jitterMs: 1,
    });
    cleanups.push(() => socket.stop());
    await socket.start();
    await waitFor(() => fixture.identifies.length === 1, "l'IDENTIFY");
    fixture.dispatch(
      "READY",
      { v: 10, session_id: "session-7", resume_gateway_url: fixture.gatewayUrl },
      1,
    );
    await waitFor(() => socket.status().connecte, "READY");
    fixture.sendRaw({ op: 7, d: null });
    await waitFor(() => fixture.resumes.length === 1, "la reprise après RECONNECT");
    expect(fixture.resumes[0]?.session_id).toBe("session-7");
  });
});

describe("adaptateur — ingestion, fils et anti-boucle", () => {
  it("ingère MESSAGE_CREATE/UPDATE/DELETE et range un FIL dans son salon parent", async () => {
    const fixture = await startDiscordFixture({ heartbeatIntervalMs: 5_000 });
    const store = openStore();
    const adapter = new DiscordChatAdapter({
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      apiBase: fixture.apiBase,
      gatewayUrl: fixture.gatewayUrl,
    });
    cleanups.push(() => adapter.disconnect());
    await adapter.connect();
    await waitFor(() => adapter.status().etat === "on", "la session");
    await waitFor(() => store.conversations().length > 0, "les salons");

    // 1. Message ORDINAIRE.
    fixture.dispatch("MESSAGE_CREATE", messageFixture({ id: "211111111111111111" }), 2);
    await waitFor(
      () => store.message(CONVERSATION, "211111111111111111") !== undefined,
      "le message ordinaire",
    );

    // 2. Message dans un FIL : conversation = salon PARENT, `threadRootId` = le fil.
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({ id: "311111111111111111", channel_id: THREAD, channel_type: 11 }),
      3,
    );
    await waitFor(
      () => store.message(CONVERSATION, "311111111111111111") !== undefined,
      "le message de fil",
    );
    expect(store.message(CONVERSATION, "311111111111111111")?.threadRootId).toBe(THREAD);
    // ⚠️ Le fil n'est PAS une conversation séparée.
    expect(store.record(conversationIdOfDiscordChannel(THREAD))).toBeUndefined();

    // 3. ÉDITION : une seule entrée, `editedAt` renseigné.
    fixture.dispatch(
      "MESSAGE_UPDATE",
      messageFixture({
        id: "211111111111111111",
        content: "bonjour (édité)",
        edited_timestamp: "2026-01-02T11:00:00.000Z",
      }),
      4,
    );
    await waitFor(
      () => store.message(CONVERSATION, "211111111111111111")?.editedAt !== undefined,
      "l'édition",
    );
    expect(store.message(CONVERSATION, "211111111111111111")?.text).toBe("bonjour (édité)");
    expect(
      store.messages(CONVERSATION).filter((message) => message.remoteId === "211111111111111111"),
    ).toHaveLength(1);

    // 4. SUPPRESSION : l'entrée RESTE, avec la mention « supprimé sur Discord ».
    fixture.dispatch(
      "MESSAGE_DELETE",
      { id: "211111111111111111", channel_id: CHANNEL, guild_id: GUILD_ID },
      5,
    );
    await waitFor(
      () => store.message(CONVERSATION, "211111111111111111")?.deleted === true,
      "la suppression",
    );
    const supprime = store.message(CONVERSATION, "211111111111111111");
    expect(supprime?.deleted).toBe(true);
    // ⚠️ Le TEXTE d'origine est conservé (on ne réécrit pas l'histoire).
    expect(supprime?.text).toBe("bonjour (édité)");
  });

  it("un message du BOT n'entraîne AUCUNE réponse (anti-boucle), même en mode `tout`", async () => {
    const fixture = await startDiscordFixture({ heartbeatIntervalMs: 5_000 });
    const store = openStore();
    const adapter = new DiscordChatAdapter({
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      apiBase: fixture.apiBase,
      gatewayUrl: fixture.gatewayUrl,
      generateReply: async () => "je ne devrais pas être publié",
    });
    cleanups.push(() => adapter.disconnect());
    await adapter.connect();
    await waitFor(() => adapter.status().etat === "on", "la session");
    await waitFor(() => store.conversations().length > 0, "les salons");
    store.setReplyMode(CONVERSATION, "tout");

    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({
        id: "411111111111111111",
        author: { id: BOT_ID, username: "yuki", bot: true },
        content: "ceci est ma propre réponse",
      }),
      2,
    );
    await waitFor(
      () => store.message(CONVERSATION, "411111111111111111") !== undefined,
      "l'ingestion du message du bot",
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fixture.posts).toHaveLength(0);
  });

  it("`status()` n'expose NI jeton NI URL complète", async () => {
    const fixture = await startDiscordFixture({ heartbeatIntervalMs: 5_000 });
    const store = openStore();
    const configure = new DiscordChatAdapter({
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      apiBase: fixture.apiBase,
      gatewayUrl: fixture.gatewayUrl,
    });
    cleanups.push(() => configure.disconnect());
    const status = configure.status();
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(JSON.stringify(status)).not.toContain("127.0.0.1");

    // Sans jeton : le statut DIT quoi faire, sans jamais nommer un secret.
    const sansJeton = new DiscordChatAdapter({ token: () => undefined, store });
    const off = sansJeton.status();
    expect(off.etat).toBe("off");
    expect(String(off.raison)).toContain("/config → Discussions");
    // Et il nomme le prérequis le plus probable : l'intent privilégié.
    expect(String(off.raison)).toContain("MESSAGE_CONTENT");
  });
});
