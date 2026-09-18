/**
 * Modèles LLM par rôle (données pures, AUCUN import SDK/typebox).
 *
 * - Léger : `gemma4:31b` — mène la conversation, SEUL à parler, thinking
 *   DÉSACTIVÉ (`reasoning: false`, aucun paramètre de raisonnement envoyé).
 * - Lourd : `deepseek-v4.1-flash` — tâches complexes en arrière-plan, thinking
 *   ACTIVÉ. Sur un endpoint OpenAI, `think:false` est ignoré : c'est
 *   `reasoning_effort: "none"` qui coupe le thinking, d'où le `thinkingLevelMap`.
 *
 * `buildModelsConfig()` est la source unique (testée contre
 * `config/pi/models.json`) : le fichier embarqué ne peut pas dériver du code.
 */

import {
  HEAVY_PROVIDER,
  LIGHT_PROVIDER,
  LLM_ENV,
  PROVIDERS,
  readEnvString,
  type LlmRole,
  type ProviderSpec,
} from "./providers.js";

/** Niveaux de raisonnement du SDK Pi (repris tels quels). */
export type ThinkingLevelName =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * Table tristate : une chaîne envoie cette valeur au provider, `null` marque le
 * niveau comme non supporté.
 */
export type ThinkingLevelMap = Partial<
  Record<ThinkingLevelName, string | null>
>;

/** ThinkingLevelMap du lourd : `off` coupe le thinking via `reasoning_effort`. */
export const HEAVY_THINKING_LEVEL_MAP: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
};

export interface ModelSpec {
  readonly role: LlmRole;
  readonly providerId: string;
  /** Identifiant passé à l'API. */
  readonly id: string;
  readonly name: string;
  /** Supporte le raisonnement étendu. */
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: ThinkingLevelMap;
  readonly input: readonly ("text" | "image")[];
  readonly contextWindow: number;
  readonly maxTokens: number;
  /** Niveau de raisonnement par défaut du rôle. */
  readonly defaultThinking: ThinkingLevelName;
  /** Référence `provider/modelId`. */
  readonly reference: string;
}

export const LIGHT_MODEL: ModelSpec = {
  role: "light",
  providerId: LIGHT_PROVIDER.id,
  id: "gemma4:31b",
  name: "Gemma 4 31B (léger)",
  reasoning: false,
  input: ["text"],
  contextWindow: 131_072,
  maxTokens: 32_768,
  defaultThinking: "off",
  reference: `${LIGHT_PROVIDER.id}/gemma4:31b`,
};

export const HEAVY_MODEL: ModelSpec = {
  role: "heavy",
  providerId: HEAVY_PROVIDER.id,
  id: "deepseek-v4.1-flash",
  name: "DeepSeek V4.1 Flash (lourd)",
  reasoning: true,
  thinkingLevelMap: HEAVY_THINKING_LEVEL_MAP,
  input: ["text"],
  contextWindow: 131_072,
  maxTokens: 32_768,
  defaultThinking: "high",
  reference: `${HEAVY_PROVIDER.id}/deepseek-v4.1-flash`,
};

export const MODELS: Readonly<Record<LlmRole, ModelSpec>> = {
  light: LIGHT_MODEL,
  heavy: HEAVY_MODEL,
};

export function modelForRole(role: LlmRole): ModelSpec {
  return MODELS[role];
}

const THINKING_LEVELS: readonly ThinkingLevelName[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function resolveThinking(value: string | undefined, fallback: ThinkingLevelName): ThinkingLevelName {
  return value && (THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevelName)
    : fallback;
}

/**
 * Résout les modèles EFFECTIFS : `YUKI_LLM_<ROLE>_{MODEL,THINKING}` surchargent
 * les défauts. L'identifiant sélectionné doit exister dans `models.json`.
 * `reference` est recalculée (`providerId/modelId`) à partir des providers fournis.
 */
export function resolveModels(
  env: NodeJS.ProcessEnv = process.env,
  providers: Readonly<Record<LlmRole, ProviderSpec>> = PROVIDERS,
): Record<LlmRole, ModelSpec> {
  const build = (role: LlmRole, base: ModelSpec): ModelSpec => {
    const id = readEnvString(env, LLM_ENV[role].model) ?? base.id;
    const defaultThinking = resolveThinking(
      readEnvString(env, LLM_ENV[role].thinking),
      base.defaultThinking,
    );
    const providerId = providers[role].id;
    return {
      ...base,
      providerId,
      id,
      defaultThinking,
      reference: `${providerId}/${id}`,
    };
  };
  return {
    light: build("light", LIGHT_MODEL),
    heavy: build("heavy", HEAVY_MODEL),
  };
}

interface ModelsConfigModel {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

interface ModelsConfigProvider {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  compat: { supportsDeveloperRole: boolean };
  models: ModelsConfigModel[];
}

export interface ModelsConfig {
  providers: Record<string, ModelsConfigProvider>;
}

function toModelConfig(model: ModelSpec): ModelsConfigModel {
  const config: ModelsConfigModel = {
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: [...model.input],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  if (model.thinkingLevelMap) config.thinkingLevelMap = model.thinkingLevelMap;
  return config;
}

/**
 * Construit le contenu de `config/pi/models.json`. Aucune clé en clair : les
 * `apiKey` ne sont que des références d'environnement.
 */
export function buildModelsConfig(): ModelsConfig {
  const provider = (
    spec: typeof LIGHT_PROVIDER,
    model: ModelSpec,
  ): ModelsConfigProvider => ({
    name: spec.name,
    baseUrl: spec.baseUrl,
    api: spec.api,
    apiKey: `$${spec.keyEnv}`,
    // Le fournisseur compatible OpenAI ne comprend pas toujours le rôle
    // `developer` utilisé par le SDK pour les modèles à raisonnement.
    compat: { supportsDeveloperRole: false },
    models: [toModelConfig(model)],
  });
  return {
    providers: {
      [LIGHT_PROVIDER.id]: provider(LIGHT_PROVIDER, LIGHT_MODEL),
      [HEAVY_PROVIDER.id]: provider(HEAVY_PROVIDER, HEAVY_MODEL),
    },
  };
}
