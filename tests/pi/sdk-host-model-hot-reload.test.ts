/**
 * Rechargement de modèle À CHAUD — `PiHost.applyLlmConfig`.
 *
 * On exerce le VRAI `src/pi/sdk-host.ts` (runtime SDK stubé par `vi.mock`) :
 *   - un changement de modèle (`apply: hot`) prend effet SANS redémarrage : la
 *     conversation INACTIVE est re-ciblée sur le nouveau modèle, et le run
 *     suivant part bien avec ce nouveau modèle ;
 *   - une conversation dont un run est EN VOL n'est PAS cassée : son modèle
 *     reste l'ancien pendant le run, et la bascule n'a lieu qu'entre deux runs ;
 *   - `applyLlmConfig` rafraîchit le runtime de modèles partagé (1 appel).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModelsConfig } from "../../src/llm/index.js";
import type { PiLogger } from "../../src/pi/types.js";

/** Session stubée (clé = sessionId), partagée avec le mock hoisté. */
const stub = vi.hoisted(() => ({
  sessions: new Map<
    string,
    {
      model?: { provider: string; id: string };
      thinkingLevel?: string;
      prompts: Array<{ text: string; model?: { provider: string; id: string } }>;
      listeners: Set<(event: unknown) => void>;
      resolvePrompt?: () => void;
      disposed: boolean;
    }
  >(),
  refreshCount: 0,
}));

vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async (options: {
    sessionManager: { getSessionId(): string };
    model?: { provider: string; id: string };
    thinkingLevel?: string;
  }) => {
    const sessionId = options.sessionManager.getSessionId();
    const entry = {
      model: options.model,
      thinkingLevel: options.thinkingLevel,
      prompts: [] as Array<{ text: string; model?: { provider: string; id: string } }>,
      listeners: new Set<(event: unknown) => void>(),
      resolvePrompt: undefined as undefined | (() => void),
      disposed: false,
    };
    stub.sessions.set(sessionId, entry);
    const session = {
      sessionId,
      get model() {
        return entry.model;
      },
      get thinkingLevel() {
        return entry.thinkingLevel;
      },
      subscribe: (cb: (event: unknown) => void) => {
        entry.listeners.add(cb);
        return () => entry.listeners.delete(cb);
      },
      prompt: async (text: string) => {
        entry.prompts.push({ text, model: entry.model });
        for (const cb of [...entry.listeners]) cb({ type: "agent_start" });
        await new Promise<void>((resolve) => {
          entry.resolvePrompt = resolve;
        });
      },
      setModel: async (model: { provider: string; id: string }) => {
        entry.model = model;
      },
      setThinkingLevel: (level: string) => {
        entry.thinkingLevel = level;
      },
      abort: async () => {
        entry.resolvePrompt?.();
      },
      sessionManager: options.sessionManager,
    };
    return {
      session,
      dispose: async () => {
        entry.disposed = true;
      },
    };
  },
}));

vi.mock("../../src/pi/sdk/model-runtime.js", () => ({
  getSharedModelRuntime: async () => ({}),
  refreshSharedModelRuntime: async () => {
    stub.refreshCount += 1;
    return {};
  },
  resolveSdkModel: (_runtime: unknown, reference: string) => {
    const slash = reference.indexOf("/");
    if (slash <= 0) return undefined;
    return {
      provider: reference.slice(0, slash),
      id: reference.slice(slash + 1),
    };
  },
  resolveSdkThinking: () => "off",
}));

const noopLogger: PiLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const temps: string[] = [];

function makeHost(
  model: string,
  modelsConfig: ModelsConfig,
): ReturnType<typeof createSdkPiHost> {
  const dir = mkdtempSync(join(tmpdir(), "yuki-hot-model-"));
  temps.push(dir);
  return createSdkPiHost({
    agentDir: join(dir, "agent"),
    cwd: dir,
    home: join(dir, "home"),
    sessionsDir: join(dir, "agent", "sessions"),
    systemPrompt: "prompt système de test",
    modelsConfig,
    model,
    thinking: "off",
    logger: noopLogger,
  });
}

function modelsConfig(model: string): ModelsConfig {
  return {
    providers: {
      "llm-light": {
        name: "LL",
        baseUrl: "http://x",
        api: "openai-completions",
        apiKey: "$YUKI_LLM_LIGHT_API_KEY",
        compat: { supportsDeveloperRole: false },
        models: [
          {
            id: model,
            name: model,
            reasoning: false,
            input: ["text"],
            contextWindow: 1,
            maxTokens: 1,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
      "llm-heavy": {
        name: "LH",
        baseUrl: "http://x",
        api: "openai-completions",
        apiKey: "$YUKI_LLM_HEAVY_API_KEY",
        compat: { supportsDeveloperRole: false },
        models: [
          {
            id: model,
            name: model,
            reasoning: false,
            input: ["text"],
            contextWindow: 1,
            maxTokens: 1,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

import { createSdkPiHost } from "../../src/pi/sdk-host.js";

afterEach(() => {
  stub.sessions.clear();
  stub.refreshCount = 0;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PiHost.applyLlmConfig — modèle à chaud", () => {
  it("re-cible une conversation INACTIVE sur le nouveau modèle, sans redémarrage", async () => {
    const host = makeHost("llm-light/model-a", modelsConfig("model-a"));
    await host.start();
    const sid = host.currentSessionId();
    expect(sid).toBeTruthy();
    expect(stub.sessions.get(sid!)?.model?.id).toBe("model-a");

    expect(host.applyLlmConfig).toBeTypeOf("function");
    await host.applyLlmConfig!({
      modelsConfig: modelsConfig("model-b"),
      conversationModel: "llm-light/model-b",
      conversationThinking: "off",
    });
    await tick();

    // Le runtime de modèles partagé a bien été rafraîchi (relecture de models.json).
    expect(stub.refreshCount).toBe(1);
    // La conversation INACTIVE pointe désormais sur le NOUVEAU modèle.
    expect(stub.sessions.get(sid!)?.model?.id).toBe("model-b");

    // Le prochain run part avec le nouveau modèle (aucun redémarrage).
    host.send(sid!, "bonjour");
    stub.sessions.get(sid!)?.resolvePrompt?.();
    expect(stub.sessions.get(sid!)?.prompts.at(-1)?.model?.id).toBe("model-b");
    await host.stop();
  });

  it("NE CASSE PAS un run EN VOL : bascule seulement entre deux runs", async () => {
    const host = makeHost("llm-light/model-a", modelsConfig("model-a"));
    await host.start();
    const sid = host.currentSessionId()!;

    // Run 1 : reste EN VOL.
    host.send(sid, "un");
    expect(host.getState(sid)?.state).toBe("streaming");

    // Changement de modèle PENDANT le run.
    await host.applyLlmConfig!({
      modelsConfig: modelsConfig("model-b"),
      conversationModel: "llm-light/model-b",
      conversationThinking: "off",
    });
    await tick();

    // Le run EN VOL garde son modèle d'origine (aucune bascule au milieu d'un tour).
    expect(stub.sessions.get(sid)?.model?.id).toBe("model-a");

    // Fin du run 1.
    stub.sessions.get(sid)?.resolvePrompt?.();
    await tick();
    expect(host.getState(sid)?.state).toBe("idle");

    // Run 2 : la bascule a eu lieu entre les deux runs (appliquée AVANT le prompt).
    host.send(sid, "deux");
    await tick();
    expect(stub.sessions.get(sid)?.prompts.at(-1)?.model?.id).toBe("model-b");
    stub.sessions.get(sid)?.resolvePrompt?.();
    await host.stop();
  });
});
