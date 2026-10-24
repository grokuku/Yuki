/**
 * RÉACTIONS — catalogue (miroir du serveur), placement du menu (jamais coupé),
 * et invariants d'interface (CSP : aucun `innerHTML`).
 *
 * Ce que ce test prouve :
 *  - le catalogue du NAVIGATEUR est identique, identifiant par identifiant et
 *    libellé par libellé, à celui du SERVEUR (une divergence casse la suite) ;
 *  - les trois sections titrées existent et chaque entrée porte son libellé ET
 *    son explication (demande utilisateur : « pour être sûr que je me trompe
 *    pas ») ;
 *  - le menu s'ouvre VERS LE HAUT quand il n'y a pas la place en dessous (dernier
 *    message, petit écran) et reste DANS la fenêtre ;
 *  - le module n'utilise pas `innerHTML` (CSP stricte).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MENU_MARGIN_PX,
  REACTIONS,
  REACTION_GROUPS,
  menuPlacement,
  reactionById,
  reactionEmoji,
  reactionName,
} from "../../public/ui/reactions.js";
import {
  REACTIONS as SERVER_REACTIONS,
  REACTION_GROUPS as SERVER_GROUPS,
} from "../../src/reactions/types.js";

const UI_DIR = join(process.cwd(), "public", "ui");

function readUi(name: string): string {
  return readFileSync(join(UI_DIR, name), "utf8");
}

describe("catalogue — miroir EXACT du serveur", () => {
  it("mêmes groupes, titres et sens, dans le même ordre", () => {
    expect(REACTION_GROUPS.map((group) => group.id)).toEqual(
      SERVER_GROUPS.map((group) => group.id),
    );
    expect(REACTION_GROUPS.map((group) => group.title)).toEqual(
      SERVER_GROUPS.map((group) => group.title),
    );
    expect(REACTION_GROUPS.map((group) => group.meaning)).toEqual(
      SERVER_GROUPS.map((group) => group.meaning),
    );
  });

  it("mêmes réactions (identifiant, registre, pictogramme, libellé, explication)", () => {
    expect(
      REACTIONS.map((item) => ({
        id: item.id,
        group: item.group,
        emoji: item.emoji,
        label: item.label,
        hint: item.hint,
      })),
    ).toEqual(
      SERVER_REACTIONS.map((item) => ({
        id: item.id,
        group: item.group,
        emoji: item.emoji,
        label: item.label,
        hint: item.hint,
      })),
    );
  });

  it("trois sections titrées, chacune avec ses réactions", () => {
    expect(REACTION_GROUPS).toHaveLength(3);
    for (const group of REACTION_GROUPS) {
      const items = REACTIONS.filter((item) => item.group === group.id);
      expect(items.length).toBeGreaterThanOrEqual(4);
      for (const item of items) {
        expect(item.label.length).toBeGreaterThan(0);
        expect(item.hint.length).toBeGreaterThan(0);
      }
    }
  });

  it("résout une réaction par identifiant (pictogramme + nom accessible)", () => {
    expect(reactionById("trop-long")?.label).toBe("Trop long");
    expect(reactionEmoji("trop-long")).toBe("🐢");
    expect(reactionName("fatigue")).toBe("😴 Fatigué");
    // Une réaction inconnue ne casse rien (état vide, pas de pictogramme).
    expect(reactionById("inconnue")).toBeUndefined();
    expect(reactionEmoji("inconnue")).toBe("");
    expect(reactionEmoji(null)).toBe("");
  });
});

describe("placement du menu — jamais hors de l'écran", () => {
  const viewport = { width: 1280, height: 800 };
  const size = { width: 272, height: 320 };

  it("s'ouvre SOUS le bouton quand il y a la place", () => {
    const placement = menuPlacement(
      { left: 900, right: 926, top: 100, bottom: 124 },
      size,
      viewport,
    );
    expect(placement.flippedUp).toBe(false);
    expect(placement.top).toBe(128);
  });

  it("s'ouvre VERS LE HAUT sur le DERNIER message (pas la place en dessous)", () => {
    const placement = menuPlacement(
      // Bouton collé au bas de la fenêtre.
      { left: 900, right: 926, top: 770, bottom: 794 },
      size,
      viewport,
    );
    expect(placement.flippedUp).toBe(true);
    expect(placement.top).toBe(770 - size.height - 4);
    expect(placement.top).toBeGreaterThanOrEqual(MENU_MARGIN_PX);
  });

  it("reste DANS la fenêtre sur un petit écran (menu plus haut que la place)", () => {
    const small = { width: 360, height: 420 };
    const tall = { width: 272, height: 380 };
    const placement = menuPlacement(
      { left: 330, right: 352, top: 380, bottom: 402 },
      tall,
      small,
    );
    expect(placement.top).toBeGreaterThanOrEqual(MENU_MARGIN_PX);
    expect(placement.top + tall.height).toBeLessThanOrEqual(small.height);
    expect(placement.left).toBeGreaterThanOrEqual(MENU_MARGIN_PX);
    expect(placement.left + tall.width).toBeLessThanOrEqual(small.width);
  });

  it("aligne le bord DROIT du menu sur celui du bouton (bouton en bas à droite)", () => {
    const placement = menuPlacement(
      { left: 900, right: 926, top: 100, bottom: 124 },
      size,
      viewport,
    );
    expect(placement.left).toBe(926 - size.width);
  });

  it("ne sort jamais par la gauche (message étroit)", () => {
    const placement = menuPlacement(
      { left: 10, right: 20, top: 100, bottom: 124 },
      size,
      viewport,
    );
    expect(placement.left).toBe(MENU_MARGIN_PX);
  });
});

describe("interface — invariants CSP et accessibilité", () => {
  const source = readUi("reactions.js");

  it("n'injecte JAMAIS de balisage (DOM programmatique uniquement)", () => {
    // Le mot apparaît dans le commentaire d'en-tête (« aucun innerHTML ») : on
    // cherche donc un USAGE, pas une mention.
    expect(source).not.toMatch(/\.(inner|outer)HTML\s*=/);
    expect(source).not.toMatch(/insertAdjacentHTML\s*\(/);
    expect(source).not.toMatch(/document\.write\s*\(/);
  });

  it("le bouton est un vrai bouton, nommé, avec l'état du menu", () => {
    expect(source).toContain('aria-haspopup');
    expect(source).toContain('aria-expanded');
    expect(source).toContain('aria-label');
    // Le libellé d'un bouton ne doit jamais entrer dans une sélection.
    expect(readUi("styles.css")).toMatch(/\.message__react-btn\s*\{[^}]*user-select:\s*none/s);
  });

  it("le menu est FLOTTANT (il ne pousse rien et ne peut pas être rogné)", () => {
    const css = readUi("styles.css");
    expect(css).toMatch(/\.ctx-menu\s*\{[^}]*position:\s*fixed/s);
    // Sur un écran trop petit, le menu DÉFILE au lieu d'être coupé.
    expect(css).toMatch(/\.ctx-menu--reactions\s*\{[^}]*max-height:/s);
    expect(css).toMatch(/\.ctx-menu--reactions\s*\{[^}]*overflow-y:\s*auto/s);
  });

  it("le bouton est révélé au survol et TOUJOURS visible au toucher", () => {
    const css = readUi("styles.css");
    expect(css).toMatch(/\.message--assistant:hover \.message__react-btn/);
    expect(css).toMatch(/@media \(hover: none\)\s*\{[\s\S]{0,120}\.message__react-btn/);
    // Une réaction posée reste affichée sans survol.
    expect(css).toMatch(/\.message__react-btn--set\s*\{[^}]*opacity:\s*1/s);
  });

  it("le bouton n'est monté QUE sur un message assistant et une fois persisté", () => {
    const app = readUi("app.js");
    // Rendu depuis le transcript : uniquement dans la branche assistant.
    expect(app).toMatch(/appendAssistantMessage\(entry\.text[\s\S]{0,400}reactionControl\.attach/);
    // En flux : l'identifiant arrive avec `run_finished` (message persisté).
    expect(app).toMatch(/frame\.entryId[\s\S]{0,120}reactionControl\.attach/);
    // Une trame `reaction` est traitée AVANT le curseur `seq` (contrôle).
    expect(app).toMatch(/type === "reaction"[\s\S]{0,400}reactionControl\.apply/);
  });
});
