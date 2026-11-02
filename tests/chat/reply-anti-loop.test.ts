/**
 * ANTI-BOUCLE — un post de YUKI (accusé, résultat, rapport de job, publication
 * inter-canal) ne déclenche **AUCUN** run.
 *
 * ⚠️ CE QUE CE FICHIER VERROUILLE, et qui devient CRITIQUE avec la progression :
 * la fonctionnalité qui vient d'être livrée fait publier à Yuki **plusieurs** messages
 * par tour (accusé, image, ligne d'échec). Chacun revient par le temps réel `posted`.
 * Si un seul était pris pour une question humaine, la boucle serait immédiate :
 * ack → réponse → ack…
 *
 * Ce que ce fichier prouve, contre un SERVEUR FIXTURE RÉEL (HTTP + WS) :
 *  1. un message humain déclenche UN run, et un seul ;
 *  2. l'ÉCHO de tous les posts de Yuki (accusé, résultat, rapport de job, publication
 *     dans un autre canal) ne déclenche AUCUN run supplémentaire ;
 *  3. la règle est la MÊME pour un post lu depuis le miroir : auteur = bot ⇒ `auteur_bot`.
 *
 * ⚠️ Échoue sur le code d'origine : `publier` n'existe pas (Yuki ne publiait qu'un
 * message par tour), et l'accusé n'existait pas du tout à distance.
 */

import { afterEach, describe, expect, it } from "vitest";

import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { conversationIdOfChannel, postToRemoteMessage } from "../../src/chat/mirror/ingest.js";
import { decideReply } from "../../src/chat/reply/responder.js";
import type { ChatReplyGenerator } from "../../src/chat/types.js";
import { createLogger } from "../../src/observability/logger.js";
import {
  MM_BOT_ID,
  MM_CHANNEL,
  MM_TOKEN,
  openMmMirror,
  startMmFixture,
  waitFor,
} from "./mm-reply-fixture.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const CONVERSATION = conversationIdOfChannel(MM_CHANNEL);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Génération simulée : elle accuse, produit un résultat, puis répond. */
function generateurTrace(appels: string[]): ChatReplyGenerator {
  return async (input) => {
    appels.push(input.message.remoteId);
    // ⚠️ L'accusé part AVANT le travail : c'est un post supplémentaire, donc une
    // nouvelle occasion de boucler.
    await input.publier?.({ text: "Deux secondes." });
    await input.publier?.({ text: "L'action « generer_image » a échoué : je continue sans elle." });
    return "Voilà la réponse de fond.";
  };
}

describe("anti-boucle — nos propres posts ne déclenchent aucun run", () => {
  it("un message humain déclenche UN run, et l'écho de nos trois posts aucun", async () => {
    const fixture = await startMmFixture(cleanups);
    const store = openMmMirror(cleanups);
    const appels: string[] = [];

    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => MM_TOKEN,
      store,
      pollIntervalMs: 0,
      generateReply: generateurTrace(appels),
      logger,
    });
    cleanups.push(() => adapter.disconnect());

    await adapter.connect();
    await waitFor(() => fixture.open > 0, "la connexion temps réel");
    store.setReplyMode(CONVERSATION, "tout");

    // ① Le message HUMAIN.
    fixture.broadcast("posted", {
      id: "humain-1",
      channel_id: MM_CHANNEL,
      user_id: "humain-1",
      message: "génère une image",
      create_at: Date.now(),
    });
    await waitFor(() => appels.length === 1, "le premier run");
    await waitFor(() => fixture.created.length >= 3, "les posts d'accusé et de résultat");

    // ② RAPPORT DE JOB et PUBLICATION INTER-CANAL : deux autres posts de Yuki, par le
    //    MÊME chemin d'envoi que la progression.
    await adapter.send(CONVERSATION, { kind: "texte", text: "Tâche terminée : 3 fichiers." });
    await adapter.send(CONVERSATION, { kind: "texte", text: "Message publié dans #Imagerie." });

    // ③ LE SERVEUR RENVOIE TOUS CES POSTS par le temps réel (c'est ce qu'il fait en
    //    production : `send` insère, puis l'écho `posted` arrive).
    for (const post of [...fixture.created]) {
      fixture.broadcast("posted", {
        id: String(post.id ?? `inconnu-${Math.random()}`),
        channel_id: MM_CHANNEL,
        user_id: MM_BOT_ID,
        message: String(post.message ?? ""),
        create_at: Date.now(),
      });
    }

    // ④ Laisse le temps à un éventuel (mauvais) second run de partir.
    await new Promise((resolve) => setTimeout(resolve, 150));

    // UN SEUL run : celui du message humain.
    expect(appels).toEqual(["humain-1"]);
    // Et la progression a bien produit plusieurs posts (le risque était réel).
    expect(fixture.created.length).toBeGreaterThanOrEqual(3);
  });

  it("un post de Yuki lu depuis le miroir est classé `auteur_bot` (même règle, autre chemin)", async () => {
    const store = openMmMirror(cleanups);
    store.upsert({
      remoteId: "x",
      conversationId: CONVERSATION,
      author: { id: MM_BOT_ID, nom: "yuki", estBot: true },
      role: "assistant",
      text: "Deux secondes.",
      sentAt: new Date().toISOString(),
    });

    // Un post brut de l'API, tel que le serveur le renvoie, avec l'identifiant du bot.
    const message = postToRemoteMessage(
      {
        id: "post-bot",
        channel_id: MM_CHANNEL,
        user_id: MM_BOT_ID,
        message: "L'action « generer_image » a échoué : je continue sans elle.",
        create_at: Date.now(),
      } as never,
      { platform: "mattermost", conversationId: CONVERSATION, botUserId: MM_BOT_ID },
    );

    expect(message.author.estBot).toBe(true);
    expect(message.role).toBe("assistant");

    // ⚠️ Même en mode « répondre à TOUS », l'anti-boucle passe AVANT le mode.
    const decision = await decideReply({
      message,
      replyMode: "tout",
      botUserId: MM_BOT_ID,
      aliases: ["@yuki"],
    });
    expect(decision.repondre).toBe(false);
    expect(decision.raison).toBe("auteur_bot");
  });
});
