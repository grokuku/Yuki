/**
 * CÂBLAGE DES ROUTES → RECONNEXION À CHAUD (bug du 2026-11-14).
 *
 * ⚠️ CE QUE CE FICHIER VERROUILLE : la réconciliation des plateformes
 * (`AdaptateursChatBots.rafraichirBot`) ne sert à RIEN si aucune route ne
 * l'appelle. C'était exactement l'état d'origine : `PUT /api/bots/<id>/config`
 * écrivait `chat.mattermost.enabled = on` puis… rien. Aucun adaptateur, aucun
 * WebSocket, bot « hors ligne », aucun canal.
 *
 * Ce que ce fichier prouve :
 *  ① `PUT /api/bots/<id>/config` sur une clé de plateforme ⇒ `rafraichir(bot)` est
 *     appelé, et la réponse porte le bilan (donc l'état de connexion) ;
 *  ② une écriture SANS rapport avec une plateforme ne reconnecte rien ;
 *  ③ `POST /api/secrets` d'un jeton `YUKI_CHAT_<BOT>__<PLATEFORME>` ⇒ reconnexion
 *     du bot PROPRIÉTAIRE du jeton (le coller suffit, sans redémarrage) ;
 *  ④ `PUT /api/chat/mattermost` (URL d'instance) ⇒ reconnexion du bot de la pile ;
 *  ⑤ `POST /api/bots/<id>/plateformes` ⇒ resynchronisation des canaux ;
 *  ⑥ `GET /api/bots/<id>/config` porte l'ÉTAT de connexion du bot demandé ;
 *  ⑦ port ABSENT ⇒ la réponse DIT qu'un redémarrage est nécessaire (jamais un
 *     badge « à chaud » mensonger sans conséquence visible).
 *
 * Échoue sur le code d'origine : aucun de ces appels n'existait, et la réponse de
 * `PUT /api/bots/<id>/config` ne portait ni `plateformes` ni bilan.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChatService } from "../../src/chat/index.js";
import type {
  BilanPlateformesAChaud,
  PlateformesAChaudPort,
} from "../../src/chat/plateformes-a-chaud.js";
import { botDeSecretChat } from "../../src/chat/plateformes-a-chaud.js";
import { ConfigStore } from "../../src/config/store.js";
import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { handleConfigRequest } from "../../src/gateway/routes/config.js";
import { handleChatRequest, type ChatMattermostPort } from "../../src/gateway/routes/chat.js";
import { handleSecretsRequest } from "../../src/gateway/routes/secrets.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WRITE_HEADERS = { "x-yuki-config": "1", "content-type": "application/json" };
const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/** Port ESPION : retient les appels, rend un bilan neutre. */
function portEspion(): PlateformesAChaudPort & {
  appels: { methode: string; argument: string }[];
} {
  const appels: { methode: string; argument: string }[] = [];
  const bilan = (bot: string): BilanPlateformesAChaud => ({
    bot,
    connectes: [`${bot}:mattermost`],
    reconnectes: [],
    deconnectes: [],
    echecs: [],
  });
  return {
    appels,
    rafraichir: async (botId) => {
      appels.push({ methode: "rafraichir", argument: botId });
      return bilan(botId);
    },
    etat: (botId) => {
      appels.push({ methode: "etat", argument: botId });
      return {
        mattermost: {
          active: true,
          jetonEnregistre: true,
          adaptateur: true,
          etat: "on",
          canaux: 2,
        },
        discord: {
          active: false,
          jetonEnregistre: false,
          adaptateur: false,
          etat: "off",
          canaux: 0,
        },
      };
    },
    resynchroniser: async (botId) => {
      appels.push({ methode: "resynchroniser", argument: botId });
      return { canaux: 2 };
    },
    rafraichirPourSecret: async (nom) => {
      appels.push({ methode: "rafraichirPourSecret", argument: nom });
      return bilan("granolaf");
    },
  };
}

interface Banc {
  runtime: ReturnType<typeof createConfigRuntime>;
  deps: Parameters<typeof handleConfigRequest>[0]["deps"];
}

function banc(options: { port?: PlateformesAChaudPort } = {}): Banc {
  const root = mkdtempSync(join(tmpdir(), "yuki-plateformes-chaud-"));
  tempDirs.push(root);
  const env = loadEnv({
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: join(root, "state", "config.json"),
  });
  const runtime = createConfigRuntime({
    env,
    store: new ConfigStore(env.configStorePath),
    processEnv: {},
    promptDefaults: { light: "P", heavy: "H" },
  });
  const deps = {
    runtime,
    logger,
    botDuRun: runtime.botId,
    ...(options.port !== undefined ? { plateformes: options.port } : {}),
  } as Banc["deps"];
  return { runtime, deps };
}

async function configCall(b: Banc, method: string, path: string, body?: unknown) {
  const response = await handleConfigRequest({
    method,
    path,
    headers: { ...WRITE_HEADERS },
    body: body === undefined ? "" : JSON.stringify(body),
    deps: b.deps,
  });
  return { status: response.status, body: response.body as Record<string, unknown> };
}

describe("① PUT /api/bots/<id>/config d'une clé de plateforme ⇒ réconciliation", () => {
  it("activer Mattermost appelle `rafraichir` pour CE bot", async () => {
    const port = portEspion();
    const b = banc({ port });
    const { status, body } = await configCall(b, "PUT", "/api/bots/yuki/config", {
      "chat.mattermost.enabled": "on",
    });
    expect(status).toBe(200);
    expect(port.appels.filter((appel) => appel.methode === "rafraichir")).toEqual([
      { methode: "rafraichir", argument: "yuki" },
    ]);
    // La réponse porte le bilan : l'interface peut annoncer la connexion réelle.
    expect(body.plateformesApplication).toMatchObject({ bot: "yuki" });
    expect(body.plateformes).toMatchObject({ mattermost: { etat: "on" } });
  });

  it("changer l'URL appelle aussi `rafraichir` (reconnexion vers la nouvelle)", async () => {
    const port = portEspion();
    const b = banc({ port });
    const { status } = await configCall(b, "PUT", "/api/bots/yuki/config", {
      "chat.mattermost.url": "https://autre-serveur.example",
    });
    expect(status).toBe(200);
    expect(port.appels.some((appel) => appel.methode === "rafraichir")).toBe(true);
  });

  it("② une écriture sans rapport avec une plateforme ne reconnecte RIEN", async () => {
    const port = portEspion();
    const b = banc({ port });
    const { status } = await configCall(b, "PUT", "/api/bots/yuki/config", {
      // Clé MIXTE (donc acceptée sur l'écran du bot) sans rapport avec une connexion.
      "prompts.light": "Tu es Yuki, en français.",
    });
    expect(status).toBe(200);
    expect(port.appels.some((appel) => appel.methode === "rafraichir")).toBe(false);
  });
});

describe("③ POST /api/secrets d'un jeton de discussion ⇒ reconnexion du bot visé", () => {
  it("le nom du secret désigne son PROPRIÉTAIRE, pas le bot de la pile", async () => {
    const port = portEspion();
    const store = {
      isConfigured: () => true,
      list: () => [],
      has: () => false,
      lookup: () => undefined,
      set: () => ({ name: "x" }),
      delete: () => true,
    };
    const response = await handleSecretsRequest({
      method: "POST",
      path: "/api/secrets",
      headers: { ...WRITE_HEADERS },
      body: JSON.stringify({
        name: "YUKI_CHAT_GRANOLAF__MATTERMOST",
        value: "jeton-secret",
      }),
      deps: { store: store as never, logger, plateformes: port },
    });
    expect(response.status).toBe(200);
    expect(port.appels).toContainEqual({
      methode: "rafraichirPourSecret",
      argument: "YUKI_CHAT_GRANOLAF__MATTERMOST",
    });
  });

  it("la règle inverse du nom de secret est EXACTE (et prudente)", () => {
    expect(botDeSecretChat("YUKI_CHAT_GRANOLAF__MATTERMOST")).toEqual({
      botId: "granolaf",
      plateforme: "mattermost",
    });
    expect(botDeSecretChat("YUKI_CHAT_GRANOLAF_BIS__DISCORD")).toEqual({
      botId: "granolaf-bis",
      plateforme: "discord",
    });
    // Ancien nom d'instance : il ne désigne AUCUN bot (l'appelant tranche).
    expect(botDeSecretChat("YUKI_CHAT_MATTERMOST")).toBeNull();
    expect(botDeSecretChat("YUKI_SOURCE_YUKI__GITHUB")).toBeNull();
  });
});

describe("④ PUT /api/chat/mattermost (URL d'instance) ⇒ reconnexion de la pile", () => {
  it("l'URL enregistrée déclenche la réconciliation du bot du run", async () => {
    const port = portEspion();
    const state = { baseUrl: "" };
    const mattermost: ChatMattermostPort = {
      baseUrl: () => state.baseUrl,
      tokenConfigured: () => true,
      saveBaseUrl: (url) => {
        state.baseUrl = url;
      },
      saveToken: () => undefined,
      connect: async () => undefined,
      deconnecter: async () => undefined,
      miroir: () => ({ conversations: 0, messages: 0, octets: 0 }),
      supprimerMiroir: () => ({ conversations: 0, messages: 0, octets: 0 }),
      view: () => ({ url: state.baseUrl }) as never,
      replySettings: () => undefined,
      applyReplySettings: () => false,
    };
    const response = await handleChatRequest({
      method: "PUT",
      path: "/api/chat/mattermost",
      headers: { ...WRITE_HEADERS },
      body: JSON.stringify({ baseUrl: "https://mm.example.fr" }),
      deps: {
        service: new ChatService({ mode: () => "mattermost" }),
        mattermost,
        logger,
        plateformes: port,
        botDuRun: "yuki",
      },
    });
    expect(response.status).toBe(200);
    expect(port.appels).toContainEqual({ methode: "rafraichir", argument: "yuki" });
    expect((response.body as Record<string, unknown>).plateformesApplication).toMatchObject({
      bot: "yuki",
    });
  });
});

describe("⑤ POST /api/bots/<id>/plateformes ⇒ resynchronisation des canaux", () => {
  it("appelle `resynchroniser` pour ce bot et rend le nombre de canaux", async () => {
    const port = portEspion();
    const b = banc({ port });
    const { status, body } = await configCall(b, "POST", "/api/bots/yuki/plateformes");
    expect(status).toBe(200);
    expect(port.appels).toContainEqual({ methode: "resynchroniser", argument: "yuki" });
    expect(body.resynchronisation).toEqual({ canaux: 2 });
  });

  it("GET est refusé (la route interroge la plateforme et écrit le miroir)", async () => {
    const b = banc({ port: portEspion() });
    const { status } = await configCall(b, "GET", "/api/bots/yuki/plateformes");
    expect(status).toBe(405);
  });
});

describe("⑥ GET /api/bots/<id>/config porte l'état de connexion du bot", () => {
  it("l'état est celui du bot DEMANDÉ", async () => {
    const b = banc({ port: portEspion() });
    const { status, body } = await configCall(b, "GET", "/api/bots/yuki/config");
    expect(status).toBe(200);
    expect(body.plateformes).toMatchObject({
      mattermost: { active: true, adaptateur: true, etat: "on", canaux: 2 },
      discord: { active: false, etat: "off" },
    });
  });
});

describe("⑦ sans port, le REDÉMARRAGE nécessaire est DIT", () => {
  it("la réponse porte `reconnexionIndisponible` au lieu d'un succès muet", async () => {
    const b = banc();
    const { status, body } = await configCall(b, "PUT", "/api/bots/yuki/config", {
      "chat.mattermost.enabled": "on",
    });
    expect(status).toBe(200);
    const application = body.plateformesApplication as {
      reconnexionIndisponible?: string;
    };
    expect(application.reconnexionIndisponible).toContain("redémarrage");
    expect(body.plateformes).toBeNull();
  });
});
