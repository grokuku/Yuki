/**
 * Résolution et vérification des points de montage.
 *
 * La persistance passe par des volumes nommés Docker (cibles fixes dans le
 * conteneur). Les chemins conteneur servent de cibles et sont sondés à
 * l'exécution pour produire l'état `volumes` du endpoint `/health`.
 */

import { accessSync, constants, statSync } from "node:fs";

import type { Env } from "./env.js";

export type MountId = "pi" | "workspace" | "models" | "state";
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

/** Définit les quatre points de montage (volumes nommés), dans un ordre stable. */
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
