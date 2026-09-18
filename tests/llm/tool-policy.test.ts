import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_TOOLS,
  HEAVY_PROVIDER,
  HEAVY_MODEL,
  LIGHT_PROVIDER,
  LIGHT_MODEL,
  PROVIDERS,
  buildModelsConfig,
  containsForbiddenTool,
  toolAllowlist,
} from "../../src/llm/index.js";
import { readFileSync } from "node:fs";

describe("llm — providers & modèles", () => {
  it("associe chaque rôle à un provider DISTINCT (nommage neutre, deux clés)", () => {
    expect(PROVIDERS.light.id).toBe("llm-light");
    expect(PROVIDERS.heavy.id).toBe("llm-heavy");
    expect(PROVIDERS.light.id).not.toBe(PROVIDERS.heavy.id);
    expect(PROVIDERS.light.keyEnv).toBe("YUKI_LLM_LIGHT_API_KEY");
    expect(PROVIDERS.heavy.keyEnv).toBe("YUKI_LLM_HEAVY_API_KEY");
    expect(PROVIDERS.light.baseUrl).toBe(PROVIDERS.heavy.baseUrl);
    expect(PROVIDERS.light.baseUrl).toBe("https://ollama.com/v1");
    expect(LIGHT_PROVIDER.maxConcurrentRequests).toBe(1);
    expect(HEAVY_PROVIDER.maxConcurrentRequests).toBe(3);
  });

  it("LIGHT_MODEL est gemma4:31b sans thinking; HEAVY_MODEL a le thinkingLevelMap validé", () => {
    expect(LIGHT_MODEL.id).toBe("gemma4:31b");
    expect(LIGHT_MODEL.reasoning).toBe(false);
    expect(LIGHT_MODEL.thinkingLevelMap).toBeUndefined();
    expect(LIGHT_MODEL.defaultThinking).toBe("off");

    expect(HEAVY_MODEL.id).toBe("deepseek-v4.1-flash");
    expect(HEAVY_MODEL.reasoning).toBe(true);
    expect(HEAVY_MODEL.thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
    expect(HEAVY_MODEL.defaultThinking).toBe("high");
  });

  it("buildModelsConfig() correspond EXACTEMENT à config/pi/models.json", () => {
    const file = JSON.parse(
      readFileSync("config/pi/models.json", "utf8"),
    ) as unknown;
    expect(file).toEqual(buildModelsConfig());
    // Aucune clé en clair : uniquement des références d'environnement.
    const config = buildModelsConfig();
    for (const provider of Object.values(config.providers)) {
      expect(provider.apiKey.startsWith("$")).toBe(true);
    }
  });
});

describe("llm — politique d'outils (garantie structurelle)", () => {
  it("le léger peut déléguer mais n'a JAMAIS write/bash/edit", () => {
    const tools = toolAllowlist("light");
    expect(tools).toContain("delegate");
    expect(tools).toContain("job_status");
    expect(tools).toContain("cancel_job");
    expect(tools).toEqual(
      expect.arrayContaining(["read", "ls", "grep", "find"]),
    );
    for (const forbidden of FORBIDDEN_TOOLS) {
      expect(tools).not.toContain(forbidden);
    }
    expect(containsForbiddenTool(tools)).toBe(false);
  });

  it("délégation désactivée → les outils de délégation ne sont pas exposés", () => {
    const tools = toolAllowlist("light", { delegationEnabled: false });
    expect(tools).toEqual(["read", "ls", "grep", "find"]);
  });

  it("le lourd n'a que les outils de lecture (pas de délégation)", () => {
    const tools = toolAllowlist("heavy");
    expect(tools).toEqual(["read", "ls", "grep", "find"]);
    expect(tools).not.toContain("delegate");
    expect(tools).not.toContain("job_status");
    expect(tools).not.toContain("cancel_job");
    expect(containsForbiddenTool(tools)).toBe(false);
  });

  it("détecte effectivement les outils interdits (garde-fou)", () => {
    expect(containsForbiddenTool(["read", "write"])).toBe(true);
    expect(containsForbiddenTool(["read", "bash"])).toBe(true);
  });
});
