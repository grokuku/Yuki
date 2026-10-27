/**
 * Harnais E2E JETABLE — RESTAURATION DE L'ACTIVITÉ AU RETOUR SUR UN FIL.
 *
 * Il sert la page de discussion `/` sous la CSP réelle, avec un host Pi
 * MULTI-SESSION dont les runs sont DÉTERMINISTES :
 *   - un run démarre (`state: "streaming"`, `run_started`) puis RESTE SUSPENDU
 *     tant que le serveur de contrôle n'a pas relâché son contenu (/release) ⇒
 *     la fenêtre « run en cours, AUCUN contenu encore produit » est stable, donc
 *     mesurable (pas de course avec un flux) ;
 *   - des jobs d'arrière-plan peuvent être ouverts/fermés à la demande
 *     (/job-start, /job-finish) : ils figurent dans `getState()` comme les jobs
 *     d'un VRAI `JobStore`.
 *
 * ⚠️ `getState()` reproduit ce que le VRAI `buildState` (src/pi/sdk-host.ts)
 * expose désormais : `awaitingFirstToken` (run sans contenu) et `jobs` (jobs NON
 * terminaux). C'est l'ÉTAT VIVANT que le snapshot transporte jusqu'au navigateur.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-activity-restore-serve.ts"
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
  SessionJobInfo,
  SessionState,
  TranscriptEntry,
} from "../../src/pi/types.js";
import type { SegmentSynthesizer, TtsPipelineDeps } from "../../src/tts/index.js";
import type { GpuReport } from "../../src/types/gpu.js";

/* ─── Host Pi MULTI-SESSION (double), runs SUSPENDUS ─────────────────────── */

interface PendingStream {
  runId: string;
  parts: string[];
  delayMs: number;
}

interface Rec {
  id: string;
  file: string;
  title: string;
  transcript: TranscriptEntry[];
  state: PiSessionStateName;
  activeRunId?: string;
  partial: string;
  /** Run démarré mais SANS contenu émis (attente du /release). */
  pending?: PendingStream;
  timers: NodeJS.Timeout[];
  generation: number;
  updatedAt: string;
  /** Jobs NON terminaux de cette conversation (comme un `JobStore`). */
  jobs: SessionJobInfo[];
}

function chunk(text: string, parts: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / Math.max(1, parts)));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

class SuspendedRunHost implements PiHost {
  private readonly listeners = new Set<PiEventListener>();
  private readonly bySession = new Map<string, Set<PiEventListener>>();
  private readonly sessions = new Map<string, Rec>();
  private focusedId: string | undefined;
  private ready = false;

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
        jobs: [],
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
    const id = `sess-new-${this.sessions.size + 1}`;
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
      jobs: [],
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
      chunks: 6,
      delayMs: 80,
      hold: false,
    });
  }

  /* --- pilotage par le serveur de contrôle ------------------------------- */

  /** Démarre un run SUSPENDU (aucun contenu tant que `release` n'a pas été appelé). */
  debugRunHeld(sessionId: string, reply: string, chunks: number, delayMs: number): RunHandle {
    return this.startRun(sessionId, { reply, chunks, delayMs, hold: true });
  }

  /** Relâche le run suspendu : son contenu streame puis le run se termine. */
  debugRelease(sessionId: string): boolean {
    const rec = this.sessions.get(sessionId);
    if (!rec || !rec.pending) return false;
    const { runId, parts, delayMs } = rec.pending;
    rec.pending = undefined;
    this.stream(rec, runId, parts, delayMs, "");
    return true;
  }

  /** Ouvre un job d'arrière-plan NON terminal (comme un `delegate` de fond). */
  debugJobStart(sessionId: string, jobId: string, task: string): boolean {
    const rec = this.sessions.get(sessionId);
    if (!rec) return false;
    if (!rec.jobs.some((job) => job.jobId === jobId)) {
      rec.jobs.push({
        jobId,
        task,
        status: "running",
        startedAt: new Date().toISOString(),
      });
    }
    this.emit({ type: "job_started", sessionId, jobId, task });
    return true;
  }

  /** Termine un job (statut TERMINAL) : il sort de l'état du fil. */
  debugJobFinish(sessionId: string, jobId: string): boolean {
    const rec = this.sessions.get(sessionId);
    if (!rec) return false;
    const before = rec.jobs.length;
    rec.jobs = rec.jobs.filter((job) => job.jobId !== jobId);
    this.emit({ type: "job_finished", sessionId, jobId, status: "completed" });
    return rec.jobs.length !== before;
  }

  debugTranscript(sessionId: string): string {
    const rec = this.sessions.get(sessionId);
    if (!rec) return "";
    return [...rec.transcript, ...(rec.partial ? [{ role: "assistant" as const, text: rec.partial }] : [])]
      .map((entry) => entry.text)
      .join("\n");
  }

  async abort(sessionId: string, runId?: string): Promise<void> {
    const rec = this.sessions.get(sessionId);
    if (!rec) return;
    if (runId && rec.activeRunId !== runId) return;
    this.cancelRun(rec, "abort");
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

  // --- interne -----------------------------------------------------------

  /** ⚠️ MÊME contenu d'état que le VRAI `buildState` du host Pi. */
  private stateOf(id: string | undefined): SessionState {
    const rec = id ? this.sessions.get(id) : undefined;
    if (!rec) return { sessionId: id ?? "", state: "idle", transcript: [] };
    return {
      sessionId: rec.id,
      state: rec.state,
      ...(rec.activeRunId ? { activeRunId: rec.activeRunId } : {}),
      ...(rec.state === "streaming"
        ? { awaitingFirstToken: rec.partial.length === 0 }
        : {}),
      ...(rec.jobs.length > 0 ? { jobs: rec.jobs.map((job) => ({ ...job })) } : {}),
      transcript: [
        ...rec.transcript,
        ...(rec.partial ? [{ role: "assistant" as const, text: rec.partial }] : []),
      ],
    };
  }

  private startRun(
    sessionId: string,
    spec: { reply: string; chunks: number; delayMs: number; hold: boolean },
  ): RunHandle {
    const rec = this.sessions.get(sessionId);
    if (!rec) throw new Error(`Session inconnue : ${sessionId}`);
    if (rec.activeRunId) this.cancelRun(rec, "superseded");
    rec.generation += 1;
    const runId = randomUUID();
    rec.state = "streaming";
    rec.activeRunId = runId;
    rec.partial = "";
    rec.updatedAt = new Date().toISOString();
    this.emit({ type: "state", sessionId, state: "streaming", activeRunId: runId });
    this.emit({ type: "run_started", sessionId, runId });
    const parts = chunk(spec.reply, spec.chunks);
    if (spec.hold) {
      rec.pending = { runId, parts, delayMs: spec.delayMs };
    } else {
      this.stream(rec, runId, parts, spec.delayMs, "");
    }
    return { runId, sessionId, queued: false };
  }

  private stream(
    rec: Rec,
    runId: string,
    parts: string[],
    delayMs: number,
    initial: string,
  ): void {
    const gen = rec.generation;
    let acc = initial;
    const step = (index: number): void => {
      const timer = setTimeout(() => {
        if (gen !== rec.generation) return;
        if (index >= parts.length) {
          rec.transcript.push({ role: "assistant", text: acc });
          rec.partial = "";
          rec.state = "idle";
          rec.activeRunId = undefined;
          this.emit({ type: "run_finished", sessionId: rec.id, runId, reason: "done" });
          this.emit({ type: "state", sessionId: rec.id, state: "idle" });
          return;
        }
        const piece = parts[index] ?? "";
        acc += piece;
        rec.partial = acc;
        this.emit({
          type: "delta",
          sessionId: rec.id,
          runId,
          channel: "content",
          text: piece,
        });
        step(index + 1);
      }, Math.max(0, delayMs));
      rec.timers.push(timer);
    };
    step(0);
  }

  private cancelRun(rec: Rec, reason: string): void {
    const runId = rec.activeRunId;
    for (const timer of rec.timers) clearTimeout(timer);
    rec.timers = [];
    rec.generation += 1;
    rec.pending = undefined;
    rec.activeRunId = undefined;
    rec.state = "idle";
    rec.partial = "";
    if (runId) {
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

/* ─── Montage du gateway ─────────────────────────────────────────────────── */

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
});

const host = new SuspendedRunHost([
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

/* Pipeline TTS RÉEL (synthétiseur ENREGISTREUR) : un fil de fond doit rester MUET. */
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
  serverVersion: "e2e-activity-restore-0.1.0",
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
  const sessionId = url.searchParams.get("sessionId") ?? host.currentSessionId() ?? "";
  if (url.pathname === "/run-held") {
    const text = url.searchParams.get("text") ?? "Réponse tenue.";
    const chunks = Number(url.searchParams.get("chunks") ?? "6");
    const delayMs = Number(url.searchParams.get("delayMs") ?? "60");
    try {
      const handle = host.debugRunHeld(sessionId, text, chunks, delayMs);
      return send({ ok: true, runId: handle.runId, sessionId });
    } catch (error) {
      return send({ ok: false, error: String(error) }, 400);
    }
  }
  if (url.pathname === "/release") {
    return send({ ok: host.debugRelease(sessionId) });
  }
  if (url.pathname === "/job-start") {
    const jobId = url.searchParams.get("jobId") ?? "job-1";
    const task = url.searchParams.get("task") ?? "tâche de fond";
    return send({ ok: host.debugJobStart(sessionId, jobId, task) });
  }
  if (url.pathname === "/job-finish") {
    const jobId = url.searchParams.get("jobId") ?? "job-1";
    return send({ ok: host.debugJobFinish(sessionId, jobId) });
  }
  if (url.pathname === "/transcript") {
    return send({ text: host.debugTranscript(sessionId) });
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
