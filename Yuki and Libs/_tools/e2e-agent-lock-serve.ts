/**
 * Harnais E2E JETABLE — VERROU « MATÉRIEL SENSIBLE » (décisions utilisateur
 * du 2026-10-24).
 *
 * Câble un gateway RÉEL avec :
 *   - un mot de passe d'INSTANCE connu (`motdepasse-e2e-42`, haché scrypt) ;
 *   - un agent sensible (`agent-nuc00` / « nuc00 ») connecté ⇒ VERROUILLÉ ;
 *   - un agent ordinaire (`agent-nuc01` / « nuc01 ») ⇒ jamais verrouillé ;
 *   - le service d'exécution armé du verrou (preuve du refus + `touch`).
 *
 * Routes E2E UNIQUEMENT (ce harnais est jetable) : `/api/e2e/agent-connect`
 * pour simuler la connexion d'un agent sans mTLS.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-agent-lock-serve.ts"
 * Env : YUKI_E2E_DIR dossier d'état (OBLIGATOIRE).
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { WebSocket } from "ws";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
  AgentConnection,
  AgentDirectoryService,
  AgentExecutionService,
  AgentHub,
  AgentLockService,
  AgentStore,
  ApprovalRegistry,
  AuditLog,
  caDirectoryIn,
  CertificateAuthority,
  maxSizeBytesFromMb,
  PairingManager,
} from "../../src/agents/index.js";
import type { AgentsApiDeps } from "../../src/gateway/routes/agents.js";
import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport, type AgentsGatewayPort } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost } from "../../src/pi/host.js";
import { SessionPinStore } from "../../src/pi/session-pins.js";
import { InstancePasswordStore } from "../../src/security/instance-password.js";
import type { GpuReport } from "../../src/types/gpu.js";

/** Mot de passe d'instance utilisé par l'E2E (haché sur disque, jamais en clair). */
export const E2E_PASSWORD = "motdepasse-e2e-42";

const stateDir = process.env.YUKI_E2E_DIR;
if (!stateDir) throw new Error("YUKI_E2E_DIR requis");
const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
for (const dir of [agentDir, cwd, sessionsDir]) mkdirSync(dir, { recursive: true });

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
});
const config = createConfigRuntime({
  env,
  promptDefaults: { light: "systeme leger", heavy: "systeme lourd" },
});

/** Écrit une session JSONL persistée (user + assistant) et renvoie son id. */
function seedSession(user: string, assistant: string): string {
  const manager = SessionManager.create(cwd, sessionsDir);
  manager.appendMessage({ role: "user", content: user, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: assistant }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  return manager.getSessionId();
}

seedSession("Bonjour, question du fil", "Réponse de test.");

// --- Mot de passe d'INSTANCE + registre d'agents ---------------------------
const password = InstancePasswordStore.open({
  path: join(stateDir, "instance-password.json"),
  logger,
});
password.set(E2E_PASSWORD);

const store = AgentStore.open({
  path: join(stateDir, "agents.jsonl"),
  defaults: { level: "destructive", privilege: "normal" },
  logger,
  canMarkSensitive: () => password.isConfigured(),
});
const audit = AuditLog.open({
  path: join(stateDir, "audit.jsonl"),
  maxSizeBytes: maxSizeBytesFromMb(1),
  retentionDays: 30,
  logger,
});
const ca = CertificateAuthority.open({ dir: caDirectoryIn(stateDir), logger });
const pairing = new PairingManager({ ca, store, audit, logger });
const hub = new AgentHub({ logger });
const approvals = new ApprovalRegistry({ logger });
const lock = new AgentLockService({ store, password, logger });
lock.attachHub(hub);
const execution = new AgentExecutionService({
  store,
  hub,
  audit,
  approvals,
  logger,
  lock,
});
const directory = new AgentDirectoryService({ store, hub, audit, lock, logger });
void execution;
void directory;

// --- Agents : un SENSIBLE (verrouillé) et un ordinaire ---------------------
store.markSeen("agent-nuc00");
store.setName("agent-nuc00", "nuc00");
store.setLevel("agent-nuc00", "never");
store.setSensitive("agent-nuc00", true);
store.markSeen("agent-nuc01");
store.setName("agent-nuc01", "nuc01");
store.setLevel("agent-nuc01", "destructive");

const agentsGateway: AgentsGatewayPort = {
  list: () =>
    store.list().map((record) => {
      const status = lock.status(record.agentId);
      return {
        agentId: record.agentId,
        name: record.name !== "" ? record.name : record.agentId,
        level: record.level,
        revoked: record.revoked,
        online: hub.isOnline(record.agentId),
        lastSeen: record.lastSeen,
        sensitive: record.sensitive === true,
        locked: status.locked,
        ...(status.remainingMs !== undefined ? { unlockRemainingMs: status.remainingMs } : {}),
      };
    }),
  setEnabled: (agentId, enabled) => store.setEnabled(agentId, enabled),
  setLevel: (agentId, level) => store.setLevel(agentId, level),
  subscribe: (listener) => {
    const offStore = store.subscribe(listener);
    const offHub = hub.subscribe(listener);
    const offLock = lock.subscribe(listener);
    return () => {
      offStore();
      offHub();
      offLock();
    };
  },
};

// --- Hôte Pi + transport WS -------------------------------------------------
const host = createPiHost({
  agentDir,
  cwd,
  home: join(stateDir, "home"),
  sessionsDir,
  systemPrompt: "# Yuki\n\nAssistant de test E2E.\n",
  settingsSeedPath: "config/pi/settings.json",
  logger,
});
await host.start();

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-0.0.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  pins: SessionPinStore.open({ path: join(stateDir, "session-pins.json"), logger }),
  agents: agentsGateway,
});

const agentsDeps: AgentsApiDeps = {
  pairing,
  store,
  logger,
  hub,
  audit,
  approvals,
  lock,
  onSecretSeen: () => {
    // ⚠️ Volontairement VIDE dans ce harnais : on ne mémorise aucune valeur.
  },
};

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
  config: {
    runtime: config,
    logger,
    password,
    sensitiveAgentCount: () =>
      store.list().filter((record) => record.sensitive === true && !record.revoked).length,
    onSecretSeen: () => {
      // Idem : aucune valeur mémorisée.
    },
  },
  agents: agentsDeps,
};

const app = createApp(context);

/** Socket factice suffisant à `AgentConnection` (agent « connecté » sans mTLS). */
function fakeAgentSocket(): WebSocket {
  const socket = new EventEmitter() as unknown as EventEmitter & { readyState: number };
  socket.readyState = 1; // WebSocket.OPEN
  (socket as unknown as { send: () => boolean }).send = () => true;
  (socket as unknown as { close: () => void }).close = () => socket.emit("close", 1000);
  return socket as unknown as WebSocket;
}

const server = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (
    url.pathname === "/api/e2e/agent-connect" ||
    url.pathname === "/api/e2e/agent-disconnect"
  ) {
    const agentId = url.searchParams.get("agentId") ?? "";
    if (url.pathname === "/api/e2e/agent-connect") {
      if (agentId && !hub.isOnline(agentId)) {
        hub.register(
          new AgentConnection({
            ws: fakeAgentSocket(),
            agentId,
            logger,
            onClose: (closed) => hub.unregister(closed),
          }),
        );
      }
    } else if (agentId) {
      hub.disconnect(agentId);
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        agentId,
        online: hub.isOnline(agentId),
        locked: lock.isLocked(agentId),
      }),
    );
    return;
  }
  app(req, res);
});
transport.attach(server);
server.listen(0, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  console.log(`READY http://127.0.0.1:${address.port}`);
});
setInterval(() => {}, 1 << 30);
