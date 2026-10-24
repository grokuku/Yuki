/**
 * Mot de passe d'INSTANCE — haché (scrypt + sel), persisté sur le volume `state`.
 *
 * ## Pourquoi ce nom NEUTRE
 *
 * Le premier usage est le DÉVERROUILLAGE des agents « matériel sensible »
 * (`src/agents/lock.ts`) : il n'y a qu'UN mot de passe pour toute l'instance
 * (décision utilisateur), pas un par agent. Le stockage est donc volontairement
 * GÉNÉRIQUE (`InstancePasswordStore`, fichier `instance-password.json`) : il
 * pourra servir demain de déverrouillage applicatif global SANS migration ni
 * second fichier. Aucun nom lié aux agents ici.
 *
 * ## Modèle de sécurité
 *
 * - **Jamais de valeur en clair** : le fichier ne contient qu'un HACHÉ scrypt
 *   (KDF du coffre, `src/secrets/vault.ts` : `deriveScryptKey` — source unique,
 *   aucun second KDF) et un SEL ALÉATOIRE tiré à chaque changement.
 * - Comparaison en TEMPS CONSTANT (`timingSafeEqual`).
 * - Écriture **atomique** (`tmp` + `rename`) et mode **0600**.
 * - ⚠️ Le mot de passe n'est JAMAIS renvoyé par l'API (seulement
 *   « défini / pas défini » + la date), JAMAIS journalisé, JAMAIS dans le
 *   contexte du modèle : ce module ne reçoit un logger que pour des CODES.
 * - ⚠️ Il n'y a PAS de récupération : un mot de passe perdu ne se retrouve pas
 *   (on peut seulement le REMPLACER en fournissant l'ancien — ou repartir d'un
 *   fichier vierge, ce qui n'est possible qu'avec un accès au volume `state`).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  deriveScryptKey,
  randomSalt,
  SCRYPT_DEFAULTS,
  type ScryptParams,
} from "../secrets/vault.js";

/** Version de schéma du fichier de mot de passe d'instance. */
export const INSTANCE_PASSWORD_SCHEMA_VERSION = 1;

/**
 * Longueur MINIMALE acceptée. 8 caractères : en dessous, le hachage scrypt ne
 * protège plus grand-chose (l'espace des mots de passe courts est épuisable).
 */
export const INSTANCE_PASSWORD_MIN_LENGTH = 8;

/** Longueur MAXIMALE acceptée (borne anti-abus mémoire, scrypt est linéaire). */
export const INSTANCE_PASSWORD_MAX_LENGTH = 1024;

/** Longueur du haché (octets) — 32 octets = 256 bits, comme la clé du coffre. */
const HASH_LEN = 32;

interface StoredPasswordFile {
  schemaVersion: number;
  algorithm: "scrypt";
  kdf: ScryptParams;
  /** Haché scrypt (base64) — ⚠️ jamais la valeur. */
  hash: string;
  updatedAt: string;
}

/** Vue PUBLIQUE (jamais le haché, jamais la valeur). */
export interface InstancePasswordView {
  /** `true` si un mot de passe d'instance est défini. */
  configured: boolean;
  /** Date du dernier changement (ISO 8601), absente si aucun mot de passe. */
  updatedAt?: string;
}

export type InstancePasswordErrorCode =
  | "password_too_short"
  | "password_too_long"
  | "password_missing"
  | "password_mismatch"
  | "password_not_set"
  | "password_io"
  | "password_file_invalid";

/** Erreur explicite du mot de passe d'instance (message déjà destiné à l'humain). */
export class InstancePasswordError extends Error {
  override readonly name = "InstancePasswordError";
  constructor(
    readonly code: InstancePasswordErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface InstancePasswordLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface InstancePasswordStoreOptions {
  path: string;
  logger?: InstancePasswordLogger;
  /** Horloge injectable (tests) — défaut `Date.now`. */
  now?: () => number;
}

function assertLength(password: unknown): string {
  if (typeof password !== "string" || password.length === 0) {
    throw new InstancePasswordError(
      "password_missing",
      "Mot de passe d'instance : valeur requise.",
    );
  }
  if (password.length < INSTANCE_PASSWORD_MIN_LENGTH) {
    throw new InstancePasswordError(
      "password_too_short",
      `Mot de passe d'instance trop court : ${INSTANCE_PASSWORD_MIN_LENGTH} ` +
        "caractères minimum.",
    );
  }
  if (password.length > INSTANCE_PASSWORD_MAX_LENGTH) {
    throw new InstancePasswordError(
      "password_too_long",
      `Mot de passe d'instance trop long : ${INSTANCE_PASSWORD_MAX_LENGTH} ` +
        "caractères maximum.",
    );
  }
  return password;
}

/**
 * Dérive le haché d'un mot de passe (scrypt du coffre, sel fourni).
 * Exporté pour que les TESTS puissent vérifier le format stocké sans jamais
 * manipuler de valeur en clair ailleurs dans le code.
 */
export function hashInstancePassword(
  password: string,
  kdf: ScryptParams,
): string {
  return deriveScryptKey(password, kdf, HASH_LEN).toString("base64");
}

/**
 * Store du mot de passe d'instance. `open` ne lève pas quand le fichier est
 * absent (mot de passe non défini) ; il lève si le fichier est ILLISIBLE ou
 * d'un format inattendu (jamais de repli silencieux sur « pas de mot de passe »,
 * qui rouvrirait les agents sensibles sans le dire).
 */
export class InstancePasswordStore {
  private readonly path: string;
  private readonly logger?: InstancePasswordLogger;
  private readonly now: () => number;
  private stored: StoredPasswordFile | null = null;

  private constructor(options: InstancePasswordStoreOptions) {
    this.path = options.path;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  static open(options: InstancePasswordStoreOptions): InstancePasswordStore {
    const store = new InstancePasswordStore(options);
    store.load();
    return store;
  }

  get filePath(): string {
    return this.path;
  }

  /** `true` si un mot de passe d'instance est défini. */
  isConfigured(): boolean {
    return this.stored !== null;
  }

  /** Vue PUBLIQUE : « défini ou pas » + date. Jamais le haché, jamais la valeur. */
  view(): InstancePasswordView {
    if (!this.stored) return { configured: false };
    return { configured: true, updatedAt: this.stored.updatedAt };
  }

  /**
   * Vérifie un mot de passe (temps constant). `false` si aucun mot de passe
   * n'est défini — un déverrouillage ne peut alors PAS réussir.
   */
  verify(password: unknown): boolean {
    if (!this.stored) return false;
    if (typeof password !== "string" || password.length === 0) return false;
    const expected = Buffer.from(this.stored.hash, "base64");
    let actual: Buffer;
    try {
      actual = deriveScryptKey(password, this.stored.kdf, expected.length);
    } catch (error) {
      this.logger?.warn("instance_password.derive_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
      return false;
    }
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  }

  /**
   * Définit (ou CHANGE) le mot de passe d'instance.
   *
   * ⚠️ Un CHANGEMENT exige l'ANCIEN mot de passe (`currentPassword`) : sans
   * cela, une session ouverte sur `/config` pourrait REMPLACER le mot de passe
   * et rouvrir tous les agents sensibles sans le connaître (la protection ne
   * vaudrait alors rien). Un premier définition n'exige rien.
   */
  set(password: string, options: { currentPassword?: string } = {}): InstancePasswordView {
    const next = assertLength(password);
    if (this.stored) {
      const current = options.currentPassword;
      if (typeof current !== "string" || current.length === 0) {
        throw new InstancePasswordError(
          "password_mismatch",
          "Mot de passe d'instance déjà défini : saisissez l'ancien mot de passe " +
            "pour le remplacer.",
        );
      }
      if (!this.verify(current)) {
        throw new InstancePasswordError(
          "password_mismatch",
          "Ancien mot de passe d'instance incorrect : remplacement refusé.",
        );
      }
    }
    const kdf: ScryptParams = {
      salt: randomSalt(),
      n: SCRYPT_DEFAULTS.n,
      r: SCRYPT_DEFAULTS.r,
      p: SCRYPT_DEFAULTS.p,
    };
    const nextFile: StoredPasswordFile = {
      schemaVersion: INSTANCE_PASSWORD_SCHEMA_VERSION,
      algorithm: "scrypt",
      kdf,
      hash: hashInstancePassword(next, kdf),
      updatedAt: new Date(this.now()).toISOString(),
    };
    const replaced = this.stored !== null;
    this.persist(nextFile);
    this.stored = nextFile;
    // ⚠️ Aucune valeur, aucun haché : seulement le FAIT et l'horodatage.
    this.logger?.warn("instance_password.set", {
      updated_at: nextFile.updatedAt,
      replaced,
    });
    return this.view();
  }

  /**
   * Retire le mot de passe d'instance. Réservé à un usage EXPLICITE : l'appelant
   * doit vérifier qu'aucun agent sensible ne dépend encore de lui (sinon ces
   * agents deviendraient définitivement inutilisables).
   */
  clear(): boolean {
    if (!this.stored) return false;
    this.stored = null;
    try {
      // Fichier RETIRÉ : un redémarrage ne ressuscitera pas l'ancien mot de passe.
      if (existsSync(this.path)) rmSync(this.path, { force: true });
    } catch (error) {
      throw new InstancePasswordError(
        "password_io",
        `Impossible d'effacer le mot de passe d'instance (${this.path}).`,
        { cause: error },
      );
    }
    this.logger?.warn("instance_password.cleared", {});
    return true;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (error) {
      throw new InstancePasswordError(
        "password_io",
        `Lecture impossible du mot de passe d'instance (${this.path}).`,
        { cause: error },
      );
    }
    if (raw.trim() === "") return; // fichier vidé = aucun mot de passe
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new InstancePasswordError(
        "password_file_invalid",
        `Mot de passe d'instance illisible (${this.path}) : fichier JSON invalide.`,
        { cause: error },
      );
    }
    const file = parsed as Partial<StoredPasswordFile> | null;
    if (
      !file ||
      typeof file !== "object" ||
      file.schemaVersion !== INSTANCE_PASSWORD_SCHEMA_VERSION ||
      file.algorithm !== "scrypt" ||
      !file.kdf ||
      typeof file.kdf.salt !== "string" ||
      typeof file.hash !== "string" ||
      file.hash.length === 0 ||
      typeof file.updatedAt !== "string"
    ) {
      throw new InstancePasswordError(
        "password_file_invalid",
        `Mot de passe d'instance illisible (${this.path}) : format inattendu.`,
      );
    }
    this.stored = {
      schemaVersion: INSTANCE_PASSWORD_SCHEMA_VERSION,
      algorithm: "scrypt",
      kdf: {
        salt: file.kdf.salt,
        n: Number(file.kdf.n),
        r: Number(file.kdf.r),
        p: Number(file.kdf.p),
      },
      hash: file.hash,
      updatedAt: file.updatedAt,
    };
  }

  /** Écrit le fichier ATOMIQUEMENT (tmp + rename) en 0600. */
  private persist(file: StoredPasswordFile): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
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
      throw new InstancePasswordError(
        "password_io",
        `Écriture impossible du mot de passe d'instance (${this.path}).`,
        { cause: error },
      );
    }
  }
}
