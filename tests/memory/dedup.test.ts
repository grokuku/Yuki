/**
 * Déduplication déterministe (passe de mise de côté).
 *
 * Prouve que les QUASI-doublons (reformulations, précisions d'un souvenir
 * existant) sont reconnus — et que les VRAIES nouveautés (même sujet, contenu
 * différent) ne le sont PAS.
 */

import { describe, expect, it } from "vitest";

import {
  findNearDuplicate,
  isNearDuplicate,
  memoryTokens,
  NEAR_DUPLICATE_CONTAINMENT,
} from "../../src/memory/dedup.js";

describe("dédup — mots significatifs", () => {
  it("replie casse et accents et ignore les mots trop courts", () => {
    expect(memoryTokens("L'utilisateur préfère les CRÊPES au sucre")).toEqual([
      "utilisateur",
      "prefere",
      "les",
      "crepes",
      "sucre",
    ]);
  });

  it("déduplique un mot répété", () => {
    expect(memoryTokens("crêpes crêpes CREPES")).toEqual(["crepes"]);
  });
});

describe("dédup — isNearDuplicate", () => {
  it("reconnaît une PRÉCISION d'un souvenir existant (aucun mot nouveau)", () => {
    expect(
      isNearDuplicate(
        "L'utilisateur préfère le thé au café",
        "L'utilisateur préfère le thé au café le matin",
      ),
    ).toBe(true);
  });

  it("reconnaît une REFORMULATION à casse/accents près", () => {
    expect(
      isNearDuplicate("L'UTILISATEUR prefere les crepes bretonnes", "L'utilisateur préfère les crêpes bretonnes"),
    ).toBe(true);
  });

  it("ne confond PAS deux faits distincts du même sujet (Rennes vs Nantes)", () => {
    expect(
      isNearDuplicate("L'utilisateur habite à Nantes", "L'utilisateur habite à Rennes"),
    ).toBe(false);
  });

  it("ne compare pas un candidat trop court (moins de 3 mots significatifs)", () => {
    expect(isNearDuplicate("Thé vert", "L'utilisateur préfère le thé vert")).toBe(false);
  });

  it("le seuil est celui de la constante documentée", () => {
    expect(NEAR_DUPLICATE_CONTAINMENT).toBe(0.8);
  });
});

describe("dédup — findNearDuplicate", () => {
  const existing = [
    { id: "mem-1", text: "L'utilisateur préfère le téléphone en thème sombre" },
    { id: "mem-2", text: "L'utilisateur s'appelle Alice" },
  ];

  it("renvoie le souvenir le plus proche avec son identifiant", () => {
    const match = findNearDuplicate("L'utilisateur préfère le téléphone en thème sombre la nuit", existing);
    expect(match?.id).toBe("mem-1");
    // 5 mots sur 6 déjà présents (« nuit » est le seul mot neuf) ⇒ quasi-doublon.
    expect(match?.containment).toBeGreaterThanOrEqual(NEAR_DUPLICATE_CONTAINMENT);
  });

  it("renvoie undefined quand le candidat apporte du neuf", () => {
    expect(findNearDuplicate("L'utilisateur travaille chez un éditeur de logiciels", existing)).toBeUndefined();
  });

  it("choisit le recouvrement MAXIMAL quand plusieurs souvenirs sont proches", () => {
    const match = findNearDuplicate("Alice préfère le thème sombre", [
      { id: "a", text: "Le thème sombre est utilisé par Alice" },
      { id: "b", text: "Alice préfère le thème sombre" },
    ]);
    expect(match?.id).toBe("b");
  });
});
