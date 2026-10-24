/**
 * INTÉGRATION — SUPPRESSION DÉFINITIVE d'une conversation (host réel, SDK stubé,
 * `SessionManager` RÉELS).
 *
 * Ce que ce test prouve, sans faire confiance aux commentaires :
 *  - la conversation DISPARAÎT de la liste ET son fichier JSONL est EFFACÉ ;
 *  - la MÉMOIRE DURABLE est INTACTE **octet pour octet** (aucune écriture) ;
 *  - la suppression de la conversation OUVERTE laisse le host SANS conversation
 *    ouverte (état vide), pas dans un état fantôme ;
 *  - un run EN COURS est ARRÊTÉ avant l'effacement (jamais de fil ressuscité) ;
 *  - une cible inconnue est REFUSÉE (message français), rien n'est touché.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PiLogger } from "../../src/pi/types.js";
import type { MemoryPort, MemoryRecallResult } from "../../src/memory/types.js";

/** Le runtime SDK est stubé : on n'exerce QUE le host (pas de modèle). */
vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async (options: {
    sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
  }) => {
    const session = {
      sessionId: options.sessionManager.getSessionId(),
      subscribe: () => () => undefined,
      // Un tour contenant « LENT » RESTE EN VOL (promesse non résolue) : c'est le
      // seul moyen d'observer l'arrêt demandé avant l'effacement.
      prompt: (text?: string) =>
        typeof text === "string" && text.includes("LENT")
          ? new Promise<void>(() => undefined)
          : Promise.resolve(undefined),
      abort: async () => {
        aborts.push(session.sessionId);
      },
      sessionManager: options.sessionManager,
    };
    return {
      session,
      dispose: async () => undefined,
    };
  },
}));

vi.mock("../../src/pi/sdk/model-runtime.js", () => ({
  getSharedModelRuntime: async () => ({}),
  resolveSdkModel: () => undefined,
  resolveSdkThinking: () => undefined,
}));

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { createSdkPiHost } from "../../src/pi/sdk-host.js";
import { MemoryIndex, MemoryService, MemoryStore } from "../../src/memory/index.js";
import { PiHostError } from "../../src/pi/errors.js";
import { createLogger } from "../../src/observability/logger.js";

/** Sessions réellement interrompues (abort du SDK) — observation des tests. */
const aborts: string[] = vi.hoisted(() => [] as string[]);

const noopLogger: PiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-delete-host-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  aborts.length = 0;
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

/** Écrit une session persistée (user + assistant) et renvoie son identifiant. */
function seed(env: Env, user: string, assistant: string): string {
  const manager = SessionManager.create(env.cwd, env.sessionsDir);
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
  return manager.getSessionId();
}

/** Port mémoire OBSERVÉ : aucune écriture, on compte seulement les appels. */
function observedMemory(): MemoryPort & { calls: number } {
  const empty: MemoryRecallResult = {
    block: null,
    enabled: false,
    entries: 0,
    chars: 0,
    durationMs: 0,
  };
  const port = {
    calls: 0,
    recall: async () => empty,
    onTurnEnd: () => undefined,
    onBeforeCompact: () => {
      port.calls += 1;
    },
    onSessionSetAside: () => {
      port.calls += 1;
    },
    onSessionCompact: async () => {
      port.calls += 1;
      return { ran: false, reason: "disabled" as const, added: 0, updated: 0, removed: 0, skipped: 0, chunks: 0 };
    },
  };
  return port;
}

describe("suppression définitive — fichier effacé, MÉMOIRE intacte (host réel)", () => {
  it("la conversation quitte la liste ET son fichier JSONL est supprimé", async () => {
    const env = layout();
    const first = seed(env, "Conversation à jeter : aucune importance.", "D'accord.");
    const second = seed(env, "Conversation à GARDER : elle compte.", "Bien noté.");
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
    });
    await host.start();

    const file = await host.sessionFileFor(first);
    expect(file).toBeTruthy();
    expect(existsSync(file!)).toBe(true);

    await host.deleteSession(first);

    // 1. Le FICHIER n'existe plus.
    expect(existsSync(file!)).toBe(false);
    // 2. La LISTE ne la contient plus (et garde l'autre).
    const ids = (await host.listSessions()).map((info) => info.sessionId);
    expect(ids).not.toContain(first);
    expect(ids).toContain(second);
    await host.stop();
  });

  it("la MÉMOIRE DURABLE est INTACTE octet pour octet (aucune écriture)", async () => {
    const env = layout();
    const sessionId = seed(env, "Mon POTAGER est au fond du jardin.", "Je retiens.");
    const memoryPath = join(env.dir, "memory.jsonl");
    const store = MemoryStore.open({ path: memoryPath, logger: undefined });
    store.add({
      text: "L'utilisateur cultive un potager au fond du jardin",
      cat: "fait",
      why: "aménagement durable du jardin",
      source: "test",
    });
    const before = readFileSync(memoryPath);
    expect(before.length).toBeGreaterThan(0);

    const index = new MemoryIndex({ path: join(env.dir, "memory-index.sqlite") });
    let prompts = 0;
    const service = new MemoryService({
      store,
      index,
      logger: createLogger({ level: "error", sink: () => undefined, secretValues: [] }),
      enabled: () => true,
      bounds: () => ({ topK: 5, budgetChars: 8000, timeoutMs: 100 }),
      extractor: async () => {
        prompts += 1;
        return "[]";
      },
    });
    service.start();
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
      memory: service,
    });
    await host.start();

    await host.deleteSession(sessionId);
    // Laisse tourner un éventuel travail de fond avant de comparer les octets.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await service.drain();

    // ⚠️ ASSERTION DEMANDÉE : le fichier de mémoire est IDENTIQUE octet pour octet.
    expect(readFileSync(memoryPath).equals(before)).toBe(true);
    // Et AUCUNE passe de mémoire n'a été déclenchée par la suppression.
    expect(prompts).toBe(0);
    // Le souvenir est toujours servi par le rappel.
    const recall = await service.recall("potager");
    expect(recall.block).toContain("potager");
    await host.stop();
    service.close();
  });

  it("supprimer la conversation OUVERTE laisse le host SANS conversation (état vide)", async () => {
    const env = layout();
    const first = seed(env, "Ancienne conversation.", "Ok.");
    const second = seed(env, "Conversation RÉCENTE (focalisée).", "Ok.");
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
    });
    await host.start();
    // La session focalisée est « la plus récente » : on ne présume pas laquelle
    // (deux fichiers créés dans la même seconde), on supprime CELLE QUI L'EST.
    const focused = host.currentSessionId();
    expect([first, second]).toContain(focused);
    const survivor = focused === first ? second : first;

    await host.deleteSession(focused!);

    expect(host.currentSessionId()).toBeUndefined();
    expect(host.getState()).toBeUndefined();
    const ids = (await host.listSessions()).map((info) => info.sessionId);
    expect(ids).toEqual([survivor]);
    await host.stop();
  });

  it("arrête le run EN COURS avant d'effacer le fichier", async () => {
    const env = layout();
    const sessionId = seed(env, "Un tour LENT est en cours ici.", "Réponse.");
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
    });
    await host.start();
    // Le tour ne se termine JAMAIS : le run est réellement EN VOL.
    host.send(sessionId, "question LENTE");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.getState(sessionId)?.state).toBe("streaming");
    // La session focalisée est VIVANTE : son run serait réécrit après coup si
    // l'on n'arrêtait pas d'abord (fil fantôme).
    await host.deleteSession(sessionId);
    expect(aborts).toContain(sessionId);
    expect(host.getState(sessionId)).toBeUndefined();
    await host.stop();
  });

  it("cible inconnue ⇒ PiHostError franche, rien n'est modifié", async () => {
    const env = layout();
    const keep = seed(env, "Conversation CONSERVÉE.", "Ok.");
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
    });
    await host.start();
    await expect(host.deleteSession("inconnue-0000")).rejects.toBeInstanceOf(PiHostError);
    await expect(host.deleteSession("inconnue-0000")).rejects.toThrow(/introuvable/i);
    const ids = (await host.listSessions()).map((info) => info.sessionId);
    expect(ids).toContain(keep);
    await host.stop();
  });

  it("sans mémoire branchée : la suppression réussit et ne déclenche aucune passe", async () => {
    const env = layout();
    const memory = observedMemory();
    const sessionId = seed(env, "Conversation sans importance.", "Ok.");
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
    await host.deleteSession(sessionId);
    expect(memory.calls).toBe(0);
    await host.stop();
  });
});
