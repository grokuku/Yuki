/**
 * Générateur X.509 minimal (DER) — autorité interne de Yuki (Lot 4, B2, D115).
 *
 * ⚠️ **Pourquoi réécrire et non consommer `@peculiar/x509` ?** La décision du
 * lot autorisait `@peculiar/x509`. À l'usage, ce paquet (v1 comme v2) tire
 * `tsyringe`, qui **exige un polyfill global `reflect-metadata`** au point
 * d'entrée (`Error: tsyringe requires a reflect polyfill`). Ajouter un
 * **polyfill global** à un serveur Node pour générer deux certificats serait un
 * coût disproportionné (et deux dépendances de plus). Yuki n'avait que 3
 * dépendances ; ce module garde ce nombre **inchangé**, en s'appuyant
 * uniquement sur `node:crypto` (clés, signature) — voir le rapport du lot.
 *
 * Ce module n'implémente QUE ce dont l'appairage a besoin : ECDSA P-256,
 * auto-signature d'un CA, signature d'un certificat feuille, extensions
 * `basicConstraints` / `keyUsage` / `extendedKeyUsage` / `subjectAltName`.
 * Rien d'autre (pas de CSR, pas de RSA, pas de parsing DER complet).
 *
 * Toute la structure DER est canonique et vérifiée par les tests (`node:crypto`
 * → `X509Certificate`, puis poignée de main TLS réelle et vérification Go).
 */

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";

/** Paire de clés EC P-256. */
export interface EcKeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

/** Génère une paire de clés EC P-256 (prime256v1). */
export function generateEcKeyPair(): EcKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return { publicKey, privateKey };
}

/** Exporte la SubjectPublicKeyInfo (SPKI) DER d'une clé publique. */
export function publicKeySpkiDer(publicKey: KeyObject): Buffer {
  return publicKey.export({ type: "spki", format: "der" }) as Buffer;
}

/** Exporte une clé privée en PEM PKCS#8 (`-----BEGIN PRIVATE KEY-----`). */
export function privateKeyPkcs8Pem(privateKey: KeyObject): string {
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

/* ─── Encodage DER ──────────────────────────────────────────────────────── */

function derLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let value = len;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Élément TLV : tag, longueur, contenu. */
function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function sequence(...parts: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(parts));
}

function set(...parts: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(parts));
}

/** Encode un entier positif (préfixe 0x00 si le bit de poids fort est à 1). */
function integer(content: Buffer): Buffer {
  let bytes = content.length === 0 ? Buffer.from([0]) : content;
  if ((bytes[0] as number) & 0x80) {
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  }
  return tlv(0x02, bytes);
}

/** Encode un OID depuis sa forme pointée (`1.2.840.10045.4.3.2`). */
function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length < 2 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`OID invalide : ${dotted}`);
  }
  const bytes: number[] = [40 * (parts[0] as number) + (parts[1] as number)];
  for (let i = 2; i < parts.length; i += 1) {
    let value = parts[i] as number;
    const stack: number[] = [value & 0x7f];
    value >>>= 7;
    while (value > 0) {
      stack.push((value & 0x7f) | 0x80);
      value >>>= 7;
    }
    for (let j = stack.length - 1; j >= 0; j -= 1) bytes.push(stack[j] as number);
  }
  return tlv(0x06, Buffer.from(bytes));
}

function utf8(value: string): Buffer {
  return tlv(0x0c, Buffer.from(value, "utf8"));
}

function boolean(value: boolean): Buffer {
  return tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
}

/** UTCTime `YYMMDDHHMMSSZ` (valide pour les années 1950–2049). */
function utcTime(date: Date): Buffer {
  const year = date.getUTCFullYear();
  if (year < 1950 || year > 2049) {
    throw new Error("utcTime : année hors de l'intervalle 1950–2049");
  }
  const p = (n: number, w = 2): string => n.toString().padStart(w, "0");
  const text =
    p(year % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    "Z";
  return tlv(0x17, Buffer.from(text, "ascii"));
}

/** BIT STRING à partir d'indices de bits posés (0 = MSB du premier octet). */
export function bitString(bits: readonly number[]): Buffer {
  if (bits.length === 0) return tlv(0x03, Buffer.from([0]));
  const max = Math.max(...bits);
  const byteCount = Math.floor(max / 8) + 1;
  const bytes = new Uint8Array(byteCount);
  for (const bit of bits) {
    bytes[Math.floor(bit / 8)] |= 0x80 >>> bit % 8;
  }
  const unused = byteCount * 8 - (max + 1);
  return tlv(0x03, Buffer.concat([Buffer.from([unused]), Buffer.from(bytes)]));
}

/** Name X.509 à un seul RDN (`CN=<commonName>`). */
function commonName(cn: string): Buffer {
  return sequence(set(sequence(oid("2.5.4.3"), utf8(cn))));
}

/** Algorithme de signature ecdsa-with-SHA256 (sans paramètres). */
function ecdsaWithSha256(): Buffer {
  return sequence(oid("1.2.840.10045.4.3.2"));
}

/** Extension X.509 : `SEQUENCE { extnID, [critical], extnValue OCTET STRING }`. */
function extension(oidStr: string, critical: boolean, value: Buffer): Buffer {
  const parts: Buffer[] = [oid(oidStr)];
  if (critical) parts.push(boolean(true));
  parts.push(tlv(0x04, value));
  return sequence(...parts);
}

/* ─── Indices de KeyUsage (RFC 5280 4.2.1.3) ─────────────────────────────── */

export const KEY_USAGE = {
  digitalSignature: 0,
  nonRepudiation: 1,
  keyEncipherment: 2,
  dataEncipherment: 3,
  keyAgreement: 4,
  keyCertSign: 5,
  cRLSign: 6,
  encipherOnly: 7,
  decipherOnly: 8,
} as const;

/** OID d'ExtendedKeyUsage. */
export const EKU_OID = {
  serverAuth: "1.3.6.1.5.5.7.3.1",
  clientAuth: "1.3.6.1.5.5.7.3.2",
} as const;

/** Spécification d'un certificat à produire. */
export interface CertificateSpec {
  /** CN du sujet. */
  commonName: string;
  serial?: Buffer;
  notBefore: Date;
  notAfter: Date;
  /** Indices de `keyUsage` (voir `KEY_USAGE`). */
  keyUsage: readonly number[];
  /** OID d'`extendedKeyUsage` (voir `EKU_OID`). */
  extendedKeyUsage?: readonly string[];
  /** Noms DNS du `subjectAltName`. */
  dnsNames?: readonly string[];
  /** Adresses IP du `subjectAltName`. */
  ipAddresses?: readonly string[];
  /** `true` ⇒ `basicConstraints` CA=true (sinon CA=false explicite). */
  isCa?: boolean;
}

/** Numéro de série aléatoire positif (128 bits, bit de poids fort à 0). */
export function randomSerial(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] as number) & 0x7f;
  if (bytes[0] === 0) bytes[0] = 1;
  return bytes;
}

function generalNames(spec: CertificateSpec): Buffer {
  const names: Buffer[] = [];
  for (const dns of spec.dnsNames ?? []) {
    names.push(tlv(0x82, Buffer.from(dns, "ascii")));
  }
  for (const ip of spec.ipAddresses ?? []) {
    names.push(tlv(0x87, ipv4ToBytes(ip)));
  }
  return sequence(...names);
}

/** Convertit une adresse IPv4 pointée en 4 octets. */
export function ipv4ToBytes(ip: string): Buffer {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`adresse IPv4 invalide : ${ip}`);
  }
  return Buffer.from(parts as number[]);
}

function extensionsFor(spec: CertificateSpec): Buffer {
  const list: Buffer[] = [
    extension("2.5.29.19", true, spec.isCa ? sequence(boolean(true)) : sequence()),
  ];
  list.push(extension("2.5.29.15", true, bitString(spec.keyUsage)));
  if (spec.extendedKeyUsage && spec.extendedKeyUsage.length > 0) {
    list.push(
      extension(
        "2.5.29.37",
        false,
        sequence(...spec.extendedKeyUsage.map((o) => oid(o))),
      ),
    );
  }
  if ((spec.dnsNames?.length ?? 0) > 0 || (spec.ipAddresses?.length ?? 0) > 0) {
    list.push(extension("2.5.29.17", false, generalNames(spec)));
  }
  return sequence(...list);
}

function tbsCertificate(
  spec: CertificateSpec,
  issuerName: Buffer,
  subjectPublicKeyDer: Buffer,
): Buffer {
  return sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // version v3
    integer(spec.serial ?? randomSerial()),
    ecdsaWithSha256(),
    issuerName,
    sequence(utcTime(spec.notBefore), utcTime(spec.notAfter)),
    commonName(spec.commonName),
    subjectPublicKeyDer,
    tlv(0xa3, extensionsFor(spec)),
  );
}

function certificateFrom(tbs: Buffer, signatureDer: Buffer): string {
  const der = sequence(
    tbs,
    ecdsaWithSha256(),
    tlv(0x03, Buffer.concat([Buffer.from([0]), signatureDer])),
  );
  return pemFromDer("CERTIFICATE", der);
}

/** Emballe un DER en PEM (lignes de 64 caractères, retour final). */
export function pemFromDer(label: string, der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** Empreinte SHA-256 (hex minuscule) d'un DER de certificat. */
export function fingerprintHex(der: Buffer): string {
  return createHash("sha256").update(der).digest("hex");
}

/** Crée un certificat AUTO-SIGNÉ (CA racine). Renvoie PEM + DER. */
export function createSelfSignedCertificate(
  spec: CertificateSpec & { subjectPublicKeyDer: Buffer; privateKey: KeyObject },
): { certPem: string; der: Buffer; fingerprint: string } {
  const name = commonName(spec.commonName);
  const tbs = tbsCertificate(spec, name, spec.subjectPublicKeyDer);
  const signature = sign("sha256", tbs, spec.privateKey);
  const certPem = certificateFrom(tbs, signature);
  const der = derFromPem(certPem);
  return { certPem, der, fingerprint: fingerprintHex(der) };
}

/** Crée un certificat SIGNÉ par un CA (issuerName = Name du CA). */
export function createSignedCertificate(
  issuer: { commonName: string; privateKey: KeyObject },
  spec: CertificateSpec & { subjectPublicKeyDer: Buffer },
): { certPem: string; der: Buffer; fingerprint: string } {
  const issuerName = commonName(issuer.commonName);
  const tbs = tbsCertificate(spec, issuerName, spec.subjectPublicKeyDer);
  const signature = sign("sha256", tbs, issuer.privateKey);
  const certPem = certificateFrom(tbs, signature);
  const der = derFromPem(certPem);
  return { certPem, der, fingerprint: fingerprintHex(der) };
}

/** Décode le premier bloc CERTIFICATE d'un PEM en DER. */
export function derFromPem(pem: string): Buffer {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem);
  if (!match) throw new Error("PEM de certificat illisible");
  return Buffer.from((match[1] as string).replace(/\s+/g, ""), "base64");
}

/** Parse un certificat PEM via `node:crypto`. */
export function parseCertificate(pem: string): X509Certificate {
  return new X509Certificate(pem);
}

/** Extraction des noms DNS d'un `subjectAltName` (format Node `DNS:x, IP Address:y`). */
export function dnsNamesOf(cert: X509Certificate): string[] {
  const alt = cert.subjectAltName ?? "";
  return alt
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("DNS:"))
    .map((part) => part.slice(4));
}
