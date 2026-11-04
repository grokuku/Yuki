/**
 * D3 — PLATEFORME D'UN RUN DISTANT : celle de la CONVERSATION, pas le mode d'affichage.
 *
 * Ce que ce fichier verrouille :
 *  - `runPlatformOf` lit le préfixe de l'identifiant miroir (`dc-…` ⇒ `discord`) et ne
 *    consulte le mode global QUE pour un identifiant qui n'est pas un miroir ;
 *  - `createRemoteReplyGenerator` transmet l'identifiant de la conversation à `botName`,
 *    donc le prompt nomme le bot de la BONNE plateforme ;
 *  - la politique d'outils reçoit la plateforme du run (et non `chat.mode`).
 *
 * ⚠️ Avant ce correctif, `botName: () => …` lisait `chat.mode` GLOBAL : un run né dans un
 * salon Discord alors que l'interface affichait Mattermost recevait « Tu es <pseudo
 * Mattermost>. » (`src/chat/reply/prompt.ts`), et la politique d'outils était celle de
 * Mattermost.
 */

import { describe, expect, it } from "vitest";

import { createRemoteReplyGenerator, runPlatformOf } from "../../src/chat/index.js";
import { toolAllowlistForChat } from "../../src/llm/tool-policy.js";
import type { RemoteMessage } from "../../src/chat/types.js";

const MESSAGE: RemoteMessage = {
  remoteId: "m-1",
  conversationId: "dc-999888777",
  author: { id: "humain-1", nom: "Camille", estBot: false },
  role: "user",
  text: "bonjour",
  sentAt: "2026-11-01T12:00:00.000Z",
};

describe("runPlatformOf — la conversation décide", () => {
  it("un identifiant Discord désigne un run Discord, quel que soit `chat.mode`", () => {
    expect(runPlatformOf("dc-123", "mattermost")).toBe("discord");
    expect(runPlatformOf("dc-123", "local")).toBe("discord");
  });

  it("un identifiant Mattermost désigne un run Mattermost, quel que soit `chat.mode`", () => {
    expect(runPlatformOf("mm-canal-1", "discord")).toBe("mattermost");
  });

  it("un identifiant qui n'est PAS un miroir retombe sur le mode (jamais une plateforme inventée)", () => {
    expect(runPlatformOf("session-locale-42", "local")).toBe("local");
    expect(runPlatformOf("session-locale-42", "discord")).toBe("discord");
  });
});

describe("createRemoteReplyGenerator — le prompt nomme le bot de SA plateforme", () => {
  it("un canal Discord nomme le bot Discord même si `chat.mode` vaut `mattermost`", async () => {
    const prompts: string[] = [];
    const plateformes: string[] = [];
    // Fabrique de nom IDENTIQUE à celle du câblage (`src/index.ts`) : c'est le lien entre
    // `runPlatformOf` et le prompt qui est vérifié ici.
    const nomsDeBot: Record<string, string> = {
      discord: "Yuki-Discord",
      mattermost: "Yuki-Mattermost",
    };
    const generate = createRemoteReplyGenerator({
      available: () => true,
      botName: (conversationId) => nomsDeBot[runPlatformOf(conversationId, "mattermost")] ?? "Yuki",
      runTools: (conversationId) => {
        plateformes.push(runPlatformOf(conversationId, "mattermost"));
        return { tools: [], customTools: [] };
      },
      createWriter: () => async (prompt: string) => {
        prompts.push(prompt);
        return "réponse";
      },
    });

    await generate({ channelTitle: "général", transcript: [MESSAGE], message: MESSAGE });

    expect(plateformes).toEqual(["discord"]);
    expect(prompts).toHaveLength(1);
    // ⚠️ Le nom réellement injecté dans le prompt est celui de la plateforme du run.
    expect(prompts[0]).toContain("Yuki-Discord");
    expect(prompts[0]).not.toContain("Mattermost");
  });

  it("la politique d'outils suit la plateforme du run, pas le mode d'affichage", () => {
    // Run né dans un canal Discord alors que l'interface affiche Mattermost.
    const plateforme = runPlatformOf(MESSAGE.conversationId, "mattermost");
    const outils = toolAllowlistForChat(
      "light",
      { imagesEnabled: true, filesEnabled: true },
      // ⚠️ DEUX réglages : les outils distants sont ouverts, les agents non.
      { chatMode: plateforme, remoteAgents: false, remoteTools: true },
    );
    // ⚠️ Un run distant ne reçoit JAMAIS la politique LOCALE complète (lecture du disque,
    // exécution) : la liste reste celle des outils de canal (`REMOTE_SAFE_TOOLS`).
    expect([...outils].sort()).toEqual([
      "consulter_workflow",
      "envoyer_fichier",
      // ⚠️ Réponse en plusieurs messages (`envoyer_message`, 2026-11-04) : groupe
      // `toujours` — la publication dans la conversation courante ne dépend d'aucun
      // réglage d'accès distant.
      "envoyer_message",
      "generer_image",
      "lire_fichier",
      "lister_fichiers",
      // ⚠️ Envoi PROGRAMMÉ (`programmer_envoi`, lot 28) : même groupe `toujours` —
      // programmer une publication ne touche à aucune machine et n'appelle aucun
      // modèle à l'heure dite.
      "programmer_envoi",
      // ⚠️ Publication inter-canal : un MESSAGE, pas une action sur une machine ⇒
      // aucune approbation, donc présent quel que soit le réglage (décision A).
      "publier_dans_canal",
    ]);
    // Et le mode global, lui, aurait donné exactement la même liste : la différence n'est
    // donc visible que par la plateforme transmise, que ce test verrouille ci-dessus.
    expect(plateforme).toBe("discord");
  });
});
