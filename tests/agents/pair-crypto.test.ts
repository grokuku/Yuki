/**
 * Parité cryptographique de l'appairage (Lot 4). Ces tests reprennent les
 * scénarios de `agent/internal/pair/pair_test.go` côté Yuki : le cadrage de
 * longueur, la preuve HMAC, la dérivation HKDF et l'AES-GCM doivent produire
 * les MÊMES octets des deux côtés.
 */

import { describe, expect, it } from "vitest";

import {
  codeKey,
  computeProof,
  deriveKey,
  domainConcat,
  encodeBase30,
  formatCode,
  generateCode,
  normalizeCode,
  open,
  pairCodeOf,
  PAIR_CODE_ALPHABET,
  PAIR_CODE_LENGTH,
  PAIR_NONCE_SIZE,
  seal,
  verifyProof,
} from "../../src/agents/index.js";

const CODE = "ABCD-2345-6789";

describe("code d'appairage", () => {
  it("generateCode produit la forme canonique XXXX-XXXX-XXXX", () => {
    const pattern = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
    for (let i = 0; i < 200; i += 1) {
      expect(generateCode()).toMatch(pattern);
    }
  });

  it("generateCode est déterministe avec une source nulle (comme le Go)", () => {
    const zeros = (n: number): Buffer => Buffer.alloc(n);
    expect(generateCode(zeros)).toBe("2222-2222-2222");
  });

  it("l'alphabet exclut les caractères ambigus (30 symboles, ~58,9 bits)", () => {
    expect(PAIR_CODE_ALPHABET).toHaveLength(30);
    for (const ambiguous of ["0", "1", "I", "L", "O", "U"]) {
      expect(PAIR_CODE_ALPHABET.includes(ambiguous)).toBe(false);
    }
    expect(PAIR_CODE_LENGTH).toBe(12);
    expect(encodeBase30(0n)).toBe("222222222222");
  });

  it("normalizeCode tolère casse et séparateurs, rejette l'ambigu", () => {
    expect(normalizeCode("abcd 2345 6789")).toBe(CODE);
    expect(normalizeCode("  abcd23456789\t")).toBe(CODE);
    expect(normalizeCode(CODE)).toBe(CODE);
    for (const bad of ["ABCD-2345-678O", "ABCD-2345-6780", "ABCD-2345-678I", "ABCD-2345-678L", "ABCD-2345-678U", "ABCD-2345-6781"]) {
      expect(() => normalizeCode(bad)).toThrowError();
      try {
        normalizeCode(bad);
      } catch (error) {
        expect(pairCodeOf(error)).toBe("pair_code_invalid");
      }
    }
    expect(() => normalizeCode("ABCD-2345")).toThrowError();
    expect(() => normalizeCode("")).toThrowError();
  });

  it("codeKey est déterministe, insensible à la casse, et distinct", () => {
    const a = codeKey("2222-2222-2222");
    expect(a).toHaveLength(8);
    expect(a.equals(Buffer.alloc(8))).toBe(true);
    const b = codeKey("2222-2222-2223");
    expect(a.equals(b)).toBe(false);
    expect(codeKey("22222222 2223").equals(b)).toBe(true);
    expect(() => codeKey("nope")).toThrowError();
  });
});

describe("cadrage de longueur (domainConcat)", () => {
  it("préfixe chaque partie par sa longueur sur 4 octets big-endian", () => {
    const a = Buffer.from([0xaa, 0xbb]);
    const b = Buffer.from([0xcc]);
    expect(domainConcat(a, b).toString("hex")).toBe("00000002aabb00000001cc");
    expect(domainConcat().length).toBe(0);
    // Le cadrage lève l'ambiguïté : (a|b) ≠ (a'|b') même concaténation nue.
    expect(domainConcat(Buffer.from("ab"), Buffer.from("c")).toString("hex")).not.toBe(
      domainConcat(Buffer.from("a"), Buffer.from("bc")).toString("hex"),
    );
  });
});

describe("preuve HMAC (proof)", () => {
  const nonce = Buffer.alloc(PAIR_NONCE_SIZE, 7);
  const key = codeKey(CODE);

  it("vérifie une preuve valide et refuse les variantes", () => {
    const proof = computeProof(key, Buffer.from("aabbccdd"), nonce);
    expect(proof).toHaveLength(32);
    expect(verifyProof(key, Buffer.from("aabbccdd"), nonce, proof)).toBe(true);
    expect(verifyProof(key, Buffer.from("other"), nonce, proof)).toBe(false);
    expect(verifyProof(key, Buffer.from("aabbccdd"), Buffer.alloc(PAIR_NONCE_SIZE, 8), proof)).toBe(false);
    expect(verifyProof(codeKey("ABCD-2345-6798"), Buffer.from("aabbccdd"), nonce, proof)).toBe(false);
    const tampered = Buffer.from(proof);
    tampered[0] = (tampered[0] as number) ^ 0x01;
    expect(verifyProof(key, Buffer.from("aabbccdd"), nonce, tampered)).toBe(false);
    expect(verifyProof(key, Buffer.from("aabbccdd"), nonce, proof.subarray(0, 16))).toBe(false);
  });
});

describe("dérivation HKDF (deriveKey)", () => {
  const an = Buffer.alloc(PAIR_NONCE_SIZE, 1);
  const yn = Buffer.alloc(PAIR_NONCE_SIZE, 2);
  const key = codeKey(CODE);

  it("est déterministe et sensible au code et aux aléas", () => {
    const k1 = deriveKey(key, an, yn);
    expect(k1).toHaveLength(32);
    expect(deriveKey(key, an, yn).equals(k1)).toBe(true);
    expect(deriveKey(key, an, Buffer.alloc(PAIR_NONCE_SIZE, 3)).equals(k1)).toBe(false);
    expect(deriveKey(codeKey("ABCD-2345-6798"), an, yn).equals(k1)).toBe(false);
    expect(() => deriveKey(Buffer.alloc(0), an, yn)).toThrowError();
  });
});

describe("AES-256-GCM (seal / open)", () => {
  const key = Buffer.alloc(32, 5);
  const aad = Buffer.from("aad");
  const message = Buffer.from("contenu secret");

  it("fait l'aller-retour et refuse toute altération", () => {
    const sealed = seal(key, message, aad);
    expect(open(key, sealed, aad).equals(message)).toBe(true);

    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0x80;
    try {
      open(key, tampered, aad);
    } catch (error) {
      expect(pairCodeOf(error)).toBe("pair_decrypt_failed");
    }
    try {
      open(Buffer.alloc(32, 6), sealed, aad);
    } catch (error) {
      expect(pairCodeOf(error)).toBe("pair_decrypt_failed");
    }
    try {
      open(key, sealed, Buffer.from("other"));
    } catch (error) {
      expect(pairCodeOf(error)).toBe("pair_decrypt_failed");
    }
    expect(() => open(key, sealed.subarray(0, 3), aad)).toThrowError();
  });
});

describe("formatCode", () => {
  it("insère deux tirets", () => {
    expect(formatCode("ABCD23456789")).toBe(CODE);
  });
});
