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
import {
  CONVERSATION_ARCHIVE_DIR_NAME,
  CONVERSATION_ARCHIVE_INDEX_FILE,
} from "../memory/conversation-archive.js";
import { CONTAINER_PATHS } from "./container-paths.js";
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
  // --- Mémoire durable (Lot 12) ---
  /** Fichier JSONL de mémoire (journal append-only, lisible à la main). */
  memoryStorePath: string;
  /** Fichier SQLite de l'index FTS5 (DÉRIVÉ, reconstructible). */
  memoryIndexPath: string;
  /**
   * Dossier de l'archive « vie antérieure » (volume `state`, Lot 13) : séparé du
   * store de mémoire, jamais fusionné. Surcharge : `YUKI_HERITAGE_DIR`.
   */
  heritageDir: string;
  /**
   * Dossier de l'ARCHIVE des conversations mises de côté (volume `state`) :
   * une conversation = un fichier JSON complet, JAMAIS injecté dans le prompt.
   * Surcharge : `YUKI_CONVERSATION_ARCHIVE_DIR`.
   */
  conversationArchiveDir: string;
  /**
   * Fichier SQLite de l'index FTS5 de cette archive (DÉRIVÉ, reconstructible).
   * Surcharge : `YUKI_CONVERSATION_ARCHIVE_INDEX_PATH`.
   */
  conversationArchiveIndexPath: string;
  // --- Agents d'exécution (Lot 4) ---
  /** Fichier JSONL du store des agents (journal append-only, volume `state`). */
  agentsStorePath: string;
  /** Fichier JSONL du journal d'audit des exécutions (volume `state`). */
  auditLogPath: string;
  /**
   * Fichier JSON du COFFRE DE SECRETS chiffré (volume `state`, 0600). ⚠️ Ne
   * contient que des entrées CHIFFRÉES (AES-256-GCM) : la clé maître n'y est
   * JAMAIS rangée, elle vient de `YUKI_VAULT_KEY` (hors bande). Surcharge :
   * `YUKI_SECRETS_VAULT_PATH`.
   */
  secretsVaultPath: string;
  /**
   * Fichier JSON du MOT DE PASSE D'INSTANCE (volume `state`, 0600). ⚠️ Ne
   * contient qu'un HACHÉ scrypt + un sel : jamais la valeur en clair. Sert au
   * déverrouillage des agents « matériel sensible » (et, plus tard, à un éventuel
   * déverrouillage applicatif global). Surcharge :
   * `YUKI_INSTANCE_PASSWORD_PATH`.
   */
  instancePasswordPath: string;
  /**
   * Fichier JSONL des jobs d'ARCHIVAGE du libraire (volume `state`). Séparé de
   * `jobsStorePath` (délégation) pour ne pas mêler les deux espaces de noms.
   * Surcharge : `YUKI_LIBRARIAN_JOBS_PATH`.
   */
  librarianJobsPath: string;
  /**
   * Répertoire des CAPTURES de pages web obtenues via Libry (volume `state`).
   * Sert la route same-origin `/captures/<id>.<ext>`. Surcharge :
   * `YUKI_LIBRARIAN_SHOTS_DIR`.
   */
  librarianShotsDir: string;
  /**
   * Fichier JSON des conversations ÉPINGLÉES (volume `state`). Séparé du SDK Pi :
   * on n'écrit jamais de champ maison dans le JSONL d'une session. Surcharge :
   * `YUKI_SESSION_PINS_PATH`.
   */
  sessionPinsPath: string;
  /**
   * Journal JSONL des RÉACTIONS de l'utilisateur aux messages de Yuki (volume
   * `state`). ⚠️ Séparé du JSONL de session (propriété du SDK) ET de la mémoire
   * durable : une réaction n'est ni un message ni un souvenir. Surcharge :
   * `YUKI_REACTIONS_STORE_PATH`.
   */
  reactionsStorePath: string;
  /**
   * Répertoire des FICHIERS échangés avec l'utilisateur (volume `state`).
   * `POST /api/files` y dépose les octets, `/fichiers/<id>.<ext>` les sert.
   * ⚠️ MÊME volume que la configuration, la mémoire et les sessions : c'est
   * pourquoi le plafond de taille existe. Surcharge : `YUKI_FILES_DIR`.
   */
  filesDir: string;
  /**
   * Fichier JSON des WORKFLOWS ComfyUI nommés (volume `state`). ⚠️ Fichier
   * SÉPARÉ de `config.json` : un graphe pèse des dizaines de Ko et l'API de
   * configuration ne renvoie jamais un graphe. Surcharge :
   * `YUKI_COMFY_WORKFLOWS_PATH`.
   */
  comfyWorkflowsPath: string;
  /**
   * Répertoire des IMAGES générées par ComfyUI (volume `state`). Servies en
   * same-origin (`/images/<id>.<ext>`), comme les captures de pages web.
   * Surcharge : `YUKI_COMFY_IMAGES_DIR`.
   */
  comfyImagesDir: string;
  /**
   * Fichier JSON des clés VAPID (volume `state`, 0600). ⚠️ Contient la clé
   * PRIVÉE : jamais exposé, jamais journalisé. Surcharge : `YUKI_PUSH_VAPID_PATH`.
   */
  pushVapidPath: string;
  /**
   * Fichier JSON des ABONNEMENTS push par appareil (volume `state`, 0600).
   * Données TECHNIQUES, jamais mêlées au transcript ni à la mémoire. Surcharge :
   * `YUKI_PUSH_SUBSCRIPTIONS_PATH`.
   */
  pushSubscriptionsPath: string;
  // --- Personnalité de Yuki ---
  /**
   * Fichier Markdown de la personnalité (volume `state`), SÉPARÉ du prompt
   * système de sûreté. Historique et journal sont dérivés de son dossier.
   * Surcharge : `YUKI_PERSONALITY_PATH`.
   */
  personalityPath: string;
  // --- Règles strictes de Yuki (éditées par l'utilisateur) ---
  /**
   * Fichier Markdown des règles strictes (volume `state`), VOISIN de
   * `personality.md` mais DISTINCT (l'utilisateur seul les édite ; Yuki ne les
   * modifie jamais). Historique et journal sont dérivés de son dossier.
   * Surcharge : `YUKI_RULES_PATH`.
   */
  rulesPath: string;
  // --- Configuration du moteur TTS `audio.cpp` (Lot 9) ---
  /**
   * Dossier de configuration du moteur, VU PAR LE GATEWAY (montage `rw`).
   * Le fichier `<dir>/server.json` y est lu ET écrit (atomicité). Il est monté
   * en `ro` sur `ttsEngineConfigMountDir` côté service `tts`.
   */
  ttsEngineConfigDir: string;
  /** Chemin du dossier de configuration tel que VU PAR LE MOTEUR (défaut `/config`). */
  ttsEngineConfigMountDir: string;
  /** Chemin du dossier des modèles tel que VU PAR LE MOTEUR (défaut `mountPoints.models`). */
  ttsEngineModelsDir: string;
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
  // ⚠️ Cibles de montage = défauts du code (`CONTAINER_PATHS`), surchargeables
  // par variable pour les déploiements existants, mais JAMAIS définies dans les
  // composes (voir `src/config/container-paths.ts`, `docs/lot9.md` D61).
  const mountPoints: MountPoints = {
    pi: getString(env, "YUKI_MOUNT_PI_AGENT", CONTAINER_PATHS.pi),
    workspace: getString(env, "YUKI_MOUNT_WORKSPACE", CONTAINER_PATHS.workspace),
    models: getString(env, "YUKI_MOUNT_MODELS", CONTAINER_PATHS.models),
    state: getString(env, "YUKI_MOUNT_STATE", CONTAINER_PATHS.state),
    voices: getString(env, "YUKI_MOUNT_VOICES", CONTAINER_PATHS.voices),
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
    ttsEngineConfigDir: getString(
      env,
      "YUKI_TTS_CONFIG_DIR",
      CONTAINER_PATHS.ttsConfigDir,
    ),
    ttsEngineConfigMountDir: getString(
      env,
      "YUKI_TTS_ENGINE_CONFIG_DIR",
      CONTAINER_PATHS.ttsEngineConfigDir,
    ),
    ttsEngineModelsDir: getString(
      env,
      "YUKI_TTS_ENGINE_MODELS_DIR",
      mountPoints.models,
    ),
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
    memoryStorePath: getString(
      env,
      "YUKI_MEMORY_STORE_PATH",
      `${mountPoints.state}/memory.jsonl`,
    ),
    memoryIndexPath: getString(
      env,
      "YUKI_MEMORY_INDEX_PATH",
      `${mountPoints.state}/memory-index.sqlite`,
    ),
    heritageDir: getString(
      env,
      "YUKI_HERITAGE_DIR",
      `${mountPoints.state}/memory-heritage`,
    ),
    conversationArchiveDir: getString(
      env,
      "YUKI_CONVERSATION_ARCHIVE_DIR",
      `${mountPoints.state}/${CONVERSATION_ARCHIVE_DIR_NAME}`,
    ),
    conversationArchiveIndexPath: getString(
      env,
      "YUKI_CONVERSATION_ARCHIVE_INDEX_PATH",
      `${mountPoints.state}/${CONVERSATION_ARCHIVE_INDEX_FILE}`,
    ),
    agentsStorePath: getString(
      env,
      "YUKI_AGENTS_STORE_PATH",
      `${mountPoints.state}/agents.jsonl`,
    ),
    auditLogPath: getString(
      env,
      "YUKI_AUDIT_LOG_PATH",
      `${mountPoints.state}/audit.jsonl`,
    ),
    secretsVaultPath: getString(
      env,
      "YUKI_SECRETS_VAULT_PATH",
      `${mountPoints.state}/secrets.vault.json`,
    ),
    instancePasswordPath: getString(
      env,
      "YUKI_INSTANCE_PASSWORD_PATH",
      `${mountPoints.state}/instance-password.json`,
    ),
    librarianJobsPath: getString(
      env,
      "YUKI_LIBRARIAN_JOBS_PATH",
      `${mountPoints.state}/librarian-jobs.jsonl`,
    ),
    librarianShotsDir: getString(
      env,
      "YUKI_LIBRARIAN_SHOTS_DIR",
      `${mountPoints.state}/librarian-shots`,
    ),
    sessionPinsPath: getString(
      env,
      "YUKI_SESSION_PINS_PATH",
      `${mountPoints.state}/session-pins.json`,
    ),
    reactionsStorePath: getString(
      env,
      "YUKI_REACTIONS_STORE_PATH",
      `${mountPoints.state}/reactions.jsonl`,
    ),
    filesDir: getString(env, "YUKI_FILES_DIR", `${mountPoints.state}/files`),
    comfyWorkflowsPath: getString(
      env,
      "YUKI_COMFY_WORKFLOWS_PATH",
      `${mountPoints.state}/comfy/workflows.json`,
    ),
    comfyImagesDir: getString(
      env,
      "YUKI_COMFY_IMAGES_DIR",
      `${mountPoints.state}/comfy/images`,
    ),
    pushVapidPath: getString(
      env,
      "YUKI_PUSH_VAPID_PATH",
      `${mountPoints.state}/push-vapid.json`,
    ),
    pushSubscriptionsPath: getString(
      env,
      "YUKI_PUSH_SUBSCRIPTIONS_PATH",
      `${mountPoints.state}/push-subscriptions.json`,
    ),
    personalityPath: getString(
      env,
      "YUKI_PERSONALITY_PATH",
      `${mountPoints.state}/personality.md`,
    ),
    rulesPath: getString(
      env,
      "YUKI_RULES_PATH",
      `${mountPoints.state}/rules.md`,
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
