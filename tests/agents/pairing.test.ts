/**
 * Tests d'attaque et de cycle de vie de l'appairage (Lot 4, B3). Les scénarios
 * sont alignés sur `agent/internal/pair/pair_test.go` : mauvais code, code
 * périmé, code déjà utilisé, rate-limit, preuve invalide, rejeu — chacun DOIT
 * échouer avec le MÊME code d'erreur que côté Go.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  caDirectoryIn,
  CertificateAuthority,
  codeKey,
  computeProof,
  deriveKey,
  open,
  pairCodeOf,
  PAIR_CODE_MAX_ATTEMPTS,
  PAIR_CODE_TTL_MS,
  PairingManager,
  PairingSession,
  parsePayload,
  sealAad,
} from "../../src/agents/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { agentBegin } from "./stack.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const CODE = "ABCD-2345-6789";
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-pair-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const material = {
  caCert: "-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----\n",
  clientCert: "-----BEGIN CERTIFICATE-----\nCC\n-----END CERTIFICATE-----\n",
  clientKey: "-----BEGIN PRIVATE KEY-----\nCK\n-----END PRIVATE KEY-----\n",
  agentId: "11111111-2222-3333-4444-555555555555",
  caFingerprint: "f".repeat(64),
};

describe("PairingSession — nominal", () => {
  it("authorize produit un pair_ok déchiffrable, puis consomme le code", () => {
    const session = new PairingSession(CODE);
    const begin = agentBegin(CODE);
    const outcome = session.authorize(begin.frame, material);
    expect(session.isUsed).toBe(true);

    const key = deriveKey(begin.key, begin.agentNonce, outcome.yukiNonce);
    const plaintext = open(key, outcome.blob, sealAad(begin.agentNonce, outcome.yukiNonce));
    const payload = parsePayload(plaintext);
    expect(payload.agentId).toBe(material.agentId);
    expect(payload.caFingerprint).toBe(material.caFingerprint);
  });
});

describe("PairingSession — attaques (chacune DOIT échouer)", () => {
  it("(1) mauvais code ⇒ proof_invalid", () => {
    const session = new PairingSession(CODE);
    const begin = agentBegin("ABCD-2345-6798");
    try {
      session.authorize(begin.frame, material);
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(pairCodeOf(error)).toBe("proof_invalid");
    }
    expect(session.attemptsUsed).toBe(1);
  });

  it("(2) preuve invalide (octets aléatoires) ⇒ proof_invalid", () => {
    const session = new PairingSession(CODE);
    const begin = agentBegin(CODE);
    begin.frame.proof = Buffer.alloc(32, 0);
    try {
      session.authorize(begin.frame, material);
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(pairCodeOf(error)).toBe("proof_invalid");
    }
  });

  it("(3) rejeu du MÊME agent_nonce ⇒ pair_replay", () => {
    const session = new PairingSession(CODE);
    const begin = agentBegin(CODE);
    session.authorize(begin.frame, material);
    const key = codeKey(CODE);
    const replay = {
      type: "pair_begin" as const,
      protoVersion: 1,
      agentNonce: begin.agentNonce,
      yukiFpClaimed: "autre",
      proof: computeProof(key, Buffer.from("autre", "utf8"), begin.agentNonce),
    };
    try {
      session.authorize(replay, material);
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(pairCodeOf(error)).toBe("pair_replay");
    }
  });

  it("(4) code déjà utilisé ⇒ pair_code_used", () => {
    const session = new PairingSession(CODE);
    session.authorize(agentBegin(CODE).frame, material);
    try {
      session.authorize(agentBegin(CODE).frame, material);
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(pairCodeOf(error)).toBe("pair_code_used");
    }
  });

  it("(5) code périmé ⇒ pair_code_expired", () => {
    let now = Date.UTC(2026, 9, 7, 12, 0, 0);
    const session = new PairingSession(CODE, { now: () => now });
    now += PAIR_CODE_TTL_MS + 1_000;
    try {
      session.authorize(agentBegin(CODE).frame, material);
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(pairCodeOf(error)).toBe("pair_code_expired");
    }
  });

  it("(6) rate-limit : 5 échecs ⇒ invalidé, puis pair_rate_limited", () => {
    const session = new PairingSession(CODE);
    for (let i = 0; i < PAIR_CODE_MAX_ATTEMPTS; i += 1) {
      const begin = agentBegin(CODE);
      begin.frame.proof = Buffer.alloc(32, i + 1);
      try {
        session.authorize(begin.frame, material);
      } catch (error) {
        expect(pairCodeOf(error)).toBe("proof_invalid");
      }
    }
    expect(session.isInvalidated).toBe(true);
    expect(session.attemptsUsed).toBe(PAIR_CODE_MAX_ATTEMPTS);
    try {
      session.authorize(agentBegin(CODE).frame, material);
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(pairCodeOf(error)).toBe("pair_rate_limited");
    }
  });

  it("(7) agent_nonce de mauvaise taille ⇒ malformed_message", () => {
    const session = new PairingSession(CODE);
    const begin = agentBegin(CODE);
    begin.frame.agentNonce = Buffer.from([1, 2, 3]);
    try {
      session.authorize(begin.frame, material);
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(pairCodeOf(error)).toBe("malformed_message");
    }
  });
});

describe("PairingManager", () => {
  function manager(overrides: Parameters<typeof makeManager>[0] = {}): PairingManager {
    return makeManager(overrides);
  }

  function makeManager(overrides: {
    ttlMs?: number;
    maxAttempts?: number;
    maxPending?: number;
    perIp?: { max: number; windowMs: number };
    now?: () => number;
  }): PairingManager {
    const ca = CertificateAuthority.open({
      dir: caDirectoryIn(tempDir()),
      logger,
      ...(overrides.now ? { now: overrides.now } : {}),
    });
    return new PairingManager({
      ca,
      logger,
      ...(overrides.ttlMs !== undefined ? { ttlMs: overrides.ttlMs } : {}),
      ...(overrides.maxAttempts !== undefined ? { maxAttempts: overrides.maxAttempts } : {}),
      ...(overrides.maxPending !== undefined ? { maxPending: overrides.maxPending } : {}),
      ...(overrides.perIp ? { perIp: overrides.perIp } : {}),
    });
  }

  it("refuse un code au format invalide ⇒ pair_code_invalid", () => {
    const m = manager();
    try {
      m.submitCode("nope", { ip: "1.2.3.4" });
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(pairCodeOf(error)).toBe("pair_code_invalid");
    }
  });

  it("met en attente une pair_begin sans session, puis la résout après saisie du code", () => {
    const m = manager();
    const begin = agentBegin(CODE);
    const result = m.beginPairing(begin.frame, { ip: "1.2.3.4" });
    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(m.pendingCount()).toBe(1);

    const submitted = m.submitCode(CODE, { ip: "1.2.3.4" });
    expect(submitted.code).toBe(CODE);
    expect(m.activeSessionCount()).toBe(0); // consommée par la résolution

    const polled = m.pollPairing(result.pairId);
    expect(polled.status).toBe("ok");
  });

  it("résout immédiatement quand la session existe déjà", () => {
    const m = manager();
    m.submitCode(CODE, { ip: "1.2.3.4" });
    const begin = agentBegin(CODE);
    const result = m.beginPairing(begin.frame, { ip: "1.2.3.4" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    const key = deriveKey(begin.key, begin.agentNonce, result.outcome.yukiNonce);
    const payload = parsePayload(open(key, result.outcome.blob, sealAad(begin.agentNonce, result.outcome.yukiNonce)));
    expect(payload.agentId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mauvais code avec une session active ⇒ proof_invalid (pas de mise en attente)", () => {
    const m = manager();
    m.submitCode(CODE, { ip: "1.2.3.4" });
    const begin = agentBegin("ABCD-2345-6798");
    try {
      m.beginPairing(begin.frame, { ip: "1.2.3.4" });
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(pairCodeOf(error)).toBe("proof_invalid");
    }
  });

  it("scrutation d'un identifiant inconnu ⇒ pair_code_expired", () => {
    const m = manager();
    try {
      m.pollPairing("inconnu");
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(pairCodeOf(error)).toBe("pair_code_expired");
    }
  });

  it("limite globale par IP sur les pair_begin", () => {
    const m = manager({ perIp: { max: 3, windowMs: 60_000 } });
    for (let i = 0; i < 3; i += 1) {
      const begin = agentBegin(CODE);
      expect(m.beginPairing(begin.frame, { ip: "9.9.9.9" }).status).toBe("pending");
    }
    const begin = agentBegin(CODE);
    try {
      m.beginPairing(begin.frame, { ip: "9.9.9.9" });
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(pairCodeOf(error)).toBe("pair_rate_limited");
    }
    // Une autre IP n'est pas affectée.
    expect(m.beginPairing(agentBegin(CODE).frame, { ip: "8.8.8.8" }).status).toBe("pending");
  });

  it("borne le nombre de trames en attente", () => {
    const m = manager({ maxPending: 2 });
    expect(m.beginPairing(agentBegin(CODE).frame, { ip: "1.1.1.1" }).status).toBe("pending");
    expect(m.beginPairing(agentBegin(CODE).frame, { ip: "1.1.1.1" }).status).toBe("pending");
    try {
      m.beginPairing(agentBegin(CODE).frame, { ip: "1.1.1.1" });
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(pairCodeOf(error)).toBe("pair_rate_limited");
    }
  });
});
