/**
 * API des DISCUSSIONS — routes Mattermost ajoutées au lot 2.
 *
 * Ce que ce fichier prouve, sans réseau ni serveur Mattermost :
 *  - l'URL du serveur est VALIDÉE avant d'être enregistrée (et le refus est explicite) ;
 *  - le JETON est accepté en écriture, une seule fois, et n'est **JAMAIS** renvoyé
 *    (ni la valeur, ni un préfixe) ;
 *  - « Se connecter » refuse de démarrer sans jeton ou sans URL, avec un motif
 *    ACTIONNABLE ;
 *  - le MODE DE RÉPONSE se règle PAR CANAL (`PATCH`), et un canal inconnu est un 404 ;
 *  - toutes les routes restent GARDÉES par l'en-tête `X-Yuki-Config: 1`.
 *
 * ⚠️ Échoue sur le code d'origine : ces routes n'existent pas (404).
 */

import { describe, expect, it } from "vitest";

import { ChatService } from "../../src/chat/index.js";
import type { ChatReplyMode } from "../../src/chat/types.js";
import {
  handleChatRequest,
  type ChatMattermostPort,
  type ChatMattermostView,
} from "../../src/gateway/routes/chat.js";

const HEADERS = { "x-yuki-config": "1" };

/** Port Mattermost ESPION : mémorise ce qu'on lui demande, ne touche à rien. */
function spyPort(overrides: Partial<ChatMattermostPort> = {}) {
  const state = {
    baseUrl: "",
    token: false,
    connected: 0,
    modes: new Map<string, ChatReplyMode>(),
    canaux: ["mm-canal-1"],
  };
  const view = (): ChatMattermostView => ({
    url: state.baseUrl,
    jetonEnregistre: state.token,
    plateforme: { etat: state.token ? "connexion" : "off" },
    synchronisation: {
      demarre: false,
      canauxSuivis: state.modes.size,
      backfill: { fait: false, imports: 0, borneAtteinte: false },
      rattrapageActif: false,
    },
    canaux: [...state.modes].map(([id, mode]) => ({
      id,
      titre: id,
      messageCount: 1,
      replyMode: mode,
      backfillFait: true,
      historiqueAnterieur: false,
    })),
  });
  const port: ChatMattermostPort = {
    baseUrl: () => state.baseUrl,
    tokenConfigured: () => state.token,
    saveBaseUrl: (url) => {
      state.baseUrl = url;
    },
    saveToken: (token) => {
      // ⚠️ On ne garde QUE le fait qu'un jeton existe : jamais sa valeur, même ici.
      state.token = token.length > 0;
    },
    connect: async () => {
      state.connected += 1;
    },
    view,
    replyMode: (conversationId) => state.modes.get(conversationId),
    setReplyMode: (conversationId, mode) => {
      if (!state.canaux.includes(conversationId)) return false;
      if (mode === undefined) state.modes.delete(conversationId);
      else state.modes.set(conversationId, mode);
      return true;
    },
    ...overrides,
  };
  return { port, state };
}

function deps(port?: ChatMattermostPort) {
  const service = new ChatService({ mode: () => "mattermost" });
  return { service, ...(port ? { mattermost: port } : {}) };
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  port?: ChatMattermostPort,
) {
  return handleChatRequest({
    method,
    path,
    headers: HEADERS,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    deps: deps(port),
  });
}

describe("garde — aucune route de discussion n'est publique", () => {
  it("sans en-tête `X-Yuki-Config: 1`, tout est refusé (403)", async () => {
    for (const [method, path] of [
      ["GET", "/api/chat/status"],
      ["PUT", "/api/chat/mattermost"],
      ["POST", "/api/chat/mattermost/jeton"],
      ["POST", "/api/chat/mattermost/connexion"],
      ["PATCH", "/api/chat/conversations/mm-canal-1"],
    ] as const) {
      const response = await handleChatRequest({
        method,
        path,
        headers: {},
        deps: deps(spyPort().port),
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });
});

describe("URL du serveur — validée avant d'être enregistrée", () => {
  it("accepte une URL http(s) et la transmet au port", async () => {
    const { port, state } = spyPort();
    const response = await call("PUT", "/api/chat/mattermost", { baseUrl: "https://mm.exemple.fr" }, port);
    expect(response.status).toBe(200);
    expect(state.baseUrl).toBe("https://mm.exemple.fr");
  });

  it("refuse une URL invalide ou un protocole inattendu, sans rien enregistrer", async () => {
    const { port, state } = spyPort();
    for (const baseUrl of ["pas une url", "ftp://mm.exemple.fr"]) {
      const response = await call("PUT", "/api/chat/mattermost", { baseUrl }, port);
      expect(response.status).toBe(400);
      expect(response.status).toBe(400);
    }
    expect(state.baseUrl).toBe("");
  });

  it("accepte l'effacement (chaîne vide) : on doit pouvoir déconfigurer", async () => {
    const { port, state } = spyPort();
    const response = await call("PUT", "/api/chat/mattermost", { baseUrl: "  " }, port);
    expect(response.status).toBe(200);
    expect(state.baseUrl).toBe("");
  });
});

describe("jeton — écrit une fois, jamais relu", () => {
  it("enregistre le jeton et NE LE RENVOIE PAS (ni valeur, ni préfixe)", async () => {
    const { port, state } = spyPort();
    const jeton = "jeton-bot-abcdef0123456789";
    const response = await call("POST", "/api/chat/mattermost/jeton", { jeton }, port);
    expect(response.status).toBe(200);
    expect(state.token).toBe(true);
    const texte = JSON.stringify(response.body);
    expect(texte).not.toContain(jeton);
    expect(texte).not.toContain("jeton-bot");
    expect(response.body).toEqual({ ok: true, jetonEnregistre: true });
  });

  it("refuse un jeton vide (jamais un enregistrement silencieux)", async () => {
    const { port, state } = spyPort();
    const response = await call("POST", "/api/chat/mattermost/jeton", { jeton: "   " }, port);
    expect(response.status).toBe(400);
    expect(state.token).toBe(false);
  });
});

describe("connexion — refus explicite quand il manque quelque chose", () => {
  it("sans jeton : 400 avec un motif actionnable", async () => {
    const { port, state } = spyPort();
    state.baseUrl = "https://mm.exemple.fr";
    const response = await call("POST", "/api/chat/mattermost/connexion", {}, port);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("jeton");
    expect(state.connected).toBe(0);
  });

  it("sans URL : 400 (on ne devine pas le serveur)", async () => {
    const { port, state } = spyPort();
    state.token = true;
    const response = await call("POST", "/api/chat/mattermost/connexion", {}, port);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("URL");
    expect(state.connected).toBe(0);
  });

  it("avec URL ET jeton : démarre, et accepte de les fournir dans le même geste", async () => {
    const { port, state } = spyPort();
    const response = await call(
      "POST",
      "/api/chat/mattermost/connexion",
      { baseUrl: "https://mm.exemple.fr", jeton: "jeton-1" },
      port,
    );
    expect(response.status).toBe(200);
    expect(state.connected).toBe(1);
    expect(state.baseUrl).toBe("https://mm.exemple.fr");
    expect(JSON.stringify(response.body)).not.toContain("jeton-1");
  });

  it("un échec de connexion est un 502 lisible (jamais un succès supposé)", async () => {
    const { port, state } = spyPort({
      connect: async () => {
        throw new Error("le serveur refuse l'authentification");
      },
    });
    state.baseUrl = "https://mm.exemple.fr";
    state.token = true;
    const response = await call("POST", "/api/chat/mattermost/connexion", {}, port);
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).toContain("refuse l'authentification");
  });
});

describe("mode de réponse — par canal", () => {
  it("enregistre `tout`, puis `mention` ; le mode revient dans l'état", async () => {
    const { port, state } = spyPort();
    const premier = await call("PATCH", "/api/chat/conversations/mm-canal-1", { replyMode: "tout" }, port);
    expect(premier.status).toBe(200);
    expect(state.modes.get("mm-canal-1")).toBe("tout");
    const second = await call("PATCH", "/api/chat/conversations/mm-canal-1", { replyMode: "mention" }, port);
    expect(second.status).toBe(200);
    expect(state.modes.get("mm-canal-1")).toBe("mention");
    const vue = (second.body as { mattermost: ChatMattermostView }).mattermost;
    expect(vue.canaux[0]?.replyMode).toBe("mention");
  });

  it("refuse un mode inconnu (aucune valeur devinée)", async () => {
    const { port, state } = spyPort();
    const response = await call("PATCH", "/api/chat/conversations/mm-canal-1", { replyMode: "parfois" }, port);
    expect(response.status).toBe(400);
    expect(state.modes.size).toBe(0);
  });

  it("un canal non synchronisé est un 404 (le réglage serait sans objet)", async () => {
    const { port } = spyPort();
    const response = await call("PATCH", "/api/chat/conversations/mm-inconnu", { replyMode: "tout" }, port);
    expect(response.status).toBe(404);
  });
});

describe("état — jamais un jeton", () => {
  it("`GET /api/chat/status` agrège l'état Mattermost sans secret", async () => {
    const { port } = spyPort();
    const response = await call("GET", "/api/chat/status", undefined, port);
    expect(response.status).toBe(200);
    const body = response.body as { mattermost: ChatMattermostView };
    expect(body.mattermost.jetonEnregistre).toBe(false);
    // ⚠️ Aucun CHAMP ne porte une valeur de jeton : `jetonEnregistre` est un booléen, et
    // le mot « jeton » qui apparaît dans un conseil (« saisissez le jeton ») n'est pas
    // une fuite. On vérifie donc qu'aucune valeur ne ressemble à un jeton Mattermost
    // (26 caractères alphanumériques).
    expect(Object.keys(body.mattermost).sort()).toEqual([
      "canaux",
      "jetonEnregistre",
      "plateforme",
      "synchronisation",
      "url",
    ]);
    for (const valeur of Object.values(body.mattermost)) {
      expect(JSON.stringify(valeur ?? null)).not.toMatch(/"[a-z0-9]{26}"/);
    }
  });

  it("sans port Mattermost, les routes dédiées répondent 503 (et l'état reste servi)", async () => {
    const etat = await call("GET", "/api/chat/status");
    expect(etat.status).toBe(200);
    expect((etat.body as { mattermost?: unknown }).mattermost).toBeUndefined();
    const ecriture = await call("PUT", "/api/chat/mattermost", { baseUrl: "https://x.fr" });
    expect(ecriture.status).toBe(503);
  });
});
