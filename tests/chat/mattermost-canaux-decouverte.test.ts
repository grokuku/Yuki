/**
 * DÉCOUVERTE DES CANAUX — un canal ajouté APRÈS la connexion doit apparaître.
 *
 * ⚠️ CAS EXACT SIGNALÉ (2026-11-14) : « je venais seulement d'ajouter le canal…
 * J'ai relancé et les canaux ont bien été détectés. » Autrement dit : la liste
 * n'était énumérée qu'AU DÉMARRAGE, donc un canal ajouté ensuite restait invisible
 * jusqu'au redémarrage suivant.
 *
 * Ce que ce fichier prouve, contre un SERVEUR FIXTURE RÉEL :
 *  ① la découverte interroge bien l'APPARTENANCE RÉELLE du bot
 *     (`/users/me/teams` puis `/users/me/teams/<id>/channels`) ;
 *  ② un canal ajouté après coup entre dans le miroir après une RESYNCHRONISATION
 *     (aucun redémarrage) ;
 *  ③ l'événement temps réel d'ADHÉSION (`added_to_channel`) déclenche cette
 *     resynchronisation — c'est ce qui rend l'apparition immédiate ;
 *  ④ zéro canal n'est jamais une liste VIDE MUETTE : la raison est dans le statut ;
 *  ⑤ la ré-énumération périodique de la synchronisation rattrape un événement
 *     manqué (filet de sécurité).
 *
 * Échoue sur le code d'origine : ni `resynchroniser`/`planifierResynchronisation`,
 * ni `added_to_channel`, ni ré-énumération périodique n'existaient.
 */

import { afterEach, describe, expect, it } from "vitest";

import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { MattermostSocket } from "../../src/chat/mattermost/ws.js";
import { ChatSyncService } from "../../src/chat/sync/service.js";
import { conversationIdOfChannel } from "../../src/chat/mirror/ingest.js";
import { createLogger } from "../../src/observability/logger.js";
import {
  MM_CHANNEL,
  MM_TOKEN,
  openMmMirror,
  startMmFixture,
  waitFor,
} from "./mm-reply-fixture.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [MM_TOKEN] });
const CONVERSATION = conversationIdOfChannel(MM_CHANNEL);
const CONVERSATION_2 = conversationIdOfChannel("canal-2");

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Adaptateur branché sur la fixture, avec son propre miroir. */
async function adaptateurFixture(baseUrl: string, options: { maxChannels?: number } = {}) {
  const miroir = openMmMirror(cleanups);
  const adaptateur = new MattermostChatAdapter({
    baseUrl: () => baseUrl,
    token: () => MM_TOKEN,
    store: miroir,
    logger,
    ...(options.maxChannels !== undefined ? { maxChannels: options.maxChannels } : {}),
  });
  cleanups.push(async () => {
    await adaptateur.disconnect().catch(() => undefined);
  });
  return { adaptateur, miroir };
}

describe("①② un canal ajouté après la connexion apparaît après resynchronisation", () => {
  it("la liste est ré-énumérée et le nouveau canal entre dans le miroir", async () => {
    const fixture = await startMmFixture(cleanups);
    const { adaptateur, miroir } = await adaptateurFixture(fixture.baseUrl);

    await adaptateur.connect();
    await waitFor(
      () => miroir.records()[CONVERSATION] !== undefined,
      "le premier canal est découvert et miroité",
    );
    expect(miroir.records()[CONVERSATION_2]).toBeUndefined();

    // ⚠️ L'administrateur ajoute le bot au canal APRÈS la synchronisation initiale.
    fixture.ajouterCanal("canal-2", "Projet");
    await adaptateur.resynchroniser();

    await waitFor(
      () => miroir.records()[CONVERSATION_2] !== undefined,
      "le canal ajouté après coup apparaît sans redémarrage",
    );
    expect(miroir.record(CONVERSATION_2)?.title).toBe("Projet");
  });

  it("③ l'événement d'ADHÉSION déclenche la resynchronisation (délai coalescé)", async () => {
    const fixture = await startMmFixture(cleanups);
    const { adaptateur, miroir } = await adaptateurFixture(fixture.baseUrl);
    await adaptateur.connect();
    await waitFor(() => miroir.records()[CONVERSATION] !== undefined, "premier canal miroité");

    fixture.ajouterCanal("canal-2", "Projet");
    // Même chemin que le temps réel, avec une fenêtre de coalescence nulle (test).
    adaptateur.planifierResynchronisation(0);

    await waitFor(
      () => miroir.records()[CONVERSATION_2] !== undefined,
      "l'adhésion signalée par le temps réel ajoute le canal",
    );
  });
});

describe("③ bis la trame `added_to_channel` est bien reconnue par le socket", () => {
  it("elle appelle `onMembership`, pas `onEvent` (ce n'est pas un post)", async () => {
    const adhesions: string[] = [];
    const posts: string[] = [];
    /** Doublure de WebSocket : on PILOTE les trames reçues. */
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const socket = new MattermostSocket({
      baseUrl: () => "http://127.0.0.1:1",
      token: () => MM_TOKEN,
      onEvent: (event) => posts.push(event.kind),
      onMembership: (kind) => adhesions.push(kind),
      logger: undefined,
      random: () => 0,
      createSocket: () => ({
        on: (event, listener) => {
          listeners.set(event, listener);
          return undefined;
        },
        send: () => undefined,
        close: () => undefined,
        removeAllListeners: () => undefined,
      }),
    });
    cleanups.push(async () => {
      await socket.stop().catch(() => undefined);
    });

    await socket.start();
    listeners.get("open")?.();
    listeners.get("message")?.(
      JSON.stringify({ status: "OK", seq_reply: 1 }),
    );
    listeners.get("message")?.(
      JSON.stringify({ event: "hello", data: { server_version: "10.0.0" }, seq: 1 }),
    );
    listeners.get("message")?.(
      JSON.stringify({ event: "added_to_channel", data: { channel_id: "canal-2" }, seq: 2 }),
    );

    expect(adhesions).toEqual(["added_to_channel"]);
    expect(posts).toEqual([]);
  });
});

describe("④ zéro canal n'est jamais une liste vide MUETTE", () => {
  it("le statut de la plateforme dit que le bot ne voit aucun canal", async () => {
    const fixture = await startMmFixture(cleanups);
    // Borne de canaux à ZÉRO : le serveur rend bien un canal, la découverte n'en
    // garde aucun — c'est alors au statut de le DIRE (aucune liste muette).
    const { adaptateur } = await adaptateurFixture(fixture.baseUrl, { maxChannels: 0 });
    const canaux = await adaptateur.channels();
    expect(canaux).toEqual([]);
    const raison = adaptateur.status().raison ?? "";
    expect(raison).toContain("ne voit aucun canal");
  });
});

describe("⑤ la ré-énumération périodique rattrape un événement manqué", () => {
  it("un canal apparu côté serveur est découvert sans nouvelle connexion", async () => {
    const miroir = openMmMirror(cleanups);
    /** Plateforme factice : sa liste de canaux GRANDIT en cours de route. */
    let canaux = [{ conversationId: "mm-a", plateforme: "mattermost", remoteId: "a", title: "A" }];
    const plateforme = {
      identity: async () => ({ id: "bot-1" }),
      channels: async () => canaux,
      postsSince: async () => ({ messages: [], historiqueAnterieur: false }),
      subscribePosts: () => () => undefined,
    };
    const sync = new ChatSyncService({
      platform: plateforme as never,
      store: miroir,
      logger: undefined,
      pollIntervalMs: 1,
      rescanEveryPolls: 1,
      schedule: (callback) => {
        const handle = setTimeout(callback, 0);
        return handle;
      },
      cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    });
    cleanups.push(async () => {
      await sync.stop();
    });

    await sync.start();
    canaux = [
      ...canaux,
      { conversationId: "mm-b", plateforme: "mattermost", remoteId: "b", title: "B" },
    ];

    await waitFor(() => miroir.records()["mm-b"] !== undefined, "le canal B est découvert");
  });
});
