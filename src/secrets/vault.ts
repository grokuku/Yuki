/**
 * Coffre de secrets CHIFFRÉ (volume `state`) — clé maître FOURNIE HORS BANDE.
 *
 * ## Modèle de sécurité (décision utilisateur n°2)
 *
 * - Algorithme : **AES-256-GCM** (chiffrement authentifié), un IV ALÉATOIRE par
 *   entrée (12 octets) — jamais réutilisé.
 * - Clé : **DÉRIVÉE de `YUKI_VAULT_KEY`** par **scrypt** (KDF *memory-hard*).
 *   Justification : `YUKI_VAULT_KEY` est un secret fourni par l'opérateur, dont
 *   l'entropie n'est pas garantie (phrase de passe possible). Un KDF *rapide*
 *   (HKDF, SHA-256) ne ralentirait PAS une attaque par force brute sur le
 *   fichier ; scrypt la rend coûteuse (coût mémoire paramétré). Un sel ALÉATOIRE
 *   par coffre est stocké en clair (il n'a pas besoin d'être secret).
 * - **La clé n'est JAMAIS rangée à côté du coffre** : elle vient de
 *   l'environnement (`YUKI_VAULT_KEY`). Si elle est absente ou fausse, on
 *   **REFUSE** (aucun repli en clair, jamais).
 * - Écriture **atomique** (`tmp` + `rename`) et mode **0600**.
 *
 * ⚠️ Si l'utilisateur perd `YUKI_VAULT_KEY`, il perd les secrets : c'est
 * irréversible (aucun recours). À dire et à documenter.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { isValidSecretName } from "./references.js";

/** Variable d'environnement portant la clé maître (fournie hors bande). */
export const VAULT_KEY_ENV = "YUKI_VAULT_KEY";

/** Version de schéma du fichier de coffre. */
export const VAULT_SCHEMA_VERSION = 1;

/**
 * Longueur MINIMALE d'un secret stocké. ⚠️ En dessous, le masquage de sortie
 * ne peut pas fonctionner sans sur-masquer (la redaction exige ≥ 6 caractères) :
 * on refuse donc la valeur AVANT qu'elle ne fuie.
 */
export const VAULT_MIN_SECRET_LENGTH = 6;

/**
 * Paramètres scrypt (coût mémoire/CPU), stockés EN CLAIR dans le fichier : le
 * sel n'a pas besoin d'être secret, seuls `n`/`r`/`p` décrivent le coût.
 *
 * ⚠️ SOURCE UNIQUE du KDF du projet : `InstancePasswordStore`
 * (`src/security/instance-password.ts`) réutilise CECI (aucun second KDF
 * écrit à la main).
 */
export interface ScryptParams {
  /** Sel ALÉATOIRE, encodé en base64. */
  salt: string;
  n: number;
  r: number;
  p: number;
}

/** Paramètres scrypt (coût mémoire/CPU). Stockés en clair dans le fichier. */
interface KdfParams extends ScryptParams {
  algorithm: "scrypt";
}

/** Entrée chiffrée telle que stockée (jamais la valeur en clair). */
interface StoredEntry {
  iv: string;
  tag: string;
  data: string;
  updatedAt: string;
}

interface VaultFile {
  schemaVersion: number;
  kdf: KdfParams;
  cipher: "aes-256-gcm";
  entries: Record<string, StoredEntry>;
}

/** Entrée déchiffrée en mémoire. */
interface VaultEntryValue {
  name: string;
  value: string;
  label?: string;
  updatedAt: string;
}

/** Vue PUBLIQUE d'une entrée (jamais la valeur) — renvoyée par l'API. */
export interface VaultEntryView {
  name: string;
  label?: string;
  updatedAt: string;
}

/** Base des erreurs du coffre. */
export class VaultError extends Error {
  override readonly name: string = "VaultError";
}

/** Clé absente : le coffre reste VERROUILLÉ (jamais de repli en clair). */
export class VaultKeyMissingError extends VaultError {
  override readonly name = "VaultKeyMissingError";
  constructor() {
    super(
      `Coffre de secrets verrouillé : la variable d'environnement ${VAULT_KEY_ENV} ` +
        "n'est pas définie. Fournissez la clé maître hors bande (aucun repli en clair).",
    );
  }
}

/** Clé fausse (ou fichier corrompu) : on REFUSE d'ouvrir. */
export class VaultKeyInvalidError extends VaultError {
  override readonly name = "VaultKeyInvalidError";
  constructor(cause: unknown) {
    super(
      `Coffre de secrets illisible : ${VAULT_KEY_ENV} est fausse (ou le coffre est ` +
        "altéré). Aucun repli en clair : vérifiez la clé maître.",
      { cause },
    );
  }
}

/** Nom de secret invalide (préfixe réservé manquant). */
export class VaultNameError extends VaultError {
  override readonly name = "VaultNameError";
  constructor(name: string) {
    super(
      `Nom de secret invalide « ${name} » : un nom doit commencer par ` +
        "« YUKI_SECRET_ » (voir la syntaxe de référence des commandes).",
    );
  }
}

/** Valeur trop courte pour être masquée sans sur-masquer. */
export class VaultValueError extends VaultError {
  override readonly name = "VaultValueError";
  constructor(min: number) {
    super(
      `Valeur trop courte : un secret doit compter au moins ${min} caractères ` +
        "(en dessous, le masquage de sortie sur-masquerait le reste du texte).",
    );
  }
}

/** Erreur d'écriture explicite (volume non inscriptible, disque plein…). */
export class VaultWriteError extends VaultError {
  override readonly name = "VaultWriteError";
  constructor(
    readonly path: string,
    readonly reason: string,
    cause: unknown,
  ) {
    super(`Impossible d'écrire le coffre de secrets (${reason}) dans ${path}.`, {
      cause,
    });
  }
}

/** Coût scrypt par défaut du projet (mémoire ≈ 128 × N × r ≈ 16 Mio). */
export const SCRYPT_DEFAULTS = { n: 16_384, r: 8, p: 1 } as const;

const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Tire un sel ALÉATOIRE (base64) — jamais réutilisé entre deux fichiers. */
export function randomSalt(): string {
  return randomBytes(SALT_LEN).toString("base64");
}

/**
 * Dérive une clé de `keyLen` octets (scrypt) depuis un secret et un sel.
 *
 * ⚠️ KDF SOURCE UNIQUE : le coffre l'utilise pour sa clé AES-256, et
 * `InstancePasswordStore` pour le hachage du mot de passe d'instance. Ne pas
 * réimplémenter ailleurs.
 */
export function deriveScryptKey(
  secret: string,
  params: ScryptParams,
  keyLen: number = KEY_LEN,
): Buffer {
  // `maxmem` couvre 128 * N * r (+ marge) sinon Node lève « memory limit ».
  const maxmem = Math.max(32 * 1024 * 1024, 256 * params.n * params.r);
  return scryptSync(secret, Buffer.from(params.salt, "base64"), keyLen, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem,
  });
}

/** Dérive la clé AES-256 depuis la clé maître et le sel (scrypt). */
function deriveKey(masterKey: string, params: KdfParams): Buffer {
  return deriveScryptKey(masterKey, params, KEY_LEN);
}

function defaultKdf(): KdfParams {
  return {
    algorithm: "scrypt",
    salt: randomSalt(),
    n: SCRYPT_DEFAULTS.n,
    r: SCRYPT_DEFAULTS.r,
    p: SCRYPT_DEFAULTS.p,
  };
}

/**
 * Coffre de secrets chiffré. Construit par `SecretVault.open` : la valeur de
 * retour n'existe QUE si le coffre a pu être ouvert (clé présente ET valide).
 */
export class SecretVault {
  private readonly path: string;
  private readonly key: Buffer;
  private kdf: KdfParams;
  /** Entrées en mémoire (valeur DÉCHIFFRÉE) — jamais écrites en clair. */
  private readonly entries = new Map<string, VaultEntryValue>();

  private constructor(path: string, key: Buffer, kdf: KdfParams) {
    this.path = path;
    this.key = key;
    this.kdf = kdf;
  }

  /** Le coffre est-il configuré (clé maître définie) ? */
  static isConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
    return (env[VAULT_KEY_ENV] ?? "").length > 0;
  }

  /**
   * Ouvre (ou crée) le coffre. **REFUSE** si la clé est absente ou fausse :
   * ne renvoie jamais un coffre en clair.
   */
  static open(options: { path: string; key?: string }): SecretVault {
    const key = options.key ?? process.env[VAULT_KEY_ENV] ?? "";
    if (key.length === 0) throw new VaultKeyMissingError();

    const path = options.path;
    if (!existsSync(path)) {
      // Coffre NEUF : on tire un sel, on dérive la clé, le fichier sera créé à
      // la première écriture (aucune donnée en clair n'est persistée).
      const kdf = defaultKdf();
      const vault = new SecretVault(path, deriveKey(key, kdf), kdf);
      return vault;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new VaultKeyInvalidError(error);
    }
    const file = parsed as Partial<VaultFile> | null;
    if (
      !file ||
      typeof file !== "object" ||
      file.schemaVersion !== VAULT_SCHEMA_VERSION ||
      !file.kdf ||
      file.cipher !== "aes-256-gcm" ||
      !file.entries ||
      typeof file.entries !== "object"
    ) {
      throw new VaultKeyInvalidError(new Error("format de coffre inattendu"));
    }
    const kdf = file.kdf as KdfParams;
    const derived = deriveKey(key, kdf);
    const vault = new SecretVault(path, derived, kdf);
    // Déchiffre TOUT de suite : une clé fausse (auth GCM) fait échouer l'open.
    for (const [name, entry] of Object.entries(file.entries as Record<string, StoredEntry>)) {
      vault.entries.set(name, vault.decrypt(name, entry));
    }
    return vault;
  }

  get filePath(): string {
    return this.path;
  }

  /** Noms des secrets stockés (triés). */
  names(): string[] {
    return [...this.entries.keys()].sort();
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Valeur déchiffrée d'un secret, ou `undefined` s'il est absent. */
  get(name: string): string | undefined {
    return this.entries.get(name)?.value;
  }

  /** Vue PUBLIQUE (nom + libellé + horodatage) — JAMAIS la valeur. */
  list(): VaultEntryView[] {
    return this.names().map((name) => {
      const entry = this.entries.get(name) as VaultEntryValue;
      return {
        name,
        ...(entry.label !== undefined && entry.label !== "" ? { label: entry.label } : {}),
        updatedAt: entry.updatedAt,
      };
    });
  }

  /** Valeurs déchiffrées (pour la redaction). Jamais persistées ni renvoyées. */
  values(): string[] {
    return [...this.entries.values()].map((entry) => entry.value);
  }

  /** Ajoute ou remplace un secret (valide le nom et la longueur), persiste. */
  set(name: string, value: string, label?: string): VaultEntryView {
    if (!isValidSecretName(name)) throw new VaultNameError(name);
    if (value.length < VAULT_MIN_SECRET_LENGTH) {
      throw new VaultValueError(VAULT_MIN_SECRET_LENGTH);
    }
    const entry: VaultEntryValue = {
      name,
      value,
      ...(label !== undefined && label.trim() !== "" ? { label: label.trim() } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.entries.set(name, entry);
    this.persist();
    return {
      name,
      ...(entry.label !== undefined ? { label: entry.label } : {}),
      updatedAt: entry.updatedAt,
    };
  }

  /** Supprime un secret. Renvoie `true` s'il existait. */
  delete(name: string): boolean {
    if (!this.entries.delete(name)) return false;
    this.persist();
    return true;
  }

  private decrypt(name: string, entry: StoredEntry): VaultEntryValue {
    let plaintext: string;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.key,
        Buffer.from(entry.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      plaintext = Buffer.concat([
        decipher.update(Buffer.from(entry.data, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch (error) {
      throw new VaultKeyInvalidError(error);
    }
    let payload: { value?: unknown; label?: unknown };
    try {
      payload = JSON.parse(plaintext) as { value?: unknown; label?: unknown };
    } catch (error) {
      throw new VaultKeyInvalidError(error);
    }
    if (typeof payload.value !== "string") {
      throw new VaultKeyInvalidError(new Error("entrée sans valeur"));
    }
    return {
      name,
      value: payload.value,
      ...(typeof payload.label === "string" && payload.label !== ""
        ? { label: payload.label }
        : {}),
      updatedAt: entry.updatedAt,
    };
  }

  private encrypt(entry: VaultEntryValue): StoredEntry {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const payload = JSON.stringify({ value: entry.value, ...(entry.label ? { label: entry.label } : {}) });
    const data = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    return {
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: data.toString("base64"),
      updatedAt: entry.updatedAt,
    };
  }

  /** Écrit le coffre atomiquement (tmp + rename) en 0600. */
  private persist(): void {
    const file: VaultFile = {
      schemaVersion: VAULT_SCHEMA_VERSION,
      kdf: this.kdf,
      cipher: "aes-256-gcm",
      entries: {},
    };
    for (const [name, entry] of this.entries) {
      file.entries[name] = this.encrypt(entry);
    }
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
      throw new VaultWriteError(this.path, messageOf(error), error);
    }
  }
}
