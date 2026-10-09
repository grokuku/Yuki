/**
 * Panneau « Agents » de /config — garde-fous STATIQUES de la source.
 *
 * Vérifie le CORRECTIF d'affichage (agents révoqués isolés) et la suppression
 * DÉFINITIVE (route `/remove`, confirmation HolafModal explicite, jamais
 * `window.confirm`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "public", "ui", "agents-panel.js"), "utf8");

describe("agents-panel.js — correctif d'affichage des révoqués", () => {
  it("sépare les agents actifs des révoqués (section distincte)", () => {
    expect(source).toContain("filter((agent) => !agent.revoked)");
    expect(source).toContain("filter((agent) => agent.revoked)");
    expect(source).toContain("Agents révoqués");
    expect(source).toContain("agent-card--revoked");
  });

  it("n'affiche plus un révoqué comme un actif configurable", () => {
    // Le bloc révoqué retourne AVANT les champs de configuration.
    expect(source).toContain("if (agent.revoked) {");
  });
});

describe("agents-panel.js — suppression définitive", () => {
  it("appelle la route POST /remove (jamais une simple révocation)", () => {
    expect(source).toContain("/remove`");
    expect(source).toContain("HolafFetch.post");
  });

  it("confirme via HolafModal, avec un texte explicite (irréversible + ré-appairage)", () => {
    expect(source).not.toContain("window.confirm(");
    expect(source).toContain("HolafModal.confirm");
    expect(source).toContain("Supprimer définitivement");
    expect(source).toContain("IRRÉVERSIBLE");
    expect(source).toContain("RÉ-APPARIÉ");
  });

  it("garde la révocation comme action RÉVERSIBLE distincte", () => {
    expect(source).toContain('text: "Révoquer"');
    expect(source).toContain('text: "Restaurer"');
    expect(source).toContain("HolafFetch.delete");
  });

  it("construit le DOM sans injection HTML directe", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).toContain("createElement");
  });
});
