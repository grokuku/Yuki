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
      // Lot 9 (M1) : le gateway monte `/models` en `rw` (lecture des GGUF +
      // écriture FUTURE des téléchargements, rangés sous `<models>/downloads/`).
      // ⚠️ Le moteur `tts` monte, lui, le MÊME dossier en `ro` : seul le
      // gateway peut écrire. Voir `docs/lot9.md` (D46/D60).
      mode: "rw",
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

/** Résultat d'une sonde d'écriture. Sur échec, la cause système est conservée. */
export interface WriteProbe {
  writable: boolean;
  /** Message brut de l'erreur système Node, si l'écriture a échoué. */
  error?: string;
  /** Code système Node (`EROFS`, `EACCES`, `EPERM`, `ENOENT`…), si disponible. */
  code?: string;
}

/** Extrait le code système (`errno`) d'une erreur Node, sans jamais lever. */
function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/** Contexte d'un échec de sonde, pour un conseil EXACT selon la cause réelle. */
export interface WriteFailureContext {
  /** Identifiant du volume sondé (ex. « models »), tel qu'affiché par `/health`. */
  volume: string;
  /** Chemin conteneur sondé (ex. « /models »). */
  path: string;
  /** Code système Node (`EROFS`, `EACCES`, `EPERM`, `ENOENT`…), si connu. */
  code?: string;
  /** Nom du service Compose où intervenir (défaut « gateway »). */
  service?: string;
}

/**
 * Traduit l'échec d'une sonde d'écriture en un conseil FRANÇAIS **exact selon
 * la cause réelle**, sans jamais inventer de cause :
 *   - `EROFS`          → montage en LECTURE SEULE (retirer `:ro` du compose) ;
 *   - `EACCES`/`EPERM` → permissions (uid/gid du conteneur) ;
 *   - `ENOENT`         → volume/dossier absent ;
 *   - `ENOTDIR`/`EISDIR` → chemin qui n'est pas un répertoire exploitable ;
 *   - tout autre code  → message honnête citant le code brut, sans cause supposée.
 *
 * Le message nomme le volume, son chemin et le service Compose où intervenir.
 */
export function describeWriteFailure(context: WriteFailureContext): string {
  const service = context.service?.trim() || "gateway";
  const where = `le volume « ${context.volume} » (chemin « ${context.path} »)`;
  const Where = where.charAt(0).toUpperCase() + where.slice(1);
  switch (context.code) {
    case "EROFS":
      return (
        `${Where} est monté en LECTURE SEULE. Retirez « :ro » du volume correspondant ` +
        `dans le service « ${service} » du compose (variante bind), ` +
        "ou vérifiez qu'il n'est pas monté en lecture seule."
      );
    case "EACCES":
    case "EPERM":
      return (
        `Permissions insuffisantes sur ${where} : sur un bind mount, donnez-le à ` +
        `l'uid/gid du conteneur (« chown 1000:1000 ») puis redémarrez le service « ${service} ».`
      );
    case "ENOENT":
      return (
        `${Where} est absent : déclarez le volume dans le service « ${service} » du ` +
        "compose (ou créez le dossier hôte d'un bind mount) avant de démarrer."
      );
    case "ENOTDIR":
    case "EISDIR":
      return (
        `${Where} n'est pas un répertoire exploitable : corrigez le chemin ou le ` +
        `montage du service « ${service} » dans le compose.`
      );
    default:
      return (
        `Écriture impossible dans ${where} — code système « ${context.code ?? "inconnu"} » : ` +
        "la cause n'est pas déterminable à partir de ce code ; inspectez le montage et " +
        `les permissions du service « ${service} » du compose.`
      );
  }
}

/**
 * Sonde une **écriture réelle** dans un répertoire (fichier temporaire créé puis
 * supprimé). Contrairement à `accessSync(W_OK)`, elle reflète vraiment ce que
 * le processus peut écrire — indispensable pour détecter TÔT un volume `state`
 * non inscriptible (bind mount appartenant à un autre uid/gid), qui ne se
 * manifesterait sinon qu'au premier Enregistrement de la page `/config`.
 *
 * La **logique** de sonde est inchangée ; en cas d'échec, le **code système**
 * est en plus remonté, pour permettre un diagnostic exact (`describeWriteFailure`).
 */
export function probeWritable(path: string): WriteProbe {
  const failure = (error: unknown): WriteProbe => {
    const code = errorCode(error);
    return {
      writable: false,
      error: error instanceof Error ? error.message : String(error),
      ...(code ? { code } : {}),
    };
  };
  try {
    mkdirSync(path, { recursive: true });
  } catch (error) {
    return failure(error);
  }
  const probe = join(path, `.yuki-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, "");
  } catch (error) {
    return failure(error);
  }
  try {
    rmSync(probe, { force: true });
  } catch {
    // La sonde a réussi : un échec de nettoyage n'invalide pas le résultat.
  }
  return { writable: true };
}
