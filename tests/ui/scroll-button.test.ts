/**
 * Bouton « revenir en bas de la conversation » — logique PURE et garde-fous
 * STATIQUES de la source.
 *
 * ⚠️ Le bouton ne possède AUCUN système de défilement : la décision de
 * visibilité est PURE (`shouldShowScrollButton`, hystérésis anti-clignotement),
 * et le clic appelle le mécanisme existant (`goToEnd`/`pinIfNeeded`).
 *
 * Le rendu/interaction RÉELS (mesures de `scrollTop`, rectangles, absence de
 * clignotement pendant un flux) sont prouvés en E2E (Chromium headless + CDP,
 * `_tools/e2e-scroll-button.mjs`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SCROLL_BOTTOM_LABEL,
  SCROLL_BUTTON_SHOW_PX,
  rectsIntersect,
  shouldShowScrollButton,
} from "../../public/ui/scroll-button.js";

const read = (...segments: string[]): string =>
  readFileSync(join(process.cwd(), ...segments), "utf8");

describe("shouldShowScrollButton — hystérésis anti-clignotement", () => {
  it("en bas (distance ≤ seuil d'épinglage) ⇒ JAMAIS visible", () => {
    expect(shouldShowScrollButton(false, 0, true)).toBe(false);
    expect(shouldShowScrollButton(true, 0, true)).toBe(false);
    // Distance inférieure au seuil d'apparition mais fil épinglé ⇒ masqué.
    expect(shouldShowScrollButton(false, 5, true)).toBe(false);
  });

  it("masqué : ne se révèle qu'AU-DELÀ du seuil d'apparition (pas dès 5 px)", () => {
    expect(shouldShowScrollButton(false, SCROLL_BUTTON_SHOW_PX, false)).toBe(false);
    expect(shouldShowScrollButton(false, SCROLL_BUTTON_SHOW_PX + 1, false)).toBe(true);
    expect(shouldShowScrollButton(false, 5, false)).toBe(false);
  });

  it("visible : reste affiché jusqu'au RÉ-ÉPINGLAGE (hystérésis, pas de clignotement)", () => {
    // Entre le seuil d'apparition (80) et d'épinglage (24), l'état est CONSERVÉ :
    // une oscillation autour d'un seul seuil ferait clignoter le bouton.
    expect(shouldShowScrollButton(true, SCROLL_BUTTON_SHOW_PX - 1, false)).toBe(true);
    expect(shouldShowScrollButton(true, 30, false)).toBe(true);
    // Ré-épinglé (distance ≤ seuil) ⇒ masqué.
    expect(shouldShowScrollButton(true, 0, true)).toBe(false);
  });

  it("le seuil d'apparition est NETTEMENT plus grand que 5 px", () => {
    expect(SCROLL_BUTTON_SHOW_PX).toBeGreaterThanOrEqual(64);
  });
});

describe("rectsIntersect", () => {
  const a = { left: 0, top: 0, right: 100, bottom: 100 };
  it("recouvrement franc ⇒ true", () => {
    expect(rectsIntersect(a, { left: 50, top: 50, right: 150, bottom: 150 })).toBe(true);
  });
  it("bords qui se touchent SANS empiéter ⇒ false", () => {
    expect(rectsIntersect(a, { left: 100, top: 0, right: 200, bottom: 100 })).toBe(false);
    expect(rectsIntersect(a, { left: 0, top: 100, right: 100, bottom: 200 })).toBe(false);
  });
  it("rectangles disjoints ⇒ false", () => {
    expect(rectsIntersect(a, { left: 300, top: 300, right: 400, bottom: 400 })).toBe(false);
  });
});

describe("garde-fous STATIQUES de scroll-button.js (CSP + réutilisation)", () => {
  const source = read("public", "ui", "scroll-button.js");

  it("construit le DOM sans injection HTML ni style en ligne (CSP stricte)", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("style=");
    expect(source).toContain('doc.createElement("button")');
    // Positionnement par CSSOM, jamais un attribut de style littéral.
    expect(source).toContain("button.style.left");
    expect(source).toContain("button.style.top");
  });

  it("libellé FRANÇAIS explicite porté par `aria-label` ET `title`", () => {
    expect(source).toContain('button.setAttribute("aria-label", SCROLL_BOTTOM_LABEL)');
    expect(source).toContain("button.title = SCROLL_BOTTOM_LABEL");
    expect(SCROLL_BOTTOM_LABEL).toBe("Revenir en bas de la conversation");
  });

  it("N'ÉCRIT JAMAIS `scrollTop` : le défilement reste celui de l'app", () => {
    expect(source).not.toMatch(/scrollTop\s*=/);
    // Le clic délègue via `onActivate` (aucun `scrollTo` non plus ici).
    expect(source).toContain("onActivate()");
  });

  it("évite la fenêtre de validation flottante (obstacle mesuré, z-index dessous)", () => {
    expect(source).toContain(".approval-window");
    expect(source).toContain("rectsIntersect");
    const css = read("public", "ui", "styles.css");
    // z-index du bouton STRICTEMENT sous celui de la couche de validation.
    expect(css).toMatch(/\.scroll-bottom\s*\{[^}]*z-index:\s*900/s);
    expect(css).toMatch(/\.approval-window\s*\{[^}]*z-index:\s*1201/s);
  });
});

describe("garde-fous STATIQUES de app.js (réutilisation du défilement existant)", () => {
  const app = read("public", "ui", "app.js");

  it("la visibilité du bouton est rafraîchie dans `pinIfNeeded` (chemin unique)", () => {
    expect(app).toMatch(/function pinIfNeeded\(pinned\)[\s\S]{0,600}scrollButton\.refresh\(\)/);
  });

  it("le clic réutilise `goToEnd` (fluide) et non un second défilement", () => {
    expect(app).toMatch(/onActivate:\s*goToEnd/);
    expect(app).toMatch(/function goToEnd\(\)[\s\S]{0,400}scrollConversationToEnd\(\)/);
    expect(app).toMatch(/el\.scrollTo\(\{\s*top:\s*el\.scrollHeight,\s*behavior:\s*"smooth"\s*\}\)/);
  });

  it("le bouton est câblé sur l'épinglage EXISTANT (`isConversationPinned`)", () => {
    expect(app).toMatch(/createScrollToBottom\(\{[\s\S]{0,300}isPinned:\s*isConversationPinned/);
  });
});
