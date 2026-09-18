/**
 * Fabrique de sessions SDK (confidentiel — `src/pi/sdk/**` uniquement).
 *
 * - `createLightRuntime` : runtime de la session LÉGÈRE persistante, avec
 *   l'allowlist d'outils et les outils custom injectés par le câblage.
 * - `createEphemeralSession` : session EN MÉMOIRE pour un job lourd (une tâche =
 *   une session = un prompt = une réponse ⇒ aucune fuite de contexte).
 */

import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SettingsManager,
  SessionManager,
  type AgentSession,
  type AgentSessionRuntime,
  type AgentSessionRuntimeDiagnostic,
  type CreateAgentSessionRuntimeFactory,
  type CreateAgentSessionRuntimeResult,
  type CreateAgentSessionServicesOptions,
  type ModelRuntime,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { PiLogger } from "../types.js";
import type { SdkModel, SdkThinkingLevel } from "./model-runtime.js";

type ResourceLoaderOptions = NonNullable<
  CreateAgentSessionServicesOptions["resourceLoaderOptions"]
>;

function buildResourceLoaderOptions(
  systemPrompt: string,
): ResourceLoaderOptions {
  return {
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    // Aucun fichier AGENTS.md ne doit s'inviter dans le prompt système.
    agentsFilesOverride: () => ({ agentsFiles: [] }),
  };
}

function toolOptions(
  tools: readonly string[] | undefined,
  customTools: readonly ToolDefinition[] | undefined,
): {
  tools?: string[];
  noTools?: "all";
  customTools?: ToolDefinition[];
} {
  const options: {
    tools?: string[];
    noTools?: "all";
    customTools?: ToolDefinition[];
  } = {};
  if (tools && tools.length > 0) {
    options.tools = [...tools];
  } else {
    // Aucune allowlist fournie : on n'expose AUCUN outil (jamais les builtins
    // par défaut, qui incluent write/edit/bash).
    options.noTools = "all";
  }
  if (customTools && customTools.length > 0) {
    options.customTools = [...customTools];
  }
  return options;
}

export interface LightRuntimeOptions {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  modelRuntime: ModelRuntime;
  sessionManager: SessionManager;
  systemPrompt: string;
  model?: SdkModel;
  thinkingLevel?: SdkThinkingLevel;
  tools?: readonly string[];
  customTools?: readonly ToolDefinition[];
}

/** Construit le runtime de la session légère (runtime remplaçable par le SDK). */
export async function createLightRuntime(
  options: LightRuntimeOptions,
): Promise<AgentSessionRuntime> {
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    sessionManager,
  }): Promise<CreateAgentSessionRuntimeResult> => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: options.agentDir,
      settingsManager: options.settingsManager,
      modelRuntime: options.modelRuntime,
      resourceLoaderOptions: buildResourceLoaderOptions(options.systemPrompt),
    });
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(options.model ? { model: options.model } : {}),
      ...(options.thinkingLevel
        ? { thinkingLevel: options.thinkingLevel }
        : {}),
      ...toolOptions(options.tools, options.customTools),
    });
    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };

  return createAgentSessionRuntime(createRuntime, {
    cwd: options.cwd,
    agentDir: options.agentDir,
    sessionManager: options.sessionManager,
  });
}

export interface EphemeralSessionOptions {
  cwd: string;
  agentDir: string;
  systemPrompt: string;
  modelRuntime: ModelRuntime;
  settingsManager?: SettingsManager;
  model?: SdkModel;
  thinkingLevel?: SdkThinkingLevel;
  tools?: readonly string[];
  customTools?: readonly ToolDefinition[];
  logger?: PiLogger;
}

export interface EphemeralSession {
  session: AgentSession;
  diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Ouvre une session EN MÉMOIRE (jamais persistée) destinée à un job lourd.
 * Le prompt système est dédié ; `AGENTS.md` est vidé ; le cwd est celui de la
 * session légère (`/workspace`).
 */
export async function createEphemeralSession(
  options: EphemeralSessionOptions,
): Promise<EphemeralSession> {
  const settingsManager =
    options.settingsManager ??
    SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 },
    });
  const services = await createAgentSessionServices({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    modelRuntime: options.modelRuntime,
    resourceLoaderOptions: buildResourceLoaderOptions(options.systemPrompt),
  });
  const result = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(options.cwd),
    ...(options.model ? { model: options.model } : {}),
    ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    ...toolOptions(options.tools, options.customTools),
  });
  return { session: result.session, diagnostics: services.diagnostics };
}
