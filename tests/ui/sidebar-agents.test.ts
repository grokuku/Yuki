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
  agentConnectionLabel,
  agentInitial,
  agentLabel,
  agentLevelLabel,
  isAgentConnected,
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

describe("pastille = CONNEXION, découplée de l'activation", () => {
  it("l'état de connexion dépend UNIQUEMENT de `online`, jamais du niveau", () => {
    // Désactivé MAIS connecté ⇒ connecté (la pastille parle de connexion).
    expect(isAgentConnected({ level: "disabled", online: true })).toBe(true);
    // Actif MAIS déconnecté ⇒ déconnecté.
    expect(isAgentConnected({ level: "never", online: false })).toBe(false);
    // Absent (jamais connecté) ⇒ déconnecté par défaut.
    expect(isAgentConnected({ level: "destructive" })).toBe(false);
    expect(isAgentConnected({ online: false })).toBe(false);
    expect(isAgentConnected(undefined)).toBe(false);
  });

  it("l'activation reste indépendante de la connexion", () => {
    expect(isAgentEnabled({ level: "never", online: false })).toBe(true);
    expect(isAgentEnabled({ level: "disabled", online: true })).toBe(false);
  });

  it("libellé EXPLICITE de connexion (accessibilité)", () => {
    expect(agentConnectionLabel({ online: true })).toBe("Connecté");
    expect(agentConnectionLabel({ online: false })).toBe("Déconnecté");
    expect(agentConnectionLabel({ level: "disabled", online: true })).toBe("Connecté");
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

  it("affiche la CONSÉQUENCE réelle de chaque niveau (sans ouvrir /config)", () => {
    const hint = (level: string) =>
      LEVEL_MENU_ITEMS.find((item) => item.level === level)?.hint ?? "";
    // ⚠️ « Désactivé » = commandes REFUSÉES (pas seulement « inactif »).
    expect(hint("disabled")).toMatch(/REFUS/i);
    expect(hint("disabled")).toMatch(/exécuter/i);
    // ⚠️ « Pas de validation » = AUCUNE validation : la nuance est explicite.
    expect(hint("never")).toMatch(/Aucune validation/i);
    expect(hint("never")).toMatch(/directement/i);
    // Les deux niveaux de validation disent bien ce qui est validé.
    expect(hint("always")).toMatch(/Chaque commande/i);
    expect(hint("destructive")).toMatch(/destructrices/i);
    // Chaque niveau porte une phrase non vide (jamais de promesse muette).
    for (const item of LEVEL_MENU_ITEMS) {
      expect(typeof item.hint).toBe("string");
      expect((item.hint ?? "").length).toBeGreaterThan(20);
    }
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

  it("la pastille porte un libellé de connexion explicite (pas la couleur seule)", () => {
    // ⚠️ Vert/rouge seuls = inaccessible (daltonisme) : le libellé est OBLIGATOIRE.
    expect(source).toContain('"Connecté"');
    expect(source).toContain('"Déconnecté"');
    // Le témoin expose ce libellé (title/aria-label), il n'est plus décoratif.
    expect(source).toContain('class: "side-agent__dot"');
    expect(source).toContain('role: "img"');
    expect(source).toContain('"aria-label": connectionLabel');
    // La pastille est pilotée par la CONNEXION, jamais par l'activation.
    expect(source).toContain("data-online");
    expect(source).not.toContain('if (agent.online) badge.setAttribute("data-online"');
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

  it("rend la conséquence de chaque niveau (nœud texte, jamais d'injection)", () => {
    // Le hint est posé en `textContent` sur un nœud créé, comme le libellé.
    expect(source).toContain("ctx-menu__hint");
    expect(source).toContain("ctx-menu__col");
  });

  it("ne referme pas le menu sur un défilement ÉTRANGER au panneau", () => {
    // ⚠️ Régression : un closer de défilement GLOBAL (`window`) se déclenchait
    // sur le défilement du FIL de discussion — qui défile en CONTINU pendant
    // une réponse — et refermait le menu aussitôt ouvert. Le closer doit être
    // SCOPÉ à la barre latérale (parité avec le menu des conversations).
    expect(source).not.toContain('window.addEventListener("scroll", closeMenu, true)');
    expect(source).toContain('closest(".sidebar")');
  });
});

describe("pastille d'agent : la CSS la lie à la CONNEXION, plus à l'activation", () => {
  const css = readFileSync(join(process.cwd(), "public", "ui", "styles.css"), "utf8");

  it("vert piloté par `data-online`, et NON par `data-enabled`", () => {
    expect(css).toContain('.side-agent__badge[data-online="true"] .side-agent__dot');
    // ⚠️ Plus AUCUN lien entre la pastille et l'état activé/désactivé.
    expect(css).not.toContain('.side-agent__badge[data-enabled="true"] .side-agent__dot');
  });

  it("déconnecté = rouge par défaut (variante de thème, aucune couleur en dur)", () => {
    const dotBlock = css.slice(css.indexOf(".side-agent__dot {"));
    const end = dotBlock.indexOf("}");
    const rule = dotBlock.slice(0, end);
    expect(rule).toContain("background: var(--danger)");
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,6}/); // aucune couleur en dur
  });
});
