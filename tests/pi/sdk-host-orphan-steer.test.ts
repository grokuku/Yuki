/**
 * PARITÉ PI-WEB — FILET « PAS DE STEER ORPHELIN » + INACTIVITÉ APRÈS DÉLÉGATION.
 *
 * Le VRAI `src/pi/sdk-host.ts` est exercé ; le runtime SDK est STUBÉ avec une
 * file de steering FIDÈLE (le `steer` met en file, `prompt` ne purge PAS —
 * comme un run qui a dépassé son dernier poll de steering).
 *
 * ⚠️ Le test ① est LE test qui compte : un message UTILISATEUR livré pendant un
 * run et NON consommé avant la fin de ce run doit ROUVRIR UN TOUR IMMÉDIATEMENT —
 * jamais attendre le rapport d'un job. Sans le filet, le message resterait dans
 * la file jusqu'au prochain tour (en pratique le rapport du job) : c'est
 * exactement le scénario réel qui a échoué (clone de Tetris + « 5 thèmes »).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDelegationService } from "../../src/delegation/index.js";
import { JobQueue, JobStore } from "../../src/jobs/index.js";
import { createLogger } from "../../src/observability/logger.js";
import {
  createDelegateTools,
  createRunContextTracker,
} from "../../src/pi/sdk/delegate-tools.js";
import { PENDING_JOBS_TAG } from "../../src/pi/sdk/delegation-extension.js";
import type { PiEvent, PiLogger } from "../../src/pi/types.js";
import { FakeHeavyWorker } from "../delegation/fake-heavy-worker.js";

const stub = vi.hoisted(() => ({
  sessionListeners: new Set<(event: unknown) => void>(),
  emit: (event: unknown): void => {
    for (const listener of [...stub.sessionListeners]) listener(event);
  },
  /** Textes reçus par `session.steer` (steer UTILISATEUR). */
  steered: [] as string[],
  /** File de steering SIMULÉE du SDK (vide à la livraison de chaque message). */
  steering: [] as string[],
  /** Nombre d'appels à `clearQueue` (purge du filet). */
  cleared: 0,
  /** Textes reçus par `session.prompt` (tours normaux). */
  prompts: [] as string[],
  /** Résout le prompt EN COURS (garde le run ouvert pour la durée du test). */
  releasePrompt: undefined as unknown,
  /** Fabriques d'extensions passées au runtime (pour prouver le câblage). */
  extensionFactories: [] as unknown[],
}));

vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async (options: {
    sessionManager: {
      getSessionId(): string;
      getSessionName(): string | undefined;
      getSessionFile(): string | undefined;
      getBranch(): unknown[];
    };
    extensionFactories?: unknown[];
  }) => {
    stub.extensionFactories = options.extensionFactories ?? [];
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
        stub.steering.push(text);
      },
      // ⚠️ FIDÈLE au SDK : la file de steering n'est PAS purgée par `prompt`
      // (le run a passé son dernier poll) — c'est ce qui crée l'orphelin.
      getSteeringMessages: () => stub.steering,
      clearQueue: () => {
        stub.cleared += 1;
        const steering = [...stub.steering];
        stub.steering.length = 0;
        return { steering, followUp: [] };
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

type Harness = {
  host: ReturnType<typeof createSdkPiHost>;
  service: ReturnType<typeof createDelegationService>;
  worker: FakeHeavyWorker;
};

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "yuki-sdk-orphan-"));
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
  return { host, service, worker };
}

function endRun(): void {
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

/**
 * Récupère le handler `before_agent_start` de la fabrique de relais RÉELLEMENT
 * passée au runtime par le host, pour prouver le câblage de bout en bout.
 */
function relayHandler(): (event: unknown, ctx: unknown) => unknown {
  const factory = stub.extensionFactories.find(
    (f) => (f as { name?: string }).name === "yuki-delegation-relay",
  ) as { factory?: unknown } | ((pi: unknown) => void) | undefined;
  expect(factory).toBeDefined();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const run = typeof factory === "function" ? factory : factory!.factory;
  (run as (pi: unknown) => void)({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(name, handler);
    },
  });
  const handler = handlers.get("before_agent_start");
  expect(handler).toBeDefined();
  return handler!;
}

afterEach(async () => {
  stub.sessionListeners.clear();
  stub.steered.length = 0;
  stub.steering.length = 0;
  stub.cleared = 0;
  stub.prompts.length = 0;
  stub.releasePrompt = undefined;
  stub.extensionFactories.length = 0;
  for (const host of hosts.splice(0)) await host.stop();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("① FILET — un message utilisateur non consommé rouvre un tour IMMÉDIATEMENT", () => {
  it("message pendant le run ⇒ livré en steer, NON consommé ⇒ ROUVRE un tour NEUF tout de suite (pas au rapport du job)", async () => {
    const { host } = makeHarness();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;

    const first = host.send(sessionId, "clone Tetris");
    await delay(5);
    expect(stub.prompts).toHaveLength(1);

    // Message suivant PENDANT le run : livré en steer (vrai message), et — comme
    // le run a déjà passé son dernier poll — il RESTE en file (orphelin).
    const second = host.send(sessionId, "ajoute 5 thèmes");
    expect(second.queued).toBe(false);
    await delay(5);
    expect(stub.steered).toHaveLength(1);
    expect(stub.steered[0]).toContain("ajoute 5 thèmes");
    expect(stub.steering).toHaveLength(1); // encore en file = NON consommé
    // Toujours un seul tour : le steer n'ouvre pas de run à lui seul.
    expect(stub.prompts).toHaveLength(1);

    // Fin du run SANS rapport de job.
    endRun();
    await waitForRunFinished(events, first.runId);
    await delay(10);

    // ⚠️ LE FILET : un tour NEUF est parti TOUT DE SUITE avec le message orphelin.
    expect(stub.prompts).toHaveLength(2);
    expect(stub.prompts[1]).toContain("ajoute 5 thèmes");
    // La file du SDK a été purgée (le message va être rejoué, pas doublé).
    expect(stub.cleared).toBeGreaterThanOrEqual(1);
    expect(stub.steering).toHaveLength(0);
    // Deux tours visibles : l'initial puis le message orphelin rejoué.
    expect(events.filter((e) => e.type === "run_started")).toHaveLength(2);

    // ⚠️ INVARIANT : le message orphelin reste UN VRAI message — il est dans le
    // transcript (une seule fois) ET c'est un message UTILISATEUR.
    const userTexts = (host.getState(sessionId)?.transcript ?? [])
      .filter((entry) => entry.role === "user")
      .map((entry) => entry.text);
    expect(userTexts).toEqual(["clone Tetris", "ajoute 5 thèmes"]);
  });

  it("message utilisateur CONSOMMÉ pendant le run ⇒ AUCUN tour neuf (pas de doublon)", async () => {
    const { host } = makeHarness();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;

    const first = host.send(sessionId, "message initial");
    await delay(5);

    host.send(sessionId, "précision consommée");
    await delay(5);
    expect(stub.steering).toHaveLength(1);
    // Le run CONSOMME le steer (la file se vide) : plus rien d'orphelin.
    stub.steering.length = 0;

    endRun();
    await waitForRunFinished(events, first.runId);
    await delay(10);

    // Aucun tour neuf : le filet NE rejoue PAS un message déjà consommé.
    expect(stub.prompts).toHaveLength(1);
    expect(stub.cleared).toBe(0);
  });
});

describe("③ INACTIVE après délégation — le message suivant ouvre un TOUR NEUF, jamais un steer condamné", () => {
  it("après le ticket de delegate, la session n'a plus de run en vol et le message suivant est un NOUVEAU TOUR", async () => {
    const { host, service, worker } = makeHarness();
    const events: PiEvent[] = [];
    host.subscribeAll((event) => events.push(event));
    await host.start();
    const sessionId = host.currentSessionId()!;

    // Un sous-agent tourne (comme après un `delegate` de fond non bloquant).
    worker.push({ manual: true });
    const dispatched = await service.delegate({
      task: "tâche de fond",
      lightSessionId: sessionId,
    });
    expect(dispatched.status).toBe("dispatched");

    // Tour de l'orchestrateur : il rend la main (le run se termine).
    const handle = host.send(sessionId, "occupe-toi de la tâche");
    await delay(5);
    expect(host.getState(sessionId)?.state).toBe("streaming");
    endRun();
    await waitForRunFinished(events, handle.runId);
    await delay(10);

    // ⚠️ Plus AUCUN run en vol : l'orchestrateur est INACTIF (badge E5 `waiting`
    // car un job tourne encore, mais ce n'est PAS un run).
    const state = host.getState(sessionId);
    expect(state?.activeRunId).toBeUndefined();
    expect(state?.state).toBe("waiting");

    // ⚠️ Le message suivant ouvre un TOUR NEUF (prompt), PAS un steer condamné.
    const before = stub.prompts.length;
    const next = host.send(sessionId, "ajoute 5 thèmes");
    expect(next.queued).toBe(false);
    await delay(5);
    expect(stub.prompts.length).toBe(before + 1);
    expect(stub.prompts.at(-1)).toContain("ajoute 5 thèmes");
    expect(stub.steered).toHaveLength(0);
  });
});

describe("② Yuki SAIT qu'un job tourne (prompt effectif via le vrai câblage du host)", () => {
  it("l'extension de relais est câblée et injecte la consigne + le job en cours dans le prompt du tour", async () => {
    const { host, service, worker } = makeHarness();
    await host.start();
    const sessionId = host.currentSessionId()!;

    // Job de fond EN COURS : le `JobStore` (source de vérité) le liste avec son
    // statut `running` et son intitulé.
    worker.push({ manual: true });
    const dispatched = await service.delegate({
      task: "cloner Tetris et ajouter des thèmes",
      lightSessionId: sessionId,
    });
    expect(dispatched.status).toBe("dispatched");
    await delay(5);

    // Récupère la fabrique d'extension RÉELLEMENT passée au runtime par le host
    // et exerce son handler `before_agent_start` avec le contexte de la session.
    const handler = relayHandler();
    const result = handler(
      { prompt: "où en est-on ?", systemPrompt: "PROMPT DE BASE" },
      { sessionManager: { getSessionId: () => sessionId } },
    ) as { systemPrompt?: string };
    const text = result.systemPrompt ?? "";
    // Consigne de relais BINDING présente (extrait).
    expect(text).toContain("Relais vers les sous-agents");
    expect(text).toContain("steer_job");
    // ⚠️ Yuki SAIT quel job tourne (extrait : intitulé + job_id + statut).
    expect(text).toContain("cloner Tetris et ajouter des thèmes");
    expect(text).toContain(dispatched.status === "dispatched" ? dispatched.job_id : "");
    expect(text).toContain("Tâches en cours");
    expect(text).toContain("en cours");

    // ⚠️ ÉPHÉMÈRE : rien de ce bloc n'entre dans le transcript / le snapshot.
    const serialized = JSON.stringify(host.getState(sessionId));
    expect(serialized).not.toContain(`<${PENDING_JOBS_TAG}>`);
    expect(serialized).not.toContain("Relais vers les sous-agents");
  });

  it("sans tâche en cours : l'injection disparaît (mention « aucune tâche »), elle ne relaie pas à tort", async () => {
    const { host } = makeHarness();
    await host.start();
    const sessionId = host.currentSessionId()!;

    const handler = relayHandler();
    const result = handler(
      { prompt: "salut", systemPrompt: "PROMPT DE BASE" },
      { sessionManager: { getSessionId: () => sessionId } },
    ) as { systemPrompt?: string };
    const text = result.systemPrompt ?? "";
    expect(text).toContain("Aucune tâche en cours pour cette conversation.");
    expect(text).not.toContain(`<${PENDING_JOBS_TAG}>`);
  });

  it("CHAÎNE COMPLÈTE : Yuki VOIT le job → elle appelle steer_job(job_id) → la consigne ATTEINT le sous-agent", async () => {
    const { host, service, worker } = makeHarness();
    await host.start();
    const sessionId = host.currentSessionId()!;

    // Le sous-agent tourne.
    worker.push({ manual: true });
    const dispatched = await service.delegate({
      task: "cloner Tetris",
      lightSessionId: sessionId,
    });
    expect(dispatched.status).toBe("dispatched");
    await delay(5);

    // 1) Elle VOIT le job et un job_id EXPLOITABLE dans le prompt effectif.
    const handler = relayHandler();
    const prompt =
      (
        handler(
          { prompt: "où en est-on ?", systemPrompt: "PROMPT DE BASE" },
          { sessionManager: { getSessionId: () => sessionId } },
        ) as { systemPrompt?: string }
      ).systemPrompt ?? "";
    expect(prompt).toContain("cloner Tetris");
    expect(prompt).toContain("en cours");
    const match = prompt.match(/job_id : (job-[^\s,)]+)/);
    expect(match).toBeTruthy();
    const jobId = match![1];

    // 2) Elle DÉCIDE et appelle l'outil `steer_job` sur ce job_id.
    const tools = createDelegateTools({
      service,
      tracker: createRunContextTracker(),
    });
    const steerTool = tools.find((tool) => tool.name === "steer_job")!;
    const res = await steerTool.execute(
      "call-1",
      { job_id: jobId, text: "ajoute 5 thèmes" },
      undefined,
      undefined,
      { sessionManager: { getSessionId: () => sessionId } } as never,
    );
    const outcome = JSON.parse((res.content[0] as { text: string }).text) as {
      status: string;
    };
    expect(outcome.status).toBe("steered");

    // 3) La consigne a ATTEINT le sous-agent (le vrai `steerJob` du service).
    expect(worker.steersFor(0)).toContain("ajoute 5 thèmes");
    // Le job_id extrait du prompt est bien celui du job en cours.
    expect(dispatched.status === "dispatched" ? dispatched.job_id : "").toBe(jobId);
  });
});
