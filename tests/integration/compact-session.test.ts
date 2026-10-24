/**
 * INTÉGRATION — COMPACTION FORCÉE avec le SDK Pi RÉEL et un fournisseur
 * OpenAI-compatible SIMULÉ (HTTP local, aucun réseau externe, aucun coût).
 *
 * Ce fichier répond à la seule question qui décide de la fonctionnalité :
 * **le moteur sait-il compacter À LA DEMANDE ?** Oui — `AgentSession.compact()`
 * (`@earendil-works/pi-coding-agent`, `dist/core/agent-session.d.ts`), le même
 * chemin que `/compact` et le mode RPC `{"type":"compact"}`.
 *
 * Ce qui est PROUVÉ ici, sur le vrai SDK :
 *  1. après `compactSession()`, le JSONL de la conversation contient une entrée
 *     `compaction` (résumé + `tokensBefore`) ⇒ le fil est RÉELLEMENT compacté ;
 *  2. la PASSE DE MÉMOIRE se TERMINE avant la requête de summarisation (ordre
 *     prouvé par les compteurs du faux fournisseur) ;
 *  3. la consolidation « avant compaction » du moteur (`session_before_compact`)
 *     s'exécute APRÈS la passe de remplissage ;
 *  4. une conversation réellement compactée REFUSE d'être recompactée (message
 *     français, pas un succès vide).
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPiHost } from "../../src/pi/host.js";
import { buildModelsConfigFrom, type EffectiveLlmConfig } from "../../src/llm/models.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { MemoryPort, MemoryRecallResult } from "../../src/memory/types.js";
import { createLogger } from "../../src/observability/logger.js";

/** Fournisseur OpenAI-compatible minimal (SSE), qui compte les requêtes. */
interface FakeProvider {
  readonly url: string;
  requests(): number;
  close(): Promise<void>;
}

async function startFakeProvider(): Promise<FakeProvider> {
  let count = 0;
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    count += 1;
    req.on("data", () => {
      /* consomme le corps */
    });
    req.on("end", () => {
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
      res.write(chunk({ content: "## Goal\nRésumé de test généré par le fournisseur simulé." }, null));
      res.write(chunk({}, "stop"));
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "test-model",
          choices: [],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => count,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

function effective(baseUrl: string): EffectiveLlmConfig {
  const role = {
    api: "openai-completions",
    baseUrl,
    model: "test-model",
    thinking: "off" as const,
  };
  return { light: role, heavy: role };
}

const temps: string[] = [];
const providers: FakeProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) await provider.close();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env["YUKI_LLM_LIGHT_API_KEY"];
  delete process.env["YUKI_LLM_HEAVY_API_KEY"];
});

interface Env {
  dir: string;
  cwd: string;
  sessionsDir: string;
  agentDir: string;
  home: string;
  settingsSeed: string;
}

/**
 * Réglages SEMÉS avec un `keepRecentTokens` minuscule : la conversation de test
 * (quelques échanges) dépasse donc le seuil et il y a RÉELLEMENT de l'historique
 * à résumer — sans avoir à produire 20 000 tokens.
 */
function layout(): Env {
  const dir = mkdtempSync(join(tmpdir(), "yuki-compact-sdk-"));
  temps.push(dir);
  const settingsSeed = join(dir, "settings-seed.json");
  writeFileSync(
    settingsSeed,
    `${JSON.stringify(
      {
        defaultProjectTrust: "never",
        enableInstallTelemetry: false,
        compaction: { enabled: true, reserveTokens: 256, keepRecentTokens: 20 },
        showCacheMissNotices: false,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return {
    dir,
    cwd: join(dir, "workspace"),
    sessionsDir: join(dir, "agent", "sessions"),
    agentDir: join(dir, "agent"),
    home: join(dir, "home"),
    settingsSeed,
  };
}

/** Écrit une conversation de plusieurs échanges (persistée sur disque). */
function seedConversation(env: Env, turns: number): string {
  const manager = SessionManager.create(env.cwd, env.sessionsDir);
  for (let index = 0; index < turns; index += 1) {
    manager.appendMessage({
      role: "user",
      content: `Message utilisateur ${index + 1} : parlons du sujet ${index + 1} en détail.`,
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Réponse assistant ${index + 1} sur le sujet ${index + 1}.` }],
      api: "test",
      provider: "test",
      model: "test",
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
  }
  return manager.getSessionId();
}

/** Entrées du JSONL (une par ligne) — lecture DIRECTE de ce que le SDK écrit. */
function readEntries(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

interface MemoryProbe {
  port: MemoryPort;
  /** Ordre observé : `full` = passe de remplissage, `before` = hook du moteur. */
  order: string[];
  /** Nombre de requêtes du fournisseur AU MOMENT où la passe s'est terminée. */
  requestsWhenFullPassEnded: number | null;
  messages: number;
}

function memoryProbe(provider: FakeProvider): MemoryProbe {
  const probe: MemoryProbe = {
    port: {} as MemoryPort,
    order: [],
    requestsWhenFullPassEnded: null,
    messages: 0,
  };
  const empty: MemoryRecallResult = {
    block: null,
    enabled: false,
    entries: 0,
    chars: 0,
    durationMs: 0,
  };
  probe.port = {
    recall: async () => empty,
    onTurnEnd: () => undefined,
    onBeforeCompact: () => {
      probe.order.push("before");
    },
    onSessionCompact: async (input) => {
      // ⚠️ La passe est VOLONTAIREMENT ASYNCHRONE : sans cela, elle s'exécuterait
      // EN ENTIER de façon synchrone à l'appel et le test ne prouverait pas que
      // le host l'ATTEND avant de compacter (il prouverait seulement l'ordre de
      // deux appels de fonction).
      probe.messages = input.messages.length;
      await new Promise((resolve) => setTimeout(resolve, 120));
      probe.order.push("full");
      probe.requestsWhenFullPassEnded = provider.requests();
      return { ran: true, added: 1, updated: 0, removed: 0, skipped: 0, chunks: 1 };
    },
  };
  return probe;
}

async function makeHost(env: Env, provider: FakeProvider, memory?: MemoryPort) {
  process.env["YUKI_LLM_LIGHT_API_KEY"] = "sk-light-secret-0000";
  process.env["YUKI_LLM_HEAVY_API_KEY"] = "sk-heavy-secret-0000";
  const host = createPiHost({
    agentDir: env.agentDir,
    cwd: env.cwd,
    home: env.home,
    sessionsDir: env.sessionsDir,
    systemPrompt: "Tu es un assistant de test.",
    settingsSeedPath: env.settingsSeed,
    modelsConfig: buildModelsConfigFrom(effective(provider.url)),
    model: "llm-light/test-model",
    thinking: "off",
    llmAvailable: true,
    ...(memory ? { memory } : {}),
    logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }),
  });
  await host.start();
  return host;
}

describe("intégration — compaction forcée (SDK Pi RÉEL)", () => {
  it("compacte RÉELLEMENT le fil : le JSONL porte une entrée `compaction`", async () => {
    const provider = await startFakeProvider();
    providers.push(provider);
    const env = layout();
    const probe = memoryProbe(provider);
    const sessionId = seedConversation(env, 4);
    const host = await makeHost(env, provider, probe.port);
    try {
      const file = await host.sessionFileFor(sessionId);
      expect(file).toBeTruthy();
      expect(file!.startsWith(env.sessionsDir)).toBe(true);
      const before = readEntries(file!);
      expect(before.some((entry) => entry["type"] === "compaction")).toBe(false);

      const outcome = await host.compactSession(sessionId);

      // 1. LE FIL EST RÉELLEMENT COMPACTÉ (écrit par le SDK dans le JSONL).
      const after = readEntries(file!);
      const compaction = after.filter((entry) => entry["type"] === "compaction");
      expect(compaction).toHaveLength(1);
      expect(String(compaction[0]!["summary"] ?? "")).toContain("Résumé de test");
      expect(Number(compaction[0]!["tokensBefore"] ?? 0)).toBeGreaterThan(0);
      // Le compte rendu du host reflète les mesures du moteur.
      expect(outcome.tokensBefore).toBeGreaterThan(0);
      expect(outcome.tokensAfter).toBeTypeOf("number");

      // 2. ORDRE : la passe de remplissage s'est TERMINÉE avant la summarisation
      //    (le fournisseur n'avait encore reçu AUCUNE requête à cet instant).
      expect(probe.order[0]).toBe("full");
      expect(probe.requestsWhenFullPassEnded).toBe(0);
      expect(provider.requests()).toBeGreaterThan(0);
      expect(probe.messages).toBe(8);
      // 3. La consolidation « avant compaction » du MOTEUR arrive APRÈS.
      expect(probe.order).toEqual(["full", "before"]);
    } finally {
      await host.stop();
    }
  });

  it("une conversation DÉJÀ compactée refuse la recompaction (message français)", async () => {
    const provider = await startFakeProvider();
    providers.push(provider);
    const env = layout();
    const sessionId = seedConversation(env, 3);
    const host = await makeHost(env, provider);
    try {
      await host.compactSession(sessionId);
      await expect(host.compactSession(sessionId)).rejects.toThrow(/rien de plus à compacter/i);
    } finally {
      await host.stop();
    }
  });

  it("sans mémoire configurée, la compaction a lieu quand même (raison `unsupported`)", async () => {
    const provider = await startFakeProvider();
    providers.push(provider);
    const env = layout();
    const sessionId = seedConversation(env, 3);
    const host = await makeHost(env, provider);
    try {
      const outcome = await host.compactSession(sessionId);
      expect(outcome.memory.ran).toBe(false);
      expect(outcome.memory.reason).toBe("unsupported");
      const file = await host.sessionFileFor(sessionId);
      const entries = readEntries(file!);
      expect(entries.filter((entry) => entry["type"] === "compaction")).toHaveLength(1);
    } finally {
      await host.stop();
    }
  });
});
