import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  REPORT_HEADER,
  clampDeadline,
  createDelegationService,
  truncateToBytes,
  type DelegateOutcome,
  type ModelAvailability,
} from "../../src/delegation/index.js";
import { JobQueue, JobStore } from "../../src/jobs/index.js";
import { createLogger } from "../../src/observability/logger.js";
import type { PiEvent } from "../../src/pi/types.js";
import { FakeHeavyWorker } from "./fake-heavy-worker.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  store: JobStore;
  queue: JobQueue;
  worker: FakeHeavyWorker;
  reports: Array<{ sessionId: string; text: string; origin?: string; jobId?: string }>;
  events: PiEvent[];
  service: ReturnType<typeof createDelegationService>;
}

function makeHarness(options: {
  available?: boolean;
  maxConcurrent?: number;
  maxQueue?: number;
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "yuki-deleg-"));
  tempDirs.push(dir);
  const store = JobStore.open({
    path: join(dir, "jobs.jsonl"),
    logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }),
  });
  const queue = new JobQueue({
    maxConcurrent: options.maxConcurrent ?? 3,
    maxQueue: options.maxQueue ?? 10,
  });
  const worker = new FakeHeavyWorker();
  const reports: Harness["reports"] = [];
  const events: PiEvent[] = [];
  const availability: ModelAvailability = {
    isAvailable: (role: string) => (options.available ?? true) && role === "heavy",
  };
  const service = createDelegationService({
    store,
    queue,
    heavy: worker,
    availability,
    logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }),
    idleTimeoutMs: 120_000,
    totalTimeoutMs: 1_200_000,
  });
  service.subscribe((event) => events.push(event));
  service.setWaker({
    send: (sessionId, text, opts) => {
      reports.push({
        sessionId,
        text,
        ...(opts?.origin !== undefined ? { origin: opts.origin } : {}),
        ...(opts?.jobId !== undefined ? { jobId: opts.jobId } : {}),
      });
      return { runId: "run-report-1" };
    },
  });
  return { store, queue, worker, reports, events, service };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("delegation — deadline & inline/pending", () => {
  it("job terminé avant la deadline → INLINE avec usage", async () => {
    const h = makeHarness();
    h.worker.push({
      autoMs: 5,
      firstToken: true,
      partial: "brouillon",
      result: { status: "completed", text: "résultat final", usage: { input: 11, output: 22 } },
    });
    const outcome = await h.service.delegate({
      task: "tâche",
      lightSessionId: "sess-1",
      parentRunId: "run-1",
      deadlineMs: 1500,
    });
    expect(outcome).toMatchObject({
      status: "completed",
      result: "résultat final",
      usage_input: 11,
      usage_output: 22,
      truncated: false,
    });
    expect(outcome.status === "completed" && outcome.duration_ms).toBeGreaterThanOrEqual(0);

    const [record] = h.store.list();
    expect(record?.status).toBe("completed");
    expect(record?.result.partial).toBe("brouillon");
    // Rapport émis et journalisé (notified).
    expect(h.reports).toHaveLength(1);
    expect(record?.notified).toBe(true);
  });

  it("deadline courte → {pending, job_id} immédiat, puis le job finit en arrière-plan", async () => {
    const h = makeHarness();
    h.worker.push({ manual: true });
    const started = Date.now();
    const outcome = await h.service.delegate({
      task: "tâche longue",
      lightSessionId: "sess-1",
      deadlineMs: 200,
    });
    expect(outcome).toMatchObject({ status: "pending", deadline_ms: 200 });
    expect(Date.now() - started).toBeLessThan(1000);
    const jobId = outcome.status === "pending" ? outcome.job_id : "";
    expect(h.store.get(jobId)?.status).toBe("running");

    // Le job SURVIT à la deadline et se termine plus tard.
    h.worker.finishLast({ status: "completed", text: "terminé après coup" });
    await wait(20);
    expect(h.store.get(jobId)?.status).toBe("completed");
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.text).toContain(REPORT_HEADER);
  });

  it("clé lourde absente → unavailable, aucun job créé", async () => {
    const h = makeHarness({ available: false });
    const outcome = await h.service.delegate({
      task: "tâche",
      lightSessionId: "sess-1",
    });
    expect(outcome).toEqual({ status: "unavailable", reason: "heavy_unavailable" });
    expect(h.store.size).toBe(0);
    expect(h.worker.runs).toHaveLength(0);
  });

  it("file pleine → rejected immédiat (jamais de blocage silencieux)", async () => {
    const h = makeHarness({ maxConcurrent: 1, maxQueue: 0 });
    h.worker.push({ manual: true });
    const first = h.service.delegate({
      task: "occupant",
      lightSessionId: "sess-1",
      deadlineMs: 200,
    });
    const second = await h.service.delegate({
      task: "refusé",
      lightSessionId: "sess-1",
    });
    expect(second).toEqual({ status: "rejected", reason: "queue_full" });
    const firstOutcome = (await first) as DelegateOutcome;
    expect(firstOutcome.status).toBe("pending");
  });

  it("cancel_job annule un job en cours", async () => {
    const h = makeHarness();
    h.worker.push({ manual: true });
    const outcome = await h.service.delegate({
      task: "annulable",
      lightSessionId: "sess-1",
      deadlineMs: 200,
    });
    const jobId = outcome.status === "pending" ? outcome.job_id : "";
    const cancelled = await h.service.cancelJob(jobId);
    expect(cancelled).toEqual({ status: "cancelled", job_id: jobId });
    await wait(20);
    expect(h.store.get(jobId)?.status).toBe("cancelled");
    // Un job annulé n'est pas rapporté.
    expect(h.reports).toHaveLength(0);
  });
});

describe("delegation — instrumentation & report", () => {
  it("émet les étages avec corrélation jobId", async () => {
    const h = makeHarness();
    h.worker.push({ autoMs: 5, result: { status: "completed", text: "ok" } });
    await h.service.delegate({
      task: "tâche",
      lightSessionId: "sess-1",
      parentRunId: "run-42",
      deadlineMs: 1500,
    });
    const phases = h.events.filter((e) => e.type === "phase");
    const stages = phases.map((p) => (p.type === "phase" ? p.stage : ""));
    expect(stages).toEqual(
      expect.arrayContaining([
        "delegate_received",
        "delegate_inline_wait",
        "job_enqueued",
        "job_started",
        "job_finished",
        "report_requested",
        "report_emitted",
        "delegate_returned_inline",
      ]),
    );
    // Corrélation : les étages de job portent le jobId.
    const jobPhases = phases.filter(
      (p) => p.type === "phase" && p.stage === "job_started",
    );
    expect(jobPhases[0]).toMatchObject({ runId: "run-42" });
    expect(
      jobPhases[0]?.type === "phase" ? jobPhases[0].jobId : undefined,
    ).toEqual(expect.any(String));

    const jobEvents = h.events.filter(
      (e) => e.type === "job_started" || e.type === "job_finished" || e.type === "job_report",
    );
    expect(jobEvents.length).toBeGreaterThanOrEqual(3);
  });

  it("le report porte l'en-tête, le job_id et n'expose aucun thinking", async () => {
    const h = makeHarness();
    h.worker.push({
      autoMs: 5,
      result: { status: "completed", text: "contenu final du lourd" },
    });
    await h.service.delegate({
      task: "tâche",
      lightSessionId: "sess-1",
      deadlineMs: 1500,
    });
    const report = h.reports[0];
    expect(report).toBeDefined();
    expect(report?.origin).toBe("job_report");
    expect(report?.sessionId).toBe("sess-1");
    expect(report?.text).toContain(REPORT_HEADER);
    expect(report?.text).toContain("contenu final du lourd");
    expect(report?.text).not.toContain("thinking");
    expect(report?.text).toContain("1 à 3 phrases");
  });

  it("job failed → report avec partial et statut failed", async () => {
    const h = makeHarness();
    h.worker.push({
      autoMs: 5,
      result: { status: "failed", error: "boum", partial: "moitié faite" },
    });
    await h.service.delegate({
      task: "tâche",
      lightSessionId: "sess-1",
      deadlineMs: 1500,
    });
    const [record] = h.store.list();
    expect(record?.status).toBe("failed");
    expect(h.reports[0]?.text).toContain("moitié faite");
    expect(h.reports[0]?.text).toContain("failed");
  });
});

describe("delegation — helpers", () => {
  it("clampDeadline borne et retombe sur le défaut", () => {
    expect(clampDeadline(undefined)).toBe(1500);
    expect(clampDeadline("abc")).toBe(1500);
    expect(clampDeadline(null)).toBe(1500);
    expect(clampDeadline(50)).toBe(200);
    expect(clampDeadline(100_000)).toBe(60_000);
    expect(clampDeadline(3210.4)).toBe(3210);
  });

  it("truncateToBytes borne en octets UTF-8", () => {
    const { text, truncated } = truncateToBytes("ééé", 2);
    expect(truncated).toBe(true);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(2);
    expect(truncateToBytes("ok", 10)).toEqual({ text: "ok", truncated: false });
  });
});
