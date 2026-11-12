/**
 * LOT 41 — LES DEUX BOUTONS DE RÉGLAGES DE LA BARRE DU HAUT.
 *
 * ⚠️ LE DÉFAUT CORRIGÉ ICI (retour utilisateur du 2026-11-12) : « j'avais dit :
 * sépare complètement les paramètres globaux des paramètres individuels des bots.
 * Donc déjà deux boutons. Je n'ai toujours qu'un bouton paramètre. […] ce bouton
 * ouvre la page de config de Yuki et je ne peux pas aller sur les autres bots. »
 *
 * Ce que ces tests défendent :
 *  - **deux** destinations distinctes et libellées en français :
 *    « Réglages généraux » → `/config`, « Réglages du bot » → `/bots?b=…` ;
 *  - « Réglages du bot » porte le bot AFFICHÉ (jamais `yuki` en dur quand un
 *    autre bot est sélectionné), avec repli `yuki` pour un bot retiré ;
 *  - téléphone : les deux restent ATTEIGNABLES (panneau « Config ») — on ne
 *    supprime rien, on déplace.
 *
 * ⚠️ CES TESTS ÉCHOUENT SUR LE CODE D'ORIGINE : la barre du haut n'a qu'une
 * pastille `Configuration` (`href="/config"`), `urlReglagesBot` n'existe pas,
 * et `app.js` n'écrit jamais l'`href` d'un bouton de réglages.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BOT_REGLAGES_REPLI,
  urlReglagesBot,
} from "../../public/ui/bot-switcher-modele.js";

const ui = (name: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", name), "utf8");

/** Bandeau seul (`.topbar`), pour ne pas confondre avec le panneau téléphone. */
function bandeau(html: string): string {
  const debut = html.indexOf('<header class="topbar">');
  const fin = html.indexOf("</header>", debut);
  expect(debut).toBeGreaterThan(-1);
  expect(fin).toBeGreaterThan(debut);
  return html.slice(debut, fin);
}

describe("urlReglagesBot — le bouton porte le bot AFFICHÉ", () => {
  it("bot affiché connu ⇒ SES réglages (pas ceux de `yuki`)", () => {
    const bots = [{ id: "yuki" }, { id: "kohai" }];
    expect(urlReglagesBot("kohai", bots)).toBe("/bots?b=kohai");
    expect(urlReglagesBot("yuki", bots)).toBe("/bots?b=yuki");
  });

  it("aucun bot affiché (`null`, vide, espaces) ⇒ repli `yuki`", () => {
    expect(urlReglagesBot(null, [{ id: "kohai" }])).toBe("/bots?b=yuki");
    expect(urlReglagesBot("", [{ id: "kohai" }])).toBe("/bots?b=yuki");
    expect(urlReglagesBot("   ", [{ id: "kohai" }])).toBe("/bots?b=yuki");
    expect(BOT_REGLAGES_REPLI).toBe("yuki");
  });

  it("bot RETIRÉ de l'instance (absent de la liste connue) ⇒ repli `yuki`", () => {
    expect(urlReglagesBot("fantome", [{ id: "yuki" }, { id: "kohai" }])).toBe(
      "/bots?b=yuki",
    );
  });

  it("liste pas encore lue (vide) ⇒ on garde le bot affiché", () => {
    expect(urlReglagesBot("kohai", [])).toBe("/bots?b=kohai");
    expect(urlReglagesBot("kohai", undefined)).toBe("/bots?b=kohai");
  });

  it("slugs encodés (état partageable, rechargement sûr)", () => {
    expect(urlReglagesBot("a b", [])).toBe("/bots?b=a%20b");
  });
});

describe("barre du haut — DEUX pastilles, libellés français", () => {
  const html = ui("index.html");
  const topbar = bandeau(html);

  it("« Réglages généraux » mène à la page INSTANCE (`/config`)", () => {
    expect(topbar).toMatch(
      /<a[^>]*id="reglages-generaux"[^>]*href="\/config"[^>]*>[\s\S]*?Réglages généraux/,
    );
  });

  it("« Réglages du bot » mène à la page BOT (`/bots?b=…`)", () => {
    expect(topbar).toMatch(
      /<a[^>]*id="reglages-bot"[^>]*href="\/bots\?b=yuki"[^>]*>[\s\S]*?Réglages du bot/,
    );
  });

  it("l'unique bouton « Configuration » a disparu du bandeau", () => {
    expect(topbar).not.toMatch(/<a[^>]*class="pill topbar__config"[^>]*>\s*Configuration\s*</);
    // Plus aucun libellé anglais de type « bot configuration ».
    expect(topbar.toLowerCase()).not.toContain("bot configuration");
  });

  it("TÉLÉPHONE : les deux destinations restent atteignables (panneau Config)", () => {
    // Les pastilles du bandeau sont masquées en téléphone (règle existante)…
    expect(ui("styles.css")).toMatch(/\.topbar__config\s*\{[^}]*display:\s*none/s);
    // …donc les deux mêmes réglages vivent dans le panneau « Config ».
    const panneau = html.slice(html.indexOf('id="mnav-panel-config"'));
    expect(panneau).toContain('href="/config"');
    expect(panneau).toMatch(
      /<a[^>]*id="mnav-reglages-bot"[^>]*href="\/bots\?b=yuki"[^>]*>[\s\S]*?Réglages du bot affiché/,
    );
  });
});

describe("app.js — l'`href` suit le bot affiché, sans HTML ni style inline", () => {
  const app = ui("app.js");

  it("importe la règle PURE (`urlReglagesBot`), pas une URL recopiée", () => {
    expect(app).toContain('from "./bot-switcher-modele.js"');
    expect(app).toContain("urlReglagesBot(");
    // Les DEUX liens (bandeau + panneau téléphone) sont réécrits.
    expect(app).toContain('document.getElementById("reglages-bot")');
    expect(app).toContain('document.getElementById("mnav-reglages-bot")');
    expect(app).toContain('setAttribute("href", url)');
  });

  it("met à jour après `welcome` (le bot RÉELLEMENT connecté)", () => {
    expect(app).toMatch(/botConnecte = typeof frame\.bot[\s\S]{0,400}?majLienReglagesBot\(\);/);
    // Et après la lecture de la liste des bots (pour écarter un bot retiré).
    expect(app).toMatch(/botSwitcher\.rafraichir\(\)\.then\(/);
  });
});
