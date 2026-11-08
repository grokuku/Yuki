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
  LLM_ENV_ALIAS,
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
  CONVERSATION_ARCHIVE_TOOLS,
  containsForbiddenTool,
  DELEGATE_TOOLS,
  EXECUTION_TOOLS,
  FILE_LIST_TOOLS,
  FILE_READ_TOOLS,
  FORBIDDEN_TOOLS,
  HERITAGE_TOOLS,
  LIBRARIAN_TOOLS,
  READ_ONLY_TOOLS,
  SECRET_DIRECTORY_TOOLS,
  SECRET_REQUEST_TOOLS,
  APPROVAL_REQUIRED_TOOLS,
  approvalRequiredTools,
  // ⚠️ OUTILS LONGS (lot 23) : la liste MESURÉE et le refus actionnable sont
  // publics — c'est ce qui permet de les verrouiller par test et de les exposer
  // au run de canal (`src/pi/sdk/long-tool-guard.ts`).
  LONG_RUNNING_TOOLS,
  longRunningTool,
  longToolInlineRefusal,
  REMOTE_AGENTS_TOOLS,
  REMOTE_ALWAYS_TOOLS,
  REMOTE_NEVER_TOOLS,
  REMOTE_SAFE_TOOLS,
  REMOTE_TOOL_GROUP_OF,
  REMOTE_TOOLS,
  remoteToolGroup,
  toolAllowlist,
  toolAllowlistForChat,
  TOOL_POLICY,
} from "./tool-policy.js";
export type {
  AgentDirectoryToolName,
  BuiltinToolName,
  ChatOriginMode,
  ChatToolPolicyOptions,
  ConversationArchiveToolName,
  CustomToolName,
  DelegateToolName,
  ExecutionToolName,
  FileListToolName,
  HeritageToolName,
  LibrarianToolName,
  LongRunningTool,
  RemoteToolGroup,
  SecretToolName,
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
  avertirSiPromptLegerIncomplet,
  consigneEnvoiProgrammeAbsente,
  DELEGATION_INSTRUCTION,
  diagnostiquerPromptLeger,
  promptVide,
  DELEGATION_MARKER,
  HEAVY_NO_USER_MARKER,
  HEAVY_SECRET_MARKER,
  HEAVY_SYSTEM_PROMPT_FALLBACK,
  PROMPT_LIGHT_RESET_HINT,
  SCHEDULED_SEND_MARKER,
  SCHEDULED_SEND_REMINDER_MARKER,
  SECRET_REQUEST_MARKER,
  VOICE_SPEECH_INSTRUCTION,
} from "./prompts.js";
