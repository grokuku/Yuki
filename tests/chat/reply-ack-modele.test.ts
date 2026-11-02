/**
 * ACCUSÉ D'UN RUN DE CANAL — **ÉCRIT PAR LE MODÈLE**, la table en REPLI.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE (décision utilisateur 2026-11-02, verbatim :
 * « je veux pas que le ack soit une table fixe. c'est totalement inhumain comme
 * comportement. ») : l'accusé d'un run distant était TOUJOURS une phrase de
 * `ACK_FALLBACK_TEXTS` (`src/pi/ack.ts`), donc la même mécanique à chaque message.
 *
 * Ce que ce fichier prouve, de bout en bout (`createRemoteReplyGenerator`) et sans
 * réseau ni modèle — l'écrivain est SIMULÉ mais émet EXACTEMENT les événements du vrai
 * (`SdkToolEvent`, `src/pi/sdk/prompt-writer.ts`) :
 *  1. le texte d'accusé écrit par le modèle part TEL QUEL (pas celui de la table) ;
 *  2. modèle MUET ⇒ repli de la table, en ROTATION : deux runs, deux phrases ;
 *  3. un texte trop long (> `ACK_MAX_CHARS`) est du CONTENU : aucun accusé publié ;
 *  4. AUCUN outil après l'accusé ⇒ ce texte est LA RÉPONSE : une seule publication
 *     (aucune), donc jamais deux fois le même texte ;
 *  5. UN SEUL accusé par run, même avec trois outils ;
 *  6. la SOURCE (`modele`/`repli`) est journalisée, JAMAIS le texte ;
 *  7. ZÉRO appel modèle supplémentaire : la consigne vit dans le prompt du tour.
 *
 * ⚠️ Échoue sur le code d'origine : l'écrivain distant ne remontait aucun candidat, le
 * run de canal ne recevait pas de consigne d'accusé (`src/pi/chat-run.ts`) et la
 * progression publiait la table (`src/chat/reply/progress.ts` n'existait pas).
 */

import { describe, expect, it } from "vitest";

import { createRemoteReplyGenerator, type ProgressMessage } from "../../src/chat/index.js";
import { ACK_FALLBACK_TEXTS, ACK_MAX_CHARS } from "../../src/pi/ack.js";
import type { SdkPromptWriter, SdkToolEvent } from "../../src/pi/index.js";

/** Message déclencheur (forme du contrat d'adaptateur). */
function message(conversationId = "mm-canal-1") {
  return {
    remoteId: `m-${conversationId}`,
    conversationId,
    author: { id: "humain-1", nom: "Camille", estBot: false },
    role: "user" as const,
    text: "génère une image de chat",
    sentAt: "2026-11-02T10:00:00.000Z",
  };
}

/** Événements d'outil rejoués par l'écrivain simulé (mêmes formes que le vrai). */
type EvenementOutil = SdkToolEvent;

interface Journal {
  message: string;
  champs?: Record<string, unknown>;
}

/**
 * Génération d'UNE réponse avec un écrivain qui rejoue `evenements`.
 *
 * ⚠️ L'écrivain est CRÉÉ À CHAQUE run par le générateur (`createWriter`), donc les
 * publications s'accumulent dans `publications` et la rotation du repli reste portée par
 * le générateur (elle est PAR CONVERSATION, `src/chat/reply/generate.ts`).
 */
function monter(options: { conversationId?: string } = {}) {
  const publications: ProgressMessage[] = [];
  const journal: Journal[] = [];
  let appels = 0;
  let evenements: readonly EvenementOutil[] = [];
  let texteFinal = "";

  const generate = createRemoteReplyGenerator({
    available: () => true,
    botName: () => "Yuki",
    runTools: () => ({ tools: ["generer_image", "lire_fichier"], customTools: [] }),
    createWriter: (run) => {
      const writer = async (): Promise<string> => {
        appels += 1;
        for (const evenement of evenements) run.onTool?.(evenement);
        return texteFinal;
      };
      return writer as unknown as SdkPromptWriter;
    },
    logger: {
      info: (message: string, champs?: Record<string, unknown>): void => {
        journal.push({ message, ...(champs !== undefined ? { champs } : {}) });
      },
    },
  });

  const jouer = async (script: {
    evenements?: readonly EvenementOutil[];
    texteFinal: string;
  }): Promise<string> => {
    evenements = script.evenements ?? [];
    texteFinal = script.texteFinal;
    const brut = await generate({
      channelTitle: "Général",
      transcript: [message(options.conversationId)],
      message: message(options.conversationId),
      publier: async (intermediaire) => {
        publications.push(intermediaire);
      },
    });
    return typeof brut === "string" ? brut : brut.text;
  };

  return {
    jouer,
    publications,
    journal,
    appels: () => appels,
    /** Publications du DERNIER run (les précédentes sont oubliées). */
    vider: (): void => {
      publications.length = 0;
    },
  };
}

/** Un appel d'action longue, avec le texte que le modèle a écrit AVANT. */
function appel(tool: string, ackCandidat?: string): EvenementOutil {
  return {
    phase: "start",
    tool,
    ...(ackCandidat !== undefined ? { ackCandidat } : {}),
  };
}

describe("l'accusé de canal vient du MODÈLE", () => {
  it("publie le texte d'accusé du modèle TEL QUEL, et pas une phrase de la table", async () => {
    const run = monter();
    const phrase = "J'arrive, je lance la machine à images.";
    const texte = await run.jouer({
      evenements: [appel("generer_image", phrase), { phase: "end", tool: "generer_image" }],
      texteFinal: `${phrase}\n\nVoilà le chat demandé.`,
    });

    // ① C'est SON texte, mot pour mot.
    expect(run.publications).toEqual([{ text: phrase }]);
    // ⚠️ Et ce n'est PAS une phrase de la table (le défaut reproché).
    expect(ACK_FALLBACK_TEXTS.generer_image).not.toContain(phrase);
    // Le texte final ne le répète pas : il est retiré de la réponse (égalité STRICTE).
    expect(texte).toBe("Voilà le chat demandé.");
    // ⑤ La source est journalisée… sans le texte.
    expect(run.journal).toEqual([
      { message: "chat.progress.ack", champs: { tool: "generer_image", source: "modele" } },
    ]);
  });

  it("modèle MUET : repli de la table, en ROTATION (deux runs, deux phrases différentes)", async () => {
    const run = monter();
    await run.jouer({
      evenements: [appel("generer_image")],
      texteFinal: "Voilà l'image demandée.",
    });
    const premiere = run.publications[0]?.text;
    run.vider();

    await run.jouer({
      evenements: [appel("generer_image")],
      texteFinal: "Voilà l'image demandée.",
    });
    const seconde = run.publications[0]?.text;

    expect(ACK_FALLBACK_TEXTS.generer_image).toContain(premiere ?? "");
    expect(ACK_FALLBACK_TEXTS.generer_image).toContain(seconde ?? "");
    // ⚠️ LE REPROCHE ÉTAIT LÀ : toujours la même phrase. La rotation l'interdit.
    expect(seconde).not.toBe(premiere);
    expect(run.journal.map((ligne) => ligne.champs?.["source"])).toEqual(["repli", "repli"]);
  });

  it("un texte plus LONG que la borne reste du CONTENU : aucun accusé publié", async () => {
    const run = monter();
    const long = `Je m'en occupe, voilà le détail : ${"a".repeat(ACK_MAX_CHARS)}`;
    const texte = await run.jouer({
      evenements: [appel("generer_image", long)],
      texteFinal: long,
    });

    // ③ Ni modèle, ni repli : ce texte est déjà la réponse.
    expect(run.publications).toEqual([]);
    expect(texte).toBe(long);
    expect(run.journal).toEqual([]);
  });

  it("AUCUN outil après l'accusé : le texte est la RÉPONSE, jamais publié deux fois", async () => {
    const run = monter();
    const texte = await run.jouer({
      evenements: [],
      texteFinal: "Je m'en occupe.",
    });

    // ④ Zéro publication : le texte part une seule fois, comme réponse finale.
    expect(run.publications).toEqual([]);
    expect(texte).toBe("Je m'en occupe.");
    expect(run.journal).toEqual([]);
  });

  it("UN SEUL accusé par run, même avec trois outils d'action longue", async () => {
    const run = monter();
    await run.jouer({
      evenements: [
        appel("generer_image", "Je m'en occupe."),
        { phase: "end", tool: "generer_image" },
        appel("generer_image", "Je relance."),
        { phase: "end", tool: "generer_image" },
        appel("generer_image", "Encore une."),
        { phase: "end", tool: "generer_image" },
      ],
      texteFinal: "Voilà.",
    });

    expect(run.publications).toEqual([{ text: "Je m'en occupe." }]);
    expect(run.journal).toHaveLength(1);
  });

  it("un outil de LECTURE ne prend jamais d'accusé", async () => {
    const run = monter();
    await run.jouer({
      evenements: [appel("lire_fichier", "Je vérifie."), { phase: "end", tool: "lire_fichier" }],
      texteFinal: "Voilà le fichier.",
    });

    expect(run.publications).toEqual([]);
    expect(run.journal).toEqual([]);
  });

  it("ZÉRO appel modèle supplémentaire : une seule rédaction, quel que soit l'accusé", async () => {
    const run = monter();
    await run.jouer({
      evenements: [appel("generer_image", "Deux secondes."), { phase: "end", tool: "generer_image" }],
      texteFinal: "Voilà.",
    });

    // ⚠️ La consigne d'accusé vit dans le prompt du tour (`extensionFactories`) : elle
    // n'ajoute AUCUNE requête. Un second appel ici serait un coût par message de canal.
    expect(run.appels()).toBe(1);
    expect(run.publications).toHaveLength(1);
  });
});

describe("transport de la consigne — les extensions du run arrivent à l'écrivain", () => {
  it("`extensionFactories` du run (consigne d'accusé) est transmise à l'écrivain du CANAL", async () => {
    // ⚠️ `ReplyRun` porte la LISTE (ce que produit `createRemoteRunTools`) ; c'est
    // `createRemoteReplyGenerator` qui la remet sous forme de FABRIQUE relue à chaque tour.
    let recues: readonly unknown[] | undefined;
    const generate = createRemoteReplyGenerator({
      available: () => true,
      botName: () => "Yuki",
      runTools: () => ({
        tools: ["generer_image"],
        customTools: [],
        extensionFactories: ["consigne-accuse"],
      }),
      createWriter: (run) => {
        recues = run.extensionFactories?.();
        return (async () => "Voilà.") as unknown as SdkPromptWriter;
      },
    });

    await generate({ channelTitle: "Général", transcript: [message()], message: message() });
    expect(recues).toEqual(["consigne-accuse"]);
  });
});
