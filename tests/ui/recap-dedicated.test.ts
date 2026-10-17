/**
 * « Continuer dans une conversation dédiée » — logique PURE du module UI et
 * garde-fous STATIQUES de la source (CSP, HolafModal, déclencheur présent).
 *
 * Le rendu/interaction RÉELS sont prouvés en E2E (Chromium headless + CDP,
 * `_tools/e2e-recap.mjs`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  isRecapFrame,
  recapProgressLabel,
  RECAP_TRIGGER_LABEL,
  validatePreview,
} from "../../public/ui/recap-dedicated.js";

const read = (...segments: string[]): string =>
  readFileSync(join(process.cwd(), ...segments), "utf8");

describe("isRecapFrame — corrélation par requestId", () => {
  it("ne retient QUE la requête en attente", () => {
    const pending = { requestId: "R1", phase: "preview" };
    expect(isRecapFrame({ type: "recap_ready", requestId: "R1" }, pending)).toBe(true);
    expect(isRecapFrame({ type: "recap_progress", requestId: "R1" }, pending)).toBe(true);
    expect(isRecapFrame({ type: "error", requestId: "R1" }, pending)).toBe(true);
    expect(isRecapFrame({ type: "recap_ready", requestId: "R2" }, pending)).toBe(false);
  });

  it("sans requête en attente ou sans requestId : jamais", () => {
    expect(isRecapFrame({ type: "recap_ready", requestId: "R1" }, null)).toBe(false);
    expect(isRecapFrame({ type: "recap_ready" }, { requestId: "R1", phase: "preview" })).toBe(false);
    expect(isRecapFrame(null, { requestId: "R1", phase: "preview" })).toBe(false);
  });
});

describe("recapProgressLabel — attente VISIBLE d'une conversation volumineuse", () => {
  it("annonce la partie en cours et le nombre d'appels", () => {
    const label = recapProgressLabel(2, 5);
    expect(label).toContain("2/5");
    expect(label).toContain("plusieurs minutes");
  });

  it("tolère des valeurs absentes (jamais de NaN affiché)", () => {
    expect(recapProgressLabel(undefined, undefined)).not.toContain("NaN");
  });
});

describe("validatePreview — garde-fou de l'aperçu", () => {
  it("refuse un titre ou un récapitulatif vide (rien n'est créé)", () => {
    expect(validatePreview("   ", "corps").ok).toBe(false);
    expect(validatePreview("titre", "   ").ok).toBe(false);
  });

  it("normalise le titre et conserve le corps", () => {
    const result = validatePreview("  Mon   titre \n", "  corps  ");
    expect(result).toEqual({ ok: true, title: "Mon titre", recap: "corps" });
  });
});

describe("garde-fous statiques de la source", () => {
  const module = read("public", "ui", "recap-dedicated.js");
  const html = read("public", "ui", "index.html");
  const css = read("public", "ui", "styles.css");
  const app = read("public", "ui", "app.js");

  it("aucune injection HTML et aucun window.confirm (CSP stricte)", () => {
    // On teste l'USAGE (affectation), pas les commentaires qui les documentent.
    expect(module).not.toMatch(/\.innerHTML\s*=/);
    expect(module).not.toMatch(/window\.confirm\(/);
    expect(module).not.toMatch(/(?<!\w)confirm\(/);
    // Le corps du récapitulatif est posé par `value`/`textContent`, jamais en HTML.
    expect(module).toContain("body.value =");
  });

  it("le déclencheur est présent dans le markup et porte un libellé accessible", () => {
    expect(html).toContain('id="recap-dedicated"');
    expect(html).toContain(RECAP_TRIGGER_LABEL);
  });

  it("le bloc `recap` et l'aperçu ont un style dédié (thème, pas de px de couleur en dur)", () => {
    expect(css).toContain(".message--recap");
    expect(css).toContain(".recap-block__label");
    expect(css).toContain(".recap-modal__body");
  });

  it("app.js câble le module et lui confie ses trames AVANT le traitement générique", () => {
    expect(app).toContain("createRecapDedicated");
    const guarded = app.indexOf("recapDedicated.handleFrame(frame)");
    const generic = app.indexOf('if (type === "welcome")');
    expect(guarded).toBeGreaterThan(-1);
    expect(generic).toBeGreaterThan(guarded);
  });

  it("la PROGRESSION d'un fil découpé met à jour l'écran d'attente existant", () => {
    // On réutilise le mécanisme d'attente (`busy.set`), sans 2ᵉ système.
    expect(module).toContain('frame.type === "recap_progress"');
    expect(module).toContain("busy.set(");
    expect(module).toContain("recapProgressLabel");
  });

  it("le rendu du transcript reconnaît le rôle `recap`", () => {
    expect(app).toContain('entry.role === "recap"');
    expect(app).toContain("appendRecapBlock");
  });
});
