/**
 * Harnais E2E JETABLE — MISE DE CÔTÉ d'une conversation : ARCHIVE COMPLÈTE +
 * PASSE DE MÉMOIRE, sur un gateway RÉEL avec un hôte Pi RÉEL.
 *
 * Ce que le harnais câble (comme la production, sans réseau LLM) :
 *  - `MemoryService` réelle (store JSONL + index FTS5) avec un EXTRACTEUR
 *    DÉTERMINISTE (pas de modèle : le test doit être reproductible). Règles :
 *      · prompt contenant « POTAGER » ⇒ écrit un fait durable (avec `why`) ;
 *      · prompt contenant « PANNE »   ⇒ échoue (simulation de panne) ;
 *      · sinon ⇒ `[]` (aucune écriture).
 *  - `ConversationArchiveStore` réelle (fichiers du volume d'état + index FTS5).
 *  - `createPiHost` avec `memory` + `conversationArchive` (donc l'outil
 *    `chercher_conversations_archivees` est enregistré et allowlisté).
 *
 * Quatre conversations sont pré-écrites : `potager`, `panne`, `muette` (celle
 * que le host FOCALISE, chemin session VIVANTE) et `témoin` (jamais touchée).
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-set-aside-memory-serve.ts"
 * Env : YUKI_E2E_SETASIDE_DIR (OBLIGATOIRE) — état, sessions, mémoire, archive.
 * Sortie : « READY <gateway> PROBE <probe> » puis reste vivant.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import {
  ConversationArchiveStore,
  MemoryIndex,
  MemoryService,
  MemoryStore,
} from "../../src/memory/index.js";
import { buildInlineExtensions } from "../../src/pi/sdk-host.js";
import { createPiHost } from "../../src/pi/host.js";
import { createConversationArchiveTools } from "../../src/pi/sdk/conversation-archive-tools.js";
import { toolAllowlist } from "../../src/llm/index.js";
import { createLogger } from "../../src/observability/logger.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_SETASIDE_DIR;
if (!stateDir) throw new Error("YUKI_E2E_SETASIDE_DIR requis");
const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
for (const dir of [agentDir, cwd, sessionsDir]) mkdirSync(dir, { recursive: true });

const logs: string[] = [];
const logger = createLogger({
  level: "info",
  sink: (line) => {
    logs.push(line);
  },
  secretValues: [],
});

/** Écrit une session persistée (user + assistant) et renvoie son identifiant. */
function seed(user: string, assistant: string, name?: string): string {
  const manager = SessionManager.create(cwd, sessionsDir);
  if (name) manager.appendSessionInfo(name);
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

const SEEDS = {
  potager: seed(
    "Mon POTAGER est au fond du jardin, derrière le mur de pierre.",
    "Je retiens l'emplacement du potager.",
    "Conversation POTAGER",
  ),
  panne: seed(
    "Conversation PANNE : la passe de mémoire va échouer ici.",
    "Compris.",
    "Conversation PANNE",
  ),
  muette: seed(
    "Bonjour, conversation banale sans information durable.",
    "Bonjour.",
    "Conversation MUETTE",
  ),
  temoin: seed(
    "Conversation TEMOIN qui doit rester dans la liste.",
    "Elle reste.",
    "Conversation TEMOIN",
  ),
};

/** Extractor DÉTERMINISTE (aucun réseau) : le test doit être reproductible. */
async function stubExtractor(prompt: string): Promise<string> {
  if (prompt.toUpperCase().includes("PANNE")) {
    // PANNE SIMULÉE : la mise de côté doit réussir quand même.
    await sleep(300);
    throw new Error("panne simulée de l'extracteur");
  }
  if (prompt.toUpperCase().includes("POTAGER")) {
    // DÉLAI VOLONTAIRE : il prouve que la mise de côté n'ATTEND PAS la passe
    // (l'interface doit se libérer bien avant la fin de l'écriture mémoire).
    await sleep(1500);
    return JSON.stringify([
      {
        op: "add",
        text: "L'utilisateur cultive un potager au fond du jardin",
        cat: "fait",
        why: "aménagement durable du jardin",
      },
    ]);
  }
  return "[]";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const env = loadEnv({ YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt", YUKI_LOG_LEVEL: "error" });

const memoryStore = MemoryStore.open({ path: join(stateDir, "memory.jsonl"), logger });
const memoryIndex = new MemoryIndex({ path: join(stateDir, "memory-index.sqlite"), logger });
const memoryService = new MemoryService({
  store: memoryStore,
  index: memoryIndex,
  logger,
  enabled: () => true,
  bounds: () => ({ topK: 5, budgetChars: 8000, timeoutMs: 400 }),
  extractor: stubExtractor,
  maxItemsPerPass: () => 3,
  setAsideBounds: () => ({ maxChars: 24_000, maxChunks: 2 }),
});
memoryService.start();

const conversationArchive = new ConversationArchiveStore({
  dir: join(stateDir, "conversations-archive"),
  indexPath: join(stateDir, "conversations-archive-index.sqlite"),
  logger,
});
conversationArchive.ensureLayout();

const host = createPiHost({
  agentDir,
  cwd,
  home: join(stateDir, "home"),
  sessionsDir,
  systemPrompt: "# Yuki\n\nAssistant de test E2E.\n",
  settingsSeedPath: "config/pi/settings.json",
  logger,
  memory: memoryService,
  conversationArchive,
});
await host.start();

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
});

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
};

const server = createHttpServer(createApp(context));
transport.attach(server);

// ---------------------------------------------------------------------------
// SONDE de test (serveur SÉPARÉ, hors produit) : lecture de l'état RÉEL obtenu.
// ---------------------------------------------------------------------------

/** Journaux du harnais, filtrés (déjà sérialisés JSON). */
function logLines(pattern: RegExp): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of logs) {
    try {
      const record = JSON.parse(line) as Record<string, unknown>;
      if (pattern.test(String(record.msg ?? ""))) out.push(record);
    } catch {
      // ligne non JSON : ignorée
    }
  }
  return out;
}

/** Exécute l'OUTIL RÉEL de recherche d'archive (comme le ferait le modèle). */
async function runArchiveTool(query: string, limit = 8): Promise<{ text: string; details: unknown }> {
  const tool = createConversationArchiveTools(conversationArchive)[0]!;
  const execute = tool.execute as unknown as (
    id: string,
    params: unknown,
    signal: undefined,
  ) => Promise<{ content: { type: string; text: string }[]; details: unknown }>;
  const result = await execute("probe", { recherche: query, limite: limit }, undefined);
  return { text: result.content.map((part) => part.text).join(""), details: result.details };
}

/** Exécute les extensions de prompt RÉELLES (miroir de `buildInlineExtensions`). */
async function runPromptHandlers(): Promise<string[]> {
  const extensions = buildInlineExtensions({ memory: memoryService, logger });
  const prompts: string[] = [];
  for (const extension of extensions) {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const run = typeof extension === "function" ? extension : extension.factory;
    (run as (pi: unknown) => void)({
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(name, handler);
      },
    });
    const handler = handlers.get("before_agent_start");
    if (!handler) continue;
    const result = (await handler(
      { prompt: "Qu'est-ce qu'on s'était dit à propos du potager ?", systemPrompt: "BASE" },
      {},
    )) as { systemPrompt?: string } | undefined;
    prompts.push(result?.systemPrompt ?? "BASE");
  }
  return prompts;
}

const probe = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (body: unknown): void => {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  };
  try {
    if (url.pathname === "/seeds") {
      send(SEEDS);
      return;
    }
    if (url.pathname === "/memories") {
      send({
        entries: memoryStore.entries.map((entry) => ({
          text: entry.text,
          cat: entry.cat,
          why: entry.why ?? null,
          source: entry.source,
        })),
      });
      return;
    }
    if (url.pathname === "/archive-info") {
      send({ info: conversationArchive.info(), seeds: SEEDS });
      return;
    }
    if (url.pathname === "/archive-search") {
      const query = url.searchParams.get("q") ?? "";
      send(await runArchiveTool(query));
      return;
    }
    if (url.pathname === "/prompt") {
      send({ prompts: await runPromptHandlers() });
      return;
    }
    if (url.pathname === "/logs") {
      const pattern = new RegExp(url.searchParams.get("pattern") ?? "set_aside");
      send({ lines: logLines(pattern).map((record) => ({ msg: record.msg, ...record })) });
      return;
    }
    if (url.pathname === "/tools") {
      send({
        light: toolAllowlist("light", { conversationArchiveEnabled: true }),
        lightWithout: toolAllowlist("light"),
      });
      return;
    }
    if (url.pathname === "/rearchive") {
      // Idempotence RÉELLE : on ré-archive la conversation déjà archivée.
      const id = url.searchParams.get("id") ?? "";
      const before = conversationArchive.info();
      const result = conversationArchive.archiveConversation({ id, title: "réessai", messages: [] });
      send({ result, before, after: conversationArchive.info() });
      return;
    }
    if (url.pathname === "/recall") {
      const query = url.searchParams.get("q") ?? "";
      send(await memoryService.recall(query));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(error instanceof Error ? error.message : String(error));
  }
});

server.listen(0, "127.0.0.1", () => {
  const gateway = server.address() as AddressInfo;
  probe.listen(0, "127.0.0.1", () => {
    const probeAddress = probe.address() as AddressInfo;
    console.log(
      `READY http://127.0.0.1:${gateway.port} PROBE http://127.0.0.1:${probeAddress.port}`,
    );
  });
});
setInterval(() => {}, 1 << 30);
