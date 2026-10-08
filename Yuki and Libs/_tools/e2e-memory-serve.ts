/**
 * Harnais E2E JETABLE — gateway RÉEL avec les API « Personnalité » et
 * « administration de la mémoire » câblées, pour le rendu headless Chromium de
 * la page /config, onglet Personnalité (bloc « Réinitialiser la mémoire »).
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-memory-serve.ts"
 * Env :
 *   YUKI_E2E_MEMORY_DIR  dossier d'état (OBLIGATOIRE) ; les chemins de mémoire,
 *                        index, personnalité et archives y vivent. Le harnais
 *                        mjs y relit l'archive après le reset.
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { MemoryIndex, MemoryService, MemoryStore } from "../../src/memory/index.js";
import { PersonalityStore } from "../../src/personality/index.js";
import { createLogger } from "../../src/observability/logger.js";
import type { GpuReport } from "../../src/types/gpu.js";

const dir = process.env.YUKI_E2E_MEMORY_DIR;
if (!dir) throw new Error("YUKI_E2E_MEMORY_DIR requis");
mkdirSync(dir, { recursive: true });

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
  YUKI_MEMORY_STORE_PATH: join(dir, "memory.jsonl"),
  YUKI_MEMORY_INDEX_PATH: join(dir, "memory-index.sqlite"),
  YUKI_PERSONALITY_PATH: join(dir, "personality.md"),
});
const config = createConfigRuntime({
  env,
  promptDefaults: { light: "systeme leger", heavy: "systeme lourd" },
});

// Personnalité + mémoire : deux magasins SÉPARÉS (comme en production).
writeFileSync(join(dir, "personality.md"), "# Yuki\n\nJe suis Yuki, une assistante franche.\n", "utf8");
const personalityStore = new PersonalityStore({ path: env.personalityPath, logger, secretValues: [] });

const memoryStore = MemoryStore.open({ path: env.memoryStorePath, logger });
const memoryIndex = new MemoryIndex({ path: env.memoryIndexPath, logger });
const memoryService = new MemoryService({
  store: memoryStore,
  index: memoryIndex,
  logger,
  enabled: () => true,
  bounds: () => ({ topK: 5, budgetChars: 8000, timeoutMs: 400 }),
});
memoryService.start();
memoryStore.add({ text: "L'utilisateur aime les crêpes bretonnes", source: "e2e-1", cat: "preference" });
memoryStore.add({ text: "L'utilisateur habite à Rennes", source: "e2e-2", cat: "fait" });

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
  config: { runtime: config, logger },
  personality: { store: personalityStore, logger },
  memory: { admin: memoryService, logger },
};

const server = createHttpServer(createApp(context));
server.listen(0, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  console.log(`READY http://127.0.0.1:${address.port}`);
});
setInterval(() => {}, 1 << 30);
