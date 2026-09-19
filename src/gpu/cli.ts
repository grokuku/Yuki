/**
 * CLI `gpu:report`.
 *
 * Produit le même rapport que la console/`/health`. Sortie ≠ 0 si la porte
 * refuse (mode strict avec override non satisfait).
 */

import { loadEnv, type CompatMode } from "../config/env.js";
import { createConfigRuntime } from "../config/runtime.js";
import { createLogger } from "../observability/logger.js";
import { detectGpus } from "./detect.js";
import { runGate, type GateCompatConfig } from "./gate.js";
import { loadCompatManifest, loadProfiles } from "./profiles.js";
import { formatReportConsole } from "./report.js";

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");

  const env = loadEnv();
  const logger = createLogger({ level: env.logLevel });
  const config = createConfigRuntime({ env });
  const profiles = loadProfiles(env.configDir);
  const manifest = loadCompatManifest(env.configDir);

  const detection = detectGpus({
    command: env.gpuCmd,
    fixture: env.gpuFixture,
    commandFromEnv: env.gpuCmdFromEnv,
  });

  const gateConfig: GateCompatConfig = {
    compatMode: config.getString("gpu.compatMode") as CompatMode,
    profile: config.getString("gpu.profile") || null,
    minDriver: config.getNumber("gpu.minDriver"),
  };
  const gate = runGate({ config: gateConfig, profiles, manifest, detection }, logger);

  const output = asJson
    ? JSON.stringify(gate.report, null, 2)
    : formatReportConsole(gate.report);
  process.stdout.write(`${output}\n`);

  if (!gate.passed) {
    process.exitCode = 1;
  }
}

main();
