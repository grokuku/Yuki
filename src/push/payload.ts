/**
 * Chiffrement de charge utile Web Push — RFC 8291, encodage `aes128gcm`
 * (RFC 8188). Aucune dépendance : `node:crypto`.
 *
 * Rappel du schéma (une seule trame suffit) :
 *   1. ECDH éphémère P-256 avec la clé publique de l'abonné (`p256dh`) ;
 *   2. HKDF-SHA256 (sel = secret `auth`) → IKM ;
 *   3. HKDF-SHA256 (sel aléatoire) → CEK (16 o) et nonce (12 o) ;
 *   4. AES-128-GCM sur `charge utile || 0x02` (délimiteur de dernière trame) ;
 *   5. corps = en-tête aes128gcm (sel + taille + clé éphémère) || cryptogramme.
 */

import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

/** Taille de trame par défaut (octets) — valeur usuelle des services de push. */
export const DEFAULT_RECORD_SIZE = 4096;

const INFO_IKM = Buffer.from("WebPush: info\0", "utf8");
const INFO_CEK = Buffer.from("Content-Encoding: aes128gcm\0", "utf8");
const INFO_NONCE = Buffer.from("Content-Encoding: nonce\0", "utf8");

export class PushCryptoError extends Error {
  override readonly name = "PushCryptoError";
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

export interface EncryptedPayload {
  /** Corps complet (en-tête aes128gcm + cryptogramme) — à POSTer tel quel. */
  body: Buffer;
  /** Sel aléatoire de la trame (exposé pour la vérification en test). */
  salt: Buffer;
}

export interface SubscriberKeys {
  /** Clé publique P-256 de l'abonné (base64url, point non compressé). */
  p256dh: string;
  /** Secret d'authentification (base64url, 16 octets). */
  auth: string;
}

/**
 * Chiffre `plaintext` pour l'abonné. Lève `PushCryptoError` sur clés invalides
 * (jamais un succès silencieux sur des données inexploitables).
 */
export function encryptPayload(
  keys: SubscriberKeys,
  plaintext: Buffer,
  recordSize: number = DEFAULT_RECORD_SIZE,
): EncryptedPayload {
  const uaPublic = Buffer.from(keys.p256dh, "base64url");
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new PushCryptoError("Clé p256dh invalide (point P-256 non compressé de 65 octets attendu).");
  }
  const authSecret = Buffer.from(keys.auth, "base64url");
  if (authSecret.length !== 16) {
    throw new PushCryptoError("Secret auth invalide (16 octets attendus).");
  }
  if (!Number.isInteger(recordSize) || recordSize < 1 || recordSize > 0xffffffff) {
    throw new PushCryptoError("Taille de trame invalide.");
  }

  // (1) Clé éphémère du serveur + secret partagé ECDH.
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey(); // 65 octets, non compressé
  const sharedSecret = ecdh.computeSecret(uaPublic);

  // (2) IKM : HKDF(salt = auth, ikm = secret ECDH, info = "WebPush: info\0" || ua || as).
  const ikm = hkdf(
    authSecret,
    sharedSecret,
    Buffer.concat([INFO_IKM, uaPublic, asPublic]),
    32,
  );

  // (3) CEK + nonce : HKDF(salt = aléatoire, ikm = IKM).
  const salt = randomBytes(16);
  const cek = hkdf(salt, ikm, INFO_CEK, 16);
  const nonce = hkdf(salt, ikm, INFO_NONCE, 12);

  // (4) Chiffrement AES-128-GCM d'une trame unique, terminée par 0x02.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final()]);
  const tag = cipher.getAuthTag();

  // (5) En-tête : sel(16) || rs(4, BE) || idlen(1)=65 || clé éphémère(65).
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(recordSize, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic]);

  return { body: Buffer.concat([header, ciphertext, tag]), salt };
}
