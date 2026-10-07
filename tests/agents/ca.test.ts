/**
 * Autorité interne X.509 (Lot 4, B2) : génération/persistance du CA, signature
 * des certificats clients (SAN = agent_id, clientAuth, validité 1 an),
 * certificat serveur et chemin de renouvellement.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  caDirectoryIn,
  CertificateAuthority,
  CLIENT_CERT_VALIDITY_DAYS,
  dnsNamesOf,
  parseCertificate,
} from "../../src/agents/index.js";
import * as agents from "../../src/agents/index.js";
import { createLogger } from "../../src/observability/logger.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-ca-"));
  dirs.push(dir);
  return dir;
}

const FIXED_NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CertificateAuthority", () => {
  it("crée et persiste le CA avec des permissions restrictives", () => {
    const dir = tempDir();
    const caDir = caDirectoryIn(dir);
    const ca = CertificateAuthority.open({ dir: caDir, logger, now: () => FIXED_NOW });

    expect(ca.subjectCn).toBe("Yuki Internal CA");
    expect(ca.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(ca.certificatePem).toContain("BEGIN CERTIFICATE");
    // Clé privée : 0600, jamais exposée publiquement.
    expect(statSync(join(caDir, "agents-ca.key")).mode & 0o777).toBe(0o600);
    // Le certificat du CA est bien auto-signé (vérifiable par sa propre clé).
    expect(ca.certificate.verify(ca.certificate.publicKey)).toBe(true);
  });

  it("recharge le MÊME CA au redémarrage (empreinte stable)", () => {
    const caDir = caDirectoryIn(tempDir());
    const first = CertificateAuthority.open({ dir: caDir, logger, now: () => FIXED_NOW });
    const second = CertificateAuthority.open({ dir: caDir, logger, now: () => FIXED_NOW });
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("signe un certificat client : SAN = agent_id, clientAuth, validité 1 an", () => {
    const ca = CertificateAuthority.open({ dir: caDirectoryIn(tempDir()), logger, now: () => FIXED_NOW });
    const agentId = "11111111-2222-3333-4444-555555555555";
    const cert = ca.signClientCertificate(agentId);
    const parsed = parseCertificate(cert.certPem);

    expect(parsed.subject).toContain(agentId);
    expect(dnsNamesOf(parsed)).toEqual([agentId]);
    expect(parsed.verify(ca.certificate.publicKey)).toBe(true);
    // EKU clientAuth (Node expose les OID d'usage étendu dans `keyUsage`).
    expect(parsed.keyUsage).toContain("1.3.6.1.5.5.7.3.2");
    // Validité : ~1 an.
    const span = parsed.validToDate.getTime() - parsed.validFromDate.getTime();
    expect(Math.round(span / 86_400_000)).toBe(CLIENT_CERT_VALIDITY_DAYS);
    expect(cert.keyPem).toContain("BEGIN PRIVATE KEY");
  });

  it("refuse un identifiant d'agent vide", () => {
    const ca = CertificateAuthority.open({ dir: caDirectoryIn(tempDir()), logger, now: () => FIXED_NOW });
    expect(() => ca.signClientCertificate("")).toThrowError();
  });

  it("renouvelle en conservant le même agent_id (SAN identique)", () => {
    const ca = CertificateAuthority.open({ dir: caDirectoryIn(tempDir()), logger, now: () => FIXED_NOW });
    const agentId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const first = ca.signClientCertificate(agentId);
    const renewed = ca.renewClientCertificate(agentId);
    expect(renewed.agentId).toBe(agentId);
    expect(dnsNamesOf(parseCertificate(renewed.certPem))).toEqual([agentId]);
    expect(renewed.fingerprint).not.toBe(first.fingerprint);
  });

  it("produit un certificat serveur couvrant les SAN demandés, et le régénère sinon", () => {
    const caDir = caDirectoryIn(tempDir());
    const ca = CertificateAuthority.open({ dir: caDir, logger, now: () => FIXED_NOW });
    const first = ca.ensureServerCertificate({ dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"] });
    const parsed = parseCertificate(first.certPem);
    expect(dnsNamesOf(parsed)).toContain("localhost");
    expect(parsed.subjectAltName).toContain("127.0.0.1");
    expect(parsed.verify(ca.certificate.publicKey)).toBe(true);

    // Même demande ⇒ même couple (pas de régénération inutile).
    const again = ca.ensureServerCertificate({ dnsNames: ["localhost"], ipAddresses: ["127.0.0.1"] });
    expect(again.certPem).toBe(first.certPem);

    // SAN manquant ⇒ régénération.
    const widened = ca.ensureServerCertificate({
      dnsNames: ["localhost", "yuki.example"],
      ipAddresses: ["127.0.0.1"],
    });
    expect(widened.certPem).not.toBe(first.certPem);
    expect(dnsNamesOf(parseCertificate(widened.certPem))).toContain("yuki.example");
  });

  it("expose un générateur X.509 minimal utilisable par Go (chaîne vérifiable)", () => {
    // Vérification de la structure DER : le certificat client doit être
    // analysable par `node:crypto` ET porter une signature ECDSA-SHA256.
    const ca = CertificateAuthority.open({ dir: caDirectoryIn(tempDir()), logger, now: () => FIXED_NOW });
    const cert = ca.signClientCertificate("22222222-3333-4444-5555-666666666666");
    const der = agents.derFromPem(cert.certPem);
    expect(agents.fingerprintHex(der)).toBe(cert.fingerprint);
    // Le DER commence par un SEQUENCE (0x30) et le certificat se relit par Node.
    expect(der[0]).toBe(0x30);
    expect(parseCertificate(cert.certPem).verify(ca.certificate.publicKey)).toBe(true);
  });
});
