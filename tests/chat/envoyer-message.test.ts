/**
 * RÉPONSE EN PLUSIEURS MESSAGES — outil `envoyer_message` (lot 27, 2026-11-04).
 *
 * ⚠️ DEMANDE UTILISATEUR : « est-ce que Yuki saura faire des réponses étalées sur
 * plusieurs messages ? (par exemple : donne-moi PI jusqu'à la 20ᵉ décimale, avec une
 * décimale par message) » — « l'idée n'est pas de timer chaque réponse, mais de les
 * enchaîner automatiquement » — « je préfère l'appel d'outil, même si c'est plus
 * coûteux ». Chaque appel publie donc UN message PENDANT le tour, dans la conversation
 * où Yuki répond.
 *
 * Ce que ce fichier verrouille (un piège, un test) :
 *  ① 20 appels ⇒ 20 messages publiés, DANS L'ORDRE (le cas PI) ;
 *  ② la réponse finale NE RÉPÈTE PAS ce qui est déjà parti (drapeau « j'ai déjà
 *    parlé » — le même piège que le double accusé, en plus grand) ;
 *  ③ aucun `send` SIMULTANÉ, même à 10 appels lancés en parallèle (file de
 *    `ReplyProgress` respectée) ;
 *  ④ le 21ᵉ appel est REFUSÉ explicitement (jamais une troncature muette) ;
 *  ⑤ un texte vide est REFUSÉ (aucune bulle vide) ;
 *  ⑥ au-delà de la borne de la plateforme, la troncature est DITE (au modèle ET dans
 *    le message publié) ;
 *  ⑦ le worker LOURD n'a pas `envoyer_message` (invariant « un seul rédacteur »).
 *
 * ⚠️ Le run est le VRAI (`createRemoteReplyGenerator` → `createRemoteRunTools` →
 * `ReplyProgress`) ; seul l'écrivain est simulé : il appelle réellement l'outil, comme
 * le ferait le modèle.
 */

import { describe, expect, it } from "vitest";

import { createRemoteReplyGenerator, createReplyMessagePort } from "../../src/chat/index.js";
import type { ProgressMessage } from "../../src/chat/index.js";
import type { RemoteMessage } from "../../src/chat/types.js";
import { REMOTE_ALWAYS_TOOLS, remoteToolGroup, toolAllowlist } from "../../src/llm/tool-policy.js";
import { createLogger } from "../../src/observability/logger.js";
import { createRemoteRunTools } from "../../src/pi/index.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

const MESSAGE: RemoteMessage = {
  remoteId: "post-1",
  conversationId: "mm-canal-1",
  author: { id: "humain-1", nom: "humain", estBot: false },
  role: "user",
  text: "donne-moi PI jusqu'à la 20ᵉ décimale, une décimale par message",
  sentAt: "2026-11-04 14:57",
};

type AnyTool = {
  name: string;
  execute: (...args: unknown[]) => Promise<{
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  }>;
};

/** Publication observée : le texte publié et la trace de concurrence. */
interface Observed {
  text: string;
  enVol: number;
}

/** Générateur RÉEL, écrivain SIMULÉ qui appelle `envoyer_message` comme le modèle. */
function makeGenerator(options: {
  publier: (message: ProgressMessage) => Promise<void>;
  /** Ce que fait le « modèle » : suite de textes envoyés + réponse finale. */
  scenario: (tool: AnyTool) => Promise<string>;
  plateforme?: "mattermost" | "discord";
}) {
  return createRemoteReplyGenerator({
    available: () => true,
    botName: () => "Yuki",
    runTools: (conversationId, onFileProduced, contexte) =>
      createRemoteRunTools({
        conversationId,
        chatMode: options.plateforme ?? "mattermost",
        remoteAgents: false,
        remoteTools: false,
        // ⚠️ L'outil est du groupe `toujours` : il ne dépend d'aucun réglage, mais la
        // politique du rôle doit l'activer (`messagesEnabled`).
        lightOptions: () => ({ messagesEnabled: true }),
        ...(contexte.publierMessage !== undefined
          ? {
              messages: createReplyMessagePort({
                plateforme: options.plateforme ?? "mattermost",
                publier: contexte.publierMessage,
              }),
            }
          : {}),
        onFileProduced,
        logger,
      }),
    createWriter: (run) => async () => {
      const tool = (run.customTools() as AnyTool[]).find(
        (candidate) => candidate.name === "envoyer_message",
      );
      if (!tool) throw new Error("le run n'a pas reçu `envoyer_message`");
      return options.scenario(tool);
    },
    logger,
  });
}

/** Publication instrumentée : ordre, concurrence, textes. */
function instrumentedPublisher(observes: Observed[]) {
  let enVol = 0;
  let maxEnVol = 0;
  const publier = async (message: ProgressMessage): Promise<void> => {
    enVol += 1;
    maxEnVol = Math.max(maxEnVol, enVol);
    observes.push({ text: message.text, enVol });
    // Petite attente : sans elle, deux `send` simultanés ne se verraient pas.
    await new Promise((resolve) => setTimeout(resolve, 1));
    enVol -= 1;
  };
  return { publier, maxEnVol: () => maxEnVol };
}

/** Texte du résultat d'un outil (jamais le texte publié, qui n'est pas recopié). */
function texteOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

describe("envoyer_message — 20 messages, dans l'ordre (le cas PI)", () => {
  it("20 appels ⇒ 20 publications ordonnées, et aucune réponse finale en double", async () => {
    const observes: Observed[] = [];
    const publisher = instrumentedPublisher(observes);
    const decimales = [
      "3",
      "1",
      "4",
      "1",
      "5",
      "9",
      "2",
      "6",
      "5",
      "3",
      "5",
      "8",
      "9",
      "7",
      "9",
      "3",
      "2",
      "3",
      "8",
      "4",
    ];
    const generate = makeGenerator({
      publier: publisher.publier,
      scenario: async (tool) => {
        for (const decimale of decimales) {
          await tool.execute("appel", { texte: decimale }, undefined, undefined, undefined);
        }
        // Tous les segments sont partis : le modèle n'a plus rien à ajouter.
        return "";
      },
    });

    const issue = await generate({
      channelTitle: "Canal",
      transcript: [],
      message: MESSAGE,
      publier: publisher.publier,
    });

    // ① VINGT messages, DANS L'ORDRE des appels.
    expect(observes.map((observation) => observation.text)).toEqual(decimales);
    // ② Rien de plus à la fin (aucune bulle vide, aucune redite) : le texte rendu est vide.
    expect(issue).toBe("");
  });
});

describe("envoyer_message — la réponse finale ne répète pas", () => {
  it("les lignes déjà envoyées sont retirées ; le reste part verbatim", async () => {
    const observes: Observed[] = [];
    const publisher = instrumentedPublisher(observes);
    const generate = makeGenerator({
      publier: publisher.publier,
      scenario: async (tool) => {
        await tool.execute("a1", { texte: "3" }, undefined, undefined, undefined);
        await tool.execute("a2", { texte: "1" }, undefined, undefined, undefined);
        // ⚠️ Le défaut visé : le modèle redonne tout dans sa réponse finale.
        return "3\n1\n\nVoilà les deux premières décimales.";
      },
    });

    const issue = await generate({
      channelTitle: "Canal",
      transcript: [],
      message: MESSAGE,
      publier: publisher.publier,
    });

    // ⚠️ `publier` ne reçoit QUE les messages du tour : la réponse finale est rendue
    // par le générateur, et c'est l'ADAPTATEUR qui la publie. On vérifie donc ici les
    // deux moitiés : ce qui est parti (les 2 segments) et ce qui RESTE à dire.
    expect(observes.map((observation) => observation.text)).toEqual(["3", "1"]);
    expect(issue).toBe("Voilà les deux premières décimales.");
  });

  it("tout a été dit par l'outil ⇒ aucun message final n'est publié", async () => {
    const observes: Observed[] = [];
    const publisher = instrumentedPublisher(observes);
    const generate = makeGenerator({
      publier: publisher.publier,
      scenario: async (tool) => {
        await tool.execute("a1", { texte: "3,14159" }, undefined, undefined, undefined);
        return "3,14159";
      },
    });

    const issue = await generate({
      channelTitle: "Canal",
      transcript: [],
      message: MESSAGE,
      publier: publisher.publier,
    });

    expect(observes).toHaveLength(1);
    expect(issue).toBe("");
  });
});

describe("envoyer_message — aucun send simultané", () => {
  it("10 appels lancés en parallèle restent sérialisés (file de ReplyProgress)", async () => {
    const observes: Observed[] = [];
    const publisher = instrumentedPublisher(observes);
    const generate = makeGenerator({
      publier: publisher.publier,
      scenario: async (tool) => {
        await Promise.all(
          Array.from({ length: 10 }, (_valeur, index) =>
            tool.execute("appel", { texte: `message ${index + 1}` }, undefined, undefined, undefined),
          ),
        );
        return "";
      },
    });

    await generate({
      channelTitle: "Canal",
      transcript: [],
      message: MESSAGE,
      publier: publisher.publier,
    });

    // ⚠️ UN SEUL envoi en vol à la fois, jamais deux.
    expect(publisher.maxEnVol()).toBe(1);
    // Et l'ordre des appels est conservé.
    expect(observes.map((observation) => observation.text)).toEqual(
      Array.from({ length: 10 }, (_valeur, index) => `message ${index + 1}`),
    );
  });
});

describe("envoyer_message — plafond du tour", () => {
  it("le 21ᵉ appel est refusé explicitement, et rien n'est publié", async () => {
    const observes: Observed[] = [];
    const publisher = instrumentedPublisher(observes);
    let dernier = "";
    const generate = makeGenerator({
      publier: publisher.publier,
      scenario: async (tool) => {
        for (let index = 1; index <= 21; index += 1) {
          const result = await tool.execute(
            `appel-${index}`,
            { texte: `segment ${index}` },
            undefined,
            undefined,
            undefined,
          );
          dernier = texteOf(result);
        }
        return "";
      },
    });

    await generate({
      channelTitle: "Canal",
      transcript: [],
      message: MESSAGE,
      publier: publisher.publier,
    });

    // Vingt messages, pas vingt et un.
    expect(observes).toHaveLength(20);
    expect(observes.at(-1)?.text).toBe("segment 20");
    // Le refus est EXPLICITE (il nomme le plafond), pas une troncature muette.
    expect(dernier).toContain("Rien n'a été envoyé");
    expect(dernier).toContain("maximum de 20 messages");
  });
});

describe("envoyer_message — refus et bornes", () => {
  it("un texte vide est refusé : aucune publication", async () => {
    const observes: Observed[] = [];
    const publisher = instrumentedPublisher(observes);
    let resultat = "";
    const generate = makeGenerator({
      publier: publisher.publier,
      scenario: async (tool) => {
        const result = await tool.execute(
          "a1",
          { texte: "   \n  " },
          undefined,
          undefined,
          undefined,
        );
        resultat = texteOf(result);
        return "";
      },
    });

    await generate({
      channelTitle: "Canal",
      transcript: [],
      message: MESSAGE,
      publier: publisher.publier,
    });

    expect(observes).toHaveLength(0);
    expect(resultat).toContain("Rien n'a été envoyé");
    expect(resultat).toContain("vide");
  });

  it("au-delà de la borne Mattermost, la troncature est DITE (message et résultat)", async () => {
    const observes: Observed[] = [];
    const publisher = instrumentedPublisher(observes);
    let resultat = "";
    const generate = makeGenerator({
      publier: publisher.publier,
      scenario: async (tool) => {
        const result = await tool.execute(
          "a1",
          { texte: "a".repeat(20_000) },
          undefined,
          undefined,
          undefined,
        );
        resultat = texteOf(result);
        return "";
      },
    });

    await generate({
      channelTitle: "Canal",
      transcript: [],
      message: MESSAGE,
      publier: publisher.publier,
    });

    expect(observes).toHaveLength(1);
    const publie = observes[0]!.text;
    // Le message publié PORTE la mention de troncature (jamais une coupe muette)…
    expect(publie).toContain("message tronqué : limite Mattermost");
    expect([...publie].length).toBeLessThanOrEqual(16_383);
    // …et le modèle l'apprend, pour ne pas croire avoir tout envoyé.
    expect(resultat).toContain("TRONQUÉ");
  });

  it("le résultat de l'outil ne recopie PAS le texte envoyé", async () => {
    const observes: Observed[] = [];
    const publisher = instrumentedPublisher(observes);
    let resultat = "";
    const generate = makeGenerator({
      publier: publisher.publier,
      scenario: async (tool) => {
        const result = await tool.execute(
          "a1",
          { texte: "une decimale tres reconnaissable" },
          undefined,
          undefined,
          undefined,
        );
        resultat = texteOf(result);
        return "";
      },
    });

    await generate({
      channelTitle: "Canal",
      transcript: [],
      message: MESSAGE,
      publier: publisher.publier,
    });

    // Court, sans le texte : sinon un tour de 20 messages doublerait son coût.
    expect(resultat).not.toContain("une decimale tres reconnaissable");
    expect(resultat).toContain("Message 1 envoyé");
  });
});

describe("envoyer_message — politique d'outils", () => {
  it("groupe `toujours` : présent quel que soit le réglage d'accès distant", () => {
    expect(remoteToolGroup("envoyer_message")).toBe("toujours");
    expect(REMOTE_ALWAYS_TOOLS).toContain("envoyer_message");
  });

  it("le worker LOURD n'a PAS `envoyer_message` (un seul rédacteur)", () => {
    // ⚠️ L'invariant n'est pas une consigne de prompt : le lourd ne peut pas l'appeler,
    // l'outil n'est ni dans sa politique ni dans les outils qu'il construit.
    expect(toolAllowlist("heavy", { messagesEnabled: true })).not.toContain("envoyer_message");
    expect(toolAllowlist("light", { messagesEnabled: true })).toContain("envoyer_message");
    // Et sans le câblage, il n'est pas proposé non plus (port absent ⇒ outil absent).
    expect(toolAllowlist("light", {})).not.toContain("envoyer_message");
  });
});
