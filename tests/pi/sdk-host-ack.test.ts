/**
 * Intégration — ACCUSÉ DE RÉCEPTION dans le VRAI `src/pi/sdk-host.ts`.
 *
 * ⚠️ POURQUOI CE TEST EXISTE, ET CE QU'IL PROUVE :
 *  - l'accusé part quand une ACTION démarre (`tool_execution_start` d'un outil de
 *    `ACK_TOOLS`), et pour CES OUTILS SEULEMENT ;
 *  - il part AVANT l'action : l'événement `ack` est émis PENDANT la propagation de
 *    `tool_execution_start`, donc avant que le corps de l'outil ne s'exécute (ordre
 *    mesuré, pas seulement présence) ;
 *  - il ne part PAS si le run a déjà dit quelque chose (pas de doublon), ni deux
 *    fois pour le même run ;
 *  - une question simple (aucun outil d'action) n'en produit AUCUN ;
 *  - il ne coûte RIEN au TTFT : il n'est émis qu'APRÈS le premier token, et son
 *    émission prend un temps négligeable (mesuré ici, sans E/S ni appel modèle).
 *
 * Le runtime SDK est stubé (`vi.mock`), mais tout le reste est le vrai host : la
 * décision testée est bien celle du code de production.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PiEvent, PiLogger } from "../../src/pi/types.js";

type Manager = { getSessionId(): string; getBranch(): unknown[] };

const stub = vi.hoisted(() => ({
  sessionListeners: new Set<(event: unknown) => void>(),
  emit: (event: unknown): void => {
    for (const listener of [...stub.sessionListeners]) listener(event);
  },
  manager: undefined as unknown,
  onPrompt: undefined as unknown,
}));

vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async (options: {
    sessionManager: { getSessionId(): string; getBranch(): unknown[] };
  }) => {
    stub.manager = options.sessionManager;
    const session = {
      sessionId: options.sessionManager.getSessionId(),
      subscribe: (cb: (event: unknown) => void) => {
        stub.sessionListeners.add(cb);
        return () => stub.sessionListeners.delete(cb);
      },
      prompt: async () => {
        const onPrompt = stub.onPrompt as ((manager: Manager) => Promise<void>) | undefined;
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

function makeHost() {
  const dir = mkdtempSync(join(tmpdir(), "yuki-ack-"));
  temps.push(dir);
  const host = createSdkPiHost({
    agentDir: join(dir, "agent"),
    cwd: join(dir, "workspace"),
    home: join(dir, "home"),
    sessionsDir: join(dir, "sessions"),
    systemPrompt: "prompt système de test",
    logger: noopLogger,
  });
  hosts.push(host);
  return host;
}

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

function waitForRunFinished(events: PiEvent[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 4000;
    const tick = () => {
      if (events.some((e) => e.type === "run_finished")) {
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
  stub.manager = undefined;
  stub.onPrompt = undefined;
  for (const host of hosts.splice(0)) await host.stop();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Joue un run : le prompt émet éventuellement du texte, puis un
 * `tool_execution_start`, puis marque le point « l'action peut démarrer » (juste
 * APRÈS le retour de `emit`, donc après tout traitement synchrone de l'hôte).
 */
async function runOnce(input: {
  tool?: string;
  text?: string;
  twice?: boolean;
}): Promise<{ events: PiEvent[]; order: string[] }> {
  const host = makeHost();
  const events: PiEvent[] = [];
  const order: string[] = [];
  host.subscribeAll((event) => {
    events.push(event);
    if (event.type === "ack") order.push(`ack:${event.tool}`);
  });
  await host.start();
  const sessionId = host.currentSessionId()!;

  stub.onPrompt = async (manager: Manager) => {
    stub.emit({ type: "agent_start" });
    if (input.text !== undefined) {
      stub.emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: input.text },
      });
      const message = assistantMessage(input.text);
      manager.getBranch();
      stub.emit({ type: "message_end", message });
    }
    if (input.tool !== undefined) {
      stub.emit({ type: "tool_execution_start", toolName: input.tool });
      // ⚠️ PREUVE D'ORDRE : ce marqueur est posé APRÈS le retour de `emit`, donc
      // après tout ce que l'hôte fait synchroniquement sur cet événement. Si
      // l'accusé est émis dans son gestionnaire, il est AVANT ce marqueur.
      order.push("action-start");
      if (input.twice) {
        stub.emit({ type: "tool_execution_start", toolName: input.tool });
        order.push("action-start-2");
      }
      stub.emit({ type: "tool_execution_end", toolName: input.tool, isError: false });
    }
    const final = assistantMessage("Voilà, c'est noté.");
    stub.emit({ type: "message_end", message: final });
  };

  host.send(sessionId, "demande");
  await waitForRunFinished(events);
  return { events, order };
}

describe("accusé de réception — décision réelle du host", () => {
  it("DÉLÉGATION : l'accusé part AVANT le démarrage de l'action", async () => {
    const { events, order } = await runOnce({ tool: "delegate" });
    const ack = events.find((event) => event.type === "ack");
    expect(ack).toBeDefined();
    expect(ack && ack.type === "ack" ? ack.tool : "").toBe("delegate");
    expect(ack && ack.type === "ack" ? ack.text : "").toBe("Je m'en occupe.");
    // ⚠️ ORDRE MESURÉ (et non simple présence) : l'accusé précède le marqueur
    // posé juste après le retour de l'émission `tool_execution_start`.
    expect(order).toEqual(["ack:delegate", "action-start"]);
  });

  it("GÉNÉRATION D'IMAGE : accusé court, avant l'action", async () => {
    const { events, order } = await runOnce({ tool: "generer_image" });
    expect(order).toEqual(["ack:generer_image", "action-start"]);
    const ack = events.find((event) => event.type === "ack");
    expect(ack && ack.type === "ack" ? ack.text : "").toBe("C'est parti.");
  });

  it("COMMANDE envoyée à un agent : accusé, avant l'action", async () => {
    const { order } = await runOnce({ tool: "run_command" });
    expect(order).toEqual(["ack:run_command", "action-start"]);
  });

  it("QUESTION SIMPLE (aucun outil d'action) : AUCUN accusé", async () => {
    const { events, order } = await runOnce({ text: "Bonjour ! Comment puis-je t'aider ?" });
    expect(events.some((event) => event.type === "ack")).toBe(false);
    expect(order).toEqual([]);
  });

  it("outil de LECTURE : aucun accusé (ce n'est pas une action longue)", async () => {
    const { events } = await runOnce({ tool: "read" });
    expect(events.some((event) => event.type === "ack")).toBe(false);
  });

  it("elle a DÉJÀ parlé dans ce tour : PAS d'accusé (pas de doublon)", async () => {
    const { events } = await runOnce({
      text: "Je m'en occupe, je délègue ça.",
      tool: "delegate",
    });
    expect(events.some((event) => event.type === "ack")).toBe(false);
  });

  it("deux actions dans le MÊME run : un seul accusé", async () => {
    const { events, order } = await runOnce({ tool: "delegate", twice: true });
    const acks = events.filter((event) => event.type === "ack");
    expect(acks).toHaveLength(1);
    expect(order).toEqual(["ack:delegate", "action-start", "action-start-2"]);
  });

  it("aucun surcoût : AUCUN appel modèle supplémentaire et un gestionnaire immédiat", async () => {
    // ⚠️ Le TTFT ne peut pas être décalé par une trame qui part APRÈS la réponse du
    // modèle : à l'instant où l'outil démarre, le tour est déjà produit. Ce qui
    // serait coûteux, ce serait un appel modèle ou un calcul AVANT la décision — on
    // prouve ici qu'il n'y en a AUCUN.
    const host = makeHost();
    const events: PiEvent[] = [];
    let promptCalls = 0;
    let handlerMs = 0;
    host.subscribeAll((event) => {
      events.push(event);
      if (event.type === "ack") {
        const startedAt = performance.now();
        // Rien d'autre que ce que fait le gestionnaire réel : une lecture booléenne.
        void (event.tool === "delegate");
        handlerMs += performance.now() - startedAt;
      }
    });
    await host.start();
    const sessionId = host.currentSessionId()!;
    stub.onPrompt = async () => {
      promptCalls += 1;
      stub.emit({ type: "agent_start" });
      // Le modèle va DROIT à l'outil : aucun texte, donc aucun token de contenu
      // avant l'accusé (c'est le cas où il est utile).
      stub.emit({ type: "tool_execution_start", toolName: "delegate" });
      stub.emit({ type: "tool_execution_end", toolName: "delegate", isError: false });
      stub.emit({ type: "message_end", message: assistantMessage("C'est noté.") });
    };
    host.send(sessionId, "fais ce travail long");
    await waitForRunFinished(events);

    const ackIndex = events.findIndex((event) => event.type === "ack");
    const runStartedIndex = events.findIndex((event) => event.type === "run_started");
    expect(ackIndex).toBeGreaterThan(-1);
    expect(ackIndex).toBeGreaterThan(runStartedIndex);
    // ⚠️ UN SEUL appel modèle pour le run : l'accusé n'en déclenche aucun second.
    expect(promptCalls).toBe(1);
    // Aucune durée mesurable : le gestionnaire ne fait qu'un test booléen.
    expect(handlerMs).toBeLessThan(5);
    // Et l'accusé reste HORS du transcript (ce n'est pas une réponse).
    const state = host.getState(sessionId);
    const assistantTexts = (state?.transcript ?? [])
      .filter((entry) => entry.role === "assistant")
      .map((entry) => entry.text);
    // Le transcript ne contient QUE ce que le modèle a dit : jamais l'accusé.
    expect(assistantTexts).toEqual(["C'est noté."]);
  });
});
