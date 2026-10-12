/**
 * STEER UTILISATEUR (VRAI `src/pi/sdk-host.ts`).
 *
 * ⚠️ DISTINCTION CAPITALE :
 *  - STEER INTERNE (orchestrateur → sous-agent, outil `steer_job`) : éphémère,
 *    jamais dans le transcript ni la mémoire (prouvé dans `tests/delegation`).
 *  - STEER UTILISATEUR (ce fichier) : un message de l'utilisateur pendant un run
 *    est un VRAI échange — INJECTÉ dans le run en cours (`session.steer`), il doit
 *    rester dans le TRANSCRIPT (rechargeable, mémorisable) et NE PAS ouvrir de
 *    nouveau run. Il n'est jamais envoyé au TTS.
 *
 * Le runtime SDK est STUBÉ ; les événements traversent le VRAI `send` /
 * `startRun` / `handleSdkEvent` du host.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDelegationService } from "../../src/delegation/index.js";
import { JobQueue, JobStore } from "../../src/jobs/index.js";
import { createLogger } from "../../src/observability/logger.js";
import type { PiEvent, PiLogger } from "../../src/pi/types.js";
import { FakeHeavyWorker } from "../delegation/fake-heavy-worker.js";

const stub = vi.hoisted(() => ({
  sessionListeners: new Set<(event: unknown) => void>(),
  emit: (event: unknown): void => {
    for (const listener of [...stub.sessionListeners]) listener(event);
  },
  /** Textes reçus par `session.steer` (steer UTILISATEUR). */
  steered: [] as string[],
  /** Résout le prompt en cours (garde le run ouvert pour la durée du test). */
  releasePrompt: undefined as unknown,
  /** Textes reçus par `session.prompt` (tours normaux). */
  prompts: [] as string[],
}));

vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async (options: {
    sessionManager: {
      getSessionId(): string;
      getSessionName(): string | undefined;
      getSessionFile(): string | undefined;
      getBranch(): unknown[];
    };
  }) => {
    const session = {
      sessionId: options.sessionManager.getSessionId(),
      subscribe: (cb: (event: unknown) => void) => {
        stub.sessionListeners.add(cb);
        return () => stub.sessionListeners.delete(cb);
      },
      prompt: async (text: string) => {
        stub.prompts.push(text);
        stub.emit({ type: "agent_start" });
        await new Promise<void>((resolve) => {
          stub.releasePrompt = resolve;
        });
      },
      steer: async (text: string) => {
        stub.steered.push(text);
      },
      abort: async () => undefined,
      sessionManager: options.sessionManager,
    };
    return { session, dispose: async () => undefined };
  },
}));

vi.mock("../../src/pi/sdk/model-runtime.js", () => ({
  getSharedModelRuntime: async () => ({}),
  resolveSdkModel: () => undefined,
  resolveSdkThinking: () => undefined,
}));

import { createSdkPiHost } from "../../src/pi/sdk-host.js";

const noopLogger: PiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const temps: string[] = [];
const hosts: Array<{ stop(): Promise<void> }> = [];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeHost(options: { delegation?: ReturnType<typeof createDelegationService> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "yuki-sdk-user-steer-"));
  temps.push(dir);
  const host = createSdkPiHost({
    agentDir: join(dir, "agent"),
    cwd: join(dir, "workspace"),
    home: join(dir, "home"),
    sessionsDir: join(dir, "sessions"),
    systemPrompt: "prompt système de test",
    logger: noopLogger,
    ...(options.delegation ? { delegation: options.delegation } : {}),
  });
  hosts.push(host);
  return host;
}

function makeDelegation() {
  const dir = mkdtempSync(join(tmpdir(), "yuki-sdk-user-steer-jobs-"));
  temps.push(dir);
  const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
  const store = JobStore.open({ path: join(dir, "jobs.jsonl"), logger });
  const worker = new FakeHeavyWorker();
  const service = createDelegationService({
    store,
    queue: new JobQueue({ maxConcurrent: 3, maxQueue: 10 }),
    heavy: worker,
    availability: { isAvailable: (role) => role === "heavy" },
    logger,
    idleTimeoutMs: 120_000,
    totalTimeoutMs: 1_200_000,
    resultBatchWindowMs: 30,
  });
  return { service, worker, store };
}

function releaseAndFinish(events: PiEvent[], runId: string): Promise<void> {
  const release = stub.releasePrompt as (() => void) | undefined;
  release?.();
  stub.emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "réponse" }],
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2000;
    const tick = () => {
      if (events.some((e) => e.type === "run_finished" && e.runId === runId)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error("run_finished non reçu"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

afterEach(async () => {
  stub.sessionListeners.clear();
  stub.steered.length = 0;
  stub.prompts.length = 0;
  stub.releasePrompt = undefined;
  for (const host of hosts.splice(0)) await host.stop();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sdk-host réel — STEER UTILISATEUR (message pendant un run)", () => {
  it("un message pendant un run est INJECTÉ (session.steer), PAS mis en file", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;

    const first = host.send(sessionId, "message initial");
    await delay(5);
    expect(stub.prompts).toEqual([expect.stringContaining("message initial")]);

    // ⚠️ Le run est EN COURS : le message suivant ne doit PAS attendre.
    const second = host.send(sessionId, "précision pendant le run");
    // Pas de mise en file : c'est un steer.
    expect(second.queued).toBe(false);
    await delay(5);

    // ⚠️ PREUVE : le message est arrivé jusqu'au `session.steer` du run en cours.
    expect(stub.steered).toHaveLength(1);
    expect(stub.steered[0]).toContain("précision pendant le run");
    // Aucun nouveau tour normal n'a été lancé.
    expect(stub.prompts).toHaveLength(1);
    // Un SEUL `run_started` (le message n'ouvre pas de run).
    expect(events.filter((e) => e.type === "run_started")).toHaveLength(1);

    // ⚠️ Vrai échange : les DEUX messages sont dans le TRANSCRIPT (rechargeable).
    const transcript = host.getState(sessionId)?.transcript ?? [];
    const userTexts = transcript
      .filter((entry) => entry.role === "user")
      .map((entry) => entry.text);
    expect(userTexts).toEqual(["message initial", "précision pendant le run"]);

    await releaseAndFinish(events, first.runId);
    expect(host.getState(sessionId)?.state).toBe("idle");
  });

  it("un prompt SYNTHÉTIQUE (rapport de job) pendant un run reste EN FILE", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;

    const first = host.send(sessionId, "message initial");
    await delay(5);
    // Un report de job ne doit JAMAIS interrompre le tour de l'utilisateur.
    const report = host.send(sessionId, "rapport de job simulé", {
      origin: "job_report",
    });
    expect(report.queued).toBe(true);
    await delay(5);
    // Le report n'a PAS été steeré ; il attend son tour.
    expect(stub.steered).toEqual([]);
    expect(stub.prompts).toHaveLength(1);
    // Un prompt synthétique n'entre pas dans le transcript (pas de bulle).
    const userTexts = (host.getState(sessionId)?.transcript ?? [])
      .filter((entry) => entry.role === "user")
      .map((entry) => entry.text);
    expect(userTexts).toEqual(["message initial"]);

    void first;
  });

  it("sans run en cours : comportement INCHANGÉ (tour normal, pas de steer)", async () => {
    const host = makeHost();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;

    const handle = host.send(sessionId, "message à froid");
    expect(handle.queued).toBe(false);
    await delay(5);
    // C'est un `prompt` normal, pas un `steer`.
    expect(stub.prompts).toHaveLength(1);
    expect(stub.steered).toEqual([]);
    await releaseAndFinish(events, handle.runId);
  });

  it("un steer orchestrateur vers un SOUS-AGENT n'interrompt PAS la conversation en cours", async () => {
    const { service, worker } = makeDelegation();
    const host = makeHost({ delegation: service });
    await host.start();
    service.setWaker(host);
    const sid = host.currentSessionId()!;
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));

    // Job lourd en cours.
    worker.push({ manual: true });
    const dispatched = await service.delegate({
      task: "tâche de fond",
      lightSessionId: sid,
    });
    const jobId = dispatched.status === "dispatched" ? dispatched.job_id : "";

    // Conversation LÉGÈRE EN COURS (prompt tenu ouvert).
    const handle = host.send(sid, "question de l'utilisateur");
    await delay(5);
    expect(host.getState(sid)?.state).toBe("streaming");

    // Consigne de l'orchestrateur vers le SOUS-AGENT pendant ce run.
    const steer = await service.steerJob(jobId, "priorise le paiement");
    expect(steer).toMatchObject({ status: "steered" });
    expect(worker.steersFor(0)).toEqual(["priorise le paiement"]);
    // ⚠️ La conversation n'est PAS interrompue : ni abort, ni nouvel état.
    expect(host.getState(sid)?.state).toBe("streaming");
    // La consigne INTERNE n'est pas un message UTILISATEUR : aucun `session.steer`.
    expect(stub.steered).toEqual([]);
    void handle;
  });
});
