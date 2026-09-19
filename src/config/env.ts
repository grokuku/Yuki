/**
 * Lecture et validation STRICTE de l'environnement.
 *
 * Toute valeur présente mais invalide (entier attendu, énumération inconnue,
 * port hors bornes) lève une `EnvError` explicite AVANT toute autre action.
 * Le catalogue complet des variables est documenté dans `.env.example`.
 */

import type { LogLevel } from "../observability/logger.js";

export type CompatMode = "strict" | "auto-degrade";

/** Politique en cas de clé LLM manquante (aligné sur `src/llm/availability`). */
export type LlmMissingKeyMode = "degrade" | "refuse";

/** Niveaux de raisonnement acceptés (alignés sur le SDK Pi). */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface MountPoints {
  pi: string;
  workspace: string;
  models: string;
  state: string;
}

export interface Env {
  nodeEnv: string;
  version: string;
  logLevel: LogLevel;
  gatewayHost: string;
  gatewayPort: number;
  compatMode: CompatMode;
  profile: string | null;
  gpuCmd: string;
  gpuCmdFromEnv: boolean;
  gpuFixture: string | null;
  minDriver: number;
  uid: number;
  gid: number;
  configDir: string;
  mountPoints: MountPoints;
  // --- Domaine Pi embarqué (Lot 1) ---
  piAgentDir: string;
  piSessionsDir: string;
  piHome: string;
  piCwd: string;
  piSystemPromptPath: string;
  piSettingsSeedPath: string;
  /** Prompt système dédié au worker lourd. */
  piHeavySystemPromptPath: string;
  /** Seed de `models.json` (providers/modèles neutres `llm-light`/`llm-heavy`). */
  piModelsSeedPath: string;
  piModel: string | null;
  piThinking: ThinkingLevel | null;
  // --- Multi-LLM & jobs (Lot 2) ---
  llmMissingKeyMode: LlmMissingKeyMode;
  jobsStorePath: string;
  heavyMaxConcurrent: number;
  heavyMaxQueue: number;
  heavyIdleTimeoutMs: number;
  heavyTotalTimeoutMs: number;
  // --- Transport temps réel (Lot 1) ---
  wsReplayBuffer: number;
  wsReplayBytes: number;
}

export class EnvError extends Error {
  override readonly name = "EnvError";
}

function readTrimmed(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function getString(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: string,
): string {
  return readTrimmed(env, name) ?? fallback;
}

function getOptionalString(
  env: NodeJS.ProcessEnv,
  name: string,
): string | null {
  return readTrimmed(env, name) ?? null;
}

function getInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  bounds?: { min?: number; max?: number },
): number {
  const raw = readTrimmed(env, name);
  if (raw === undefined) return fallback;
  if (!/^-?\d+$/.test(raw)) {
    throw new EnvError(
      `Variable ${name} invalide : entier attendu, reçu ${JSON.stringify(raw)}`,
    );
  }
  const value = Number.parseInt(raw, 10);
  if (bounds?.min !== undefined && value < bounds.min) {
    throw new EnvError(
      `Variable ${name} invalide : valeur ${value} < minimum ${bounds.min}`,
    );
  }
  if (bounds?.max !== undefined && value > bounds.max) {
    throw new EnvError(
      `Variable ${name} invalide : valeur ${value} > maximum ${bounds.max}`,
    );
  }
  return value;
}

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function getLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = readTrimmed(env, "YUKI_LOG_LEVEL");
  if (raw === undefined) return "info";
  if (!(LOG_LEVELS as readonly string[]).includes(raw)) {
    throw new EnvError(
      `Variable YUKI_LOG_LEVEL invalide : attendu ${LOG_LEVELS.join(" | ")}, reçu ${JSON.stringify(raw)}`,
    );
  }
  return raw as LogLevel;
}

function getCompatMode(env: NodeJS.ProcessEnv): CompatMode {
  const raw = readTrimmed(env, "YUKI_COMPAT_MODE");
  if (raw === undefined) return "strict";
  if (raw !== "strict" && raw !== "auto-degrade") {
    throw new EnvError(
      `Variable YUKI_COMPAT_MODE invalide : attendu "strict" ou "auto-degrade", reçu ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

function getThinkingLevel(env: NodeJS.ProcessEnv): ThinkingLevel | null {
  const raw = readTrimmed(env, "YUKI_PI_THINKING");
  if (raw === undefined) return null;
  if (!(THINKING_LEVELS as readonly string[]).includes(raw)) {
    throw new EnvError(
      `Variable YUKI_PI_THINKING invalide : attendu ${THINKING_LEVELS.join(" | ")}, reçu ${JSON.stringify(raw)}`,
    );
  }
  return raw as ThinkingLevel;
}

function getLlmMissingKeyMode(env: NodeJS.ProcessEnv): LlmMissingKeyMode {
  const raw = readTrimmed(env, "YUKI_LLM_MISSING_KEY_MODE");
  if (raw === undefined) return "degrade";
  if (raw !== "degrade" && raw !== "refuse") {
    throw new EnvError(
      `Variable YUKI_LLM_MISSING_KEY_MODE invalide : attendu "degrade" ou "refuse", reçu ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * Charge et valide l'environnement.
 *
 * Aucune variable n'est *requise* au Lot 0 : toutes disposent d'un défaut
 * sûr. Le mécanisme d'exigence (`required`) est néanmoins prêt pour les lots
 * futurs (clés d'API, etc.).
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const configDir = getString(env, "YUKI_CONFIG_DIR", "./config");
  const mountPoints: MountPoints = {
    pi: getString(env, "YUKI_MOUNT_PI_AGENT", "/data/pi"),
    workspace: getString(env, "YUKI_MOUNT_WORKSPACE", "/workspace"),
    models: getString(env, "YUKI_MOUNT_MODELS", "/models"),
    state: getString(env, "YUKI_MOUNT_STATE", "/data/state"),
  };
  const piAgentDir = getString(
    env,
    "YUKI_PI_AGENT_DIR",
    `${mountPoints.pi}/agent`,
  );
  return {
    nodeEnv: getString(env, "NODE_ENV", "development"),
    version: getString(env, "YUKI_VERSION", "0.1.0"),
    logLevel: getLogLevel(env),
    gatewayHost: getString(env, "YUKI_GATEWAY_HOST", "0.0.0.0"),
    gatewayPort: getInt(env, "YUKI_GATEWAY_PORT", 8080, { min: 1, max: 65535 }),
    compatMode: getCompatMode(env),
    profile: getOptionalString(env, "YUKI_PROFILE"),
    gpuCmd: getString(env, "YUKI_GPU_CMD", "nvidia-smi"),
    gpuCmdFromEnv: readTrimmed(env, "YUKI_GPU_CMD") !== undefined,
    gpuFixture: getOptionalString(env, "YUKI_GPU_FIXTURE"),
    minDriver: getInt(env, "YUKI_MIN_DRIVER", 580, { min: 1 }),
    uid: getInt(env, "YUKI_UID", 1000, { min: 0 }),
    gid: getInt(env, "YUKI_GID", 1000, { min: 0 }),
    configDir,
    mountPoints,
    piAgentDir,
    piSessionsDir: getString(
      env,
      "YUKI_PI_SESSIONS_DIR",
      `${piAgentDir}/sessions`,
    ),
    piHome: getString(env, "YUKI_PI_HOME", `${mountPoints.pi}/home`),
    piCwd: getString(env, "YUKI_PI_CWD", mountPoints.workspace),
    piSystemPromptPath: getString(
      env,
      "YUKI_PI_SYSTEM_PROMPT",
      `${configDir}/pi/system-prompt.md`,
    ),
    piSettingsSeedPath: getString(
      env,
      "YUKI_PI_SETTINGS_SEED",
      `${configDir}/pi/settings.json`,
    ),
    piModelsSeedPath: getString(
      env,
      "YUKI_PI_MODELS_SEED",
      `${configDir}/pi/models.json`,
    ),
    piHeavySystemPromptPath: getString(
      env,
      "YUKI_PI_HEAVY_SYSTEM_PROMPT",
      `${configDir}/pi/system-prompt-heavy.md`,
    ),
    piModel: getOptionalString(env, "YUKI_PI_MODEL"),
    piThinking: getThinkingLevel(env),
    llmMissingKeyMode: getLlmMissingKeyMode(env),
    jobsStorePath: getString(
      env,
      "YUKI_JOBS_STORE_PATH",
      `${mountPoints.state}/jobs.jsonl`,
    ),
    heavyMaxConcurrent: getInt(env, "YUKI_HEAVY_MAX_CONCURRENT", 3, { min: 1 }),
    heavyMaxQueue: getInt(env, "YUKI_HEAVY_MAX_QUEUE", 10, { min: 0 }),
    heavyIdleTimeoutMs: getInt(env, "YUKI_HEAVY_IDLE_TIMEOUT_MS", 120_000, {
      min: 1,
    }),
    heavyTotalTimeoutMs: getInt(env, "YUKI_HEAVY_TOTAL_TIMEOUT_MS", 1_200_000, {
      min: 1,
    }),
    wsReplayBuffer: getInt(env, "YUKI_WS_REPLAY_BUFFER", 1000, { min: 1 }),
    wsReplayBytes: getInt(env, "YUKI_WS_REPLAY_BYTES", 5_000_000, { min: 1 }),
  };
}
