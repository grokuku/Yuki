/**
 * LOT 25 — le fil de canal est HORODATÉ, et le prompt dit l'heure qu'il est.
 *
 * Défaut d'origine (signalé le 2026-11-02) : « elle m'a dit qu'elle avait pas les
 * timestamp des messages ». Le fil était injecté en lignes `auteur : texte`, sans aucune
 * heure : le modèle ne pouvait donc pas savoir quel message était RÉCENT, et citait une
 * fiche du matin comme « la dernière » alors qu'une autre était arrivée trois minutes
 * plus tard. Ces tests verrouillent quatre choses :
 *
 *  1. chaque ligne du fil porte `[JJ/MM HH:mm]` ;
 *  2. l'horodatage ENTRE dans la fenêtre de 6 000 caractères (elle ne rétrécit pas en
 *     silence) et l'ordre de troncature ne change pas (les plus RÉCENTS restent) ;
 *  3. le prompt porte l'HEURE COURANTE, au format des prompts locaux ;
 *  4. quand la fenêtre coupe, une mention DIT que l'historique est partiel — et elle est
 *     absente quand tout tient.
 */

import { describe, expect, it } from "vitest";

import {
  CHAT_PARTIAL_HISTORY_NOTICE,
  CHAT_REPLY_TRANSCRIPT_MAX_CHARS,
  buildReplyPrompt,
  formatLineTimestamp,
} from "../../src/chat/reply/prompt.js";
import type { RemoteMessage } from "../../src/chat/types.js";

/** Message d'un humain, à un instant DONNÉ (tous les tests fixent l'instant). */
function message(text: string, options: { id: string; at: string; auteur?: string }): RemoteMessage {
  const auteur = options.auteur ?? "humain-1";
  return {
    remoteId: options.id,
    conversationId: "mm-canal-1",
    author: { id: auteur, nom: auteur, estBot: false },
    role: "user",
    text,
    sentAt: options.at,
  };
}

/**
 * Lignes du FIL seul (entre l'en-tête « Fil récent » et la section suivante).
 *
 * ⚠️ On mesure le bloc RÉELLEMENT transmis : c'est lui que la borne doit tenir.
 */
function filLines(prompt: string): string[] {
  const marque = "Fil récent (du plus ancien au plus récent) :\n";
  const position = prompt.indexOf(marque);
  expect(position).toBeGreaterThanOrEqual(0);
  const apres = prompt.slice(position + marque.length);
  const fin = apres.indexOf("\n\n");
  const bloc = fin === -1 ? apres : apres.slice(0, fin);
  return bloc.split("\n").filter((ligne) => ligne !== "");
}

/** Instant `HH:mm` d'une ligne horodatée (pour comparer deux lignes). */
function horodatageDe(ligne: string): string {
  const match = /^\[(\d{2}\/\d{2} \d{2}:\d{2})\] /.exec(ligne);
  expect(match).not.toBeNull();
  return (match as RegExpExecArray)[1] as string;
}

describe("horodatage des lignes du fil", () => {
  it("chaque ligne porte `[JJ/MM HH:mm]` (deux messages d'heures connues)", () => {
    const ancien = message("j'ai produit la fiche", { id: "m1", at: "2026-11-02T11:46:00.000Z" });
    const recent = message("et voici celle de maintenant", {
      id: "m2",
      at: "2026-11-02T15:09:00.000Z",
    });
    const declencheur = message("c'est laquelle la dernière ?", {
      id: "m3",
      at: "2026-11-02T15:12:00.000Z",
    });

    const prompt = buildReplyPrompt({
      channelTitle: "Général",
      transcript: [ancien, recent, declencheur],
      message: declencheur,
      timeZone: "UTC",
    });

    expect(prompt).toContain("[02/11 11:46] humain-1 : j'ai produit la fiche");
    expect(prompt).toContain("[02/11 15:09] humain-1 : et voici celle de maintenant");
    // Chaque ligne du fil est horodatée, sans exception.
    for (const ligne of filLines(prompt)) expect(horodatageDe(ligne)).toMatch(/^\d{2}\/\d{2} \d{2}:\d{2}$/);
  });

  it("l'ORDRE se LIT dans l'horodatage (ancien avant récent)", () => {
    const fil = [
      message("message du matin", { id: "a", at: "2026-11-02T08:15:00.000Z" }),
      message("message de l'après-midi", { id: "b", at: "2026-11-02T14:20:00.000Z" }),
      message("message du soir", { id: "c", at: "2026-11-02T21:05:00.000Z" }),
    ];
    const prompt = buildReplyPrompt({
      channelTitle: "Général",
      transcript: fil,
      message: message("question", { id: "q", at: "2026-11-02T21:06:00.000Z" }),
      timeZone: "UTC",
    });
    const lignes = filLines(prompt);
    const instants = lignes.map(horodatageDe);
    expect(instants).toEqual(["02/11 08:15", "02/11 14:20", "02/11 21:05"]);
    // Croissant : l'ordre du fil reste celui du miroir (plus ancien → plus récent).
    expect([...instants].sort()).toEqual(instants);
  });

  it("respecte le FUSEAU demandé (même horloge que les prompts locaux)", () => {
    // 10:46 UTC = 11:46 à Paris (CET) en novembre.
    expect(formatLineTimestamp("2026-11-02T10:46:00.000Z", "Europe/Paris")).toBe("[02/11 11:46]");
    expect(formatLineTimestamp("2026-11-02T10:46:00.000Z", "UTC")).toBe("[02/11 10:46]");
  });

  it("sans fuseau demandé, rend l'UTC (jamais le fuseau du process)", () => {
    // ⚠️ Le défaut est `ui.timeZone` côté serveur (`UTC` par défaut) : un appel
    // direct sans fuseau ne doit pas basculer sur l'heure de la machine.
    expect(formatLineTimestamp("2026-11-02T10:46:00.000Z")).toBe("[02/11 10:46]");
  });

  it("n'invente JAMAIS une heure pour un instant illisible", () => {
    expect(formatLineTimestamp("pas une date")).toBe("[horodatage inconnu]");
    const prompt = buildReplyPrompt({
      channelTitle: "Général",
      transcript: [message("ancien", { id: "a", at: "pas une date" })],
      message: message("question", { id: "q", at: "2026-11-02T15:12:00.000Z" }),
      timeZone: "UTC",
    });
    expect(prompt).toContain("[horodatage inconnu] humain-1 : ancien");
  });
});

describe("notion de présent", () => {
  it("le prompt porte l'HEURE COURANTE au format des prompts locaux", () => {
    const prompt = buildReplyPrompt({
      channelTitle: "Général",
      transcript: [message("bonjour", { id: "a", at: "2026-11-02T11:46:00.000Z" })],
      message: message("tu es là ?", { id: "q", at: "2026-11-02T15:12:00.000Z" }),
      now: new Date("2026-11-02T15:12:00.000Z"),
      timeZone: "UTC",
    });
    // ⚠️ Suffixe du FUSEAU EXPLICITE (défaut UTC) : le prompt ne dépend jamais du
    // fuseau du process, ni de celui d'un navigateur.
    expect(prompt).toContain("Heure courante : [horodatage] 2026-11-02 15:12 (UTC)");
    // Le repère est AVANT le fil : il sert de point de comparaison aux lignes.
    expect(prompt.indexOf("Heure courante")).toBeLessThan(prompt.indexOf("Fil récent"));
  });
});

describe("fenêtre bornée — l'horodatage entre dans le décompte", () => {
  const fil: RemoteMessage[] = Array.from({ length: 12 }, (_, index) =>
    message(`message numéro ${index} avec un peu de texte pour peser`, {
      id: `t${index}`,
      at: new Date(Date.UTC(2026, 10, 2, 8, 0, index)).toISOString(),
    }),
  );
  const declencheur = message("question", { id: "q", at: "2026-11-02T09:00:00.000Z" });

  for (const maxChars of [100, 150, 300, 600, 1_000, CHAT_REPLY_TRANSCRIPT_MAX_CHARS]) {
    it(`le fil transmis tient dans maxChars=${maxChars} (horodatages et retours à la ligne compris)`, () => {
      const prompt = buildReplyPrompt({
        channelTitle: "Général",
        transcript: fil,
        message: declencheur,
        maxChars,
        timeZone: "UTC",
      });
      const lignes = filLines(prompt);
      expect(lignes.length).toBeGreaterThan(0);
      // ⚠️ Le bloc RÉEL (horodatages inclus) ne dépasse jamais la borne annoncée.
      expect(lignes.join("\n").length).toBeLessThanOrEqual(maxChars);
      // Chaque ligne conservée est horodatée : la borne ne « vole » pas l'heure.
      for (const ligne of lignes) expect(ligne.startsWith("[")).toBe(true);
    });
  }

  it("tronque du côté ANCIEN : les messages les plus RÉCENTS restent", () => {
    const prompt = buildReplyPrompt({
      channelTitle: "Général",
      transcript: fil,
      message: declencheur,
      maxChars: 200,
      timeZone: "UTC",
    });
    const lignes = filLines(prompt);
    expect(lignes[lignes.length - 1]).toContain("message numéro 11");
    expect(prompt).not.toContain("message numéro 0 ");
  });
});

describe("mention « historique partiel »", () => {
  const fil: RemoteMessage[] = Array.from({ length: 40 }, (_, index) =>
    message(`message numéro ${index} avec un peu de texte pour peser`, {
      id: `t${index}`,
      at: new Date(Date.UTC(2026, 10, 2, 8, 0, index)).toISOString(),
    }),
  );
  const declencheur = message("question", { id: "q", at: "2026-11-02T09:00:00.000Z" });

  it("PRÉSENTE quand la fenêtre coupe", () => {
    const prompt = buildReplyPrompt({
      channelTitle: "Général",
      transcript: fil,
      message: declencheur,
      maxChars: 300,
      timeZone: "UTC",
    });
    expect(prompt).toContain(CHAT_PARTIAL_HISTORY_NOTICE);
    expect(prompt).toContain("incomplet");
    expect(prompt).toContain("plus anciens");
  });

  it("ABSENTE quand tout tient", () => {
    const prompt = buildReplyPrompt({
      channelTitle: "Général",
      transcript: fil.slice(-3),
      message: declencheur,
      timeZone: "UTC",
    });
    expect(prompt).not.toContain(CHAT_PARTIAL_HISTORY_NOTICE);
    expect(prompt).not.toContain("incomplet");
  });

  it("ABSENTE quand le fil est vide (aucune coupe à signaler)", () => {
    const prompt = buildReplyPrompt({
      channelTitle: "Général",
      transcript: [],
      message: declencheur,
      timeZone: "UTC",
    });
    expect(prompt).toContain("(aucun message précédent)");
    expect(prompt).not.toContain(CHAT_PARTIAL_HISTORY_NOTICE);
  });
});
