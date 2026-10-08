/**
 * Harnais E2E JETABLE — gateway RÉEL avec un hôte Pi RÉEL et DEUX conversations
 * pré-écrites sur disque, pour le rendu headless Chromium de la page de
 * discussion (`/`) : barre latérale, bascule, survol/épinglage, menu
 * contextuel, état vide.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-chat-sessions-serve.ts"
 * Env :
 *   YUKI_E2E_CHAT_DIR  dossier d'état (OBLIGATOIRE) — y vivent les sessions.
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost } from "../../src/pi/host.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_CHAT_DIR;
if (!stateDir) throw new Error("YUKI_E2E_CHAT_DIR requis");
const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
for (const dir of [agentDir, cwd, sessionsDir]) mkdirSync(dir, { recursive: true });

/** Écrit une session JSONL persistée (user + assistant) et renvoie son id. */
function seed(user: string, assistant: string): string {
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

// Deux fils aux contenus DISJOINTS : la bascule doit changer ce qui s'affiche.
seed("Bonjour, question du PREMIER fil", "Réponse PREMIERE — fil A.");
seed("Salut, question du SECOND fil", "Réponse SECONDE — fil B.");

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({ YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt", YUKI_LOG_LEVEL: "error" });

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
});

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
};

const server = createHttpServer(createApp(context));
transport.attach(server);
server.listen(0, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  console.log(`READY http://127.0.0.1:${address.port}`);
});
setInterval(() => {}, 1 << 30);
