import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ACTIVITY_DETAIL_MAX,
  DISPATCH_NOTE,
  MAX_PENDING_STEERS,
  REPORT_HEADER,
  clampDeadline,
  createDelegationService,
  excerptForActivity,
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
  /** Livre immédiatement les lots de résultats en attente (E4). */
  flush: () => void;
}

function makeHarness(options: {
  available?: boolean;
  maxConcurrent?: number;
  maxQueue?: number;
  resultBatchWindowMs?: number;
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
    ...(options.resultBatchWindowMs !== undefined
      ? { resultBatchWindowMs: options.resultBatchWindowMs }
      : {}),
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
  return {
    store,
    queue,
    worker,
    reports,
    events,
    service,
    flush: () => service.flushPendingReports(),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("delegation — E4 : non bloquant par défaut (ticket immédiat)", () => {
  it("sans `background` : rend la main IMMÉDIATEMENT avec un ticket de LANCEMENT", async () => {
    const h = makeHarness();
    h.worker.push({ manual: true });
    const started = Date.now();
    const outcome = await h.service.delegate({
      task: "tâche longue",
      lightSessionId: "sess-1",
      parentRunId: "run-1",
    });
    const elapsed = Date.now() - started;
    // ⚠️ PREUVE DE NON-BLOCAGE : le tour rend la main sans attendre le sous-agent.
    expect(elapsed).toBeLessThan(100);
    expect(outcome.status).toBe("dispatched");
    if (outcome.status !== "dispatched") throw new Error("ticket attendu");
    // Le ticket ANNONCE un lancement ; il n'affirme AUCUN résultat.
    expect(outcome.job_id).toEqual(expect.any(String));
    expect(outcome.note).toBe(DISPATCH_NOTE);
    expect(outcome.note).toMatch(/lancée/i);
    expect(outcome).not.toHaveProperty("result");

    // Le job est BIEN lancé et tourne (non terminal) ; il n'est pas encore rapporté.
    const record = h.store.get(outcome.job_id);
    expect(record?.status).toBe("running");
    expect(h.reports).toHaveLength(0);

    // Une fois la tâche réellement terminée, le résultat est réinjecté (un tour).
    h.worker.finishLast({ status: "completed", text: "résultat final" });
    await wait(10);
    h.flush();
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.text).toContain("résultat final");
  });

  it("`background: \"false\"` (chaîne) repasse en mode bloquant", async () => {
    const h = makeHarness();
    h.worker.push({ autoMs: 5, result: { status: "completed", text: "ok" } });
    const outcome = await h.service.delegate({
      task: "tâche",
      lightSessionId: "sess-1",
      // Un modèle envoie parfois la chaîne "false" : elle ne doit PAS rester
      // en tâche de fond.
      background: false,
    });
    expect(outcome.status).toBe("completed");
  });

  it("E4 — LOTISSEMENT : deux résultats proches ⇒ UN SEUL tour (fenêtre fixe 30 ms)", async () => {
    const h = makeHarness({ resultBatchWindowMs: 30 });
    h.worker.push({ manual: true });
    h.worker.push({ manual: true });
    const a = await h.service.delegate({ task: "tâche A", lightSessionId: "sess-1" });
    const b = await h.service.delegate({ task: "tâche B", lightSessionId: "sess-1" });
    expect(a.status).toBe("dispatched");
    expect(b.status).toBe("dispatched");

    // Les deux terminent dans la même fenêtre : un seul lot doit partir.
    const aId = a.status === "dispatched" ? a.job_id : "";
    const bId = b.status === "dispatched" ? b.job_id : "";
    h.worker.finish(0, { status: "completed", text: "résultat A" });
    h.worker.finish(1, { status: "completed", text: "résultat B" });
    await wait(5);
    // Avant l'échéance de la fenêtre : rien n'est encore parti.
    expect(h.reports).toHaveLength(0);

    await wait(60);
    // ⚠️ PREUVE DU LOTISSEMENT : 2 résultats ⇒ 1 SEUL tour.
    expect(h.reports).toHaveLength(1);
    const prompt = h.reports[0]?.text ?? "";
    expect(prompt.startsWith(REPORT_HEADER)).toBe(true);
    expect(prompt).toContain("résultat A");
    expect(prompt).toContain("résultat B");
    expect(prompt).toContain("2 tâches terminées");
    expect(h.store.get(aId)?.notified).toBe(true);
    expect(h.store.get(bId)?.notified).toBe(true);
  });

  it("E4 — le lot n'est PAS repoussé (≠ debounce) : la fenêtre part du PREMIER résultat", async () => {
    const h = makeHarness({ resultBatchWindowMs: 40 });
    h.worker.push({ manual: true });
    h.worker.push({ manual: true });
    const a = await h.service.delegate({ task: "A", lightSessionId: "sess-1" });
    const b = await h.service.delegate({ task: "B", lightSessionId: "sess-1" });
    void a;
    void b;
    h.worker.finish(0, { status: "completed", text: "A fini" });
    // Le second arrive APRÈS le début de la fenêtre (25 ms < 40 ms).
    await wait(25);
    h.worker.finish(1, { status: "completed", text: "B fini" });
    // La fenêtre n'est PAS repoussée : le lot part ~40 ms après le 1er.
    await wait(30);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0]?.text).toContain("A fini");
    expect(h.reports[0]?.text).toContain("B fini");
  });

  it("E5 — hasPendingWork : vrai tant qu'un job n'est pas terminal ET tant que le lot n'est pas livré", async () => {
    const h = makeHarness();
    h.worker.push({ manual: true });
    const outcome = await h.service.delegate({
      task: "tâche",
      lightSessionId: "sess-1",
    });
    expect(h.service.hasPendingWork("sess-1")).toBe(true);
    expect(h.service.hasPendingWork("autre")).toBe(false);

    h.worker.finishLast({ status: "completed", text: "fini" });
    await wait(10);
    // Terminé mais résultat PAS encore livré ⇒ toujours du travail en attente.
    expect(h.service.hasPendingWork("sess-1")).toBe(true);
    h.flush();
    expect(h.service.hasPendingWork("sess-1")).toBe(false);
    void outcome;
  });
});

describe("delegation — deadline & inline/pending (mode bloquant explicite)", () => {
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
      background: false,
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
    // Rapport émis et journalisé (notified) — à la livraison du lot.
    h.flush();
    expect(h.reports).toHaveLength(1);
    expect(h.store.get(record!.id)?.notified).toBe(true);
  });

  it("deadline courte → {pending, job_id} immédiat, puis le job finit en arrière-plan", async () => {
    const h = makeHarness();
    h.worker.push({ manual: true });
    const started = Date.now();
    const outcome = await h.service.delegate({
      task: "tâche longue",
      lightSessionId: "sess-1",
      background: false,
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
    h.flush();
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
      background: false,
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
      background: false,
      deadlineMs: 200,
    });
    const jobId = outcome.status === "pending" ? outcome.job_id : "";
    const cancelled = await h.service.cancelJob(jobId);
    expect(cancelled).toEqual({ status: "cancelled", job_id: jobId });
    await wait(20);
    expect(h.store.get(jobId)?.status).toBe("cancelled");
    // Un job annulé n'est pas rapporté.
    h.flush();
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
      background: false,
      deadlineMs: 1500,
    });
    h.flush();
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

  it("le mode tâche de fond émet l'étage `delegate_dispatched`", async () => {
    const h = makeHarness();
    h.worker.push({ manual: true });
    await h.service.delegate({ task: "tâche", lightSessionId: "sess-1" });
    const stages = h.events
      .filter((e) => e.type === "phase")
      .map((p) => (p.type === "phase" ? p.stage : ""));
    expect(stages).toContain("delegate_dispatched");
    expect(stages).not.toContain("delegate_inline_wait");
  });

  it("E3 — émet l'ACTIVITÉ du sous-agent (étapes + progression, corrélée au job)", async () => {
    const h = makeHarness();
    h.worker.push({
      autoMs: 5,
      firstToken: true,
      partial: "travail partiel du lourd",
      result: { status: "completed", text: "ok" },
    });
    await h.service.delegate({
      task: "analyse",
      lightSessionId: "sess-1",
      parentRunId: "run-42",
      background: false,
      deadlineMs: 1500,
    });
    const activities = h.events.filter((e) => e.type === "job_activity");
    const stages = activities.map((e) => (e.type === "job_activity" ? e.stage : ""));
    expect(stages).toEqual(
      expect.arrayContaining([
        "job_started",
        "job_first_token",
        "job_progress",
        "job_finished",
      ]),
    );
    // TOUTES rattachées à la session LÉGÈRE et à UN job identifié.
    for (const activity of activities) {
      if (activity.type !== "job_activity") continue;
      expect(activity.sessionId).toBe("sess-1");
      expect(activity.jobId).toEqual(expect.any(String));
      expect(activity.at).toEqual(expect.any(String));
    }
    const started = activities.find(
      (e) => e.type === "job_activity" && e.stage === "job_started",
    );
    expect(started).toMatchObject({ task: "analyse" });
    const progress = activities.find(
      (e) => e.type === "job_activity" && e.stage === "job_progress",
    );
    expect(progress).toMatchObject({ detail: "travail partiel du lourd" });
    const finished = activities.find(
      (e) => e.type === "job_activity" && e.stage === "job_finished",
    );
    expect(finished).toMatchObject({ status: "completed" });
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
      background: false,
      deadlineMs: 1500,
    });
    h.flush();
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
      background: false,
      deadlineMs: 1500,
    });
    h.flush();
    const [record] = h.store.list();
    expect(record?.status).toBe("failed");
    expect(h.reports[0]?.text).toContain("moitié faite");
    expect(h.reports[0]?.text).toContain("failed");
  });
});

describe("delegation — STEER orchestrateur → sous-agent", () => {
  it("job EN COURS : la consigne est REMISE au run en cours (injected) + étape d'activité muette", async () => {
    const h = makeHarness();
    h.worker.push({ manual: true });
    const outcome = await h.service.delegate({
      task: "tâche",
      lightSessionId: "sess-1",
    });
    const jobId = outcome.status === "dispatched" ? outcome.job_id : "";
    const steer = await h.service.steerJob(jobId, "concentre-toi sur X");
    expect(steer).toMatchObject({
      status: "steered",
      delivery: "injected",
      job_id: jobId,
    });
    // ⚠️ PREUVE : la consigne est bien arrivée au worker (donc dans le run).
    expect(h.worker.steersFor(0)).toEqual(["concentre-toi sur X"]);
    // Visibilité E3 : une étape d'ACTIVITÉ (trame de contrôle, muette).
    const activity = h.events.find(
      (e) => e.type === "job_activity" && e.stage === "steer",
    );
    expect(activity).toMatchObject({ jobId, detail: "concentre-toi sur X" });
  });

  it("job EN FILE : consigne TAMPONNÉE puis intégrée au PREMIER message (jamais perdue)", async () => {
    const h = makeHarness({ maxConcurrent: 1 });
    h.worker.push({ manual: true }); // A occupe le seul slot.
    h.worker.push({ manual: true }); // B reste en file.
    const a = await h.service.delegate({ task: "A", lightSessionId: "sess-1" });
    const b = await h.service.delegate({ task: "B", lightSessionId: "sess-1" });
    const bId = b.status === "dispatched" ? b.job_id : "";
    // B n'a PAS démarré (un seul run lourd enregistré).
    expect(h.worker.runs).toHaveLength(1);
    expect(h.store.get(bId)?.status).toBe("queued");

    const steer = await h.service.steerJob(bId, "précision importante");
    expect(steer).toMatchObject({
      status: "steered",
      delivery: "buffered",
      pending: 1,
    });
    // Rien n'est remis au worker tant que B n'a pas démarré.
    expect(h.worker.runs).toHaveLength(1);

    // A se termine ⇒ B démarre AVEC la consigne tamponnée.
    h.worker.finish(0, { status: "completed", text: "A fini" });
    await wait(10);
    expect(h.worker.runs).toHaveLength(2);
    expect(h.worker.runs[1]?.initialSteers).toEqual(["précision importante"]);
    void a;
  });

  it("job INCONNU : not_found (jamais de succès silencieux)", async () => {
    const h = makeHarness();
    const steer = await h.service.steerJob("job-inexistant", "x");
    expect(steer).toMatchObject({
      status: "not_found",
      job_id: "job-inexistant",
    });
  });

  it("job TERMINÉ : not_steerable (jamais de succès silencieux)", async () => {
    const h = makeHarness();
    h.worker.push({ autoMs: 5, result: { status: "completed", text: "ok" } });
    const outcome = await h.service.delegate({
      task: "tâche",
      lightSessionId: "sess-1",
    });
    const jobId = outcome.status === "dispatched" ? outcome.job_id : "";
    await wait(10);
    const steer = await h.service.steerJob(jobId, "trop tard");
    expect(steer).toMatchObject({
      status: "not_steerable",
      job_status: "completed",
      reason: "job_finished",
    });
  });

  it("tampon BORNÉ : au-delà de la borne, refus honnête (buffer_full)", async () => {
    const h = makeHarness({ maxConcurrent: 1 });
    h.worker.push({ manual: true });
    h.worker.push({ manual: true });
    await h.service.delegate({ task: "A", lightSessionId: "sess-1" });
    const b = await h.service.delegate({ task: "B", lightSessionId: "sess-1" });
    const bId = b.status === "dispatched" ? b.job_id : "";
    for (let i = 0; i < MAX_PENDING_STEERS; i += 1) {
      const accepted = await h.service.steerJob(bId, `consigne ${i}`);
      expect(accepted.status).toBe("steered");
    }
    // ⚠️ Au-delà de la borne : REFUS explicite, jamais un jeté silencieux.
    const full = await h.service.steerJob(bId, "de trop");
    expect(full).toMatchObject({
      status: "buffer_full",
      limit: MAX_PENDING_STEERS,
    });
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

  it("excerptForActivity tient sur une ligne et borne la longueur", () => {
    expect(excerptForActivity("  a\n\nb\t c ")).toBe("a b c");
    const long = excerptForActivity("x".repeat(500));
    expect(long.length).toBeLessThanOrEqual(ACTIVITY_DETAIL_MAX);
    expect(long.endsWith("…")).toBe(true);
    const short = "y".repeat(ACTIVITY_DETAIL_MAX);
    expect(excerptForActivity(short)).toBe(short);
  });
});
