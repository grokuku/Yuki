/**
 * Attente & activité de fond — logique PURE de l'UI (`public/ui/activity.js`),
 * plus les garde-fous STATIQUES de la source (`app.js`).
 *
 * Le comportement INTERACTIF (indicateur observé AVANT le premier token,
 * visibilité des trames `job_*`, non-prononciation TTS) est prouvé en E2E
 * (`_tools/e2e-activity.mjs`, Chromium headless + CDP).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  THINKING_LABEL,
  describeActivity,
  formatDuration,
  jobStatusView,
} from "../../public/ui/activity.js";


/** `describeActivity` garanti NON NUL (les cas nuls sont testés à part). */
function mustActivity(jobs: Parameters<typeof describeActivity>[0], now: number) {
  const view = describeActivity(jobs, now);
  if (!view) throw new Error("activité attendue non nulle");
  return view;
}

/* ─── Libellé d'attente ─────────────────────────────────────────────────── */

describe("libellé d'attente", () => {
  it("est en français et non vide", () => {
    expect(THINKING_LABEL).toBe("Yuki réfléchit…");
  });
});

/* ─── Statut de job → libellé ──────────────────────────────────────────── */

describe("jobStatusView — statut → libellé français + tonalité", () => {
  it("mappe chaque statut terminal", () => {
    expect(jobStatusView("running").label).toBe("en cours");
    expect(jobStatusView("completed").label).toBe("terminée (succès)");
    expect(jobStatusView("failed").label).toBe("échouée");
    expect(jobStatusView("cancelled").label).toBe("annulée");
    expect(jobStatusView("interrupted").label).toBe("interrompue");
  });

  it("seul `completed` est en tonalité « ok »", () => {
    const tones = ["running", "failed", "cancelled", "interrupted", "mystère"].map(
      (status) => jobStatusView(status).tone,
    );
    expect(tones).not.toContain("ok");
    expect(jobStatusView("completed").tone).toBe("ok");
  });

  it("un statut INCONNU reste neutre (jamais présenté comme un succès)", () => {
    const view = jobStatusView("mystère");
    expect(view.key).toBe("unknown");
    expect(view.tone).toBe("muted");
    expect(view.label).not.toMatch(/succès/i);
  });
});

/* ─── Durée lisible ────────────────────────────────────────────────────── */

describe("formatDuration — durée lisible en français", () => {
  it("millisecondes, secondes, minutes", () => {
    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(200)).toBe("200 ms");
    expect(formatDuration(1500)).toBe("1,5 s");
    expect(formatDuration(28_500)).toBe("28,5 s");
    expect(formatDuration(65_000)).toBe("1 min 5 s");
  });

  it("entrée invalide → chaîne vide (jamais « NaN »)", () => {
    expect(formatDuration(undefined)).toBe("");
    expect(formatDuration(Number.NaN)).toBe("");
    expect(formatDuration(-10)).toBe("");
  });
});

/* ─── Décision d'affichage ─────────────────────────────────────────────── */

describe("describeActivity — rien à afficher quand aucun job", () => {
  it("liste vide → null (élément masqué)", () => {
    expect(describeActivity([], 1000)).toBeNull();
    expect(describeActivity(undefined, 1000)).toBeNull();
  });
});

describe("describeActivity — tâche en cours", () => {
  it("un job en cours : libellé + compteur de durée SÉPARÉ (anti-spam)", () => {
    const view = mustActivity(
      [{ status: "running", task: "analyse du dépôt", startedAt: 1000 }],
      4240,
    );
    expect(view.text).toBe("Tâche de fond « analyse du dépôt » en cours…");
    expect(view.timer).toBe(" (3,2 s)");
    expect(view.tone).toBe("active");
  });

  it("un job en cours sans tâche connue : libellé générique", () => {
    const view = mustActivity([{ status: "running", startedAt: 0 }], 500);
    expect(view.text).toBe("Tâche de fond en cours…");
    expect(view.timer).toBe(" (500 ms)");
  });

  it("plusieurs jobs en cours : compte, pas de liste", () => {
    const view = mustActivity(
      [
        { status: "running", startedAt: 1000 },
        { status: "running", startedAt: 2000 },
      ],
      3000,
    );
    expect(view.text).toBe("2 tâches de fond en cours…");
    expect(view.timer).toBe(" (2,0 s)");
  });
});

describe("describeActivity — statut terminal", () => {
  it("terminée : tâche + statut + durée DANS le libellé accessible", () => {
    const view = mustActivity(
      [{ status: "completed", task: "analyse", startedAt: 0, durationMs: 28_500 }],
      99_999,
    );
    expect(view.text).toBe("Tâche de fond « analyse » terminée (succès) — 28,5 s");
    expect(view.timer).toBe("");
    expect(view.tone).toBe("ok");
  });

  it("échec : tonalité erreur, jamais un succès", () => {
    const view = mustActivity(
      [{ status: "failed", startedAt: 0, durationMs: 1200 }],
      10_000,
    );
    expect(view.text).toBe("Tâche de fond échouée — 1,2 s");
    expect(view.tone).toBe("error");
  });

  it("le terminal le PLUS RÉCENT est affiché tant qu'aucun n'est en cours", () => {
    const view = mustActivity(
      [
        { status: "completed", startedAt: 0, durationMs: 1000 },
        { status: "interrupted", startedAt: 0, durationMs: 2000 },
      ],
      10_000,
    );
    expect(view.text).toBe("Tâche de fond interrompue — 2,0 s");
    expect(view.tone).toBe("muted");
  });
});

/* ─── Garde-fous statiques (CSP + déclenchement sur l'ÉTAT DU RUN) ─────── */

describe("garde-fous statiques de app.js", () => {
  const app = readFileSync(join(process.cwd(), "public", "ui", "app.js"), "utf8");
  const activity = readFileSync(
    join(process.cwd(), "public", "ui", "activity.js"),
    "utf8",
  );

  it("l'indicateur est montré sur `run_started` (état du run), pas sur le canal thinking", () => {
    // Le cas `run_started` appelle showThinking() et NE masque plus l'indicateur.
    expect(app).toMatch(/case "run_started":[\s\S]*?showThinking\(\)/);
    // Le canal `thinking` ne fait plus qu'AFFICHER (jamais masquer) : il est mort
    // avec le modèle léger sans raisonnement.
    expect(app).toMatch(/frame\.channel === "thinking"[\s\S]{0,40}showThinking\(\)/);
    // Le contenu masque l'attente.
    expect(app).toMatch(/Du CONTENU arrive[\s\S]{0,200}hideThinking\(\)/);
  });

  it("gère explicitement les trames de job (plus ignorées)", () => {
    expect(app).toMatch(/case "job_started":[\s\S]*?onJobStarted\(frame\)/);
    expect(app).toMatch(/case "job_finished":[\s\S]*?onJobFinished\(frame\)/);
  });

  it("construit le DOM sans innerHTML ni style en ligne (CSP stricte)", () => {
    // `activity.js` ne touche JAMAIS au DOM : il ne peut ni injecter du HTML ni
    // poser un style en ligne.
    expect(activity).not.toContain("innerHTML");
    expect(activity).not.toContain("document.");
    expect(activity).not.toMatch(/style\s*=/);
  });

  it("la page déclare les régions d'état (accessibilité) et le libellé est aligné", () => {
    const html = readFileSync(join(process.cwd(), "public", "ui", "index.html"), "utf8");
    expect(html).toMatch(/id="thinking"[^>]*role="status"[^>]*aria-live="polite"/);
    expect(html).toMatch(/id="job-activity"[^>]*role="status"[^>]*aria-live="polite"/);
    expect(html).toContain(THINKING_LABEL);
  });
});
