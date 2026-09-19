/**
 * Configuration du domaine Pi embarqué.
 *
 * Responsabilités :
 *  - résoudre les chemins (agentDir, cwd, HOME, sessions) ;
 *  - vérifier que l'état tient sur un volume inscriptible malgré un rootfs
 *    read-only (garde-fou explicite, échec bruyant) ;
 *  - seeder `settings.json` sur le volume au premier démarrage, puis ne plus
 *    jamais l'écraser ;
 *  - écrire `models.json` de façon atomique depuis la configuration effective
 *    (généré au démarrage — plus de seed copie-si-absent depuis le Lot 11) ;
 *  - positionner les variables d'environnement reconnues par le SDK
 *    (`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE`,
 *    `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`) et un `HOME` inscriptible.
 *
 * Les noms de variables du SDK sont ceux documentés dans
 * `@earendil-works/pi-coding-agent/docs/environment-variables.md`.
 */

import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { PiHostError } from "./errors.js";
import type { PiLogger } from "./types.js";

export interface PiConfigInput {
  agentDir: string;
  cwd: string;
  home: string;
  sessionsDir?: string;
  settingsSeedPath?: string;
}

export interface PiPaths {
  agentDir: string;
  cwd: string;
  home: string;
  sessionsDir: string;
  /** Fichier de réglages global du SDK (dans agentDir). */
  settingsPath: string;
  /** Source de seed (dans l'image, lecture seule). Peut être absente. */
  settingsSeedPath?: string;
  /** Fichier de modèles/config providers (dans agentDir). */
  modelsPath: string;
}

function absolute(path: string, base: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

/** Résout les chemins du domaine Pi. */
export function resolvePiPaths(
  input: PiConfigInput,
  base: string = process.cwd(),
): PiPaths {
  const agentDir = absolute(input.agentDir, base);
  return {
    agentDir,
    cwd: absolute(input.cwd, base),
    home: absolute(input.home, base),
    sessionsDir: input.sessionsDir
      ? absolute(input.sessionsDir, base)
      : join(agentDir, "sessions"),
    settingsPath: join(agentDir, "settings.json"),
    ...(input.settingsSeedPath
      ? { settingsSeedPath: absolute(input.settingsSeedPath, base) }
      : {}),
    modelsPath: join(agentDir, "models.json"),
  };
}

function ensureWritableDir(path: string, label: string): void {
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    throw new PiHostError(
      "PI_RESOURCE_ERROR",
      `Impossible de créer ${label} (${path}) : le volume est-il monté inscriptible ?`,
      { cause: error },
    );
  }
  try {
    const info = statSync(path);
    if (!info.isDirectory()) {
      throw new Error("not a directory");
    }
    accessSync(path, constants.W_OK);
  } catch (error) {
    throw new PiHostError(
      "PI_RESOURCE_ERROR",
      `${label} (${path}) n'est pas un répertoire inscriptible — rootfs read-only sans volume ?`,
      { cause: error },
    );
  }
}

/**
 * Garantit l'existence et l'écriture possible de tout l'état Pi sur le volume.
 * Échoue AVANT toute création de session avec un code stable.
 */
export function ensurePiLayout(paths: PiPaths): void {
  ensureWritableDir(paths.agentDir, "agentDir");
  ensureWritableDir(paths.home, "HOME");
  ensureWritableDir(paths.sessionsDir, "sessionsDir");
  ensureWritableDir(paths.cwd, "cwd");
}

export interface SeedResult {
  seeded: boolean;
  reason?: "created" | "already-present" | "no-seed";
}

/**
 * Copie un fichier de seed depuis l'image si — et seulement si — le fichier du
 * volume est absent. Un fichier existant n'est JAMAIS réécrit.
 */
function seedCopyIfAbsent(
  targetPath: string,
  seedPath: string | undefined,
  label: string,
  logMessage: string,
  logger?: PiLogger,
): SeedResult {
  if (existsSync(targetPath)) {
    return { seeded: false, reason: "already-present" };
  }
  if (!seedPath || !existsSync(seedPath)) {
    return { seeded: false, reason: "no-seed" };
  }
  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(seedPath, targetPath);
  } catch (error) {
    throw new PiHostError(
      "PI_RESOURCE_ERROR",
      `Impossible de seeder ${label} vers ${targetPath}.`,
      { cause: error },
    );
  }
  logger?.info(logMessage, { path: targetPath, from: seedPath });
  return { seeded: true, reason: "created" };
}

/**
 * Seed `settings.json` depuis l'image si — et seulement si — le fichier du
 * volume est absent. Un fichier existant n'est JAMAIS réécrit.
 */
export function seedSettingsFile(
  paths: PiPaths,
  logger?: PiLogger,
): SeedResult {
  return seedCopyIfAbsent(
    paths.settingsPath,
    paths.settingsSeedPath,
    "les réglages Pi",
    "pi.settings.seeded",
    logger,
  );
}

/**
 * Écrit `models.json` de façon **atomique** (`tmp` + `rename`), TOUJOURS
 * réécrit. Depuis le Lot 11, ce fichier est **généré** depuis la configuration
 * effective : plus aucun seed copie-si-absent (qui obligeait à éditer un
 * fichier dans un volume pour changer de fournisseur).
 *
 * Les clés n'y figurent JAMAIS : seules des références `$YUKI_LLM_*_API_KEY`.
 */
export function writeModelsFile(
  paths: PiPaths,
  modelsConfig: unknown,
  logger?: PiLogger,
): void {
  try {
    mkdirSync(dirname(paths.modelsPath), { recursive: true });
    const tmp = `${paths.modelsPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(modelsConfig, null, 2)}\n`, "utf8");
    renameSync(tmp, paths.modelsPath);
  } catch (error) {
    throw new PiHostError(
      "PI_RESOURCE_ERROR",
      `Impossible d'écrire models.json vers ${paths.modelsPath}.`,
      { cause: error },
    );
  }
  logger?.info("pi.models.written", { path: paths.modelsPath });
}

/**
 * Variables d'environnement lues par le SDK. Elles redirigent l'état hors du
 * rootfs et coupent les opérations réseau de démarrage.
 */
export const PI_SDK_ENV: Readonly<Record<string, string>> = {
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
};

/**
 * Applique l'environnement Pi au process. Renvoie une fonction de restauration
 * (utile aux tests) qui remet les valeurs précédentes.
 */
export function applyPiEnvironment(
  paths: PiPaths,
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const variables: Record<string, string> = {
    ...PI_SDK_ENV,
    PI_CODING_AGENT_DIR: paths.agentDir,
    PI_CODING_AGENT_SESSION_DIR: paths.sessionsDir,
    HOME: paths.home,
  };
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(variables)) {
    previous.set(key, env[key]);
    env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete env[key];
      } else {
        env[key] = value;
      }
    }
  };
}
