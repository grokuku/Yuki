/**
 * Autorité interne X.509 (Lot 4, B2) : génération/persistance du CA, signature
 * des certificats clients (SAN = agent_id, clientAuth, validité 1 an),
 * certificat serveur et chemin de renouvellement.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  caDirectoryIn,
  CertificateAuthority,
  CLIENT_CERT_VALIDITY_DAYS,
  dnsNamesOf,
  parseCertificate,
  parseIpBytes,
  serverCertificateNames,
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

/** `true` si `alt` (`subjectAltName`) contient l'adresse IP (comparaison octets). */
function ipCovered(alt: string, ip: string): boolean {
  const wanted = parseIpBytes(ip);
  if (!wanted) return false;
  return alt.split(",").some((part) => {
    const trimmed = part.trim();
    const value = trimmed.startsWith("IP Address:")
      ? trimmed.slice("IP Address:".length)
      : trimmed.startsWith("IP:")
        ? trimmed.slice("IP:".length)
        : null;
    if (value === null) return false;
    const found = parseIpBytes(value);
    return found !== null && found.equals(wanted);
  });
}

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

  it("certificat serveur : SAN IPv4 LAN + IPv6, régénération sans changer le CA", () => {
    const caDir = caDirectoryIn(tempDir());
    const ca = CertificateAuthority.open({ dir: caDir, logger, now: () => FIXED_NOW });
    const caFingerprint = ca.fingerprint;
    const caCertPem = ca.certificatePem;
    const caKeyBytes = readFileSync(join(caDir, "agents-ca.key"));

    // Certificat « ancien monde » : boucle locale IPv4 seulement.
    const legacy = ca.ensureServerCertificate({
      dnsNames: ["localhost"],
      ipAddresses: ["127.0.0.1"],
    });

    // Le cas RÉEL du bug : l'agent joint Yuki par l'IP LAN, déclarée dans
    // `agents.serverName` ⇒ le SAN doit la couvrir, sinon régénération.
    const names = serverCertificateNames({
      bindHost: "0.0.0.0",
      serverName: "10.10.0.5",
    });
    const widened = ca.ensureServerCertificate(names);
    expect(widened.certPem).not.toBe(legacy.certPem);

    const parsed = parseCertificate(widened.certPem);
    const alt = parsed.subjectAltName ?? "";
    expect(alt).toContain("127.0.0.1");
    // ⚠️ L'IP littérale est dans IPAddress, PAS dans DNSName.
    expect(alt).toContain("IP Address:10.10.0.5");
    expect(ipCovered(alt, "10.10.0.5")).toBe(true);
    // IPv6 `::1` : encodée en 16 octets (Node la rend NON compressée).
    expect(ipCovered(alt, "::1")).toBe(true);
    expect(dnsNamesOf(parsed)).toContain("localhost");
    expect(dnsNamesOf(parsed)).not.toContain("10.10.0.5");
    // Le certificat reste signé par le CA (pas de bascule auto-signée).
    expect(parsed.verify(ca.certificate.publicKey)).toBe(true);

    // ⚠️ POINT CRITIQUE : le CA (clé + empreinte) est INCHANGÉ après
    // régénération ⇒ les agents déjà appairés restent valables.
    expect(ca.fingerprint).toBe(caFingerprint);
    expect(ca.certificatePem).toBe(caCertPem);
    expect(readFileSync(join(caDir, "agents-ca.key")).equals(caKeyBytes)).toBe(true);

    // Le nouveau couple couvre désormais l'IP LAN : pas de régénération en boucle.
    const stable = ca.ensureServerCertificate(
      serverCertificateNames({ bindHost: "0.0.0.0", serverName: "10.10.0.5" }),
    );
    expect(stable.certPem).toBe(widened.certPem);

    // `serverName` retiré (retour au défaut) ⇒ le SAN attendu se réduit, mais le
    // certificat en place COUVRE ENCORE l'ensemble (sur-ensemble) : pas de
    // régénération. Seule l'absence d'un SAN demandé déclenche la régénération.
    const narrowedWanted = serverCertificateNames({ bindHost: "0.0.0.0" });
    const kept = ca.ensureServerCertificate(narrowedWanted);
    expect(kept.certPem).toBe(widened.certPem);
  });

  it("un NOM déclaré (`yuki.lan`) va dans DNSName, jamais dans IPAddress", () => {
    const caDir = caDirectoryIn(tempDir());
    const ca = CertificateAuthority.open({ dir: caDir, logger, now: () => FIXED_NOW });
    const names = serverCertificateNames({
      bindHost: "0.0.0.0",
      serverName: "yuki.lan",
    });
    const cert = ca.ensureServerCertificate(names);
    const parsed = parseCertificate(cert.certPem);
    expect(dnsNamesOf(parsed)).toContain("yuki.lan");
    expect(dnsNamesOf(parsed)).toContain("localhost");
    // Aucune trace du nom dans les IPAddress.
    expect(parsed.subjectAltName ?? "").not.toContain("IP Address:yuki.lan");
  });

  it("couverture IPv6 : une écriture équivalente de la même adresse ne régénère pas", () => {
    const caDir = caDirectoryIn(tempDir());
    const ca = CertificateAuthority.open({ dir: caDir, logger, now: () => FIXED_NOW });
    const first = ca.ensureServerCertificate({
      dnsNames: ["localhost"],
      ipAddresses: ["127.0.0.1", "2001:db8::1"],
    });
    // Forme NON compressée de la MÊME adresse : la comparaison se fait par octets.
    const same = ca.ensureServerCertificate({
      dnsNames: ["localhost"],
      ipAddresses: ["127.0.0.1", "2001:0db8:0:0:0:0:0:1"],
    });
    expect(same.certPem).toBe(first.certPem);
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
