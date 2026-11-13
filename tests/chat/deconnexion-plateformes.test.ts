/**
 * LOT 30 — DÉBRANCHER / SUPPRIMER une connexion (Mattermost, Discord).
 *
 * Ce que ce fichier prouve, avec des PIÈCES RÉELLES (adaptateur Mattermost, serveur
 * fixture HTTP+WS, miroir sur disque, coffre chiffré) :
 *  ① **Débrancher** (`DELETE /api/chat/<plateforme>/connexion`) efface le JETON du coffre
 *    et ARRÊTE la synchronisation (WebSocket fermé, balayeur arrêté) — ⚠️ et laisse le
 *    MIROIR INTACT : les conversations restent lisibles, remettre le jeton suffit ;
 *  ② **Supprimer** (`DELETE /api/chat/<plateforme>/miroir`) efface le jeton ET le miroir
 *    de CETTE plateforme seulement (un `mm-…` n'emporte jamais un `dc-…`) ;
 *  ③ Supprimer exige une CONFIRMATION explicite (`{"confirmation": true}`) : sans elle,
 *    refus 400 et aucune destruction ;
 *  ④ après suppression, `chat.mode` retombe sur `local` si c'était la plateforme visée ;
 *  ⑤ une tentative de TRAVERSÉE de chemin (`../`) ne sort pas du dossier du miroir.
 *
 * ⚠️ Échoue sur le code d'origine : ces deux routes n'existent pas (404), `purgePlatform`
 * et `statsOf` non plus.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChatService } from "../../src/chat/index.js";
import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import type { RemotePlatform } from "../../src/chat/types.js";
import {
  handleChatRequest,
  type ChatDiscordPort,
  type ChatMattermostPort,
  type ChatPlatformChannelView,
} from "../../src/gateway/routes/chat.js";
import { DISCORD_TOKEN_SECRET_NAME, MATTERMOST_TOKEN_SECRET_NAME } from "../../src/secrets/references.js";
import { SecretStore } from "../../src/secrets/store.js";
import {
  MM_CHANNEL,
  MM_TOKEN,
  openMmMirror,
  startMmFixture,
  waitFor,
} from "./mm-reply-fixture.js";

const HEADERS = { "x-yuki-config": "1" };
const CLE_COFFRE = "cle-de-test-deconnexion-0123456789";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Coffre RÉEL sur un fichier temporaire (aucun double : on veut la vraie suppression). */
function ouvrirCoffre(): SecretStore {
  const root = mkdtempSync(join(tmpdir(), "yuki-lot30-coffre-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return new SecretStore({ path: join(root, "secrets.vault"), key: CLE_COFFRE });
}

/** Canaux d'une plateforme, exactement comme les ports de `src/index.ts` les rendent. */
function canauxDe(store: ChatMirrorStore, platform: RemotePlatform): ChatPlatformChannelView[] {
  return Object.entries(store.records())
    .filter(([, record]) => record.platform === platform)
    .map(([id, record]) => ({
      id,
      titre: record.title,
      messageCount: record.messageCount,
      ...(record.replyMode !== undefined ? { replyMode: record.replyMode } : {}),
      replyStyle: record.replyStyle ?? "fil",
      quoteAuthor: record.quoteAuthor ?? "non",
      backfillFait: record.backfillDone,
      historiqueAnterieur: record.historiqueAnterieur === true || record.borneAtteinte === true,
    }));
}

/**
 * Port MATTERMOST câblé comme `src/index.ts:1949` le fait : `deconnecter` = arrêt de la
 * synchro PUIS effacement du jeton, le miroir n'étant jamais touché.
 */
function portMattermost(
  adapter: MattermostChatAdapter,
  store: ChatMirrorStore,
  coffre: SecretStore,
  url: string,
): ChatMattermostPort {
  return {
    baseUrl: () => url,
    tokenConfigured: () => coffre.has(MATTERMOST_TOKEN_SECRET_NAME),
    saveBaseUrl: () => undefined,
    saveToken: (jeton) => coffre.set(MATTERMOST_TOKEN_SECRET_NAME, jeton, "test"),
    connect: () => adapter.connect(),
    deconnecter: async () => {
      await adapter.disconnect();
      coffre.delete(MATTERMOST_TOKEN_SECRET_NAME);
    },
    miroir: () => store.statsOf("mattermost"),
    supprimerMiroir: () => store.purgePlatform("mattermost"),
    view: () => ({
      url,
      active: true,
      jetonEnregistre: coffre.has(MATTERMOST_TOKEN_SECRET_NAME),
      plateforme: adapter.status(),
      synchronisation: adapter.syncStatus(),
      miroir: store.statsOf("mattermost"),
      canaux: canauxDe(store, "mattermost"),
    }),
    replySettings: (conversationId) => adapter.replySettings(conversationId),
    applyReplySettings: () => false,
  };
}

/** Port DISCORD minimal : même contrat de suppression, sans passerelle réseau. */
function portDiscord(store: ChatMirrorStore, coffre: SecretStore): ChatDiscordPort {
  return {
    guildId: () => "",
    saveGuildId: () => undefined,
    maxUploadBytes: () => 8 * 1024 * 1024,
    saveMaxUploadBytes: () => undefined,
    tokenConfigured: () => coffre.has(DISCORD_TOKEN_SECRET_NAME),
    saveToken: (jeton) => coffre.set(DISCORD_TOKEN_SECRET_NAME, jeton, "test"),
    connect: async () => undefined,
    deconnecter: async () => {
      coffre.delete(DISCORD_TOKEN_SECRET_NAME);
    },
    miroir: () => store.statsOf("discord"),
    supprimerMiroir: () => store.purgePlatform("discord"),
    view: () => ({
      guildId: "",
      maxUploadBytes: 8 * 1024 * 1024,
      intentMessageContent: null,
      active: true,
      jetonEnregistre: coffre.has(DISCORD_TOKEN_SECRET_NAME),
      plateforme: { etat: "off" },
      synchronisation: {
        demarre: false,
        canauxSuivis: 0,
        backfill: { fait: false, imports: 0, borneAtteinte: false },
        rattrapageActif: false,
      },
      miroir: store.statsOf("discord"),
      canaux: canauxDe(store, "discord"),
    }),
    replySettings: () => undefined,
    applyReplySettings: () => false,
  };
}

/** Message minimal pour remplir le miroir d'une plateforme. */
function message(conversationId: string, id: string) {
  return {
    conversationId,
    remoteId: id,
    author: { id: "humain-1", nom: "Humain", estBot: false },
    role: "user" as const,
    text: `message ${id}`,
    sentAt: "2026-11-05T10:00:00.000Z",
  };
}

/** Remplit le miroir : une conversation Mattermost et une Discord, avec leurs fichiers. */
function remplirMiroir(store: ChatMirrorStore): void {
  store.ensureConversation({
    conversationId: "mm-canal-1",
    platform: "mattermost",
    remoteId: "canal-1",
    title: "Général",
  });
  store.ensureConversation({
    conversationId: "dc-salon-1",
    platform: "discord",
    remoteId: "salon-1",
    title: "général",
  });
  store.upsert(message("mm-canal-1", "p1"));
  store.upsert(message("mm-canal-1", "p2"));
  store.upsert(message("dc-salon-1", "d1"));
}

function deps(options: {
  mode: () => string;
  mattermost?: ChatMattermostPort;
  discord?: ChatDiscordPort;
}) {
  const modes: string[] = [];
  return {
    modes,
    deps: {
      service: new ChatService({ mode: options.mode }),
      ...(options.mattermost ? { mattermost: options.mattermost } : {}),
      ...(options.discord ? { discord: options.discord } : {}),
      saveMode: (mode: string) => {
        modes.push(mode);
      },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    },
  };
}

describe("① DÉBRANCHER — le jeton part, la synchro s'arrête, le miroir RESTE", () => {
  it("jeton effacé, WebSocket fermé, synchro arrêtée, conversations toujours lisibles", async () => {
    const fixture = await startMmFixture(cleanups, {
      backlog: [
        {
          id: "vieux-1",
          channel_id: MM_CHANNEL,
          user_id: "humain-1",
          message: "un message d'hier",
          create_at: Date.now() - 3_600_000,
        },
      ],
    });
    const store = openMmMirror(cleanups);
    const coffre = ouvrirCoffre();
    coffre.set(MATTERMOST_TOKEN_SECRET_NAME, MM_TOKEN, "Jeton du bot Mattermost");
    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => coffre.lookup(MATTERMOST_TOKEN_SECRET_NAME),
      store,
      pollIntervalMs: 0,
    });
    cleanups.push(() => adapter.disconnect());
    const port = portMattermost(adapter, store, coffre, fixture.baseUrl);
    const { deps: apiDeps } = deps({ mode: () => "mattermost", mattermost: port });

    await adapter.connect();
    // La synchro a réellement démarré : un canal miroir existe et la socket est ouverte.
    await waitFor(() => store.conversations().length > 0, "le canal miroir importé");
    await waitFor(() => fixture.open > 0, "la socket temps réel ouverte");
    expect(adapter.syncStatus().demarre).toBe(true);

    const reponse = await handleChatRequest({
      method: "DELETE",
      path: "/api/chat/mattermost/connexion",
      headers: HEADERS,
      deps: apiDeps,
    });
    expect(reponse.status).toBe(200);

    // ① le JETON est parti du coffre.
    expect(coffre.has(MATTERMOST_TOKEN_SECRET_NAME)).toBe(false);
    // ② la synchro est ARRÊTÉE pour de vrai, le WebSocket est fermé.
    expect(adapter.syncStatus().demarre).toBe(false);
    await waitFor(() => fixture.open === 0, "la socket temps réel fermée");
    // ③ ⚠️ LE MIROIR EST INTACT : conversations ET messages toujours là, lisibles.
    const conversations = store.conversations();
    expect(conversations.map((conversation) => conversation.id)).toContain("mm-canal-1");
    expect(store.messages("mm-canal-1").length).toBeGreaterThan(0);
    expect(store.statsOf("mattermost").conversations).toBe(1);
    expect(existsSync(join(store.messagesDir, "mm-canal-1.jsonl"))).toBe(true);
  });

  it("sans jeton au coffre, débrancher reste sans effet destructeur (idempotent)", async () => {
    const store = openMmMirror(cleanups);
    const coffre = ouvrirCoffre();
    const adapter = new MattermostChatAdapter({
      baseUrl: () => "",
      token: () => coffre.lookup(MATTERMOST_TOKEN_SECRET_NAME),
      store,
      pollIntervalMs: 0,
    });
    cleanups.push(() => adapter.disconnect());
    remplirMiroir(store);
    const { deps: apiDeps } = deps({
      mode: () => "local",
      mattermost: portMattermost(adapter, store, coffre, ""),
    });
    const reponse = await handleChatRequest({
      method: "DELETE",
      path: "/api/chat/mattermost/connexion",
      headers: HEADERS,
      deps: apiDeps,
    });
    expect(reponse.status).toBe(200);
    expect(store.statsOf("mattermost")).toEqual({ conversations: 1, messages: 2, octets: expect.any(Number) });
  });

  it("la route reste GARDÉE par `X-Yuki-Config` (403 sans l'en-tête)", async () => {
    const store = openMmMirror(cleanups);
    const coffre = ouvrirCoffre();
    const adapter = new MattermostChatAdapter({
      baseUrl: () => "",
      token: () => undefined,
      store,
      pollIntervalMs: 0,
    });
    cleanups.push(() => adapter.disconnect());
    const { deps: apiDeps } = deps({
      mode: () => "local",
      mattermost: portMattermost(adapter, store, coffre, ""),
    });
    const reponse = await handleChatRequest({
      method: "DELETE",
      path: "/api/chat/mattermost/connexion",
      headers: {},
      deps: apiDeps,
    });
    expect(reponse.status).toBe(403);
  });
});

describe("② SUPPRIMER — jeton ET miroir, et l'autre plateforme INTACTE", () => {
  it("efface les conversations Mattermost, garde celles de Discord (fichiers compris)", async () => {
    const store = openMmMirror(cleanups);
    const coffre = ouvrirCoffre();
    coffre.set(MATTERMOST_TOKEN_SECRET_NAME, MM_TOKEN, "Jeton du bot Mattermost");
    coffre.set(DISCORD_TOKEN_SECRET_NAME, "jeton-discord-0123456789", "Jeton du bot Discord");
    remplirMiroir(store);
    const adapter = new MattermostChatAdapter({
      baseUrl: () => "",
      token: () => coffre.lookup(MATTERMOST_TOKEN_SECRET_NAME),
      store,
      pollIntervalMs: 0,
    });
    cleanups.push(() => adapter.disconnect());
    const { deps: apiDeps } = deps({
      mode: () => "local",
      mattermost: portMattermost(adapter, store, coffre, ""),
      discord: portDiscord(store, coffre),
    });

    // Ce que la confirmation doit pouvoir ANNONCER avant l'action.
    expect(store.statsOf("mattermost")).toMatchObject({ conversations: 1, messages: 2 });

    const reponse = await handleChatRequest({
      method: "DELETE",
      path: "/api/chat/mattermost/miroir",
      headers: HEADERS,
      body: JSON.stringify({ confirmation: true }),
      deps: apiDeps,
    });
    expect(reponse.status).toBe(200);

    // ① jeton ET miroir Mattermost effacés.
    expect(coffre.has(MATTERMOST_TOKEN_SECRET_NAME)).toBe(false);
    expect(store.statsOf("mattermost")).toEqual({ conversations: 0, messages: 0, octets: 0 });
    expect(existsSync(join(store.messagesDir, "mm-canal-1.jsonl"))).toBe(false);
    expect(store.conversations().some((conversation) => conversation.platform === "mattermost")).toBe(
      false,
    );

    // ② ⚠️ L'AUTRE PLATEFORME EST INTACTE : conversation, messages ET fichier.
    expect(store.statsOf("discord").conversations).toBe(1);
    expect(store.messages("dc-salon-1")).toHaveLength(1);
    expect(existsSync(join(store.messagesDir, "dc-salon-1.jsonl"))).toBe(true);
    expect(coffre.has(DISCORD_TOKEN_SECRET_NAME)).toBe(true);
  });

  it("sans corps de confirmation, REFUS 400 et rien n'est détruit", async () => {
    const store = openMmMirror(cleanups);
    const coffre = ouvrirCoffre();
    coffre.set(MATTERMOST_TOKEN_SECRET_NAME, MM_TOKEN, "Jeton du bot Mattermost");
    remplirMiroir(store);
    const adapter = new MattermostChatAdapter({
      baseUrl: () => "",
      token: () => coffre.lookup(MATTERMOST_TOKEN_SECRET_NAME),
      store,
      pollIntervalMs: 0,
    });
    cleanups.push(() => adapter.disconnect());
    const { deps: apiDeps } = deps({
      mode: () => "local",
      mattermost: portMattermost(adapter, store, coffre, ""),
    });

    for (const corps of [undefined, "", "{}", JSON.stringify({ confirmation: false })]) {
      const reponse = await handleChatRequest({
        method: "DELETE",
        path: "/api/chat/mattermost/miroir",
        headers: HEADERS,
        ...(corps !== undefined ? { body: corps } : {}),
        deps: apiDeps,
      });
      expect(reponse.status).toBe(400);
      expect((reponse.body as { error: string }).error).toBe("confirmation_requise");
    }
    // Rien n'a bougé : ni coffre, ni miroir.
    expect(coffre.has(MATTERMOST_TOKEN_SECRET_NAME)).toBe(true);
    expect(store.statsOf("mattermost")).toMatchObject({ conversations: 1, messages: 2 });
  });

  it("③ `chat.mode` retombe sur `local` quand il désignait la plateforme supprimée", async () => {
    const store = openMmMirror(cleanups);
    const coffre = ouvrirCoffre();
    coffre.set(MATTERMOST_TOKEN_SECRET_NAME, MM_TOKEN, "Jeton du bot Mattermost");
    remplirMiroir(store);
    const adapter = new MattermostChatAdapter({
      baseUrl: () => "",
      token: () => coffre.lookup(MATTERMOST_TOKEN_SECRET_NAME),
      store,
      pollIntervalMs: 0,
    });
    cleanups.push(() => adapter.disconnect());
    const { deps: apiDeps, modes } = deps({
      mode: () => "mattermost",
      mattermost: portMattermost(adapter, store, coffre, ""),
    });

    const reponse = await handleChatRequest({
      method: "DELETE",
      path: "/api/chat/mattermost/miroir",
      headers: HEADERS,
      body: JSON.stringify({ confirmation: true }),
      deps: apiDeps,
    });
    expect(reponse.status).toBe(200);
    // ⚠️ Le mode est ÉCRIT par le même chemin que `PUT /api/config`, et la réponse le dit.
    expect(modes).toEqual(["local"]);
    expect((reponse.body as { mode: string }).mode).toBe("local");
  });

  it("supprimer la plateforme qui n'est PAS le mode courant ne change pas le mode", async () => {
    const store = openMmMirror(cleanups);
    const coffre = ouvrirCoffre();
    coffre.set(DISCORD_TOKEN_SECRET_NAME, "jeton-discord-0123456789", "Jeton du bot Discord");
    remplirMiroir(store);
    const { deps: apiDeps, modes } = deps({
      mode: () => "mattermost",
      discord: portDiscord(store, coffre),
    });
    const reponse = await handleChatRequest({
      method: "DELETE",
      path: "/api/chat/discord/miroir",
      headers: HEADERS,
      body: JSON.stringify({ confirmation: true }),
      deps: apiDeps,
    });
    expect(reponse.status).toBe(200);
    expect(modes).toEqual([]);
    expect((reponse.body as { mode: string }).mode).toBe("mattermost");
  });
});

describe("④ TRAVERSÉE de chemin — confinée au dossier du miroir", () => {
  it("un identifiant `../…` ne sort pas de `chat-mirror/` et n'efface rien dehors", () => {
    const racine = mkdtempSync(join(tmpdir(), "yuki-lot30-traversee-"));
    cleanups.push(() => rmSync(racine, { recursive: true, force: true }));
    const messagesDir = join(racine, "chat-mirror");
    const indexPath = join(racine, "chat-mirror.json");
    // Sentinelle HORS du dossier des messages : elle ne doit pas bouger.
    const sentinelle = join(racine, "sentinelle.jsonl");
    writeFileSync(sentinelle, "à ne pas effacer\n");

    // Un index MODIFIÉ À LA MAIN : identifiant hostile rattaché à Mattermost.
    writeFileSync(
      indexPath,
      JSON.stringify({
        schemaVersion: 1,
        settings: {},
        conversations: {
          "mm-canal-1": {
            platform: "mattermost",
            remoteId: "canal-1",
            title: "Général",
            messageCount: 1,
            backfillDone: true,
          },
          "../../../etc/passwd": {
            platform: "mattermost",
            remoteId: "evil",
            title: "evil",
            messageCount: 1,
            backfillDone: false,
          },
          "dc-salon-1": {
            platform: "discord",
            remoteId: "salon-1",
            title: "général",
            messageCount: 1,
            backfillDone: true,
          },
        },
      }),
    );
    const storeHostile = ChatMirrorStore.open({ indexPath, messagesDir });

    const supprime = storeHostile.purgePlatform("mattermost");

    // ⚠️ La sentinelle est intacte : aucun `../` n'a pu sortir du dossier.
    expect(existsSync(sentinelle)).toBe(true);
    // Les deux conversations Mattermost (dont l'identifiant hostile) ont disparu.
    expect(supprime.conversations).toBe(2);
    expect(storeHostile.statsOf("mattermost")).toEqual({ conversations: 0, messages: 0, octets: 0 });
    // L'autre plateforme n'est pas concernée par la purge.
    expect(storeHostile.statsOf("discord").conversations).toBe(1);
    // Aucun fichier créé hors du dossier, et aucun nom ne porte de `..`.
    const restants = existsSync(messagesDir) ? readdirSync(messagesDir) : [];
    expect(restants.every((nom) => !nom.includes(".."))).toBe(true);
  });

  it("un chemin de route avec `../` ne touche aucune route de discussion (404)", async () => {
    const store = openMmMirror(cleanups);
    const coffre = ouvrirCoffre();
    remplirMiroir(store);
    const { deps: apiDeps } = deps({ mode: () => "local", discord: portDiscord(store, coffre) });
    for (const chemin of [
      "/api/chat/../../etc/passwd",
      "/api/chat/mattermost/../miroir",
      "/api/chat/mattermost/miroir/../../connexion",
    ]) {
      const reponse = await handleChatRequest({
        method: "DELETE",
        path: chemin,
        headers: HEADERS,
        body: JSON.stringify({ confirmation: true }),
        deps: apiDeps,
      });
      expect(reponse.status).toBe(404);
    }
    // Le miroir n'a pas été touché.
    expect(store.statsOf("discord").conversations).toBe(1);
  });
});
