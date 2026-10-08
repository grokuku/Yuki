/**
 * Autorité de certification interne de Yuki (Lot 4, B2, décision D115).
 *
 * Yuki porte une autorité ECDSA P-256 qui **signe le certificat client d'un
 * agent au moment de l'appairage**. Le couple CA (clé privée incluse) est
 * **persisté sur le volume `state`** et **ne quitte JAMAIS Yuki** : seul le
 * certificat (public) est transmis, jamais la clé du CA.
 *
 * Le certificat client porte :
 *   - `subject CN = agent_id` et `subjectAltName DNS = agent_id` (UUID) ;
 *   - `extendedKeyUsage = clientAuth`, `keyUsage = digitalSignature` ;
 *   - une validité d'**un an** (renouvelable — voir `renewClientCertificate`).
 *
 * ⚠️ Permissions : le dossier du CA est créé en `0700`, la clé privée en
 * `0600`, le certificat en `0644` — même logique restrictive que le reste des
 * secrets sur le volume `state`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPrivateKey, X509Certificate, type KeyObject } from "node:crypto";

import {
  KEY_USAGE,
  EKU_OID,
  createSelfSignedCertificate,
  createSignedCertificate,
  derFromPem,
  dnsNamesOf,
  fingerprintHex,
  generateEcKeyPair,
  parseCertificate,
  parseIpBytes,
  privateKeyPkcs8Pem,
  publicKeySpkiDer,
  type CertificateSpec,
  type EcKeyPair,
} from "./x509.js";

/** CN du CA interne (constant, inscrit dans les certificats). */
export const CA_COMMON_NAME = "Yuki Internal CA";

/** Validité d'un certificat client (D115 : un an). */
export const CLIENT_CERT_VALIDITY_DAYS = 365;

/** Marge appliquée à `notBefore` (horloges désynchronisées entre machines). */
const CLOCK_SKEW_MS = 5 * 60_000;

export interface CaLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface CertificateAuthorityOptions {
  /** Dossier de persistance (volume `state`, ex. `/data/state/agents-ca`). */
  dir: string;
  logger?: CaLogger;
  now?: () => number;
}

export interface ClientCertificate {
  agentId: string;
  certPem: string;
  keyPem: string;
  /** Empreinte SHA-256 du certificat (hex minuscule). */
  fingerprint: string;
  notAfter: string;
}

export interface ServerCertificate {
  certPem: string;
  keyPem: string;
}

/** Écrit un fichier de façon atomique (temp + rename) avec permissions données. */
function writeAtomic(path: string, data: string, mode: number): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
  chmodSync(path, mode);
}

/** Extrait le CN d'une chaîne `subject`/`issuer` de `node:crypto`. */
export function commonNameFromSubject(subject: string): string | null {
  const match = /(?:^|,)\s*CN=([^,]+)/.exec(subject);
  return match ? (match[1] as string).trim() : null;
}

export class CertificateAuthority {
  private readonly dir: string;
  private readonly logger?: CaLogger;
  private readonly now: () => number;

  private readonly caCertPem: string;
  private readonly caCert: X509Certificate;
  private readonly caKeyPem: string;
  private readonly caSubjectCn: string;

  private constructor(options: CertificateAuthorityOptions, loaded: {
    certPem: string;
    keyPem: string;
    subjectCn: string;
  }) {
    this.dir = options.dir;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.caCertPem = loaded.certPem;
    this.caCert = parseCertificate(loaded.certPem);
    this.caKeyPem = loaded.keyPem;
    this.caSubjectCn = loaded.subjectCn;
  }

  /**
   * Ouvre (ou crée) le CA : génère le couple auto-signé s'il n'existe pas,
   * le recharge sinon. Le dossier et la clé reçoivent des permissions
   * restrictives.
   */
  static open(options: CertificateAuthorityOptions): CertificateAuthority {
    const certPath = join(options.dir, "agents-ca.crt");
    const keyPath = join(options.dir, "agents-ca.key");
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });

    if (existsSync(certPath) && existsSync(keyPath)) {
      const certPem = readFileSync(certPath, "utf8");
      const keyPem = readFileSync(keyPath, "utf8");
      const cert = parseCertificate(certPem);
      const subjectCn = commonNameFromSubject(cert.subject) ?? CA_COMMON_NAME;
      try {
        chmodSync(keyPath, 0o600);
      } catch {
        // Bestseller : un système de fichiers sans permissions POSIX ne doit pas
        // empêcher l'ouverture du CA.
      }
      options.logger?.info("agents.ca.loaded", {
        dir: options.dir,
        subject: subjectCn,
        fingerprint: fingerprintHex(derFromPem(certPem)),
      });
      return new CertificateAuthority(options, { certPem, keyPem, subjectCn });
    }

    const keys = generateEcKeyPair();
    const now = options.now ? options.now() : Date.now();
    const spec: CertificateSpec & { subjectPublicKeyDer: Buffer; privateKey: KeyObject } = {
      commonName: CA_COMMON_NAME,
      subjectPublicKeyDer: publicKeySpkiDer(keys.publicKey),
      privateKey: keys.privateKey,
      notBefore: new Date(now - CLOCK_SKEW_MS),
      notAfter: new Date(now + 3650 * 86_400_000),
      keyUsage: [KEY_USAGE.keyCertSign, KEY_USAGE.cRLSign, KEY_USAGE.digitalSignature],
      isCa: true,
    };
    const generated = createSelfSignedCertificate(spec);
    writeAtomic(certPath, generated.certPem, 0o644);
    writeAtomic(keyPath, privateKeyPkcs8Pem(keys.privateKey), 0o600);
    options.logger?.info("agents.ca.created", {
      dir: options.dir,
      subject: CA_COMMON_NAME,
      fingerprint: generated.fingerprint,
    });
    return new CertificateAuthority(options, {
      certPem: generated.certPem,
      keyPem: privateKeyPkcs8Pem(keys.privateKey),
      subjectCn: CA_COMMON_NAME,
    });
  }

  /** Certificat du CA en PEM (transmis aux agents au moment de l'appairage). */
  get certificatePem(): string {
    return this.caCertPem;
  }

  /** Empreinte SHA-256 du CA (hex minuscule) — sert de PIN côté agent. */
  get fingerprint(): string {
    return fingerprintHex(this.caCert.raw);
  }

  /** Sujet (CN) du CA. */
  get subjectCn(): string {
    return this.caSubjectCn;
  }

  get certificate(): X509Certificate {
    return this.caCert;
  }

  /**
   * Signe un certificat client pour `agentId` (SAN = agent_id).
   *
   * `validityDays` borne la validité (défaut un an, D115). Le chemin de
   * RENOUVELLEMENT réutilise cette même méthode (voir le serveur mTLS).
   */
  signClientCertificate(
    agentId: string,
    options: { validityDays?: number } = {},
  ): ClientCertificate {
    if (typeof agentId !== "string" || agentId.trim().length === 0) {
      throw new Error("identifiant d'agent vide : certificat impossible");
    }
    const keys: EcKeyPair = generateEcKeyPair();
    const now = this.now();
    const days = options.validityDays ?? CLIENT_CERT_VALIDITY_DAYS;
    const notAfter = new Date(now + days * 86_400_000);
    const signed = createSignedCertificate(
      { commonName: this.caSubjectCn, privateKey: this.caPrivateKey() },
      {
        commonName: agentId,
        subjectPublicKeyDer: publicKeySpkiDer(keys.publicKey),
        notBefore: new Date(now - CLOCK_SKEW_MS),
        notAfter,
        keyUsage: [KEY_USAGE.digitalSignature],
        extendedKeyUsage: [EKU_OID.clientAuth],
        dnsNames: [agentId],
      },
    );
    return {
      agentId,
      certPem: signed.certPem,
      keyPem: privateKeyPkcs8Pem(keys.privateKey),
      fingerprint: signed.fingerprint,
      notAfter: notAfter.toISOString(),
    };
  }

  /**
   * Renouvelle le certificat d'un agent DÉJÀ appairé, en conservant le même
   * `agentId` (donc le même SAN). ⚠️ Le renouvellement n'est appelable QUE sur
   * le canal mTLS (voir `createAgentsServer`), jamais en premier contact.
   */
  renewClientCertificate(agentId: string): ClientCertificate {
    if (!agentId || agentId.trim().length === 0) {
      throw new Error("renouvellement : identifiant d'agent requis");
    }
    return this.signClientCertificate(agentId);
  }

  /**
   * Certificat SERVEUR du port machines, signé par le CA et persisté.
   *
   * Les SAN demandés (`dnsNames` + `ipAddresses`) doivent tous être présents :
   * à défaut, le couple est régénéré (cas d'un changement d'hôte d'écoute ou de
   * `agents.serverName`, voir `serverCertificateNames`).
   *
   * ⚠️ La RÉGÉNÉRATION ne touche QUE `agents-server.crt` / `agents-server.key` :
   * la clé du CA (`agents-ca.key`) n'est JAMAIS réécrite ici. Les agents déjà
   * appairés ont épinglé le CA ⇒ leur confiance reste valable après une
   * régénération (aucun ré-appairage nécessaire).
   */
  ensureServerCertificate(serverNames: {
    dnsNames: readonly string[];
    ipAddresses: readonly string[];
    validityDays?: number;
  }): ServerCertificate {
    const certPath = join(this.dir, "agents-server.crt");
    const keyPath = join(this.dir, "agents-server.key");
    if (existsSync(certPath) && existsSync(keyPath)) {
      const certPem = readFileSync(certPath, "utf8");
      const keyPem = readFileSync(keyPath, "utf8");
      if (this.coversNames(certPem, serverNames)) {
        return { certPem, keyPem };
      }
      this.logger?.info("agents.server_cert.regenerate", {
        reason: "SAN manquants",
      });
    }
    const keys = generateEcKeyPair();
    const now = this.now();
    const signed = createSignedCertificate(
      { commonName: this.caSubjectCn, privateKey: this.caPrivateKey() },
      {
        commonName: "yuki-agents",
        subjectPublicKeyDer: publicKeySpkiDer(keys.publicKey),
        notBefore: new Date(now - CLOCK_SKEW_MS),
        notAfter: new Date(now + (serverNames.validityDays ?? 825) * 86_400_000),
        keyUsage: [KEY_USAGE.digitalSignature],
        extendedKeyUsage: [EKU_OID.serverAuth],
        dnsNames: [...serverNames.dnsNames],
        ipAddresses: [...serverNames.ipAddresses],
      },
    );
    const keyPem = privateKeyPkcs8Pem(keys.privateKey);
    writeAtomic(certPath, signed.certPem, 0o644);
    writeAtomic(keyPath, keyPem, 0o600);
    return { certPem: signed.certPem, keyPem };
  }

  /** `true` si le certificat couvre tous les noms demandés (DNS + IP). */
  private coversNames(
    certPem: string,
    serverNames: { dnsNames: readonly string[]; ipAddresses: readonly string[] },
  ): boolean {
    try {
      const cert = parseCertificate(certPem);
      const dns = new Set(dnsNamesOf(cert).map((n) => n.toLowerCase()));
      for (const name of serverNames.dnsNames) {
        if (!dns.has(name.toLowerCase())) return false;
      }
      for (const ip of serverNames.ipAddresses) {
        if (!isCoveredIp(cert, ip)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private caPrivateKey(): KeyObject {
    return createPrivateKey(this.caKeyPem);
  }
}

/** `true` si l'adresse IP apparaît dans le `subjectAltName` du certificat. */
function isCoveredIp(cert: X509Certificate, ip: string): boolean {
  // Comparaison par OCTETS, pas par chaîne : Node rend les IP du SAN sous une
  // forme canonique (`IP Address:2001:db8::1`) qui peut différer de l'écriture
  // demandée (`2001:0db8:0:0:0:0:0:1`) sans que l'adresse soit différente.
  const wanted = parseIpBytes(ip);
  if (!wanted) return false;
  const alt = cert.subjectAltName ?? "";
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

/** Nom de dossier par défaut du CA dans un volume `state`. */
export function caDirectoryIn(stateDir: string): string {
  return join(stateDir, "agents-ca");
}
