/**
 * Harnais E2E JETABLE — « Continuer dans une conversation dédiée » : gateway
 * RÉEL, hôte Pi RÉEL, une conversation pré-écrite sur disque, et un GÉNÉRATEUR
 * DE RÉCAPITULATIF FACTICE (aucun LLM requis). Le récapitulatif renvoyé reprend
 * littéralement les messages reçus : il prouve que le transcript atteint bien le
 * générateur puis la nouvelle conversation.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-recap-serve.ts"
 * Env :
 *   YUKI_E2E_RECAP_DIR  dossier d'état (OBLIGATOIRE) — y vivent les sessions.
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
import { createRecapService } from "../../src/recap/index.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_RECAP_DIR;
if (!stateDir) throw new Error("YUKI_E2E_RECAP_DIR requis");
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

// La conversation d'ORIGINE porte des FAITS précis, dont un marqueur unique.
seed(
  "Discussion générale : on a parlé du PROJET-CERBERE et du coffre de secrets.",
  "Décision : la clé du coffre de secrets reste en 0600. Chiffrement AES-256-GCM.",
);

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

// Générateur FACTICE : le récapitulatif reprend LITTÉRALEMENT les messages reçus
// (donc les faits du fil d'origine), précédés d'un marqueur unique.
const recap = createRecapService(async (prompt) => {
  const marker = "RECAP-E2E-MARQUEUR";
  const lines = prompt
    .split("\n")
    .filter((line) => /PROJET-CERBERE|0600|AES-256-GCM/.test(line))
    .join("\n");
  return `TITRE: Le coffre de secrets\n=== RÉCAPITULATIF ===\n${marker}\n${lines}\n- Question ouverte : la rotation de la clé n'est PAS tranchée.`;
});

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  recap,
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
