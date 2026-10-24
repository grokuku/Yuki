/**
 * INTÉGRATION — COMPACTION FORCÉE (`compactSession`) : ORDRE passe de mémoire →
 * compaction, et compte rendu honnête.
 *
 * On exerce le VRAI `src/pi/sdk-host.ts` avec des `SessionManager` RÉELS et un
 * runtime SDK stubé dont la méthode `compact()` est OBSERVÉE : c'est la SEULE
 * façon de prouver l'ORDRE sans modèle.
 *
 * Ce que ce test prouve :
 *  - la PASSE DE MÉMOIRE (attendue) se TERMINE avant l'appel à `compact()` ;
 *  - un ÉCHEC de la passe ne bloque PAS la compaction (et le dit) ;
 *  - une conversation vide est REFUSÉE avec un message clair, sans passe ni
 *    compaction (jamais un succès vide) ;
 *  - une conversation NON VIVANTE est ouverte SANS voler le focus ;
 *  - les échecs du moteur sont TRADUITS (aucun message anglais) ;
 *  - la progression annonce `memory` puis `compact`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { CompactProgress, PiLogger } from "../../src/pi/types.js";
import type { MemoryPort, MemoryRecallResult } from "../../src/memory/types.js";

/** Journal partagé (ordre des opérations) + réglage d'échec du moteur. */
const shared = vi.hoisted(() => ({
  log: [] as string[],
  /** Message d'échec à lever depuis `compact()` (vide : succès). */
  failWith: "",
}));

vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async (options: {
    sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
  }) => {
    const session = {
      sessionId: options.sessionManager.getSessionId(),
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      sessionManager: options.sessionManager,
      /**
       * Compaction RÉELLE du moteur remplacée par une doublure OBSERVÉE : on ne
       * teste pas le SDK ici (c'est le rôle du test d'intégration dédié), on
       * teste l'ORDRE et le compte rendu du host.
       */
      compact: async () => {
        shared.log.push("compact");
        if (shared.failWith.length > 0) {
          const message = shared.failWith;
          shared.failWith = "";
          throw new Error(message);
        }
        return {
          summary: "résumé de test",
          firstKeptEntryId: "entry-1",
          tokensBefore: 12_000,
          estimatedTokensAfter: 2_000,
        };
      },
    };
    return { session, dispose: async () => undefined };
  },
}));

vi.mock("../../src/pi/sdk/model-runtime.js", () => ({
  getSharedModelRuntime: async () => ({}),
  resolveSdkModel: () => undefined,
  resolveSdkThinking: () => undefined,
}));

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createSdkPiHost } from "../../src/pi/sdk-host.js";
import { PiHostError } from "../../src/pi/errors.js";

const noopLogger: PiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-compact-host-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  shared.log.length = 0;
  shared.failWith = "";
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Env {
  dir: string;
  cwd: string;
  sessionsDir: string;
  agentDir: string;
}

function layout(): Env {
  const dir = tempDir();
  return {
    dir,
    cwd: join(dir, "workspace"),
    sessionsDir: join(dir, "sessions"),
    agentDir: join(dir, "agent"),
  };
}

function appendExchange(manager: SessionManager, user: string, assistant: string): void {
  manager.appendMessage({ role: "user", content: user, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: assistant }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

function seed(env: Env, user: string, assistant: string): string {
  const manager = SessionManager.create(env.cwd, env.sessionsDir);
  appendExchange(manager, user, assistant);
  return manager.getSessionId();
}

/** Port mémoire OBSERVÉ : journalise l'ordre, configurable en échec. */
function memoryPort(options: { delayMs?: number; fail?: boolean } = {}) {
  const empty: MemoryRecallResult = {
    block: null,
    enabled: false,
    entries: 0,
    chars: 0,
    durationMs: 0,
  };
  const seen: Array<{ sessionId: string; messages: number; title: string }> = [];
  const port: MemoryPort & { seen: typeof seen } = {
    seen,
    recall: async () => empty,
    onTurnEnd: () => undefined,
    onBeforeCompact: () => undefined,
    onSessionCompact: async (input) => {
      shared.log.push("memory:start");
      seen.push({
        sessionId: input.sessionId,
        messages: input.messages.length,
        title: input.title,
      });
      if (options.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      shared.log.push("memory:end");
      if (options.fail) throw new Error("panne simulée de la passe");
      return {
        ran: true,
        added: 2,
        updated: 1,
        removed: 0,
        skipped: 3,
        chunks: 1,
      };
    },
  };
  return port;
}

describe("compaction forcée — passe de mémoire AVANT la compaction (host réel)", () => {
  it("TERMINE la passe de mémoire avant d'appeler la compaction (ordre prouvé)", async () => {
    const env = layout();
    const sessionId = seed(env, "Mon POTAGER est au fond du jardin.", "Je retiens l'emplacement.");
    const memory = memoryPort({ delayMs: 30 });
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
      memory,
    });
    await host.start();

    const phases: string[] = [];
    const outcome = await host.compactSession(sessionId, {
      onProgress: (progress: CompactProgress) => {
        phases.push(
          progress.phase +
            (progress.part !== undefined ? `:${progress.part}/${progress.parts}` : ""),
        );
      },
    });

    // ⚠️ L'ORDRE est l'exigence utilisateur : la passe se TERMINE avant la compaction.
    expect(shared.log).toEqual(["memory:start", "memory:end", "compact"]);
    expect(phases).toEqual(["memory", "compact"]);
    // La passe a reçu la conversation ENTIÈRE (les deux messages).
    expect(memory.seen[0]?.sessionId).toBe(sessionId);
    expect(memory.seen[0]?.messages).toBe(2);
    expect(memory.seen[0]?.title.length).toBeGreaterThan(0);
    // Compte rendu RÉEL (rien d'inventé) : mémoire + mesures du moteur.
    expect(outcome.memory.ran).toBe(true);
    expect(outcome.memory.added).toBe(2);
    expect(outcome.memory.updated).toBe(1);
    expect(outcome.memory.skipped).toBe(3);
    expect(outcome.tokensBefore).toBe(12_000);
    expect(outcome.tokensAfter).toBe(2_000);
    await host.stop();
  });

  it("un ÉCHEC de la passe ne bloque PAS la compaction, et le résultat le DIT", async () => {
    const env = layout();
    const sessionId = seed(env, "Conversation quelconque.", "Réponse.");
    const memory = memoryPort({ fail: true });
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
      memory,
    });
    await host.start();

    const outcome = await host.compactSession(sessionId);
    // La compaction a bien eu lieu APRÈS l'échec (la mémoire n'est pas bloquante).
    expect(shared.log).toEqual(["memory:start", "memory:end", "compact"]);
    expect(outcome.memory.ran).toBe(false);
    expect(outcome.memory.reason).toBe("failed");
    expect(outcome.memory.error).toContain("panne simulée");
    expect(outcome.tokensBefore).toBe(12_000);
    await host.stop();
  });

  it("conversation VIDE / trop courte ⇒ refus CLAIR, aucune passe, aucune compaction", async () => {
    const env = layout();
    const memory = memoryPort();
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
      memory,
    });
    await host.start();
    // Conversation NEUVE (vivante, zéro message) : c'est le cas d'un fil vide.
    const state = await host.newSession();
    const emptyId = state.sessionId;

    await expect(host.compactSession(emptyId)).rejects.toBeInstanceOf(PiHostError);
    await expect(host.compactSession(emptyId)).rejects.toThrow(/vide ou trop courte/i);
    expect(shared.log).toEqual([]);
    expect(memory.seen).toEqual([]);
    await host.stop();
  });

  it("compacte une conversation NON VIVANTE sans voler le focus", async () => {
    const env = layout();
    const first = seed(env, "Conversation ANCIENNE (à compacter).", "Ok.");
    const second = seed(env, "Conversation RÉCENTE (focalisée).", "Ok.");
    const memory = memoryPort();
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
      memory,
    });
    await host.start();
    const focused = host.currentSessionId();
    const target = focused === first ? second : first;
    expect(target).not.toBe(focused);

    const outcome = await host.compactSession(target);
    expect(outcome.memory.ran).toBe(true);
    // ⚠️ Aucun vol de focus : l'utilisateur reste sur sa conversation ouverte.
    expect(host.currentSessionId()).toBe(focused);
    expect(memory.seen[0]?.sessionId).toBe(target);
    await host.stop();
  });

  it("TRADUIT les échecs du moteur (aucun message anglais ne sort)", async () => {
    const env = layout();
    const sessionId = seed(env, "Conversation courte.", "Ok.");
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
    });
    await host.start();

    shared.failWith = "Nothing to compact (session too small)";
    await expect(host.compactSession(sessionId)).rejects.toThrow(/trop courte/i);

    shared.failWith = "Already compacted";
    await expect(host.compactSession(sessionId)).rejects.toThrow(/rien de plus à compacter/i);

    shared.failWith = "No model selected";
    await expect(host.compactSession(sessionId)).rejects.toMatchObject({
      code: "LLM_UNAVAILABLE",
    });

    shared.failWith = "Compaction failed: rate limit atteint";
    await expect(host.compactSession(sessionId)).rejects.toThrow(/rate limit atteint/);
    await host.stop();
  });

  it("sans port de mémoire : la compaction a lieu et le dit (`unsupported`)", async () => {
    const env = layout();
    const sessionId = seed(env, "Conversation normale.", "Réponse.");
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
    });
    await host.start();

    const outcome = await host.compactSession(sessionId);
    expect(shared.log).toEqual(["compact"]);
    expect(outcome.memory.ran).toBe(false);
    expect(outcome.memory.reason).toBe("unsupported");
    await host.stop();
  });
});
