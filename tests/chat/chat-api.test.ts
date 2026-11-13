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
import type {
  ChatQuoteAuthor,
  ChatReplyMode,
  ChatReplySettings,
  ChatReplySettingsPatch,
  ChatReplyStyle,
} from "../../src/chat/types.js";
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
    deconnected: 0,
    modes: new Map<string, ChatReplyMode>(),
    styles: new Map<string, ChatReplyStyle>(),
    quotes: new Map<string, ChatQuoteAuthor>(),
    canaux: ["mm-canal-1"],
  };
  const view = (): ChatMattermostView => ({
    url: state.baseUrl,
    active: true,
    jetonEnregistre: state.token,
    plateforme: { etat: state.token ? "connexion" : "off" },
    synchronisation: {
      demarre: false,
      canauxSuivis: state.modes.size,
      backfill: { fait: false, imports: 0, borneAtteinte: false },
      rattrapageActif: false,
    },
    miroir: { conversations: state.canaux.length, messages: state.canaux.length, octets: 0 },
    canaux: state.canaux.map((id) => ({
      id,
      titre: id,
      messageCount: 1,
      ...(state.modes.has(id) ? { replyMode: state.modes.get(id) } : {}),
      replyStyle: state.styles.get(id) ?? "fil",
      quoteAuthor: state.quotes.get(id) ?? "non",
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
    // ⚠️ Débrancher = jeton effacé + synchro arrêtée ; le miroir reste (réversible).
    deconnecter: async () => {
      state.token = false;
      state.deconnected += 1;
    },
    miroir: () => ({ conversations: 0, messages: 0, octets: 0 }),
    supprimerMiroir: () => ({ conversations: 0, messages: 0, octets: 0 }),
    view,
    replySettings: (conversationId) =>
      state.canaux.includes(conversationId)
        ? {
            ...(state.modes.has(conversationId) ? { replyMode: state.modes.get(conversationId) } : {}),
            replyStyle: state.styles.get(conversationId) ?? "fil",
            quoteAuthor: state.quotes.get(conversationId) ?? "non",
          }
        : undefined,
    applyReplySettings: (conversationId, patch) => {
      if (!state.canaux.includes(conversationId)) return false;
      if (patch.replyMode !== undefined) {
        if (patch.replyMode === null) state.modes.delete(conversationId);
        else state.modes.set(conversationId, patch.replyMode);
      }
      if (patch.replyStyle !== undefined) {
        if (patch.replyStyle === null) state.styles.delete(conversationId);
        else state.styles.set(conversationId, patch.replyStyle);
      }
      if (patch.quoteAuthor !== undefined) {
        if (patch.quoteAuthor === null) state.quotes.delete(conversationId);
        else state.quotes.set(conversationId, patch.quoteAuthor);
      }
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

  it("un échec de connexion est un 502 lisible (jamais un succès supposé)", async () => {    const { port, state } = spyPort({
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

  /**
   * ⚠️ GARDE AJOUTÉE (2026-11-13) : l'URL fournie avec le bouton « Se connecter »
   * est désormais écrite dans la clé PAR BOT `chat.mattermost.url`, dont le schéma
   * refuse une adresse non http(s). Sans contrôle ici, le corps
   * `{ baseUrl: "pas une url" }` aurait levé une erreur de configuration (500)
   * au lieu d'un refus explicite — et n'aurait rien dit à l'utilisateur.
   */
  it("refuse une URL invalide fournie avec la connexion (400, pas un 500)", async () => {
    const { port, state } = spyPort();
    state.token = true;
    const response = await call(
      "POST",
      "/api/chat/mattermost/connexion",
      { baseUrl: "pas une url" },
      port,
    );
    expect(response.status).toBe(400);
    expect(state.baseUrl).toBe("");
    expect(state.connected).toBe(0);
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

describe("comment répondre — style et citation, par canal (même route)", () => {
  it("enregistre `replyStyle` et `quoteAuthor` et les rend dans la réponse et dans l'état", async () => {
    const { port, state } = spyPort();
    const response = await call(
      "PATCH",
      "/api/chat/conversations/mm-canal-1",
      { replyStyle: "nouveau", quoteAuthor: "oui" },
      port,
    );
    expect(response.status).toBe(200);
    expect(state.styles.get("mm-canal-1")).toBe("nouveau");
    expect(state.quotes.get("mm-canal-1")).toBe("oui");
    const corps = response.body as {
      reglages: { replyStyle: string; quoteAuthor: string };
      mattermost: ChatMattermostView;
    };
    expect(corps.reglages).toMatchObject({ replyStyle: "nouveau", quoteAuthor: "oui" });
    const canal = corps.mattermost.canaux[0];
    expect(canal?.replyStyle).toBe("nouveau");
    expect(canal?.quoteAuthor).toBe("oui");
  });

  it("un sous-ensemble n'écrase pas les autres réglages", async () => {
    const { port, state } = spyPort();
    await call("PATCH", "/api/chat/conversations/mm-canal-1", { replyMode: "tout" }, port);
    await call("PATCH", "/api/chat/conversations/mm-canal-1", { quoteAuthor: "oui" }, port);
    expect(state.modes.get("mm-canal-1")).toBe("tout");
    expect(state.quotes.get("mm-canal-1")).toBe("oui");
  });

  it("`null` remet le réglage à son défaut (le défaut est celui du moteur, pas de l'API)", async () => {
    const { port, state } = spyPort();
    await call("PATCH", "/api/chat/conversations/mm-canal-1", { replyStyle: "nouveau" }, port);
    const response = await call(
      "PATCH",
      "/api/chat/conversations/mm-canal-1",
      { replyStyle: null, quoteAuthor: null },
      port,
    );
    expect(response.status).toBe(200);
    expect(state.styles.size).toBe(0);
    expect(state.quotes.size).toBe(0);
    const corps = response.body as { reglages: { replyStyle: string; quoteAuthor: string } };
    expect(corps.reglages.replyStyle).toBe("fil");
    expect(corps.reglages.quoteAuthor).toBe("non");
  });

  it("REFUS explicite d'une valeur inconnue, et rien n'est appliqué", async () => {
    const { port, state } = spyPort();
    for (const corps of [
      { replyStyle: "imbrique" },
      { quoteAuthor: "peut-etre" },
      { replyStyle: 42 },
      { replyMode: "tout", replyStyle: "imbrique" },
    ]) {
      const response = await call("PATCH", "/api/chat/conversations/mm-canal-1", corps, port);
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain("replyStyle");
    }
    expect(state.styles.size).toBe(0);
    expect(state.quotes.size).toBe(0);
    // Un corps VIDE n'applique rien non plus (il n'y aurait rien à faire).
    const vide = await call("PATCH", "/api/chat/conversations/mm-canal-1", {}, port);
    expect(vide.status).toBe(400);
  });
});

describe("réglages par canal — MIROIR DU BOT AFFICHÉ (lot 45)", () => {
  /**
   * Port de réglages d'un bot : un miroir DISTINCT de celui du port d'instance.
   *
   * ⚠️ C'est le défaut corrigé : `PATCH /api/chat/conversations/<id>` écrivait
   * toujours dans le miroir du bot COURANT (`<state>/chat-mirror.json`). Un canal
   * d'un autre bot (dans `<state>/bots/<id>/chat-mirror.json`) était donc réglé
   * dans le mauvais fichier : réglage sans effet, et menu qui recoche l'ancienne
   * valeur au rafraîchissement (la liste est autoritaire côté serveur).
   */
  function miroirBot(canaux: string[]) {
    const ecritures: { conversationId: string; patch: Record<string, unknown> }[] = [];
    const valeurs = new Map<string, ChatReplySettingsPatch>();
    const reglages = (conversationId: string): ChatReplySettings | null => {
      if (!canaux.includes(conversationId)) return null;
      const v = valeurs.get(conversationId) ?? {};
      return {
        ...(typeof v.replyMode === "string" ? { replyMode: v.replyMode } : {}),
        replyStyle: v.replyStyle ?? "fil",
        quoteAuthor: v.quoteAuthor ?? "non",
      };
    };
    return {
      ecritures,
      miroir: {
        reglages,
        ecrire: (conversationId: string, patch: Record<string, unknown>) => {
          if (!canaux.includes(conversationId)) return false;
          ecritures.push({ conversationId, patch });
          valeurs.set(conversationId, { ...(valeurs.get(conversationId) ?? {}), ...patch });
          return true;
        },
      },
    };
  }

  it("`bot` dans le corps ⇒ l'écriture va dans SON miroir, jamais dans celui du port d'instance", async () => {
    const { port, state } = spyPort();
    const granolaf = miroirBot(["dc-salon-1"]);
    const response = await handleChatRequest({
      method: "PATCH",
      path: "/api/chat/conversations/dc-salon-1",
      headers: HEADERS,
      body: JSON.stringify({ replyMode: "tout", bot: "granolaf" }),
      deps: {
        ...deps(port),
        reglagesCanalDeBot: (botId: string) =>
          botId === "granolaf" ? granolaf.miroir : undefined,
      },
    });
    expect(response.status).toBe(200);
    expect(granolaf.ecritures).toEqual([{ conversationId: "dc-salon-1", patch: { replyMode: "tout" } }]);
    expect(response.body).toMatchObject({
      ok: true,
      bot: "granolaf",
      reglages: { replyMode: "tout", replyStyle: "fil", quoteAuthor: "non" },
    });
    // Le miroir du bot courant n'a rien reçu (c'était l'écriture perdue).
    expect(state.modes.size).toBe(0);
  });

  it("un bot INCONNU est REFUSÉ (400) — jamais de repli sur un autre miroir", async () => {
    const { port, state } = spyPort();
    const response = await handleChatRequest({
      method: "PATCH",
      path: "/api/chat/conversations/mm-canal-1",
      headers: HEADERS,
      body: JSON.stringify({ replyMode: "tout", bot: "fantome" }),
      deps: { ...deps(port), reglagesCanalDeBot: () => undefined },
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toContain("fantome");
    expect(state.modes.size).toBe(0);
  });

  it("canal absent du miroir de CE bot ⇒ 404 (le réglage serait sans objet)", async () => {
    const { port } = spyPort();
    const granolaf = miroirBot(["dc-salon-1"]);
    const response = await handleChatRequest({
      method: "PATCH",
      path: "/api/chat/conversations/dc-autre",
      headers: HEADERS,
      body: JSON.stringify({ replyStyle: "nouveau", bot: "granolaf" }),
      deps: { ...deps(port), reglagesCanalDeBot: () => granolaf.miroir },
    });
    expect(response.status).toBe(404);
    expect(granolaf.ecritures).toHaveLength(0);
  });

  it("SANS `bot`, le comportement d'avant est conservé (port d'instance)", async () => {
    const { port, state } = spyPort();
    const response = await handleChatRequest({
      method: "PATCH",
      path: "/api/chat/conversations/mm-canal-1",
      headers: HEADERS,
      body: JSON.stringify({ replyMode: "mention" }),
      deps: { ...deps(port), reglagesCanalDeBot: () => undefined },
    });
    expect(response.status).toBe(200);
    expect(state.modes.get("mm-canal-1")).toBe("mention");
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
      // Interrupteur de la plateforme (`chat.mattermost.enabled`) : un BOOLÉEN, lu
      // par l'interface. Un jeton posé sans lui n'ouvre aucune connexion.
      "active",
      "canaux",
      "jetonEnregistre",
      // Lot 30 : empreinte du miroir (conversations, messages, octets) — affichée
      // AVANT la confirmation d'une suppression. Trois NOMBRES, jamais un secret.
      "miroir",
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
