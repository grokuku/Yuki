/**
 * Harnais E2E JETABLE — RÉACTIONS aux messages de Yuki.
 *
 * Gateway RÉEL, hôte Pi SIMULÉ (qui émet de VRAIES trames, avec l'identifiant
 * d'entrée de session sur chaque message — comme le SDK), pipeline TTS RÉEL
 * (synthétiseur simulé qui ENREGISTRE le texte prononcé) et store de réactions
 * RÉEL sur disque (volume `state`).
 *
 * Un serveur de CONTRÔLE (port séparé, hors CSP) permet de :
 *   - lancer un tour UTILISATEUR (`/send`) ;
 *   - compter les tours DÉCLENCHÉS (`/runs`) : une réaction doit en produire ZÉRO ;
 *   - relire le texte RÉELLEMENT prononcé (`/spoken`) ;
 *   - relire le transcript serveur, la réaction persistée par message ;
 *   - construire le BLOC réellement injecté au modèle via la VRAIE extension
 *     (`/prompt-block`) : preuve que le sens du groupe parvient au prompt ;
 *   - relire la MÉMOIRE DURABLE (`/memory`) : preuve qu'une GRATITUDE répétée
 *     n'écrit AUCUNE ligne (le câblage est celui de la composition root :
 *     `ReactionStore.set` → `regularityMemory` → `MemoryService`).
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-reactions-serve.ts"
 * Sortie : « READY http://127.0.0.1:<port> » puis « CONTROL http://… ».
 */

import { mkdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { MemoryIndex, MemoryService, MemoryStore, REACTIONS_SOURCE } from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";
import type { PiEvent } from "../../src/pi/types.js";
import { createReactionsExtensionFactory } from "../../src/pi/sdk/reactions-extension.js";
import { ReactionStore } from "../../src/reactions/store.js";
import { regularityMemory, type ReactionRegularity } from "../../src/reactions/types.js";
import type { SegmentSynthesizer, TtsPipelineDeps } from "../../src/tts/index.js";
import type { GpuReport } from "../../src/types/gpu.js";
import { FakePiHost, type FakeStep } from "../../tests/pi/host-double.js";

const STATE_DIR = process.env.YUKI_E2E_REACTIONS_DIR ?? "/tmp/yuki-e2e-reactions";
mkdirSync(STATE_DIR, { recursive: true });

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
  // Store RÉEL sur disque : la preuve de « survit au rechargement » passe par là.
  YUKI_REACTIONS_STORE_PATH: join(STATE_DIR, "reactions.jsonl"),
});

/**
 * Réponses des tours successifs. Les TROIS premières sont citées par les
 * assertions (extrait du message visé) : ne pas les changer. Les suivantes
 * servent la preuve de rétention : dix messages distincts pour dix ❤️.
 */
const ANSWERS = [
  "Première réponse, courte et posée.",
  "Deuxième réponse, un peu plus détaillée que la précédente.",
  "Troisième réponse : la toute dernière du fil, celle du bas de l'écran.",
  "Quatrième réponse, pour la dixième réaction.",
  "Cinquième réponse, pour la dixième réaction.",
  "Sixième réponse, pour la dixième réaction.",
  "Septième réponse, pour la dixième réaction.",
  "Huitième réponse, pour la dixième réaction.",
  "Neuvième réponse, pour la dixième réaction.",
  "Dixième réponse : la gratitude répétée ne doit rien mémoriser.",
];
const USER_TEXT = "Peux-tu me répondre en trois temps ?";

function chatSteps(text: string, size = 8, delayMs = 40): FakeStep[] {
  const steps: FakeStep[] = [];
  for (let index = 0; index < text.length; index += size) {
    steps.push({ kind: "delta", channel: "content", text: text.slice(index, index + size), delayMs });
  }
  return steps;
}

const host = new FakePiHost({
  sessionId: "e2e-reactions-session",
  scripts: ANSWERS.map((text, index) => ({
    name: `tour-${index}`,
    steps: chatSteps(text),
  })),
});
await host.start();

/** Réactions effectivement écrites (store RÉEL, journal sur disque). */
const store = ReactionStore.open({ path: env.reactionsStorePath });

/**
 * MÉMOIRE DURABLE réelle, câblée comme la composition root (`src/index.ts`) :
 * c'est le SEUL moyen de prouver qu'une gratitude répétée n'écrit rien.
 */
const memoryPath = join(STATE_DIR, "memory.jsonl");
const memoryStore = MemoryStore.open({ path: memoryPath, logger });
const memoryIndex = new MemoryIndex({ path: join(STATE_DIR, "memory-index.sqlite"), logger });
const memory = new MemoryService({
  store: memoryStore,
  index: memoryIndex,
  logger,
  enabled: () => true,
  bounds: () => ({ topK: 5, budgetChars: 8000, timeoutMs: 400 }),
  maxItemsPerPass: () => 3,
});
memory.start();

/** Traduit une régularité en souvenir — MÊME chaîne que `src/index.ts`. */
function rememberReactionRegularity(regularity: ReactionRegularity): void {
  const candidate = regularityMemory(regularity);
  if (!candidate) return;
  memory.onReactionRegularity({ ...candidate, source: REACTIONS_SOURCE });
}
/** Nombre de tours DÉCLENCHÉS (une réaction doit en produire ZÉRO). */
let runs = 0;
host.subscribeAll((event: PiEvent) => {
  if (event.type === "run_started") runs += 1;
});

/* ─── Pipeline TTS RÉEL (synthétiseur ENREGISTREUR) ───────────────────────── */
const spoken: string[] = [];
const synthesizer: SegmentSynthesizer = async (request) => {
  spoken.push(request.text);
  return (async function* () {
    yield { type: "format", sampleRate: 16_000, channels: 1 };
    yield { type: "data", bytes: Buffer.alloc(800) };
  })();
};
const ttsConfig: Record<string, number | string> = {
  "tts.prefetchDepth": 1,
  "tts.minSentenceChars": 1,
  "tts.maxSentenceChars": 200,
  "tts.engine": "chatterbox",
  "tts.voice": "",
};
const ttsPipeline: TtsPipelineDeps = {
  enabled: true,
  config: {
    getString: (path) => String(ttsConfig[path] ?? ""),
    getNumber: (path) => Number(ttsConfig[path] ?? 0),
  },
  synthesizer,
  resolveVoice: () => null,
  logger,
};

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-reactions-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  tts: ttsPipeline,
  // Port d'écriture : MÊME store que celui injecté dans l'extension de prompt.
  reactions: {
    set: (sessionId, entryId, reaction) => {
      const regularity = store.set(sessionId, entryId, reaction);
      if (regularity) rememberReactionRegularity(regularity);
      return regularity !== null;
    },
    clear: (sessionId, entryId) => store.clear(sessionId, entryId),
    forSession: (sessionId) => store.forSession(sessionId),
  },
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
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;
console.log(`READY http://127.0.0.1:${address.port}`);

/* ─── Serveur de CONTRÔLE ─────────────────────────────────────────────────── */
const control = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? "", "http://127.0.0.1");
  const send = (body: unknown, status = 200): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const sessionId = host.currentSessionId() ?? "e2e-reactions-session";
  if (url.pathname === "/send") {
    const text = url.searchParams.get("text") ?? USER_TEXT;
    const handle = host.send(sessionId, text);
    return send({ ok: true, runId: handle.runId, sessionId });
  }
  if (url.pathname === "/runs") {
    return send({ runs });
  }
  if (url.pathname === "/spoken") {
    return send({ spoken: [...spoken] });
  }
  if (url.pathname === "/spoken-reset") {
    spoken.length = 0;
    return send({ ok: true });
  }
  if (url.pathname === "/transcript") {
    const state = host.getState(sessionId);
    return send({
      entries: (state?.transcript ?? []).map((entry) => ({
        role: entry.role,
        text: entry.text,
        id: entry.id ?? null,
      })),
    });
  }
  if (url.pathname === "/reactions") {
    return send({
      state: [...store.forSession(sessionId).entries()],
      file: store.filePath,
      count: store.size,
    });
  }
  if (url.pathname === "/memory") {
    // On laisse la file d'écriture se vider : une écriture asynchrone ne doit pas
    // échapper à la mesure.
    await memory.drain();
    const lines = readFileSync(memoryPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.startsWith("#"));
    return send({
      file: memoryPath,
      lines: lines.length,
      events: lines,
      entries: memoryStore.entries.map((entry) => entry.text),
    });
  }
  if (url.pathname === "/prompt-block") {
    // VRAIE extension de réactions, VRAI store : on construit le bloc exactement
    // comme au tour suivant (prompt système), sur la branche simulée du double.
    const state = host.getState(sessionId);
    const branch = (state?.transcript ?? [])
      .filter((entry) => typeof entry.id === "string")
      .map((entry) => ({
        type: "message",
        id: entry.id,
        message: { role: entry.role, content: [{ type: "text", text: entry.text }] },
      }));
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    createReactionsExtensionFactory(store).factory({
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        handlers.set(name, handler);
      },
    } as never);
    const handler = handlers.get("before_agent_start");
    if (!handler) return send({ prompt: null }, 500);
    const value = (await handler(
      { prompt: USER_TEXT, systemPrompt: "PROMPT DE BASE" },
      {
        sessionManager: {
          getSessionId: () => sessionId,
          getBranch: () => branch,
        },
      },
    )) as { systemPrompt?: string } | undefined;
    return send({ prompt: value?.systemPrompt ?? "PROMPT DE BASE" });
  }
  return send({ error: "unknown" }, 404);
});
await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
const controlAddress = control.address() as AddressInfo;
console.log(`CONTROL http://127.0.0.1:${controlAddress.port}`);

setInterval(() => {}, 1 << 30);
