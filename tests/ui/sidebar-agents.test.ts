/**
 * Encart « agents » de la barre latérale — logique PURE + garde-fous STATIQUES
 * de la source (rendu DOM, aucune `innerHTML`, aucun `style=`, CSP).
 *
 * Le comportement DOM/interactif (affichage 0/1/plusieurs, bascule on/off en
 * rail) est couvert en E2E (Chromium headless + CDP), pas ici.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  agentInitial,
  agentLabel,
  agentLevelLabel,
  isAgentEnabled,
  LEVEL_MENU_ITEMS,
} from "../../public/ui/sidebar-agents.js";

describe("libellé d'agent — jamais vide", () => {
  it("privilégie le nom, replie sur l'identifiant", () => {
    expect(agentLabel({ agentId: "a1", name: "nuc00" })).toBe("nuc00");
    expect(agentLabel({ agentId: "a1", name: "  " })).toBe("a1");
    expect(agentLabel({ agentId: "a1" })).toBe("a1");
    expect(agentLabel({})).toBe("agent");
  });

  it("dérive une initiale, jamais vide", () => {
    expect(agentInitial({ agentId: "a1", name: "nuc00" })).toBe("N");
    expect(agentInitial({ agentId: "z9" })).toBe("Z");
    expect(agentInitial({})).toBe("A"); // repli « agent »
  });
});

describe("on/off — état lu depuis le NIVEAU (aucun second drapeau)", () => {
  it("actif pour tout niveau sauf `disabled`", () => {
    expect(isAgentEnabled({ level: "disabled" })).toBe(false);
    expect(isAgentEnabled({ level: "always" })).toBe(true);
    expect(isAgentEnabled({ level: "destructive" })).toBe(true);
    expect(isAgentEnabled({ level: "never" })).toBe(true);
  });

  it("libellés courts de niveau", () => {
    expect(agentLevelLabel("disabled")).toBe("désactivé");
    expect(agentLevelLabel("always")).toBe("valide tout");
    expect(agentLevelLabel("destructive")).toBe("valide le destructif");
    expect(agentLevelLabel("never")).toBe("sans validation");
    expect(agentLevelLabel("bogus")).toBe("bogus");
  });
});

describe("menu contextuel — les 4 niveaux (D118), libellés explicites", () => {
  it("expose exactement les 4 niveaux, dans l'ordre, en français", () => {
    expect(LEVEL_MENU_ITEMS.map((item) => item.level)).toEqual([
      "disabled",
      "always",
      "destructive",
      "never",
    ]);
    expect(LEVEL_MENU_ITEMS.map((item) => item.label)).toEqual([
      "Désactivé",
      "Validation à chaque commande",
      "Validation des commandes destructrices",
      "Pas de validation",
    ]);
  });
});

describe("garde-fous statiques de sidebar-agents.js (CSP, sémantique)", () => {
  const source = readFileSync(join(process.cwd(), "public", "ui", "sidebar-agents.js"), "utf8");

  it("construit le DOM sans injection HTML directe ni style en ligne", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("style=");
    expect(source).toContain("createElement");
  });

  it("expose un bouton on/off accessible (role switch, aria-checked)", () => {
    expect(source).toContain('role: "switch"');
    expect(source).toContain('"aria-checked"');
    expect(source).toContain("onToggle");
  });

  it("masque les agents révoqués et affiche un message honnête quand la liste est vide", () => {
    expect(source).toContain("agent.revoked");
    expect(source).toContain('"Aucun agent appairé."');
  });

  it("câble le clic droit (contextmenu) vers le menu de niveau, accessible au clavier", () => {
    expect(source).toContain('"contextmenu"');
    expect(source).toContain("onSetLevel");
    // Sémantique « menu radio » : le niveau courant est marqué `aria-checked`.
    expect(source).toContain('role: "menuitemradio"');
    // Accessibilité clavier (touche Menu contextuel / Maj+F10), comme les conversations.
    expect(source).toContain("ContextMenu");
    expect(source).toContain("F10");
    // Position au CURSEUR via le CSSOM (aucun `style=` dans le markup).
    expect(source).toContain("clientX");
    expect(source).toContain("clientY");
    expect(source).toContain("menu.style.left");
  });
});
