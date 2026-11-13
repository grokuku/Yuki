/**
 * LOT 42 — ONGLET « PLATEFORMES » D'UN BOT AUTRE QUE CELUI DE LA PILE.
 *
 * Défaut corrigé (capture utilisateur) : `/bots?b=<bot>` → onglet « Plateformes »
 * VIDE, réduit au bouton « Enregistrer ». Deux causes, vérifiées ici :
 *  ① le panneau n'était monté que si le bot affiché était ACTIF
 *    (`panneauxDuBotActif`, `config.js`) ;
 *  ② même monté, `chat-panel.js` n'écrivait QUE dans l'overlay et le jeton du bot
 *    de la PILE (routes d'instance `/api/chat/**`).
 *
 * Ce que ce fichier prouve :
 *  - le panneau est RENDU pour un bot affiché qui n'est pas celui de la pile ;
 *  - ses LECTURES visent `GET /api/bots/<id>/config` (jamais `/api/chat/status`,
 *    qui décrit le bot de la pile) ;
 *  - le jeton écrit est CELUI DU BOT AFFICHÉ (`POST /api/secrets`,
 *    `YUKI_CHAT_<BOT>__<PLATEFORME>`) — jamais `/api/chat/<plateforme>/jeton` ;
 *  - un bot ARRÊTÉ reste configurable ;
 *  - aucun jeton n'est laissé en clair dans la page ;
 *  - le nom du secret calculé par la page est IDENTIQUE à celui du serveur.
 *
 * ⚠️ DOM SIMULÉ : Vitest tourne en `environment: "node"` (ni jsdom ni happy-dom).
 * ⚠️ Échoue sur le code d'origine : `initChatPanelBot`, `nomSecretChatBot` et
 * `texteEtatJetonBot` n'existent pas.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  initChatPanel,
  nomSecretChatBot,
  nomsSecretsChatBot,
  texteEtatJetonBot,
} from "../../public/ui/chat-panel.js";
import {
  nomSecretChat,
  nomsSecretsChat,
  type PlateformeChat,
} from "../../src/chat/jetons-bot.js";

// ─── DOM minimal ───────────────────────────────────────────────────────────

class Noeud {
  tag: string;
  children: Noeud[];
  parent: Noeud | null;
  attrs: Map<string, string>;
  textContent: string;
  className: string;
  hidden: boolean;
  disabled: boolean;
  valueInterne: string;
  listeners: Map<string, Array<(evenement?: unknown) => void>>;

  constructor(tag: string) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.attrs = new Map();
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.valueInterne = "";
    this.listeners = new Map();
  }

  setAttribute(nom: string, valeur: unknown): void {
    this.attrs.set(nom, String(valeur));
  }

  getAttribute(nom: string): string | null {
    return this.attrs.get(nom) ?? null;
  }

  removeAttribute(nom: string): void {
    this.attrs.delete(nom);
  }

  append(...noeuds: Noeud[]): void {
    for (const noeud of noeuds) {
      noeud.parent = this;
      this.children.push(noeud);
    }
  }

  replaceChildren(...noeuds: Noeud[]): void {
    for (const enfant of this.children) enfant.parent = null;
    this.children = [];
    this.append(...noeuds);
  }

  addEventListener(type: string, fn: (evenement?: unknown) => void): void {
    const liste = this.listeners.get(type) ?? [];
    liste.push(fn);
    this.listeners.set(type, liste);
  }

  declencher(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn();
  }

  get value(): string {
    return this.valueInterne;
  }

  set value(valeur: string) {
    this.valueInterne = String(valeur);
  }

  focus(): void {
    // Volontairement vide : le focus n'existe pas dans ce DOM simulé.
  }
}

function descendants(racine: Noeud): Noeud[] {
  const sortie: Noeud[] = [];
  for (const enfant of racine.children) sortie.push(enfant, ...descendants(enfant));
  return sortie;
}

function parId(racine: Noeud, id: string): Noeud | null {
  return descendants(racine).find((noeud) => noeud.attrs.get("id") === id) ?? null;
}

function parTexte(racine: Noeud, texte: string): Noeud | null {
  return descendants(racine).find((noeud) => noeud.textContent === texte) ?? null;
}

/**
 * Bouton d'un libellé donné, cherché dans la SECTION qui porte le champ indiqué
 * (les deux plateformes ont un bouton « Enregistrer le jeton » : viser le premier
 * de la page écrirait pour la mauvaise plateforme).
 */
function boutonDe(racine: Noeud, idChamp: string, libelle: string): Noeud {
  const champ = parId(racine, idChamp);
  if (champ === null) throw new Error(`champ « ${idChamp} » introuvable`);
  let noeud: Noeud | null = champ;
  while (noeud !== null && noeud.className !== "config-group") noeud = noeud.parent;
  const bouton = parTexte(noeud ?? racine, libelle);
  if (bouton === null) throw new Error(`bouton « ${libelle} » introuvable`);
  return bouton;
}

/** Texte visible d'un sous-arbre (textContent posé + nœuds texte). */
function texte(racine: Noeud): string {
  const morceaux = [racine.textContent];
  for (const enfant of racine.children) morceaux.push(texte(enfant));
  return morceaux.filter((morceau) => morceau !== "").join(" · ");
}

const DOM_PRECEDENT = {
  document: (globalThis as Record<string, unknown>).document,
  Node: (globalThis as Record<string, unknown>).Node,
};

beforeEach(() => {
  (globalThis as Record<string, unknown>).Node = Noeud;
  (globalThis as Record<string, unknown>).document = {
    createElement: (tag: string) => new Noeud(tag),
    createTextNode: (contenu: string) => {
      const noeud = new Noeud("#text");
      noeud.textContent = contenu;
      return noeud;
    },
    activeElement: null,
    getElementById: () => null,
  };
});

afterEach(() => {
  (globalThis as Record<string, unknown>).document = DOM_PRECEDENT.document;
  (globalThis as Record<string, unknown>).Node = DOM_PRECEDENT.Node;
});

// ─── Serveur simulé ────────────────────────────────────────────────────────

interface Appel {
  url: string;
  method: string;
  body: unknown;
}

/** Ce qu'un bot configuré renvoie pour `GET /api/bots/<id>/config`. */
function configBot(options: {
  mattermost?: boolean;
  discord?: boolean;
  guildId?: string;
  maxUploadBytes?: number;
}) {
  return {
    fields: {
      // ⚠️ Les DEUX INTERRUPTEURS (le choix exclusif `chat.mode` est retiré).
      "chat.mattermost.enabled": { value: options.mattermost === true ? "on" : "off", scope: "bot" },
      "chat.discord.enabled": { value: options.discord === true ? "on" : "off", scope: "bot" },
      "chat.discord.guildId": { value: options.guildId ?? "", scope: "bot" },
      "chat.discord.maxUploadBytes": {
        value: options.maxUploadBytes ?? 8 * 1024 * 1024,
        scope: "bot",
      },
    },
  };
}

function serveur(options: { config: unknown; noms?: string[] }) {
  const appels: Appel[] = [];
  const noms = new Set(options.noms ?? []);
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    appels.push({ url, method, body });
    if (url === "/api/secrets" && method === "POST") {
      const nom = (body as { name?: string })?.name;
      if (typeof nom === "string") noms.add(nom);
      return { ok: true, status: 200, json: async () => ({ entry: { name: nom } }) };
    }
    if (url === "/api/secrets") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          configured: true,
          entries: [...noms].map((nom) => ({ name: nom })),
        }),
      };
    }
    if (url.startsWith("/api/bots/")) {
      return { ok: true, status: 200, json: async () => options.config };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: "unexpected", message: `route inattendue ${url}` }),
    };
  };
  return { appels, fetchImpl };
}

/** Laisse tourner les promesses déclenchées par un clic (`void (async () => …)()`). */
async function laisserTourner(verifier: () => boolean): Promise<void> {
  for (let essai = 0; essai < 50; essai += 1) {
    if (verifier()) return;
    await new Promise((resoudre) => setTimeout(resoudre, 0));
  }
  throw new Error("la condition attendue ne s'est jamais réalisée");
}

// ─── ① Le nom du secret est le MÊME des deux côtés ─────────────────────────

describe("nom du secret du jeton : page et serveur d'accord", () => {
  it("`YUKI_CHAT_<BOT>__<PLATEFORME>` identique à `src/chat/jetons-bot.ts`", () => {
    for (const botId of ["granolaf", "yuki", "bot-de-test"]) {
      for (const plateforme of ["mattermost", "discord"] as PlateformeChat[]) {
        expect(nomSecretChatBot(botId, plateforme)).toBe(nomSecretChat(botId, plateforme));
        expect(nomsSecretsChatBot(botId, plateforme)).toEqual(nomsSecretsChat(botId, plateforme));
      }
    }
  });

  it("le nom porte le bot EN MAJUSCULES et un séparateur `__`", () => {
    expect(nomSecretChatBot("granolaf", "discord")).toBe("YUKI_CHAT_GRANOLAF__DISCORD");
    expect(nomSecretChatBot("bot-de-test", "mattermost")).toBe(
      "YUKI_CHAT_BOT_DE_TEST__MATTERMOST",
    );
  });

  it("l'état du jeton NOMME le secret manquant, sans jamais de valeur", () => {
    const texteEtat = texteEtatJetonBot("granolaf", "discord", ["YUKI_CHAT_GRANOLAF__MATTERMOST"]);
    expect(texteEtat).toContain("YUKI_CHAT_GRANOLAF__DISCORD");
    expect(texteEtat).toContain("Aucun jeton");
    expect(texteEtatJetonBot("granolaf", "mattermost", ["YUKI_CHAT_GRANOLAF__MATTERMOST"])).toContain(
      "enregistré",
    );
  });
});

// ─── ② Le panneau est RENDU, et il vise CE bot ─────────────────────────────

describe("panneau « Plateformes » d'un bot non-pile", () => {
  it("est RENDU (pas vide) et lit la configuration DE CE BOT", async () => {
    const racine = new Noeud("div");
    const { appels, fetchImpl } = serveur({
      config: configBot({ discord: true, guildId: "42", maxUploadBytes: 1_048_576 }),
    });
    initChatPanel({
      root: racine as never,
      fetchImpl: fetchImpl as never,
      botId: "granolaf",
      botNom: "Granolaf",
      botDuRun: "yuki",
      botDemarre: true,
    });

    expect(racine.children.length).toBeGreaterThan(0);
    expect(texte(racine)).toContain("Plateformes de Granolaf");
    // ⚠️ JAMAIS `/api/chat/status` : cette route décrit le bot de la PILE.
    expect(appels.some((appel) => appel.url.startsWith("/api/chat"))).toBe(false);
    expect(appels.some((appel) => appel.url === "/api/bots/granolaf/config")).toBe(true);

    // ⚠️ DEUX INTERRUPTEURS, pas de menu déroulant (le choix exclusif est retiré :
    // il coupait les plateformes non choisies).
    expect(parId(racine, "chat-bot-mode")).toBeNull();
    const discord = parId(racine, "chat-bot-discord-enabled");
    const mattermost = parId(racine, "chat-bot-mattermost-enabled");
    expect(discord).not.toBeNull();
    expect(mattermost).not.toBeNull();
    // L'interrupteur est LU (jamais deviné) : Discord est allumé, Mattermost éteint.
    await laisserTourner(() => discord!.attrs.get("aria-pressed") === "true");
    expect(discord!.attrs.get("aria-pressed")).toBe("true");
    expect(mattermost!.attrs.get("aria-pressed")).toBe("false");
    // ⚠️ Le LOCAL n'est pas un choix : aucun interrupteur ne le représente.
    expect(texte(racine)).toContain("n'est pas une option");
  });

  it("enregistre `chat.discord.enabled` SUR LA ROUTE DU BOT AFFICHÉ", async () => {
    const racine = new Noeud("div");
    const { appels, fetchImpl } = serveur({ config: configBot({}) });
    initChatPanel({
      root: racine as never,
      fetchImpl: fetchImpl as never,
      botId: "granolaf",
      botNom: "Granolaf",
      botDuRun: "yuki",
      botDemarre: true,
    });
    const interrupteur = parId(racine, "chat-bot-discord-enabled")!;
    await laisserTourner(() => interrupteur.attrs.get("aria-pressed") === "false");
    interrupteur.declencher("click");

    await laisserTourner(() =>
      appels.some((appel) => appel.method === "PUT" && appel.url === "/api/bots/granolaf/config"),
    );
    const ecriture = appels.find((appel) => appel.method === "PUT")!;
    expect(ecriture.url).toBe("/api/bots/granolaf/config");
    // ⚠️ C'est l'INTERRUPTEUR qui s'écrit (le jeton reste un secret séparé).
    expect(ecriture.body).toEqual({ "chat.discord.enabled": "on" });
    // Aucune écriture de configuration d'instance.
    expect(appels.some((appel) => appel.url === "/api/config")).toBe(false);
  });
});

// ─── ③ Le jeton écrit est CELUI DU BOT, jamais celui de `yuki` ─────────────

describe("jeton de plateforme d'un bot non-pile", () => {
  it("écrit `YUKI_CHAT_<BOT>__DISCORD`, jamais la route d'instance", async () => {
    const racine = new Noeud("div");
    const { appels, fetchImpl } = serveur({ config: configBot({}) });
    initChatPanel({
      root: racine as never,
      fetchImpl: fetchImpl as never,
      botId: "granolaf",
      botNom: "Granolaf",
      botDuRun: "yuki",
      botDemarre: true,
    });
    const champ = parId(racine, "chat-bot-discord-jeton")!;
    champ.value = "JETON-DISCORD-DE-GRANOLAF";
    boutonDe(racine, "chat-bot-discord-jeton", "Enregistrer le jeton").declencher("click");

    // La condition attend le GESTIONNAIRE complet (écriture PUIS vidage du champ).
    await laisserTourner(
      () => appels.some((appel) => appel.method === "POST") && champ.value === "",
    );
    const ecriture = appels.find((appel) => appel.method === "POST")!;
    expect(ecriture.url).toBe("/api/secrets");
    expect(ecriture.body).toMatchObject({
      name: "YUKI_CHAT_GRANOLAF__DISCORD",
      value: "JETON-DISCORD-DE-GRANOLAF",
    });
    // ⚠️ LE BUG LE PLUS GRAVE : écrire chez `yuki`.
    expect(appels.some((appel) => appel.url === "/api/chat/discord/jeton")).toBe(false);
    expect(appels.some((appel) => String((appel.body as { name?: string })?.name).includes("YUKI__"))).toBe(
      false,
    );
    // ⚠️ AUCUN jeton en clair : le champ est vidé après l'enregistrement.
    expect(champ.value).toBe("");
  });

  it("les deux jetons sont écrits séparément, avec le nom de leur plateforme", async () => {
    const racine = new Noeud("div");
    const { appels, fetchImpl } = serveur({ config: configBot({}) });
    initChatPanel({
      root: racine as never,
      fetchImpl: fetchImpl as never,
      botId: "granolaf",
      botDuRun: "yuki",
      botDemarre: false,
    });
    const champ = parId(racine, "chat-bot-mattermost-jeton")!;
    champ.value = "JETON-MATTERMOST-DE-GRANOLAF";
    boutonDe(racine, "chat-bot-mattermost-jeton", "Enregistrer le jeton").declencher("click");
    await laisserTourner(() => appels.some((appel) => appel.method === "POST"));
    expect((appels.find((appel) => appel.method === "POST")!.body as { name?: string }).name).toBe(
      "YUKI_CHAT_GRANOLAF__MATTERMOST",
    );
  });

  it("aucun jeton en clair dans la page, même après enregistrement", async () => {
    const racine = new Noeud("div");
    const { fetchImpl } = serveur({ config: configBot({ discord: true }) });
    initChatPanel({
      root: racine as never,
      fetchImpl: fetchImpl as never,
      botId: "granolaf",
      botNom: "Granolaf",
      botDuRun: "yuki",
      botDemarre: true,
    });
    const champ = parId(racine, "chat-bot-discord-jeton")!;
    champ.value = "SECRET-QUI-NE-DOIT-PAS-RESTER";
    boutonDe(racine, "chat-bot-discord-jeton", "Enregistrer le jeton").declencher("click");
    await laisserTourner(() => champ.value === "");
    expect(texte(racine)).not.toContain("SECRET-QUI-NE-DOIT-PAS-RESTER");
    // L'état du coffre est dit en clair (nom du secret), jamais sa valeur.
    expect(texte(racine)).toContain("YUKI_CHAT_GRANOLAF__DISCORD");
  });
});

// ─── ④ Un bot ARRÊTÉ reste configurable ────────────────────────────────────

describe("bot arrêté", () => {
  it("reste éditable et écrit toujours chez lui", async () => {
    const racine = new Noeud("div");
    const { appels, fetchImpl } = serveur({ config: configBot({}) });
    initChatPanel({
      root: racine as never,
      fetchImpl: fetchImpl as never,
      botId: "granolaf",
      botNom: "Granolaf",
      botDuRun: "yuki",
      botDemarre: false,
    });
    // ⚠️ Aucun contrôle n'est désactivé par l'état d'arrêt.
    expect(descendants(racine).some((noeud) => noeud.disabled)).toBe(false);
    expect(texte(racine)).toContain("arrêté");
    expect(texte(racine)).toContain("ÉDITABLE");

    const champ = parId(racine, "chat-bot-discord-guild")!;
    const upload = parId(racine, "chat-bot-discord-upload")!;
    // ⚠️ La première lecture remplit les champs : on saisit APRÈS elle.
    await laisserTourner(() => upload.value !== "");
    champ.value = "424242";
    upload.value = "2097152";
    parTexte(racine, "Enregistrer les options")!.declencher("click");
    await laisserTourner(() =>
      appels.some((appel) => appel.method === "PUT" && appel.url === "/api/bots/granolaf/config"),
    );
    const ecriture = appels.find((appel) => appel.method === "PUT")!;
    expect(ecriture.body).toEqual({
      "chat.discord.guildId": "424242",
      "chat.discord.maxUploadBytes": 2_097_152,
    });
  });
});

// ─── ⑤ Le bot de la PILE garde le panneau d'instance (aucune régression) ───

describe("bot de la pile", () => {
  it("garde le panneau d'instance (`GET /api/chat/status`)", async () => {
    const racine = new Noeud("div");
    const appels: string[] = [];
    const fetchImpl = async (url: string) => {
      appels.push(url);
      if (url === "/api/chat/status") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            mode: "local",
            plateforme: { etat: "on" },
            creation: { autorisee: true },
            distant: { agents: "desactive", outils: "desactive" },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    initChatPanel({
      root: racine as never,
      fetchImpl: fetchImpl as never,
      botId: "yuki",
      botDuRun: "yuki",
    });
    await laisserTourner(() => appels.includes("/api/chat/status"));
    expect(appels).toContain("/api/chat/status");
    // Le panneau PAR BOT n'est pas monté dans ce cas : ni menu exclusif, ni
    // interrupteurs par bot.
    expect(parId(racine, "chat-bot-mode")).toBeNull();
    expect(parId(racine, "chat-bot-discord-enabled")).toBeNull();
    // Le panneau du bot de la pile ne monte pas non plus les interrupteurs par bot.
    expect(parId(racine, "chat-bot-discord-enabled")).toBeNull();
  });
});

// ─── ⑥ Le MONTAGE ne dépend plus du bot actif ──────────────────────────────

describe("montage du panneau dans la page Bot (`config.js`)", () => {
  it("le panneau est monté pour TOUT bot affiché, avec SON identifiant", () => {
    const source = readFileSync(join(process.cwd(), "public", "ui", "config.js"), "utf8");
    // ⚠️ CAUSE ① du défaut : la garde `panneauxDuBotActif` (bot ACTIF) rendait
    // l'onglet « Plateformes » VIDE pour un bot ajouté après coup.
    expect(source).not.toMatch(/panneauxDuBotActif\s*&&\s*chatRoot/);
    // Le bot AFFICHÉ est passé au panneau, avec le bot de la PILE comme référence.
    expect(source).toContain('const botDuChat = PAGE_BOT ? (botCourant?.id ?? "") : "";');
    expect(source).toContain("botId: botDuChat");
    // ⚠️ GARDE MISE À JOUR (lot 45) : `botPrincipal` et `BOT_REPLI` sont
    // SUPPRIMÉS (plus de « bot principal », plus de repli `yuki`). Le bot du run
    // vient de `GET /api/bots` (`botDuRun`), à défaut le PREMIER de la liste.
    expect(source).toContain("botDuRun: botDuRun ?? botsConnus[0]?.id ?? null");
    // ⚠️ `actif` ne dit pas « tourne » : c'est `execution.demarre` qui le dit.
    expect(source).toContain("botDemarre: botCourant?.execution?.demarre === true");
  });
});
