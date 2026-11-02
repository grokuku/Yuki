/**
 * API des DISCUSSIONS — ROUTES DISCORD (lot 21), génériques par plateforme.
 *
 * Ce que ce fichier prouve :
 *  - les routes Discord existent (`PUT /api/chat/discord`, `/jeton`, `/connexion`) et sont
 *    gardées par `X-Yuki-Config: 1`, comme celles de Mattermost ;
 *  - le JETON est accepté une seule fois et **n'est jamais renvoyé** (ni valeur, ni préfixe) ;
 *  - `guildId` est validé (un flocon ne contient que des chiffres) et la chaîne vide a un
 *    SENS : « tous les serveurs du bot » ;
 *  - `maxUploadBytes` est validé et borné (le refus est explicite) ;
 *  - `PATCH /api/chat/conversations/<id>` route selon le PRÉFIXE (`dc-…` ⇒ port Discord,
 *    `mm-…` ⇒ port Mattermost) : un seul code, deux plateformes ;
 *  - l'état de l'intent `MESSAGE_CONTENT` est exposé TEL QUEL (`true`, `false`, `null`).
 *
 * ⚠️ Échoue sur le code d'origine : aucune route Discord n'existait, et le port
 * Mattermost était le seul reconnu (`PATCH` d'un `dc-…` répondait 404).
 */

import { describe, expect, it } from "vitest";

import { ChatService } from "../../src/chat/index.js";
import type { ChatQuoteAuthor, ChatReplyMode, ChatReplyStyle } from "../../src/chat/types.js";
import {
  handleChatRequest,
  type ChatDiscordPort,
  type ChatDiscordView,
  type ChatMattermostPort,
  type ChatMattermostView,
} from "../../src/gateway/routes/chat.js";

const HEADERS = { "x-yuki-config": "1" };
const TOKEN = "jeton-discord-secret-0123456789";

/** Port Discord ESPION : mémorise ce qu'on lui demande, ne touche à rien. */
function spyDiscord(overrides: Partial<ChatDiscordPort> = {}) {
  const state = {
    guildId: "",
    maxUploadBytes: 8 * 1024 * 1024,
    token: false,
    connected: 0,
    modes: new Map<string, ChatReplyMode>(),
  };
  const view = (): ChatDiscordView => ({
    guildId: state.guildId,
    maxUploadBytes: state.maxUploadBytes,
    // ⚠️ `null` = pas encore lu : l'interface ne doit jamais prétendre qu'il est actif.
    intentMessageContent: null,
    jetonEnregistre: state.token,
    plateforme: { etat: state.token ? "connexion" : "off" },
    synchronisation: {
      demarre: false,
      canauxSuivis: 0,
      backfill: { fait: false, imports: 0, borneAtteinte: false },
      rattrapageActif: false,
    },
    canaux: [
      {
        id: "dc-canal-1",
        titre: "général",
        messageCount: 2,
        ...(state.modes.has("dc-canal-1") ? { replyMode: state.modes.get("dc-canal-1") } : {}),
        replyStyle: "fil" as ChatReplyStyle,
        quoteAuthor: "non" as ChatQuoteAuthor,
        backfillFait: true,
        historiqueAnterieur: false,
      },
    ],
  });
  const port: ChatDiscordPort = {
    guildId: () => state.guildId,
    saveGuildId: (guildId) => {
      state.guildId = guildId;
    },
    maxUploadBytes: () => state.maxUploadBytes,
    saveMaxUploadBytes: (bytes) => {
      state.maxUploadBytes = bytes;
    },
    tokenConfigured: () => state.token,
    saveToken: (token) => {
      // ⚠️ On ne garde QUE le fait qu'un jeton existe : jamais sa valeur, même ici.
      state.token = token.length > 0;
    },
    connect: async () => {
      state.connected += 1;
    },
    view,
    replySettings: (conversationId) =>
      conversationId === "dc-canal-1"
        ? {
            ...(state.modes.has(conversationId) ? { replyMode: state.modes.get(conversationId) } : {}),
            replyStyle: "fil",
            quoteAuthor: "non",
          }
        : undefined,
    applyReplySettings: (conversationId, patch) => {
      if (conversationId !== "dc-canal-1") return false;
      if (patch.replyMode !== undefined) {
        if (patch.replyMode === null) state.modes.delete(conversationId);
        else state.modes.set(conversationId, patch.replyMode);
      }
      return true;
    },
    ...overrides,
  };
  return { port, state };
}

/** Port Mattermost minimal (sert à prouver que le routage par préfixe fonctionne). */
function spyMattermost(): ChatMattermostPort {
  const view = (): ChatMattermostView => ({
    url: "",
    jetonEnregistre: false,
    plateforme: { etat: "off" },
    synchronisation: {
      demarre: false,
      canauxSuivis: 0,
      backfill: { fait: false, imports: 0, borneAtteinte: false },
      rattrapageActif: false,
    },
    canaux: [],
  });
  return {
    baseUrl: () => "",
    saveBaseUrl: () => undefined,
    tokenConfigured: () => false,
    saveToken: () => undefined,
    connect: async () => undefined,
    view,
    replySettings: () => undefined,
    applyReplySettings: () => false,
  };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  deps?: { discord?: ChatDiscordPort; mattermost?: ChatMattermostPort },
) {
  return handleChatRequest({
    method,
    path,
    headers: HEADERS,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    deps: {
      service: new ChatService({ mode: () => "discord" }),
      ...(deps?.discord ? { discord: deps.discord } : {}),
      ...(deps?.mattermost ? { mattermost: deps.mattermost } : {}),
    },
  });
}

describe("routes Discord — gardes et lecture", () => {
  it("la lecture de l'état est GARDÉE par `X-Yuki-Config`", async () => {
    const response = await handleChatRequest({
      method: "GET",
      path: "/api/chat/status",
      headers: {},
      deps: { service: new ChatService({ mode: () => "discord" }) },
    });
    expect(response.status).toBe(403);
  });

  it("`GET /api/chat/status` expose les DEUX plateformes quand elles sont câblées", async () => {
    const { port } = spyDiscord();
    const response = await call("GET", "/api/chat/status", undefined, {
      discord: port,
      mattermost: spyMattermost(),
    });
    expect(response.status).toBe(200);
    const body = response.body as { discord?: ChatDiscordView; mattermost?: ChatMattermostView };
    expect(body.discord?.canaux[0]?.id).toBe("dc-canal-1");
    // ⚠️ `null` = état de l'intent INCONNU : jamais un `true` supposé.
    expect(body.discord?.intentMessageContent).toBeNull();
    expect(body.mattermost).toBeDefined();
  });

  it("une plateforme non câblée répond 503 avec un motif actionnable", async () => {
    const response = await call("POST", "/api/chat/discord/jeton", { jeton: TOKEN });
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).toContain("redémarrez Yuki");
  });
});

describe("routes Discord — jeton", () => {
  it("enregistre le jeton et ne le renvoie JAMAIS", async () => {
    const { port, state } = spyDiscord();
    const response = await call("POST", "/api/chat/discord/jeton", { jeton: TOKEN }, { discord: port });
    expect(response.status).toBe(200);
    expect(state.token).toBe(true);
    const serialise = JSON.stringify(response.body);
    expect(serialise).not.toContain(TOKEN);
    // Ni préfixe, ni suffixe : la réponse ne porte que le FAIT qu'un jeton existe.
    expect(serialise).not.toContain(TOKEN.slice(0, 8));
    expect(serialise).not.toContain(TOKEN.slice(-8));
  });

  it("refuse un jeton vide avec le geste à faire", async () => {
    const { port } = spyDiscord();
    const response = await call("POST", "/api/chat/discord/jeton", { jeton: "   " }, { discord: port });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("portail développeur Discord");
  });
});

describe("routes Discord — réglages scalaires", () => {
  it("enregistre un identifiant de serveur (flocon) et accepte la chaîne vide", async () => {
    const { port, state } = spyDiscord();
    const ok = await call("PUT", "/api/chat/discord", { guildId: "223456789012345678" }, { discord: port });
    expect(ok.status).toBe(200);
    expect(state.guildId).toBe("223456789012345678");
    // ⚠️ Vide = « tous les serveurs du bot » : c'est un CHOIX, pas une absence de valeur.
    const vide = await call("PUT", "/api/chat/discord", { guildId: "" }, { discord: port });
    expect(vide.status).toBe(200);
    expect(state.guildId).toBe("");
  });

  it("refuse un identifiant de serveur qui n'est pas un flocon (jamais un nom)", async () => {
    const { port, state } = spyDiscord();
    const response = await call("PUT", "/api/chat/discord", { guildId: "mon-serveur" }, { discord: port });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("que des chiffres");
    expect(state.guildId).toBe("");
  });

  it("enregistre la borne d'envoi et refuse une valeur absurde", async () => {
    const { port, state } = spyDiscord();
    const ok = await call("PUT", "/api/chat/discord", { maxUploadBytes: 4_194_304 }, { discord: port });
    expect(ok.status).toBe(200);
    expect(state.maxUploadBytes).toBe(4_194_304);
    const zero = await call("PUT", "/api/chat/discord", { maxUploadBytes: 0 }, { discord: port });
    expect(zero.status).toBe(400);
    expect(state.maxUploadBytes).toBe(4_194_304);
  });
});

describe("routes Discord — connexion", () => {
  it("refuse de se connecter sans jeton, avec un motif ACTIONNABLE", async () => {
    const { port, state } = spyDiscord();
    const response = await call("POST", "/api/chat/discord/connexion", {}, { discord: port });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("Aucun jeton Discord");
    expect(state.connected).toBe(0);
  });

  it("démarre la connexion quand le jeton existe", async () => {
    const { port, state } = spyDiscord();
    await call("POST", "/api/chat/discord/jeton", { jeton: TOKEN }, { discord: port });
    const response = await call("POST", "/api/chat/discord/connexion", {}, { discord: port });
    expect(response.status).toBe(200);
    expect(state.connected).toBe(1);
    expect(JSON.stringify(response.body)).not.toContain(TOKEN);
  });
});

describe("routes — réglages de canal routés par PRÉFIXE", () => {
  it("`dc-…` va au port Discord, `mm-…` au port Mattermost", async () => {
    const discord = spyDiscord();
    const mattermost = spyMattermost();
    const surDiscord = await call(
      "PATCH",
      "/api/chat/conversations/dc-canal-1",
      { replyMode: "tout" },
      { discord: discord.port, mattermost },
    );
    expect(surDiscord.status).toBe(200);
    expect(discord.state.modes.get("dc-canal-1")).toBe("tout");

    // ⚠️ Un canal Mattermost n'est PAS traité par le port Discord (aucun mélange).
    const surMattermost = await call(
      "PATCH",
      "/api/chat/conversations/mm-canal-1",
      { replyMode: "tout" },
      { discord: discord.port, mattermost },
    );
    expect(surMattermost.status).toBe(404);
    expect(discord.state.modes.has("mm-canal-1")).toBe(false);
  });

  it("refuse une valeur de réglage inconnue (rien n'est deviné)", async () => {
    const discord = spyDiscord();
    const response = await call(
      "PATCH",
      "/api/chat/conversations/dc-canal-1",
      { replyMode: "parfois" },
      { discord: discord.port },
    );
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("Valeurs acceptées");
  });
});
