/**
 * Port « machines » de Yuki (Lot 4, B2/B3) — écoute HTTPS dédiée, **hors Caddy
 * et hors authentik** (D114/D116), protégée par **mTLS** (D115).
 *
 * ⚠️ **Mode « premier contact » — porte d'entrée NON authentifiée.** Un agent
 * neuf n'a pas encore de certificat client : le serveur accepte donc, **sans
 * certificat**, UNIQUEMENT les routes d'appairage :
 *
 *   - `POST /api/pair`          (dépose une `pair_begin`) ;
 *   - `GET  /api/pair/<pairId>` (récupère le `pair_ok` chiffré).
 *
 * Ce mode est **borné** :
 *
 *   - les routes d'appairage ne peuvent **rien exécuter** (aucune commande) ;
 *   - le corps est plafonné (`maxBodyBytes`) et le JSON validé (type/version) ;
 *   - les `pair_begin` sont limitées par IP et le nombre de trames en attente
 *     est borné (`PairingManager`) ;
 *   - **toute autre route** (état, renouvellement, WS d'exécution) exige un
 *     certificat client **chaîné au CA de Yuki**, dont le SAN (`agent_id`) est
 *     **connu du store** et **non révoqué**.
 *
 * Le transport d'exécution WebSocket est monté sur cette écoute (upgrade), mais
 * **réservé aux agents authentifiés** : le mode premier contact ne l'ouvre pas.
 */

import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";

import { WebSocket, WebSocketServer } from "ws";

import type { AuditLog } from "./audit.js";
import type { CertificateAuthority } from "./ca.js";
import { AgentConnection, AgentHub } from "./connection.js";
import { PairError } from "./errors.js";
import { parsePairBegin } from "./pair-protocol.js";
import { pairOkJson, type PairingManager, type PairingOutcome } from "./pairing.js";
import type { AgentStore } from "./store.js";

/** Chemin d'appairage (dépôt de la `pair_begin`). */
export const AGENTS_PAIR_PATH = "/api/pair";
/** Chemin de scrutation d'un appairage (`/api/pair/<pairId>`). */
export const AGENTS_PAIR_PREFIX = `${AGENTS_PAIR_PATH}/`;
/** Chemin d'identité de l'agent authentifié. */
export const AGENTS_WHOAMI_PATH = "/api/agent/whoami";
/** Chemin de renouvellement du certificat (mTLS obligatoire). */
export const AGENTS_RENEW_PATH = "/api/agent/renew";
/** Chemin du transport d'exécution WebSocket (mTLS obligatoire). */
export const AGENTS_WS_PATH = "/ws";
/** Taille maximale d'un corps d'appairage. */
export const MAX_AGENTS_BODY_BYTES = 64 * 1024;

export interface AgentsServerLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface AgentsServerOptions {
  /** Certificat serveur (signé par le CA interne), PEM. */
  certPem: string;
  /** Clé privée du certificat serveur, PEM PKCS#8. */
  keyPem: string;
  /** Certificat du CA interne, PEM (sert de `ClientCAs`). */
  caCertPem: string;
  pairing: PairingManager;
  store: AgentStore;
  audit: AuditLog;
  ca: CertificateAuthority;
  /**
   * Registre des connexions d'exécution (B6). Fourni par le câblage pour que
   * l'outil du modèle et les routes partagent les mêmes canaux ; sinon, un hub
   * local est créé (tests, usages isolés).
   */
  hub?: AgentHub;
  logger: AgentsServerLogger;
  now?: () => number;
  maxBodyBytes?: number;
}

interface PeerIdentity {
  agentId: string | null;
  fingerprint: string | null;
  /** `true` si la chaîne du certificat client remonte au CA du serveur. */
  chainOk: boolean;
}

interface JsonResponse {
  status: number;
  body: unknown;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function normalizePath(rawUrl: string | undefined): string {
  const url = new URL(rawUrl ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/** Identité présentée par le pair (certificat client, s'il y en a un). */
function peerIdentity(req: IncomingMessage): PeerIdentity {
  const socket = req.socket as TLSSocket;
  const cert = socket.getPeerCertificate?.();
  const hasCert = Boolean(cert && cert.raw && Object.keys(cert).length > 0);
  if (!hasCert) return { agentId: null, fingerprint: null, chainOk: false };
  const alt = cert.subjectaltname ?? "";
  const dns = alt
    .split(",")
    .map((part) => part.trim())
    .find((part) => part.startsWith("DNS:"));
  return {
    agentId: dns ? dns.slice(4) : null,
    fingerprint: cert.fingerprint256 ?? null,
    chainOk: socket.authorized === true,
  };
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(new PairError("malformed_message", "corps trop volumineux"));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

/** Statut HTTP associé à un code d'erreur d'appairage. */
function statusForPairCode(code: string): number {
  switch (code) {
    case "proof_invalid":
      return 401;
    case "pair_rate_limited":
      return 429;
    case "pair_code_used":
    case "pair_replay":
      return 409;
    case "pair_code_expired":
      return 410;
    case "internal_error":
      return 500;
    default:
      return 400;
  }
}

function errorBody(code: string, message: string): Record<string, unknown> {
  return { error: code, code, message };
}

function sendJson(res: ServerResponse, response: JsonResponse): void {
  const payload = JSON.stringify(response.body);
  res.writeHead(response.status, {
    ...JSON_HEADERS,
    "content-length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

/** Fabrique le serveur HTTPS du port machines. */
export function createAgentsServer(options: AgentsServerOptions): HttpsServer {
  const { pairing, store, audit, ca, logger } = options;
  const maxBody = options.maxBodyBytes ?? MAX_AGENTS_BODY_BYTES;
  const wss = new WebSocketServer({ noServer: true });
  const hub = options.hub ?? new AgentHub({ logger });

  /** L'agent est-il authentifié (chaîne CA + SAN connue + non révoqué) ? */
  function authorizedAgent(identity: PeerIdentity): string | null {
    if (!identity.chainOk || !identity.agentId) return null;
    if (!store.has(identity.agentId)) return null;
    if (store.isRevoked(identity.agentId)) return null;
    return identity.agentId;
  }

  async function handleBegin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: Buffer;
    try {
      body = await readBody(req, maxBody);
    } catch (error) {
      const code = error instanceof PairError ? error.code : "malformed_message";
      sendJson(res, { status: 413, body: errorBody(code, "corps d'appairage invalide") });
      return;
    }
    try {
      const begin = parsePairBegin(body.toString("utf8"));
      const result = pairing.beginPairing(begin, { ip: clientIp(req) });
      if (result.status === "ok") {
        sendJson(res, { status: 200, body: pairOkJson(result.outcome) });
        return;
      }
      sendJson(res, {
        status: 202,
        body: {
          status: "pending",
          pair_id: result.pairId,
          retry_after_ms: result.retryAfterMs,
        },
      });
    } catch (error) {
      const code = error instanceof PairError ? error.code : "internal_error";
      const message = error instanceof Error ? error.message : "appairage impossible";
      logger.warn("agents.pair.begin_failed", { code, ip: clientIp(req) });
      sendJson(res, { status: statusForPairCode(code), body: errorBody(code, message) });
    }
  }

  function handlePoll(pairId: string, res: ServerResponse): void {
    try {
      const result = pairing.pollPairing(pairId);
      if (result.status === "ok") {
        sendJson(res, { status: 200, body: pairOkJson(result.outcome) });
        return;
      }
      sendJson(res, {
        status: 202,
        body: { status: "pending", retry_after_ms: result.retryAfterMs },
      });
    } catch (error) {
      const code = error instanceof PairError ? error.code : "internal_error";
      const message = error instanceof Error ? error.message : "appairage inconnu";
      sendJson(res, { status: statusForPairCode(code), body: errorBody(code, message) });
    }
  }

  function handleWhoami(agentId: string, res: ServerResponse): void {
    const record = store.get(agentId);
    sendJson(res, {
      status: 200,
      body: {
        agent_id: agentId,
        level: record?.level ?? null,
        privilege: record?.privilege ?? null,
        last_seen: record?.lastSeen ?? null,
        revoked: record?.revoked ?? false,
      },
    });
  }

  function handleRenew(agentId: string, req: IncomingMessage, res: ServerResponse): void {
    try {
      const renewed = ca.renewClientCertificate(agentId);
      audit.append({
        event: "renew",
        agentId,
        meta: { ip: clientIp(req) },
      });
      logger.info("agents.renew.ok", { agent_id: agentId });
      sendJson(res, {
        status: 200,
        body: {
          ca_cert: ca.certificatePem,
          ca_fingerprint: ca.fingerprint,
          client_cert: renewed.certPem,
          client_key: renewed.keyPem,
          not_after: renewed.notAfter,
        },
      });
    } catch (error) {
      logger.warn("agents.renew.failed", {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      sendJson(res, {
        status: 500,
        body: errorBody("internal_error", "renouvellement impossible"),
      });
    }
  }

  const server = createHttpsServer(
    {
      cert: options.certPem,
      key: options.keyPem,
      ca: options.caCertPem,
      requestCert: true,
      // ⚠️ La vérification de chaîne est faite APPLICATIVEMENT : `rejectUnauthorized`
      // reste faux pour laisser passer le PREMIER CONTACT (sans certificat), et
      // chaque route décide si un certificat valide est requis.
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
    },
    (req: IncomingMessage, res: ServerResponse) => {
      void handleRequest(req, res).catch((error: unknown) => {
        logger.error("agents.request.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          sendJson(res, { status: 500, body: errorBody("internal_error", "erreur interne") });
        } else {
          res.end();
        }
      });
    },
  );

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = normalizePath(req.url);
    const method = (req.method ?? "GET").toUpperCase();
    logger.debug("agents.request", { path, method, ip: clientIp(req) });

    // ── Routes d'appairage : accessibles SANS certificat (premier contact). ──
    if (path === AGENTS_PAIR_PATH && method === "POST") {
      await handleBegin(req, res);
      return;
    }
    if (path.startsWith(AGENTS_PAIR_PREFIX) && method === "GET") {
      const pairId = path.slice(AGENTS_PAIR_PREFIX.length);
      handlePoll(pairId, res);
      return;
    }

    // ── Toutes les autres routes exigent un agent authentifié. ───────────────
    const identity = peerIdentity(req);
    const agentId = authorizedAgent(identity);
    if (!agentId) {
      const code = identity.agentId && identity.chainOk ? "forbidden" : "unauthorized";
      logger.warn("agents.request.unauthorized", {
        path,
        ip: clientIp(req),
        presented: identity.agentId ?? null,
        chain_ok: identity.chainOk,
      });
      sendJson(res, {
        status: identity.agentId && identity.chainOk ? 403 : 401,
        body: errorBody(code, "certificat client requis ou agent non autorisé"),
      });
      return;
    }

    if (path === AGENTS_WHOAMI_PATH && (method === "GET" || method === "HEAD")) {
      handleWhoami(agentId, res);
      return;
    }
    if (path === AGENTS_RENEW_PATH && method === "POST") {
      handleRenew(agentId, req, res);
      return;
    }
    sendJson(res, { status: 404, body: { error: "not_found", path } });
  }

  // ── Upgrade WebSocket (transport d'exécution — agents authentifiés only) ───
  server.on("upgrade", (req, socket, head) => {
    const path = normalizePath(req.url);
    const identity = peerIdentity(req);
    const agentId = authorizedAgent(identity);
    if (path !== AGENTS_WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!agentId) {
      logger.warn("agents.ws.unauthorized", {
        ip: clientIp(req),
        presented: identity.agentId ?? null,
      });
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      onConnection(ws, agentId);
    });
  });

  function onConnection(ws: WebSocket, agentId: string): void {
    logger.info("agents.ws.connected", { agent_id: agentId });
    try {
      store.markSeen(agentId);
    } catch (error) {
      logger.warn("agents.ws.mark_seen_failed", {
        agent_id: agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    audit.append({ event: "connection", agentId, meta: { transport: "ws" } });

    // Canal d'exécution RÉEL (B6) : Yuki peut désormais envoyer `cmd` et
    // corréler `ack`/`result`/`error` ; l'agent, lui, envoie `hello`.
    const connection = new AgentConnection({
      ws,
      agentId,
      logger,
      onClose: (closed) => {
        hub.unregister(closed);
        logger.debug("agents.ws.closed", { agent_id: closed.agentId });
      },
    });
    hub.register(connection);
    // Pousse la configuration courante de l'agent (niveau D118 + privilège
    // D120). L'agent la journalise ; la décision reste dans Yuki.
    const record = store.get(agentId);
    if (record) connection.pushConfig(record.level, record.privilege);
  }

  server.on("tlsClientError", (error: Error) => {
    logger.debug("agents.tls.client_error", { error: error.message });
  });

  server.on("close", () => {
    hub.closeAll();
    wss.close();
  });

  return server;
}

/** Démarre l'écoute et résout quand le port est ouvert. */
export function startAgentsServer(
  server: HttpsServer,
  host: string,
  port: number,
): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve(server.address() as AddressInfo);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/** Ferme le serveur (et le WebSocketServer associé). */
export function closeAgentsServer(server: HttpsServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export type { PairingOutcome };
