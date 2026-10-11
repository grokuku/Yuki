/**
 * Choix du compte modèle pour l'ÉCRITURE mémoire de fond.
 *
 * Décision : l'extraction / la consolidation basculent sur le compte LOURD
 * quand il est disponible, pour libérer le compte léger (mono-slot). Repli sur
 * le léger sinon. Un garde-fou statique verrouille le câblage dans `src/index.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { memoryWriteModelReference } from "../../src/memory/index.js";

describe("memoryWriteModelReference — écriture de fond sur le compte lourd", () => {
  it("préfère le lourd dès qu'il est disponible", () => {
    expect(
      memoryWriteModelReference({
        heavyAvailable: true,
        heavyRef: "llm-heavy/deepseek",
        lightRef: "llm-light/gemma",
      }),
    ).toBe("llm-heavy/deepseek");
  });

  it("retombe sur le léger si le lourd n'est pas disponible (jamais de perte)", () => {
    expect(
      memoryWriteModelReference({
        heavyAvailable: false,
        heavyRef: "llm-heavy/deepseek",
        lightRef: "llm-light/gemma",
      }),
    ).toBe("llm-light/gemma");
  });
});

describe("garde-fou statique — câblage de l'extracteur de mémoire", () => {
  const index = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");

  it("l'extracteur de mémoire utilise la référence d'écriture résolue (lourd si dispo)", () => {
    expect(index).toContain("memoryWriteModelReference({");
    const start = index.indexOf("extractor: createSdkMemoryExtractor({");
    expect(start).toBeGreaterThan(-1);
    // Bloc de l'extracteur seul (jusqu'à la fin du `createSdkMemoryExtractor`).
    const block = index.slice(start, start + 600);
    expect(block).toMatch(/modelReference: memoryWriteRef/);
    // Plus AUCUNE écriture mémoire câblée en dur sur le léger.
    expect(block).not.toContain("lightRef");
  });
});
