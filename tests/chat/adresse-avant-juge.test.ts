/**
 * ADRESSE AVANT LE JUGE (mode `auto`) — décision utilisateur du 2026-11-14 :
 * « le LLM juge, mais avant de faire juger tu devrais vérifier si le bot est cité.
 * S'il est cité on considère qu'on s'adresse à lui, du coup tu peux économiser un
 * appel LLM et partir directement en réponse. »
 *
 * Trois PREUVES D'ADRESSE, déterministes, évaluées AVANT tout appel modèle :
 *  ① mention native (`@grolaf`, `<@id>`, identifiant brut) ;
 *  ② le NOM du bot apparaît comme un MOT dans le texte (« grolafette » ne compte pas) ;
 *  ③ le message répond à un message DU BOT (fil).
 *
 * Ces tests VERROUILLENT l'ÉCONOMIE (le juge n'est pas appelé) autant que la
 * décision : c'est l'assertion sur le compteur d'appels qui échoue sur l'origine,
 * où tout message `auto` passait par le modèle.
 */

import { describe, expect, it } from "vitest";

import { botAliases, decideReply } from "../../src/chat/reply/responder.js";
import type { RemoteMessage } from "../../src/chat/types.js";

interface LigneJournal {
  message: string;
  champs: Record<string, unknown>;
}

function journalFactice(): { lignes: LigneJournal[]; info: (m: string, f?: Record<string, unknown>) => void } {
  const lignes: LigneJournal[] = [];
  return {
    lignes,
    info: (message, champs = {}) => lignes.push({ message, champs }),
  };
}

function message(texte: string, extra: Partial<RemoteMessage> = {}): RemoteMessage {
  return {
    remoteId: "post-1",
    conversationId: "mm-canal",
    text: texte,
    sentAt: "2026-11-14 15:20",
    role: "user",
    author: { id: "user-1", nom: "Nico", estBot: false },
    ...extra,
  };
}

/** Alias du bot `grolaf` (comme le font les adaptateurs). */
const ALIASES = botAliases({ botUserId: "bot-1", botUsername: "grolaf" });
const NOMS = ["grolaf"];

/** Juge espion : compte les appels (0 = économie réalisée). */
function jugeEspion(reponse = true): { appels: number; juge: () => Promise<boolean> } {
  const espion = {
    appels: 0,
    juge: async (): Promise<boolean> => {
      espion.appels += 1;
      return reponse;
    },
  };
  return espion;
}

describe("mode `auto` — preuve d'adresse AVANT le juge", () => {
  it("mention native ⇒ réponse DIRECTE, le juge n'est JAMAIS appelé", async () => {
    const espion = jugeEspion();
    const journal = journalFactice();
    const decision = await decideReply({
      message: message("@grolaf allo ?"),
      replyMode: "auto",
      aliases: ALIASES,
      botNames: NOMS,
      judge: espion.juge,
      logger: journal,
    });
    expect(decision.repondre).toBe(true);
    expect(decision.raison).toBe("mention");
    expect(espion.appels).toBe(0);
    expect(journal.lignes.map((l) => l.message)).toContain("chat.adresse.par_mention");
  });

  it("nom du bot dans le texte ⇒ réponse DIRECTE, sans juge", async () => {
    const espion = jugeEspion();
    const journal = journalFactice();
    const decision = await decideReply({
      message: message("bon, grolaf, tu es là ?"),
      replyMode: "auto",
      aliases: ALIASES,
      botNames: NOMS,
      judge: espion.juge,
      logger: journal,
    });
    expect(decision).toMatchObject({ repondre: true, raison: "nom" });
    expect(espion.appels).toBe(0);
    const ligne = journal.lignes.find((l) => l.message === "chat.adresse.par_nom");
    expect(ligne, "le risque de faux positif doit être journalisé").toBeDefined();
    expect(ligne?.champs.avertissement).toBeTruthy();
  });

  it("« grolafette » ne cite PAS grolaf (frontière de mot)", async () => {
    const espion = jugeEspion(false);
    const decision = await decideReply({
      message: message("la grolafette est prête"),
      replyMode: "auto",
      aliases: ALIASES,
      botNames: NOMS,
      judge: espion.juge,
    });
    expect(espion.appels).toBe(1);
    expect(decision).toMatchObject({ repondre: false, raison: "juge_non" });
  });

  it("réponse de fil à un message DU BOT ⇒ réponse DIRECTE, sans juge", async () => {
    const espion = jugeEspion();
    const decision = await decideReply({
      message: message("et du coup ?", { threadRootId: "post-bot" }),
      replyMode: "auto",
      aliases: ALIASES,
      botNames: NOMS,
      repondAuBot: (candidat) => candidat.threadRootId === "post-bot",
      judge: espion.juge,
    });
    expect(decision).toMatchObject({ repondre: true, raison: "reponse_au_bot" });
    expect(espion.appels).toBe(0);
  });

  it("aucune preuve d'adresse ⇒ le JUGE est appelé (comportement conservé)", async () => {
    const espion = jugeEspion(true);
    const journal = journalFactice();
    const decision = await decideReply({
      message: message("on se retrouve à midi ?"),
      replyMode: "auto",
      aliases: ALIASES,
      botNames: NOMS,
      repondAuBot: () => false,
      judge: espion.juge,
      logger: journal,
    });
    expect(espion.appels).toBe(1);
    expect(decision).toMatchObject({ repondre: true, raison: "juge_oui" });
    expect(journal.lignes.map((l) => l.message)).toContain("chat.adresse.juge");
  });

  it("juge indisponible + mention ⇒ le bot répond QUAND MÊME (jamais un silence sur une citation)", async () => {
    const decision = await decideReply({
      message: message("@grolaf allo ?"),
      replyMode: "auto",
      aliases: ALIASES,
      botNames: NOMS,
    });
    expect(decision).toMatchObject({ repondre: true, raison: "mention" });
  });
});

describe("un juge qui LÈVE ne fait jamais taire une citation", () => {
  it("mention + juge en échec ⇒ le bot répond quand même", async () => {
    const decision = await decideReply({
      message: message("@grolaf allo ?"),
      replyMode: "auto",
      aliases: ALIASES,
      botNames: NOMS,
      judge: async () => {
        throw new Error("modèle injoignable");
      },
    });
    expect(decision).toMatchObject({ repondre: true, raison: "mention" });
  });

  it("sans preuve + juge en échec ⇒ décision explicite ET journal visible", async () => {
    const journal = journalFactice();
    const decision = await decideReply({
      message: message("on se retrouve à midi ?"),
      replyMode: "auto",
      aliases: ALIASES,
      botNames: NOMS,
      judge: async () => {
        throw new Error("modèle injoignable");
      },
      logger: { ...journal, warn: journal.info },
    });
    expect(decision).toMatchObject({ repondre: false, raison: "juge_indisponible" });
    const ligne = journal.lignes.find((l) => l.message === "chat.adresse.juge_echec");
    expect(ligne, "un échec de juge ne doit jamais être muet").toBeDefined();
    expect(String(ligne?.champs.error)).toContain("modèle injoignable");
  });
});

describe("modes `mention` et `tout` — inchangés, et sans juge", () => {
  it("`mention` répond sur une mention, sans aucun juge disponible", async () => {
    const decision = await decideReply({
      message: message("@grolaf allo ?"),
      replyMode: "mention",
      aliases: ALIASES,
    });
    expect(decision).toMatchObject({ repondre: true, raison: "mention" });
  });

  it("`mention` répond aussi sur le NOM et sur une réponse au bot", async () => {
    const parNom = await decideReply({
      message: message("grolaf, une idée ?"),
      replyMode: "mention",
      aliases: ALIASES,
      botNames: NOMS,
    });
    expect(parNom).toMatchObject({ repondre: true, raison: "nom" });
    const parReponse = await decideReply({
      message: message("et alors ?", { threadRootId: "post-bot" }),
      replyMode: "mention",
      aliases: ALIASES,
      botNames: NOMS,
      repondAuBot: () => true,
    });
    expect(parReponse).toMatchObject({ repondre: true, raison: "reponse_au_bot" });
  });

  it("`mention` ne répond toujours pas sans citation", async () => {
    const decision = await decideReply({
      message: message("on se retrouve à midi ?"),
      replyMode: "mention",
      aliases: ALIASES,
      botNames: NOMS,
    });
    expect(decision).toMatchObject({ repondre: false, raison: "pas_de_mention" });
  });

  it("`tout` répond à tout message humain, sans juge", async () => {
    const espion = jugeEspion();
    const decision = await decideReply({
      message: message("on se retrouve à midi ?"),
      replyMode: "tout",
      aliases: ALIASES,
      botNames: NOMS,
      judge: espion.juge,
    });
    expect(decision).toMatchObject({ repondre: true, raison: "mode_tout" });
    expect(espion.appels).toBe(0);
  });

  it("un message de robot ne reçoit jamais de réponse, même cité", async () => {
    const decision = await decideReply({
      message: message("@grolaf allo ?", {
        author: { id: "other-bot", nom: "autre bot", estBot: true },
      }),
      replyMode: "auto",
      aliases: ALIASES,
      botNames: NOMS,
    });
    expect(decision).toMatchObject({ repondre: false, raison: "auteur_bot" });
  });
});
