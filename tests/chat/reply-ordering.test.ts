/**
 * ORDRE de publication d'un run distant : `[accusé, image, réponse]`.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE : un run distant ne publiait qu'UN texte, à la
 * fin (`src/chat/reply/generate.ts`), image et accusé compris. La personne qui avait
 * demandé une image voyait donc le silence, puis un message unique — et l'image ne
 * pouvait PAS être datée au moment où elle a été produite.
 *
 * Ce que ce fichier prouve, sans réseau et sans modèle :
 *  1. l'ACCUSÉ part AVANT l'action (le tour de l'outil n'a pas encore commencé) ;
 *  2. l'IMAGE part À L'ARRIVÉE (`onFileProduced`), pas à la fin du tour ;
 *  3. la RÉPONSE part en dernier, et ne contient PAS l'accusé déjà publié ;
 *  4. l'image n'est PAS réattachée à la réponse finale (`fichiers` absent) ;
 *  5. les publications ont des horodatages CROISSANTS.
 *
 * ⚠️ Échoue sur le code d'origine : `publier` n'existe pas dans l'entrée du générateur,
 * `onTool` n'existe pas sur le run, et le générateur rendait l'image dans la réponse.
 */

import { describe, expect, it } from "vitest";

import {
  createRemoteReplyGenerator,
  ReplyProgress,
  type ProgressMessage,
} from "../../src/chat/index.js";
import type { SdkPromptWriter, SdkToolEvent } from "../../src/pi/index.js";

interface Publication {
  text: string;
  fichiers?: readonly string[];
  ordre: number;
  a: number;
}

/** Message déclencheur (forme du contrat d'adaptateur). */
const MESSAGE = {
  remoteId: "m-1",
  conversationId: "mm-canal-1",
  author: { id: "humain-1", nom: "Camille", estBot: false },
  role: "user" as const,
  text: "génère une image de chat",
  sentAt: "2026-11-02T10:00:00.000Z",
};

/**
 * Générateur réel, avec un écrivain SIMULÉ qui joue la suite d'événements d'un run qui
 * appelle `generer_image` : accusé → outil → image produite → réponse.
 */
function genererAvecScript(script: {
  ackCandidat?: string;
  texteFinal: string;
  produire?: boolean;
}) {
  const publications: Publication[] = [];
  let ordre = 0;
  let produire: (() => void) | undefined;

  const publier = async (message: ProgressMessage): Promise<void> => {
    ordre += 1;
    publications.push({
      text: message.text,
      ...(message.fichiers !== undefined ? { fichiers: message.fichiers } : {}),
      ordre,
      a: Date.now(),
    });
  };

  const generate = createRemoteReplyGenerator({
    available: () => true,
    botName: () => "Yuki",
    runTools: (_conversationId, onFileProduced) => {
      produire = () => onFileProduced("fichier-image-1");
      return { tools: ["generer_image"], customTools: [] };
    },
    createWriter: (run) => {
      const writer = async (): Promise<string> => {
        const signaler = (event: SdkToolEvent): void => run.onTool?.(event);
        signaler({
          phase: "start",
          tool: "generer_image",
          ...(script.ackCandidat !== undefined ? { ackCandidat: script.ackCandidat } : {}),
        });
        // L'image est produite PENDANT l'outil, donc avant la fin du tour.
        if (script.produire !== false) produire?.();
        signaler({ phase: "end", tool: "generer_image" });
        return script.texteFinal;
      };
      return writer as unknown as SdkPromptWriter;
    },
  });

  return { generate, publications, publier };
}

describe("ordre de publication d'un run distant", () => {
  it("publie `[accusé, image]` avant la réponse, dans cet ordre et à des instants croissants", async () => {
    const { generate, publications, publier } = genererAvecScript({
      ackCandidat: "Deux secondes.",
      texteFinal: "Deux secondes.\n\nVoilà le chat demandé.",
    });

    const resultat = await generate({
      channelTitle: "Général",
      transcript: [MESSAGE],
      message: MESSAGE,
      publier,
    });

    // ① L'accusé est le PREMIER message : il part avant que l'outil ne travaille.
    expect(publications[0]?.text).toBe("Deux secondes.");
    // ② L'image part à l'ARRIVÉE, seule, et une seule fois.
    expect(publications[1]?.fichiers).toEqual(["fichier-image-1"]);
    expect(publications).toHaveLength(2);
    // ⑤ Horodatages croissants (ordre d'arrivée sur la plateforme).
    for (let i = 1; i < publications.length; i += 1) {
      expect(publications[i]!.a).toBeGreaterThanOrEqual(publications[i - 1]!.a);
      expect(publications[i]!.ordre).toBeGreaterThan(publications[i - 1]!.ordre);
    }

    // ③ La réponse finale ne contient PLUS la ligne d'accusé (elle est déjà partie).
    expect(resultat).toBe("Voilà le chat demandé.");
    // ④ L'image déjà postée n'est PAS réattachée (elle apparaîtrait deux fois).
    expect(typeof resultat).toBe("string");
  });

  it("un tour qui ne dit QUE l'accusé rend un texte vide (rien de plus à publier)", async () => {
    const { generate, publier } = genererAvecScript({
      ackCandidat: "Je m'en occupe.",
      texteFinal: "Je m'en occupe.",
    });
    const resultat = await generate({
      channelTitle: "Général",
      transcript: [MESSAGE],
      message: MESSAGE,
      publier,
    });

    expect(resultat).toBe("");
  });

  it("sans `publier`, le comportement est INCHANGÉ : un seul texte, image rendue", async () => {
    const { generate } = genererAvecScript({ texteFinal: "Voilà le chat." });
    const resultat = await generate({
      channelTitle: "Général",
      transcript: [MESSAGE],
      message: MESSAGE,
    });

    expect(resultat).toEqual({ text: "Voilà le chat.", fichiers: ["fichier-image-1"] });
  });
});

describe("progression — deux images, deux posts, aucune réattachée", () => {
  it("publie chaque fichier une fois et ne réattache rien", async () => {
    const publications: ProgressMessage[] = [];
    const p = new ReplyProgress({
      publier: async (message) => {
        publications.push(message);
      },
      outils: ["generer_image"],
    });
    p.demarrerOutil({ tool: "generer_image", ackCandidat: "C'est parti." });
    p.publierFichier("f-1");
    p.publierFichier("f-2");
    await p.attendre();

    expect(publications[0]?.text).toBe("C'est parti.");
    expect(publications.slice(1).map((m) => m.fichiers)).toEqual([["f-1"], ["f-2"]]);
    expect(p.fichiersRestants(["f-1", "f-2"])).toEqual([]);
  });
});
