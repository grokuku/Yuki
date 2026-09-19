/**
 * Point d'entrée du gateway Yuki.
 *
 * La porte de compatibilité GPU est franchie AVANT l'ouverture du port. En mode
 * strict, un refus laisse la porte fermée MAIS le serveur HTTP démarre quand
 * même : la page `/config` reste accessible pour corriger le profil (invariant
 * Lot 11 : « le paramétrage ne dépend jamais du fonctionnement applicatif »).
 *
 * Lot 11 — ORDRE D'INITIALISATION CRITIQUE :
 *   1. charger la configuration (store + env + défauts) ;
 *   2. PONT des clés du store vers `process.env` ;
 *   3. créer le logger (sa redaction capte alors les clés du store) ;
 *   4. passer en plus explicitement les clés du store au logger.
 * Sans cet ordre, une clé issue du store fuiterait dans les logs.
 *
 * Lot 2 : composition root. On câble les ports (`src/delegation`) sur leurs
 * implémentations SDK (`src/pi/sdk/**`, exposées via la façade `src/pi`) :
 * `JobStore` + `JobQueue` + worker lourd + service de délégation injectés dans
 * le `PiHost`. ⚠️ Aucun import direct de `src/pi/sdk/**` ici.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadEnv, type CompatMode, type LlmMissingKeyMode } from "./config/env.js";
import { inspectMountPoints, mountPoints } from "./config/paths.js";
import { createConfigRuntime, type ConfigRuntime } from "./config/runtime.js";
import { createDelegationService, type DelegationService } from "./delegation/index.js";
import { createServer, installGracefulShutdown, startServer } from "./gateway/server.js";
import { createWsTransport } from "./gateway/ws/server.js";
import type { Transport } from "./gateway/ws/transport.js";
import type { SubsystemsSnapshot } from "./gateway/routes/health.js";
import { detectGpus } from "./gpu/detect.js";
import { runGate, type GateCompatConfig } from "./gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "./gpu/profiles.js";
import { formatReportConsole } from "./gpu/report.js";
import { JobQueue, JobStore } from "./jobs/index.js";
import {
  HEAVY_SYSTEM_PROMPT_FALLBACK,
  buildModelsConfigFrom,
  evaluateMissingKeyPolicy,
  resolveAvailability,
  resolveModelsFrom,
  resolveProvidersFrom,
  toolAllowlist,
  type EffectiveLlmConfig,
  type LlmConfig,
  type ThinkingLevelName,
} from "./llm/index.js";
import { collectSecretValues, createLogger } from "./observability/logger.js";
import { createPiHost, createSdkHeavyWorker, type PiHost } from "./pi/index.js";
import type { ModelAvailability } from "./delegation/index.js";

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Lit la config effective des deux rôles LLM (store + env + défauts). */
function effectiveLlmConfig(config: ConfigRuntime): EffectiveLlmConfig {
  return {
    light: {
      api: config.getString("llm.light.api"),
      baseUrl: config.getString("llm.light.baseUrl"),
      model: config.getString("llm.light.model"),
      thinking: config.getString("llm.light.thinking") as ThinkingLevelName,
    },
    heavy: {
      api: config.getString("llm.heavy.api"),
      baseUrl: config.getString("llm.heavy.baseUrl"),
      model: config.getString("llm.heavy.model"),
      thinking: config.getString("llm.heavy.thinking") as ThinkingLevelName,
    },
  };
}

async function main(): Promise<void> {
  // --- (1) Configuration : store + env + défauts ----------------------------
  const env = loadEnv();
  const config = createConfigRuntime({
    env,
    promptDefaults: {
      light: loadTextFile(env.piSystemPromptPath, FALLBACK_SYSTEM_PROMPT),
      heavy: loadTextFile(env.piHeavySystemPromptPath, HEAVY_SYSTEM_PROMPT_FALLBACK),
    },
  });

  // --- (2) Pont des clés du store vers `process.env` ------------------------
  // `models.json` référence `$YUKI_LLM_<ROLE>_API_KEY` : le SDK les résout dans
  // l'environnement au moment de la requête.
  config.bridgeSecrets();

  // --- (3) Logger (redaction des clés d'env ET du store) --------------------
  const logger = createLogger({
    level: env.logLevel,
    secretValues: [...collectSecretValues(), ...config.secretValues()],
  });

  // --- (4) Replis du store + import unique de `models.json` -----------------
  for (const warning of config.warnings) {
    logger.warn("config.store.fallback", { detail: warning });
  }
  const modelsPath = join(env.piAgentDir, "models.json");
  if (config.isStoreEmpty() && existsSync(modelsPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(modelsPath, "utf8"));
      const imported = config.importLegacyModels(parsed);
      if (imported.length > 0) {
        logger.info("config.models.imported", { fields: imported, from: modelsPath });
      }
    } catch (error) {
      logger.warn("config.models.import_failed", {
        from: modelsPath,
        error: messageOf(error),
      });
    }
  }

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

  if (!gate.passed) {
    // On NE sort PAS : la page `/config` doit rester joignable pour corriger le
    // profil. `gatePassed: false` ⇒ `/health/ready` reste 503.
    process.stdout.write(`${formatReportConsole(gate.report)}\n`);
    logger.error("gateway.startup refused (configuration à corriger via /config)", {
      resolvedProfile: gate.report.resolvedProfile,
      resolution: gate.report.resolution,
      missingCapabilities: gate.report.missingCapabilities,
    });
  }

  // --- LLM : config effective + disponibilité (aucun appel réseau) ----------
  const effective = effectiveLlmConfig(config);
  const llmConfig: LlmConfig = {
    providers: resolveProvidersFrom(effective),
    models: resolveModelsFrom(effective),
  };
  const resolveAvail = () => resolveAvailability(process.env, llmConfig);
  const availabilityPort: ModelAvailability = {
    isAvailable: (role) => resolveAvail().isAvailable(role),
  };

  const missingKeyMode = config.getString("llm.missingKeyMode") as LlmMissingKeyMode;
  const availabilityAtStart = resolveAvail();
  const missingKey = evaluateMissingKeyPolicy(availabilityAtStart, missingKeyMode);
  logger.info("llm.availability", {
    mode: missingKeyMode,
    light: availabilityAtStart.light.status,
    light_key: availabilityAtStart.light.keyPresent,
    heavy: availabilityAtStart.heavy.status,
    heavy_key: availabilityAtStart.heavy.keyPresent,
  });

  if (missingKey.refuse) {
    logger.error("gateway.startup refused (clé LLM manquante)", {
      missing: missingKey.missing,
      mode: missingKeyMode,
    });
    process.exitCode = 1;
    return;
  }

  const lightRef = llmConfig.models.light.reference;
  const lightThinking = llmConfig.models.light.defaultThinking;
  const heavyRef = llmConfig.models.heavy.reference;
  const heavyThinking = llmConfig.models.heavy.defaultThinking;
  const heavyAvailableAtStart = availabilityAtStart.isAvailable("heavy");

  const volumes = inspectMountPoints(mountPoints(env));
  const startedAt = Date.now();

  // --- Jobs, délégation, PiHost (uniquement si la porte est passée) ---------
  let piStatus: "starting" | "ready" | "error" = "starting";
  let sessionsCount = 0;
  let activeRuns = 0;
  let host: PiHost | undefined;
  let transport: Transport | undefined;
  let delegation: DelegationService | undefined;

  if (gate.passed) {
    const idleTimeoutMs = config.getNumber("delegation.idleTimeoutMs");
    const totalTimeoutMs = config.getNumber("delegation.totalTimeoutMs");

    const jobStore = JobStore.open({ path: env.jobsStorePath, logger });
    const queue = new JobQueue({
      maxConcurrent: config.getNumber("delegation.maxConcurrent"),
      maxQueue: config.getNumber("delegation.maxQueue"),
    });
    const heavyWorker = createSdkHeavyWorker({
      cwd: env.piCwd,
      agentDir: env.piAgentDir,
      authPath: join(env.piAgentDir, "auth.json"),
      modelsPath,
      systemPrompt: config.getString("prompts.heavy"),
      modelReference: heavyRef,
      thinking: heavyThinking,
      tools: toolAllowlist("heavy"),
      idleTimeoutMs,
      totalTimeoutMs,
      logger,
    });
    delegation = createDelegationService({
      store: jobStore,
      queue,
      heavy: heavyWorker,
      availability: availabilityPort,
      idleTimeoutMs,
      totalTimeoutMs,
      defaultDeadlineMs: () => config.getNumber("delegation.defaultDeadlineMs"),
      logger,
    });

    host = createPiHost({
      agentDir: env.piAgentDir,
      cwd: env.piCwd,
      home: env.piHome,
      sessionsDir: env.piSessionsDir,
      systemPrompt: config.getString("prompts.light"),
      settingsSeedPath: env.piSettingsSeedPath,
      modelsConfig: buildModelsConfigFrom(effective),
      model: lightRef,
      thinking: lightThinking,
      tools: toolAllowlist("light", { delegationEnabled: heavyAvailableAtStart }),
      ...(heavyAvailableAtStart ? { delegation } : {}),
      eventSource: delegation,
      llmAvailable: () => resolveAvail().isAvailable("light"),
      logger,
    });
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
      logger.error("pi.start.failed", { error: messageOf(error) });
    }

    transport = createWsTransport({
      host,
      logger,
      serverVersion: env.version,
      replayBufferSize: config.getNumber("transport.replayBuffer"),
      replayBufferBytes: config.getNumber("transport.replayBytes"),
    });
  }

  const getSubsystems = (): SubsystemsSnapshot => {
    const availability = resolveAvail();
    const counts =
      delegation?.counts() ??
      { running: 0, queued: 0, completed: 0, failed: 0, interrupted: 0 };
    return {
      pi: {
        status: piStatus,
        cwd: env.piCwd,
        agentDir: env.piAgentDir,
        sessionsDir: env.piSessionsDir,
        model: lightRef,
        sessionsCount,
        activeRuns,
      },
      transport: {
        ws: {
          clients: transport?.clientCount() ?? 0,
          replayBufferSize: config.getNumber("transport.replayBuffer"),
        },
        sse: false,
      },
      llm: {
        light: {
          provider: llmConfig.providers.light.id,
          model: llmConfig.models.light.id,
          status: availability.light.status,
          keyPresent: availability.light.keyPresent,
        },
        heavy: {
          provider: llmConfig.providers.heavy.id,
          model: llmConfig.models.heavy.id,
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
        maxConcurrent: config.getNumber("delegation.maxConcurrent"),
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
      config: { runtime: config, logger },
    },
    transport,
  );

  installGracefulShutdown(server, logger, {
    beforeClose: async () => {
      await transport?.close();
      await host?.stop();
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
    light: availabilityAtStart.light.status,
    heavy: availabilityAtStart.heavy.status,
  });
}

main().catch((error: unknown) => {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`Yuki gateway — erreur fatale : ${message}\n`);
  process.exitCode = 1;
});
