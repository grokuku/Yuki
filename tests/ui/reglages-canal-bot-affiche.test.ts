/**
 * Réglages d'un canal — LE CANAL D'UN BOT NON PRINCIPAL DOIT ÊTRE RÉGLABLE.
 *
 * Exigence utilisateur (2026-11-13) : « c'est important de voir les canaux parce
 * que c'est ce qui permet de régler le mode de réponse du bot ». La liste des
 * canaux n'est pas décorative : c'est le SEUL point d'entrée des trois réglages
 * par canal (quand répondre, comment répondre, mentionner l'auteur).
 *
 * Ce que ce fichier prouve, statiquement (aucun navigateur) :
 *  1. le bloc des trois réglages est monté et affiché pour TOUT canal distant
 *     (`kind === "remote"`), sans condition de bot — un bot secondaire n'a pas
 *     un menu différent ;
 *  2. l'écriture PART avec le bot AFFICHÉ (`bot` dans le corps PATCH) : sans lui
 *     le serveur écrirait dans le miroir du bot courant et le réglage serait
 *     perdu ;
 *  3. le menu reste accessible au doigt (appui long), pas seulement au clic
 *     droit — c'est le même panneau qui sert le menu téléphone.
 *
 * ⚠️ Échoue sur le code d'origine : la barre latérale ne recevait pas le bot
 * affiché, et `applyReplySettings` envoyait le patch SEUL — le serveur écrivait
 * donc dans le miroir du bot courant.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = (name: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", name), "utf8");

describe("menu d'un canal — les trois réglages, pour TOUT bot", () => {
  const panel = source("sessions-panel.js");

  it("les trois groupes de réglages sont montés", () => {
    expect(panel).toContain('ajouterGroupe("Quand répondre"');
    expect(panel).toContain('ajouterGroupe("Comment répondre"');
    expect(panel).toContain('ajouterGroupe("Mentionner l\'auteur"');
  });

  it("le bloc est affiché pour un canal MIRROIR, quel que soit son bot", () => {
    // Aucune condition de bot : `kind === "remote"` suffit (un canal de
    // `granolaf` est un miroir comme un canal de `yuki`).
    expect(panel).toContain('cible.kind === "remote"');
    expect(panel).toContain("replyBlock.hidden = !distant");
    // Pas de filtre par identifiant de bot dans le panneau.
    expect(panel).not.toContain('kind === "remote" && bot');
  });

  it("l'écriture joint le bot AFFICHÉ (le serveur écrit dans SON miroir)", () => {
    expect(panel).toContain("const bot = String(botId()");
    expect(panel).toContain("{ ...patch, bot }");
    // Et le panneau reçoit bien une fabrique, pas un identifiant gravé.
    expect(panel).toContain('typeof deps.botId === "function"');
    expect(source("app.js")).toContain("botId: () => botAffiche()");
  });

  it("le menu reste accessible AU DOIGT (appui long), pas seulement au clic droit", () => {
    // Même menu, même ancre : `attachLongPress` reçoit le point du doigt, et
    // `openMenu` le place au-dessus (voir `point`).
    expect(panel).toContain("attachLongPress(item, (point) => openMenu(info.id, item, point))");
    expect(panel).toContain("let left = point ? point.x : rect.left + 8");
    expect(panel).toContain("let top = point ? point.y : rect.bottom + 4");
  });
});
