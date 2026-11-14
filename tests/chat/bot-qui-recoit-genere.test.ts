/**
 * LE BOT QUI A REÇU LE MESSAGE EST CELUI QUI GÉNÈRE — Mattermost ET Discord.
 *
 * ⚠️ SYMPTÔME (2026-11-14, trois fois confirmé) : dans l'interface web, chaque bot
 * répond correctement ; dans Mattermost **et** dans Discord, tous répondaient
 * « je suis Yuki ». Le chemin commun aux deux plateformes déduisait le bot de la
 * table de propriété des canaux — table remplie à la PREMIÈRE publication. Un canal
 * qui n'avait encore rien publié retombait donc sur le bot du run (Yuki) : identité,
 * personnalité, outils, délégation et annuaire d'agents étaient les siens.
 *
 * ⚠️ CORRECTION : l'ADAPTATEUR connaît son `botId` (il est construit par bot). Il le
 * transmet au générateur (`ChatReplyGenerator.botId`) et au juge
 * (`ChatReplyJudge.botId`). Ce fichier le prouve contre les fixtures HTTP+WS des deux
 * plateformes, avec une personnalité DISTINCTE par bot.
 *
 * Échoue sur l'origine : ni `botId` sur les dépendances d'adaptateur, ni sur l'entrée
 * du générateur, ni sur celle du juge.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DiscordChatAdapter } from "../../src/chat/discord/adapter.js";
import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import { conversationIdOfChannel } from "../../src/chat/mirror/ingest.js";
import { conversationIdOfDiscordChannel } from "../../src/chat/mirror/ingest.js";
import { createRemoteReplyGenerator, promptRedacteurDuBot } from "../../src/chat/index.js";
import type { ChatReplyGenerator } from "../../src/chat/types.js";
import { createLogger } from "../../src/observability/logger.js";
import {
  MM_BOT_ID,
  MM_CHANNEL,
  MM_TOKEN,
  startMmFixture,
  waitFor,
} from "./mm-reply-fixture.js";
import {
  CHANNEL,
  TOKEN,
  messageFixture,
  startDiscordFixture,
} from "./discord-fixture.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const CONVERSATION_MM = conversationIdOfChannel(MM_CHANNEL);
const CONVERSATION_DISCORD = conversationIdOfDiscordChannel(CHANNEL);

/** Personnalités distinctes : marqueurs propres à chacune. */
const PERSONNALITES = {
  yuki: "Yuki est une entité unique.\nMême personne partout, quelle que soit la plateforme.",
  grolaf: "Le Cybergitan du 34.\nTu es Grolaf, une conscience numérique avec le bagout du sud.",
  kohai: "Kohai est un petit frère attentif.\nTu es Kohai, discret et précis.",
} as const;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function openStore(prefix: string): ChatMirrorStore {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return ChatMirrorStore.open({
    indexPath: join(root, "chat-mirror.json"),
    messagesDir: join(root, "chat-mirror"),
  });
}

interface Vu {
  botId?: string;
  prompt: string;
}

/**
 * Générateur TÉMOIN : il compose le prompt comme le fait `main()` (bot transmis par
 * l'adaptateur → `promptRedacteurDuBot`) et retient ce qu'il a reçu.
 */
function generateurTemoin(vus: Vu[]): ChatReplyGenerator {
  return async (input) => {
    const botId = input.botId ?? "yuki";
    const personnalite = PERSONNALITES[botId as keyof typeof PERSONNALITES] ?? PERSONNALITES.yuki;
    const prompt = promptRedacteurDuBot({
      botId,
      nom: botId,
      personnalite: { texte: personnalite, origine: "champ", provenance: "bot", fichier: null },
    });
    vus.push({ ...(input.botId !== undefined ? { botId: input.botId } : {}), prompt });
    return "réponse";
  };
}

describe("Mattermost — le bot qui a reçu le message génère SA réponse", () => {
  it("`grolaf` reçoit une mention ⇒ le générateur reçoit `grolaf` et SON prompt", async () => {
    const vus: Vu[] = [];
    let juges = 0;
    const store = openStore("yuki-botid-mm-");
    const fixture = await startMmFixture(cleanups);
    const adapter = new MattermostChatAdapter({
      botId: "grolaf",
      baseUrl: () => fixture.baseUrl,
      token: () => MM_TOKEN,
      store,
      logger,
      pollIntervalMs: 0,
      judge: async () => {
        juges += 1;
        return true;
      },
      generateReply: generateurTemoin(vus),
    });
    cleanups.push(() => adapter.disconnect());
    await adapter.connect();
    await waitFor(() => fixture.open > 0, "la connexion temps réel");
    await waitFor(() => store.conversations().length > 0, "les canaux");
    store.setReplyMode(CONVERSATION_MM, "auto");

    // ⚠️ L'identifiant brut du bot est un alias : la mention est reconnue SANS juge,
    // même si le pseudo du fixture n'est pas celui du déploiement.
    fixture.broadcast("posted", {
      id: "post-grolaf-1",
      channel_id: MM_CHANNEL,
      user_id: "humain-1",
      message: `allo ${MM_BOT_ID} ?`,
      create_at: Date.now(),
    });

    await waitFor(() => vus.length > 0, "la génération");
    expect(vus[0]?.botId).toBe("grolaf");
    expect(vus[0]?.prompt).toContain("Tu es grolaf");
    expect(vus[0]?.prompt).toContain("Cybergitan du 34");
    expect(vus[0]?.prompt).not.toContain("Même personne partout");
    // ⚠️ Une mention (même par identifiant brut) suffit : aucun appel au juge.
    expect(juges).toBe(0);
  });
});

describe("Discord — un TROISIÈME bot génère avec SA personnalité", () => {
  it("`kohai` reçoit un message ⇒ le générateur reçoit `kohai`, jamais Yuki", async () => {
    const vus: Vu[] = [];
    const store = openStore("yuki-botid-dc-");
    const fixture = await startDiscordFixture({ heartbeatIntervalMs: 5_000 });
    const adapter = new DiscordChatAdapter({
      botId: "kohai",
      token: () => TOKEN,
      store,
      pollIntervalMs: 0,
      apiBase: fixture.apiBase,
      gatewayUrl: fixture.gatewayUrl,
      judge: async () => true,
      generateReply: generateurTemoin(vus),
    });
    cleanups.push(() => adapter.disconnect());
    await adapter.connect();
    await waitFor(() => adapter.status().etat === "on", "la session");
    await waitFor(() => store.conversations().length > 0, "les salons");
    // ⚠️ `tout` : ce fichier prouve QUI génère, pas la détection d'adresse (elle a
    // son propre test, `adresse-avant-juge.test.ts`).
    store.setReplyMode(CONVERSATION_DISCORD, "tout");
    fixture.dispatch(
      "MESSAGE_CREATE",
      messageFixture({ id: "111111111111111199", content: "tu peux m'aider ?" }),
      2,
    );

    await waitFor(() => vus.length > 0, "la génération");
    expect(vus[0]?.botId).toBe("kohai");
    expect(vus[0]?.prompt).toContain("Tu es kohai");
    expect(vus[0]?.prompt).not.toContain("Même personne partout");
  });
});

describe("le bot du tour porte AUSSI les outils, la délégation et les extensions", () => {
  it("`contexte.botId` est celui de l'adaptateur, et AUCUNE extension d'un autre bot ne s'invite", async () => {
    const contextes: (string | undefined)[] = [];
    const extensions = [{ name: "extension-du-bot" }];
    let extensionsRecues: readonly unknown[] | undefined;
    const generateur = createRemoteReplyGenerator({
      available: () => true,
      botName: (_conversationId, botId) => botId ?? "yuki",
      runTools: (_conversationId, _onFileProduced, contexte) => {
        contextes.push(contexte.botId);
        return {
          tools: ["lire_fichier"],
          customTools: [],
          extensionFactories: extensions,
        };
      },
      createWriter: (run) => {
        extensionsRecues = run.extensionFactories?.() ?? [];
        return async () => "réponse";
      },
    });
    await generateur({
      channelTitle: "salon",
      transcript: [],
      message: {
        remoteId: "m1",
        conversationId: "dc-123",
        text: "salut",
        sentAt: "2026-11-14 15:20",
        role: "user",
        author: { id: "u1", nom: "Nico", estBot: false },
      },
      botId: "kohai",
    });
    // ⚠️ Outils, délégation et annuaire d'agents de la génération sont CEUX de
    // `kohai` — jamais ceux du bot du run.
    expect(contextes).toEqual(["kohai"]);
    // ⚠️ La seule source d'extensions du run est la politique de CE bot : rien
    // (mémoire, consignes, règles d'un autre bot) ne peut s'ajouter ici.
    expect(extensionsRecues).toBe(extensions);
  });
});

describe("le web et le distant nomment le MÊME bot", () => {
  it("`grolaf` : prompt du canal et prompt local portent la même personnalité", () => {
    const canal = promptRedacteurDuBot({
      botId: "grolaf",
      nom: "grolaf",
      personnalite: {
        texte: PERSONNALITES.grolaf,
        origine: "champ",
        provenance: "bot",
        fichier: null,
      },
      autres: [{ botId: "yuki", texte: PERSONNALITES.yuki }],
    });
    expect(canal.startsWith("Tu es grolaf")).toBe(true);
    expect(canal).toContain(PERSONNALITES.grolaf);
    expect(canal).not.toContain("Même personne partout");
  });
});
