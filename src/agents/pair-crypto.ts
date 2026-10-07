/**
 * Cœur cryptographique de l'appairage (Lot 4) — **réplique TS à l'identique**
 * de `agent/internal/pair/crypto.go` (Go). ⚠️ Toute divergence de cadrage, de
 * sel HKDF ou d'AAD casse l'appairage EN SILENCE : ce module est donc couvert
 * par des vecteurs croisés Go ↔ TS (`tests/agents/interop-go.test.ts`).
 *
 * Ce qui DOIT être identique des deux côtés :
 *
 *   - **cadrage de longueur** (`domainConcat`) : chaque partie préfixée par sa
 *     longueur sur 4 octets **big-endian** ;
 *   - **`proof = HMAC-SHA256(C, domainConcat(yuki_fp_claimed, agent_nonce))`** ;
 *   - **`K = HKDF-SHA256(secret = C, salt = domainConcat(agent_nonce,
 *     yuki_nonce), info = "yuki-agent-pair-v1", 32)`** ;
 *   - **AAD AES-256-GCM = `domainConcat(agent_nonce, yuki_nonce)`** ;
 *   - blob = `nonce GCM (12) || ciphertext || tag (16)`.
 *
 * Primitives : `node:crypto` uniquement (aucune réimplémentation).
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

import { PairError } from "./errors.js";

/** Taille des aléas `agent_nonce` / `yuki_nonce` (32 octets). */
export const PAIR_NONCE_SIZE = 32;
/** Taille de la clé de session `K` (AES-256). */
export const PAIR_KEY_SIZE = 32;
/** Information HKDF (séparation de domaine). */
export const PAIR_DERIVATION_INFO = "yuki-agent-pair-v1";
/** Taille du nonce GCM (12 octets). */
export const GCM_NONCE_SIZE = 12;
/** Taille du tag d'authentification GCM (16 octets). */
export const GCM_TAG_SIZE = 16;

/** Alphabet Crockford base32 « sans ambiguïté » (identique au Go). */
export const PAIR_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Nombre de caractères significatifs du code. */
export const PAIR_CODE_LENGTH = 12;
/** Matière de clé dérivée du code (8 octets, big-endian). */
export const PAIR_CODE_BYTES = 8;
/** TTL par défaut d'un code d'appairage (10 minutes). */
export const PAIR_CODE_TTL_MS = 10 * 60_000;
/** Tentatives par défaut avant invalidation d'un code. */
export const PAIR_CODE_MAX_ATTEMPTS = 5;

/**
 * Concaténation **cadencée** : chaque partie est précédée de sa longueur sur
 * 4 octets big-endian. Lève toute ambiguïté de découpage.
 */
export function domainConcat(...parts: readonly Uint8Array[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(part.length, 0);
    chunks.push(length, Buffer.from(part));
  }
  return Buffer.concat(chunks);
}

/** `proof = HMAC-SHA256(C, domainConcat(yukiFP, agentNonce))`. */
export function computeProof(
  codeKey: Uint8Array,
  yukiFpClaimed: Uint8Array,
  agentNonce: Uint8Array,
): Buffer {
  return createHmac("sha256", codeKey)
    .update(domainConcat(yukiFpClaimed, agentNonce))
    .digest();
}

/** Vérifie une `proof` à temps constant. Toute taille incohérente ⇒ `false`. */
export function verifyProof(
  codeKey: Uint8Array,
  yukiFpClaimed: Uint8Array,
  agentNonce: Uint8Array,
  proof: Uint8Array,
): boolean {
  const expected = computeProof(codeKey, yukiFpClaimed, agentNonce);
  if (expected.length !== proof.length) return false;
  return timingSafeEqual(expected, Buffer.from(proof));
}

/** `K = HKDF-SHA256(secret = C, salt = domainConcat(agentNonce, yukiNonce), info, 32)`. */
export function deriveKey(
  codeKey: Uint8Array,
  agentNonce: Uint8Array,
  yukiNonce: Uint8Array,
): Buffer {
  if (codeKey.length === 0) {
    throw new PairError("internal_error", "pair : matière de code vide");
  }
  const salt = domainConcat(agentNonce, yukiNonce);
  const key = hkdfSync("sha256", codeKey, salt, PAIR_DERIVATION_INFO, PAIR_KEY_SIZE);
  return Buffer.from(key);
}

/** AAD du blob `pair_ok` : concaténation cadencée des deux aléas. */
export function sealAad(agentNonce: Uint8Array, yukiNonce: Uint8Array): Buffer {
  return domainConcat(agentNonce, yukiNonce);
}

/** Chiffre `plaintext` en AES-256-GCM : `nonce || ciphertext || tag`. */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Buffer {
  if (key.length !== PAIR_KEY_SIZE) {
    throw new PairError("internal_error", `pair : clé de ${key.length} octets (attendu 32)`);
  }
  const nonce = randomBytes(GCM_NONCE_SIZE);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

/** Déchiffre et authentifie un blob produit par `seal`. Toute altération échoue. */
export function open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Buffer {
  if (key.length !== PAIR_KEY_SIZE) {
    throw new PairError("internal_error", `pair : clé de ${key.length} octets (attendu 32)`);
  }
  if (sealed.length < GCM_NONCE_SIZE + GCM_TAG_SIZE) {
    throw new PairError("pair_decrypt_failed", "blob trop court");
  }
  const nonce = Buffer.from(sealed.subarray(0, GCM_NONCE_SIZE));
  const tag = Buffer.from(sealed.subarray(sealed.length - GCM_TAG_SIZE));
  const ciphertext = Buffer.from(sealed.subarray(GCM_NONCE_SIZE, sealed.length - GCM_TAG_SIZE));
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new PairError(
      "pair_decrypt_failed",
      "déchiffrement/authentification échoué",
    );
  }
}

/* ─── Code d'appairage ────────────────────────────────────────────────────── */

function invalidCode(message: string): PairError {
  return new PairError("pair_code_invalid", message);
}

/**
 * Normalise une saisie utilisateur en forme canonique `XXXX-XXXX-XXXX`.
 * Tolère casse libre et séparateurs `-`/espace/tabulation ; **rejette** les
 * caractères ambigus (`0`, `1`, `I`, `L`, `O`, `U`) et toute autre longueur.
 */
export function normalizeCode(input: string): string {
  const raw: string[] = [];
  for (const ch of input.toUpperCase().trim()) {
    if (ch === "-" || ch === " " || ch === "\t" || ch === "\r" || ch === "\n") continue;
    if (!PAIR_CODE_ALPHABET.includes(ch)) {
      throw invalidCode(
        `caractère invalide ${JSON.stringify(ch)} (alphabet Crockford : ${PAIR_CODE_ALPHABET})`,
      );
    }
    raw.push(ch);
  }
  if (raw.length !== PAIR_CODE_LENGTH) {
    throw invalidCode(
      `longueur invalide : ${raw.length} caractères (attendu ${PAIR_CODE_LENGTH})`,
    );
  }
  return formatCode(raw.join(""));
}

/** Insère les tirets d'affichage. `raw` fait exactement 12 caractères. */
export function formatCode(raw: string): string {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

/**
 * Décode un code (forme libre ou canonique) en 8 octets big-endian. C'est cette
 * valeur — et non la chaîne — qui sert de clé à `computeProof` et `deriveKey`.
 */
export function codeKey(code: string): Buffer {
  const canonical = normalizeCode(code);
  const raw = canonical.replace(/-/g, "");
  let value = 0n;
  const base = BigInt(PAIR_CODE_ALPHABET.length);
  for (const ch of raw) {
    value = value * base + BigInt(PAIR_CODE_ALPHABET.indexOf(ch));
  }
  const out = Buffer.alloc(PAIR_CODE_BYTES);
  let hex = value.toString(16);
  if (hex.length % 2 === 1) hex = `0${hex}`;
  const bytes = Buffer.from(hex, "hex");
  bytes.copy(out, PAIR_CODE_BYTES - bytes.length);
  return out;
}

/** Espace des codes : `30^12`. */
function codeSpace(): bigint {
  return BigInt(PAIR_CODE_ALPHABET.length) ** BigInt(PAIR_CODE_LENGTH);
}

/** Encode une valeur de `[0, 30^12)` en 12 caractères (poids fort d'abord). */
export function encodeBase30(value: bigint): string {
  const base = BigInt(PAIR_CODE_ALPHABET.length);
  const chars = new Array<string>(PAIR_CODE_LENGTH);
  let current = value;
  for (let i = PAIR_CODE_LENGTH - 1; i >= 0; i -= 1) {
    const remainder = current % base;
    chars[i] = PAIR_CODE_ALPHABET[Number(remainder)] as string;
    current /= base;
  }
  return chars.join("");
}

/**
 * Tire un code d'appairage uniformément (rejet, sans biais modulo) et renvoie sa
 * forme canonique `XXXX-XXXX-XXXX`. `randomSource` est injectable pour les tests.
 */
export function generateCode(
  randomSource: (size: number) => Buffer = randomBytes,
): string {
  const space = codeSpace();
  const range = 1n << 64n;
  const limit = (range / space) * space;
  for (;;) {
    const bytes = randomSource(8);
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    if (value < limit) {
      return formatCode(encodeBase30(value % space));
    }
  }
}

/**
 * Vérifie qu'une `proof` correspond à la clé d'un code, sans comptabiliser
 * d'échec (sonde destinée à la recherche de session, jamais à l'appairage).
 */
export function probeProof(
  codeKey: Uint8Array,
  yukiFpClaimed: string,
  agentNonce: Uint8Array,
  proof: Uint8Array,
): boolean {
  return verifyProof(codeKey, Buffer.from(yukiFpClaimed, "utf8"), agentNonce, proof);
}

/** Alias lisible : `Proof` (usage Go) ⇒ `computeProof`. */
export const Proof = computeProof;
/** Alias lisible : `VerifyProof` (usage Go) ⇒ `verifyProof`. */
export const VerifyProof = verifyProof;
/** Alias lisible : `DeriveKey` (usage Go) ⇒ `deriveKey`. */
export const DeriveKey = deriveKey;
/** Alias lisible : `Seal` (usage Go) ⇒ `seal`. */
export const Seal = seal;
/** Alias lisible : `Open` (usage Go) ⇒ `open`. */
export const Open = open;
/** Alias lisible : `CodeKey` (usage Go) ⇒ `codeKey`. */
export const CodeKey = codeKey;
/** Alias lisible : `NormalizeCode` (usage Go) ⇒ `normalizeCode`. */
export const NormalizeCode = normalizeCode;
