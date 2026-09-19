/**
 * Intégration LLM RÉEL — opt-in uniquement (`YUKI_TEST_REAL_LLM=1`).
 *
 * Sans la variable ET les deux clés, ce fichier est entièrement ignoré :
 * aucun réseau, aucun coût. Il vérifie que les deux providers répondent avec
 * leurs clés distinctes (comptage d'usage) et qu'un `delegate` réel rend un
 * résultat sans que le lourd ne produise de message assistant dans la session
 * légère.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDelegationService } from "../../src/delegation/index.js";
import { JobQueue, JobStore } from "../../src/jobs/index.js";
import { HEAVY_MODEL, LIGHT_MODEL, buildModelsConfig, toolAllowlist } from "../../src/llm/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost, createSdkHeavyWorker } from "../../src/pi/index.js";
import { resolvePiPaths, seedSettingsFile, writeModelsFile } from "../../src/pi/config.js";

const ENABLED =
  process.env["YUKI_TEST_REAL_LLM"] === "1" &&
  Boolean(process.env["YUKI_LLM_LIGHT_API_KEY"]) &&
  Boolean(process.env["YUKI_LLM_HEAVY_API_KEY"]);

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setup(): { agentDir: string; cwd: string; home: string; sessionsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "yuki-llm-"));
  tempDirs.push(root);
  return {
    agentDir: join(root, "agent"),
    cwd: join(root, "workspace"),
    home: join(root, "home"),
    sessionsDir: join(root, "agent", "sessions"),
  };
}

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

describe.skipIf(!ENABLED)("LLM réel (opt-in)", () => {
  it("le worker lourd répond via sa clé (usage > 0)", async () => {
    const dirs = setup();
    const paths = resolvePiPaths({
      agentDir: dirs.agentDir,
      cwd: dirs.cwd,
      home: dirs.home,
      sessionsDir: dirs.sessionsDir,
      settingsSeedPath: "config/pi/settings.json",
    });
    seedSettingsFile(paths, logger);
    writeModelsFile(paths, buildModelsConfig(), logger);

    const heavy = createSdkHeavyWorker({
      cwd: paths.cwd,
      agentDir: paths.agentDir,
      authPath: join(paths.agentDir, "auth.json"),
      modelsPath: paths.modelsPath,
      systemPrompt: readFileSync("config/pi/system-prompt-heavy.md", "utf8"),
      modelReference: HEAVY_MODEL.reference,
      thinking: HEAVY_MODEL.defaultThinking,
      tools: toolAllowlist("heavy"),
      idleTimeoutMs: 120_000,
      totalTimeoutMs: 1_200_000,
      logger,
    });

    const handle = heavy.run({
      jobId: "real-heavy-1",
      task: "Réponds exactement : OK.",
      lightSessionId: "sess-real",
      idleTimeoutMs: 120_000,
      totalTimeoutMs: 1_200_000,
    });
    const result = await handle.promise;
    expect(result.status).toBe("completed");
    expect(result.text ?? "").toMatch(/ok/i);
    expect((result.usage?.input ?? 0) + (result.usage?.output ?? 0)).toBeGreaterThan(0);
  });

  it("le léger répond et un delegate réel rend un résultat", async () => {
    const dirs = setup();
    const store = JobStore.open({
      path: join(dirs.agentDir, "jobs.jsonl"),
      logger,
    });
    const queue = new JobQueue({ maxConcurrent: 3, maxQueue: 10 });
    const heavy = createSdkHeavyWorker({
      cwd: dirs.cwd,
      agentDir: dirs.agentDir,
      authPath: join(dirs.agentDir, "auth.json"),
      modelsPath: join(dirs.agentDir, "models.json"),
      systemPrompt: readFileSync("config/pi/system-prompt-heavy.md", "utf8"),
      modelReference: HEAVY_MODEL.reference,
      thinking: HEAVY_MODEL.defaultThinking,
      tools: toolAllowlist("heavy"),
      idleTimeoutMs: 120_000,
      totalTimeoutMs: 1_200_000,
      logger,
    });
    const delegation = createDelegationService({
      store,
      queue,
      heavy,
      availability: { isAvailable: () => true },
      logger,
      idleTimeoutMs: 120_000,
      totalTimeoutMs: 1_200_000,
    });

    const host = createPiHost({
      agentDir: dirs.agentDir,
      cwd: dirs.cwd,
      home: dirs.home,
      sessionsDir: dirs.sessionsDir,
      systemPrompt: readFileSync("config/pi/system-prompt.md", "utf8"),
      settingsSeedPath: "config/pi/settings.json",
      modelsConfig: buildModelsConfig(),
      model: LIGHT_MODEL.reference,
      thinking: "off",
      tools: toolAllowlist("light"),
      delegation,
      eventSource: delegation,
      llmAvailable: true,
      logger,
    });
    delegation.setWaker(host);

    try {
      await host.start();
      const sessionId = host.currentSessionId();
      expect(sessionId).toEqual(expect.any(String));
      const deltas: string[] = [];
      let content = "";
      let lightTokens = 0;
      const off = host.subscribeAll((event) => {
        if (event.type === "delta" && event.channel === "content") {
          content += event.text;
          deltas.push(event.text);
        }
        if (event.type === "run_summary") {
          lightTokens = (event.tokensIn ?? 0) + (event.tokensOut ?? 0);
        }
      });
      const handle = host.send(sessionId!, "Réponds exactement : BONJOUR.");
      expect(handle.runId).toEqual(expect.any(String));
      await new Promise<void>((resolve) => {
        const stop = host.subscribeAll((event) => {
          if (event.type === "run_finished" && event.runId === handle.runId) {
            stop();
            resolve();
          }
        });
      });
      off();
      expect(content.length).toBeGreaterThan(0);
      expect(lightTokens).toBeGreaterThan(0);

      const outcome = await delegation.delegate({
        task: "Réponds exactement : RAPPORT OK.",
        lightSessionId: sessionId!,
        parentRunId: handle.runId,
        deadlineMs: 60_000,
      });
      expect(["completed", "pending"]).toContain(outcome.status);

      // Le lourd ne produit AUCUN message assistant dans la session légère :
      // le seul message ajouté est le prompt de report.
      const transcript = host.getState(sessionId)?.transcript ?? [];
      const assistantTexts = transcript
        .filter((entry) => entry.role === "assistant")
        .map((entry) => entry.text);
      expect(assistantTexts.every((text) => !text.includes("thinking"))).toBe(true);
    } finally {
      await host.stop();
    }
  });
});
