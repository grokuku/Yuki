/**
 * Harnais E2E JETABLE — capture d'écran DANS la conversation.
 *
 * Gateway RÉEL avec un hôte Pi RÉEL hors ligne et un port de captures EN MÉMOIRE
 * (aucun agent réel) : il émet une image JPEG minuscule dans la conversation
 * courante. L'image doit s'afficher DANS le fil (`<img data:>` sous la CSP
 * RÉELLE), disparaître au rechargement (état ÉPHÉMÈRE, jamais dans le snapshot)
 * et n'entraîner AUCUNE violation CSP ni exception JS.
 *
 * ⚠️ Ne produit AUCUNE capture PNG suivie : les éventuelles captures d'écran du
 * navigateur vont dans un dossier temporaire.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-screenshot-serve.ts"
 * Env :
 *   YUKI_E2E_SHOT_DIR  dossier d'état (OBLIGATOIRE).
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost } from "../../src/pi/host.js";
import type {
  CapturedScreenshotView,
  ScreenshotGatewayPort,
  ScreenshotViewEvent,
} from "../../src/agents/execution.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_SHOT_DIR;
if (!stateDir) throw new Error("YUKI_E2E_SHOT_DIR requis");
const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
for (const dir of [agentDir, cwd, sessionsDir]) mkdirSync(dir, { recursive: true });

/** JPEG 1×1 valide (le navigateur le rend, la CSP autorise `data:`). */
const TINY_JPEG =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
  "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAA" +
  "Cf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

/** Port de captures EN MÉMOIRE : émet une image dans la conversation courante. */
class StubScreenshotPort implements ScreenshotGatewayPort {
  private readonly listeners = new Set<(event: ScreenshotViewEvent) => void>();

  constructor(private readonly sessionId: string) {}

  subscribeScreenshots(listener: (event: ScreenshotViewEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(): void {
    const screenshot: CapturedScreenshotView = {
      agentId: "agent-nuc00",
      agentName: "nuc00",
      sessionId: this.sessionId,
      dataUrl: TINY_JPEG,
      format: "jpeg",
      width: 1280,
      height: 720,
      bytes: 140 * 1024,
      capturedAt: new Date().toISOString(),
    };
    for (const listener of [...this.listeners]) listener({ kind: "captured", screenshot });
  }
}

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

const sessionId = host.currentSessionId();
if (!sessionId) throw new Error("aucune session courante");
const screenshots = new StubScreenshotPort(sessionId);

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  screenshots,
});

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
};

const app = createApp(context);
const server = createHttpServer((req, res) => {
  // Endpoint JETABLE : déclenche une capture vers la conversation courante.
  if (req.url === "/e2e/shot") {
    screenshots.emit();
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
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
