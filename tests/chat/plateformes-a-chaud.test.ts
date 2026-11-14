/**
 * PLATEFORMES À CHAUD — activer Mattermost sur un bot QUI TOURNE doit ouvrir la
 * connexion TOUT DE SUITE (bug signalé le 2026-11-14).
 *
 * ⚠️ SÉQUENCE RÉELLE REPRODUITE PAR L'UTILISATEUR :
 *   1. plusieurs redémarrages (dont un avant la configuration Mattermost) ⇒ aucun
 *      adaptateur (interrupteur `off`) ;
 *   2. configuration + activation SANS redémarrer ⇒ rien ne se passait : aucun
 *      adaptateur créé, aucun WebSocket ouvert ;
 *   3. symptôme A : le bot est HORS LIGNE dans Mattermost (la présence suit le WS) ;
 *   4. symptôme B : aucun canal dans l'interface web (pas de connexion ⇒ pas de
 *      synchronisation ⇒ miroir vide) ;
 *   5. coupure + relance ⇒ tout fonctionne. **Le seul déclencheur était le
 *      redémarrage.**
 *
 * Ce que ce fichier prouve, et qui ÉCHOUE sur le code d'origine (aucune
 * `rafraichirBot` n'existait, donc aucune activation à chaud possible) :
 *  ① activer ⇒ un adaptateur est CRÉÉ et `connect()` est appelé ;
 *  ② désactiver ⇒ `disconnect()` est appelé et la paire est oubliée ;
 *  ③ URL changée ⇒ la connexion est ROUVERTE (vers la NOUVELLE adresse, jamais
 *     l'ancienne : deux bots, deux serveurs) ;
 *  ④ jeton changé ⇒ reconnexion ;
 *  ⑤ échec de connexion ⇒ journal `chat.adaptateur.connect_failed` ET bilan
 *     `echecs` nommé (donc état lisible, pas seulement une trace) ;
 *  ⑥ la SYNCHRONISATION démarre après connexion : le canal apparaît dans le
 *     miroir du bot demandé ;
 *  ⑦ le miroir lu est celui du BOT DEMANDÉ (rafraîchir un bot n'écrit jamais dans
 *     celui d'un autre).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  AdaptateursChatBots,
  cleAdaptateur,
  type AdaptateurChatDemarrable,
  type AdaptateursChatLogger,
} from "../../src/chat/adaptateurs-bots.js";
import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import { conversationIdOfChannel } from "../../src/chat/mirror/ingest.js";
import type { JetonChat, PlateformeChat } from "../../src/chat/jetons-bot.js";
import { createLogger } from "../../src/observability/logger.js";
import {
  MM_CHANNEL,
  MM_TOKEN,
  openMmMirror,
  startMmFixture,
  waitFor,
} from "./mm-reply-fixture.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Journal qui RETIENT les lignes (pour prouver qu'un échec est bien journalisé). */
interface JournalCapture extends AdaptateursChatLogger {
  readonly lignes: { niveau: "info" | "warn"; message: string; champs?: Record<string, unknown> }[];
}

function journalCapture(): JournalCapture {
  const lignes: JournalCapture["lignes"] = [];
  return {
    lignes,
    info: (message, champs) => {
      lignes.push({ niveau: "info", message, ...(champs !== undefined ? { champs } : {}) });
    },
    warn: (message, champs) => {
      lignes.push({ niveau: "warn", message, ...(champs !== undefined ? { champs } : {}) });
    },
  };
}

/** Adaptateur factice : il retient ce qui lui est demandé, rien de plus. */
interface AdaptateurEspion extends AdaptateurChatDemarrable {
  readonly appels: string[];
  connecte: boolean;
}

function espion(options: { echec?: string } = {}): AdaptateurEspion {
  const adaptateur: AdaptateurEspion = {
    appels: [],
    connecte: false,
    connect: async () => {
      adaptateur.appels.push("connect");
      if (options.echec !== undefined) throw new Error(options.echec);
      adaptateur.connecte = true;
    },
    disconnect: async () => {
      adaptateur.appels.push("disconnect");
      adaptateur.connecte = false;
    },
  };
  return adaptateur;
}

function jeton(botId: string, plateforme: PlateformeChat = "mattermost"): JetonChat {
  return { botId, plateforme, nom: `YUKI_CHAT_${botId.toUpperCase()}__MATTERMOST` };
}

/** Registre sans paire initiale : tout ce qui existe est créé par la règle testée. */
function registre(options: {
  crees: Map<string, AdaptateurEspion>;
  journal?: JournalCapture;
  botDuRun?: string;
  echec?: string;
}): AdaptateursChatBots<AdaptateurChatDemarrable> {
  return new AdaptateursChatBots<AdaptateurChatDemarrable>({
    botDuRun: options.botDuRun ?? "yuki",
    resolution: { jetons: new Map(), conflits: [] },
    creer: (entree) => {
      const cle = cleAdaptateur(entree.botId, entree.plateforme);
      const adaptateur = espion(options.echec !== undefined ? { echec: options.echec } : {});
      options.crees.set(cle, adaptateur);
      return adaptateur;
    },
    logger: options.journal ?? journalCapture(),
  });
}

describe("① activer une plateforme sur un bot qui tourne ⇒ adaptateur créé + connect()", () => {
  it("l'activation SANS redémarrage ouvre la connexion", async () => {
    const crees = new Map<string, AdaptateurEspion>();
    const adaptateurs = registre({ crees });
    // Au départ : interrupteur `off` ⇒ AUCUNE paire (c'est l'état d'après le démarrage).
    expect(adaptateurs.paires()).toEqual([]);

    const bilan = await adaptateurs.rafraichirBot({
      botId: "yuki",
      jetons: new Map<PlateformeChat, JetonChat>([["mattermost", jeton("yuki")]]),
    });

    expect(bilan.connectes).toEqual(["yuki:mattermost"]);
    expect(bilan.echecs).toEqual([]);
    expect(crees.get("yuki:mattermost")?.appels).toEqual(["connect"]);
    expect(adaptateurs.estConnecte("yuki", "mattermost")).toBe(true);
    // L'adaptateur est bien celui du bot demandé, et il est servable par `pour()`.
    expect(adaptateurs.pour("yuki", "mattermost")).toBe(crees.get("yuki:mattermost"));
  });

  it("② désactiver ⇒ disconnect() puis oubli de la paire", async () => {
    const crees = new Map<string, AdaptateurEspion>();
    const adaptateurs = registre({ crees });
    await adaptateurs.rafraichirBot({
      botId: "yuki",
      jetons: new Map<PlateformeChat, JetonChat>([["mattermost", jeton("yuki")]]),
    });

    // Interrupteur éteint : la résolution fraîche ne contient plus de jeton.
    const bilan = await adaptateurs.rafraichirBot({
      botId: "yuki",
      jetons: new Map<PlateformeChat, JetonChat>(),
    });

    expect(bilan.deconnectes).toEqual(["yuki:mattermost"]);
    expect(crees.get("yuki:mattermost")?.appels).toEqual(["connect", "disconnect"]);
    expect(adaptateurs.pour("yuki", "mattermost")).toBeUndefined();
    expect(adaptateurs.estConnecte("yuki", "mattermost")).toBe(false);
  });
});

describe("③④ URL ou jeton changé ⇒ reconnexion (jamais l'ancienne destination)", () => {
  it("③ une autre URL ROUVRE la connexion, et l'empreinte de l'ancienne est abandonnée", async () => {
    const crees = new Map<string, AdaptateurEspion>();
    const adaptateurs = registre({ crees });
    await adaptateurs.rafraichirBot({
      botId: "yuki",
      jetons: new Map<PlateformeChat, JetonChat>([["mattermost", jeton("yuki")]]),
      empreinte: () => `https://ancien.example\n${MM_TOKEN}`,
    });
    const adaptateur = crees.get("yuki:mattermost") as AdaptateurEspion;
    expect(adaptateur.appels).toEqual(["connect"]);

    const bilan = await adaptateurs.rafraichirBot({
      botId: "yuki",
      jetons: new Map<PlateformeChat, JetonChat>([["mattermost", jeton("yuki")]]),
      empreinte: () => `https://nouveau.example\n${MM_TOKEN}`,
    });

    expect(bilan.reconnectes).toEqual(["yuki:mattermost"]);
    // ⚠️ disconnect PUIS connect : la connexion vers l'ancien serveur est FERMÉE.
    expect(adaptateur.appels).toEqual(["connect", "disconnect", "connect"]);
    expect(adaptateurs.estConnecte("yuki", "mattermost")).toBe(true);
  });

  it("④ un jeton changé ROUVRE la connexion (l'ancienne est authentifiée avec l'ancien)", async () => {
    const crees = new Map<string, AdaptateurEspion>();
    const adaptateurs = registre({ crees });
    await adaptateurs.rafraichirBot({
      botId: "yuki",
      jetons: new Map<PlateformeChat, JetonChat>([["mattermost", jeton("yuki")]]),
      empreinte: () => `https://mm.example\nancien-jeton`,
    });

    const bilan = await adaptateurs.rafraichirBot({
      botId: "yuki",
      jetons: new Map<PlateformeChat, JetonChat>([["mattermost", jeton("yuki")]]),
      empreinte: () => `https://mm.example\nnouveau-jeton`,
    });

    expect(bilan.reconnectes).toEqual(["yuki:mattermost"]);
    expect(crees.get("yuki:mattermost")?.appels).toEqual(["connect", "disconnect", "connect"]);
  });

  it("une empreinte INCHANGÉE ne rouvre rien (on ne coupe pas une connexion saine)", async () => {
    const crees = new Map<string, AdaptateurEspion>();
    const adaptateurs = registre({ crees });
    const jetons = new Map<PlateformeChat, JetonChat>([["mattermost", jeton("yuki")]]);
    await adaptateurs.rafraichirBot({ botId: "yuki", jetons, empreinte: () => "identique" });
    const bilan = await adaptateurs.rafraichirBot({
      botId: "yuki",
      jetons,
      empreinte: () => "identique",
    });
    expect(bilan.reconnectes).toEqual([]);
    expect(crees.get("yuki:mattermost")?.appels).toEqual(["connect"]);
  });
});

describe("⑤ un échec de connexion est EXPOSÉ (journal + bilan nommé)", () => {
  it("le journal porte `chat.adaptateur.connect_failed` et le bilan la raison", async () => {
    const crees = new Map<string, AdaptateurEspion>();
    const journal = journalCapture();
    const adaptateurs = registre({ crees, journal, echec: "Le jeton du bot est refusé (401)." });

    const bilan = await adaptateurs.rafraichirBot({
      botId: "yuki",
      jetons: new Map<PlateformeChat, JetonChat>([["mattermost", jeton("yuki")]]),
    });

    expect(bilan.echecs).toEqual([
      { cle: "yuki:mattermost", error: "Le jeton du bot est refusé (401)." },
    ]);
    expect(adaptateurs.estConnecte("yuki", "mattermost")).toBe(false);
    const trace = journal.lignes.find(
      (ligne) => ligne.message === "chat.adaptateur.connect_failed",
    );
    expect(trace).toBeDefined();
    expect(trace?.champs?.paire).toBe("yuki:mattermost");
    expect(trace?.champs?.error).toContain("refusé");
  });
});

describe("⑥⑦ la synchronisation démarre APRÈS la connexion, dans le miroir du bot demandé", () => {
  it("activer à chaud ⇒ WebSocket ouvert ⇒ le canal apparaît dans le miroir du bot", async () => {
    const fixture = await startMmFixture(cleanups);
    const miroirA = openMmMirror(cleanups);
    const miroirB = openMmMirror(cleanups);
    const adaptateur = new MattermostChatAdapter({
      baseUrl: () => (miroirA.baseUrl() === "" ? fixture.baseUrl : miroirA.baseUrl()),
      token: () => MM_TOKEN,
      store: miroirA,
      logger: createLogger({ level: "error", sink: () => {}, secretValues: [MM_TOKEN] }),
    });
    cleanups.push(async () => {
      // Un arrêt sur socket non établi lève côté `ws` : le nettoyage ne doit pas
      // masquer le résultat du test.
      await adaptateur.disconnect().catch(() => undefined);
    });

    const adaptateurs = new AdaptateursChatBots<MattermostChatAdapter>({
      botDuRun: "yuki",
      resolution: { jetons: new Map(), conflits: [] },
      creer: () => adaptateur,
      logger: journalCapture(),
    });

    // Aucun bot connecté au départ (l'interrupteur était `off` au démarrage).
    expect(miroirA.records()[conversationIdOfChannel(MM_CHANNEL)]).toBeUndefined();

    await adaptateurs.rafraichirBot({
      botId: "yuki",
      jetons: new Map<PlateformeChat, JetonChat>([["mattermost", jeton("yuki")]]),
    });

    // ⑥ La synchro a démarré : le canal découvert est entré dans le miroir.
    await waitFor(
      () => miroirA.records()[conversationIdOfChannel(MM_CHANNEL)] !== undefined,
      "le canal découvert entre dans le miroir du bot",
    );
    // ⚠️ « on » exige l'authentification temps réel ET la synchro démarrée : c'est
    // la mesure exacte de la présence du bot dans Mattermost.
    await waitFor(() => adaptateur.status().etat === "on", "la connexion temps réel aboutit");
    await waitFor(() => fixture.open === 1, "un WebSocket est ouvert côté serveur");

    // ⑦ Le miroir de l'AUTRE bot n'a rien reçu : la paire est bien ciblée.
    expect(miroirB.records()).toEqual({});
  });

  it("deux bots : rafraîchir l'un ne touche pas la connexion de l'autre", async () => {
    const crees = new Map<string, AdaptateurEspion>();
    const adaptateurs = registre({ crees });
    await adaptateurs.rafraichirBot({
      botId: "yuki",
      jetons: new Map<PlateformeChat, JetonChat>([["mattermost", jeton("yuki")]]),
    });
    await adaptateurs.rafraichirBot({
      botId: "granolaf",
      jetons: new Map<PlateformeChat, JetonChat>([["mattermost", jeton("granolaf")]]),
    });

    // Éteindre granolaf laisse yuki connectée.
    await adaptateurs.rafraichirBot({
      botId: "granolaf",
      jetons: new Map<PlateformeChat, JetonChat>(),
    });
    expect(adaptateurs.estConnecte("granolaf", "mattermost")).toBe(false);
    expect(adaptateurs.estConnecte("yuki", "mattermost")).toBe(true);
    expect(crees.get("yuki:mattermost")?.appels).toEqual(["connect"]);
  });
});

describe("⑧ un miroir absent interdit la création (aucune connexion inventée)", () => {
  it("la fabrique qui lève est un ÉCHEC nommé, jamais une exception qui remonte", async () => {
    const journal = journalCapture();
    const adaptateurs = new AdaptateursChatBots<AdaptateurChatDemarrable>({
      botDuRun: "yuki",
      resolution: { jetons: new Map(), conflits: [] },
      creer: () => {
        throw new Error("Le miroir de discussion du bot « yuki » est indisponible");
      },
      logger: journal,
    });

    const bilan = await adaptateurs.rafraichirBot({
      botId: "yuki",
      jetons: new Map<PlateformeChat, JetonChat>([["mattermost", jeton("yuki")]]),
    });

    expect(bilan.echecs.map((echec) => echec.cle)).toEqual(["yuki:mattermost"]);
    expect(journal.lignes.some((ligne) => ligne.message === "chat.adaptateur.creation_failed")).toBe(
      true,
    );
  });
});

/** Le type de miroir importé sert aussi de garde : un miroir non ouvert lève. */
describe("⑨ le miroir d'un bot est bien un store à lui", () => {
  it("deux miroirs rendus par `openMmMirror` sont indépendants", () => {
    const a = openMmMirror(cleanups);
    const b = openMmMirror(cleanups);
    expect(a).toBeInstanceOf(ChatMirrorStore);
    expect(a).not.toBe(b);
    expect(a.records()).toEqual({});
    expect(b.records()).toEqual({});
  });
});
