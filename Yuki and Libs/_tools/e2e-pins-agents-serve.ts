/**
 * Harnais E2E JETABLE — gateway RÉEL câblé pour les trois volets :
 *   1) épinglage des conversations (barre latérale de `/`),
 *   2) encart « agents » en bas de la barre latérale du chat,
 *   3) séparation/ suppression définitive des agents sur `/config`.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-pins-agents-serve.ts"
 * Env :
 *   YUKI_E2E_DIR   dossier d'état (OBLIGATOIRE) — sessions, agents, épingles.
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
  AgentExecutionService,
  AgentHub,
  AgentStore,
  ApprovalRegistry,
  AuditLog,
  caDirectoryIn,
  CertificateAuthority,
  maxSizeBytesFromMb,
  PairingManager,
} from "../../src/agents/index.js";
import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport, type AgentsGatewayPort } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost } from "../../src/pi/host.js";
import { SessionPinStore } from "../../src/pi/session-pins.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_DIR;
if (!stateDir) throw new Error("YUKI_E2E_DIR requis");
const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
for (const dir of [agentDir, cwd, sessionsDir]) mkdirSync(dir, { recursive: true });

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({ YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt", YUKI_LOG_LEVEL: "error" });
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

seedSession("Bonjour, question du PREMIER fil", "Réponse PREMIERE — fil A.");
seedSession("Salut, question du SECOND fil", "Réponse SECONDE — fil B.");

// --- Registre d'agents : un actif, un désactivé, un révoqué -----------------
const store = AgentStore.open({
  path: join(stateDir, "agents.jsonl"),
  defaults: { level: "destructive", privilege: "normal" },
  logger,
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
const execution = new AgentExecutionService({ store, hub, audit, approvals, logger });
void execution;

store.markSeen("agent-nuc00");
store.setName("agent-nuc00", "nuc00");
store.markSeen("agent-nuc01");
store.setName("agent-nuc01", "nuc01");
store.setLevel("agent-nuc01", "disabled");
store.markSeen("agent-vieux");
store.setName("agent-vieux", "vieux");
store.revoke("agent-vieux");

const agentsGateway: AgentsGatewayPort = {
  list: () =>
    store.list().map((record) => ({
      agentId: record.agentId,
      name: record.name !== "" ? record.name : record.agentId,
      level: record.level,
      revoked: record.revoked,
      online: hub.isOnline(record.agentId),
    })),
  setEnabled: (agentId, enabled) => store.setEnabled(agentId, enabled),
  setLevel: (agentId, level) => store.setLevel(agentId, level),
  // ⚠️ Comme `src/index.ts` : le store ET le hub — une DÉCONNEXION d'agent
  // n'écrit rien dans le store, elle ne se voit que par le hub.
  subscribe: (listener) => {
    const offStore = store.subscribe(listener);
    const offHub = hub.subscribe(listener);
    return () => {
      offStore();
      offHub();
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
  serverVersion: "e2e-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  pins: SessionPinStore.open({ path: join(stateDir, "session-pins.json"), logger }),
  agents: agentsGateway,
});

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
  config: { runtime: config, logger },
  agents: { pairing, store, logger, hub, audit, approvals },
};

const app = createApp(context);

/**
 * Socket factice suffisant à `AgentConnection`. Sert à ÉMULER un agent connecté
 * pour l'E2E du RENDU de la pastille (vert/rouge) ; le chemin serveur réel
 * (mTLS) est couvert par les tests d'intégration. Routes E2E UNIQUEMENT (ce
 * harnais est jetable), jamais montées en production.
 */
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
    res.end(JSON.stringify({ agentId, online: hub.isOnline(agentId) }));
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
