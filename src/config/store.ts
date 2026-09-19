/**
 * Store de configuration (Lot 11).
 *
 * Fichier JSON unique, **sparse** (seules les valeurs saisies sont conservées,
 * ce qui distingue « défaut » de « saisi » et permet de restaurer un défaut en
 * supprimant la clé), écrit de façon **atomique** (`tmp` + `rename`) en mode
 * **0600**.
 *
 * Repli silencieux, sans jamais écraser : fichier absent → défauts ; JSON
 * invalide ou `schemaVersion` inconnue → défauts en mémoire + fichier conservé
 * tel quel. Le démarrage n'échoue JAMAIS à cause du store.
 *
 * À l'inverse, une **écriture** impossible (volume `state` non inscriptible,
 * disque plein…) lève une `ConfigStoreWriteError` explicite : la cause système
 * (`EACCES`, `EROFS`, `ENOSPC`…) est traduite, jamais un échec muet.
 *
 * Aucun import SDK/typebox.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Version de schéma du fichier de configuration. */
export const CONFIG_STORE_SCHEMA_VERSION = 1;

export type ConfigStoreSource = "file" | "absent" | "invalid";

export interface ConfigStoreLoad {
  /** Valeurs stockées (vides si fichier absent/invalide). */
  values: Record<string, unknown>;
  source: ConfigStoreSource;
  /** Motif du repli (fichier conservé) si `source === "invalid"`. */
  error?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Erreur d'écriture du store : la cause système est explicite et exploitable. */
export class ConfigStoreWriteError extends Error {
  override readonly name = "ConfigStoreWriteError";
  constructor(
    /** Chemin complet du fichier de store visé. */
    readonly path: string,
    /** Cause lisible (français), ex. « permission refusée ». */
    readonly reason: string,
    /** Code système Node (`EACCES`, `EROFS`…), si connu. */
    readonly code: string | undefined,
    cause: unknown,
  ) {
    super(`Impossible d'écrire la configuration (${reason}) dans ${path}.`, {
      cause,
    });
  }
}

/** Traduit un code d'erreur système Node en cause lisible (français). */
function writeReason(error: unknown): { reason: string; code: string | undefined } {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  const reasons: Record<string, string> = {
    EACCES: "permission refusée",
    EPERM: "permission refusée",
    EROFS: "système de fichiers en lecture seule",
    ENOSPC: "espace disque insuffisant",
    EDQUOT: "quota disque dépassé",
    ENOTDIR: "chemin invalide (un parent n'est pas un répertoire)",
    EEXIST: "le chemin est occupé par un autre fichier",
  };
  return { reason: (code !== undefined ? reasons[code] : undefined) ?? messageOf(error), code };
}

/** Accès fichier au store de configuration. */
export class ConfigStore {
  constructor(readonly path: string) {}

  /** Le fichier existe-t-il ? */
  exists(): boolean {
    return existsSync(this.path);
  }

  /** Charge le store. Ne lève jamais : replie sur les défauts au besoin. */
  load(): ConfigStoreLoad {
    if (!existsSync(this.path)) {
      return { values: {}, source: "absent" };
    }
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      return { values: {}, source: "invalid", error: messageOf(error) };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        values: {},
        source: "invalid",
        error: `JSON invalide : ${messageOf(error)}`,
      };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { values: {}, source: "invalid", error: "objet JSON attendu" };
    }
    const root = parsed as Record<string, unknown>;
    if (root.schemaVersion !== CONFIG_STORE_SCHEMA_VERSION) {
      return {
        values: {},
        source: "invalid",
        error: `schemaVersion inconnue (${JSON.stringify(root.schemaVersion)})`,
      };
    }
    const values = root.values;
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      return { values: {}, source: "invalid", error: "« values » absent ou invalide" };
    }
    return { values: { ...(values as Record<string, unknown>) }, source: "file" };
  }

  /**
   * Écrit le store de façon atomique et en 0600. Le dossier parent est créé au
   * besoin. Le `rename` sur le même système de fichiers garantit qu'un lecteur
   * ne voit jamais un fichier partiel.
   */
  write(values: Record<string, unknown>): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      const payload = `${JSON.stringify(
        { schemaVersion: CONFIG_STORE_SCHEMA_VERSION, values },
        null,
        2,
      )}\n`;
      writeFileSync(tmp, payload, { mode: 0o600 });
      try {
        chmodSync(tmp, 0o600);
      } catch {
        // Meilleur effort : la création avec `mode` a déjà tenté le 0600.
      }
      renameSync(tmp, this.path);
      try {
        chmodSync(this.path, 0o600);
      } catch {
        // Meilleur effort.
      }
    } catch (error) {
      const { reason, code } = writeReason(error);
      throw new ConfigStoreWriteError(this.path, reason, code, error);
    }
  }
}
