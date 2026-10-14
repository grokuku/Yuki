/**
 * Chiffrement de charge utile Web Push (aes128gcm) — aller-retour vérifié par
 * un déchiffreur indépendant écrit dans le test (mêmes primitives, chemin
 * inverse). On vérifie aussi le format de l'en-tête et le refus des clés
 * invalides.
 */

import { createDecipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encryptPayload, PushCryptoError } from "../../src/push/payload.js";

/** Abonné de test : clés p256dh/auth aléatoires valides. */
function subscriber() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    ecdh,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  };
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

/** Déchiffreur INDÉPENDANT (chemin inverse de `encryptPayload`). */
function decrypt(body: Buffer, sub: ReturnType<typeof subscriber>): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const keyId = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const uaPublic = Buffer.from(sub.p256dh, "base64url");
  const authSecret = Buffer.from(sub.auth, "base64url");
  const shared = sub.ecdh.computeSecret(keyId);
  const ikm = hkdf(
    authSecret,
    shared,
    Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, keyId]),
    32,
  );
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(tag);
  const record = Buffer.concat([decipher.update(data), decipher.final()]);
  // Dernier octet = délimiteur de trame (0x02) : on le retire.
  return record.subarray(0, record.length - 1).toString("utf8");
}

describe("encryptPayload", () => {
  it("chiffre puis déchiffre fidèlement (UTF-8, accents inclus)", () => {
    const sub = subscriber();
    const message = JSON.stringify({ title: "Validation en attente", body: "Commande : rm -rf « éàü »" });
    const { body, salt } = encryptPayload(sub, Buffer.from(message, "utf8"));
    expect(salt.length).toBe(16);
    expect(decrypt(body, sub)).toBe(message);
  });

  it("n'utilise JAMAIS le même sel/cryptogramme deux fois", () => {
    const sub = subscriber();
    const plaintext = Buffer.from("salut", "utf8");
    const a = encryptPayload(sub, plaintext);
    const b = encryptPayload(sub, plaintext);
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.body.equals(b.body)).toBe(false);
  });

  it("écrit un en-tête aes128gcm conforme (rs, clé éphémère 65 o)", () => {
    const sub = subscriber();
    const { body } = encryptPayload(sub, Buffer.from("x", "utf8"), 4096);
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(0x04);
  });

  it("refuse une clé p256dh invalide ou un auth de mauvaise taille", () => {
    const sub = subscriber();
    expect(() => encryptPayload({ p256dh: "AAAA", auth: sub.auth }, Buffer.from("x"))).toThrow(
      PushCryptoError,
    );
    expect(() => encryptPayload({ p256dh: sub.p256dh, auth: randomBytes(8).toString("base64url") }, Buffer.from("x"))).toThrow(
      PushCryptoError,
    );
  });
});
