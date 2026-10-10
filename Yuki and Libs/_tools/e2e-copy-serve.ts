/**
 * Harnais E2E JETABLE — bouton « copier » des blocs de code du fil.
 *
 * Gateway RÉEL avec un hôte Pi RÉEL hors ligne et UNE conversation pré-écrite
 * contenant un bloc de code (contenu VOLONTAIREMENT piégeux : indentation,
 * tabulation, espaces de fin, `& < > '`, Unicode), un bloc `muet`, du code en
 * ligne et un tableau. Sert à prouver EXACTEMENT ce que reçoit le
 * presse-papiers après un CLIC RÉEL.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-copy-serve.ts"
 * Env :
 *   YUKI_E2E_COPY_DIR  dossier d'état (OBLIGATOIRE).
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

const stateDir = process.env.YUKI_E2E_COPY_DIR;
if (!stateDir) throw new Error("YUKI_E2E_COPY_DIR requis");
const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
for (const dir of [agentDir, cwd, sessionsDir]) mkdirSync(dir, { recursive: true });

const CODE_LINES = [
  "  # accentué : héllo & <monde>",
  "\techo \"a & b < c > d 'e'\"   ",
  "func f() {",
  "    return 1;",
  "}",
];

/**
 * Réponse assistant : bloc de code piégeux + bloc muet + code en ligne +
 * tableau. Les lignes sont IDENTIQUES à l'attendu du test E2E.
 */
const ASSISTANT = [
  "Démonstration.",
  "",
  "```bash",
  ...CODE_LINES,
  "```",
  "",
  "```muet",
  "secret brut 42",
  "```",
  "",
  "Et du `code` en ligne.",
  "",
  "| A | B |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
].join("\n");

const USAGE = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const manager = SessionManager.create(cwd, sessionsDir);
manager.appendMessage({ role: "user", content: "Montre-moi un exemple.", timestamp: Date.now() });
manager.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: ASSISTANT }],
  api: "test",
  provider: "test",
  model: "test",
  usage: USAGE,
  stopReason: "stop",
  timestamp: Date.now(),
});

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
});

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
