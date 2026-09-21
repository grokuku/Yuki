/**
 * Pipeline TTS côté gateway (Lot 7, Lot B) — file + prefetch + producteur unique.
 *
 * Branché **hors du chemin critique** des deltas : `onContent` ne fait que
 * segmenter et mettre en file (aucun `await`), la synthèse tourne dans une boucle
 * asynchrone distincte. Invariants repris de pithagoras (spec §1, D3) :
 *   - **producteur unique** : une seule synthèse en vol à la fois (le moteur
 *     `audio.cpp` sérialise de toute façon via son `BusyGuard`) ;
 *   - **prefetch borné** : au plus `tts.prefetchDepth` phrases préparées d'avance
 *     (+ la phrase en cours) ;
 *   - **ordre garanti** : chaque segment porte un index strictement croissant ;
 *   - **purge** : toute interruption vide la file et annule la synthèse en vol.
 *
 * Le pipeline est un **no-op total** si `tts.enabled !== "on"` : aucune trame,
 * aucune erreur, aucun blocage. Un moteur injoignable ou un segment en échec est
 * **journalisé puis abandonné** (retry borné), sans jamais casser le run texte.
 */

import { PHASE } from "../pi/instrumentation.js";
import { AudioCppError, type TtsLogger } from "./audio-cpp.js";
import {
  encodeTtsFrame,
  TTS_FRAME_CODEC,
  TTS_FRAME_VERSION,
  type TtsFrameHeader,
} from "./framing.js";
import { readTtsOptions } from "./options.js";
import { SentenceSegmenter } from "./segmenter.js";
import type { AudioStreamEvent, SegmentSynthesizer } from "./synthesizer.js";
import type { Voice } from "./types.js";

/** Métriques TTS cumulées d'un run (alimente `run_summary`). */
export interface TtsRunMetrics {
  ttfaMs?: number;
  ttsSynthMs?: number;
  ttsSegments?: number;
}

/** Segment prêt à synthétiser (texte + index monotone). */
export interface TtsSegment {
  index: number;
  text: string;
}

/**
 * File FIFO bornée du producteur : `capacity` = `prefetchDepth + 1` (la phrase
 * en cours + les phrases préparées d'avance). Au-delà, les segments émis restent
 * **en attente** (`staged`) et ne sont pas perdus : ils entrent dès qu'une place
 * se libère. `staged` ne bloque jamais l'appelant (le texte brut est bon marché).
 */
export class TtsQueue {
  private readonly ready: TtsSegment[] = [];
  private readonly staged: TtsSegment[] = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  push(segment: TtsSegment): void {
    this.staged.push(segment);
    this.refill();
  }

  shift(): TtsSegment | undefined {
    const segment = this.ready.shift();
    if (segment) this.refill();
    return segment;
  }

  clear(): void {
    this.ready.length = 0;
    this.staged.length = 0;
  }

  /** Segments « préparés » (visibles du producteur). */
  get size(): number {
    return this.ready.length;
  }

  /** Segments en attente de place (non perdus). */
  get pending(): number {
    return this.staged.length;
  }

  get total(): number {
    return this.ready.length + this.staged.length;
  }

  private refill(): void {
    while (this.ready.length < this.capacity && this.staged.length > 0) {
      this.ready.push(this.staged.shift()!);
    }
  }
}

/** Lecteur minimal de configuration (compatible `ConfigRuntime`). */
export interface TtsPipelineConfig {
  getString(path: string): string;
  getNumber(path: string): number;
}

export interface TtsPipelineDeps {
  /** `tts.enabled === "on"`. Sinon, le pipeline est un no-op total. */
  enabled: boolean;
  config: TtsPipelineConfig;
  synthesizer: SegmentSynthesizer;
  /**
   * Résout l'id de voix configuré (`tts.voice`) en voix à utiliser : un id
   * **vide ou inconnu** retombe sur la voix **par défaut** du registre (premier
   * preset), `null` = aucune voix disponible. C'est le MÊME résolveur que
   * l'aperçu et le test (câblage `src/index.ts` via `VoiceStore.resolveVoice`).
   */
  resolveVoice: (id: string) => Voice | null;
  logger: TtsLogger;
  now?: () => number;
  /** Nombre de réessais bornés après un échec *retryable*. */
  maxRetries?: number;
  /** Délai avant le réessai `attempt` (0-indexé). */
  retryDelayMs?: (attempt: number) => number;
  /** Sommeil annulable (injectable pour les tests). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface TtsPipelineCallbacks {
  emitAudio(sessionId: string, frame: Buffer): void;
  emitControl(sessionId: string, frame: Buffer): void;
  onStage(sessionId: string, runId: string, stage: string): void;
  onMetrics(sessionId: string, runId: string, metrics: TtsRunMetrics): void;
}

interface TtsRun {
  sessionId: string;
  runId: string;
  t0: number;
  segmenter: SentenceSegmenter;
  queue: TtsQueue;
  nextIndex: number;
  running: boolean;
  finished: boolean;
  aborted: boolean;
  endSent: boolean;
  inflight?: AbortController;
  firstByteAt?: number;
  synthMs: number;
  segmentsDone: number;
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** Pipeline TTS : orchestration segmentation → file → synthèse → trames. */
export class TtsPipeline {
  private readonly runs = new Map<string, TtsRun>();
  private readonly now: () => number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: (attempt: number) => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(
    private readonly deps: TtsPipelineDeps,
    private readonly callbacks: TtsPipelineCallbacks,
  ) {
    this.now = deps.now ?? Date.now;
    this.maxRetries = Math.max(0, deps.maxRetries ?? 2);
    this.retryDelayMs = deps.retryDelayMs ?? ((attempt) => 250 * 2 ** attempt);
    this.sleep = deps.sleep ?? sleepAbortable;
  }

  /** `true` si le pipeline produit réellement (`tts.enabled === "on"`). */
  get active(): boolean {
    return this.deps.enabled;
  }

  /** Nombre de runs TTS suivis (testable). */
  get runCount(): number {
    return this.runs.size;
  }

  /**
   * Début d'un tour. Un **nouveau tour annule** toute voix résiduelle des tours
   * précédents (spec §7 : « la voix de la réponse précédente ne survit jamais à
   * un nouveau tour »).
   */
  onRunStarted(sessionId: string, runId: string, t0?: number): void {
    if (!this.deps.enabled) return;
    for (const other of [...this.runs.values()]) {
      if (other.sessionId === sessionId && other.runId !== runId) {
        this.cancelRun(other, "superseded");
      }
    }
    const prefetch = Math.max(0, Math.floor(this.deps.config.getNumber("tts.prefetchDepth")));
    this.runs.set(runId, {
      sessionId,
      runId,
      t0: t0 ?? this.now(),
      segmenter: new SentenceSegmenter({
        minChars: this.deps.config.getNumber("tts.minSentenceChars"),
        maxChars: this.deps.config.getNumber("tts.maxSentenceChars"),
      }),
      queue: new TtsQueue(prefetch + 1),
      nextIndex: 0,
      running: false,
      finished: false,
      aborted: false,
      endSent: false,
      synthMs: 0,
      segmentsDone: 0,
    });
  }

  /** Delta du canal **`content`** : segmenter et mettre en file. Jamais bloquant. */
  onContent(sessionId: string, runId: string, text: string): void {
    if (!this.deps.enabled) return;
    const run = this.runs.get(runId);
    if (!run || run.aborted || run.sessionId !== sessionId) return;
    for (const segment of run.segmenter.push(text)) {
      this.enqueue(run, segment);
    }
    this.kick(run);
  }

  /** Fin de run : flush du résidu, puis purge si le run n'a pas abouti. */
  onRunFinished(sessionId: string, runId: string, reason: string): void {
    if (!this.deps.enabled) return;
    const run = this.runs.get(runId);
    if (!run || run.sessionId !== sessionId) return;
    for (const segment of run.segmenter.flush()) {
      this.enqueue(run, segment);
    }
    run.finished = true;
    // Métriques disponibles au moment du `run_summary` (émis juste après).
    this.emitMetrics(run);
    if (reason !== "done") {
      this.cancelRun(run, reason);
      return;
    }
    this.kick(run);
    this.maybeFinish(run);
  }

  /** Purge/annulation : vide la file et abandonne la synthèse en vol. */
  cancel(sessionId: string, runId?: string): void {
    if (!this.deps.enabled) return;
    for (const run of [...this.runs.values()]) {
      if (run.sessionId !== sessionId) continue;
      if (runId && run.runId !== runId) continue;
      this.cancelRun(run, "abort");
    }
  }

  /** Purge de toutes les sessions (arrêt du transport). */
  cancelAll(): void {
    for (const run of [...this.runs.values()]) {
      this.cancelRun(run, "shutdown");
    }
  }

  // --- interne ---------------------------------------------------------------

  private enqueue(run: TtsRun, text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.stage(run, PHASE.sentenceSegmented);
    run.queue.push({ index: run.nextIndex, text: trimmed });
    run.nextIndex += 1;
    this.stage(run, PHASE.ttsQueued);
  }

  private kick(run: TtsRun): void {
    if (run.running || run.aborted) return;
    run.running = true;
    void this.loop(run);
  }

  private async loop(run: TtsRun): Promise<void> {
    try {
      for (;;) {
        if (run.aborted) return;
        const segment = run.queue.shift();
        if (!segment) return;
        await this.synthesizeSegment(run, segment);
      }
    } finally {
      run.running = false;
      if (run.aborted) {
        return;
      }
      if (run.queue.total > 0) {
        // Un segment est arrivé pendant le `await` : on reprend.
        this.kick(run);
        return;
      }
      this.maybeFinish(run);
    }
  }

  private maybeFinish(run: TtsRun): void {
    if (run.aborted || run.running || run.endSent) return;
    if (!run.finished || run.queue.total > 0) return;
    run.endSent = true;
    this.emitControlFrame(run, "tts_end");
    this.runs.delete(run.runId);
  }

  private async synthesizeSegment(run: TtsRun, segment: TtsSegment): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (run.aborted) return;
      const controller = new AbortController();
      run.inflight = controller;
      const requestedAt = this.now();
      try {
        this.stage(run, PHASE.ttsRequested);
        const stream = await this.deps.synthesizer({
          voice: this.resolveVoice(),
          text: segment.text,
          options: readTtsOptions(this.deps.config),
          engine: this.deps.config.getString("tts.engine"),
          signal: controller.signal,
        });
        await this.pump(run, segment, stream, requestedAt);
        if (run.aborted) return;
        this.stage(run, PHASE.ttsSegmentDone);
        this.emitMetrics(run);
        return;
      } catch (error) {
        if (run.aborted || this.isAborted(error)) return;
        if (this.isRetryable(error) && attempt < this.maxRetries) {
          this.stage(run, PHASE.ttsRetry);
          this.deps.logger.warn("tts.segment.retry", {
            run_id: run.runId,
            segment_index: segment.index,
            attempt: attempt + 1,
            error: error instanceof Error ? error.message : String(error),
          });
          await this.sleep(this.retryDelayMs(attempt), controller.signal);
          continue;
        }
        this.deps.logger.warn("tts.segment.failed", {
          run_id: run.runId,
          segment_index: segment.index,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      } finally {
        run.inflight = undefined;
      }
    }
  }

  private async pump(
    run: TtsRun,
    segment: TtsSegment,
    stream: AsyncIterable<AudioStreamEvent>,
    requestedAt: number,
  ): Promise<void> {
    let sampleRate = 24_000;
    let channels = 1;
    let chunkIndex = 0;
    for await (const event of stream) {
      if (run.aborted) return;
      if (event.type === "format") {
        sampleRate = event.sampleRate;
        channels = event.channels;
        continue;
      }
      if (run.firstByteAt === undefined) {
        run.firstByteAt = this.now();
        this.stage(run, PHASE.ttsFirstByte);
        this.emitMetrics(run);
      }
      if (event.bytes.length === 0) continue;
      this.emitAudioFrame(run, segment.index, chunkIndex, sampleRate, channels, event.bytes, false);
      chunkIndex += 1;
    }
    if (run.aborted) return;
    // Bloc de clôture de segment (payload vide, `final: true`).
    this.emitAudioFrame(
      run,
      segment.index,
      chunkIndex,
      sampleRate,
      channels,
      Buffer.alloc(0),
      true,
    );
    run.segmentsDone += 1;
    run.synthMs += Math.max(0, this.now() - requestedAt);
  }

  private resolveVoice(): Voice | null {
    // On DÉLÈGUE toujours, y compris pour un id vide : le résolveur applique la
    // voix par défaut du registre (premier preset). Auparavant, un `tts.voice`
    // vide court-circuitait en `null` → aucun `voice_ref` envoyé au moteur
    // (Chatterbox refusait alors « requires speaker reference audio »).
    const id = this.deps.config.getString("tts.voice").trim();
    const voice = this.deps.resolveVoice(id);
    if (!voice) {
      this.deps.logger.warn("tts.voice.unresolved", { id });
    }
    return voice;
  }

  private cancelRun(run: TtsRun, reason: string): void {
    if (run.aborted) return;
    run.aborted = true;
    run.queue.clear();
    run.segmenter.reset();
    run.inflight?.abort();
    this.stage(run, PHASE.ttsCancel);
    this.emitControlFrame(run, "tts_cancel");
    this.deps.logger.debug("tts.run.cancelled", { run_id: run.runId, reason });
    this.runs.delete(run.runId);
  }

  private stage(run: TtsRun, stage: string): void {
    this.callbacks.onStage(run.sessionId, run.runId, stage);
  }

  private emitMetrics(run: TtsRun): void {
    const metrics: TtsRunMetrics = {
      ttsSegments: run.segmentsDone,
      ttsSynthMs: Math.round(run.synthMs),
    };
    if (run.firstByteAt !== undefined) {
      metrics.ttfaMs = Math.max(0, run.firstByteAt - run.t0);
    }
    this.callbacks.onMetrics(run.sessionId, run.runId, metrics);
  }

  private emitAudioFrame(
    run: TtsRun,
    segmentIndex: number,
    chunkIndex: number,
    sampleRate: number,
    channels: number,
    payload: Buffer,
    final: boolean,
  ): void {
    const header: TtsFrameHeader = {
      v: TTS_FRAME_VERSION,
      type: "tts_audio",
      sessionId: run.sessionId,
      runId: run.runId,
      segmentIndex,
      chunkIndex,
      codec: TTS_FRAME_CODEC,
      sampleRate,
      channels,
      byteLength: payload.length,
      final,
    };
    this.callbacks.emitAudio(run.sessionId, encodeTtsFrame(header, payload));
  }

  private emitControlFrame(run: TtsRun, type: "tts_end" | "tts_cancel"): void {
    const header: TtsFrameHeader = {
      v: TTS_FRAME_VERSION,
      type,
      sessionId: run.sessionId,
      runId: run.runId,
      segmentIndex: run.nextIndex,
      chunkIndex: 0,
      codec: TTS_FRAME_CODEC,
      sampleRate: 0,
      channels: 0,
      byteLength: 0,
      final: true,
    };
    this.callbacks.emitControl(run.sessionId, encodeTtsFrame(header, Buffer.alloc(0)));
  }

  private isAborted(error: unknown): boolean {
    return error instanceof AudioCppError && error.code === "aborted";
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof AudioCppError) {
      return (
        error.code === "server_busy" ||
        error.code === "timeout" ||
        error.code === "network_error"
      );
    }
    return true;
  }
}
