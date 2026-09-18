/**
 * Flux par session : buffer annulaire borné, compteur `seq` monotone, rejeu et
 * snapshot.
 *
 * Le buffer vit AU-DESSUS de l'abonnement au PiHost : les événements émis sans
 * client connecté sont déjà bufferisés. Le rejeu est strictement `seq > fromSeq`.
 * Si la fenêtre demandée est dépassée, on renvoie un `snapshot` (état courant +
 * transcript contenu seul + `seq` courant) et le client réinitialise son rendu.
 */

import type { PiSessionStateName, TranscriptEntry } from "../../pi/types.js";
import type { ServerEnvelope, ServerFrame, ServerMessage } from "./protocol.js";

export interface StreamStateProvider {
  state: PiSessionStateName;
  activeRunId?: string;
  transcript: TranscriptEntry[];
}

export interface SnapshotPayload {
  seq: number;
  state: PiSessionStateName;
  activeRunId?: string;
  transcript: TranscriptEntry[];
}

export type ReplayResult =
  | { mode: "replay"; frames: ServerFrame[] }
  | { mode: "snapshot"; frames: ServerFrame[]; snapshot: SnapshotPayload };

export interface SessionStreamOptions {
  sessionId: string;
  bufferSize: number;
  bufferBytes: number;
  now?: () => number;
  snapshotSource?: () => StreamStateProvider | undefined;
}

export type FrameListener = (frame: ServerFrame) => void;

function estimateBytes(frame: ServerFrame): number {
  return Buffer.byteLength(JSON.stringify(frame), "utf8");
}

/** Buffer borné et compteur `seq` d'UNE session. */
export class SessionStream {
  readonly sessionId: string;
  private readonly bufferSize: number;
  private readonly bufferBytes: number;
  private readonly now: () => number;
  private readonly snapshotSource?: () => StreamStateProvider | undefined;

  private frames: ServerFrame[] = [];
  private bytes = 0;
  private counter = 0;
  private readonly listeners = new Set<FrameListener>();

  constructor(options: SessionStreamOptions) {
    this.sessionId = options.sessionId;
    this.bufferSize = Math.max(0, Math.floor(options.bufferSize));
    this.bufferBytes = Math.max(0, Math.floor(options.bufferBytes));
    this.now = options.now ?? Date.now;
    this.snapshotSource = options.snapshotSource;
  }

  /** Dernier `seq` attribué (0 si aucune trame). */
  get seq(): number {
    return this.counter;
  }

  /** Nombre de trames conservées. */
  get size(): number {
    return this.frames.length;
  }

  get byteSize(): number {
    return this.bytes;
  }

  /** Enveloppe à réutiliser pour une trame de contrôle (ne consomme pas de seq). */
  envelope(): ServerEnvelope {
    return {
      seq: this.counter,
      ts: new Date(this.now()).toISOString(),
      sessionId: this.sessionId,
    };
  }

  /** Attribue le prochain `seq`, bufferise et diffuse. */
  append(message: ServerMessage): ServerFrame {
    this.counter += 1;
    const frame: ServerFrame = {
      seq: this.counter,
      ts: new Date(this.now()).toISOString(),
      sessionId: this.sessionId,
      ...message,
    };
    this.buffer(frame);
    for (const listener of this.listeners) {
      listener(frame);
    }
    return frame;
  }

  private buffer(frame: ServerFrame): void {
    this.frames.push(frame);
    this.bytes += estimateBytes(frame);
    while (
      this.frames.length > this.bufferSize ||
      (this.frames.length > 0 && this.bytes > this.bufferBytes)
    ) {
      const removed = this.frames.shift();
      if (!removed) break;
      this.bytes -= estimateBytes(removed);
    }
  }

  /** Rejoue strictement `seq > fromSeq`, ou renvoie un snapshot si dépassé. */
  replay(fromSeq: number): ReplayResult {
    if (fromSeq >= this.counter) {
      return { mode: "replay", frames: [] };
    }
    const first = this.frames[0];
    if (!first || first.seq > fromSeq + 1) {
      return { mode: "snapshot", frames: [], snapshot: this.snapshot() };
    }
    return {
      mode: "replay",
      frames: this.frames.filter((frame) => frame.seq > fromSeq),
    };
  }

  /** Instantané de l'état courant (transcript = contenu seul). */
  snapshot(): SnapshotPayload {
    const source = this.snapshotSource?.();
    if (!source) {
      return { seq: this.counter, state: "idle", transcript: [] };
    }
    return {
      seq: this.counter,
      state: source.state,
      ...(source.activeRunId ? { activeRunId: source.activeRunId } : {}),
      transcript: source.transcript.map((entry) => ({
        role: entry.role,
        text: entry.text,
      })),
    };
  }

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export interface SessionStreamStoreOptions {
  bufferSize: number;
  bufferBytes: number;
  now?: () => number;
  snapshotSource?: (sessionId: string) => StreamStateProvider | undefined;
}

/** Registre des flux, un par session. */
export class SessionStreamStore {
  private readonly streams = new Map<string, SessionStream>();
  private readonly options: SessionStreamStoreOptions;

  constructor(options: SessionStreamStoreOptions) {
    this.options = options;
  }

  /** Capacité configurée (pour /health). */
  get bufferSize(): number {
    return this.options.bufferSize;
  }

  get bufferBytes(): number {
    return this.options.bufferBytes;
  }

  get count(): number {
    return this.streams.size;
  }

  has(sessionId: string): boolean {
    return this.streams.has(sessionId);
  }

  /** Récupère ou crée le flux d'une session. */
  get(sessionId: string): SessionStream {
    const existing = this.streams.get(sessionId);
    if (existing) return existing;
    const stream = new SessionStream({
      sessionId,
      bufferSize: this.options.bufferSize,
      bufferBytes: this.options.bufferBytes,
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.snapshotSource
        ? { snapshotSource: () => this.options.snapshotSource?.(sessionId) }
        : {}),
    });
    this.streams.set(sessionId, stream);
    return stream;
  }
}
