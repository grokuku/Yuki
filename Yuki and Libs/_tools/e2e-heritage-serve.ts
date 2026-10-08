/**
 * Harnais E2E JETABLE — gateway RÉEL avec l'API d'administration de l'archive
 * « vie antérieure » câblée, pour le rendu headless Chromium de la page /config,
 * onglet Personnalité (section « Vie antérieure »).
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-heritage-serve.ts"
 * Env :
 *   YUKI_E2E_HERITAGE_DIR  dossier d'état (OBLIGATOIRE) ; l'archive, la mémoire
 *                          courante et la personnalité y vivent.
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { HeritageAdminService, HeritageStore, MemoryStore } from "../../src/memory/index.js";
import { PersonalityStore } from "../../src/personality/index.js";
import { createLogger } from "../../src/observability/logger.js";
import type { GpuReport } from "../../src/types/gpu.js";

const dir = process.env.YUKI_E2E_HERITAGE_DIR;
if (!dir) throw new Error("YUKI_E2E_HERITAGE_DIR requis");
mkdirSync(dir, { recursive: true });

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
  YUKI_HERITAGE_DIR: join(dir, "memory-heritage"),
  YUKI_MEMORY_STORE_PATH: join(dir, "memory.jsonl"),
  YUKI_PERSONALITY_PATH: join(dir, "personality.md"),
});
const config = createConfigRuntime({
  env,
  promptDefaults: { light: "systeme leger", heavy: "systeme lourd" },
});

writeFileSync(join(dir, "personality.md"), "# Yuki\n\nJe suis Yuki.\n", "utf8");
const personalityStore = new PersonalityStore({ path: env.personalityPath, logger, secretValues: [] });

// Archive « vie antérieure » : une entrée de départ pour tester édition/suppression.
const heritageStore = new HeritageStore({ dir: env.heritageDir, logger });
heritageStore.ensureLayout();
const heritageAdmin = new HeritageAdminService(heritageStore, { logger, secretValues: [] });
heritageAdmin.create({
  titre: "Identité (SOUL.md)",
  categorie: "identite",
  texte: "Qui était Yuki à l'ère OpenClaw — contenu de départ.",
});

// Mémoire COURANTE : sert à prouver qu'elle n'est JAMAIS touchée par l'archive.
const memoryStore = MemoryStore.open({ path: env.memoryStorePath, logger });
memoryStore.add({ text: "L'utilisateur aime les crêpes bretonnes", source: "e2e", cat: "preference" });

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
  config: { runtime: config, logger },
  personality: { store: personalityStore, logger },
  heritage: { admin: heritageAdmin, logger },
};

const server = createHttpServer(createApp(context));
server.listen(0, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  console.log(`READY http://127.0.0.1:${address.port}`);
});
setInterval(() => {}, 1 << 30);
