/**
 * BOT DE LA CONVERSATION (lot 36, L4) — logique PURE (`public/ui/bot-conversation.js`).
 *
 * Ce que ces tests défendent :
 *  - **compatibilité** : sans `?b=`, aucune trame ne porte `botId` (la page de
 *    conversation d'aujourd'hui envoie exactement ce qu'elle envoyait avant L4) ;
 *  - **honnêteté** : le badge de l'en-tête ne dit QUE ce que le serveur annonce
 *    (`welcome.bot`) ; si un bot est demandé et que le serveur ne le confirme
 *    pas, on écrit « bot principal » plutôt que de laisser croire au slug.
 */

import { describe, expect, it } from "vitest";

import {
  botDeLaPage,
  champBot,
  texteBot,
} from "../../public/ui/bot-conversation.js";

describe("botDeLaPage", () => {
  it("lit `?b=<slug>` (même convention que /bots)", () => {
    expect(botDeLaPage("?b=kohai")).toBe("kohai");
    expect(botDeLaPage("?session=abc&b=kohai")).toBe("kohai");
  });

  it("sans `?b=` (ou vide) : aucun bot demandé", () => {
    expect(botDeLaPage("")).toBe(null);
    expect(botDeLaPage("?session=abc")).toBe(null);
    expect(botDeLaPage("?b=")).toBe(null);
    expect(botDeLaPage("?b=%20%20")).toBe(null);
    expect(botDeLaPage(undefined)).toBe(null);
  });
});

describe("champBot", () => {
  it("ne joint RIEN quand aucun bot n'est demandé (trame d'avant L4)", () => {
    expect(champBot(null)).toEqual({});
    expect(champBot(undefined)).toEqual({});
    expect(champBot("")).toEqual({});
    expect(Object.keys(champBot(null))).toEqual([]);
  });

  it("joint `botId` quand un bot est demandé", () => {
    expect(champBot("kohai")).toEqual({ botId: "kohai" });
  });
});

describe("texteBot", () => {
  it("croit le SERVEUR (`welcome.bot`) avant tout", () => {
    expect(texteBot("kohai", "kohai")).toBe("kohai");
    expect(texteBot("kohai", null)).toBe("kohai");
  });

  it("un bot demandé mais NON confirmé s'affiche « bot principal » (vérité)", () => {
    expect(texteBot(undefined, "kohai")).toBe("bot principal");
    expect(texteBot("", "kohai")).toBe("bot principal");
  });

  it("rien demandé, rien annoncé : aucun badge (écran inchangé)", () => {
    expect(texteBot(undefined, null)).toBe(null);
    expect(texteBot("", "")).toBe(null);
  });
});
