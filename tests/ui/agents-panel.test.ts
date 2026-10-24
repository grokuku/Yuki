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

describe("agents-panel.js — verrou « matériel sensible »", () => {
  it("case à cocher par agent, envoyée côté serveur (jamais un état local)", () => {
    expect(source).toContain("agent-sensitive__input");
    expect(source).toContain('text: "Matériel sensible"');
    expect(source).toContain("{ sensitive: wanted }");
  });

  it("une case refusée est REMISE à l'état RÉEL du serveur (jamais une case qui ment)", () => {
    expect(source).toContain("input.checked = agent.sensitive === true");
  });

  it("déverrouillage par HolafModal avec mot de passe, jamais window.prompt", () => {
    expect(source).toContain("unlockAgentWithPassword");
    expect(source).not.toContain("window.prompt(");
    expect(source).not.toContain("window.confirm(");
  });

  it("affiche l'état VERROUILLÉ/DÉVERROUILLÉ et le temps restant", () => {
    expect(source).toContain('text: locked ? "Verrouillé" : "Déverrouillé"');
    expect(source).toContain("Reverrouillage automatique dans");
    expect(source).toContain("/lock`");
  });
});

describe("password-modal.js — saisie masquée, HolafModal uniquement", () => {
  const modal = readFileSync(
    join(process.cwd(), "public", "ui", "password-modal.js"),
    "utf8",
  );

  it("champ `type=password` (jamais un champ texte qui afficherait le secret)", () => {
    expect(modal).toContain('input.type = "password"');
  });

  it("modale de la brique, aucun prompt natif, aucune injection HTML", () => {
    expect(modal).toContain("HolafModal.open");
    expect(modal).not.toContain("window.prompt(");
    expect(modal).not.toContain("window.confirm(");
    // Le mot « innerHTML » n'apparaît que dans le commentaire d'en-tête : ce qui
    // compte est qu'il ne soit jamais AFFECTÉ.
    expect(modal).not.toMatch(/\.innerHTML\s*=/);
    expect(modal).not.toContain("localStorage");
  });
});
