/**
 * Harnais E2E JETABLE — ACTIONS DU MENU DU TITRE : « Supprimer » (définitif) et
 * « Compacter… » (passe de mémoire PUIS compaction), sur un gateway RÉEL et un
 * hôte Pi RÉEL.
 *
 * Ce que le harnais câble (comme la production, sans réseau LLM) :
 *  - un FOURNISSEUR OpenAI-compatible SIMULÉ en local (SSE) : la compaction
 *    forcée appelle RÉELLEMENT le moteur, donc il lui faut un modèle qui répond ;
 *  - `settings.json` semé avec un `keepRecentTokens` minuscule : les
 *    conversations de test ont donc réellement de l'historique à résumer ;
 *  - `MemoryService` réelle (store JSONL + index FTS5) avec un EXTRACTEUR
 *    DÉTERMINISTE : prompt contenant « POTAGER » ⇒ écrit un fait durable.
 *
 * Trois conversations sont pré-écrites : `potager`, `jeter`, `temoin`.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-session-actions-serve.ts"
 * Env : YUKI_E2E_ACTIONS_DIR (OBLIGATOIRE) — état, sessions, mémoire, réglages.
 * Sortie : « READY <gateway> PROBE <probe> » puis reste vivant.
 */

import {
  createServer,
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { buildModelsConfigFrom, type EffectiveLlmConfig } from "../../src/llm/models.js";
import { MemoryIndex, MemoryService, MemoryStore } from "../../src/memory/index.js";
import { createPiHost } from "../../src/pi/host.js";
import { createLogger } from "../../src/observability/logger.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_ACTIONS_DIR;
if (!stateDir) throw new Error("YUKI_E2E_ACTIONS_DIR requis");
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

/* ─── FOURNISSEUR SIMULÉ (SSE) : la compaction a besoin d'un modèle ──────── */
const providerState = { requests: 0 };
const provider = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  providerState.requests += 1;
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
        id: "chatcmpl-e2e",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "test-model",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    res.write(chunk({ role: "assistant", content: "" }, null));
    res.write(chunk({ content: "## Goal\nRésumé de test (fournisseur simulé)." }, null));
    res.write(chunk({}, "stop"));
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-e2e",
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
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

/** Réglages SEMÉS : `keepRecentTokens` minuscule ⇒ l'historique est résumé. */
const settingsSeedPath = join(stateDir, "settings-seed.json");
writeFileSync(
  settingsSeedPath,
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

/** Écrit une session persistée (user + assistant) et renvoie son identifiant. */
function seed(user: string, assistant: string, name: string): string {
  const manager = SessionManager.create(cwd, sessionsDir);
  manager.appendSessionInfo(name);
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

/**
 * Conversation VOLONTAIREMENT plus longue : une compaction n'a de sens que s'il
 * y a de l'historique à résumer (le moteur refuse « trop courte » sinon — c'est
 * un comportement honnête, mais il ne prouverait pas la compaction).
 */
function seedConversation(name: string, turns: ReadonlyArray<[string, string]>): string {
  const manager = SessionManager.create(cwd, sessionsDir);
  manager.appendSessionInfo(name);
  for (const [user, assistant] of turns) {
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
  return manager.getSessionId();
}

const SEEDS = {
  potager: seedConversation("Conversation POTAGER", [
    [
      "Mon POTAGER est au fond du jardin, derrière le mur de pierre.",
      "Je retiens l'emplacement du potager.",
    ],
    [
      "Je veux y planter des tomates cerises cette année.",
      "Noté : tomates cerises dans le potager du fond.",
    ],
    [
      "Il faudra aussi réparer le portillon du potager.",
      "Je note la réparation du portillon.",
    ],
    [
      "Et installer un récupérateur d'eau près du potager.",
      "Bien noté pour le récupérateur d'eau.",
    ],
  ]),
  jeter: seed(
    "Conversation sans aucun intérêt : elle sera SUPPRIMÉE définitivement.",
    "D'accord.",
    "Conversation JETER",
  ),
  temoin: seed(
    "Conversation TEMOIN qui doit rester dans la liste.",
    "Elle reste.",
    "Conversation TEMOIN",
  ),
};

/** Extractor DÉTERMINISTE (aucun réseau) : reproductible. */
let extractorCalls = 0;
async function stubExtractor(prompt: string): Promise<string> {
  extractorCalls += 1;
  if (prompt.toUpperCase().includes("POTAGER")) {
    // DÉLAI VOLONTAIRE : la compaction doit ATTENDRE la fin de la passe.
    await sleep(600);
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

const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
});

const memoryPath = join(stateDir, "memory.jsonl");
const memoryStore = MemoryStore.open({ path: memoryPath, logger });
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

const role = {
  api: "openai-completions" as const,
  baseUrl: providerUrl,
  model: "test-model",
  thinking: "off" as const,
};
const effective: EffectiveLlmConfig = { light: role, heavy: role };
process.env["YUKI_LLM_LIGHT_API_KEY"] = "sk-e2e-light-0000";
process.env["YUKI_LLM_HEAVY_API_KEY"] = "sk-e2e-heavy-0000";

const host = createPiHost({
  agentDir,
  cwd,
  home: join(stateDir, "home"),
  sessionsDir,
  systemPrompt: "# Yuki\n\nAssistant de test E2E.\n",
  settingsSeedPath,
  modelsConfig: buildModelsConfigFrom(effective),
  model: "llm-light/test-model",
  thinking: "off",
  llmAvailable: true,
  logger,
  memory: memoryService,
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

/** Empreinte + taille du fichier de mémoire (assertion octet pour octet). */
function memoryFingerprint(): { exists: boolean; bytes: number; sha: string } {
  if (!existsSync(memoryPath)) return { exists: false, bytes: 0, sha: "" };
  const content = readFileSync(memoryPath);
  return {
    exists: true,
    bytes: content.length,
    sha: createHash("sha256").update(content).digest("hex"),
  };
}

/** Fichier JSONL d'une conversation (par identifiant), s'il existe. */
async function sessionFile(id: string): Promise<string | undefined> {
  return host.sessionFileFor(id);
}

async function sessionEntries(id: string): Promise<Record<string, unknown>[]> {
  const file = await sessionFile(id);
  if (!file || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return { type: "unparsable" };
      }
    });
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
        extractorCalls,
      });
      return;
    }
    if (url.pathname === "/memory-bytes") {
      send(memoryFingerprint());
      return;
    }
    if (url.pathname === "/requests") {
      send({ requests: providerState.requests });
      return;
    }
    if (url.pathname === "/sessions") {
      const list = await host.listSessions();
      send({
        sessions: list.map((info) => ({ id: info.sessionId, title: info.title ?? null })),
        current: host.currentSessionId() ?? null,
      });
      return;
    }
    if (url.pathname === "/file-exists") {
      const id = url.searchParams.get("id") ?? "";
      const file = await sessionFile(id);
      send({ exists: Boolean(file && existsSync(file)), file: file ?? null });
      return;
    }
    if (url.pathname === "/entries") {
      const id = url.searchParams.get("id") ?? "";
      const entries = await sessionEntries(id);
      send({
        types: entries.map((entry) => entry["type"]),
        compactions: entries
          .filter((entry) => entry["type"] === "compaction")
          .map((entry) => ({
            summaryChars: String(entry["summary"] ?? "").length,
            tokensBefore: Number(entry["tokensBefore"] ?? 0),
          })),
      });
      return;
    }
    if (url.pathname === "/logs") {
      const pattern = new RegExp(url.searchParams.get("pattern") ?? "compact");
      send({
        lines: logLines(pattern).map((record) => ({ msg: record.msg, ...record })),
      });
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
    console.log(`READY http://127.0.0.1:${gateway.port} PROBE http://127.0.0.1:${probeAddress.port}`);
  });
});
setInterval(() => {}, 1 << 30);
