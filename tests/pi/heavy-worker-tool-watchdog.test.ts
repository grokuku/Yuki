/**
 * Le worker lourd ne doit JAMAIS rester bloqué sur un outil qui ne rend pas la
 * main — et une commande LONGUE doit rester POSSIBLE.
 *
 * ⚠️ POURQUOI CES TESTS EXISTENT (production, 2026-11-02) : un job de mise à
 * jour de Raspberry Pi (`apt update && apt upgrade -y`) a échoué « sans jamais
 * rendre la main ». Cause réelle : pendant qu'un outil s'exécute, la session
 * n'émet AUCUN événement — le délai d'INACTIVITÉ du job (`delegation.idleTimeoutMs`,
 * 120 s par défaut) abattait donc tout job lançant une commande un peu longue.
 * Le rapport ne portait que le mot « timeout », et le modèle léger inventait la
 * suite (« la machine n'a pas répondu »).
 *
 * Ce que ces tests prouvent :
 *  - un OUTIL EN COURS n'est PAS de l'inactivité (une commande de 400 ms avec une
 *    borne d'inactivité de 100 ms n'est pas tuée) ;
 *  - un outil qui ne rend JAMAIS fait ÉCHOUER le job proprement, avec un message
 *    qui nomme l'outil et la durée, au lieu de le laisser bloqué ;
 *  - le motif de dépassement est LISIBLE (code + phrase) : le rapport ne dit plus
 *    seulement « timeout ».
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildModelsConfig } from "../../src/llm/index.js";
import { createLogger } from "../../src/observability/logger.js";
import {
  createSdkHeavyWorker,
  idleTimeoutError,
  toolWatchdogError,
  totalTimeoutError,
} from "../../src/pi/index.js";
import { resolvePiPaths, seedSettingsFile, writeModelsFile } from "../../src/pi/config.js";
import type { EphemeralSession } from "../../src/pi/sdk/session-factory.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Env {
  worker: ReturnType<typeof createSdkHeavyWorker>;
  createSession: unknown;
}

function makeEnv(
  createSession: unknown,
  timeouts: { idleTimeoutMs: number; totalTimeoutMs: number; toolWatchdogMs: number },
): Env {
  const root = mkdtempSync(join(tmpdir(), "yuki-heavy-watchdog-"));
  tempDirs.push(root);
  const agentDir = join(root, "agent");
  const paths = resolvePiPaths({
    agentDir,
    cwd: join(root, "workspace"),
    home: join(root, "home"),
    sessionsDir: join(agentDir, "sessions"),
    settingsSeedPath: "config/pi/settings.json",
  });
  const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
  seedSettingsFile(paths, logger);
  writeModelsFile(paths, buildModelsConfig(), logger);
  const worker = createSdkHeavyWorker({
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    authPath: join(paths.agentDir, "auth.json"),
    modelsPath: paths.modelsPath,
    systemPrompt: "Tu es le worker lourd de test.",
    modelReference: "llm-heavy/deepseek-v4.1-flash",
    thinking: "off",
    tools: [],
    createSession: createSession as never,
    idleTimeoutMs: timeouts.idleTimeoutMs,
    totalTimeoutMs: timeouts.totalTimeoutMs,
    toolWatchdogMs: timeouts.toolWatchdogMs,
    logger,
  });
  return { worker, createSession };
}

/** Message assistant de contenu (fin de tour normale). */
function assistantText(text: string): Record<string, unknown> {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Listener = (event: unknown) => void;

/**
 * Session éphémère en double dont le `prompt` joue le scénario du test.
 * `aborter` = appel de `abort()` observé (mémoire pour les assertions).
 */
function scriptedSession(
  scenario: (emit: Listener, aborted: () => boolean) => Promise<void>,
): { factory: unknown; state: { aborted: boolean } } {
  const state = { aborted: false };
  const factory = async (): Promise<EphemeralSession> => {
    let listener: Listener | undefined;
    const emit = (event: unknown): void => listener?.(event);
    const session = {
      sessionId: "ephemeral-heavy-watchdog",
      subscribe(cb: Listener): () => void {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      async prompt(): Promise<void> {
        await scenario(emit, () => state.aborted);
      },
      async abort(): Promise<void> {
        state.aborted = true;
      },
      dispose(): void {},
      async steer(): Promise<void> {},
    };
    return { session, diagnostics: [] } as unknown as EphemeralSession;
  };
  return { factory, state };
}

describe("worker lourd — outil long et outil qui ne rend jamais", () => {
  it("un OUTIL EN COURS n'est pas de l'inactivité (commande longue possible)", async () => {
    // Inactivité TRÈS courte (100 ms) : sans la suspension pendant les outils,
    // ce job serait abattu à 100 ms alors que l'outil travaille légitimement.
    const { factory, state } = scriptedSession(async (emit, aborted) => {
      emit({ type: "tool_execution_start", toolName: "run_command" });
      await wait(400);
      if (aborted()) return;
      emit({ type: "tool_execution_end", toolName: "run_command" });
      emit(assistantText("Mise à jour terminée."));
    });
    const env = makeEnv(factory, {
      idleTimeoutMs: 100,
      totalTimeoutMs: 30_000,
      toolWatchdogMs: 30_000,
    });
    const result = await env.worker
      .run({ jobId: "job-tool-long", task: "Mettre à jour.", lightSessionId: "sess-1" } as never)
      .promise;

    expect(state.aborted).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.status === "completed" ? result.text : "").toContain("Mise à jour terminée.");
  });

  it("un outil qui ne rend JAMAIS ⇒ échec PROPRE, avec le nom de l'outil et la durée", async () => {
    const { factory } = scriptedSession(async (emit, aborted) => {
      emit({ type: "tool_execution_start", toolName: "run_command" });
      // Plus jamais de `tool_execution_end` : l'outil est parti pour toujours.
      // On attend l'interruption (le job ne doit pas se terminer autrement).
      const fin = Date.now() + 2_000;
      while (!aborted() && Date.now() < fin) await wait(20);
    });
    const env = makeEnv(factory, {
      idleTimeoutMs: 60_000, // ⚠️ L'inactivité ne doit PAS être la cause ici.
      totalTimeoutMs: 60_000,
      toolWatchdogMs: 200,
    });
    const result = await env.worker
      .run({ jobId: "job-tool-bloque", task: "Lancer apt.", lightSessionId: "sess-1" } as never)
      .promise;

    expect(result.status).toBe("failed");
    const message = result.status === "failed" ? result.error : "";
    // Le job a ÉCHOUÉ (il n'est pas resté bloqué) et il dit POURQUOI.
    expect(message).toContain("tool_timeout");
    expect(message).toContain("run_command");
    expect(message).toContain("n'a pas rendu la main");
    expect(message).toContain("état final n'est pas connu");
  });

  it("les motifs de dépassement portent leur EXPLICATION (plus de « timeout » nu)", () => {
    expect(idleTimeoutError(120_000)).toContain("idle_timeout");
    expect(idleTimeoutError(120_000)).toContain("120 s");
    expect(idleTimeoutError(120_000)).toContain("PAS un échec de la machine");
    expect(totalTimeoutError(1_200_000)).toContain("timeout");
    expect(totalTimeoutError(1_200_000)).toContain("1200 s");
    expect(toolWatchdogError("run_command", 960_000)).toContain("tool_timeout");
    expect(toolWatchdogError("run_command", 960_000)).toContain("run_command");
  });
});
