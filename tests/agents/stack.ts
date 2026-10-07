/**
 * Outillage commun des tests du Lot 4 : monte une pile complète (store, audit,
 * autorité interne, gestionnaire d'appairage, serveur mTLS) sur un port
 * éphémère, dans un dossier temporaire.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import {
  AgentExecutionService,
  AgentHub,
  AgentStore,
  ApprovalRegistry,
  AuditLog,
  caDirectoryIn,
  CertificateAuthority,
  closeAgentsServer,
  codeKey,
  computeProof,
  createAgentsServer,
  maxSizeBytesFromMb,
  normalizeCode,
  PAIR_NONCE_SIZE,
  PairingManager,
  startAgentsServer,
  type PairBeginFrame,
} from "../../src/agents/index.js";
import { createLogger } from "../../src/observability/logger.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

export interface StackOptions {
  ttlMs?: number;
  maxAttempts?: number;
  maxPending?: number;
  perIp?: { max: number; windowMs: number };
  now?: () => number;
}

export interface TestStack {
  dir: string;
  store: AgentStore;
  audit: AuditLog;
  ca: CertificateAuthority;
  pairing: PairingManager;
  hub: AgentHub;
  approvals: ApprovalRegistry;
  execution: AgentExecutionService;
  server: HttpsServer;
  port: number;
  url: string;
  /** Enregistre un agent appairé dans le store. */
  register(agentId: string): void;
  close(): Promise<void>;
  cleanup(): void;
}

/** Démarre la pile sur 127.0.0.1:0 et renvoie l'URL. */
export async function startTestStack(options: StackOptions = {}): Promise<TestStack> {
  const dir = mkdtempSync(join(tmpdir(), "yuki-agents-stack-"));
  const store = AgentStore.open({
    path: join(dir, "agents.jsonl"),
    defaults: { level: "destructive", privilege: "normal" },
    logger,
  });
  const audit = AuditLog.open({
    path: join(dir, "audit.jsonl"),
    maxSizeBytes: maxSizeBytesFromMb(1),
    retentionDays: 30,
    logger,
  });
  const ca = CertificateAuthority.open({
    dir: caDirectoryIn(dir),
    logger,
    ...(options.now ? { now: options.now } : {}),
  });
  const pairing = new PairingManager({
    ca,
    store,
    audit,
    logger,
    ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.maxPending !== undefined ? { maxPending: options.maxPending } : {}),
    ...(options.perIp ? { perIp: options.perIp } : {}),
  });
  const serverCert = ca.ensureServerCertificate({
    dnsNames: ["localhost"],
    ipAddresses: ["127.0.0.1"],
  });
  const hub = new AgentHub({ logger });
  const approvals = new ApprovalRegistry({ logger });
  const execution = new AgentExecutionService({ store, hub, audit, approvals, logger });
  const server = createAgentsServer({
    certPem: serverCert.certPem,
    keyPem: serverCert.keyPem,
    caCertPem: ca.certificatePem,
    pairing,
    store,
    audit,
    ca,
    hub,
    logger,
  });
  const address = await startAgentsServer(server, "127.0.0.1", 0);
  let closed = false;
  return {
    dir,
    store,
    audit,
    ca,
    pairing,
    hub,
    approvals,
    execution,
    server,
    port: address.port,
    url: `https://127.0.0.1:${address.port}`,
    register(agentId: string) {
      store.markSeen(agentId);
    },
    async close() {
      if (closed) return;
      closed = true;
      hub.closeAll();
      server.closeAllConnections?.();
      await closeAgentsServer(server);
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Construit une `pair_begin` d'agent (miroir du `Client` Go). */
export function agentBegin(
  code: string,
  yukiFpClaimed = "",
  agentNonce: Buffer = randomBytes(PAIR_NONCE_SIZE),
): { frame: PairBeginFrame; agentNonce: Buffer; key: Buffer } {
  const key = codeKey(normalizeCode(code));
  const proof = computeProof(key, Buffer.from(yukiFpClaimed, "utf8"), agentNonce);
  return {
    frame: {
      type: "pair_begin",
      protoVersion: 1,
      agentNonce,
      yukiFpClaimed,
      proof,
    },
    agentNonce,
    key,
  };
}

/** Forme JSON filaire d'une `pair_begin` (base64). */
export function pairBeginJson(frame: PairBeginFrame): Record<string, unknown> {
  return {
    type: "pair_begin",
    proto_version: frame.protoVersion,
    agent_nonce: frame.agentNonce.toString("base64"),
    ...(frame.agentPubkey ? { agent_pubkey: frame.agentPubkey.toString("base64") } : {}),
    ...(frame.yukiFpClaimed ? { yuki_fp_claimed: frame.yukiFpClaimed } : {}),
    proof: frame.proof.toString("base64"),
  };
}

export { logger as testLogger };
