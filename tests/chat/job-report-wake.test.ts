/**
 * RAPPORT DE JOB INJECTÉ — message système, prompt et tour de Yuki.
 *
 * ⚠️ INVARIANT (`docs/lot18-chat.md`) : **dans un canal, un seul rédacteur — le tour
 * de Yuki**. Le rapport d'une tâche terminée n'est donc PLUS publié par le serveur :
 * il entre dans la conversation comme un message SYSTÈME, Yuki le lit, et sa réponse
 * est publiée.
 *
 * Ce que ce fichier prouve :
 *  1. le message injecté est RECONNAISSABLE (auteur « Rapport de tâche », jamais un
 *     humain), encadré et borné, et il nomme les fichiers produits ;
 *  2. il dit que son contenu est une DONNÉE (un résultat), pas une consigne ;
 *  3. le prompt du tour porte la consigne « rapport de tâche » et les identifiants
 *     des fichiers — donc Yuki peut les publier ;
 *  4. un tour né d'un rapport ne DÉLÈGUE pas (aucune boucle de rédélégation) ;
 *  5. les fichiers du job sont joints à SA réponse, sauf ceux qu'elle a publiés
 *     ailleurs dans le tour (aucun fichier envoyé deux fois).
 *
 * ⚠️ Échoue sur le code d'origine : le rapport était résumé puis publié par le
 * serveur, `buildReplyPrompt` n'avait ni origine ni fichiers, et le tour de canal
 * n'avait aucune notion de « tour né d'un rapport ».
 */

import { describe, expect, it } from "vitest";

import { createRemoteReplyGenerator } from "../../src/chat/reply/generate.js";
import {
  RAPPORT_SYSTEME_AUTHOR_ID,
  RAPPORT_SYSTEME_AUTHOR_NAME,
  RAPPORT_SYSTEME_ENTETE,
  RAPPORT_SYSTEME_FICHIERS_ENTETE,
  RAPPORT_SYSTEME_RAPPEL,
  estRapportSysteme,
  frameRapportSysteme,
  messageRapportSysteme,
} from "../../src/chat/reply/job-report.js";
import { CHAT_JOB_REPORT_INSTRUCTION, buildReplyPrompt } from "../../src/chat/reply/prompt.js";
import type { ReplyRunContext } from "../../src/chat/reply/generate.js";
import { createChannelPostPort } from "../../src/chat/reply/channel-post.js";
import type { RemoteMessage } from "../../src/chat/types.js";
import { toolAllowlistForChat } from "../../src/llm/tool-policy.js";
import type { SdkPromptWriter } from "../../src/pi/index.js";

const CONVERSATION = "mm-canal-general";
const IMAGERIE = "mm-canal-imagerie";

const RAPPORT = [
  "[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]",
  "job_id: job-42",
  "statut: completed",
  "tâche: générer une figurine",
  "",
  "--- résultat brut ---",
  "J'ai généré l'image demandée.",
  "--- fin du résultat ---",
].join("\n");

describe("① message injecté — un RAPPORT SYSTÈME, jamais un humain", () => {
  it("commence par l'en-tête, rappelle que c'est une donnée, nomme le job et les fichiers", () => {
    const texte = frameRapportSysteme({
      rapport: RAPPORT,
      fichiers: ["f-1", "f-2"],
      jobId: "job-42",
    });
    expect(texte.startsWith(RAPPORT_SYSTEME_ENTETE)).toBe(true);
    expect(texte).toContain(RAPPORT_SYSTEME_RAPPEL);
    expect(texte).toContain("Tâche : job-42");
    expect(texte).toContain("J'ai généré l'image demandée.");
    expect(texte).toContain(RAPPORT_SYSTEME_FICHIERS_ENTETE);
    expect(texte).toContain("- f-1");
    expect(texte).toContain("- f-2");
    // ⚠️ La DONNÉE n'est pas échappée : un rapport contient légitimement des blocs
    // `<sortie>` (sortie de commande) et les abîmer rendrait le rapport illisible.
    expect(texte).toContain("[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]");
  });

  it("ajoute la phrase de REPLI telle quelle quand le serveur en a écrit une", () => {
    const repli = "⚠️ La publication dans « L'Imagerie » n'a pas abouti : jeton expiré.";
    const texte = frameRapportSysteme({ rapport: RAPPORT, repli });
    expect(texte).toContain(repli);
  });

  it("un rapport vide ne produit jamais un bloc muet", () => {
    expect(frameRapportSysteme({ rapport: "   " })).toContain("(aucun résultat textuel)");
  });

  it("le message synthétique porte une identité dédiée, reconnaissable", () => {
    const message = messageRapportSysteme({
      conversationId: CONVERSATION,
      texte: "peu importe",
      jobId: "job-42",
      sentAt: "2026-11-02T10:00:00.000Z",
    });
    expect(message.author.id).toBe(RAPPORT_SYSTEME_AUTHOR_ID);
    expect(message.author.nom).toBe(RAPPORT_SYSTEME_AUTHOR_NAME);
    expect(message.author.estBot).toBe(true);
    expect(estRapportSysteme(message)).toBe(true);
    // Un message d'humain n'est jamais pris pour un rapport système.
    expect(
      estRapportSysteme({ author: { id: "u-1", nom: "Camille", estBot: false } }),
    ).toBe(false);
  });
});

describe("② prompt du tour — consigne et fichiers du job", () => {
  const message: RemoteMessage = messageRapportSysteme({
    conversationId: CONVERSATION,
    texte: "rapport",
    jobId: "job-42",
    sentAt: "2026-11-02T10:00:00.000Z",
  });

  it("origine `job` ⇒ consigne dédiée, jamais un remerciement ni une relance", () => {
    const prompt = buildReplyPrompt({
      channelTitle: "Général",
      transcript: [],
      message,
      origine: "job",
      fichiersDuJob: ["f-1"],
    });
    expect(prompt).toContain(CHAT_JOB_REPORT_INSTRUCTION);
    expect(prompt).toContain(RAPPORT_SYSTEME_AUTHOR_NAME);
    expect(prompt).toContain("Fichiers produits par la tâche");
    expect(prompt).toContain("- f-1");
    expect(prompt).toContain("publier_dans_canal");
  });

  it("origine `message` ⇒ aucune consigne de rapport (comportement inchangé)", () => {
    const prompt = buildReplyPrompt({
      channelTitle: "Général",
      transcript: [],
      message: { ...message, author: { id: "u-1", nom: "Camille", estBot: false } },
    });
    expect(prompt).not.toContain(CHAT_JOB_REPORT_INSTRUCTION);
    expect(prompt).not.toContain("Fichiers produits par la tâche");
  });
});

// ─── ④⑤ Le tour : aucun outil de délégation, fichiers joints UNE fois ──────

const MESSAGE: RemoteMessage = messageRapportSysteme({
  conversationId: CONVERSATION,
  texte: frameRapportSysteme({ rapport: RAPPORT, fichiers: ["f-1", "f-2"], jobId: "job-42" }),
  jobId: "job-42",
  sentAt: "2026-11-02T10:00:00.000Z",
});

/**
 * Générateur RÉEL, écrivain SIMULÉ. `publierAilleurs` reproduit ce que ferait l'outil
 * `publier_dans_canal` pendant le tour (il passe par le PORT, donc par le suivi).
 */
function generer(options: {
  capture?: { contexte?: ReplyRunContext };
  publierAilleurs?: readonly string[];
}) {
  const port = createChannelPostPort({
    plateforme: "mattermost",
    conversationSource: CONVERSATION,
    canaux: () => [
      { conversationId: IMAGERIE, titre: "L'Imagerie", plateforme: "mattermost" },
    ],
    envoyer: async () => undefined,
    fichier: (id) => ({ sessionId: CONVERSATION, name: `${id}.png`, bytes: 10 }),
    maxFichierBytes: () => 1_000_000,
  });
  const envois: Array<{ conversationId: string; fichierIds?: readonly string[] }> = [];
  const espion = {
    canaux: port.canaux,
    publier: async (request: Parameters<typeof port.publier>[0]) => {
      const outcome = await port.publier(request);
      if (outcome.ok) {
        envois.push({
          conversationId: request.canal,
          ...(request.fichierIds !== undefined ? { fichierIds: request.fichierIds } : {}),
        });
      }
      return outcome;
    },
  };

  /** Contexte du tour, retenu pour que l'écrivain simulé puisse publier « ailleurs ». */
  let contexte: ReplyRunContext | undefined;
  const generate = createRemoteReplyGenerator({
    available: () => true,
    botName: () => "Yuki",
    runTools: (_conversationId, _onFileProduced, recu) => {
      contexte = recu;
      if (options.capture !== undefined) options.capture.contexte = recu;
      return {
        // ⚠️ MÊME calcul qu'en production (`src/index.ts`) : un tour né d'un rapport
        // n'a pas la délégation, donc il ne peut pas relancer un travail.
        tools: toolAllowlistForChat(
          "light",
          {},
          { chatMode: "mattermost", remoteAgents: contexte.origine !== "job" },
        ),
        customTools: [],
      };
    },
    createWriter: () =>
      (async () => {
        // Le tour « publie » les fichiers demandés dans « L'Imagerie ».
        for (const id of options.publierAilleurs ?? []) {
          await contexte?.channelPosts
            .wrap(espion)
            .publier({ canal: "L'Imagerie", texte: "figurine", fichierIds: [id] });
        }
        return "La figurine est prête.";
      }) as unknown as SdkPromptWriter,
  });
  return { generate, envois };
}

describe("④ un tour né d'un rapport ne redélègue pas", () => {
  it("l'allowlist du tour ne contient PAS `delegate`", async () => {
    const capture: { contexte?: ReplyRunContext } = {};
    const { generate } = generer({ capture });
    await generate({
      channelTitle: "Général",
      transcript: [],
      message: MESSAGE,
      origine: "job",
      fichiersDuJob: ["f-1"],
    });

    // ⚠️ La preuve est dans la POLITIQUE du tour, pas dans le prompt : le câblage
    // (`src/index.ts`) passe `remoteAgents: false` quand l'origine est `job`.
    expect(capture.contexte?.origine).toBe("job");
    const allowlist = toolAllowlistForChat(
      "light",
      {},
      { chatMode: "mattermost", remoteAgents: capture.contexte?.origine !== "job" },
    );
    expect(allowlist).not.toContain("delegate");
    // Et le même câblage, pour un message d'HUMAIN, garde la délégation : ce n'est
    // donc pas la politique distante qui a changé, seulement ce tour-là.
    expect(
      toolAllowlistForChat("light", {}, { chatMode: "mattermost", remoteAgents: true }),
    ).toContain("delegate");
  });
});

describe("⑤ fichiers du job — joints une seule fois", () => {
  it("le contexte du tour porte l'origine et le suivi des publications", async () => {
    const capture: { contexte?: ReplyRunContext } = {};
    const { generate } = generer({ capture });
    await generate({
      channelTitle: "Général",
      transcript: [],
      message: MESSAGE,
      origine: "job",
      fichiersDuJob: ["f-1", "f-2"],
    });
    expect(capture.contexte?.origine).toBe("job");
    expect(capture.contexte?.channelPosts).toBeDefined();
  });

  it("sans publication ailleurs : les fichiers du job sont joints à la réponse", async () => {
    const { generate } = generer({});
    const resultat = await generate({
      channelTitle: "Général",
      transcript: [],
      message: MESSAGE,
      origine: "job",
      fichiersDuJob: ["f-1", "f-2"],
    });
    expect(resultat).toEqual({ text: "La figurine est prête.", fichiers: ["f-1", "f-2"] });
  });

  it("publié dans « L'Imagerie » ⇒ le fichier n'est PAS re-joint ici", async () => {
    const { generate, envois } = generer({ publierAilleurs: ["f-1"] });
    const resultat = await generate({
      channelTitle: "Général",
      transcript: [],
      message: MESSAGE,
      origine: "job",
      fichiersDuJob: ["f-1", "f-2"],
    });
    // La publication a bien eu lieu (une fois)…
    expect(envois).toHaveLength(1);
    // Le port résout le NOM demandé (« L'Imagerie ») vers l'identifiant du canal.
    expect(envois[0]?.conversationId).toBe("L'Imagerie");
    // …et l'image n'apparaît pas deux fois : seul `f-2` reste joint.
    expect(resultat).toEqual({ text: "La figurine est prête.", fichiers: ["f-2"] });
  });
});
