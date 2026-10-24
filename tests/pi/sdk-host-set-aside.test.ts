/**
 * INTÉGRATION — MISE DE CÔTÉ d'une conversation : ARCHIVE COMPLÈTE + PASSE DE
 * MÉMOIRE, en tâche de fond.
 *
 * On exerce le VRAI `src/pi/sdk-host.ts` (runtime SDK stubé, `SessionManager`
 * RÉELS) avec un port d'archive RÉEL (fichiers + index FTS5 en dossier temporaire)
 * et un port de mémoire OBSERVÉ.
 *
 * Ce que ce test prouve :
 *  - la conversation est ARCHIVÉE EN ENTIER (tous les messages, horodatages,
 *    rôles, titre) ;
 *  - la passe de mémoire est DÉCLENCHÉE avec la conversation entière ;
 *  - la mise de côté est IMMÉDIATE : elle rend la main AVANT la fin de la passe
 *    (extractor qui ne répond jamais) et réussit MÊME si la passe échoue ;
 *  - IDEMPOTENT : une conversation déjà archivée ne relance pas de passe.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PiLogger } from "../../src/pi/types.js";
import type {
  SessionSetAsideInput,
  TurnEndInput,
  BeforeCompactInput,
  MemoryPort,
  MemoryRecallResult,
} from "../../src/memory/types.js";

/** Outils custom réellement transmis au SDK (capturés par le stub). */
const captured = vi.hoisted(() => ({ toolNames: [] as string[][] }));

/** Le runtime SDK est stubé : on n'exerce QUE le host (pas de modèle). */
vi.mock("../../src/pi/sdk/session-factory.js", () => ({
  createLightRuntime: async (options: {
    sessionManager: unknown;
    customTools?: readonly { name?: string }[];
  }) => {
    captured.toolNames.push(
      (options.customTools ?? []).map((tool) => String(tool.name ?? "")),
    );
    const session = {
      sessionId: (options.sessionManager as { getSessionId(): string }).getSessionId(),
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
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
import { ConversationArchiveStore, parseArchivedConversation } from "../../src/memory/index.js";
import { MemoryIndex, MemoryService, MemoryStore } from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

const noopLogger: PiLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-setaside-host-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  captured.toolNames.length = 0;
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

function archiveStore(dir: string): ConversationArchiveStore {
  return new ConversationArchiveStore({
    dir: join(dir, "conversations-archive"),
    indexPath: join(dir, "conversations-archive-index.sqlite"),
    logger: createLogger({ level: "error", sink: () => undefined, secretValues: [] }),
  });
}

/** Port mémoire OBSERVÉ (aucune écriture réelle). */
function observedMemory(): MemoryPort & { calls: SessionSetAsideInput[] } {
  const calls: SessionSetAsideInput[] = [];
  const empty: MemoryRecallResult = {
    block: null,
    enabled: false,
    entries: 0,
    chars: 0,
    durationMs: 0,
  };
  return {
    calls,
    recall: async () => empty,
    onTurnEnd: (_input: TurnEndInput) => undefined,
    onBeforeCompact: (_input: BeforeCompactInput) => undefined,
    onSessionSetAside: (input: SessionSetAsideInput) => {
      calls.push(input);
    },
  };
}

/** Attend qu'une condition devienne vraie (bornée). */
async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`condition non atteinte : ${label}`);
}

describe("mise de côté — archive complète + passe de mémoire (host réel)", () => {
  it("archive la conversation ENTIÈRE et déclenche la passe sur TOUS ses messages", async () => {
    const env = layout();
    const sessionId = seed(env, "Souviens-toi du potager au fond du jardin.", "C'est noté.");
    const memory = observedMemory();
    const archive = archiveStore(env.dir);
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
      memory,
      conversationArchive: archive,
    });
    await host.start();

    await host.setAsideSession(sessionId);

    // 1. ARCHIVE COMPLÈTE : le fichier apparaît, avec TOUS les messages.
    const files = readdirSync(join(env.dir, "conversations-archive")).filter((n) =>
      n.endsWith(".json"),
    );
    expect(files).toHaveLength(1);
    const archived = parseArchivedConversation(
      readFileSync(join(env.dir, "conversations-archive", files[0]!), "utf8"),
    );
    expect(archived?.id).toBe(sessionId);
    expect(archived?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(archived?.messages[0]?.text).toBe("Souviens-toi du potager au fond du jardin.");
    expect(archived?.messages[1]?.text).toBe("C'est noté.");
    expect(archived?.messages[0]?.at).toBeTruthy();

    // 2. PASSE DE MÉMOIRE : déclenchée avec la conversation entière.
    await waitFor(() => memory.calls.length === 1, "passe de mémoire");
    expect(memory.calls[0]?.sessionId).toBe(sessionId);
    expect(memory.calls[0]?.messages).toHaveLength(2);
    expect(memory.calls[0]?.messages[0]?.text).toContain("potager");
    expect(memory.calls[0]?.title.length).toBeGreaterThan(0);

    // 3. L'OUTIL de recherche d'archive est bien TRANSMIS au SDK (allowlist +
    //    `customTools` : sans lui, le modèle n'aurait aucun moyen de consulter).
    expect(captured.toolNames.some((names) => names.includes("chercher_conversations_archivees"))).toBe(
      true,
    );

    // 4. La conversation a bien quitté la liste (mise de côté effective).
    expect((await host.listSessions()).some((info) => info.sessionId === sessionId)).toBe(false);
    await host.stop();
    archive.close();
  });

  it("est IMMÉDIATE : elle rend la main AVANT la fin de la passe (extractor muet)", async () => {
    const env = layout();
    const sessionId = seed(env, "Un message utilisateur assez long.", "Une réponse courte.");
    const store = MemoryStore.open({ path: join(env.dir, "memory.jsonl"), logger: undefined });
    const index = new MemoryIndex({ path: join(env.dir, "memory-index.sqlite") });
    let prompts = 0;
    const service = new MemoryService({
      store,
      index,
      logger: createLogger({ level: "error", sink: () => undefined, secretValues: [] }),
      enabled: () => true,
      bounds: () => ({ topK: 5, budgetChars: 8000, timeoutMs: 100 }),
      // Extractor qui ne répond JAMAIS : si la mise de côté attendait la passe,
      // elle ne rendrait jamais la main.
      extractor: () => {
        prompts += 1;
        return new Promise<string>(() => undefined);
      },
    });
    service.start();
    const archive = archiveStore(env.dir);
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
      memory: service,
      conversationArchive: archive,
    });
    await host.start();

    // Aucun `await` de la passe : la mise de côté doit revenir tout de suite.
    await host.setAsideSession(sessionId);
    expect((await host.listSessions()).some((info) => info.sessionId === sessionId)).toBe(false);
    // …et la passe, elle, a bien été LANCÉE derrière.
    await waitFor(() => prompts === 1, "extractor appelé en arrière-plan");
    await host.stop();
    service.close();
    archive.close();
  });

  it("réussit MÊME si la passe de mémoire ÉCHOUE (échec silencieux, journalisé)", async () => {
    const env = layout();
    const sessionId = seed(env, "Une phrase utilisateur.", "Une réponse.");
    const memory: MemoryPort = {
      recall: async () => ({ block: null, enabled: false, entries: 0, chars: 0, durationMs: 0 }),
      onTurnEnd: () => undefined,
      onBeforeCompact: () => undefined,
      onSessionSetAside: () => {
        throw new Error("panne simulée de la passe");
      },
    };
    const archive = archiveStore(env.dir);
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
      memory,
      conversationArchive: archive,
    });
    await host.start();

    // Aucune exception ne remonte à l'appelant.
    await expect(host.setAsideSession(sessionId)).resolves.toBeUndefined();
    expect((await host.listSessions()).some((info) => info.sessionId === sessionId)).toBe(false);
    // L'archive, elle, a bien été écrite (l'échec de la passe ne la concerne pas).
    await waitFor(
      () =>
        readdirSync(join(env.dir, "conversations-archive")).some((n) => n.endsWith(".json")),
      "archive écrite malgré la panne",
    );
    await host.stop();
    archive.close();
  });

  it("IDEMPOTENT : une conversation DÉJÀ archivée ne relance pas la passe", async () => {
    const env = layout();
    const sessionId = seed(env, "Une phrase utilisateur.", "Une réponse.");
    const archive = archiveStore(env.dir);
    // Pré-archive (comme un précédent passage) : même identifiant.
    archive.archiveConversation({
      id: sessionId,
      title: "déjà archivée",
      messages: [{ at: "2026-10-20T10:00:00.000Z", role: "user", text: "déjà là" }],
    });
    const memory = observedMemory();
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
      memory,
      conversationArchive: archive,
    });
    await host.start();

    await host.setAsideSession(sessionId);
    // Laisse tourner l'arrière-plan avant de conclure à l'absence de passe.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(memory.calls).toHaveLength(0);
    // Le fichier d'archive d'origine n'a pas été réécrit.
    const files = readdirSync(join(env.dir, "conversations-archive")).filter((n) =>
      n.endsWith(".json"),
    );
    expect(files).toHaveLength(1);
    expect(
      parseArchivedConversation(
        readFileSync(join(env.dir, "conversations-archive", files[0]!), "utf8"),
      )?.title,
    ).toBe("déjà archivée");
    await host.stop();
    archive.close();
  });

  it("archive aussi une conversation NON VIVANTE (relue depuis son JSONL)", async () => {
    const env = layout();
    const first = seed(env, "Conversation ANCIENNE : on parle du toit.", "Réponse ancienne.");
    const second = seed(env, "Conversation RÉCENTE.", "Réponse récente.");
    const texts = new Map([
      [first, ["Conversation ANCIENNE : on parle du toit.", "Réponse ancienne."]],
      [second, ["Conversation RÉCENTE.", "Réponse récente."]],
    ]);
    const memory = observedMemory();
    const archive = archiveStore(env.dir);
    const host = createSdkPiHost({
      agentDir: env.agentDir,
      cwd: env.cwd,
      home: join(env.dir, "home"),
      sessionsDir: env.sessionsDir,
      systemPrompt: "prompt de test",
      logger: noopLogger,
      memory,
      conversationArchive: archive,
    });
    await host.start();
    // Le host focalise la session la plus récente : on met de côté l'AUTRE
    // (donc une session NON VIVANTE, relue depuis son JSONL).
    const focused = host.currentSessionId();
    const target = focused === first ? second : first;
    expect(target).not.toBe(focused);

    await host.setAsideSession(target);
    await waitFor(() => memory.calls.length === 1, "passe sur la conversation non vivante");
    expect(memory.calls[0]?.sessionId).toBe(target);
    expect(memory.calls[0]?.messages.map((message) => message.text)).toEqual(texts.get(target));
    const files = readdirSync(join(env.dir, "conversations-archive")).filter((n) =>
      n.endsWith(".json"),
    );
    expect(files).toHaveLength(1);
    const archived = parseArchivedConversation(
      readFileSync(join(env.dir, "conversations-archive", files[0]!), "utf8"),
    );
    expect(archived?.id).toBe(target);
    expect(archived?.messages.map((message) => message.text)).toEqual(texts.get(target));
    await host.stop();
    archive.close();
  });

  it("sans port d'archive : la mise de côté reste possible (aucune dépendance dure)", async () => {
    const env = layout();
    const sessionId = seed(env, "Une phrase utilisateur.", "Une réponse.");
    const memory = observedMemory();
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
    // Sans port d'archive : l'outil de recherche N'EST PAS transmis.
    expect(
      captured.toolNames.every((names) => !names.includes("chercher_conversations_archivees")),
    ).toBe(true);
    await host.setAsideSession(sessionId);
    await waitFor(() => memory.calls.length === 1, "passe malgré l'absence d'archive");
    expect(existsSync(join(env.dir, "conversations-archive"))).toBe(false);
    await host.stop();
  });
});
