/**
 * E2 — transport multiplexé : garde-fous STATIQUES de l'UI.
 *
 * La logique de routage par `sessionId` vit dans `public/ui/app.js`, qui
 * s'exécute au chargement (pas importable hors navigateur) ; les INTERACTIONS
 * réelles sont prouvées en E2E (`_tools/e2e-multiplex.mjs`, Chromium headless).
 * Ici on verrouille les INVARIANTS de source : routage par conversation,
 * indicateur « en cours », étiquette de fil dans la fenêtre de validation, et
 * CSP (aucun `innerHTML`).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (...parts: string[]): string =>
  readFileSync(join(process.cwd(), "public", "ui", ...parts), "utf8");

describe("app.js — routage PAR CONVERSATION (aucun mélange de fils)", () => {
  const app = read("app.js");

  it("maintient un STORE par conversation, alimenté par le `sessionId` des trames", () => {
    expect(app).toContain("storeBySession");
    expect(app).toContain("function storeOf(");
    expect(app).toContain("function applyBackgroundEvent(");
    // Une trame d'un fil NON focalisé est routée vers son store et n'atteint
    // JAMAIS le rendu DOM de la conversation affichée.
    expect(app).toMatch(/target !== sessionId/);
    expect(app).toMatch(/applyBackgroundEvent\(target, frame\);[\s\S]{0,40}return;/);
  });

  it("garde le curseur `seq` STRICT pour le seul fil focalisé", () => {
    // Le contrôle `frame.seq !== lastSeq + 1` (et le `resume`) ne s'applique
    // qu'après avoir exclu les autres fils.
    expect(app).toMatch(/frame\.seq !== lastSeq \+ 1/);
    expect(app).toMatch(/requestResume\(\)/);
  });

  it("n'ouvre la voix QUE pour le fil focalisé (défense en profondeur)", () => {
    expect(app).toMatch(
      /decoded\.header\.sessionId !== sessionId\) return;|decoded\.header\.sessionId && decoded\.header\.sessionId !== sessionId/,
    );
  });

  it("étiquette une demande de validation par le titre de sa conversation", () => {
    expect(app).toContain("conversationLabelFor(");
    expect(app).toMatch(/approvalLayer\.show\(frame\.approval, \{/);
  });

  it("décide l'état « en cours » par conversation (indicateur de la barre)", () => {
    expect(app).toContain("function busyIdList(");
    expect(app).toContain("sessionsPanel.setBusy(");
    expect(app).toContain("runningJobs");
  });
});

describe("sessions-panel.js — indicateur « en cours » dans la LISTE", () => {
  const panel = read("sessions-panel.js");

  it("expose `setBusy` et pose un point `.conv__busy` (visible dans le rail)", () => {
    expect(panel).toContain("conv__busy");
    expect(panel).toContain("conv--busy");
    expect(panel).toContain("setBusy(");
  });

  it("met à jour l'ensemble « en cours » SANS reconstruire la liste", () => {
    // `setBusy` bascule la classe d'items EXISTANTS (pas de `render()`).
    expect(panel).toMatch(/setBusy\(ids\) \{[\s\S]*?querySelectorAll\("\.conv"\)/);
  });

  it("reste sans injection HTML (CSP stricte)", () => {
    expect(panel).not.toContain("innerHTML");
  });
});

describe("styles.css — indicateur « en cours » + étiquette de fil (variables de thème)", () => {
  const css = read("styles.css");

  it("définit le point d'activité et son animation, en variables de thème", () => {
    expect(css).toContain(".conv__busy");
    expect(css).toContain(".conv--busy .conv__busy");
    expect(css).toMatch(/@keyframes conv-busy-pulse/);
    expect(css).toMatch(/\.conv__busy \{[\s\S]*?var\(--accent\)/);
  });

  it("définit l'étiquette de conversation de la fenêtre de validation", () => {
    expect(css).toContain(".approval__conversation");
  });
});
