/**
 * Pied de stats du message assistant — logique PURE de l'UI (`public/ui/run-stats.js`),
 * plus les garde-fous STATIQUES du rendu (`app.js`, `styles.css`).
 *
 * ⚠️ Deux jeux de valeurs à NE PAS confondre :
 *   - PROVISOIRES (`liveRunMetricsText`) : rendu SEUL, jamais persistées ;
 *   - FINALES (`runMetricsText`, trame `run_summary`) : SEULES elles font foi
 *     (et SEULES elles sont écrites dans `yuki.run_metrics` côté serveur).
 * Le comportement INTERACTIF (pied présent dès le lancement, valeurs qui
 * évoluent, séparation visuelle des tours) est prouvé en E2E
 * (`_tools/e2e-live-stats.mjs`, Chromium headless + CDP).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { liveRunMetricsText, runMetricsText } from "../../public/ui/run-stats.js";

const readUi = (name: string): string =>
  readFileSync(join(process.cwd(), "public", "ui", name), "utf8");

/* ─── Valeurs FINALES (`run_summary`) ───────────────────────────────────── */

describe("runMetricsText — valeurs FINALES du run_summary", () => {
  it("sans `totalMs` exploitable : AUCUN texte (message sans pied)", () => {
    expect(runMetricsText(null)).toBeNull();
    expect(runMetricsText(undefined)).toBeNull();
    expect(runMetricsText({})).toBeNull();
    expect(runMetricsText({ ttftMs: 100, tokensOut: 5 })).toBeNull();
    expect(runMetricsText({ totalMs: "120" as unknown as number })).toBeNull();
  });

  it("total seul, puis TTFT et tokens quand ils existent", () => {
    expect(runMetricsText({ totalMs: 3120 })).toBe("total 3120 ms");
    expect(runMetricsText({ totalMs: 3120, ttftMs: 842 })).toBe(
      "TTFT 842 ms · total 3120 ms",
    );
    expect(runMetricsText({ totalMs: 2500, ttftMs: 1100, tokensOut: 210 })).toBe(
      "TTFT 1100 ms · total 2500 ms · 210 tok",
    );
  });

  it("arrondit les millisecondes (jamais de décimale affichée)", () => {
    expect(runMetricsText({ totalMs: 3120.6, ttftMs: 841.6 })).toBe(
      "TTFT 842 ms · total 3121 ms",
    );
  });
});

/* ─── Valeurs PROVISOIRES (pendant le run) ──────────────────────────────── */

describe("liveRunMetricsText — valeurs PROVISOIRES affichées en direct", () => {
  it("n'affiche QUE ce qui est connu : temps écoulé d'abord, TTFT ensuite", () => {
    // Au lancement : seul le temps écoulé est connu.
    expect(liveRunMetricsText({ elapsedMs: 120 })).toBe("total 120 ms");
    // Au premier token : le TTFT (MESURE serveur) s'ajoute EN TÊTE.
    expect(liveRunMetricsText({ elapsedMs: 820, ttftMs: 640 })).toBe(
      "TTFT 640 ms · total 820 ms",
    );
  });

  it("ne fabrique JAMAIS de valeur : inconnue ⇒ omise (jamais de « 0 tok »)", () => {
    // Aucune valeur connue : rien à afficher (pas de pied vide inventé).
    expect(liveRunMetricsText({})).toBeNull();
    expect(liveRunMetricsText()).toBeNull();
    expect(liveRunMetricsText({ elapsedMs: Number.NaN })).toBeNull();
    expect(liveRunMetricsText({ ttftMs: Number.POSITIVE_INFINITY })).toBeNull();
    // Le décompte de tokens n'est JAMAIS provisoire : il n'apparaît pas ici.
    expect(liveRunMetricsText({ elapsedMs: 500 })).not.toContain("tok");
  });

  it("ne recule jamais (valeurs négatives ramenées à zéro)", () => {
    expect(liveRunMetricsText({ elapsedMs: -40 })).toBe("total 0 ms");
    expect(liveRunMetricsText({ elapsedMs: 10, ttftMs: -5 })).toBe(
      "TTFT 0 ms · total 10 ms",
    );
  });
});

/* ─── Garde-fous STATIQUES du rendu ─────────────────────────────────────── */

describe("app.js — pied de stats EN DIRECT, jamais une région aria-live", () => {
  const app = readUi("app.js");

  it("importe la logique pure (aucune duplication du format)", () => {
    expect(app).toContain('from "./run-stats.js"');
    expect(app).toContain("runMetricsText");
    expect(app).toContain("liveRunMetricsText");
  });

  it("démarre le pied dès `run_started` et l'arrête/remplace au `run_summary`", () => {
    expect(app).toMatch(/case "run_started":[\s\S]{0,700}startLiveStats\(frame\.runId/);
    expect(app).toMatch(/case "run_summary":[\s\S]{0,700}stopLiveStats\(\)/);
    // Les valeurs FINALES REMPLACENT les provisoires.
    expect(app).toMatch(/case "run_summary":[\s\S]{0,700}setMeta\(target, text\)/);
  });

  it("lit le TTFT de la MESURE serveur (trame `phase`), jamais une valeur inventée", () => {
    expect(app).toMatch(/frame\.stage === "first_token"[\s\S]{0,120}liveStats\.ttftMs = frame\.sinceT0Ms/);
  });

  it("ne pose AUCUN `aria-live` sur le pied (valeur qui change en continu)", () => {
    // Le pied provisoire est au contraire retiré de l'arbre d'accessibilité.
    expect(app).toMatch(/function setLiveMeta[\s\S]{0,200}aria-hidden/);
    expect(app).not.toMatch(/message__footer[^\n]*aria-live/);
  });

  it("purge le pied provisoire quand le fil est reconstruit (snapshot/rejeu)", () => {
    expect(app).toMatch(/function applyTranscript[\s\S]{0,600}stopLiveStats\(\)/);
  });
});

describe("styles.css — séparation PUREMENT visuelle des tours assistant collés", () => {
  const css = readUi("styles.css");

  it("ajoute une ligne d'air entre deux messages assistant CONSÉCUTIFS", () => {
    expect(css).toMatch(/\.message--assistant \+ \.message--assistant\s*\{[^}]*margin-top:\s*22px/s);
  });

  it("n'ajoute NI contenu NI séparateur DOM (uniquement une marge)", () => {
    // La règle ne porte que `margin-top` : aucun texte/`content` décimal.
    const rule = css.match(/\.message--assistant \+ \.message--assistant\s*\{([^}]*)\}/s);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toContain("margin-top");
    expect(rule?.[1]).not.toContain("content:");
  });

  it("app.js n'insère AUCUN séparateur dans le fil (seulement une classe CSS)", () => {
    const app = readUi("app.js");
    // Aucun nouvel élément de séparation entre messages.
    expect(app).not.toContain("message--assistant--separated");
    expect(app).not.toContain("appendTurnSeparator");
  });
});
