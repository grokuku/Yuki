/**
 * Point d'entrée du gateway Yuki.
 *
 * La porte de compatibilité GPU est franchie AVANT l'ouverture du port.
 * En mode strict, un refus sort avec un code ≠ 0 et n'ouvre jamais le serveur.
 *
 * Lot 2 : composition root. On câble les ports (`src/delegation`) sur leurs
 * implémentations SDK (`src/pi/sdk/**`, exposées via la façade `src/pi`) :
 * `JobStore` + `JobQueue` + worker lourd + service de délégation injectés dans
 * le `PiHost`. ⚠️ Aucun import direct de `src/pi/sdk/**` ici.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadEnv } from "./config/env.js";
import { inspectMountPoints, mountPoints } from "./config/paths.js";
import { createDelegationService } from "./delegation/index.js";
import { createServer, installGracefulShutdown, startServer } from "./gateway/server.js";
import { createWsTransport } from "./gateway/ws/server.js";
import type { SubsystemsSnapshot } from "./gateway/routes/health.js";
import { detectGpus } from "./gpu/detect.js";
import { runGate } from "./gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "./gpu/profiles.js";
import { formatReportConsole } from "./gpu/report.js";
import { JobQueue, JobStore } from "./jobs/index.js";
import {
  HEAVY_SYSTEM_PROMPT_FALLBACK,
  evaluateMissingKeyPolicy,
  resolveAvailability,
  resolveLlmConfig,
  toolAllowlist,
} from "./llm/index.js";
import { createLogger } from "./observability/logger.js";
import { createPiHost, createSdkHeavyWorker } from "./pi/index.js";

const FALLBACK_SYSTEM_PROMPT =
  "Tu es Yuki, un assistant conversationnel généraliste. Réponds de manière claire et concise.";

function loadTextFile(path: string, fallback: string): string {
  try {
    const content = readFileSync(path, "utf8").trim();
    return content.length > 0 ? content : fallback;
  } catch {
    return fallback;
  }
}

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ level: env.logLevel });

  const profiles = loadProfiles(env.configDir);
  const manifest = loadCompatManifest(env.configDir);

  const detection = detectGpus({
    command: env.gpuCmd,
    fixture: env.gpuFixture,
    commandFromEnv: env.gpuCmdFromEnv,
  });

  const gate = runGate({ env, profiles, manifest, detection }, logger);

  if (!gate.passed) {
    process.stdout.write(`${formatReportConsole(gate.report)}\n`);
    logger.error("gateway.startup refused", {
      resolvedProfile: gate.report.resolvedProfile,
      resolution: gate.report.resolution,
      missingCapabilities: gate.report.missingCapabilities,
    });
    process.exitCode = 1;
    return;
  }

  // --- Disponibilité LLM (aucun appel réseau) --------------------------------
  // Configuration neutre : les variables `YUKI_LLM_LIGHT_*` / `YUKI_LLM_HEAVY_*`
  // surchargent les défauts. Les valeurs `baseUrl`/`api`/modèle restent dans
  // `config/pi/models.json` (le SDK n'interpole pas ces champs).
  const llmConfig = resolveLlmConfig(process.env);
  const availability = resolveAvailability(process.env, llmConfig);
  const missingKey = evaluateMissingKeyPolicy(availability, env.llmMissingKeyMode);
  logger.info("llm.availability", {
    mode: env.llmMissingKeyMode,
    light: availability.light.status,
    light_key: availability.light.keyPresent,
    heavy: availability.heavy.status,
    heavy_key: availability.heavy.keyPresent,
  });

  if (missingKey.refuse) {
    logger.error("gateway.startup refused (clé LLM manquante)", {
      missing: missingKey.missing,
      mode: env.llmMissingKeyMode,
    });
    process.exitCode = 1;
    return;
  }

  const lightAvailable = availability.isAvailable("light");
  const heavyAvailable = availability.isAvailable("heavy");

  const volumes = inspectMountPoints(mountPoints(env));
  const startedAt = Date.now();

  // --- Jobs & délégation -----------------------------------------------------
  const store = JobStore.open({ path: env.jobsStorePath, logger });
  const queue = new JobQueue({
    maxConcurrent: env.heavyMaxConcurrent,
    maxQueue: env.heavyMaxQueue,
  });
  const heavy = createSdkHeavyWorker({
    cwd: env.piCwd,
    agentDir: env.piAgentDir,
    authPath: join(env.piAgentDir, "auth.json"),
    modelsPath: join(env.piAgentDir, "models.json"),
    systemPrompt: loadTextFile(
      env.piHeavySystemPromptPath,
      HEAVY_SYSTEM_PROMPT_FALLBACK,
    ),
    modelReference: llmConfig.models.heavy.reference,
    thinking: llmConfig.models.heavy.defaultThinking,
    tools: toolAllowlist("heavy"),
    idleTimeoutMs: env.heavyIdleTimeoutMs,
    totalTimeoutMs: env.heavyTotalTimeoutMs,
    logger,
  });
  const delegation = createDelegationService({
    store,
    queue,
    heavy,
    availability,
    idleTimeoutMs: env.heavyIdleTimeoutMs,
    totalTimeoutMs: env.heavyTotalTimeoutMs,
    logger,
  });

  // --- PiHost embarqué (après la porte GPU) ---------------------------------
  let piStatus: "starting" | "ready" | "error" = "starting";
  let sessionsCount = 0;
  let activeRuns = 0;

  const lightModel = env.piModel ?? llmConfig.models.light.reference;
  const lightThinking = env.piThinking ?? llmConfig.models.light.defaultThinking;
  const lightTools = toolAllowlist("light", { delegationEnabled: heavyAvailable });

  const host = createPiHost({
    agentDir: env.piAgentDir,
    cwd: env.piCwd,
    home: env.piHome,
    sessionsDir: env.piSessionsDir,
    systemPrompt: loadTextFile(env.piSystemPromptPath, FALLBACK_SYSTEM_PROMPT),
    settingsSeedPath: env.piSettingsSeedPath,
    modelsSeedPath: env.piModelsSeedPath,
    model: lightModel,
    thinking: lightThinking,
    tools: lightTools,
    ...(heavyAvailable ? { delegation } : {}),
    eventSource: delegation,
    llmAvailable: lightAvailable,
    logger,
  });
  // Réveil du léger pour les reports, une fois le host construit.
  delegation.setWaker(host);

  host.subscribeAll((event) => {
    if (event.type === "state") {
      activeRuns = event.state === "streaming" ? 1 : 0;
    }
  });

  try {
    await host.start();
    piStatus = "ready";
    sessionsCount = (await host.listSessions()).length;
  } catch (error) {
    piStatus = "error";
    logger.error("pi.start.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const transport = createWsTransport({
    host,
    logger,
    serverVersion: env.version,
    replayBufferSize: env.wsReplayBuffer,
    replayBufferBytes: env.wsReplayBytes,
  });

  const getSubsystems = (): SubsystemsSnapshot => {
    const counts = delegation.counts();
    return {
      pi: {
        status: piStatus,
        cwd: env.piCwd,
        agentDir: env.piAgentDir,
        sessionsDir: env.piSessionsDir,
        model: lightModel,
        sessionsCount,
        activeRuns,
      },
      transport: {
        ws: {
          clients: transport.clientCount(),
          replayBufferSize: transport.stats().replayBufferSize,
        },
        sse: false,
      },
      llm: {
        light: {
          provider: availability.light.provider,
          model: availability.light.model,
          status: availability.light.status,
          keyPresent: availability.light.keyPresent,
        },
        heavy: {
          provider: availability.heavy.provider,
          model: availability.heavy.model,
          status: availability.heavy.status,
          keyPresent: availability.heavy.keyPresent,
        },
      },
      jobs: {
        running: counts.running,
        queued: counts.queued,
        completed: counts.completed,
        failed: counts.failed,
        interrupted: counts.interrupted,
        maxConcurrent: env.heavyMaxConcurrent,
      },
    };
  };

  const server = createServer(
    {
      env,
      report: gate.report,
      gatePassed: gate.passed,
      startedAt,
      volumes,
      getSubsystems,
    },
    transport,
  );

  installGracefulShutdown(server, logger, {
    beforeClose: async () => {
      await transport.close();
      await host.stop();
    },
  });

  const address = await startServer(server, env.gatewayHost, env.gatewayPort);
  logger.info("gateway.listening", {
    host: address.address,
    port: address.port,
    resolvedProfile: gate.report.resolvedProfile,
    mode: gate.report.mode,
    resolution: gate.report.resolution,
    pi: piStatus,
    light: availability.light.status,
    heavy: availability.heavy.status,
  });
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Yuki gateway — erreur fatale : ${message}\n`);
  process.exitCode = 1;
});
