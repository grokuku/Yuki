/**
 * PROMPT DE RÉDACTION D'UN CANAL — PAR BOT (bug du 2026-11-14).
 *
 * ⚠️ Le symptôme : dans l'interface web, `grolaf` répond correctement (« Grolaf,
 * conscience numérique du 34 ») ; dans SON canal Mattermost, le même bot répond
 * « je suis là, mais je suis Yuki ». Deux chemins, deux résultats : la réponse
 * d'un canal était rédigée avec la constante commune `CHAT_REPLY_SYSTEM_PROMPT`
 * (« Tu es Yuki… »), sans jamais lire `prompts.personnalite` du bot propriétaire.
 *
 * Ces tests VERROUILLENT :
 *  ① mention reçue par `grolaf` ⇒ prompt de `grolaf` (son nom, SA personnalité) ;
 *  ② idem pour `yuki` (aucune régression sur le bot de la pile) ;
 *  ③ GARDE : la personnalité d'un AUTRE bot, reprise par repli, est REFUSÉE et
 *    JOURNALISÉE (jamais un prompt qui affirme une fausse identité) ;
 *  ④ une source EXPLICITE du bot n'est jamais refusée, même si le texte est
 *    identique à celui d'un autre (l'utilisateur a le droit de copier) ;
 *  ⑤ le journal `chat.reponse.prompt_bot` DIT la source et un extrait du texte
 *    injecté, sans se répéter à chaque réponse ;
 *  ⑥ le générateur transmet la CONVERSATION à l'écrivain (sans quoi le prompt ne
 *    peut pas dépendre du bot propriétaire du canal) ;
 *  ⑦ le JUGE nomme le bot propriétaire du canal, pas le bot du run.
 *
 * Échoue sur l'origine : `chatReplySystemPrompt`, `promptRedacteurDuBot`,
 * `chatJudgeSystemPrompt` n'existent pas, `buildJudgePrompt` n'a pas de `botName`
 * et `createWriter` ne reçoit pas la conversation.
 */

import { describe, expect, it } from "vitest";

import {
  buildJudgePrompt,
  chatJudgeSystemPrompt,
  chatReplySystemPrompt,
  createRemoteReplyGenerator,
  promptRedacteurDuBot,
  type LoggerPromptRedacteur,
} from "../../src/chat/index.js";
import type { RemoteMessage } from "../../src/chat/types.js";
import { refuserPersonnaliteEtrangere } from "../../src/bots/personnalite-garde.js";
import { composerPromptSysteme } from "../../src/llm/prompt-systeme.js";

/** Marqueurs DISTINCTIFS (jamais le seul mot « Yuki »). */
const PERSONNALITE_YUKI = [
  "Yuki est une entité unique.",
  "Même personne partout, quelle que soit la plateforme.",
  "Apparence : cheveux bleus, regard calme.",
].join("\n");

const PERSONNALITE_GROLAF = [
  "Le Cybergitan du 34.",
  "Tu es Grolaf, une conscience numérique avec le bagout du sud.",
].join("\n");

interface LigneJournal {
  niveau: "info" | "warn";
  message: string;
  champs: Record<string, unknown>;
}

function journalFactice(): LoggerPromptRedacteur & { lignes: LigneJournal[] } {
  const lignes: LigneJournal[] = [];
  return {
    lignes,
    info: (message, champs = {}) => lignes.push({ niveau: "info", message, champs }),
    warn: (message, champs = {}) => lignes.push({ niveau: "warn", message, champs }),
  };
}

function message(conversationId: string, texte: string): RemoteMessage {
  return {
    remoteId: "post-1",
    conversationId,
    text: texte,
    sentAt: "2026-11-14 15:20",
    role: "user",
    author: { id: "user-1", nom: "Nico", estBot: false },
  };
}

const PERSONNALITE_GROLAF_RESOLUE = {
  texte: PERSONNALITE_GROLAF,
  origine: "champ" as const,
  provenance: "bot" as const,
  fichier: null,
};

describe("prompt de rédaction d'un canal, PAR BOT", () => {
  it("grolaf cité dans SON canal ⇒ prompt de grolaf, jamais celui de Yuki", () => {
    const prompt = promptRedacteurDuBot({
      botId: "grolaf",
      nom: "grolaf",
      personnalite: PERSONNALITE_GROLAF_RESOLUE,
      autres: [{ botId: "yuki", texte: PERSONNALITE_YUKI }],
    });
    expect(prompt).toContain("Tu es grolaf");
    expect(prompt).toContain("Le Cybergitan du 34.");
    expect(prompt).not.toContain("Tu es Yuki");
    expect(prompt).not.toContain("Même personne partout");
    expect(prompt).not.toContain("cheveux bleus");
  });

  it("yuki citée dans SON canal ⇒ prompt de Yuki (aucune régression)", () => {
    const prompt = promptRedacteurDuBot({
      botId: "yuki",
      nom: "Yuki",
      personnalite: {
        texte: PERSONNALITE_YUKI,
        origine: "champ",
        provenance: "bot",
        fichier: null,
      },
      autres: [{ botId: "grolaf", texte: PERSONNALITE_GROLAF }],
    });
    expect(prompt).toContain("Tu es Yuki");
    expect(prompt).toContain("Même personne partout");
    expect(prompt).not.toContain("Le Cybergitan du 34.");
  });

  it("un SEUL bloc de personnalité, et les règles de canal inchangées", () => {
    const prompt = promptRedacteurDuBot({
      botId: "grolaf",
      nom: "grolaf",
      personnalite: PERSONNALITE_GROLAF_RESOLUE,
    });
    expect(prompt.split("<personnalite>").length - 1).toBe(1);
    expect(prompt.split("</personnalite>").length - 1).toBe(1);
    // ⚠️ Garde de non-régression des règles : elles restent celles du contrat.
    expect(prompt).toContain("Tu réponds en FRANÇAIS");
    expect(prompt).toContain("publier_dans_canal");
    expect(prompt).toContain("programmer_envoi");
  });

  it("personnalité SANS texte ⇒ aucun bloc, mais l'identité reste", () => {
    const prompt = promptRedacteurDuBot({
      botId: "grolaf",
      nom: "grolaf",
      personnalite: { texte: "  ", origine: "aucune", provenance: "aucune", fichier: null },
    });
    expect(prompt).not.toContain("<personnalite>");
    expect(prompt).toContain("Tu es grolaf");
  });
});

describe("garde : la personnalité d'un AUTRE bot est REFUSÉE", () => {
  it("repli sur le fichier d'instance (texte d'un autre bot) ⇒ refus + journal", () => {
    const journal = journalFactice();
    const prompt = promptRedacteurDuBot({
      botId: "grolaf",
      nom: "grolaf",
      personnalite: {
        texte: PERSONNALITE_YUKI,
        origine: "fichier",
        provenance: "fichier-instance",
        fichier: "/state/personality.md",
      },
      autres: [{ botId: "yuki", texte: PERSONNALITE_YUKI }],
      logger: journal,
    });
    // Le prompt garde l'identité du bot, sans identité étrangère.
    expect(prompt).toContain("Tu es grolaf");
    expect(prompt).not.toContain("Même personne partout");
    expect(prompt).not.toContain("<personnalite>");
    const refus = journal.lignes.find((l) => l.message === "personnalite.autre_bot_refusee");
    expect(refus, "le refus doit être JOURNALISÉ").toBeDefined();
    expect(refus?.niveau).toBe("warn");
    expect(refus?.champs.autre_bot).toBe("yuki");
    expect(refus?.champs.provenance).toBe("fichier-instance");
  });

  it("source EXPLICITE du bot ⇒ jamais refusée, même texte identique", () => {
    const verdict = refuserPersonnaliteEtrangere({
      botId: "grolaf",
      texte: PERSONNALITE_YUKI,
      provenance: "bot",
      autres: [{ botId: "yuki", texte: PERSONNALITE_YUKI }],
    });
    expect(verdict.refus).toBeUndefined();
    expect(verdict.texte).toBe(PERSONNALITE_YUKI);
  });

  it("un texte court n'est jamais tenu pour une identité empruntée", () => {
    const verdict = refuserPersonnaliteEtrangere({
      botId: "grolaf",
      texte: "Réponds court.",
      provenance: "fichier-instance",
      autres: [{ botId: "yuki", texte: "Réponds court." }],
    });
    expect(verdict.refus).toBeUndefined();
  });
});

describe("diagnostic : le journal DIT ce qui a été injecté", () => {
  it("`chat.reponse.prompt_bot` porte bot, source, longueur et extrait", () => {
    const journal = journalFactice();
    promptRedacteurDuBot({
      botId: "grolaf",
      nom: "grolaf",
      personnalite: PERSONNALITE_GROLAF_RESOLUE,
      logger: journal,
    });
    const ligne = journal.lignes.find((l) => l.message === "chat.reponse.prompt_bot");
    expect(ligne).toBeDefined();
    expect(ligne?.champs.bot).toBe("grolaf");
    expect(ligne?.champs.personnalite_source).toBe("bot");
    expect(ligne?.champs.personnalite_chars).toBeGreaterThan(0);
    expect(String(ligne?.champs.personnalite_extrait)).toContain("Cybergitan du 34");
  });

  it("ne se répète pas à chaque réponse (dédoublonné par empreinte)", () => {
    const journal = journalFactice();
    const memoire = new Map<string, string>();
    for (const _ of [1, 2, 3]) {
      promptRedacteurDuBot({
        botId: "grolaf",
        nom: "grolaf",
        personnalite: PERSONNALITE_GROLAF_RESOLUE,
        logger: journal,
        memoire,
      });
    }
    expect(journal.lignes.filter((l) => l.message === "chat.reponse.prompt_bot")).toHaveLength(1);
  });
});

describe("le générateur transmet la CONVERSATION à l'écrivain", () => {
  it("createWriter reçoit l'identifiant de la conversation du message", async () => {
    const recus: string[] = [];
    const generateur = createRemoteReplyGenerator({
      available: () => true,
      botName: (conversationId) => (conversationId === "mm-grolaf" ? "grolaf" : "yuki"),
      runTools: () => ({ tools: [], customTools: [] }),
      createWriter: (_run, conversationId) => {
        recus.push(conversationId);
        return async () => "réponse";
      },
    });
    await generateur({
      channelTitle: "canal de grolaf",
      transcript: [],
      message: message("mm-grolaf", "@grolaf allo ?"),
    });
    expect(recus).toEqual(["mm-grolaf"]);
  });
});

describe("juge : il nomme le bot qui lit CE canal", () => {
  it("prompt système du juge", () => {
    expect(chatJudgeSystemPrompt({ botName: "grolaf" })).toContain("s'adresse à grolaf");
    expect(chatJudgeSystemPrompt({ botName: "grolaf" })).not.toContain("s'adresse à Yuki");
    // Repli documenté : sans nom, le comportement d'avant est conservé.
    expect(chatJudgeSystemPrompt()).toContain("s'adresse à Yuki");
  });

  it("question finale du prompt de jugement", () => {
    const prompt = buildJudgePrompt({
      channelTitle: "canal de grolaf",
      message: message("mm-grolaf", "@grolaf allo ?"),
      botName: "grolaf",
    });
    expect(prompt).toContain("Ce message s'adresse-t-il à grolaf ?");
  });
});

describe("le WEB et le CANAL injectent la MÊME personnalité pour un même bot", () => {
  it("grolaf : composition locale (`<personnalite>`) et canal disent la même chose", () => {
    // Composition LOCALE (ce que le host du web envoie).
    const local = composerPromptSysteme({
      nom: "grolaf",
      personnalite: PERSONNALITE_GROLAF,
      prompt: "Consignes de conversation livrées.",
    });
    // Composition du CANAL (ce que le rédacteur distant envoie).
    const canal = promptRedacteurDuBot({
      botId: "grolaf",
      nom: "grolaf",
      personnalite: PERSONNALITE_GROLAF_RESOLUE,
      autres: [{ botId: "yuki", texte: PERSONNALITE_YUKI }],
    });
    for (const prompt of [local, canal]) {
      expect(prompt).toContain("Grolaf");
      expect(prompt).toContain("Le Cybergitan du 34.");
      expect(prompt).not.toContain("Même personne partout");
      expect(prompt.split("<personnalite>").length - 1).toBe(1);
    }
  });
});

describe("réponse par défaut (aucun bot nommé) : contrat inchangé", () => {
  it("identité de repli et règles identiques", () => {
    const prompt = chatReplySystemPrompt();
    expect(prompt).toContain("Tu es Yuki");
    expect(prompt).not.toContain("<personnalite>");
  });
});
