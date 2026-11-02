/**
 * SYNCHRONISATION et BACKFILL (lot 18, lot 2).
 *
 * Ce que ce fichier prouve :
 *  - la synchronisation DÉMARRE dès que la plateforme est configurée, et le MODE
 *    (`chat.mode`) ne la filtre pas : il ne filtre que la vue (décision du lot 1) ;
 *  - le backfill part de `maintenant − 14 jours` (borne en DATE) ;
 *  - la borne de 1 000 messages par canal est RESPECTÉE et le canal est MARQUÉ
 *    `historiqueAnterieur` (bandeau « historique antérieur non importé ») ;
 *  - un canal déjà backfillé n'est PAS relu (aucun doublon au redémarrage) ;
 *  - le RATTRAPAGE repart du CURSEUR persisté et ne crée aucun doublon ;
 *  - un canal en échec n'empêche pas les autres, et son échec est VISIBLE.
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/sync/service.ts` n'existe pas.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import { ChatSyncService, BACKFILL_DAYS, BACKFILL_MAX_MESSAGES } from "../../src/chat/sync/service.js";
import type { ChatSyncChannel, ChatSyncPlatform } from "../../src/chat/sync/platform.js";
import type { ChatAdapterStatus, RemoteMessage } from "../../src/chat/types.js";

const dirs: string[] = [];
const NOW = Date.parse("2026-11-01T12:00:00.000Z");

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function openStore() {
  const root = mkdtempSync(join(tmpdir(), "yuki-sync-"));
  dirs.push(root);
  return ChatMirrorStore.open({
    indexPath: join(root, "chat-mirror.json"),
    messagesDir: join(root, "chat-mirror"),
  });
}

function message(conversationId: string, id: string, sentAt: string): RemoteMessage {
  return {
    remoteId: id,
    conversationId,
    author: { id: "humain-1", nom: "humain-1", estBot: false },
    role: "user",
    text: `message ${id}`,
    sentAt,
  };
}

/** Plateforme de test : canaux fixes, posts par canal, appels TRACÉS. */
class FakePlatform implements ChatSyncPlatform {
  readonly plateforme = "mattermost" as const;
  readonly calls: Array<{ channelId: string; since: string }> = [];
  readonly channelsList: ChatSyncChannel[];
  /** `channelId → posts rendus, quel que soit `since``. */
  posts = new Map<string, RemoteMessage[]>();
  /** Canaux qui doivent ÉCHOUER à la lecture. */
  failing = new Set<string>();
  /** `true` quand la plateforme prétend avoir buté sur sa borne de 1 000. */
  bounded = new Set<string>();
  listeners = new Set<(message: RemoteMessage) => void>();

  constructor(channels: ChatSyncChannel[]) {
    this.channelsList = channels;
  }

  async identity(): Promise<{ id: string; username?: string }> {
    return { id: "bot-1", username: "yuki" };
  }

  async channels(): Promise<ChatSyncChannel[]> {
    return this.channelsList;
  }

  async postsSince(
    channelId: string,
    since: string,
  ): Promise<{ messages: RemoteMessage[]; historiqueAnterieur: boolean }> {
    this.calls.push({ channelId, since });
    if (this.failing.has(channelId)) throw new Error("lecture impossible");
    return {
      messages: this.posts.get(channelId) ?? [],
      historiqueAnterieur: this.bounded.has(channelId),
    };
  }

  subscribePosts(listener: (message: RemoteMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Temps réel : pousse un message comme le ferait le WebSocket. */
  push(message: RemoteMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  status(): ChatAdapterStatus {
    return { etat: "on" };
  }
}

function channel(id: string, title = `Canal ${id}`): ChatSyncChannel {
  return {
    conversationId: `mm-${id}`,
    plateforme: "mattermost",
    remoteId: id,
    title,
  };
}

describe("backfill — deux semaines, borné en date ET en messages", () => {
  it("`since` = maintenant − 14 jours, et la borne de 1 000 messages est appliquée", async () => {
    const store = openStore();
    const platform = new FakePlatform([channel("c1")]);
    // 1 200 messages : la borne de 1 000 doit couper, et le canal être MARQUÉ.
    platform.posts.set(
      "c1",
      Array.from({ length: 1_200 }, (_, index) =>
        message("mm-c1", `m${index}`, new Date(NOW - index * 1_000).toISOString()),
      ),
    );
    const service = new ChatSyncService({
      platform,
      store,
      now: () => NOW,
      pollIntervalMs: 0,
    });
    await service.start();

    expect(platform.calls).toHaveLength(1);
    const since = platform.calls[0]?.since ?? "";
    expect(Date.parse(since)).toBe(NOW - BACKFILL_DAYS * 86_400_000);
    expect(BACKFILL_DAYS).toBe(14);
    expect(BACKFILL_MAX_MESSAGES).toBe(1_000);

    // Les 1 000 derniers messages (les plus récents) sont conservés.
    expect(store.messages("mm-c1")).toHaveLength(1_000);
    const record = store.record("mm-c1");
    expect(record?.backfillDone).toBe(true);
    // ⚠️ BANDEAU : la borne a été atteinte, et c'est DIT.
    expect(record?.historiqueAnterieur).toBe(true);
    expect(service.status().backfill).toMatchObject({
      fait: true,
      borneAtteinte: true,
      imports: 1_000,
    });
  });

  it("un canal déjà backfillé n'est PAS relu au redémarrage (aucun doublon)", async () => {
    const store = openStore();
    const platform = new FakePlatform([channel("c1")]);
    platform.posts.set("c1", [message("mm-c1", "m1", new Date(NOW).toISOString())]);

    const first = new ChatSyncService({ platform, store, now: () => NOW, pollIntervalMs: 0 });
    await first.start();
    expect(store.messages("mm-c1")).toHaveLength(1);

    const second = new ChatSyncService({ platform, store, now: () => NOW, pollIntervalMs: 0 });
    await second.start();
    // Le canal est déjà marqué fait : AUCUNE nouvelle lecture de backfill.
    expect(platform.calls).toHaveLength(1);
    expect(store.messages("mm-c1")).toHaveLength(1);
  });

  it("un canal en ÉCHEC n'empêche pas les autres, et n'est pas marqué fait", async () => {
    const store = openStore();
    const platform = new FakePlatform([channel("bon"), channel("casse")]);
    platform.failing.add("casse");
    platform.posts.set("bon", [message("mm-bon", "m1", new Date(NOW).toISOString())]);

    const service = new ChatSyncService({ platform, store, now: () => NOW, pollIntervalMs: 0 });
    await service.start();

    expect(store.messages("mm-bon")).toHaveLength(1);
    expect(store.record("mm-bon")?.backfillDone).toBe(true);
    expect(store.record("mm-casse")?.backfillDone).toBe(false);
    expect(service.status().derniereErreur).toContain("Canal casse");
  });

  it("un canal dont la plateforme borne la lecture est MARQUÉ (bandeau)", async () => {
    const store = openStore();
    const platform = new FakePlatform([channel("c1")]);
    platform.bounded.add("c1");
    platform.posts.set("c1", [message("mm-c1", "m1", new Date(NOW).toISOString())]);
    const service = new ChatSyncService({ platform, store, now: () => NOW, pollIntervalMs: 0 });
    await service.start();
    expect(store.record("mm-c1")?.historiqueAnterieur).toBe(true);
    expect(service.status().backfill.borneAtteinte).toBe(true);
  });
});

describe("rattrapage — reprise au CURSEUR, sans doublon", () => {
  it("le rattrapage repart du curseur persisté (pas de `now − 14 j`)", async () => {
    const store = openStore();
    const platform = new FakePlatform([channel("c1")]);
    const dernier = new Date(NOW - 3_600_000).toISOString();
    platform.posts.set("c1", [message("mm-c1", "m1", dernier)]);
    const service = new ChatSyncService({ platform, store, now: () => NOW, pollIntervalMs: 0 });
    await service.start();
    expect(store.record("mm-c1")?.curseur).toBe(dernier);

    platform.calls.length = 0;
    await service.pollOnce();
    // ⚠️ Le rattrapage relit à partir du CURSEUR du dernier message ingéré.
    expect(platform.calls).toHaveLength(1);
    expect(Date.parse(platform.calls[0]?.since ?? "")).toBe(Date.parse(dernier));
  });

  it("deux passes de rattrapage qui revoient les mêmes posts n'ajoutent RIEN", async () => {
    const store = openStore();
    const platform = new FakePlatform([channel("c1")]);
    platform.posts.set("c1", [
      message("mm-c1", "m1", new Date(NOW - 60_000).toISOString()),
      message("mm-c1", "m2", new Date(NOW - 30_000).toISOString()),
    ]);
    const service = new ChatSyncService({ platform, store, now: () => NOW, pollIntervalMs: 0 });
    await service.start();
    expect(store.messages("mm-c1")).toHaveLength(2);
    await service.pollOnce();
    await service.pollOnce();
    expect(store.messages("mm-c1")).toHaveLength(2);
  });

  it("le backfill est étiqueté `historique: true`, le temps réel NON (D1)", async () => {
    const store = openStore();
    const platform = new FakePlatform([channel("c1")]);
    platform.posts.set("c1", [
      message("mm-c1", "vieux-1", new Date(NOW - 5_000).toISOString()),
      message("mm-c1", "vieux-2", new Date(NOW - 4_000).toISOString()),
    ]);
    const livraisons: Array<{ id: string; historique: boolean }> = [];
    const service = new ChatSyncService({
      platform,
      store,
      now: () => NOW,
      pollIntervalMs: 0,
      onMessage: (item, delivery) => livraisons.push({ id: item.remoteId, historique: delivery.historique }),
    });
    await service.start();

    // ① BACKFILL : les messages sont LIVRÉS (l'interface doit voir l'historique) mais
    // étiquetés, pour que le moteur de réponse s'abstienne.
    expect(livraisons).toEqual([
      { id: "vieux-1", historique: true },
      { id: "vieux-2", historique: true },
    ]);
    expect(store.messages("mm-c1")).toHaveLength(2);

    // ② TEMPS RÉEL : pas d'étiquette, donc le moteur de réponse a le droit de courir.
    const pousse = message("mm-c1", "temps-reel", new Date(NOW).toISOString());
    store.upsert(pousse);
    platform.push(pousse);
    expect(livraisons.at(-1)).toEqual({ id: "temps-reel", historique: false });

    // ③ RATTRAPAGE : ce sont des messages RÉCENTS manqués par le temps réel — ils ne sont
    // PAS de l'historique, sinon un message reçu pendant une coupure n'aurait jamais de
    // réponse.
    const rate = message("mm-c1", "rattrape", new Date(NOW + 1_000).toISOString());
    platform.posts.set("c1", [rate]);
    await service.pollOnce();
    expect(livraisons.at(-1)).toEqual({ id: "rattrape", historique: false });
  });

  it("le temps réel pousse un message : il est annoncé UNE fois, et le rattrapage n'en rajoute pas", async () => {
    const store = openStore();
    const platform = new FakePlatform([channel("c1")]);
    platform.posts.set("c1", []);
    const vus: string[] = [];
    const service = new ChatSyncService({
      platform,
      store,
      now: () => NOW,
      pollIntervalMs: 0,
      onMessage: (item) => vus.push(item.remoteId),
    });
    await service.start();

    const pousse = message("mm-c1", "temps-reel", new Date(NOW).toISOString());
    // La plateforme a DÉJÀ ingéré le message (c'est son travail) puis le pousse.
    store.upsert(pousse);
    platform.push(pousse);
    expect(vus).toEqual(["temps-reel"]);

    // Le rattrapage revoit le même post : aucun second envoi, aucun doublon dans le fil.
    platform.posts.set("c1", [pousse]);
    await service.pollOnce();
    expect(vus).toEqual(["temps-reel"]);
    expect(store.messages("mm-c1")).toHaveLength(1);
  });
});

describe("démarrage et arrêt", () => {
  it("`start()` mémorise l'identité du bot et s'abonne au temps réel ; `stop()` coupe tout", async () => {
    const store = openStore();
    const platform = new FakePlatform([]);
    const service = new ChatSyncService({ platform, store, now: () => NOW, pollIntervalMs: 0 });
    await service.start();
    expect(store.bot()).toEqual({ id: "bot-1", username: "yuki" });
    // Le temps réel est ABONNÉ (une poussée est reçue).
    expect(platform.listeners.size).toBe(1);
    expect(service.status().demarre).toBe(true);
    await service.stop();
    expect(service.status().demarre).toBe(false);
  });

  it("aucun canal suivi ⇒ backfill « fait » est FAUX (rien n'a été importé)", async () => {
    const store = openStore();
    const platform = new FakePlatform([]);
    const service = new ChatSyncService({ platform, store, now: () => NOW, pollIntervalMs: 0 });
    await service.start();
    expect(service.status().backfill.fait).toBe(false);
    expect(service.status().canauxSuivis).toBe(0);
  });
});
