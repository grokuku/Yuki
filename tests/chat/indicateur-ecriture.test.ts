/**
 * INDICATEUR « le bot est en train d'écrire » (demande utilisateur du 2026-11-14) :
 * « de la réception du message jusqu'à l'envoi de la dernière réponse ».
 *
 * Ce que ce fichier verrouille, et pourquoi c'est structurel et non cosmétique :
 *  1. le signal part AVANT le juge et avant le modèle (test central, ordre des appels) ;
 *  2. il est RÉÉMIS avant expiration, sur les DEUX plateformes (Discord ~10 s ⇒ 8 s,
 *     Mattermost ~5 s ⇒ 3 s), avec des intervalles réduits ici pour rester rapides ;
 *  3. il s'arrête dans TOUS les cas de sortie : refus du juge, erreur, plafond dur,
 *     et juste AVANT l'envoi du dernier message ;
 *  4. il ne bloque jamais la réponse : un échec d'émission est journalisé une fois ;
 *  5. il n'y a qu'UNE boucle par canal : deux messages consécutifs ne la doublent pas ;
 *  6. le signal part dans le CANAL DU FIL, jamais dans le salon parent.
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/reply/indicateur.ts` n'existe pas, et ni
 * `POST /channels/{id}/typing` ni `user_typing` n'étaient jamais émis.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiscordChatAdapter } from "../../src/chat/discord/adapter.js";
import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import {
  conversationIdOfChannel,
  conversationIdOfDiscordChannel,
} from "../../src/chat/mirror/ingest.js";
import { IndicateursEcriture } from "../../src/chat/reply/indicateur.js";
import {
  BOT_ID as DISCORD_BOT_ID,
  CHANNEL,
  THREAD,
  TOKEN as DISCORD_TOKEN,
  messageFixture,
  startDiscordFixture,
} from "./discord-fixture.js";
import {
  MM_BOT_ID,
  MM_CHANNEL,
  MM_TOKEN,
  openMmMirror,
  startMmFixture,
  waitFor as waitForMm,
} from "./mm-reply-fixture.js";

const CONVERSATION = conversationIdOfDiscordChannel(CHANNEL);
const CONVERSATION_MM = conversationIdOfChannel(MM_CHANNEL);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// ─── Outillage ──────────────────────────────────────────────────────────────

interface Evenement {
  message: string;
  champs?: Record<string, unknown>;
}

/** Journal ENREGISTRANT : l'ordre des lignes est la preuve de l'ordre des décisions. */
function journalMemoire(): {
  logger: {
    debug: (message: string, champs?: Record<string, unknown>) => void;
    info: (message: string, champs?: Record<string, unknown>) => void;
    warn: (message: string, champs?: Record<string, unknown>) => void;
  };
  evenements: Evenement[];
} {
  const evenements: Evenement[] = [];
  const pousser = (message: string, champs?: Record<string, unknown>): void => {
    evenements.push(champs === undefined ? { message } : { message, champs });
  };
  return { logger: { debug: pousser, info: pousser, warn: pousser }, evenements };
}

/** Horloge SIMULÉE : minuteurs pilotés à la main, aucun `sleep` dans le test. */
function horlogeSimulee() {
  let t = 0;
  let seq = 0;
  const taches = new Map<number, { at: number; fn: () => void }>();
  return {
    now: (): number => t,
    setTimer: (fn: () => void, ms: number): unknown => {
      const id = ++seq;
      taches.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (handle: unknown): void => {
      taches.delete(handle as number);
    },
    async avancer(ms: number): Promise<void> {
      const cible = t + ms;
      for (;;) {
        let choisi: [number, { at: number; fn: () => void }] | undefined;
        for (const entree of taches) {
          if (entree[1].at > cible) continue;
          if (choisi === undefined || entree[1].at < choisi[1].at) choisi = entree;
        }
        if (choisi === undefined) break;
        taches.delete(choisi[0]);
        t = choisi[1].at;
        choisi[1].fn();
        // Laisse les promesses d'émission se résoudre avant la tâche suivante.
        await Promise.resolve();
      }
      t = cible;
    },
    get enAttente(): number {
      return taches.size;
    },
  };
}

function openStore(): ChatMirrorStore {
  const root = mkdtempSync(join(tmpdir(), "yuki-indicateur-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return ChatMirrorStore.open({
    indexPath: join(root, "chat-mirror.json"),
    messagesDir: join(root, "chat-mirror"),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startDiscord(
  store: ChatMirrorStore,
  options: {
    generateReply: ConstructorParameters<typeof DiscordChatAdapter>[0]["generateReply"];
    indicateur?: ConstructorParameters<typeof DiscordChatAdapter>[0]["indicateur"];
    judge?: ConstructorParameters<typeof DiscordChatAdapter>[0]["judge"];
    logger?: ReturnType<typeof journalMemoire>["logger"];
  },
) {
  const fixture = await startDiscordFixture({ heartbeatIntervalMs: 5_000 });
  const adapter = new DiscordChatAdapter({
    token: () => DISCORD_TOKEN,
    store,
    pollIntervalMs: 0,
    apiBase: fixture.apiBase,
    gatewayUrl: fixture.gatewayUrl,
    botId: DISCORD_BOT_ID,
    generateReply: options.generateReply,
    ...(options.indicateur ? { indicateur: options.indicateur } : {}),
    ...(options.judge ? { judge: options.judge } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  cleanups.push(() => adapter.disconnect());
  await adapter.connect();
  await waitForCondition(() => adapter.status().etat === "on", "la session Discord");
  await waitForCondition(() => store.conversations().length > 0, "les salons Discord");
  return { fixture, adapter };
}

async function waitForCondition(
  check: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    if (check()) return;
    await sleep(10);
  }
  throw new Error(`Délai dépassé en attendant : ${label}`);
}

const fins = (evenements: Evenement[]): Evenement[] =>
  evenements.filter((entree) => entree.message === "chat.indicateur.fin");
const debuts = (evenements: Evenement[]): Evenement[] =>
  evenements.filter((entree) => entree.message === "chat.indicateur.debut");

// ─── ① La boucle elle-même ──────────────────────────────────────────────────

describe("boucle d'indicateur — émission, plafond, échec, partage", () => {
  it("émet IMMÉDIATEMENT puis à chaque intervalle (horloge simulée)", async () => {
    const horloge = horlogeSimulee();
    const emissions: number[] = [];
    const indicateurs = new IndicateursEcriture({
      emettre: () => {
        emissions.push(horloge.now());
      },
      intervalMs: 100,
      plafondMs: 10_000,
      now: horloge.now,
      setTimer: horloge.setTimer,
      clearTimer: horloge.clearTimer,
    });
    const prise = indicateurs.demarrer("canal-1");
    // ⚠️ PREMIÈRE émission SYNCHRONE : elle précède le juge (appelé juste après).
    expect(emissions).toEqual([0]);
    await horloge.avancer(100);
    expect(emissions).toEqual([0, 100]);
    await horloge.avancer(250);
    expect(emissions).toEqual([0, 100, 200, 300]);
    prise.arreter("envoye");
    const apres = emissions.length;
    await horloge.avancer(1_000);
    expect(emissions).toHaveLength(apres);
    expect(indicateurs.actives).toBe(0);
  });

  it("plafond dur atteint ⇒ arrêt automatique (raison `plafond`)", async () => {
    const horloge = horlogeSimulee();
    const { logger, evenements } = journalMemoire();
    const indicateurs = new IndicateursEcriture({
      emettre: () => undefined,
      intervalMs: 100,
      plafondMs: 250,
      logger,
      now: horloge.now,
      setTimer: horloge.setTimer,
      clearTimer: horloge.clearTimer,
    });
    const prise = indicateurs.demarrer("canal-plafond");
    await horloge.avancer(1_000);
    expect(prise.actif).toBe(false);
    expect(indicateurs.actives).toBe(0);
    expect(fins(evenements)).toHaveLength(1);
    expect(fins(evenements)[0]?.champs?.raison).toBe("plafond");
  });

  it("échec d'émission : journalisé UNE fois, et la boucle continue", async () => {
    const horloge = horlogeSimulee();
    const { logger, evenements } = journalMemoire();
    let appels = 0;
    const indicateurs = new IndicateursEcriture({
      emettre: () => {
        appels += 1;
        throw new Error("plateforme injoignable");
      },
      intervalMs: 100,
      plafondMs: 10_000,
      logger,
      now: horloge.now,
      setTimer: horloge.setTimer,
      clearTimer: horloge.clearTimer,
    });
    const prise = indicateurs.demarrer("canal-echec");
    await horloge.avancer(350);
    expect(appels).toBeGreaterThanOrEqual(4);
    // ⚠️ UNE seule ligne d'échec, pas une par rafraîchissement.
    expect(evenements.filter((e) => e.message === "chat.indicateur.echec")).toHaveLength(1);
    prise.arreter("envoye");
  });

  it("deux prises sur le même canal : UNE seule boucle, arrêt à la dernière", async () => {
    const horloge = horlogeSimulee();
    const { logger, evenements } = journalMemoire();
    let emissions = 0;
    const indicateurs = new IndicateursEcriture({
      emettre: () => {
        emissions += 1;
      },
      intervalMs: 100,
      plafondMs: 10_000,
      logger,
      now: horloge.now,
      setTimer: horloge.setTimer,
      clearTimer: horloge.clearTimer,
    });
    const premiere = indicateurs.demarrer("canal-partage");
    const seconde = indicateurs.demarrer("canal-partage");
    // ⚠️ Aucune seconde boucle : une seule émission immédiate pour deux prises.
    expect(emissions).toBe(1);
    expect(debuts(evenements)).toHaveLength(1);
    await horloge.avancer(100);
    expect(emissions).toBe(2);
    premiere.arreter("envoye");
    // La seconde prise tient la boucle en vie.
    expect(indicateurs.boucleActive("canal-partage")).toBe(true);
    await horloge.avancer(100);
    expect(emissions).toBe(3);
    seconde.arreter("envoye");
    expect(indicateurs.actives).toBe(0);
    expect(fins(evenements)).toHaveLength(1);
    // Arrêt idempotent : une seule ligne de fin, même après un second appel.
    seconde.arreter("erreur");
    expect(fins(evenements)).toHaveLength(1);
  });
});

// ─── ② Discord ──────────────────────────────────────────────────────────────

describe("Discord — `POST /channels/{id}/typing`", () => {
  it("démarre AVANT le juge, et le modèle vient après (ordre des appels)", async () => {
    const store = openStore();
    const ordre: string[] = [];
    const { fixture } = await startDiscord(store, {
      judge: async () => {
        ordre.push("juge");
        return true;
      },
      generateReply: async () => {
        ordre.push("modele");
        return "Bonjour.";
      },
      indicateur: {
        emettre: () => {
          ordre.push("typing");
        },
        intervalMs: 50,
        plafondMs: 1_000,
      },
    });
    store.setReplyMode(CONVERSATION, "auto");
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({ id: "111111111111111201", content: "bonjour" }),
      2,
    );
    await waitForCondition(() => fixture.posts.length === 1, "la réponse Discord");
    // ⚠️ LE TEST CENTRAL : le signal part à la RÉCEPTION, avant toute décision coûteuse.
    expect(ordre[0]).toBe("typing");
    expect(ordre.indexOf("typing")).toBeLessThan(ordre.indexOf("juge"));
    expect(ordre.indexOf("juge")).toBeLessThan(ordre.indexOf("modele"));
  });

  it("le signal est RÉÉMIS avant expiration (vraie route REST)", async () => {
    const store = openStore();
    const { fixture } = await startDiscord(store, {
      generateReply: async () => {
        // ⚠️ Le client REST Discord espace ses requêtes (250 ms) : la fenêtre doit
        // couvrir au moins deux intervalles pour prouver la RÉÉMISSION.
        await sleep(900);
        return "Réponse lente.";
      },
      indicateur: { intervalMs: 250, plafondMs: 5_000 },
    });
    store.setReplyMode(CONVERSATION, "tout");
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({ id: "111111111111111202", content: "salut" }),
      2,
    );
    await waitForCondition(() => fixture.posts.length === 1, "la réponse Discord");
    const typings = fixture.requests.filter(
      (requete) => requete.path === `/channels/${CHANNEL}/typing`,
    );
    expect(typings.length).toBeGreaterThanOrEqual(2);
    expect(typings.every((requete) => requete.method === "POST")).toBe(true);
    // ⚠️ Le jeton du bot est celui de l'adaptateur, jamais une autre valeur.
    expect(typings[0]?.authorization).toBe(`Bot ${DISCORD_TOKEN}`);
    // Arrêt après la réponse : plus aucune émission une fois le tour fini.
    const apres = typings.length;
    await sleep(80);
    expect(
      fixture.requests.filter((requete) => requete.path === `/channels/${CHANNEL}/typing`),
    ).toHaveLength(apres);
  });

  it("juge = non ⇒ indicateur arrêté IMMÉDIATEMENT (raison `refus`)", async () => {
    const store = openStore();
    const { logger, evenements } = journalMemoire();
    const { fixture } = await startDiscord(store, {
      judge: async () => false,
      generateReply: async () => "ne devrait jamais partir",
      logger,
      indicateur: { intervalMs: 25, plafondMs: 2_000 },
    });
    store.setReplyMode(CONVERSATION, "auto");
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({ id: "111111111111111203", content: "rien à voir" }),
      2,
    );
    await waitForCondition(() => fins(evenements).length === 1, "l'arrêt de l'indicateur");
    expect(fins(evenements)[0]?.champs?.raison).toBe("refus");
    expect(fixture.posts).toHaveLength(0);
  });

  it("réponse en 3 messages ⇒ indicateur actif jusqu'au 3e, arrêté ensuite", async () => {
    const store = openStore();
    const { logger, evenements } = journalMemoire();
    let finsPendant: number[] = [];
    const { fixture } = await startDiscord(store, {
      generateReply: async (input) => {
        finsPendant.push(fins(evenements).length);
        await input.publier?.({ text: "Je regarde." });
        finsPendant.push(fins(evenements).length);
        await sleep(40);
        await input.publier?.({ text: "Encore deux secondes." });
        finsPendant.push(fins(evenements).length);
        await sleep(40);
        return "Voilà la réponse finale.";
      },
      logger,
      indicateur: { intervalMs: 20, plafondMs: 2_000 },
    });
    store.setReplyMode(CONVERSATION, "tout");
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({ id: "111111111111111204", content: "tu peux ?" }),
      2,
    );
    await waitForCondition(() => fixture.posts.length === 3, "les trois messages");
    // ⚠️ Aucun arrêt pendant les messages intermédiaires : le 3e est la réponse finale.
    expect(finsPendant).toEqual([0, 0, 0]);
    expect(fins(evenements)).toHaveLength(1);
    expect(fins(evenements)[0]?.champs?.raison).toBe("envoye");
  });

  it("erreur du générateur ⇒ indicateur arrêté (aucun orphelin)", async () => {
    const store = openStore();
    const { logger, evenements } = journalMemoire();
    const { fixture } = await startDiscord(store, {
      generateReply: async () => {
        throw new Error("modèle indisponible");
      },
      logger,
      indicateur: { intervalMs: 25, plafondMs: 2_000 },
    });
    store.setReplyMode(CONVERSATION, "tout");
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({ id: "111111111111111205", content: "coucou" }),
      2,
    );
    await waitForCondition(() => fins(evenements).length === 1, "l'arrêt de l'indicateur");
    expect(fins(evenements)[0]?.champs?.raison).toBe("erreur");
    expect(fixture.posts).toHaveLength(0);
  });

  it("plafond dur atteint ⇒ arrêt automatique (jamais de boucle infinie)", async () => {
    const store = openStore();
    const { logger, evenements } = journalMemoire();
    const { fixture } = await startDiscord(store, {
      generateReply: async () => {
        await sleep(200);
        return "trop tard";
      },
      logger,
      indicateur: { intervalMs: 20, plafondMs: 60 },
    });
    store.setReplyMode(CONVERSATION, "tout");
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({ id: "111111111111111206", content: "lent" }),
      2,
    );
    await waitForCondition(
      () => fins(evenements).some((e) => e.champs?.raison === "plafond"),
      "le plafond",
    );
    expect(fixture.posts).toHaveLength(0);
  });

  it("échec de l'indicateur ⇒ la réponse part quand même (journalisé une fois)", async () => {
    const store = openStore();
    const { logger, evenements } = journalMemoire();
    const { fixture } = await startDiscord(store, {
      generateReply: async () => "Réponse malgré l'échec.",
      logger,
      indicateur: {
        emettre: () => {
          throw new Error("indicateur cassé");
        },
        intervalMs: 20,
        plafondMs: 500,
      },
    });
    store.setReplyMode(CONVERSATION, "tout");
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({ id: "111111111111111207", content: "test" }),
      2,
    );
    await waitForCondition(() => fixture.posts.length === 1, "la réponse");
    expect(evenements.filter((e) => e.message === "chat.indicateur.echec")).toHaveLength(1);
    expect(fins(evenements)[0]?.champs?.raison).toBe("envoye");
  });

  it("deux messages consécutifs ⇒ UNE seule boucle (pas de doublon)", async () => {
    const store = openStore();
    const { logger, evenements } = journalMemoire();
    const { fixture } = await startDiscord(store, {
      generateReply: async () => {
        await sleep(90);
        return "réponse";
      },
      logger,
      indicateur: { intervalMs: 25, plafondMs: 2_000 },
    });
    store.setReplyMode(CONVERSATION, "tout");
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({ id: "111111111111111208", content: "un" }),
      2,
    );
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({ id: "111111111111111209", content: "deux" }),
      3,
    );
    await waitForCondition(() => fixture.posts.length === 2, "les deux réponses");
    // ⚠️ UN seul démarrage et UN seul arrêt pour le canal, malgré deux runs.
    expect(debuts(evenements)).toHaveLength(1);
    await waitForCondition(() => fins(evenements).length === 1, "l'arrêt final");
    expect(fins(evenements)[0]?.champs?.raison).toBe("envoye");
  });

  it("fil : le signal part dans le SALON DU FIL, jamais dans le parent", async () => {
    const store = openStore();
    const canaux: string[] = [];
    const { fixture } = await startDiscord(store, {
      generateReply: async () => "réponse dans le fil",
      indicateur: {
        emettre: (_conversation, canal) => {
          canaux.push(canal);
        },
        intervalMs: 1_000,
        plafondMs: 2_000,
      },
    });
    store.setReplyMode(CONVERSATION, "tout");
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({
        id: "111111111111111210",
        channel_id: THREAD,
        channel_type: 11,
        content: "dans un fil",
      }),
      2,
    );
    await waitForCondition(() => fixture.posts.length === 1, "la réponse dans le fil");
    expect(canaux[0]).toBe(THREAD);
  });
});

// ─── ③ Mattermost ───────────────────────────────────────────────────────────

const cleanupsMm: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupsMm.splice(0).reverse()) await cleanup();
});

describe("Mattermost — événement `user_typing`", () => {
  it("le signal est émis puis RÉÉMIS sur le canal du message", async () => {
    const fixture = await startMmFixture(cleanupsMm);
    const store = openMmMirror(cleanupsMm);
    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => MM_TOKEN,
      store,
      pollIntervalMs: 0,
      botId: MM_BOT_ID,
      generateReply: async () => {
        await sleep(120);
        return "Réponse lente.";
      },
      indicateur: { intervalMs: 25, plafondMs: 2_000 },
    });
    cleanupsMm.push(() => adapter.disconnect());
    await adapter.connect();
    await waitForMm(() => fixture.open > 0, "la connexion temps réel");
    store.setReplyMode(CONVERSATION_MM, "tout");

    fixture.broadcast("posted", {
      id: "humain-typing-1",
      channel_id: MM_CHANNEL,
      user_id: "humain-typing-1",
      message: "tu es là ?",
      create_at: Date.now(),
    });
    await waitForMm(() => fixture.created.length >= 1, "la réponse Mattermost");

    expect(fixture.typingFrames.length).toBeGreaterThanOrEqual(2);
    expect(fixture.typingFrames.every((trame) => trame.channel_id === MM_CHANNEL)).toBe(true);
    // ⚠️ `seq` strictement croissant : deux émissions ne se confondent pas.
    const seqs = fixture.typingFrames.map((trame) => trame.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    // Plus aucune trame après la fin du tour (l'indicateur est bien arrêté).
    const apres = fixture.typingFrames.length;
    await sleep(80);
    expect(fixture.typingFrames).toHaveLength(apres);
  });

  it("une réponse dans un FIL émet sur le canal qui contient le fil", async () => {
    const fixture = await startMmFixture(cleanupsMm);
    const store = openMmMirror(cleanupsMm);
    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => MM_TOKEN,
      store,
      pollIntervalMs: 0,
      botId: MM_BOT_ID,
      generateReply: async () => "réponse au fil",
      indicateur: { intervalMs: 1_000, plafondMs: 2_000 },
    });
    cleanupsMm.push(() => adapter.disconnect());
    await adapter.connect();
    await waitForMm(() => fixture.open > 0, "la connexion temps réel");
    store.setReplyMode(CONVERSATION_MM, "tout");

    fixture.broadcast("posted", {
      id: "racine-fil-1",
      channel_id: MM_CHANNEL,
      user_id: "humain-fil-1",
      message: "racine",
      create_at: Date.now(),
    });
    await waitForMm(() => fixture.created.length >= 1, "le premier post");
    fixture.broadcast("posted", {
      id: "dans-fil-1",
      channel_id: MM_CHANNEL,
      user_id: "humain-fil-1",
      message: "dans le fil",
      root_id: "racine-fil-1",
      create_at: Date.now(),
    });
    await waitForMm(() => fixture.created.length >= 2, "la réponse au fil");

    // Mattermost n'a pas de salon de fil : c'est le CANAL qui porte l'indicateur.
    expect(fixture.typingFrames.length).toBeGreaterThanOrEqual(2);
    expect(fixture.typingFrames.every((trame) => trame.channel_id === MM_CHANNEL)).toBe(true);
  });
});
