/**
 * Harnais E2E JETABLE — E2 : TRANSPORT MULTIPLEXÉ (plusieurs conversations en
 * parallèle, vues dans un VRAI navigateur).
 *
 * Il sert la page de discussion `/` sous la CSP réelle, avec :
 *   - un host Pi MULTI-SESSION (double déterministe) où DEUX conversations
 *     peuvent streameR EN MÊME TEMPS, chacune avec SON état et SON transcript ;
 *   - le pipeline TTS RÉEL (synthétiseur simulé qui ENREGISTRE le texte
 *     prononcé) — pour prouver qu'un fil de FOND reste MUET.
 *
 * Un serveur de CONTRÔLE (port séparé, hors CSP) permet de :
 *   - lancer un run sur N'IMPORTE QUELLE conversation (focalisée ou de fond) ;
 *   - relire le transcript d'une conversation donnée ;
 *   - relire/réinitialiser les segments réellement synthétisés.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-multiplex-serve.ts"
 * Sortie : « READY http://127.0.0.1:<port> » puis « CONTROL http://… ».
 */

import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import type { PiHost } from "../../src/pi/host.js";
import type {
  EnsureSessionOptions,
  PiEvent,
  PiEventListener,
  PiSessionStateName,
  RunHandle,
  SendOptions,
  SessionInfo,
  SessionState,
  TranscriptEntry,
} from "../../src/pi/types.js";
import type { SegmentSynthesizer, TtsPipelineDeps } from "../../src/tts/index.js";
import type { GpuReport } from "../../src/types/gpu.js";

/* ─── Host Pi MULTI-SESSION (double) ─────────────────────────────────────── */

export interface RunSpec {
  reply: string;
  chunks?: number;
  delayMs?: number;
}

interface Rec {
  id: string;
  file: string;
  title: string;
  transcript: TranscriptEntry[];
  state: PiSessionStateName;
  activeRunId?: string;
  partial: string;
  timers: NodeJS.Timeout[];
  generation: number;
  updatedAt: string;
}

function chunk(text: string, parts: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, parts)));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

class MultiSessionHost implements PiHost {
  private readonly listeners = new Set<PiEventListener>();
  private readonly bySession = new Map<string, Set<PiEventListener>>();
  private readonly sessions = new Map<string, Rec>();
  private focusedId: string | undefined;
  private ready = false;
  private counter = 0;

  constructor(seeds: Array<{ id: string; title: string; user: string; assistant: string }>) {
    seeds.forEach((seed, index) => {
      this.sessions.set(seed.id, {
        id: seed.id,
        file: `/fake/${seed.id}.jsonl`,
        title: seed.title,
        transcript: [
          { role: "user", text: seed.user, timestamp: Date.now() },
          { role: "assistant", text: seed.assistant, timestamp: Date.now() },
        ],
        state: "idle",
        partial: "",
        timers: [],
        generation: 0,
        updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
      });
    });
    this.focusedId = seeds[0]?.id;
  }

  async start(): Promise<void> {
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  currentSessionId(): string | undefined {
    return this.focusedId;
  }

  async ensureSession(target?: EnsureSessionOptions): Promise<SessionState> {
    if (target?.sessionFile) return this.resume(target.sessionFile);
    if (target?.new) return this.newSession();
    return this.stateOf(this.focusedId);
  }

  async newSession(): Promise<SessionState> {
    const id = `sess-new-${++this.counter}`;
    this.sessions.set(id, {
      id,
      file: `/fake/${id}.jsonl`,
      title: "Nouvelle conversation",
      transcript: [],
      state: "idle",
      partial: "",
      timers: [],
      generation: 0,
      updatedAt: new Date().toISOString(),
    });
    this.focusedId = id;
    this.emit({ type: "state", sessionId: id, state: "idle" });
    return this.stateOf(id);
  }

  async continueRecent(): Promise<SessionState> {
    return this.stateOf(this.focusedId);
  }

  async resume(sessionFile: string): Promise<SessionState> {
    const rec = [...this.sessions.values()].find((s) => s.file === sessionFile);
    if (!rec) throw new Error(`session introuvable : ${sessionFile}`);
    this.focusedId = rec.id;
    return this.stateOf(rec.id);
  }

  send(sessionId: string, text: string, _opts?: SendOptions): RunHandle {
    void _opts;
    return this.startRun(sessionId, {
      reply: `Réponse au message « ${text} ».`,
      chunks: 10,
      delayMs: 150,
    });
  }

  /** Lancement d'un run quelconque (utilisé par le serveur de contrôle). */
  debugRun(sessionId: string, spec: RunSpec): RunHandle {
    return this.startRun(sessionId, spec);
  }

  /** Texte agrégé du transcript d'une conversation (contrôle). */
  debugTranscript(sessionId: string): string {
    const rec = this.sessions.get(sessionId);
    if (!rec) return "";
    return [...rec.transcript, ...(rec.partial ? [{ role: "assistant" as const, text: rec.partial }] : [])]
      .map((entry) => entry.text)
      .join("\n");
  }

  debugSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** E3 — émet une trame d'activité (contrôle éphémère) pour une session. */
  debugEmitActivity(
    sessionId: string,
    stage: string,
    payload: { jobId?: string; task?: string; detail?: string; status?: string } = {},
  ): void {
    this.emit({
      type: "job_activity",
      sessionId,
      jobId: payload.jobId ?? "act-1",
      stage,
      ...(payload.task !== undefined ? { task: payload.task } : {}),
      ...(payload.detail !== undefined ? { detail: payload.detail } : {}),
      ...(payload.status !== undefined
        ? { status: payload.status as "completed" | "failed" | "cancelled" | "interrupted" }
        : {}),
      at: new Date().toISOString(),
    });
  }

  async abort(sessionId: string, runId?: string): Promise<void> {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    if (runId && rec.activeRunId !== runId) return;
    this.cancelRun(rec, "abort", true);
  }

  subscribe(sessionId: string, listener: PiEventListener): () => void {
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this.bySession.set(sessionId, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  subscribeAll(listener: PiEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recordRunStage(): void {
    /* instrumentation non nécessaire ici */
  }

  recordRunTtsMetrics(): void {
    /* instrumentation non nécessaire ici */
  }

  getState(sessionId?: string): SessionState | undefined {
    const id = sessionId ?? this.focusedId;
    if (!id) return undefined;
    return this.stateOf(id);
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [...this.sessions.values()]
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .map((rec) => ({
        sessionId: rec.id,
        sessionFile: rec.file,
        title: rec.title,
        updatedAt: rec.updatedAt,
        messageCount: rec.transcript.length,
      }));
  }

  async renameSession(id: string, title: string): Promise<void> {
    const rec = this.sessions.get(id);
    if (rec) rec.title = title.replace(/\s+/g, " ").trim() || rec.title;
  }

  async setAsideSession(id: string): Promise<void> {
    this.sessions.delete(id);
    if (this.focusedId === id) this.focusedId = undefined;
  }

  async sessionFileFor(id: string): Promise<string | undefined> {
    return this.sessions.get(id)?.file;
  }

  async stop(): Promise<void> {
    this.ready = false;
    for (const rec of this.sessions.values()) {
      for (const timer of rec.timers) clearTimeout(timer);
      rec.timers = [];
    }
    this.listeners.clear();
    this.bySession.clear();
  }

  // --- interne -------------------------------------------------------------

  private stateOf(id: string | undefined): SessionState {
    const rec = id ? this.sessions.get(id) : undefined;
    if (!rec) {
      return { sessionId: id ?? "", state: "idle", transcript: [] };
    }
    return {
      sessionId: rec.id,
      state: rec.state,
      ...(rec.activeRunId ? { activeRunId: rec.activeRunId } : {}),
      transcript: [
        ...rec.transcript,
        ...(rec.partial ? [{ role: "assistant" as const, text: rec.partial }] : []),
      ],
    };
  }

  private startRun(sessionId: string, spec: RunSpec): RunHandle {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`Session inconnue : ${sessionId}`);
    if (rec.activeRunId) this.cancelRun(rec, "superseded", true);
    rec.generation += 1;
    const gen = rec.generation;
    const runId = randomUUID();
    rec.state = "streaming";
    rec.activeRunId = runId;
    rec.partial = "";
    rec.updatedAt = new Date().toISOString();
    this.emit({ type: "state", sessionId, state: "streaming", activeRunId: runId });
    this.emit({ type: "run_started", sessionId, runId });

    const parts = chunk(spec.reply, spec.chunks ?? 8);
    const delayMs = Math.max(0, spec.delayMs ?? 25);
    let acc = "";
    const step = (index: number): void => {
      if (gen !== rec.generation) return;
      const timer = setTimeout(() => {
        if (gen !== rec.generation) return;
        if (index >= parts.length) {
          rec.transcript.push({ role: "assistant", text: acc });
          rec.partial = "";
          rec.state = "idle";
          rec.activeRunId = undefined;
          this.emit({ type: "run_finished", sessionId, runId, reason: "done" });
          this.emit({ type: "state", sessionId, state: "idle" });
          return;
        }
        const piece = parts[index] ?? "";
        acc += piece;
        rec.partial = acc;
        this.emit({ type: "delta", sessionId, runId, channel: "content", text: piece });
        step(index + 1);
      }, delayMs);
      rec.timers.push(timer);
    };
    step(0);
    return { runId, sessionId, queued: false };
  }

  private cancelRun(rec: Rec, reason: string, emit: boolean): void {
    const runId = rec.activeRunId;
    const wasStreaming = rec.state === "streaming";
    for (const timer of rec.timers) clearTimeout(timer);
    rec.timers = [];
    rec.generation += 1;
    rec.activeRunId = undefined;
    rec.state = "idle";
    rec.partial = "";
    if (emit && runId && wasStreaming) {
      this.emit({ type: "run_finished", sessionId: rec.id, runId, reason });
      this.emit({ type: "state", sessionId: rec.id, state: "idle" });
    }
  }

  private emit(event: PiEvent): void {
    for (const listener of this.listeners) listener(event);
    const set = this.bySession.get(event.sessionId);
    if (set) for (const listener of set) listener(event);
  }
}

/* ─── Montage du gateway ──────────────────────────────────────────────────── */

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
});

const host = new MultiSessionHost([
  {
    id: "sess-A",
    title: "Conversation A",
    user: "Question du fil A",
    assistant: "Réponse historique A.",
  },
  {
    id: "sess-B",
    title: "Conversation B",
    user: "Question du fil B",
    assistant: "Réponse historique B.",
  },
]);
await host.start();

/* ─── Pipeline TTS RÉEL (synthétiseur ENREGISTREUR) ───────────────────────── */
const spoken: string[] = [];
const synthesizer: SegmentSynthesizer = async (request) => {
  spoken.push(request.text);
  return (async function* () {
    yield { type: "format", sampleRate: 16_000, channels: 1 };
    yield { type: "data", bytes: Buffer.alloc(1_600) };
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
  serverVersion: "e2e-multiplex-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  tts: ttsPipeline,
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
const control = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (body: unknown, status = 200): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/run") {
    const sessionId = url.searchParams.get("sessionId") ?? host.currentSessionId() ?? "";
    const text = url.searchParams.get("text") ?? "Texte de fond.";
    const chunks = Number(url.searchParams.get("chunks") ?? "10");
    const delayMs = Number(url.searchParams.get("delayMs") ?? "120");
    try {
      const handle = host.debugRun(sessionId, { reply: text, chunks, delayMs });
      return send({ ok: true, runId: handle.runId, sessionId });
    } catch (error) {
      return send({ ok: false, error: String(error) }, 400);
    }
  }
  if (url.pathname === "/transcript") {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    return send({ text: host.debugTranscript(sessionId) });
  }
  if (url.pathname === "/sessions") {
    return send({ ids: host.debugSessionIds(), current: host.currentSessionId() ?? null });
  }
  if (url.pathname === "/job-activity") {
    const sessionId = url.searchParams.get("sessionId") ?? host.currentSessionId() ?? "";
    host.debugEmitActivity(sessionId, url.searchParams.get("stage") ?? "job_started", {
      ...(url.searchParams.get("jobId") !== null ? { jobId: url.searchParams.get("jobId")! } : {}),
      ...(url.searchParams.get("task") !== null ? { task: url.searchParams.get("task")! } : {}),
      ...(url.searchParams.get("detail") !== null ? { detail: url.searchParams.get("detail")! } : {}),
      ...(url.searchParams.get("status") !== null ? { status: url.searchParams.get("status")! } : {}),
    });
    return send({ ok: true });
  }
  if (url.pathname === "/spoken") {
    return send({ spoken });
  }
  if (url.pathname === "/spoken-reset") {
    spoken.length = 0;
    return send({ ok: true });
  }
  return send({ error: "unknown" }, 404);
});
await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
const controlAddress = control.address() as AddressInfo;
console.log(`CONTROL http://127.0.0.1:${controlAddress.port}`);

setInterval(() => {}, 1 << 30);
