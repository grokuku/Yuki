/**
 * E5 — VERROU ANTI-MENSONGE (VRAI `src/pi/sdk-host.ts`).
 *
 * ⚠️ POURQUOI CE TEST EXISTE : dès que `delegate` devient NON BLOQUANT, le
 * modèle POURRAIT écrire « c'est fait » alors que la tâche tourne encore. Or la
 * vérité de complétion ne vit PAS dans le texte du modèle, mais dans le
 * `JobStore`. On exerce le VRAI `finalizeRun` : un job en cours ⇒ l'état émis est
 * `waiting`, PAS `idle`, quoi que dise l'assistant.
 *
 * Le runtime SDK est STUBÉ (comme `sdk-host-run-metrics.test.ts`), mais les
 * événements traversent le VRAI `handleSdkEvent` / `finalizeRun` du host, et le
 * port de délégation est un VRAI `DelegationService` adossé à un VRAI `JobStore`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDelegationService } from "../../src/delegation/index.js";
import { JobQueue, JobStore } from "../../src/jobs/index.js";
import { createLogger } from "../../src/observability/logger.js";
import type { PiEvent, PiLogger } from "../../src/pi/types.js";
import { FakeHeavyWorker } from "../delegation/fake-heavy-worker.js";

type Manager = ReturnType<typeof SessionManager.create>;

const stub = vi.hoisted(() => ({
  sessionListeners: new Set<(event: unknown) => void>(),
  emit: (event: unknown): void => {
    for (const listener of [...stub.sessionListeners]) listener(event);
  },
  onPrompt: undefined as unknown,
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
      prompt: async () => {
        const onPrompt = stub.onPrompt as
          | ((manager: unknown) => Promise<void>)
          | undefined;
        if (onPrompt) await onPrompt(options.sessionManager);
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

const USAGE = {
  input: 10,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 30,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: USAGE,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function waitForRunFinished(events: PiEvent[], runId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 3000;
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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), "yuki-sdk-waiting-"));
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
  const host = createSdkPiHost({
    agentDir: join(dir, "agent"),
    cwd: join(dir, "workspace"),
    home: join(dir, "home"),
    sessionsDir: join(dir, "sessions"),
    systemPrompt: "prompt système de test",
    logger: noopLogger,
    delegation: service,
    eventSource: service,
  });
  hosts.push(host);
  service.setWaker(host);
  return { host, store, worker, service };
}

afterEach(async () => {
  stub.sessionListeners.clear();
  stub.onPrompt = undefined;
  for (const host of hosts.splice(0)) await host.stop();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sdk-host réel — E5 : l'état reste `waiting` malgré un texte qui prétend le contraire", () => {
  it("job NON terminal + assistant qui dit « c'est fait » ⇒ state = waiting (jamais idle)", async () => {
    const { host, worker, service } = makeHarness();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;

    // Le sous-agent tourne (job NON terminal), comme après un `delegate` de fond.
    worker.push({ manual: true });
    const dispatched = await service.delegate({
      task: "tâche de fond",
      lightSessionId: sessionId,
    });
    expect(dispatched.status).toBe("dispatched");

    // L'assistant écrit noir sur blanc que tout est fini.
    const CLAIM = "C'est fait, tout est terminé.";
    stub.onPrompt = async (m: Manager) => {
      const assistant = assistantMessage(CLAIM);
      m.appendMessage(assistant as never);
      stub.emit({ type: "agent_start" });
      stub.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: CLAIM },
      });
      stub.emit({ type: "message_end", message: assistant });
    };

    const handle = host.send(sessionId, "Occupe-toi de la tâche.");
    await waitForRunFinished(events, handle.runId);
    await delay(5);

    // Le texte mensonger EST bien dans le transcript...
    const transcript = host.getState(sessionId)?.transcript ?? [];
    expect(transcript.some((e) => e.role === "assistant" && e.text === CLAIM)).toBe(true);
    // ...mais la VÉRITÉ (le JobStore) impose `waiting`.
    const state = host.getState(sessionId)?.state;
    expect(state).toBe("waiting");
    const last = events.filter((e) => e.type === "state").at(-1);
    expect(last?.type === "state" && last.state).toBe("waiting");

    // Le résultat n'a pas encore été livré : on reste `waiting`.
    expect(service.hasPendingWork(sessionId)).toBe(true);
  });

  it("le badge disparaît quand le job est terminal ET le tour réinjecté livré", async () => {
    const { host, worker, service } = makeHarness();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;

    worker.push({ manual: true });
    await service.delegate({ task: "tâche de fond", lightSessionId: sessionId });

    stub.onPrompt = async (m: Manager) => {
      const assistant = assistantMessage("C'est fait.");
      m.appendMessage(assistant as never);
      stub.emit({ type: "agent_start" });
      stub.emit({ type: "message_end", message: assistant });
    };
    const handle = host.send(sessionId, "go");
    await waitForRunFinished(events, handle.runId);
    await delay(5);
    expect(host.getState(sessionId)?.state).toBe("waiting");

    // Le job se termine : l'état reste `waiting` jusqu'à la LIVRAISON du résultat.
    worker.finishLast({ status: "completed", text: "résultat du sous-agent" });
    await delay(10);
    expect(host.getState(sessionId)?.state).toBe("waiting");

    // Livraison du lot ⇒ tour réinjecté ⇒ l'état repasse à `idle`.
    service.flushPendingReports();
    await delay(30);
    const finalState = host.getState(sessionId)?.state;
    expect(finalState).toBe("idle");
    expect(service.hasPendingWork(sessionId)).toBe(false);
  });
});
