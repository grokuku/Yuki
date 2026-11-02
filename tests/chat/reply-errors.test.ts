/**
 * CAS DURS d'un run distant — échec d'outil, action longue, plafond, troncature.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE : un échec d'outil, une génération de trois
 * minutes ou une rafale d'appels ne produisaient AUCUN signal dans le canal. La
 * personne qui avait posé la question attendait un résultat qui n'arriverait jamais,
 * sans savoir pourquoi.
 *
 * Ce que ce fichier prouve :
 *  1. un ÉCHEC d'outil donne UNE ligne déterministe, jamais deux pour le même outil ;
 *  2. un outil de plus de 90 s donne UN rappel, jamais un par outil ;
 *  3. au-delà de TROIS résultats, les lignes sont omises et la RÉPONSE FINALE le dit ;
 *  4. une ligne trop longue est TRONQUÉE en le disant (borne partagée du canal).
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/reply/progress.ts` n'existe pas et la
 * réponse finale ignorait toute notion de résultat intermédiaire.
 */

import { describe, expect, it } from "vitest";

import {
  createRemoteReplyGenerator,
  PROGRESS_LONG_TOOL_TEXT,
  PROGRESS_MAX_RESULTS,
  PROGRESS_SUPPRESSED_TEXT,
  ReplyProgress,
  progressErrorText,
  type ProgressMessage,
} from "../../src/chat/index.js";
import { fitMattermostContent, MM_DEFAULT_MAX_POST_CHARS } from "../../src/chat/mattermost/adapter.js";
import type { SdkPromptWriter, SdkToolEvent } from "../../src/pi/index.js";

const MESSAGE = {
  remoteId: "m-1",
  conversationId: "mm-canal-1",
  author: { id: "humain-1", nom: "Camille", estBot: false },
  role: "user" as const,
  text: "génère trois images",
  sentAt: "2026-11-02T10:00:00.000Z",
};

function collecteur() {
  const messages: ProgressMessage[] = [];
  return {
    messages,
    publier: async (message: ProgressMessage): Promise<void> => {
      messages.push(message);
    },
  };
}

describe("échec d'outil — une ligne, déterministe", () => {
  it("la même panne produit la MÊME phrase (aucune improvisation)", () => {
    expect(progressErrorText("generer_image")).toBe(progressErrorText("generer_image"));
    expect(progressErrorText("generer_image")).toContain("generer_image");
    expect(progressErrorText("generer_image")).toContain("échoué");
  });

  it("deux signalements du même échec ⇒ UNE seule ligne publiée", async () => {
    const trace = collecteur();
    const p = new ReplyProgress({ publier: trace.publier, outils: ["generer_image"] });
    p.terminerOutil({ tool: "generer_image", isError: true });
    p.terminerOutil({ tool: "generer_image", isError: true });
    await p.attendre();

    expect(trace.messages).toEqual([{ text: progressErrorText("generer_image") }]);
  });
});

describe("outil long — rappel UNIQUE", () => {
  it("un outil long rappelle UNE fois, pas une fois par outil", async () => {
    // ⚠️ Le rappel est ARMÉ au démarrage de l'outil (délai RÉEL) : le seuil est donc
    // abaissé ici, la règle testée restant celle du run de canal (90 s).
    const trace = collecteur();
    const p = new ReplyProgress({
      publier: trace.publier,
      outils: ["generer_image", "lire_fichier"],
      seuilRappelMs: 20,
    });
    for (const outil of ["generer_image", "lire_fichier", "generer_image"]) {
      p.demarrerOutil({ tool: outil });
      await new Promise((resolve) => setTimeout(resolve, 40));
      p.terminerOutil({ tool: outil });
    }
    await p.attendre();

    const rappels = trace.messages.filter((m) => m.text === PROGRESS_LONG_TOOL_TEXT);
    expect(rappels).toHaveLength(1);
    // ⚠️ Le rappel est un FAIT (« ça prend quelques minutes »), jamais une estimation
    // de temps restant : aucune promesse trompeuse.
    expect(PROGRESS_LONG_TOOL_TEXT).not.toMatch(/secondes|minutes restantes|bientôt/i);
  });
});

describe("plafond de résultats et réponse finale", () => {
  it("le générateur ANNEXE à la réponse la mention des résultats omis", async () => {
    const trace = collecteur();
    const generate = createRemoteReplyGenerator({
      available: () => true,
      botName: () => "Yuki",
      runTools: () => ({ tools: ["generer_image", "lire_fichier"], customTools: [] }),
      createWriter: (run) => {
        const writer = async (): Promise<string> => {
          const signaler = (event: SdkToolEvent): void => run.onTool?.(event);
          for (const outil of ["a", "b", "c", "d", "e"]) {
            signaler({ phase: "start", tool: outil });
            signaler({ phase: "end", tool: outil, isError: true });
          }
          return "Je n'ai pas pu faire les cinq essais.";
        };
        return writer as unknown as SdkPromptWriter;
      },
    });

    const resultat = await generate({
      channelTitle: "Général",
      transcript: [MESSAGE],
      message: MESSAGE,
      publier: trace.publier,
    });

    // Trois lignes d'échec au plus…
    expect(trace.messages).toHaveLength(PROGRESS_MAX_RESULTS);
    // …et le reste est DIT dans la réponse finale, jamais passé sous silence.
    expect(String(resultat)).toContain("Je n'ai pas pu faire les cinq essais.");
    expect(String(resultat)).toContain(PROGRESS_SUPPRESSED_TEXT);
  });

  it("sous le plafond, la réponse finale ne rajoute RIEN", async () => {
    const trace = collecteur();
    const generate = createRemoteReplyGenerator({
      available: () => true,
      botName: () => "Yuki",
      runTools: () => ({ tools: ["generer_image"], customTools: [] }),
      createWriter: (run) => {
        const writer = async (): Promise<string> => {
          run.onTool?.({ phase: "end", tool: "generer_image", isError: true });
          return "Voilà.";
        };
        return writer as unknown as SdkPromptWriter;
      },
    });

    const resultat = await generate({
      channelTitle: "Général",
      transcript: [MESSAGE],
      message: MESSAGE,
      publier: trace.publier,
    });

    expect(resultat).toBe("Voilà.");
  });
});

describe("troncature — toujours dite", () => {
  it("une ligne plus longue que la limite du canal est coupée EN LE DISANT", () => {
    // ⚠️ Borne PARTAGÉE avec `send` (`MM_DEFAULT_MAX_POST_CHARS`) : la progression ne
    // réécrit pas de borne à elle, elle réutilise celle du canal.
    const long = "a".repeat(MM_DEFAULT_MAX_POST_CHARS + 50);
    const { texte, tronque } = fitMattermostContent(long);
    expect(tronque).toBe(true);
    expect(texte.length).toBeLessThanOrEqual(MM_DEFAULT_MAX_POST_CHARS);
    expect(texte).toMatch(/tronqu/i);
  });

  it("les libellés de progression tiennent dans la borne d'un accusé", () => {
    // ⚠️ Aucune ligne de statut ne doit devenir un paragraphe : c'est la même règle
    // que `ACK_MAX_CHARS` pour le canal.
    for (const texte of [PROGRESS_LONG_TOOL_TEXT, PROGRESS_SUPPRESSED_TEXT, progressErrorText("generer_image")]) {
      expect(texte).not.toContain("\n");
      expect([...texte].length).toBeLessThan(200);
    }
  });
});
