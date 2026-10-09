/**
 * Domaine `llm` — fournisseurs, modèles, politique d'outils, disponibilité.
 *
 * AUCUN import du SDK Pi ni de typebox : ce domaine ne connaît que des données
 * et de la logique pures, testables sans réseau.
 */

export {
  HEAVY_PROVIDER,
  LIGHT_PROVIDER,
  LLM_ENV,
  LLM_ROLES,
  PROVIDERS,
  providerForRole,
  readEnvString,
  resolveProviders,
} from "./providers.js";
export type { LlmApi, LlmRole, ProviderSpec, RoleEnvNames } from "./providers.js";

export {
  buildModelsConfig,
  buildModelsConfigFrom,
  DEFAULT_EFFECTIVE_LLM_CONFIG,
  HEAVY_MODEL,
  HEAVY_THINKING_LEVEL_MAP,
  LIGHT_MODEL,
  MODELS,
  modelForRole,
  resolveModels,
  resolveModelsFrom,
  resolveProvidersFrom,
} from "./models.js";
export type {
  EffectiveLlmConfig,
  EffectiveLlmRole,
  ModelSpec,
  ModelsConfig,
  ThinkingLevelMap,
  ThinkingLevelName,
} from "./models.js";

export {
  AGENT_DIRECTORY_TOOLS,
  containsForbiddenTool,
  DELEGATE_TOOLS,
  EXECUTION_TOOLS,
  FORBIDDEN_TOOLS,
  HERITAGE_TOOLS,
  LIBRARIAN_TOOLS,
  READ_ONLY_TOOLS,
  toolAllowlist,
  TOOL_POLICY,
} from "./tool-policy.js";
export type {
  AgentDirectoryToolName,
  BuiltinToolName,
  CustomToolName,
  DelegateToolName,
  ExecutionToolName,
  HeritageToolName,
  LibrarianToolName,
  ToolAllowlistOptions,
  ToolPolicyEntry,
} from "./tool-policy.js";

export {
  evaluateMissingKeyPolicy,
  resolveAvailability,
  resolveLlmConfig,
} from "./availability.js";
export type {
  LlmAvailability,
  LlmConfig,
  LlmMissingKeyMode,
  LlmRoleState,
  LlmRoleStatus,
  MissingKeyDecision,
} from "./availability.js";

export {
  appendVoiceInstruction,
  DELEGATION_INSTRUCTION,
  DELEGATION_MARKER,
  HEAVY_NO_USER_MARKER,
  HEAVY_SYSTEM_PROMPT_FALLBACK,
  VOICE_SPEECH_INSTRUCTION,
} from "./prompts.js";
