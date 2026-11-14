/**
 * INTERFACE DES CONSIGNES DURABLES + RÉORGANISATION DES ONGLETS.
 *
 * Ce que ce fichier VERROUILLE (décision utilisateur du 2026-11-14) :
 *  ① **onglets IDENTIQUES pour tous les bots** : l'onglet « Personnalité » et
 *    l'onglet « Prompts » viennent du CATALOGUE pur (`config-pages.js` +
 *    `config-fields.js`), qui ne connaît aucun bot — aucun panneau n'est
 *    conditionné à un identifiant ;
 *  ② **Consignes ET Faits éditables dans l'onglet « Personnalité »**
 *    (`consignes-root`, deux zones de texte, un enregistrement) ;
 *  ③ **les prompts sont dans un onglet SÉPARÉ** (« Prompts »), sur la page du
 *    bot COMME sur `/config` ;
 *  ④ **compteurs visibles** (« 3 / 50 consignes ») et **texte d'aide** disant
 *    pourquoi ce n'est PAS la mémoire ;
 *  ⑤ CSP inchangée : pas d'`innerHTML` (même en commentaire), pas de `.style.`,
 *    pas de `window.confirm(` dans le composant.
 *
 * ⚠️ ÉCHOUE SUR LE CODE D'ORIGINE : `public/ui/consignes-panel.js` n'existe pas,
 * l'onglet « Prompts » non plus, et le catalogue ne connaît ni `consignes` ni
 * `personnalite`/`prompts-systeme`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GROUPS } from "../../public/ui/config-fields.js";
import { champsDePage, groupesParOnglet, idsOnglets } from "../../public/ui/config-pages.js";
import { CONFIG_SCHEMA } from "../../src/config/schema.js";

const lire = (nom: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", nom), "utf8");

const BOTS_HTML = lire("bots.html");
const CONFIG_HTML = lire("config.html");
const CONFIG_JS = lire("config.js");
const PANEL_JS = lire("consignes-panel.js");

/** Portée réelle de chaque clé (autorité = le schéma serveur). */
const SCOPES: Record<string, string> = Object.fromEntries(
  Object.entries(CONFIG_SCHEMA).map(([path, descriptor]) => [path, descriptor.scope]),
);

/** Champs d'un onglet d'une page, DANS L'ORDRE (aucun bot en jeu). */
function champsOnglet(page: string, onglet: string): string[] {
  return (groupesParOnglet(page, GROUPS)[onglet] ?? []).flatMap((groupe) =>
    champsDePage(page, groupe, SCOPES).map((field) => field.path),
  );
}

/** Contenu d'un `<section role="tabpanel" id="panel-<onglet>">`. */
function panneau(html: string, onglet: string): string {
  const match = new RegExp(
    `<section[^>]*id="panel-${onglet}"[^>]*>([\\s\\S]*?)</section>`,
  ).exec(html);
  if (match === null) throw new Error(`panneau ${onglet} introuvable`);
  return match[1];
}

describe("① onglets IDENTIQUES pour tous les bots (aucun bot dans le calcul)", () => {
  it("le catalogue ne contient AUCUN identifiant de bot", () => {
    const source = lire("config-fields.js") + lire("config-pages.js");
    for (const interdit of ["BOT_YUKI", "botHistoriqueMono"]) {
      expect(source, interdit).not.toContain(interdit);
    }
    expect(source).not.toMatch(/botId\s*===\s*"/);
  });

  it("les onglets d'un bot sont ceux du module pur (aucun paramètre de bot)", () => {
    // `idsOnglets` / `groupesParOnglet` ne prennent QUE la page : deux bots ne
    // peuvent pas produire deux listes.
    expect(idsOnglets("bot")).toEqual([
      "general",
      "personnalite",
      "prompts",
      "voix",
      "memoire",
      "plateformes",
      "declencheurs",
    ]);
    expect(idsOnglets("instance")).toEqual([
      "modeles",
      "prompts",
      "execution",
      "images",
      "agents",
      "secrets",
      "systeme",
      "maintenance",
    ]);
  });

  it("chaque onglet porte son panneau dans le markup (page Bot)", () => {
    for (const onglet of idsOnglets("bot")) {
      expect(BOTS_HTML, onglet).toContain(`id="panel-${onglet}"`);
      expect(BOTS_HTML, onglet).toContain(`aria-controls="panel-${onglet}"`);
    }
    for (const onglet of idsOnglets("instance")) {
      expect(CONFIG_HTML, onglet).toContain(`id="panel-${onglet}"`);
    }
  });
});

describe("② Consignes ET Faits éditables dans l'onglet « Personnalité »", () => {
  it("le panneau Personnalité monte les consignes durables", () => {
    const contenu = panneau(BOTS_HTML, "personnalite");
    expect(contenu).toContain('id="group-personnalite"');
    expect(contenu).toContain('id="consignes-root"');
    // ⚠️ Aucune condition sur un bot : le montage ne dépend que de la page.
    expect(CONFIG_JS).toContain('const consignesRoot = document.getElementById("consignes-root")');
    expect(CONFIG_JS).toMatch(/botDesConsignes !== "" && consignesRoot/);
    expect(CONFIG_JS).not.toMatch(/panneauxDuBotActif\s*&&\s*consignesRoot/);
  });

  it("le composant offre deux zones d'édition et un enregistrement", () => {
    expect(PANEL_JS).toContain("export function initConsignesPanel(");
    // Deux zones (une par nature), jamais un JSON à éditer à la main.
    expect(PANEL_JS).toContain('"aria-label": "Consignes durables"');
    expect(PANEL_JS).toContain('"aria-label": "Faits durables"');
    expect(PANEL_JS).toContain("Enregistrer les consignes");
    // Écriture vers la route PAR BOT (le fichier est celui du bot affiché).
    expect(PANEL_JS).toContain("/api/bots/${encodeURIComponent(botId)}/consignes");
    expect(PANEL_JS).toContain('"x-yuki-config": "1"');
    // Les lignes sont lues comme une LISTE (une entrée par ligne).
    expect(PANEL_JS).toContain("export function entreesDeTexte(");
  });

  it("le texte d'aide dit que ce n'est PAS la mémoire", () => {
    expect(PANEL_JS).toContain("ce ne sont PAS des souvenirs");
    expect(PANEL_JS).toContain("injectées à CHAQUE tour");
    // La note de l'onglet le redit (catalogue), sans être un miroir du composant.
    const groupe = (groupesParOnglet("bot", GROUPS).personnalite ?? [])[0];
    const note = String((groupe as { note?: string }).note ?? "");
    expect(note).toContain("CONSIGNES DURABLES");
    expect(note).toContain("ce n'est pas la mémoire");
  });

  it("les compteurs rendent les bornes visibles (« 3 / 50 consignes »)", () => {
    expect(PANEL_JS).toContain("export function libelleCompteur(");
    expect(PANEL_JS).toContain("maximums.consignes");
    expect(PANEL_JS).toContain("maximums.faits");
    // Les maxima viennent du SERVEUR (aucune constante recopiée dans l'UI).
    expect(PANEL_JS).toContain("donnees.maxConsignes");
    expect(PANEL_JS).toContain("donnees.maxFaits");
  });

  it("un refus serveur est AFFICHÉ (jamais une troncature silencieuse)", () => {
    expect(PANEL_JS).toContain("Refusé");
    expect(PANEL_JS).toContain("HolafModal.alert");
  });
});

describe("③ les prompts vivent dans un onglet SÉPARÉ", () => {
  it("sur la page du bot : prompts système + outils générés, PAS la personnalité", () => {
    expect(champsOnglet("bot", "prompts")).toEqual(["prompts.light", "prompts.heavy"]);
    const contenu = panneau(BOTS_HTML, "prompts");
    expect(contenu).toContain('id="group-prompts"');
    // La personnalité, les consignes et les faits ne sont PAS ici.
    expect(champsOnglet("bot", "personnalite")).toEqual(["prompts.personnalite"]);
    const groupe = (groupesParOnglet("bot", GROUPS).prompts ?? [])[0] as
      | { toolsInstruction?: boolean; renvoi?: { bot?: { lien?: { href?: string } } } }
      | undefined;
    // Liste d'outils GÉNÉRÉE (lecture seule) + renvoi vers les règles communes.
    expect(groupe?.toolsInstruction).toBe(true);
    expect(groupe?.renvoi?.bot?.lien?.href).toBe("/config#prompts");
  });

  it("sur `/config` : prompts par défaut + personnalité par défaut + règles communes", () => {
    expect(champsOnglet("instance", "prompts")).toEqual([
      "prompts.personnalite",
      "prompts.light",
      "prompts.heavy",
    ]);
    const contenu = panneau(CONFIG_HTML, "prompts");
    expect(contenu).toContain('id="group-prompts"');
    // Les RÈGLES COMMUNES (et la personnalité d'amorçage) sont dans cet onglet.
    expect(contenu).toContain('id="personality-root"');
    // Et PAS dans « Modèles » (séparation demandée).
    expect(panneau(CONFIG_HTML, "modeles")).not.toContain('id="personality-root"');
  });
});

describe("④/⑤ CSP inchangée dans le composant", () => {
  it("aucun `innerHTML`, aucun `.style.`, aucun `window.confirm(`", () => {
    expect(PANEL_JS).not.toContain("innerHTML");
    expect(PANEL_JS).not.toContain(".style.");
    expect(PANEL_JS).not.toContain('setAttribute("style"');
    expect(PANEL_JS).not.toContain("window.confirm(");
  });

  it("le markup des pages n'ajoute aucun style inline", () => {
    expect(BOTS_HTML).not.toMatch(/id="consignes-root"[^>]*style=/);
    expect(CONFIG_HTML).not.toMatch(/\sstyle=/);
  });
});
