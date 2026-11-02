/**
 * BACKFILL — `historique: true` ⇒ **ZÉRO run**, même quand le lot contient un accusé.
 *
 * ⚠️ CE QUE CE FICHIER VERROUILLE, et pourquoi il est OBLIGATOIRE après ce lot : la
 * progression publie désormais plusieurs messages par tour (accusé, image, échec). Au
 * premier branchement, le backfill des 14 derniers jours rejoue TOUT l'historique du
 * canal — accusés compris. Sans l'étiquette `historique`, Yuki répondrait aux mentions
 * de la semaine dernière ET prendrait ses propres accusés pour des questions.
 *
 * Ce que ce fichier prouve, contre un SERVEUR FIXTURE RÉEL :
 *  1. les messages de l'historique sont IMPORTÉS (l'interface doit les voir) ;
 *  2. AUCUN d'eux ne déclenche de run — ni la mention humaine, ni l'accusé du bot ;
 *  3. le TEMPS RÉEL, lui, déclenche : la coupure est nette et ne casse pas la réponse.
 *
 * ⚠️ Échoue sur le code d'origine : `publier` n'existe pas, donc aucun accusé ne peut
 * être présent dans un lot d'historique — le cas exact que cette garde protège.
 */

import { afterEach, describe, expect, it } from "vitest";

import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { conversationIdOfChannel } from "../../src/chat/mirror/ingest.js";
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

/** Historique : une mention humaine ancienne ET un accusé publié par Yuki. */
function historique(): Array<Record<string, unknown>> {
  const ilYa3Jours = Date.now() - 3 * 24 * 3600 * 1000;
  return [
    {
      id: "vieux-humain",
      channel_id: MM_CHANNEL,
      user_id: "humain-1",
      message: "@yuki tu peux me générer une image ?",
      create_at: ilYa3Jours,
    },
    {
      id: "vieux-ack",
      channel_id: MM_CHANNEL,
      user_id: MM_BOT_ID,
      message: "Deux secondes.",
      create_at: ilYa3Jours + 1000,
    },
    {
      id: "vieux-resultat",
      channel_id: MM_CHANNEL,
      user_id: MM_BOT_ID,
      message: "Voici l'image.",
      create_at: ilYa3Jours + 2000,
    },
  ];
}

describe("backfill — l'historique est importé mais ne déclenche aucun run", () => {
  it("trois messages rejoués (dont un accusé) ⇒ ZÉRO run ; le temps réel, lui, répond", async () => {
    const fixture = await startMmFixture(cleanups, { backlog: historique() });
    const store = openMmMirror(cleanups);
    const appels: string[] = [];
    /** `publier` reçu par le générateur : la progression est-elle branchée ? */
    const progressions: Array<boolean> = [];
    const generateur: ChatReplyGenerator = async (input) => {
      appels.push(input.message.remoteId);
      progressions.push(typeof input.publier === "function");
      await input.publier?.({ text: "Deux secondes." });
      return "réponse";
    };

    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => MM_TOKEN,
      store,
      pollIntervalMs: 0,
      generateReply: generateur,
      logger,
    });
    cleanups.push(() => adapter.disconnect());

    await adapter.connect();
    await waitFor(() => fixture.open > 0, "la connexion temps réel");
    // ① L'historique est bien IMPORTÉ dans le miroir (l'interface doit le voir).
    await waitFor(
      () => store.message(CONVERSATION, "vieux-ack") !== undefined,
      "l'import de l'historique",
    );
    expect(store.messages(CONVERSATION)).toHaveLength(3);
    // ② …et pourtant AUCUN run : même en mode « répondre à tous ».
    store.setReplyMode(CONVERSATION, "tout");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(appels).toEqual([]);

    // ③ Le TEMPS RÉEL déclenche, lui : la garde ne bloque pas les vraies questions.
    fixture.broadcast("posted", {
      id: "recent-humain",
      channel_id: MM_CHANNEL,
      user_id: "humain-1",
      message: "et maintenant ?",
      create_at: Date.now(),
    });
    await waitFor(() => appels.length === 1, "le run du message récent");
    expect(appels).toEqual(["recent-humain"]);
    // ⚠️ Le run du TEMPS RÉEL reçoit bien `publier` : sans lui, aucun accusé ne partirait
    // (c'est l'adaptateur qui l'ancre au bon fil). L'historique, lui, n'en a jamais eu
    // besoin — il ne produit aucun run.
    expect(progressions).toEqual([true]);
  });
});
