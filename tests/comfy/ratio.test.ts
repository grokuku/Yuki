/**
 * RATIO D'IMAGE — déduction des dimensions injectées (`YUKI_WIDTH`/`YUKI_HEIGHT`).
 *
 * ⚠️ Ce que ce fichier verrouille : un format DEMANDÉ (« 16:9 ») doit arriver au
 * graphe sous forme de dimensions de la BONNE FORME. Avant cette correction,
 * Yuki n'écrivait que le couple fixe des réglages (1024×1024 par défaut) : un
 * graphe qui déduit sa résolution du ratio de l'image d'entrée (cas réel :
 * `FL_ImageBlank` → `AIHResolutionPresetV2` avec `use_image_ratio`) produisait
 * donc toujours du CARRÉ — « ratio 16:9 » demandé, 2508×2508 obtenu.
 */

import { describe, expect, it } from "vitest";

import {
  parseAspectRatio,
  sizeForRatio,
  sizeForRatioOrThrow,
} from "../../src/comfy/ratio.js";
import { ComfyError } from "../../src/comfy/types.js";

const BASE = { width: 1_024, height: 1_024 };

describe("parseAspectRatio — formes acceptées et refusées", () => {
  it("accepte les écritures courantes", () => {
    for (const text of ["16:9", "16/9", "16x9", "16 : 9", " 9:16 "]) {
      expect(parseAspectRatio(text), text).toBeDefined();
    }
    expect(parseAspectRatio("16:9")).toEqual({ width: 16, height: 9 });
  });

  it("refuse tout ce qui n'est pas un ratio exploitable (aucun repli silencieux)", () => {
    for (const value of [
      "",
      " ",
      "carré",
      "16",
      "16:",
      "0:9",
      "9:0",
      "-16:9",
      "1:1000",
      "1000:1",
      "16.5:9",
      null,
      undefined,
      42,
    ]) {
      expect(parseAspectRatio(value as unknown), String(value)).toBeUndefined();
    }
  });
});

describe("sizeForRatio — budget de pixels CONSTANT, forme demandée", () => {
  it("16:9 reste un PAYSAGE (jamais un carré) et conserve le budget de pixels", () => {
    const size = sizeForRatio({ width: 16, height: 9 }, BASE);
    expect(size.width).toBeGreaterThan(size.height);
    expect(size.width / size.height).toBeCloseTo(16 / 9, 1);
    // Budget conservé à quelques pour cent près (alignement sur 16 oblige).
    const budget = BASE.width * BASE.height;
    expect(Math.abs(size.width * size.height - budget) / budget).toBeLessThan(0.05);
    // Valeurs attendues pour le défaut 1024×1024 : 1360×768.
    expect(size).toEqual({ width: 1_360, height: 768 });
  });

  it("9:16 bascule en PORTRAIT (l'orientation suit le ratio)", () => {
    const size = sizeForRatio({ width: 9, height: 16 }, BASE);
    expect(size).toEqual({ width: 768, height: 1_360 });
  });

  it("1:1 reste carré", () => {
    expect(sizeForRatio({ width: 1, height: 1 }, BASE)).toEqual({
      width: 1_024,
      height: 1_024,
    });
  });

  it("les côtés sont des MULTIPLES DE 16 (exigence des latents SD/Flux)", () => {
    for (const ratio of [
      { width: 16, height: 9 },
      { width: 3, height: 2 },
      { width: 4, height: 5 },
      { width: 21, height: 9 },
    ]) {
      const size = sizeForRatio(ratio, BASE);
      expect(size.width % 16, JSON.stringify(ratio)).toBe(0);
      expect(size.height % 16, JSON.stringify(ratio)).toBe(0);
    }
  });

  it("respecte le budget des RÉGLAGES (base non carrée) et les bornes 64…4096", () => {
    const wide = sizeForRatio({ width: 16, height: 9 }, { width: 1_344, height: 768 });
    expect(wide.width).toBeGreaterThan(wide.height);
    const tiny = sizeForRatio({ width: 16, height: 9 }, { width: 64, height: 64 });
    expect(tiny.width).toBeGreaterThanOrEqual(64);
    expect(tiny.height).toBeGreaterThanOrEqual(64);
    const huge = sizeForRatio({ width: 1, height: 1 }, { width: 4_096, height: 4_096 });
    expect(huge.width).toBeLessThanOrEqual(4_096);
  });
});

describe("sizeForRatioOrThrow — refus EXPLICITE (jamais un carré silencieux)", () => {
  it("refuse un format illisible avec un message actionnable", () => {
    let error: unknown;
    try {
      sizeForRatioOrThrow("carré", BASE);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ComfyError);
    expect((error as ComfyError).code).toBe("invalid_ratio");
    expect((error as ComfyError).message).toContain("16:9");
    expect((error as ComfyError).message).toContain("largeur:hauteur");
  });

  it("rend les dimensions pour un format valide", () => {
    expect(sizeForRatioOrThrow("16:9", BASE)).toEqual({ width: 1_360, height: 768 });
  });
});
