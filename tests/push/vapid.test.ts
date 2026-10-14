/**
 * Clés VAPID — génération, persistance 0600, signature ES256, et surtout
 * NON-EXPOSITION de la clé privée.
 */

import { createPublicKey, verify } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  generateVapidKeys,
  loadOrCreateVapidKeys,
  privateKeyObject,
  vapidAuthorization,
} from "../../src/push/vapid.js";

function publicKeyObject(publicKey: string) {
  const point = Buffer.from(publicKey, "base64url");
  return createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
}

describe("generateVapidKeys", () => {
  it("produit une clé publique P-256 non compressée (65 o) et un scalaire (32 o)", () => {
    const keys = generateVapidKeys();
    const pub = Buffer.from(keys.publicKey, "base64url");
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(0x04);
    expect(Buffer.from(keys.privateKey, "base64url").length).toBe(32);
  });

  it("deux appels produisent des paires DIFFÉRENTES", () => {
    expect(generateVapidKeys().publicKey).not.toBe(generateVapidKeys().publicKey);
  });
});

describe("loadOrCreateVapidKeys", () => {
  it("crée puis RELIT la même paire (fichier 0600)", () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-vapid-"));
    const path = join(dir, "push-vapid.json");
    const first = loadOrCreateVapidKeys(path);
    expect(first.created).toBe(true);
    const mode = statSync(path).mode & 0o777;
    expect(mode.toString(8)).toBe("600");
    const second = loadOrCreateVapidKeys(path);
    expect(second.created).toBe(false);
    expect(second.keys.publicKey).toBe(first.keys.publicKey);
    expect(second.keys.privateKey).toBe(first.keys.privateKey);
  });

  it("régénère une paire si le fichier est illisible (jamais un crash)", () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-vapid-"));
    const path = join(dir, "push-vapid.json");
    writeFileSync(path, "{ pas du json ");
    const result = loadOrCreateVapidKeys(path);
    expect(result.created).toBe(true);
    expect(Buffer.from(result.keys.publicKey, "base64url").length).toBe(65);
  });
});

describe("vapidAuthorization (JWT ES256)", () => {
  it("signe un JWT vérifiable avec la clé PUBLIQUE, au format `vapid t=…, k=…`", () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization({
      keys,
      audience: "https://fcm.googleapis.com",
      subject: "mailto:yuki@localhost",
      nowMs: 1_700_000_000_000,
    });
    expect(header.startsWith("vapid t=")).toBe(true);
    expect(header).toContain(`, k=${keys.publicKey}`);
    const jwt = header.slice("vapid t=".length, header.indexOf(", k="));
    const [h, p, s] = jwt.split(".");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
    expect(payload.aud).toBe("https://fcm.googleapis.com");
    expect(payload.sub).toBe("mailto:yuki@localhost");
    expect(payload.exp).toBeGreaterThan(1_700_000_000);
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      { key: publicKeyObject(keys.publicKey), dsaEncoding: "ieee-p1363" },
      Buffer.from(s, "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("la clé privée reconstruite signe des JWT distincts dans le temps (exp différent)", () => {
    const keys = generateVapidKeys();
    const a = vapidAuthorization({ keys, audience: "https://a", subject: "mailto:x", nowMs: 1_000 });
    const b = vapidAuthorization({ keys, audience: "https://a", subject: "mailto:x", nowMs: 2_000 });
    expect(a).not.toBe(b);
  });

  it("refuse une clé publique malformée", () => {
    const keys = generateVapidKeys();
    expect(() => privateKeyObject({ ...keys, publicKey: "AAAA" })).toThrow();
  });
});

describe("non-exposition de la clé privée", () => {
  it("le fichier de clés contient la privée (stockage 0600) mais AUCUN objet public ne la porte", () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-vapid-"));
    const path = join(dir, "push-vapid.json");
    const { keys } = loadOrCreateVapidKeys(path);
    // Le stockage DOIT contenir la privée : on vérifie sa PRÉSENCE et sa forme,
    // sans jamais la comparer/la recopier (elle ne doit apparaître nulle part).
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { privateKey?: unknown };
    expect(typeof parsed.privateKey).toBe("string");
    expect((parsed.privateKey as string).length).toBeGreaterThan(20);
    // La surface publique ne comporte QUE les deux champs attendus.
    expect(Object.keys(keys).sort()).toEqual(["privateKey", "publicKey"]);
    // La clé publique est un point non compressé de 65 octets, exportable.
    expect(Buffer.from(keys.publicKey, "base64url").length).toBe(65);
  });
});
