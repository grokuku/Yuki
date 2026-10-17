/**
 * Intégration — DOCTRINE « une seule Yuki » : la mémoire durable est GLOBALE et
 * PARTAGÉE entre les conversations.
 *
 * ⚠️ POURQUOI CE TEST EXISTE : la doctrine du projet est qu'il n'y a qu'UNE
 * Yuki ; les conversations ne sont que des fenêtres. Un fait appris dans la
 * conversation A DOIT donc être rappelé dans la conversation B — y compris si B
 * était DÉJÀ OUVERTE avant l'écriture.
 *
 * ⚠️ CE TEST EXERCE LE CODE RÉEL ET LE VRAI SDK : le VRAI `createSdkPiHost`
 * (SDK Pi réel, extensions inline comprises) et la VRAIE `MemoryService`
 * (store JSONL + index FTS5 + extension de rappel) parlent à un FOURNISSEUR
 * SIMULÉ local (HTTP compatible OpenAI). Il n'y a AUCUN réseau externe :
 *  - les runs de conversation reçoivent une réponse assistant courte ;
 *  - la passe d'extraction mémoire (session éphémère) reçoit le tableau JSON.
 *
 * Le faux fournisseur ENREGISTRE le prompt SYSTÈME de chaque requête : c'est
 * l'observation directe du RAPPEL (le bloc mémoire est injecté dans le prompt
 * système du tour). On prouve ainsi les DEUX moitiés :
 *   1. ÉCRITURE : une ligne apparaît dans `memory.jsonl` après un échange A ;
 *   2. RAPPEL : le fait est présent dans le prompt système de la conversation B.
 */

import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildModelsConfigFrom, type EffectiveLlmConfig } from "../../src/llm/models.js";
import type { ProviderSpec } from "../../src/llm/providers.js";
import {
  MemoryIndex,
  MemoryService,
  MemoryStore,
} from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost, createSdkMemoryExtractor } from "../../src/pi/index.js";
import type { PiEvent } from "../../src/pi/types.js";

/** Fait durable injecté par la passe d'extraction simulée. */
const LEARNED_FACT = "L'utilisateur s'appelle Alice";
const EXTRACTION_REPLY = JSON.stringify([
  { text: LEARNED_FACT, cat: "fait", why: "identité durable de l'utilisateur" },
]);

interface CapturedRequest {
  system: string;
  user: string;
  isExtraction: boolean;
}

interface FakeProvider {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

/** Aplatit un contenu de message (chaîne OU tableau de parts) en texte. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "object" && part !== null) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") return text;
      }
      return "";
    })
    .join("\n");
}

function firstSystem(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return messages
    .filter(
      (m): m is { role?: unknown; content?: unknown } =>
        typeof m === "object" && m !== null,
    )
    .filter((m) => m.role === "system")
    .map((m) => contentText(m.content))
    .join("\n");
}

function lastUser(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  let last = "";
  for (const m of messages) {
    if (
      typeof m === "object" &&
      m !== null &&
      (m as { role?: unknown }).role === "user"
    ) {
      last = contentText((m as { content?: unknown }).content);
    }
  }
  return last;
}

/**
 * Fournisseur OpenAI-compatible minimal. Il renvoie :
 *  - le tableau JSON de souvenirs quand la requête est une passe d'extraction
 *    (son prompt contient « --- ÉCHANGE --- ») ;
 *  - une réponse assistant courte sinon.
 */
async function startFakeProvider(): Promise<FakeProvider> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      let parsed: { messages?: unknown } = {};
      try {
        parsed = JSON.parse(body) as { messages?: unknown };
      } catch {
        parsed = {};
      }
      const system = firstSystem(parsed.messages);
      const user = lastUser(parsed.messages);
      const isExtraction =
        user.includes("--- ÉCHANGE ---") ||
        user.includes("--- CONVERSATION ---") ||
        system.includes("tableau JSON");
      requests.push({ system, user, isExtraction });

      const content = isExtraction ? EXTRACTION_REPLY : "Entendu.";
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "test-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }, null));
      res.write(chunk({ content }, null));
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "test-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env["YUKI_LLM_LIGHT_API_KEY"];
});

function waitForFinish(
  events: PiEvent[],
  runId: string,
  timeoutMs = 20_000,
): Promise<Extract<PiEvent, { type: "run_finished" }>> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const found = events.find(
        (event): event is Extract<PiEvent, { type: "run_finished" }> =>
          event.type === "run_finished" && event.runId === runId,
      );
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`run_finished(${runId}) non reçu dans les temps`));
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** Attend qu'une condition devienne vraie (polling borné). */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8_000,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/** Lit les lignes `add` du journal de mémoire (hors commentaires). */
function memoryTexts(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .flatMap((line) => {
      try {
        const event = JSON.parse(line) as { t?: unknown; text?: unknown };
        return event.t === "add" && typeof event.text === "string"
          ? [event.text]
          : [];
      } catch {
        return [];
      }
    });
}

describe("intégration — mémoire durable PARTAGÉE entre conversations", () => {
  it("un fait appris dans A est ÉCRIT puis RAPPELÉ dans B (B ouverte après)", async () => {
    const provider = await startFakeProvider();
    const root = mkdtempSync(join(tmpdir(), "yuki-mem-shared-"));
    temps.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    const sessionsDir = join(agentDir, "sessions");
    const memoryPath = join(root, "state", "memory.jsonl");
    const indexPath = join(root, "state", "memory-index.sqlite");
    process.env["YUKI_LLM_LIGHT_API_KEY"] = "test-key";

    const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

    // --- VRAIE MemoryService (store global JSONL + index FTS5) --------------
    const store = MemoryStore.open({ path: memoryPath, logger });
    const index = new MemoryIndex({ path: indexPath, logger });
    const memory = new MemoryService({
      store,
      index,
      logger,
      enabled: () => true,
      bounds: () => ({ topK: 5, budgetChars: 8_000, timeoutMs: 400 }),
      extractor: createSdkMemoryExtractor({
        cwd,
        agentDir,
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        modelReference: "llm-light/test-model",
        thinking: "off",
        timeoutMs: () => 5_000,
        logger,
      }),
      maxItemsPerPass: () => 3,
    });
    memory.start();

    const providerSpec: ProviderSpec = {
      id: "llm-light",
      name: "LLM unique (test)",
      baseUrl: provider.url,
      api: "openai-completions",
      keyEnv: "YUKI_LLM_LIGHT_API_KEY",
      maxConcurrentRequests: 4,
    };
    const effective: EffectiveLlmConfig = {
      light: {
        api: providerSpec.api,
        baseUrl: provider.url,
        model: "test-model",
        thinking: "off",
      },
      heavy: {
        api: providerSpec.api,
        baseUrl: provider.url,
        model: "test-model",
        thinking: "off",
      },
    };

    const events: PiEvent[] = [];
    const host = createPiHost({
      agentDir,
      cwd,
      home,
      sessionsDir,
      systemPrompt: readFileSync("config/pi/system-prompt.md", "utf8"),
      settingsSeedPath: "config/pi/settings.json",
      modelsConfig: buildModelsConfigFrom(effective),
      model: "llm-light/test-model",
      thinking: "off",
      llmAvailable: true,
      memory,
      logger,
    });

    try {
      host.subscribeAll((event) => events.push(event));
      await host.start();

      // === Conversation A : un échange mémorable. ==========================
      const sessionA = host.currentSessionId();
      expect(sessionA).toEqual(expect.any(String));
      const runA = host.send(sessionA!, "Je m'appelle Alice, retiens-le.");
      const finishA = await waitForFinish(events, runA.runId);
      expect(finishA.reason).toBe("done");

      // 1) ÉCRITURE : une ligne apparaît dans le journal GLOBAL de mémoire.
      const written = await waitFor(() =>
        memoryTexts(memoryPath).some((text) => text.includes("Alice")),
      );
      expect(written).toBe(true);
      await memory.drain();

      // === Conversation B : NEUVE, ouverte APRÈS l'écriture. ===============
      const stateB = await host.newSession();
      const sessionB = stateB.sessionId;
      expect(sessionB).not.toBe(sessionA);

      const runB = host.send(sessionB!, "Comment je m'appelle ?");
      const finishB = await waitForFinish(events, runB.runId);
      expect(finishB.reason).toBe("done");

      // 2) RAPPEL : le prompt SYSTÈME vu par le fournisseur pour B contient le
      //    bloc de mémoire durable ET le fait appris dans A.
      const bRequest = [...provider.requests]
        .reverse()
        .find((request) => !request.isExtraction && request.user.includes("Comment je m'appelle"));
      expect(bRequest).toBeDefined();
      expect(bRequest!.system).toContain("Mémoire durable de Yuki");
      expect(bRequest!.system).toContain("Alice");
    } finally {
      await host.stop();
      memory.close();
      await provider.close();
    }
  });

  it("un fait appris dans A est RAPPELÉ dans B DÉJÀ OUVERTE avant l'écriture", async () => {
    const provider = await startFakeProvider();
    const root = mkdtempSync(join(tmpdir(), "yuki-mem-open-"));
    temps.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "workspace");
    const home = join(root, "home");
    const sessionsDir = join(agentDir, "sessions");
    const memoryPath = join(root, "state", "memory.jsonl");
    const indexPath = join(root, "state", "memory-index.sqlite");
    process.env["YUKI_LLM_LIGHT_API_KEY"] = "test-key";

    const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
    const store = MemoryStore.open({ path: memoryPath, logger });
    const index = new MemoryIndex({ path: indexPath, logger });
    const memory = new MemoryService({
      store,
      index,
      logger,
      enabled: () => true,
      bounds: () => ({ topK: 5, budgetChars: 8_000, timeoutMs: 400 }),
      extractor: createSdkMemoryExtractor({
        cwd,
        agentDir,
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
        modelReference: "llm-light/test-model",
        thinking: "off",
        timeoutMs: () => 5_000,
        logger,
      }),
      maxItemsPerPass: () => 3,
    });
    memory.start();

    const providerSpec: ProviderSpec = {
      id: "llm-light",
      name: "LLM unique (test)",
      baseUrl: provider.url,
      api: "openai-completions",
      keyEnv: "YUKI_LLM_LIGHT_API_KEY",
      maxConcurrentRequests: 4,
    };
    const effective: EffectiveLlmConfig = {
      light: { api: providerSpec.api, baseUrl: provider.url, model: "test-model", thinking: "off" },
      heavy: { api: providerSpec.api, baseUrl: provider.url, model: "test-model", thinking: "off" },
    };

    const events: PiEvent[] = [];
    const host = createPiHost({
      agentDir,
      cwd,
      home,
      sessionsDir,
      systemPrompt: readFileSync("config/pi/system-prompt.md", "utf8"),
      settingsSeedPath: "config/pi/settings.json",
      modelsConfig: buildModelsConfigFrom(effective),
      model: "llm-light/test-model",
      thinking: "off",
      llmAvailable: true,
      memory,
      logger,
    });

    try {
      host.subscribeAll((event) => events.push(event));
      await host.start();

      // Conversation B est ouverte AVANT toute écriture (session neuve, sans
      // rapport avec A).
      const stateB = await host.newSession();
      const sessionB = stateB.sessionId!;

      // Conversation A écrit un fait durable APRÈS l'ouverture de B.
      const sessionA = host.currentSessionId();
      expect(sessionA).toBe(sessionB);
      // On crée une DEUXIÈME session vivante pour A, sans fermer B.
      const stateA = await host.newSession();
      const sessionAId = stateA.sessionId!;
      expect(sessionAId).not.toBe(sessionB);

      const runA = host.send(sessionAId, "Je m'appelle Alice, retiens-le.");
      await waitForFinish(events, runA.runId);
      const written = await waitFor(() =>
        memoryTexts(memoryPath).some((text) => text.includes("Alice")),
      );
      expect(written).toBe(true);
      await memory.drain();

      // Maintenant on envoie dans B (déjà ouverte) : le rappel doit être FRAIS.
      const runB = host.send(sessionB, "Comment je m'appelle ?");
      await waitForFinish(events, runB.runId);

      const bRequest = [...provider.requests]
        .reverse()
        .find((request) => !request.isExtraction && request.user.includes("Comment je m'appelle"));
      expect(bRequest).toBeDefined();
      expect(bRequest!.system).toContain("Mémoire durable de Yuki");
      expect(bRequest!.system).toContain("Alice");
    } finally {
      await host.stop();
      memory.close();
      await provider.close();
    }
  });
});
