/**
 * E3 — Bloc d'ACTIVITÉ d'un sous-agent : logique PURE (`activity.js`) et
 * garde-fous STATIQUES de la source (`subagent-activity.js`, `app.js`).
 *
 * Le comportement INTERACTIF (apparition DANS le fil, replié par défaut,
 * dépliage au clic, silence TTS, éphémérité) est prouvé en E2E
 * (`_tools/e2e-activity.mjs`, Chromium headless + CDP).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SUBAGENT_ACTIVITY_LABEL,
  subagentStepView,
  subagentToggleLabel,
} from "../../public/ui/activity.js";

const readUi = (name: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", name), "utf8");

describe("subagentStepView — étape d'activité → ligne lisible (français)", () => {
  it("tâche lancée : tâche rendue, sinon libellé générique", () => {
    expect(subagentStepView("job_started", { task: "analyse" }).label).toBe(
      "Tâche lancée : « analyse »",
    );
    expect(subagentStepView("job_started", {}).label).toBe("Tâche lancée");
  });

  it("première réponse et progression", () => {
    expect(subagentStepView("job_first_token", {}).label).toBe("Première réponse reçue");
    expect(subagentStepView("job_progress", { detail: "étape 2/3" }).label).toBe(
      "Progression : étape 2/3",
    );
    expect(subagentStepView("job_progress", {}).label).toBe("Progression");
  });

  it("termine : réutilise le libellé de statut (jamais un faux succès)", () => {
    expect(subagentStepView("job_finished", { status: "completed" })).toMatchObject({
      label: "Terminée — terminée (succès)",
      tone: "ok",
    });
    expect(subagentStepView("job_finished", { status: "failed" }).tone).toBe("error");
    expect(subagentStepView("job_finished", { status: "mystère" }).tone).toBe("muted");
  });

  it("étape inconnue : neutre, jamais un succès", () => {
    const view = subagentStepView("peut-être");
    expect(view.key).toBe("unknown");
    expect(view.tone).toBe("muted");
  });

  it("steer : consigne de l'orchestrateur rendue (cadrage explicite)", () => {
    const view = subagentStepView("steer", { detail: "priorise le paiement" });
    expect(view.key).toBe("steer");
    expect(view.label).toBe(
      "Consigne de l'orchestrateur envoyée : priorise le paiement",
    );
    expect(view.tone).toBe("active");
    expect(subagentStepView("steer", {}).label).toBe(
      "Consigne de l'orchestrateur envoyée",
    );
  });
});

describe("subagentToggleLabel — libellé accessible du bouton", () => {
  it("accorde le nombre d'étapes et l'action", () => {
    expect(subagentToggleLabel(0, false)).toBe(
      `${SUBAGENT_ACTIVITY_LABEL} — 0 étapes — déplier`,
    );
    expect(subagentToggleLabel(1, false)).toBe(
      `${SUBAGENT_ACTIVITY_LABEL} — 1 étape — déplier`,
    );
    expect(subagentToggleLabel(3, true)).toBe(
      `${SUBAGENT_ACTIVITY_LABEL} — 3 étapes — replier`,
    );
  });
});

describe("garde-fous STATIQUES de subagent-activity.js (CSP + accessibilité)", () => {
  const source = readUi("subagent-activity.js");

  it("construit le DOM sans injection HTML ni style en ligne (CSP stricte)", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("style=");
    expect(source).toContain("createElement");
  });

  it("repli = VRAI bouton avec `aria-expanded`, replié par défaut", () => {
    expect(source).toContain('type: "button"');
    expect(source).toContain('"aria-expanded": "false"');
    expect(source).toContain("setExpanded(record, false)");
  });
});

describe("garde-fous STATIQUES de app.js (E3 — contrôle éphémère, jamais TTS)", () => {
  const app = readUi("app.js");

  it("traite `job_activity` AVANT le curseur `seq` (trame de contrôle)", () => {
    expect(app).toMatch(/type === "job_activity"[\s\S]{0,400}subagentActivity\.apply\(frame\)/);
  });

  it("ne dessine PAS le bloc d'un fil NON focalisé (aucun mélange de fils)", () => {
    expect(app).toMatch(
      /type === "job_activity"[\s\S]{0,300}activityTarget !== sessionId\) return;/,
    );
  });

  it("purge les blocs au snapshot/rejeu/reconnexion (éphémérité)", () => {
    expect(app).toContain("subagentActivity.reset()");
  });
});
