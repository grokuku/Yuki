/**
 * ACCUSÉ D'UN CANAL : **jamais deux fois**, et **à l'heure**.
 *
 * ⚠️ DEUX DÉFAUTS DE PRODUCTION (capture Mattermost, 2026-11-02 15:38-15:44), verbatim :
 *  - « il y a écrit 2x "c'est parti". » — l'accusé `C'est parti.` a été publié, puis le
 *    texte final `C'est parti, avec ta fiche sous les yeux…` est parti à son tour : le
 *    retrait de l'accusé ne connaissait que l'ÉGALITÉ STRICTE
 *    (`ReplyProgress.retirerAck`), donc un texte final qui *commence* par l'accusé
 *    n'était pas retiré ⇒ deux posts qui disent la même chose ;
 *  - « le premier n'a pas été reçu de suite […] genre 1/4 de seconde avant le second » —
 *    l'accusé était retenu par la file de publication sérialisée : derrière une
 *    publication en vol (téléversement d'image), il arrivait AVEC la réponse finale,
 *    donc après l'action qu'il devait annoncer.
 *
 * Ce que ce fichier prouve, contre un SERVEUR FIXTURE RÉEL (HTTP + WS), donc en
 * mesurant des **requêtes** et non des appels de fonction :
 *  1. accusé + réponse qui commence par le même texte ⇒ DEUX posts, et le second ne
 *     répète pas l'accusé ;
 *  2. accusé identique au texte final ENTIER ⇒ un SEUL post (pas de bulle vide) ;
 *  3. outil de 3 s, téléversement lent déjà en vol ⇒ la requête `POST /posts` de
 *     l'accusé part AVANT la fin de l'outil (horodatage du serveur).
 *
 * ⚠️ Échoue sur le code d'origine : `retirerAck` exigeait l'égalité stricte de la
 * première ligne (test ①), et l'accusé passait par la chaîne sérialisée `enfiler`
 * (test ③).
 */

import { afterEach, describe, expect, it } from "vitest";

import { createRemoteReplyGenerator } from "../../src/chat/index.js";
import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { conversationIdOfChannel } from "../../src/chat/mirror/ingest.js";
import type { StoredFileRecord } from "../../src/files/index.js";
import type { SdkPromptWriter, SdkToolEvent } from "../../src/pi/index.js";
import { createLogger } from "../../src/observability/logger.js";
import {
  MM_BOT_ID,
  MM_CHANNEL,
  MM_TOKEN,
  openMmMirror,
  startMmFixture,
  waitFor,
  type MmFixture,
} from "./mm-reply-fixture.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const CONVERSATION = conversationIdOfChannel(MM_CHANNEL);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Message déclencheur (forme du contrat d'adaptateur). */
const MESSAGE = {
  remoteId: "humain-1",
  conversationId: CONVERSATION,
  author: { id: "humain-1", nom: "Camille", estBot: false },
  role: "user" as const,
  text: "génère une image de chat",
  sentAt: "2026-11-02T10:00:00.000Z",
};

/** Le déroulé d'un outil tel que l'écrivain le rejoue (mêmes formes que le vrai). */
interface Scenario {
  /** Texte écrit par le modèle AVANT l'appel (candidat à l'accusé). */
  ackCandidat?: string;
  /** Texte final rendu par l'écrivain. */
  texteFinal: string;
  /** Durée simulée de l'outil (ms) : c'est la fenêtre où l'accusé doit arriver. */
  dureeOutilMs?: number;
  /** Un fichier est-il produit AVANT le démarrage de l'outil (téléversement lent) ? */
  fichierAvant?: boolean;
}

/**
 * Monte l'adaptateur RÉEL sur la fixture, avec un écrivain SIMULÉ qui rejoue le
 * scénario. Aucun modèle, aucun réseau : seules les requêtes HTTP sont réelles.
 */
async function monter(scenario: Scenario, fixtureOptions: { delaiFichierMs?: number } = {}) {
  const fixture: MmFixture = await startMmFixture(
    cleanups,
    fixtureOptions.delaiFichierMs !== undefined
      ? { delaiFichierMs: fixtureOptions.delaiFichierMs }
      : {},
  );
  const store = openMmMirror(cleanups);
  /** Fenêtre de l'outil, en horloge LOCALE (les requêtes sont horodatées pareil). */
  const bornes: { debut?: number; fin?: number } = {};
  let produireFichier: (() => void) | undefined;
  let requetesAvant: number = 0;

  const generate = createRemoteReplyGenerator({
    available: () => true,
    botName: () => "Yuki",
    runTools: (_conversationId, onFileProduced) => {
      produireFichier = () => onFileProduced("fichier-image-1");
      return { tools: ["generer_image", "delegate"], customTools: [] };
    },
    createWriter: (run) => {
      const writer = async (): Promise<string> => {
        const signaler = (event: SdkToolEvent): void => run.onTool?.(event);
        if (scenario.fichierAvant === true) {
          produireFichier?.();
          // ⚠️ Le téléversement doit être RÉELLEMENT en vol quand l'outil démarre
          // (sinon il serait encore dans la file et l'accusé passerait devant lui).
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        bornes.debut = Date.now();
        signaler({
          phase: "start",
          tool: "delegate",
          ...(scenario.ackCandidat !== undefined ? { ackCandidat: scenario.ackCandidat } : {}),
        });
        // L'outil TRAVAILLE : l'accusé doit partir PENDANT ce délai, pas après.
        if ((scenario.dureeOutilMs ?? 0) > 0) {
          await new Promise((resolve) => setTimeout(resolve, scenario.dureeOutilMs));
        }
        bornes.fin = Date.now();
        signaler({ phase: "end", tool: "delegate" });
        return scenario.texteFinal;
      };
      return writer as unknown as SdkPromptWriter;
    },
  });

  const adapter = new MattermostChatAdapter({
    baseUrl: () => fixture.baseUrl,
    token: () => MM_TOKEN,
    store,
    pollIntervalMs: 0,
    generateReply: generate,
    // ⚠️ Port de fichiers MINIMAL mais RÉEL : sans lui, la publication de l'image
    // échouerait AVANT tout appel réseau, et le « téléversement lent » du test ne
    // mesurerait rien.
    files: {
      get: (id: string) =>
        id === "fichier-image-1"
          ? ({ id, name: "image.png", mimeType: "image/png" } as unknown as StoredFileRecord)
          : null,
      readBytes: (id: string) => (id === "fichier-image-1" ? Buffer.from([1, 2, 3]) : null),
    },
    logger,
  });
  cleanups.push(() => adapter.disconnect());
  await adapter.connect();
  await waitFor(() => fixture.open > 0, "la connexion temps réel");
  store.setReplyMode(CONVERSATION, "tout");
  // Les requêtes de la CONNEXION (users/me, équipes, canaux, miroir) ne comptent pas.
  requetesAvant = fixture.requetes.length;

  fixture.broadcast("posted", {
    id: MESSAGE.remoteId,
    channel_id: MM_CHANNEL,
    user_id: "humain-1",
    message: MESSAGE.text,
    create_at: Date.now(),
  });

  return {
    fixture,
    bornes,
    /** Posts RÉELLEMENT créés (messages publiés), dans l'ordre d'arrivée. */
    posts: (): string[] => fixture.created.map((post) => String(post.message ?? "")),
    /** TOUTES les requêtes de CE run (connexion exclue), avec leur fin. */
    requetes: () => fixture.requetes.slice(requetesAvant),
    /** Requêtes `POST /posts` de CE run, horodatées par le serveur. */
    envois: () =>
      fixture.requetes
        .slice(requetesAvant)
        .filter((requete) => requete.method === "POST" && requete.chemin === "/api/v4/posts"),
    botId: MM_BOT_ID,
  };
}

describe("accusé d'un canal — un seul post par texte", () => {
  it("accusé + réponse qui COMMENCE par le même texte ⇒ deux posts, et le second ne le répète pas", async () => {
    const run = await monter({
      ackCandidat: "C'est parti.",
      texteFinal: "C'est parti, avec ta fiche sous les yeux cette fois : nain chauve.",
    });
    await waitFor(() => run.posts().length >= 2, "les deux posts", 8_000);

    const posts = run.posts();
    expect(posts).toHaveLength(2);
    // ① L'accusé est parti, une fois.
    expect(posts[0]).toContain("C'est parti.");
    // ② La réponse ne le RÉPÈTE pas : le préfixe a été retiré avant publication.
    expect(posts[1]).toContain("avec ta fiche sous les yeux cette fois : nain chauve.");
    expect(posts[1]).not.toContain("C'est parti");
  });

  it("DEUX lignes d'accusé de tête ⇒ une seule publiée, l'autre retirée de la réponse", async () => {
    // ⚠️ Production, 2026-11-02 15:50 : la bulle portait « Je prends ça en charge. »
    // PUIS « Je lance la mise à jour. », donc l'accusé semblait écrit deux fois.
    const run = await monter({
      ackCandidat: "Je prends ça en charge.",
      texteFinal: [
        "Je prends ça en charge.",
        "Je lance la mise à jour.",
        "C'est en route sur la PI5, par délégation : apt update puis montée de version.",
      ].join("\n"),
    });
    await waitFor(() => run.posts().length >= 2, "les deux posts", 8_000);

    const posts = run.posts();
    // ④ Deux posts : l'accusé (le PREMIER, verrou 1/run) et le corps de la réponse.
    expect(posts).toHaveLength(2);
    expect(posts[0]).toContain("Je prends ça en charge.");
    expect(posts[0]).not.toContain("Je lance la mise à jour.");
    // La réponse ne contient plus AUCUNE des deux attentes.
    expect(posts[1]).toContain("C'est en route sur la PI5, par délégation : apt update");
    expect(posts[1]).not.toContain("Je prends ça en charge");
    expect(posts[1]).not.toContain("Je lance la mise à jour");
  });

  it("accusé identique au texte final ENTIER ⇒ un seul post (aucune bulle vide)", async () => {
    const run = await monter({ ackCandidat: "Deux secondes.", texteFinal: "Deux secondes." });
    await waitFor(() => run.posts().length >= 1, "l'accusé", 8_000);
    // Laisse le temps à une éventuelle seconde publication d'arriver (défaut d'origine).
    await new Promise((resolve) => setTimeout(resolve, 200));

    // ③ C'est un choix (déjà codé dans l'adaptateur) : un tour qui n'a QUE accusé n'a
    //    rien de plus à dire. Un second post vide serait un doublon.
    expect(run.posts()).toHaveLength(1);
    expect(run.posts()[0]).toContain("Deux secondes.");
  });

  it("accusé et réponse qui ne diffèrent que par la casse et la ponctuation ⇒ un seul post", async () => {
    const run = await monter({
      ackCandidat: "C'est parti !",
      texteFinal: "c'est parti. Voilà le chat roux.",
    });
    await waitFor(() => run.posts().length >= 2, "les deux posts", 8_000);

    const posts = run.posts();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain("Voilà le chat roux.");
    expect(posts[1]?.toLowerCase()).not.toContain("c'est parti");
  });
});

describe("accusé d'un canal — publié PENDANT l'action, jamais en même temps", () => {
  it("outil de 3 s sans autre envoi : la requête de l'accusé part AVANT la fin de l'outil", async () => {
    const run = await monter({
      ackCandidat: "C'est parti.",
      texteFinal: "Voilà le chat demandé.",
      dureeOutilMs: 3_000,
    });
    await waitFor(() => run.posts().length >= 2, "accusé puis réponse", 15_000);

    const { debut, fin } = run.bornes;
    const accuse = run.envois()[0];
    expect(accuse).toBeDefined();
    // ④ Mesure à la REQUÊTE HTTP (pas à l'appel de fonction) : l'accusé est arrivé
    //    PENDANT l'outil, donc il annonce bien l'action.
    expect(accuse?.at).toBeGreaterThanOrEqual(debut as number);
    expect(accuse?.at).toBeLessThan(fin as number);
    // La réponse finale part APRÈS la fin de l'outil (ordre normal).
    expect((run.envois().at(-1)?.at as number) ?? 0).toBeGreaterThan(fin as number);
  });

  it("téléversement déjà en vol : l'accusé attend la FIN de cet envoi — jamais deux `send` simultanés", async () => {
    // ⚠️ Défaut de production (2026-11-02) : « toujours deux messages qui arrivent en
    // même temps ». L'accusé double la FILE, jamais l'envoi EN COURS : sur la
    // plateforme, les deux posts ne se recouvrent jamais.
    const run = await monter(
      {
        ackCandidat: "C'est parti.",
        texteFinal: "Voilà le chat demandé.",
        fichierAvant: true,
      },
      { delaiFichierMs: 1_000 },
    );
    await waitFor(() => run.posts().length >= 3, "accusé, image et réponse", 15_000);

    const requetes = run.requetes();
    // ⑤ Aucun recouvrement : chaque requête d'envoi démarre après la fin de la précédente.
    expect(requetes.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < requetes.length; index += 1) {
      expect(requetes[index]!.at).toBeGreaterThanOrEqual(requetes[index - 1]!.fin as number);
    }
    // Et l'ordre des textes est celui des événements.
    expect(run.posts()[0]).toContain("Voici l'image.");
    expect(run.posts()[1]).toContain("C'est parti.");
    expect(run.posts()[2]).toContain("Voilà le chat demandé.");
  });
});
