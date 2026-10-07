/**
 * Trames filaires de l'appairage (Lot 4) — miroir de `agent/internal/proto`
 * (Go). `[]byte` Go ⇔ base64 standard (RFC 4648) en JSON.
 *
 * ⚠️ Le serveur TS DOIT produire `pair_ok` et `payload` avec EXACTEMENT les
 * mêmes clés que le Go, sinon le client Go ne déchiffre/parse rien.
 */

import { PairError } from "./errors.js";

/** Version du protocole filaire (identique à `proto.Version`). */
export const PAIR_PROTO_VERSION = 1;

/** Trame `pair_begin` (agent → Yuki). */
export interface PairBeginFrame {
  type: "pair_begin";
  protoVersion: number;
  agentNonce: Buffer;
  agentPubkey?: Buffer;
  yukiFpClaimed: string;
  proof: Buffer;
}

/** Trame `pair_ok` (Yuki → agent). */
export interface PairOkFrame {
  type: "pair_ok";
  protoVersion: number;
  yukiNonce: Buffer;
  blob: Buffer;
}

/** Contenu en clair du blob `pair_ok` (clés identiques au `pair.Payload` Go). */
export interface PairPayload {
  caCert: string;
  clientCert: string;
  clientKey: string;
  agentId: string;
  caFingerprint: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PairError("invalid_json", "trame JSON non-objet");
  }
  return value as Record<string, unknown>;
}

function base64Field(
  record: Record<string, unknown>,
  name: string,
  optional = false,
): Buffer | undefined {
  const value = record[name];
  if (value === undefined || value === null || value === "") {
    if (optional) return undefined;
    throw new PairError("malformed_message", `champ \`${name}\` absent`);
  }
  if (typeof value !== "string") {
    throw new PairError("malformed_message", `champ \`${name}\` non textuel`);
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0) {
    throw new PairError("malformed_message", `champ \`${name}\` base64 illisible`);
  }
  return buffer;
}

function stringField(
  record: Record<string, unknown>,
  name: string,
  optional = false,
): string {
  const value = record[name];
  if (value === undefined || value === null) {
    if (optional) return "";
    throw new PairError("malformed_message", `champ \`${name}\` absent`);
  }
  if (typeof value !== "string") {
    throw new PairError("malformed_message", `champ \`${name}\` non textuel`);
  }
  return value;
}

/** Analyser le texte brut d'une `pair_begin`. */
export function parsePairBegin(text: string): PairBeginFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PairError("invalid_json", "JSON invalide");
  }
  return decodePairBegin(raw);
}

/** Valider un objet déjà décodé comme `pair_begin`. */
export function decodePairBegin(raw: unknown): PairBeginFrame {
  const record = asRecord(raw);
  const type = stringField(record, "type");
  if (type !== "pair_begin") {
    throw new PairError("unknown_type", `type inattendu : ${JSON.stringify(type)}`);
  }
  const version = record["proto_version"];
  if (typeof version !== "number" || version !== PAIR_PROTO_VERSION) {
    throw new PairError(
      "unsupported_version",
      `proto_version ${String(version)} non supportée (attendue ${PAIR_PROTO_VERSION})`,
    );
  }
  const agentNonce = base64Field(record, "agent_nonce");
  const proof = base64Field(record, "proof");
  const agentPubkey = base64Field(record, "agent_pubkey", true);
  const yukiFpClaimed = stringField(record, "yuki_fp_claimed", true);
  return {
    type: "pair_begin",
    protoVersion: PAIR_PROTO_VERSION,
    agentNonce: agentNonce as Buffer,
    ...(agentPubkey ? { agentPubkey } : {}),
    yukiFpClaimed,
    proof: proof as Buffer,
  };
}

/** Sérialiser une `pair_ok` (clés filaires identiques au Go). */
export function encodePairOk(ok: { yukiNonce: Buffer; blob: Buffer }): PairOkFrame {
  return {
    type: "pair_ok",
    protoVersion: PAIR_PROTO_VERSION,
    yukiNonce: ok.yukiNonce,
    blob: ok.blob,
  };
}

/** Représentation JSON d'une `pair_ok` (base64, `proto_version`). */
export function pairOkToJson(ok: PairOkFrame): Record<string, unknown> {
  return {
    type: "pair_ok",
    proto_version: PAIR_PROTO_VERSION,
    yuki_nonce: ok.yukiNonce.toString("base64"),
    blob: ok.blob.toString("base64"),
  };
}

/** Sérialise le contenu d'appairage (clés `ca_cert`, `client_cert`, …). */
export function marshalPayload(payload: PairPayload): Buffer {
  const record: Record<string, string> = {
    ca_cert: payload.caCert,
    client_cert: payload.clientCert,
    client_key: payload.clientKey,
    agent_id: payload.agentId,
    ca_fingerprint: payload.caFingerprint,
  };
  return Buffer.from(JSON.stringify(record), "utf8");
}

/** Analyse le contenu déchiffré. Champs obligatoires vérifiés. */
export function parsePayload(data: Uint8Array): PairPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(data).toString("utf8"));
  } catch {
    throw new PairError("pair_payload_malformed", "contenu JSON illisible");
  }
  const record = asRecord(raw);
  const caCert = stringField(record, "ca_cert");
  const clientCert = stringField(record, "client_cert");
  const clientKey = stringField(record, "client_key");
  const agentId = stringField(record, "agent_id");
  const caFingerprint = stringField(record, "ca_fingerprint", true);
  if (!caCert || !clientCert || !clientKey || !agentId) {
    throw new PairError("pair_payload_malformed", "champs obligatoires manquants");
  }
  return { caCert, clientCert, clientKey, agentId, caFingerprint };
}
