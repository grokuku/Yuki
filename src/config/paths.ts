/**
 * Résolution et vérification des points de montage.
 *
 * La persistance passe par des volumes nommés Docker (cibles fixes dans le
 * conteneur). Les chemins conteneur servent de cibles et sont sondés à
 * l'exécution pour produire l'état `volumes` du endpoint `/health`.
 */

import { accessSync, constants, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Env } from "./env.js";

export type MountId = "pi" | "workspace" | "models" | "state" | "voices";
export type MountMode = "rw" | "ro";

export interface MountPoint {
  id: MountId;
  containerPath: string;
  mode: MountMode;
}

export interface MountStatus extends MountPoint {
  exists: boolean;
  isDirectory: boolean;
  /** `true`/`false` si le point est sondable, `null` sinon (chemin absent). */
  writable: boolean | null;
}

/**
 * Résout le chemin du store de configuration.
 *
 * Par défaut sur le volume `state` (`/data/state/config.json`), surchargeable
 * par la variable de CÂBLAGE `YUKI_CONFIG_STORE_PATH`.
 */
export function resolveConfigStorePath(
  stateDir: string,
  override?: string,
): string {
  const trimmed = override?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : `${stateDir}/config.json`;
}

/** Définit les cinq points de montage (volumes nommés), dans un ordre stable. */
export function mountPoints(env: Env): MountPoint[] {
  return [
    {
      id: "pi",
      containerPath: env.mountPoints.pi,
      mode: "rw",
    },
    {
      id: "workspace",
      containerPath: env.mountPoints.workspace,
      mode: "rw",
    },
    {
      id: "models",
      containerPath: env.mountPoints.models,
      mode: "ro",
    },
    {
      id: "state",
      containerPath: env.mountPoints.state,
      mode: "rw",
    },
    // Lot 7 : les voix TTS (médias) sont isolées du store de configuration ;
    // le gateway les écrit, le service `tts` ne les lit qu'en ro.
    {
      id: "voices",
      containerPath: env.mountPoints.voices,
      mode: "rw",
    },
  ];
}

function canWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Sonde les chemins conteneur (les seuls visibles à l'exécution). */
export function inspectMountPoints(points: MountPoint[]): MountStatus[] {
  return points.map((point) => {
    let exists = false;
    let isDirectory = false;
    try {
      const info = statSync(point.containerPath);
      exists = true;
      isDirectory = info.isDirectory();
    } catch {
      exists = false;
      isDirectory = false;
    }
    let writable: boolean | null = null;
    if (exists && point.mode === "rw") {
      writable = canWrite(point.containerPath);
    }
    return { ...point, exists, isDirectory, writable };
  });
}

/**
 * Sonde une **écriture réelle** dans un répertoire (fichier temporaire créé puis
 * supprimé). Contrairement à `accessSync(W_OK)`, elle reflète vraiment ce que
 * le processus peut écrire — indispensable pour détecter TÔT un volume `state`
 * non inscriptible (bind mount appartenant à un autre uid/gid), qui ne se
 * manifesterait sinon qu'au premier Enregistrement de la page `/config`.
 */
export function probeWritable(path: string): {
  writable: boolean;
  error?: string;
} {
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    return {
      writable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const probe = join(path, `.yuki-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, "");
  } catch (error) {
    return {
      writable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    rmSync(probe, { force: true });
  } catch {
    // La sonde a réussi : un échec de nettoyage n'invalide pas le résultat.
  }
  return { writable: true };
}
