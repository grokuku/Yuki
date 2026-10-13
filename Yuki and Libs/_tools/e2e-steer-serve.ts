/**
 * Harnais E2E JETABLE — « MESSAGE UTILISATEUR PENDANT UNE SORTIE EN COURS ».
 *
 * Gateway RÉEL + CSP réelle + UI réelle (`public/ui`). L'hôte Pi est un double
 * DÉTERMINISTE qui reproduit la sémantique de STEER du VRAI `sdk-host` :
 *   - un message envoyé pendant un run NE lance PAS un nouveau run : il est
 *     versé au transcript (c'est un VRAI message) et le MÊME run continue ;
 *   - le run produit UNE SEULE entrée assistant dans le transcript (comme le
 *     vrai host qui fusionne les messages assistant d'un même run) ;
 *   - aucune nouvelle trame `run_started` n'est émise pour le steer.
 *
 * Le code assistant est diffusé en deux segments : le PREMIER ouvre une fence de
 * code SANS la fermer (l'utilisateur envoie son message à ce moment), le SECOND
 * ferme la fence. La fence n'est donc intacte que si le client garde le MÊME
 * bloc (bug historique : la remise à zéro coupait la fence et le markdown).
 *
 * Serveur de CONTRÔLE (port séparé) : état + transcript de la session.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-steer-serve.ts"
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
import type { GpuReport } from "../../src/types/gpu.js";

/* ─── Contenu du run : fence de code ouverte au segment A, fermée au B ────── */

const CODE_LINES = Array.from({ length: 12 }, (_, i) => `  ligne${i}();`).join("\n");
/** Segment A : ouvre une fence de code SANS la fermer. */
export const SEGMENT_A = `Voici le code demandé :\n\`\`\`js\n${CODE_LINES}`;
/** Segment B : ferme la fence et conclut. */
export const SEGMENT_B = `\n\`\`\`\nVoilà, le code est complet.`;

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
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
}

/** Hôte Pi mono-session reproduisant la sémantique de STEER du vrai host. */
class SteerHost implements PiHost {
  private readonly listeners = new Set<PiEventListener>();
  private readonly bySession = new Map<string, Set<PiEventListener>>();
  private readonly rec: Rec;
  private ready = false;
  /** Nombre de steers reçus (contrôle). */
  private steerCount = 0;
  /** Nombre de `run_started` émis (preuve : le steer n'ouvre PAS de run). */
  private runStartedCount = 0;

  constructor(sessionId: string) {
    this.rec = {
      id: sessionId,
      file: `/fake/${sessionId}.jsonl`,
      title: "Conversation de test",
      transcript: [],
      state: "idle",
      partial: "",
      timers: [],
      generation: 0,
    };
  }

  async start(): Promise<void> {
    this.ready = true;
  }

  isReady(): boolean {
    return this.ready;
  }

  currentSessionId(): string | undefined {
    return this.rec.id;
  }

  async ensureSession(_target?: EnsureSessionOptions): Promise<SessionState> {
    return this.stateOf();
  }

  async newSession(): Promise<SessionState> {
    return this.stateOf();
  }

  async continueRecent(): Promise<SessionState> {
    return this.stateOf();
  }

  async resume(_sessionFile: string): Promise<SessionState> {
    return this.stateOf();
  }

  send(_sessionId: string, text: string, _opts?: SendOptions): RunHandle {
    void _opts;
    if (this.rec.activeRunId) {
      // ⚠️ STEER : un message UTILISATEUR pendant un run est un VRAI message
      // (versé au transcript) et le run EN COURS continue — AUCUN nouveau run.
      this.steerCount += 1;
      this.rec.transcript.push({ role: "user", text, timestamp: Date.now() });
      return { runId: this.rec.activeRunId, sessionId: this.rec.id, queued: false };
    }
    return this.startRun(text);
  }

  async abort(_sessionId: string, _runId?: string): Promise<void> {
    this.cancelRun("abort");
  }

  subscribe(_sessionId: string, listener: PiEventListener): () => void {
    let set = this.bySession.get(this.rec.id);
    if (!set) {
      set = new Set();
      this.bySession.set(this.rec.id, set);
    }
    set.add(listener);
    return () => set?.delete(listener);
  }

  subscribeAll(listener: PiEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  recordRunStage(): void {
    /* non nécessaire */
  }

  recordRunTtsMetrics(): void {
    /* non nécessaire */
  }

  getState(_sessionId?: string): SessionState | undefined {
    return this.stateOf();
  }

  async listSessions(): Promise<SessionInfo[]> {
    return [
      {
        sessionId: this.rec.id,
        sessionFile: this.rec.file,
        title: this.rec.title,
        messageCount: this.rec.transcript.length,
      },
    ];
  }

  async renameSession(_id: string, title: string): Promise<void> {
    this.rec.title = title.replace(/\s+/g, " ").trim() || this.rec.title;
  }

  async setAsideSession(): Promise<void> {
    /* non utilisé */
  }

  async sessionFileFor(): Promise<string | undefined> {
    return this.rec.file;
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.cancelRun("abort");
    this.listeners.clear();
    this.bySession.clear();
  }

  /** Contrôle : rôle + texte du transcript (assistant courant inclus). */
  debugTranscript(): { roles: string[]; texts: string[] } {
    const entries = [...this.rec.transcript];
    if (this.rec.partial) entries.push({ role: "assistant", text: this.rec.partial });
    return {
      roles: entries.map((entry) => entry.role),
      texts: entries.map((entry) => entry.text),
    };
  }

  debugSteerCount(): number {
    return this.steerCount;
  }

  debugRunStartedCount(): number {
    return this.runStartedCount;
  }

  // --- interne -------------------------------------------------------------

  private stateOf(): SessionState {
    const transcript = [...this.rec.transcript];
    if (this.rec.partial) transcript.push({ role: "assistant", text: this.rec.partial });
    return {
      sessionId: this.rec.id,
      state: this.rec.state,
      ...(this.rec.activeRunId ? { activeRunId: this.rec.activeRunId } : {}),
      transcript,
    };
  }

  private startRun(text: string): RunHandle {
    this.rec.generation += 1;
    const gen = this.rec.generation;
    const runId = randomUUID();
    const t0 = Date.now();
    this.rec.transcript.push({ role: "user", text, timestamp: t0 });
    this.rec.state = "streaming";
    this.rec.activeRunId = runId;
    this.rec.partial = "";
    this.runStartedCount += 1;
    this.emit({ type: "state", sessionId: this.rec.id, state: "streaming", activeRunId: runId });
    this.emit({ type: "run_started", sessionId: this.rec.id, runId, userText: text });

    const pieces = [...chunk(SEGMENT_A, 8), ...chunk(SEGMENT_B, 8)];
    let acc = "";
    let firstToken = true;
    const step = (index: number): void => {
      if (gen !== this.rec.generation) return;
      const timer = setTimeout(() => {
        if (gen !== this.rec.generation) return;
        if (index >= pieces.length) {
          // UNE SEULE entrée assistant pour le run (fusion des segments, comme
          // le vrai host qui concatène les messages assistant d'un même run).
          this.rec.transcript.push({ role: "assistant", text: acc, timestamp: Date.now() });
          this.rec.partial = "";
          this.rec.state = "idle";
          this.rec.activeRunId = undefined;
          this.emit({
            type: "run_summary",
            sessionId: this.rec.id,
            runId,
            ttftMs: 42,
            totalMs: Date.now() - t0,
            tokensOut: Math.round(acc.length / 4),
          });
          this.emit({ type: "run_finished", sessionId: this.rec.id, runId, reason: "done" });
          this.emit({ type: "state", sessionId: this.rec.id, state: "idle" });
          return;
        }
        const piece = pieces[index] ?? "";
        acc += piece;
        this.rec.partial = acc;
        if (firstToken) {
          firstToken = false;
          this.emit({
            type: "phase",
            sessionId: this.rec.id,
            runId,
            stage: "first_token",
            sinceT0Ms: Date.now() - t0,
          });
        }
        this.emit({ type: "delta", sessionId: this.rec.id, runId, channel: "content", text: piece });
        step(index + 1);
      }, 80);
      this.rec.timers.push(timer);
    };
    step(0);
    return { runId, sessionId: this.rec.id, queued: false };
  }

  private cancelRun(reason: string): void {
    const runId = this.rec.activeRunId;
    for (const timer of this.rec.timers) clearTimeout(timer);
    this.rec.timers = [];
    this.rec.generation += 1;
    this.rec.activeRunId = undefined;
    this.rec.state = "idle";
    this.rec.partial = "";
    if (runId) {
      this.emit({ type: "run_finished", sessionId: this.rec.id, runId, reason });
      this.emit({ type: "state", sessionId: this.rec.id, state: "idle" });
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

const host = new SteerHost("sess-steer");
await host.start();

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-steer-0.1.0",
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
  if (url.pathname === "/state") {
    const state = host.getState();
    return send({
      state: state?.state ?? null,
      steerCount: host.debugSteerCount(),
      runStartedCount: host.debugRunStartedCount(),
    });
  }
  if (url.pathname === "/transcript") {
    const t = host.debugTranscript();
    return send({ roles: t.roles, texts: t.texts, joined: t.texts.join("\n") });
  }
  return send({ error: "unknown" }, 404);
});
await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
const controlAddress = control.address() as AddressInfo;
console.log(`CONTROL http://127.0.0.1:${controlAddress.port}`);

setInterval(() => {}, 1 << 30);
