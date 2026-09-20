/**
 * Harnais E2E JETABLE (hors dépôts, à la racine du workspace composite) :
 * démarre le gateway RÉEL de Yuki sur un port fixe pour le rendu headless
 * Chromium (mêmes briques que tests/integration/static-ui.test.ts).
 *
 * Usage :  cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-serve.ts"
 * Sortie : « READY http://127.0.0.1:<port> » sur stdout, puis reste vivant.
 */

import { loadEnv } from "../../src/config/env.js";
import { inspectMountPoints, mountPoints } from "../../src/config/paths.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
import { createLogger } from "../../src/observability/logger.js";

const profiles = loadProfiles();
const manifest = loadCompatManifest();
const env = loadEnv({ YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt", YUKI_LOG_LEVEL: "error" });
const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const detection = detectGpus({
  command: env.gpuCmd,
  fixture: env.gpuFixture,
  commandFromEnv: env.gpuCmdFromEnv,
  cwd: process.cwd(),
});
const gate = runGate(
  {
    config: { compatMode: "strict" as const, profile: null, minDriver: 580 },
    profiles,
    manifest,
    detection,
  },
  logger,
);

const server = createServer({
  env,
  report: gate.report,
  gatePassed: gate.passed,
  startedAt: Date.now(),
  volumes: inspectMountPoints(mountPoints(env)),
});

const address = await startServer(server, "127.0.0.1", 4173);
console.log(`READY http://127.0.0.1:${(address as import("node:net").AddressInfo).port}`);
// Reste vivant pour la durée du harnais Chromium.
setInterval(() => {}, 1 << 30);