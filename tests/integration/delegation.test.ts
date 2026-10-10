/**
 * Intégration délégation ↔ façade légère (sans SDK, sans réseau).
 *
 * Vérifie que le réveil du léger passe bien par `PiHost.send(..., { origin:
 * "job_report" })`, que le lourd ne s'exprime jamais dans la session légère et
 * que sa réflexion n'apparaît nulle part.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDelegationService } from "../../src/delegation/index.js";
import { JobQueue, JobStore } from "../../src/jobs/index.js";
import { createLogger } from "../../src/observability/logger.js";
import type { PiEvent } from "../../src/pi/types.js";
import { FakePiHost } from "../pi/host-double.js";
import { FakeHeavyWorker } from "../delegation/fake-heavy-worker.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("intégration — report du léger", () => {
  it("réveille le léger avec un prompt synthétique et ne montre jamais le lourd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-deleg-int-"));
    tempDirs.push(dir);
    const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
    const store = JobStore.open({ path: join(dir, "jobs.jsonl"), logger });
    const queue = new JobQueue({ maxConcurrent: 3, maxQueue: 10 });
    const worker = new FakeHeavyWorker();
    const host = new FakePiHost({ sessionId: "sess-light" });
    await host.start();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));

    const service = createDelegationService({
      store,
      queue,
      heavy: worker,
      availability: { isAvailable: () => true },
      logger,
      idleTimeoutMs: 120_000,
      totalTimeoutMs: 1_200_000,
    });
    service.subscribe((event) => void event);
    service.setWaker(host);

    worker.push({
      autoMs: 5,
      firstToken: true,
      partial: "réflexion interne secrète",
      result: { status: "completed", text: "rapport technique complet" },
    });

    const outcome = await service.delegate({
      task: "tâche complexe",
      lightSessionId: "sess-light",
      parentRunId: "run-light-1",
      deadlineMs: 1500,
    });
    expect(outcome.status).toBe("completed");
    await wait(20);

    // Le léger a été réveillé par un prompt SYNTHÉTIQUE (origine `job_report`).
    // ⚠️ Miroir du host RÉEL : un prompt synthétique n'apparaît NI dans le
    // transcript de l'UI, NI dans le `userText` du `run_started`. On vérifie
    // donc le réveil sur l'ÉVÉNEMENT, pas sur le transcript.
    const runStarted = events.find((event) => event.type === "run_started");
    expect(runStarted?.origin).toBe("job_report");
    expect(runStarted?.userText ?? "").not.toContain("[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]");
    const state = host.getState("sess-light");
    const transcript = state?.transcript ?? [];
    expect(transcript.some((entry) => entry.role === "user")).toBe(false);
    expect(
      transcript.some((entry) => entry.text.includes("[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]")),
    ).toBe(false);
    expect(transcript.some((entry) => entry.text.includes("réflexion interne secrète"))).toBe(false);
  });
});
