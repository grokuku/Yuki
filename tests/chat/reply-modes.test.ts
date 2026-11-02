/**
 * LES TROIS MODES DE RÉPONSE et l'ANTI-BOUCLE (lot 18, lot 2).
 *
 * Ce que ce fichier verrouille :
 *  - `tout` : Yuki répond à CHAQUE message humain ;
 *  - `mention` : elle ne répond QUE si elle est CITÉE (`@yuki`, `@<pseudo>`, identifiant
 *    du bot) — détection EXPLICITE, testée sur des cas pièges (`@yukiko`, e-mail, pseudo
 *    au milieu d'une phrase) ;
 *  - `auto` : le juge est appelé, et **JAMAIS deux fois** pour le même message ;
 *  - ⚠️ ANTI-BOUCLE : un message dont l'auteur est `botUserId` ne déclenche AUCUNE
 *    réponse, dans les TROIS modes, et n'est JAMAIS soumis au juge.
 *
 * ⚠️ Échoue sur le code d'origine : `src/chat/reply/responder.ts` n'existe pas.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_REPLY_MODE,
  REPLY_MODE_LABELS,
  botAliases,
  decideReply,
  isBotMentioned,
} from "../../src/chat/reply/responder.js";
import { buildJudgePrompt, buildReplyPrompt, parseJudgeAnswer } from "../../src/chat/reply/prompt.js";
import type { RemoteMessage } from "../../src/chat/types.js";

const BOT_ID = "botidentifiant0123456789ab";

/** Message d'un humain (ou du bot, avec `estBot`). */
function message(text: string, options: { auteur?: string; estBot?: boolean; id?: string } = {}): RemoteMessage {
  const auteur = options.auteur ?? "humain-1";
  return {
    remoteId: options.id ?? `msg-${text.length}-${auteur}`,
    conversationId: "mm-canal-1",
    author: { id: auteur, nom: auteur === BOT_ID ? "yuki" : auteur, estBot: options.estBot === true },
    role: options.estBot === true || auteur === BOT_ID ? "assistant" : "user",
    text,
    sentAt: "2026-11-01T12:00:00.000Z",
  };
}

const ALIASES = botAliases({ botUserId: BOT_ID, botUsername: "yuki", displayName: "Yuki" });

describe("détection de CITATION — explicite, jamais une heuristique", () => {
  it("reconnaît `@yuki`, `@Yuki`, `@<pseudo>` et l'identifiant du bot", () => {
    expect(isBotMentioned("@yuki tu peux regarder ça ?", ALIASES)).toBe(true);
    expect(isBotMentioned("hé @Yuki, une idée ?", ALIASES)).toBe(true);
    expect(isBotMentioned(`<@${BOT_ID}> regarde`, ALIASES)).toBe(true);
    expect(isBotMentioned(BOT_ID, ALIASES)).toBe(true);
  });

  it("NE confond PAS un pseudo plus long, une adresse e-mail ou un simple mot", () => {
    // ⚠️ `@yukiko` n'est PAS Yuki.
    expect(isBotMentioned("@yukiko bonjour", ALIASES)).toBe(false);
    // ⚠️ Une adresse e-mail n'est pas une citation.
    expect(isBotMentioned("écris à contact@yuki.fr", ALIASES)).toBe(false);
    // ⚠️ Le pseudo NU (« yuki ») n'est PAS un alias : on ne devine pas.
    expect(isBotMentioned("yuki est un prénom japonais", ALIASES)).toBe(false);
    // Et une question qui ne cite personne ne déclenche rien en mode `mention`.
    expect(isBotMentioned("quelqu'un sait où est le rapport ?", ALIASES)).toBe(false);
  });

  it("les alias ne contiennent QUE des formes explicites", () => {
    expect(ALIASES).toContain("@yuki");
    expect(ALIASES).toContain("@Yuki");
    expect(ALIASES).toContain(BOT_ID);
    expect(ALIASES).not.toContain("yuki");
  });
});

describe("anti-boucle — la règle qui prime sur les trois modes", () => {
  for (const mode of ["tout", "auto", "mention"] as const) {
    it(`mode « ${mode} » : un message du BOT ne déclenche AUCUNE réponse`, async () => {
      let juge = 0;
      const decision = await decideReply({
        message: message("@yuki je te réponds à moi-même", { auteur: BOT_ID, estBot: true }),
        replyMode: mode,
        botUserId: BOT_ID,
        aliases: ALIASES,
        judge: async () => {
          juge += 1;
          return true;
        },
      });
      expect(decision.repondre).toBe(false);
      expect(decision.raison).toBe("auteur_bot");
      // ⚠️ Le juge n'est MÊME PAS appelé sur un message du bot.
      expect(juge).toBe(0);
    });
  }

  it("un AUTRE robot ne reçoit AUCUNE réponse, même en mode `tout` (anti-boucle bot↔bot)", async () => {
    // ⚠️ D2 : `decideReply` ne lisait jamais `message.author.estBot`. Un second bot dans
    // le salon, en mode « répondre à tous », obtenait donc une réponse — et deux robots
    // pouvaient se répondre indéfiniment.
    for (const mode of ["tout", "mention", "auto"] as const) {
      let juge = 0;
      const decision = await decideReply({
        message: message("@yuki regarde mon rapport", { auteur: "autre-bot", estBot: true }),
        replyMode: mode,
        // ⚠️ L'identifiant du bot de Yuki est CONNU : ce n'est donc PAS elle.
        botUserId: BOT_ID,
        aliases: ALIASES,
        judge: async () => {
          juge += 1;
          return true;
        },
      });
      expect(decision).toMatchObject({ repondre: false, raison: "auteur_bot" });
      expect(decision.detail).toContain("robot");
      // ⚠️ Le juge n'est même pas appelé : la décision est prise AVANT le mode.
      expect(juge).toBe(0);
    }
  });

  it("un message SUPPRIMÉ ne déclenche rien (même en mode `tout`)", async () => {
    const supprime = { ...message("bonjour"), deleted: true as const };
    const decision = await decideReply({
      message: supprime,
      replyMode: "tout",
      botUserId: BOT_ID,
      aliases: ALIASES,
    });
    expect(decision).toMatchObject({ repondre: false, raison: "message_supprime" });
  });
});

describe("mode `tout` — répondre à chaque message humain", () => {
  it("répond à un message qui ne cite personne", async () => {
    const decision = await decideReply({
      message: message("il fait beau"),
      replyMode: "tout",
      botUserId: BOT_ID,
      aliases: ALIASES,
    });
    expect(decision).toMatchObject({ repondre: true, raison: "mode_tout" });
  });
});

describe("mode `mention` — répondre seulement si Yuki est citée", () => {
  it("répond sur citation, se taît sinon", async () => {
    const cite = await decideReply({
      message: message("@yuki tu viens ?"),
      replyMode: "mention",
      botUserId: BOT_ID,
      aliases: ALIASES,
    });
    expect(cite).toMatchObject({ repondre: true, raison: "mention" });

    const muet = await decideReply({
      message: message("on se voit à 14 h ?"),
      replyMode: "mention",
      botUserId: BOT_ID,
      aliases: ALIASES,
    });
    expect(muet).toMatchObject({ repondre: false, raison: "pas_de_mention" });
  });

  it("le mode par DÉFAUT est `mention` (le plus prudent qui laisse le canal utilisable)", () => {
    expect(DEFAULT_REPLY_MODE).toBe("mention");
    expect(Object.keys(REPLY_MODE_LABELS).sort()).toEqual(["auto", "mention", "tout"]);
  });
});

describe("mode `auto` — le juge tranche, UNE seule fois", () => {
  it("appelle le juge et suit sa réponse", async () => {
    const vus: string[] = [];
    const decision = await decideReply({
      message: message("Yuki, tu peux relire ce document ?", { id: "m-42" }),
      replyMode: "auto",
      botUserId: BOT_ID,
      aliases: ALIASES,
      judge: async ({ message: jugee }) => {
        vus.push(jugee.remoteId);
        return true;
      },
    });
    expect(decision).toMatchObject({ repondre: true, raison: "juge_oui" });
    expect(vus).toEqual(["m-42"]);
  });

  it("ne juge JAMAIS deux fois le même identifiant de message", async () => {
    let appels = 0;
    const jugees = new Set<string>();
    const juge = async () => {
      appels += 1;
      return true;
    };
    const input = {
      message: message("bonjour", { id: "m-7" }),
      replyMode: "auto" as const,
      botUserId: BOT_ID,
      aliases: ALIASES,
      judge: juge,
      dejaJuge: (remoteId: string) => jugees.has(remoteId),
    };
    const premier = await decideReply(input);
    expect(premier.repondre).toBe(true);
    jugees.add("m-7");
    const second = await decideReply(input);
    expect(second).toMatchObject({ repondre: false, raison: "deja_juge" });
    // ⚠️ Le SECOND appel ne sollicite pas le modèle : un seul jugement par message.
    expect(appels).toBe(1);
  });

  it("un juge indisponible NE répond PAS (jamais au hasard)", async () => {
    const decision = await decideReply({
      message: message("bonjour"),
      replyMode: "auto",
      botUserId: BOT_ID,
      aliases: ALIASES,
    });
    expect(decision).toMatchObject({ repondre: false, raison: "juge_indisponible" });
  });
});

describe("prompts — bornés et sans fuite", () => {
  it("le juge est CONSERVATEUR : seul un « oui » explicite vaut acceptation", () => {
    expect(parseJudgeAnswer("oui")).toBe(true);
    expect(parseJudgeAnswer("  Oui. ")).toBe(true);
    expect(parseJudgeAnswer("yes")).toBe(true);
    expect(parseJudgeAnswer("non")).toBe(false);
    expect(parseJudgeAnswer("non, ce n'est pas pour elle")).toBe(false);
    // ⚠️ Un modèle bavard qui commence par autre chose ne vaut PAS acceptation.
    expect(parseJudgeAnswer("Bien sûr ! Voici…")).toBe(false);
    expect(parseJudgeAnswer("")).toBe(false);
  });

  it("le prompt du juge ne contient pas de consigne de rédaction", () => {
    const prompt = buildJudgePrompt({
      channelTitle: "Général",
      message: message("@yuki tu viens ?"),
    });
    expect(prompt).toContain("Général");
    expect(prompt).toContain("« oui » ou « non »");
  });

  it("le prompt du rédacteur BORNE le fil et garde les messages les PLUS RÉCENTS", () => {
    const transcript: RemoteMessage[] = Array.from({ length: 40 }, (_, index) => ({
      ...message(`message numéro ${index} avec un peu de texte pour peser`, { id: `t${index}` }),
      sentAt: new Date(1_700_000_000_000 + index * 1_000).toISOString(),
    }));
    const prompt = buildReplyPrompt({
      channelTitle: "Général",
      transcript,
      message: transcript[39]!,
      maxChars: 300,
    });
    // Les DERNIERS messages sont conservés (le contexte du message à traiter).
    expect(prompt).toContain("message numéro 38");
    expect(prompt).not.toContain("message numéro 0 ");
    // Le message déclencheur n'est pas recopié dans le corps du fil (il est à part).
    const corps = prompt.slice(0, prompt.indexOf("Message auquel tu dois répondre"));
    expect(corps).not.toContain("message numéro 39");
    expect(prompt).toContain("Message auquel tu dois répondre");
  });
});
