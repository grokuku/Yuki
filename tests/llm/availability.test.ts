import { describe, expect, it } from "vitest";

import {
  evaluateMissingKeyPolicy,
  resolveAvailability,
} from "../../src/llm/index.js";

describe("llm — disponibilité (aucun appel réseau)", () => {
  it("sans clé : les deux rôles sont indisponibles", () => {
    const availability = resolveAvailability({});
    expect(availability.light.status).toBe("unavailable");
    expect(availability.heavy.status).toBe("unavailable");
    expect(availability.light.keyPresent).toBe(false);
    expect(availability.isAvailable("light")).toBe(false);
    expect(availability.isAvailable("heavy")).toBe(false);
  });

  it("clé légère seule : léger prêt, lourd indisponible", () => {
    const availability = resolveAvailability({
      YUKI_LLM_LIGHT_API_KEY: "fake-light",
    });
    expect(availability.light.status).toBe("ready");
    expect(availability.light.keyPresent).toBe(true);
    expect(availability.isAvailable("light")).toBe(true);
    expect(availability.heavy.status).toBe("unavailable");
    expect(availability.isAvailable("heavy")).toBe(false);
    // Les clés ne fuient jamais : seul un booléen est exposé.
    expect(JSON.stringify(availability)).not.toContain("fake-light");
  });

  it("clé vide = absente", () => {
    const availability = resolveAvailability({
      YUKI_LLM_LIGHT_API_KEY: "   ",
    });
    expect(availability.light.keyPresent).toBe(false);
  });

  it("politique degrade : ne refuse pas", () => {
    const availability = resolveAvailability({});
    const decision = evaluateMissingKeyPolicy(availability, "degrade");
    expect(decision.refuse).toBe(false);
    expect(decision.missing).toEqual(["light", "heavy"]);
  });

  it("politique refuse : refuse si une clé manque", () => {
    const availability = resolveAvailability({
      YUKI_LLM_LIGHT_API_KEY: "fake-light",
    });
    const decision = evaluateMissingKeyPolicy(availability, "refuse");
    expect(decision.refuse).toBe(true);
    expect(decision.missing).toEqual(["heavy"]);
  });

  it("politique refuse : passe si les deux clés sont présentes", () => {
    const availability = resolveAvailability({
      YUKI_LLM_LIGHT_API_KEY: "fake-light",
      YUKI_LLM_HEAVY_API_KEY: "fake-heavy",
    });
    expect(evaluateMissingKeyPolicy(availability, "refuse").refuse).toBe(false);
  });
});
