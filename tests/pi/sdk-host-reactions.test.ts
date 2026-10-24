/**
 * Intégration — RÉACTIONS : corrélation STABLE et injection au tour SUIVANT.
 *
 * ⚠️ POURQUOI CE TEST EXISTE : le piège n°1 est la MAUVAISE corrélation (une
 * réaction posée sur un autre message ferait apprendre au modèle le contraire).
 * On exerce donc le VRAI `src/pi/sdk-host.ts` (runtime SDK stubé, mais
 * `SessionManager` RÉEL et chaîne d'extensions RÉELLE construite par
 * `buildInlineExtensions`) pour prouver :
 *
 *  1. `run_finished.entryId` EST l'identifiant de l'entrée de session du message
 *     assistant persisté — la MÊME valeur que le `parentId` de `yuki.run_metrics`
 *     (aucun second identifiant n'est inventé) ;
 *  2. une réaction enregistrée dans le store sur cet identifiant est bien
 *     injectée dans le PROMPT SYSTÈME du tour SUIVANT, avec le SENS de son
 *     groupe (jugement / émotion / humeur) ;
 *  3. une réaction sur un AUTRE message n'apparaît pas sur celui-ci ;
 *  4. `getState` expose `id` par message : la reconnexion et le rechargement
 *     peuvent rattacher la réaction au bon message.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RUN_METRICS_CUSTOM_TYPE } from "../../src/pi/events.js";
import type { PiEvent, PiLogger } from "../../src/pi/types.js";
import { ReactionStore } from "../../src/reactions/store.js";
import { REACTIONS_TAG } from "../../src/reactions/prompt.js";

type Manager = ReturnType<typeof SessionManager.create>;

const stub = vi.hoisted(() => ({
  sessionListeners: new Set<(event: unknown) => void>(),
  extensions: [] as Array<{ name?: string; factory?: unknown }>,
  emit: (event: unknown): void => {
    for (const listener of [...stub.sessionListeners]) listener(event);
  },
  manager: undefined as unknown,
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
    extensionFactories?: Array<{ name?: string; factory?: unknown }>;
  }) => {
    stub.manager = options.sessionManager;
    stub.extensions = options.extensionFactories ?? [];
    const session = {
      sessionId: options.sessionManager.getSessionId(),
      subscribe: (cb: (event: unknown) => void) => {
        stub.sessionListeners.add(cb);
        return () => stub.sessionListeners.delete(cb);
      },
      prompt: async () => {
        const onPrompt = stub.onPrompt as ((manager: unknown) => Promise<void>) | undefined;
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

interface World {
  host: ReturnType<typeof createSdkPiHost>;
  store: ReactionStore;
  events: PiEvent[];
  systemPrompts: string[];
}

/**
 * Monte un host RÉEL avec le port des réactions. La chaîne d'extensions RÉELLE
 * (construite par `buildInlineExtensions`) est rejouée à chaque tour, comme le
 * SDK le fait, pour capturer le prompt système EFFECTIVEMENT construit.
 */
async function makeWorld(): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), "yuki-host-reactions-"));
  temps.push(dir);
  const store = ReactionStore.open({ path: join(dir, "state", "reactions.jsonl") });
  const host = createSdkPiHost({
    agentDir: join(dir, "agent"),
    cwd: join(dir, "workspace"),
    home: join(dir, "home"),
    sessionsDir: join(dir, "sessions"),
    systemPrompt: "PROMPT SYSTÈME DE TEST",
    reactions: store,
    logger: noopLogger,
  });
  hosts.push(host);
  const events: PiEvent[] = [];
  host.subscribeAll((event) => events.push(event));
  const world: World = { host, store, events, systemPrompts: [] };
  await host.start();
  return world;
}

const USAGE = {
  input: 10,
  output: 12,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 22,
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
      if (events.some((event) => event.type === "run_finished" && event.runId === runId)) {
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

function finishOf(events: PiEvent[], runId: string): Extract<PiEvent, { type: "run_finished" }> {
  const found = events.find(
    (event): event is Extract<PiEvent, { type: "run_finished" }> =>
      event.type === "run_finished" && event.runId === runId,
  );
  if (!found) throw new Error("run_finished introuvable");
  return found;
}

/** Joue un tour complet : extensions (prompt système) puis message persisté. */
function playTurn(world: World, text: string): Promise<string> {
  stub.onPrompt = async (manager: Manager) => {
    // 1) La chaîne d'extensions du tour (comme `before_agent_start` du SDK).
    await runExtensions(world);
    // 2) Le tour lui-même : le SDK persiste le message puis émet ses événements.
    const assistant = assistantMessage(text);
    manager.appendMessage(assistant as never);
    stub.emit({ type: "agent_start" });
    stub.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: text },
    });
    stub.emit({ type: "message_end", message: assistant });
  };
  const handle = world.host.send(world.host.currentSessionId()!, "question");
  return waitForRunFinished(world.events, handle.runId).then(() => handle.runId);
}

/** Rejoue la chaîne RÉELLE des extensions pour le tour courant. */
async function runExtensions(world: World): Promise<void> {
  let prompt = "PROMPT SYSTÈME DE TEST";
  for (const extension of stub.extensions) {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const factory = extension.factory as ((pi: unknown) => void) | undefined;
    if (typeof factory !== "function") continue;
    factory({
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(name, handler);
      },
    });
    const handler = handlers.get("before_agent_start");
    if (!handler) continue;
    const result = (await handler(
      { prompt: "question", systemPrompt: prompt },
      {
        sessionManager: {
          getSessionId: () => (stub.manager as Manager).getSessionId(),
          getBranch: () => (stub.manager as Manager).getBranch(),
        },
      },
    )) as { systemPrompt?: string } | undefined;
    if (result && typeof result.systemPrompt === "string") prompt = result.systemPrompt;
  }
  world.systemPrompts.push(prompt);
}

afterEach(async () => {
  stub.sessionListeners.clear();
  stub.extensions = [];
  stub.manager = undefined;
  stub.onPrompt = undefined;
  for (const host of hosts.splice(0)) await host.stop();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("host réel — l'identifiant des réactions EST celui des statistiques", () => {
  it("`run_finished.entryId` = `parentId` de `yuki.run_metrics` (aucun second identifiant)", async () => {
    const world = await makeWorld();
    const runId = await playTurn(world, "Première réponse.");
    const finished = finishOf(world.events, runId);
    expect(typeof finished.entryId).toBe("string");

    const manager = stub.manager as Manager;
    const file = manager.getSessionFile();
    expect(file).toBeDefined();
    const lines = readFileSync(file!, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const assistantLine = lines.find(
      (entry) => entry.type === "message" && (entry.message as { role?: string }).role === "assistant",
    );
    const metrics = lines.find((entry) => entry.customType === RUN_METRICS_CUSTOM_TYPE);
    expect(assistantLine).toBeDefined();
    expect(metrics?.parentId).toBe(assistantLine!.id);
    // L'identifiant donné aux RÉACTIONS est EXACTEMENT celui-là.
    expect(finished.entryId).toBe(assistantLine!.id);

    // Et `getState` expose cet identifiant sur le message (rechargement /
    // reconnexion) : l'interface peut le renvoyer tel quel.
    const state = world.host.getState(world.host.currentSessionId()!)!;
    const assistant = state.transcript.find((entry) => entry.role === "assistant");
    expect(assistant?.id).toBe(finished.entryId);
  });

  it("deux messages ⇒ deux identifiants DIFFÉRENTS (la réaction ne peut pas glisser)", async () => {
    const world = await makeWorld();
    const first = finishOf(world.events, await playTurn(world, "Réponse A."));
    const second = finishOf(world.events, await playTurn(world, "Réponse B."));
    expect(first.entryId).toBeTruthy();
    expect(second.entryId).toBeTruthy();
    expect(first.entryId).not.toBe(second.entryId);
  });
});

describe("host réel — le modèle VOIT la réaction au tour SUIVANT", () => {
  it("le bloc est injecté dans le prompt système, avec le SENS du groupe", async () => {
    const world = await makeWorld();
    const runId = await playTurn(world, "Une réponse très longue et détaillée.");
    const finished = finishOf(world.events, runId);
    const entryId = finished.entryId!;
    const sessionId = world.host.currentSessionId()!;

    // Premier tour : aucune réaction ⇒ aucun bloc.
    expect(world.systemPrompts[0]).not.toContain(REACTIONS_TAG);

    // L'utilisateur réagit sur CE message précis.
    world.store.set(sessionId, entryId, "trop-long");

    // Tour SUIVANT : le bloc est là, avec le registre, le libellé et l'extrait.
    await playTurn(world, "Deuxième réponse.");
    const prompt = world.systemPrompts[world.systemPrompts.length - 1];
    expect(prompt).toContain(`<${REACTIONS_TAG}>`);
    expect(prompt).toContain("[judgement · 🐢 Trop long]");
    expect(prompt).toContain("Une réponse très longue et détaillée.");
    // Le sens du registre est EXPLIQUÉ (sinon le modèle corrigerait au hasard).
    expect(prompt).toContain("corrige ton COMPORTEMENT");
    expect(prompt).toContain("informe sur le REGISTRE");
    expect(prompt).toContain("MODULE TON TON");
    // Le prompt de base est conservé (aucun écrasement).
    expect(prompt.startsWith("PROMPT SYSTÈME DE TEST")).toBe(true);
  });

  it("une réaction posée sur un AUTRE message ne se rattache pas à celui-ci", async () => {
    const world = await makeWorld();
    const firstRun = finishOf(world.events, await playTurn(world, "Réponse A."));
    const secondRun = finishOf(world.events, await playTurn(world, "Réponse B."));
    const sessionId = world.host.currentSessionId()!;

    // On réagit sur la PREMIÈRE réponse (la plus ancienne).
    world.store.set(sessionId, firstRun.entryId!, "faux");

    await playTurn(world, "Réponse C.");
    const prompt = world.systemPrompts[world.systemPrompts.length - 1];
    // L'extrait est celui du message VISÉ, pas du plus récent.
    expect(prompt).toContain("Réponse A.");
    expect(prompt).not.toContain("Réponse B.");
    expect(prompt).not.toContain("Réponse C.");
    expect(secondRun.entryId).not.toBe(firstRun.entryId);
  });

  it("une HUMEUR est présentée comme un état de l'utilisateur, pas comme un jugement", async () => {
    const world = await makeWorld();
    const runId = await playTurn(world, "Réponse neutre.");
    const sessionId = world.host.currentSessionId()!;
    world.store.set(sessionId, finishOf(world.events, runId).entryId!, "fatigue");

    await playTurn(world, "Réponse suivante.");
    const prompt = world.systemPrompts[world.systemPrompts.length - 1];
    expect(prompt).toContain("[mood · 😴 Fatigué] (état de l'utilisateur, pas un jugement sur un message)");
  });

  it("le bloc reste BORNÉ aux N dernières réactions (le prompt ne gonfle pas)", async () => {
    const world = await makeWorld();
    const sessionId = world.host.currentSessionId()!;
    let lastEntryId = "";
    for (let index = 0; index < 12; index += 1) {
      const runId = await playTurn(world, `Réponse numéro ${index}.`);
      lastEntryId = finishOf(world.events, runId).entryId!;
      world.store.set(sessionId, lastEntryId, "utile");
    }
    await playTurn(world, "Dernière réponse.");
    const prompt = world.systemPrompts[world.systemPrompts.length - 1];
    const items = prompt.split("\n- [").length - 1;
    expect(items).toBe(8);
    // La plus ANCIENNE a été écartée, la plus récente est là.
    expect(prompt).toContain("Réponse numéro 11.");
    expect(prompt).not.toContain("Réponse numéro 0.");
  });
});
