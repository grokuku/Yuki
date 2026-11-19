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

  /**
   * Bloc d'options de `createSdkMemoryExtractor(…)` (équilibrage d'accolades).
   *
   * ⚠️ GARDE RÉVISÉE (commit externe `134a313` « split LLM config », 2026-11-19) :
   * l'extracteur n'est plus un singleton (`const memoryExtractor =
   * createSdkMemoryExtractor({ … })`) mais une FABRIQUE PAR BOT
   * (`const memoryExtractor = (botId: string) => createSdkMemoryExtractor({ … })`) —
   * le modèle d'écriture est désormais lu POUR CE BOT. Le CONTRÔLE est inchangé :
   * la référence d'écriture doit être la référence RÉSOLUE (`memoryWriteRef`),
   * jamais une référence en dur sur le léger.
   */
  function blocExtracteur(): string {
    const fabrique = index.indexOf("const memoryExtractor");
    expect(
      fabrique,
      "déclaration `memoryExtractor` introuvable dans `src/index.ts`",
    ).toBeGreaterThan(-1);
    const appel = index.indexOf("createSdkMemoryExtractor({", fabrique);
    expect(appel, "`createSdkMemoryExtractor({` absent de la déclaration").toBeGreaterThan(-1);
    let profondeur = 0;
    for (let i = index.indexOf("{", appel); i < index.length; i += 1) {
      if (index[i] === "{") profondeur += 1;
      if (index[i] === "}") {
        profondeur -= 1;
        if (profondeur === 0) return index.slice(appel, i + 1);
      }
    }
    throw new Error("appel `createSdkMemoryExtractor` non refermé");
  }

  it("l'extracteur de mémoire utilise la référence d'écriture résolue (lourd si dispo)", () => {
    expect(index).toContain("memoryWriteModelReference({");
    // ⚠️ LOT 36 (L11) : l'extracteur est construit UNE fois par bot (il est
    // PARTAGÉ par les services de mémoire de ce bot), d'où la fabrique.
    const block = blocExtracteur();
    // Le modèle vient de la RÉSOLUTION, pas d'une constante : `memoryWriteRef`
    // préfère le compte lourd et ne retombe sur le léger qu'à défaut.
    expect(block).toMatch(/modelReference: \(\) => memoryWriteRef\(botId\)/);
    // Plus AUCUNE écriture mémoire câblée en dur sur le léger.
    expect(block).not.toContain("lightRef");
    // ⚠️ Et la RÉSOLUTION elle-même est bien celle du compte lourd si dispo :
    // on verrouille la déclaration de `memoryWriteRef` (bloc distinct).
    const debutRef = index.indexOf("const memoryWriteRef =");
    expect(debutRef, "déclaration `memoryWriteRef` introuvable").toBeGreaterThan(-1);
    const blocRef = index.slice(debutRef, index.indexOf("const memoryExtractor", debutRef));
    expect(blocRef).toContain("memoryWriteModelReference({");
    expect(blocRef).toContain('isAvailable("heavy")');
    expect(blocRef).toContain("liveHeavyReference(botId)");
    expect(blocRef).toContain("liveLightReference(botId)");
  });
});
