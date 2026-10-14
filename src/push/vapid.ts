/**
 * Clés VAPID (RFC 8292) — génération UNIQUE, stockage 0600, signature ES256.
 *
 * ⚠️ RÈGLE ABSOLUE : la clé PRIVÉE ne quitte JAMAIS ce module sous forme
 * exploitable par l'API, l'UI, les journaux ou les tests. Seule `publicKey`
 * (point P-256 non compressé, base64url) est exposée — c'est elle que le
 * navigateur transmet au service de push dans `applicationServerKey`.
 *
 * Aucune dépendance externe : `node:crypto` suffit (courbe prime256v1).
 */

import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Logger } from "../observability/logger.js";

export interface VapidKeys {
  /** Point P-256 non compressé (65 octets) en base64url — PUBLIC. */
  publicKey: string;
  /** Scalaire privé (32 octets) en base64url — JAMAIS exposé. */
  privateKey: string;
}

interface VapidFile {
  schemaVersion: 1;
  createdAt: string;
  publicKey: string;
  privateKey: string;
}

export const VAPID_FILE_SCHEMA_VERSION = 1;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Encode un scalaire/point brut en base64url (sans remplissage). */
function toBase64Url(buffer: Buffer): string {
  return buffer.toString("base64url");
}

/**
 * Génère une paire VAPID neuve. La clé publique est le point non compressé
 * (`0x04 || x || y`), format attendu par les services de push.
 */
export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const pub = publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
  const priv = privateKey.export({ format: "jwk" }) as { d?: string };
  if (!pub.x || !pub.y || !priv.d) {
    throw new Error("Export JWK incomplet pour la paire VAPID.");
  }
  const x = Buffer.from(pub.x, "base64url");
  const y = Buffer.from(pub.y, "base64url");
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("Point P-256 de taille inattendue.");
  }
  return {
    publicKey: toBase64Url(Buffer.concat([Buffer.from([0x04]), x, y])),
    privateKey: priv.d,
  };
}

/**
 * Reconstruit l'objet clé privée (Node) à partir des DEUX composantes stockées.
 * Le scalaire `d` est combiné au point public `x`/`y` — la clé publique est
 * portée par `publicKey` (65 octets), d'où l'on extrait `x` et `y`.
 */
export function privateKeyObject(keys: VapidKeys): KeyObject {
  const point = Buffer.from(keys.publicKey, "base64url");
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error("Clé publique VAPID invalide (point non compressé attendu).");
  }
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
      d: keys.privateKey,
    },
    format: "jwk",
  });
}

/** JSON compact encodé base64url (en-tête/charge utile JWT). */
function jsonBase64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Construit l'en-tête `Authorization` VAPID pour une audience donnée.
 * `subject` doit être un `mailto:` ou une URL (exigence des services de push).
 * Le JWT est signé ES256 (`dsaEncoding: "ieee-p1363"` ⇒ R||S brut, format JWS).
 */
export function vapidAuthorization(input: {
  keys: VapidKeys;
  audience: string;
  subject: string;
  nowMs: number;
  ttlSeconds?: number;
}): string {
  const ttl = input.ttlSeconds ?? 12 * 60 * 60;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: input.audience,
    exp: Math.floor(input.nowMs / 1000) + ttl,
    sub: input.subject,
  };
  const signingInput = `${jsonBase64Url(header)}.${jsonBase64Url(payload)}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: privateKeyObject(input.keys),
    dsaEncoding: "ieee-p1363",
  });
  const jwt = `${signingInput}.${signature.toString("base64url")}`;
  return `vapid t=${jwt}, k=${input.keys.publicKey}`;
}

/** Écrit le fichier de clés de façon atomique, en 0600. */
function writeVapidFile(path: string, keys: VapidKeys, createdAt: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const file: VapidFile = {
    schemaVersion: VAPID_FILE_SCHEMA_VERSION,
    createdAt,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
  writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Meilleur effort : la création avec `mode` a déjà tenté le 0600.
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Meilleur effort.
  }
}

export interface LoadVapidResult {
  keys: VapidKeys;
  /** `true` si la paire a été créée à cet appel (premier démarrage). */
  created: boolean;
  path: string;
}

/**
 * Charge la paire VAPID depuis `path`, ou la GÉNÈRE puis la persiste si elle
 * est absente. Un fichier illisible est régénéré (les abonnements existants
 * deviennent alors invalides — c'est inévitable et journalisé honnêtement).
 *
 * Ne journalise JAMAIS la clé privée.
 */
export function loadOrCreateVapidKeys(
  path: string,
  logger?: Logger,
  now: () => number = Date.now,
): LoadVapidResult {
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VapidFile>;
      if (
        parsed.schemaVersion === VAPID_FILE_SCHEMA_VERSION &&
        typeof parsed.publicKey === "string" &&
        typeof parsed.privateKey === "string" &&
        parsed.publicKey.length > 0 &&
        parsed.privateKey.length > 0
      ) {
        return { keys: { publicKey: parsed.publicKey, privateKey: parsed.privateKey }, created: false, path };
      }
      logger?.warn("push.vapid.invalid", { path, reason: "contenu inattendu, régénération" });
    } catch (error) {
      logger?.warn("push.vapid.unreadable", { path, error: messageOf(error) });
    }
  }

  const keys = generateVapidKeys();
  writeVapidFile(path, keys, new Date(now()).toISOString());
  return { keys, created: true, path };
}
