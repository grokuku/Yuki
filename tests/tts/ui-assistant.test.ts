/**
 * Tests unitaires — logique PURE de l'assistant de mise en route du TTS (Lot 8).
 *
 * Le composant `public/ui/tts-assistant.js` expose des fonctions de mapping
 * sans DOM (état → libellé, erreur → message, bornes du texte). On les teste en
 * Node, sans navigateur — même patron que `tests/tts/ui-audio.test.ts` (aucun
 * DOM complet requis, doublures injectées pour la partie interactive).
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TTS_TEST_TEXT,
  TTS_TEST_MAX_CHARS,
  clampTestText,
  describeEngineModels,
  describeModelsDir,
  describeTestError,
  describeTtsState,
  formatBytes,
  statusTechnicalDetails,
  validateTestText,
} from "../../public/ui/tts-assistant.js";

/* ─── Bornes du texte de test ───────────────────────────────────────────── */

describe("borne du texte de test", () => {
  it("accepte exactement 500 caractères et refuse 501", () => {
    expect(validateTestText("x".repeat(TTS_TEST_MAX_CHARS)).ok).toBe(true);
    const tooLong = validateTestText("x".repeat(TTS_TEST_MAX_CHARS + 1));
    expect(tooLong.ok).toBe(false);
    expect(tooLong.error).toContain("500");
  });

  it("rogne les espaces et traite l'absence comme chaîne vide", () => {
    expect(clampTestText("  bonjour  ")).toBe("bonjour");
    expect(clampTestText(undefined)).toBe("");
    expect(clampTestText(null)).toBe("");
    expect(clampTestText(123)).toBe("");
    expect(clampTestText("")).toBe("");
  });

  it("tronque à la borne (clamp) sans lever", () => {
    const clamped = clampTestText("a".repeat(600));
    expect(clamped).toHaveLength(TTS_TEST_MAX_CHARS);
  });
});

/* ─── État → libellé / message ──────────────────────────────────────────── */

describe("describeTtsState — les 5 états honnêtes + inconnu", () => {
  it("off → désactivé + bouton d'activation", () => {
    const view = describeTtsState({ state: "off", enabled: false, baseUrl: "http://tts:8081" });
    expect(view.key).toBe("off");
    expect(view.label).toBe("Désactivé");
    expect(view.showEnable).toBe(true);
    expect(view.tone).toBe("muted");
  });

  it("unreachable → non démarré, action manuelle expliquée, détails repliables", () => {
    const view = describeTtsState({
      state: "unreachable",
      enabled: true,
      baseUrl: "http://tts:8081",
      error: "connect ECONNREFUSED 172.18.0.9:8081",
    });
    expect(view.key).toBe("unreachable");
    expect(view.label).toBe("Non démarré");
    expect(view.showDetails).toBe(true);
    expect(view.showRetry).toBe(true);
    // Explique l'action manuelle et l'absence d'accès Docker.
    expect(view.message).toMatch(/Docker/);
    expect(view.message).toMatch(/main/);
    // Aucune affirmation « prêt », et cause GPU mentionnée comme POSSIBLE.
    expect(view.message).not.toMatch(/\bprêt\b/i);
    expect(view.message).toMatch(/GPU/);
  });

  it("starting → démarrage en cours + relance discrète", () => {
    const view = describeTtsState({ state: "starting", enabled: true, ready: false });
    expect(view.key).toBe("starting");
    expect(view.label).toBe("Démarrage en cours");
    expect(view.retrySoon).toBe(true);
    expect(view.showDetails).toBe(false);
  });

  it("ready → « prêt » SEULEMENT avec le nombre de modèles", () => {
    const view = describeTtsState({ state: "ready", enabled: true, ready: true, modelCount: 3 });
    expect(view.key).toBe("ready");
    expect(view.label).toBe("Prêt");
    expect(view.message).toContain("3");
    expect(view.message).toMatch(/modèles/);
    expect(view.tone).toBe("ok");
  });

  it("ready sans compte → « Moteur prêt. » sans inventer de nombre", () => {
    const view = describeTtsState({ state: "ready", enabled: true, modelCount: null });
    expect(view.message).toBe("Moteur prêt.");
  });

  it("error → message + détails techniques repliables", () => {
    const view = describeTtsState({ state: "error", enabled: true, error: "Le moteur a répondu 503 : …" });
    expect(view.key).toBe("error");
    expect(view.label).toBe("Erreur");
    expect(view.showDetails).toBe(true);
    expect(view.showRetry).toBe(true);
  });

  it("rapport absent → état inconnu, jamais « prêt »", () => {
    const view = describeTtsState(null);
    expect(view.key).toBe("unknown");
    expect(view.label).not.toMatch(/prêt/i);
    expect(view.showRetry).toBe(true);
  });
});

describe("statusTechnicalDetails", () => {
  it("remonte code et corps brut remontés par la sonde", () => {
    const text = statusTechnicalDetails({
      state: "error",
      enabled: true,
      baseUrl: "http://tts:8081",
      engine: "chatterbox",
      reachable: true,
      ready: null,
      modelCount: null,
      latencyMs: 12,
      measuredAt: "2026-09-20T12:00:00.000Z",
      error: "Le moteur a répondu 503 : {\"error\":\"Insufficient Memory\"}",
    });
    expect(text).toContain("503");
    expect(text).toContain("Insufficient Memory");
    expect(text).toContain("chatterbox");
  });
});

/* ─── Erreur de test → message lisible ──────────────────────────────────── */

describe("describeTestError — messages lisibles + réessai", () => {
  it("503 server_busy : « occupé OU mémoire insuffisante », jamais tranché", () => {
    const view = describeTestError({
      status: 503,
      code: "server_busy",
      engineStatus: 503,
      engineBody: '{"error":"Insufficient Memory"}',
    });
    expect(view.message).toMatch(/occupé/i);
    expect(view.message).toMatch(/mémoire/i);
    // Honnêteté : on ne tranche pas.
    expect(view.message).toMatch(/OU/);
    expect(view.detail).toContain("Insufficient Memory");
    expect(view.retry).toBe(true);
  });

  it("504 timeout", () => {
    const view = describeTestError({ status: 504, code: "timeout" });
    expect(view.message).toMatch(/délai/i);
    expect(view.retry).toBe(true);
  });

  it("502 erreur moteur générique", () => {
    const view = describeTestError({ status: 502, code: "http_error", engineStatus: 500, engineBody: "boom" });
    expect(view.message).toMatch(/502|500/);
    expect(view.detail).toBe("boom");
  });

  it("503 tts_disabled et tts_unavailable", () => {
    expect(describeTestError({ status: 503, code: "tts_disabled" }).message).toMatch(/désactivée/i);
    expect(describeTestError({ status: 503, code: "tts_unavailable" }).message).toMatch(/disponible/i);
  });

  it("400 text_too_long / requête invalide", () => {
    expect(describeTestError({ status: 400, code: "text_too_long" }).message).toContain("500");
    expect(describeTestError({ status: 400, code: "invalid_text" }).message).toMatch(/invalide/i);
  });

  it("erreur réseau (statut 0) restitue le message", () => {
    const view = describeTestError({ status: 0, message: "Failed to fetch" });
    expect(view.message).toMatch(/réseau/i);
    expect(view.hint).toBe("Failed to fetch");
  });
});

/* ─── Diagnostic du répertoire des modèles ──────────────────────────────── */

describe("describeModelsDir", () => {
  it("aucun fichier → message « à déposer » + action hors Yuki", () => {
    const view = describeModelsDir({
      dir: "/models",
      present: true,
      readable: true,
      fileCount: 0,
      files: [],
      truncated: false,
      error: null,
    });
    expect(view.kind).toBe("empty");
    expect(view.message).toMatch(/Aucun modèle/);
    expect(view.message).toMatch(/hors Yuki/i);
    expect(view.dir).toBe("/models");
  });

  it("fichiers présents → noms et tailles", () => {
    const view = describeModelsDir({
      dir: "/models",
      present: true,
      readable: true,
      fileCount: 1,
      files: [{ name: "chatterbox-q8.gguf", size: 1234 }],
      truncated: false,
      error: null,
    });
    expect(view.kind).toBe("files");
    expect(view.files[0].name).toBe("chatterbox-q8.gguf");
  });

  it("répertoire absent = état normal (jamais une exception)", () => {
    const view = describeModelsDir({
      dir: "/models",
      present: false,
      readable: false,
      fileCount: 0,
      files: [],
      truncated: false,
      error: null,
    });
    expect(view.kind).toBe("absent");
  });

  it("diagnostic absent → unknown", () => {
    expect(describeModelsDir(undefined).kind).toBe("unknown");
  });
});

describe("describeEngineModels", () => {
  it("signale l'absence du moteur configuré (enginePresent:false)", () => {
    const view = describeEngineModels({
      reachable: true,
      engine: "chatterbox",
      enginePresent: false,
      count: 1,
      models: [{ id: "kokoro", task: "tts" }],
      error: null,
    });
    expect(view.kind).toBe("list");
    expect(view.warning).toMatch(/chatterbox/);
  });

  it("moteur configuré présent → aucun avertissement", () => {
    const view = describeEngineModels({
      reachable: true,
      engine: "chatterbox",
      enginePresent: true,
      count: 1,
      models: [{ id: "chatterbox", task: "tts" }],
      error: null,
    });
    expect(view.warning).toBeNull();
  });

  it("moteur injoignable → pas de liste", () => {
    const view = describeEngineModels({ reachable: false, models: [], count: null, error: null });
    expect(view.kind).toBe("unreachable");
  });
});

describe("formatBytes", () => {
  it("formate en unités françaises", () => {
    expect(formatBytes(0)).toBe("0 o");
    expect(formatBytes(512)).toBe("512 o");
    expect(formatBytes(2048)).toBe("2.0 Ko");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 Mo");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.00 Go");
  });
});

/* ─── Alignement de la phrase par défaut ────────────────────────────────── */

describe("phrase par défaut", () => {
  it("est en français et non vide (servie aussi en placeholder)", () => {
    expect(DEFAULT_TTS_TEST_TEXT.length).toBeGreaterThan(0);
    expect(DEFAULT_TTS_TEST_TEXT).toMatch(/[a-zàâçéèêëîïôûùüÿñæœ]/i);
  });
});
