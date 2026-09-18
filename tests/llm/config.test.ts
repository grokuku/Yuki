import { describe, expect, it } from "vitest";

import {
  resolveLlmConfig,
  resolveModels,
  resolveProviders,
} from "../../src/llm/index.js";

describe("llm — configuration NEUTRE (variables par rôle)", () => {
  it("sans variables : providers neutres et défauts par rôle", () => {
    const cfg = resolveLlmConfig({});
    expect(cfg.providers.light.id).toBe("llm-light");
    expect(cfg.providers.heavy.id).toBe("llm-heavy");
    expect(cfg.providers.light.id).not.toBe(cfg.providers.heavy.id);
    expect(cfg.providers.light.keyEnv).toBe("YUKI_LLM_LIGHT_API_KEY");
    expect(cfg.providers.heavy.keyEnv).toBe("YUKI_LLM_HEAVY_API_KEY");
    expect(cfg.models.light.reference).toBe("llm-light/gemma4:31b");
    expect(cfg.models.heavy.reference).toBe("llm-heavy/deepseek-v4.1-flash");
    expect(cfg.models.light.defaultThinking).toBe("off");
    expect(cfg.models.heavy.defaultThinking).toBe("high");
  });

  it("les variables neutres surchargent, avec DEUX baseUrl distinctes", () => {
    const cfg = resolveLlmConfig({
      YUKI_LLM_LIGHT_BASE_URL: "https://light.example/v1",
      YUKI_LLM_LIGHT_API: "openai-completions",
      YUKI_LLM_LIGHT_MODEL: "small-model",
      YUKI_LLM_LIGHT_THINKING: "low",
      YUKI_LLM_HEAVY_BASE_URL: "https://heavy.example/v1",
      YUKI_LLM_HEAVY_MODEL: "big-model",
      YUKI_LLM_HEAVY_THINKING: "medium",
    });
    expect(cfg.providers.light.baseUrl).toBe("https://light.example/v1");
    expect(cfg.providers.heavy.baseUrl).toBe("https://heavy.example/v1");
    expect(cfg.providers.light.baseUrl).not.toBe(cfg.providers.heavy.baseUrl);
    expect(cfg.models.light.reference).toBe("llm-light/small-model");
    expect(cfg.models.heavy.reference).toBe("llm-heavy/big-model");
    expect(cfg.models.light.defaultThinking).toBe("low");
    expect(cfg.models.heavy.defaultThinking).toBe("medium");
  });

  it("les valeurs vides sont ignorées (défaut conservé)", () => {
    const providers = resolveProviders({
      YUKI_LLM_LIGHT_BASE_URL: "   ",
    });
    expect(providers.light.baseUrl).toBe("https://ollama.com/v1");
  });

  it("un niveau de thinking invalide retombe sur le défaut du rôle", () => {
    const models = resolveModels({ YUKI_LLM_LIGHT_THINKING: "bogus" });
    expect(models.light.defaultThinking).toBe("off");
    expect(models.heavy.defaultThinking).toBe("high");
  });

  it("le thinkingLevelMap du lourd est préservé malgré une surcharge de modèle", () => {
    const heavy = resolveModels({ YUKI_LLM_HEAVY_MODEL: "big-model" }).heavy;
    expect(heavy.reasoning).toBe(true);
    expect(heavy.thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
    // Le léger n'a JAMAIS de thinkingLevelMap.
    expect(resolveModels({}).light.thinkingLevelMap).toBeUndefined();
  });
});
