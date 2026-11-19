import type { ConfigRuntime } from "../config/runtime.js";
import { keyEnv, readCatalog, roles } from "./catalog.js";
import { buildModelsConfigFrom, resolveModelsFrom, resolveProvidersFrom, type EffectiveLlmConfig, type ThinkingLevelName } from "./models.js";
import type { LlmRole } from "./providers.js";

function legacyConfig(config: ConfigRuntime): EffectiveLlmConfig {
  return {
    light: {
      api: config.getString("llm.light.api"),
      baseUrl: config.getString("llm.light.baseUrl"),
      model: config.getString("llm.light.model"),
      thinking: config.getString("llm.light.thinking") as ThinkingLevelName,
      // ⚠️ Déclaration VISION : produit `input` dans `models.json`.
      vision: config.getString("llm.light.vision") === "oui",
    },
    heavy: {
      api: config.getString("llm.heavy.api"),
      baseUrl: config.getString("llm.heavy.baseUrl"),
      model: config.getString("llm.heavy.model"),
      thinking: config.getString("llm.heavy.thinking") as ThinkingLevelName,
      vision: config.getString("llm.heavy.vision") === "oui",
    },
    vision: {
      baseUrl: config.getString("llm.vision.baseUrl"),
      model: config.getString("llm.vision.model"),
      thinking: config.getString("llm.vision.thinking") as ThinkingLevelName,
    },
  };
}

export function llmRouting(config: ConfigRuntime, botId = config.botId) {
  const legacy = legacyConfig(config);
  const catalog = readCatalog(config.getString("llm.catalog"));
  const models = resolveModelsFrom(legacy);
  const providers = resolveProvidersFrom(legacy);
  const file = buildModelsConfigFrom(legacy);
  const entries = new Map(roles.map(role => [
    String(role), { model: models[role], provider: providers[role], effective: legacy[role] },
  ]));
  for (const item of catalog.models) {
    const custom = catalog.providers.find(p => p.id === item.provider);
    const base = item.provider === "heavy" ? providers.heavy : providers.light;
    const provider = custom ? {
      ...base, id: "catalog-" + custom.id, name: custom.name, baseUrl: custom.baseUrl, keyEnv: keyEnv(custom.id),
    } : base;
    const effective = { model: item.model, thinking: item.thinking, vision: item.vision, baseUrl: provider.baseUrl, api: provider.api };
    const model = {
      ...models.light, id: item.model, providerId: provider.id, name: item.model,
      reference: provider.id + "/" + item.model, defaultThinking: item.thinking,
      input: item.vision ? ["text", "image"] as const : ["text"] as const, reasoning: item.thinking !== "off",
    };
    entries.set(item.id, { model, provider, effective });
    const group = file.providers[provider.id] ??= {
      name: provider.name, baseUrl: provider.baseUrl, api: provider.api, apiKey: "$" + provider.keyEnv,
      compat: { supportsDeveloperRole: false, requiresAssistantAfterToolResult: true }, models: [],
    };
    group.models.push({
      id: model.id, name: model.name, reasoning: model.reasoning, input: [...model.input],
      contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }
  const selections = config.selections(botId);
  const selected = (role: LlmRole) => entries.get(selections[role]) ?? entries.get(catalog[role])!;
  const light = selected("light");
  const heavy = selected("heavy");
  return {
    effective: { ...legacy, light: light.effective, heavy: heavy.effective },
    models: { light: light.model, heavy: heavy.model },
    providers: { light: light.provider, heavy: heavy.provider }, file,
  };
}
