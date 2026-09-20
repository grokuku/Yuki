/**
 * Lecture et validation STRICTE de l'environnement (CÂBLAGE uniquement).
 *
 * Depuis le Lot 11, `Env` ne porte QUE le **câblage** (ports, chemins, identité,
 * montages, sources GPU, chemins Pi/jobs/store). Les champs configurables depuis
 * la page web (LLM, délégation, GPU, prompts, transport) vivent dans le
 * **store** (`src/config/store.ts`) et sont exposés par le runtime
 * (`src/config/runtime.ts`). Leur éventuelle **surcharge par l'environnement**
 * est lue via `readConfigEnvOverrides` (table unique `schema.ts`).
 *
 * Toute valeur présente mais invalide lève une `EnvError` explicite AVANT toute
 * autre action. Le catalogue complet des variables est documenté dans
 * `docs/lot11.md`.
 */

import type { LogLevel } from "../observability/logger.js";
import { resolveConfigStorePath } from "./paths.js";
import { CONFIG_SCHEMA } from "./schema.js";

export type { CompatMode, LlmMissingKeyMode, ThinkingLevel } from "./schema.js";
export { THINKING_LEVELS } from "./schema.js";

export interface MountPoints {
  pi: string;
  workspace: string;
  models: string;
  state: string;
  /** Volume dédié aux voix TTS (`yuki-voices`, Lot 7). */
  voices: string;
}

export interface Env {
  nodeEnv: string;
  version: string;
  logLevel: LogLevel;
  gatewayHost: string;
  gatewayPort: number;
  uid: number;
  gid: number;
  configDir: string;
  /** Fichier JSON du store de configuration (volume `state`). */
  configStorePath: string;
  /** Répertoire du registre des voix TTS (volume `yuki-voices`, Lot 7). */
  voicesDir: string;
  mountPoints: MountPoints;
  // --- Détection GPU (câblage) ---
  gpuCmd: string;
  gpuCmdFromEnv: boolean;
  gpuFixture: string | null;
  // --- Journal des jobs ---
  jobsStorePath: string;
  // --- Domaine Pi embarqué (Lot 1) ---
  piAgentDir: string;
  piSessionsDir: string;
  piHome: string;
  piCwd: string;
  piSystemPromptPath: string;
  piSettingsSeedPath: string;
  /** Prompt système dédié au worker lourd. */
  piHeavySystemPromptPath: string;
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

/**
 * Surcharges d'environnement des champs du store : ne retient que les variables
 * explicitement définies ET non vides (une variable vide n'est pas une
 * surcharge). La validation des valeurs est faite par le runtime (table unique).
 */
export function readConfigEnvOverrides(
  processEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, descriptor] of Object.entries(CONFIG_SCHEMA)) {
    if (!descriptor.env) continue;
    const raw = processEnv[descriptor.env];
    if (typeof raw === "string" && raw.trim() !== "") {
      out[path] = raw;
    }
  }
  return out;
}

/**
 * Charge et valide le câblage. Aucune variable n'est *requise* : toutes
 * disposent d'un défaut sûr.
 */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): Env {
  const configDir = getString(env, "YUKI_CONFIG_DIR", "./config");
  const mountPoints: MountPoints = {
    pi: getString(env, "YUKI_MOUNT_PI_AGENT", "/data/pi"),
    workspace: getString(env, "YUKI_MOUNT_WORKSPACE", "/workspace"),
    models: getString(env, "YUKI_MOUNT_MODELS", "/models"),
    state: getString(env, "YUKI_MOUNT_STATE", "/data/state"),
    voices: getString(env, "YUKI_MOUNT_VOICES", "/voices"),
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
    uid: getInt(env, "YUKI_UID", 1000, { min: 0 }),
    gid: getInt(env, "YUKI_GID", 1000, { min: 0 }),
    configDir,
    configStorePath: resolveConfigStorePath(
      mountPoints.state,
      readTrimmed(env, "YUKI_CONFIG_STORE_PATH"),
    ),
    voicesDir: getString(env, "YUKI_VOICES_DIR", mountPoints.voices),
    mountPoints,
    gpuCmd: getString(env, "YUKI_GPU_CMD", "nvidia-smi"),
    gpuCmdFromEnv: readTrimmed(env, "YUKI_GPU_CMD") !== undefined,
    gpuFixture: readTrimmed(env, "YUKI_GPU_FIXTURE") ?? null,
    jobsStorePath: getString(
      env,
      "YUKI_JOBS_STORE_PATH",
      `${mountPoints.state}/jobs.jsonl`,
    ),
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
    piHeavySystemPromptPath: getString(
      env,
      "YUKI_PI_HEAVY_SYSTEM_PROMPT",
      `${configDir}/pi/system-prompt-heavy.md`,
    ),
  };
}
