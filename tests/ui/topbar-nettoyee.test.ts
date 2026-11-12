/**
 * LOT 40 — LA BARRE DU HAUT, NETTOYÉE.
 *
 * Retour utilisateur (2026-11-12) : à droite du bandeau s'empilaient des
 * informations inutiles — le NOM DU BOT (déjà porté par l'onglet de son bot, à
 * gauche) et l'état brut `idle`, du jargon serveur.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `public/ui/index.html` portait
 * `<span id="bot-name" class="pill pill--bot">` et `<span id="session-state"
 * class="pill">idle</span>`, et `app.js` réinjectait `"idle"` dans la pastille.
 *
 * Ce qui est verrouillé :
 *  ① la pastille du NOM DU BOT n'existe plus (ni en HTML, ni en JS) ;
 *  ② la pastille d'état ne dit plus jamais `idle`/`streaming` : elle parle
 *    français (« en train de travailler ») ou se MASQUE au repos ;
 *  ③ le reste du bandeau est intact : connexion, notifications, thème, lune,
 *    sourdine ;
 *  ④ garde-fous : pas d'`innerHTML`, pas de `.style.` (CSP inchangée).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const lire = (chemin: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", chemin), "utf8");

const html = lire("index.html");
const app = lire("app.js");

/** Le bandeau seul : les garde-fous ne portent pas sur le menu téléphone. */
const bandeau = html.slice(html.indexOf('<header class="topbar">'), html.indexOf("</header>"));

describe("bandeau — le nom du bot n'y est plus (il est dans son onglet)", () => {
  it("aucune pastille de bot dans le bandeau", () => {
    expect(bandeau).not.toContain('id="bot-name"');
    expect(bandeau).not.toContain("pill--bot");
    expect(html).not.toContain('id="bot-name"');
  });

  it("app.js ne pilote plus de pastille de nom de bot", () => {
    expect(app).not.toContain("botName");
    expect(app).not.toContain('getElementById("bot-name")');
    // `texteBot` reste une fonction testée à part : elle n'alimente plus l'en-tête.
    expect(app).not.toMatch(/import \{[^}]*texteBot[^}]*\} from "\.\/bot-conversation\.js"/);
  });
});

describe("bandeau — l'état de session est LISIBLE (plus de jargon `idle`)", () => {
  it("le HTML n'affiche plus le mot `idle`", () => {
    expect(bandeau).not.toMatch(/>\s*idle\s*</);
    expect(html).not.toMatch(/>\s*idle\s*</);
  });

  it("app.js n'écrit plus `idle` ni `streaming` dans la pastille", () => {
    expect(app).not.toMatch(/sessionState\.textContent\s*=\s*"idle"/);
    expect(app).not.toMatch(/sessionState\.textContent\s*=\s*"streaming"/);
  });

  it("app.js dit les choses en français et masque la pastille au repos", () => {
    expect(app).toContain('"en train de travailler"');
    expect(app).toMatch(/sessionState\.hidden = true/);
    expect(app).toMatch(/sessionState\.hidden = false/);
  });
});

describe("bandeau — ce qui devait rester est resté", () => {
  it("Configuration (orthographe française), connexion, notifications, thème, lune, sourdine", () => {
    expect(bandeau).toContain(">Configuration</a>");
    expect(bandeau).not.toContain("Configuración");
    expect(bandeau).toContain('id="connection"');
    expect(bandeau).toContain('id="notif-toggle"');
    expect(bandeau).toContain('id="sources-notifs-toggle"');
    expect(bandeau).toContain('id="theme-family"');
    expect(bandeau).toContain('id="theme-toggle"');
    expect(bandeau).toContain('id="tts-toggle"');
  });

  it("CSP : aucun `innerHTML` dans le rendu du bandeau par app.js", () => {
    // Les SEULES écritures brutes d'`app.js` sont la purge du fil (chaîne vide)
    // et la hauteur auto de la zone de saisie — le bandeau n'en utilise aucune.
    expect(app).not.toMatch(/botName|sessionState\.innerHTML/);
    expect(app).not.toMatch(/sessionState\.style\./);
  });
});
