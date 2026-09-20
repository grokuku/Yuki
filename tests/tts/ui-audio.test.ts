/**
 * Tests unitaires — logique audio CLIENT (Lot 7, Lot C).
 *
 * Le module `public/ui/tts-player.js` isole l'ordonnancement/lecture et reçoit
 * une **fabrique d'AudioContext injectable** : on teste donc la logique pure
 * (ordre, coussin, purge, sourdine, contexte suspendu) avec une doublure, sans
 * vrai son ni navigateur. Le décodeur `YTA1` client est testé de même.
 */

import { describe, expect, it } from "vitest";

import { decodeTtsFrame } from "../../public/ui/tts-frames.js";
import { createTtsPlayer } from "../../public/ui/tts-player.js";
import {
  createTtsPreference,
  readMuted,
  resolveSpeechState,
  writeMuted,
} from "../../public/ui/tts-preference.js";

type AnyRecord = Record<string, unknown>;

interface DecodedFrame {
  header: Record<string, unknown>;
  payload: Uint8Array;
}

/* ─── Doublure Web Audio ────────────────────────────────────────────────── */

class FakeAudioBuffer {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  duration: number;
  channels: Float32Array[];
  constructor(channels: number, frames: number, sampleRate: number) {
    this.numberOfChannels = channels;
    this.length = frames;
    this.sampleRate = sampleRate;
    this.duration = frames / sampleRate;
    this.channels = Array.from({ length: channels }, () => new Float32Array(frames));
  }
  getChannelData(channel: number): Float32Array {
    return this.channels[channel] as Float32Array;
  }
}

class FakeSource {
  ctx: FakeAudioContext;
  buffer: FakeAudioBuffer | null = null;
  startTime: number | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  connected: unknown = null;
  constructor(ctx: FakeAudioContext) {
    this.ctx = ctx;
  }
  connect(node: unknown): void {
    this.connected = node;
  }
  disconnect(): void {}
  start(when?: number): void {
    this.startTime = typeof when === "number" ? when : this.ctx.currentTime;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeGain {
  gain = { value: 1 };
  destination: unknown = null;
  connect(node: unknown): void {
    this.destination = node;
  }
  disconnect(): void {}
}

interface FakeContextOptions {
  state?: string;
  currentTime?: number;
  resumeImpl?: (() => Promise<void>) | null;
}

class FakeAudioContext {
  state: string;
  currentTime: number;
  sampleRate = 48000;
  destination: unknown = { name: "destination" };
  sources: FakeSource[] = [];
  buffers: FakeAudioBuffer[] = [];
  resumeCalls = 0;
  resumeImpl: (() => Promise<void>) | null;
  constructor(options: FakeContextOptions = {}) {
    this.state = options.state ?? "running";
    this.currentTime = options.currentTime ?? 0;
    this.resumeImpl = options.resumeImpl ?? null;
  }
  createBuffer(channels: number, frames: number, sampleRate: number): FakeAudioBuffer {
    const buffer = new FakeAudioBuffer(channels, frames, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource(this);
    this.sources.push(source);
    return source;
  }
  createGain(): FakeGain {
    return new FakeGain();
  }
  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.resumeImpl) return this.resumeImpl();
    this.state = "running";
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }
  decodeAudioData(): Promise<FakeAudioBuffer> {
    return Promise.resolve(new FakeAudioBuffer(1, 480, 48000));
  }
}

/* ─── Encodage d'une trame YTA1 de test ─────────────────────────────────── */

function makeFrame(header: AnyRecord, payload: ArrayLike<number> = []): Uint8Array {
  const headerJson = new TextEncoder().encode(
    JSON.stringify({ ...header, byteLength: payload.length }),
  );
  const out = new Uint8Array(8 + headerJson.length + payload.length);
  out.set([0x59, 0x54, 0x41, 0x31], 0); // "YTA1"
  out[4] = (headerJson.length >>> 24) & 0xff;
  out[5] = (headerJson.length >>> 16) & 0xff;
  out[6] = (headerJson.length >>> 8) & 0xff;
  out[7] = headerJson.length & 0xff;
  out.set(headerJson, 8);
  out.set(payload, 8 + headerJson.length);
  return out;
}

function audioFrame(overrides: AnyRecord = {}, payload: number[] = []): Uint8Array {
  return makeFrame(
    {
      v: 1,
      type: "tts_audio",
      runId: "r1",
      sessionId: "s1",
      segmentIndex: 0,
      chunkIndex: 0,
      codec: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
      final: false,
      ...overrides,
    },
    payload,
  );
}

/** Décode en garantissant une trame non nulle (pratique de test). */
function decodeOk(input: ArrayBuffer | Uint8Array): DecodedFrame {
  const decoded = decodeTtsFrame(input);
  if (!decoded) throw new Error("trame de test indécodable");
  return decoded as unknown as DecodedFrame;
}

/* ─── Décodeur YTA1 ─────────────────────────────────────────────────────── */

describe("décodeur YTA1 client (défensif)", () => {
  it("décode une trame valide (JSON + payload)", () => {
    const frame = audioFrame({}, [1, 2, 3, 4]);
    const decoded = decodeOk(frame);
    expect(decoded.header.type).toBe("tts_audio");
    expect(decoded.header.runId).toBe("r1");
    expect(decoded.header.sampleRate).toBe(16000);
    expect(decoded.payload.byteLength).toBe(4);
  });

  it("accepte ArrayBuffer et Uint8Array", () => {
    const frame = audioFrame({}, [9, 9]);
    expect(decodeTtsFrame(frame.buffer as ArrayBuffer)).not.toBeNull();
    expect(decodeTtsFrame(new Uint8Array(frame))).not.toBeNull();
  });

  it("renvoie null sur magic invalide, trame tronquée ou entrée non binaire", () => {
    expect(decodeTtsFrame(null as unknown as ArrayBuffer)).toBeNull();
    expect(decodeTtsFrame(42 as unknown as ArrayBuffer)).toBeNull();
    expect(decodeTtsFrame(new Uint8Array([0, 1, 2]))).toBeNull();
    const bad = audioFrame({}, [1, 2]);
    bad[0] = 0x00; // magic cassé
    expect(decodeTtsFrame(bad)).toBeNull();
  });

  it("renvoie null sur JSON illisible ou type inconnu", () => {
    const truncated = audioFrame({}, [1, 2]);
    truncated[4] = 0xff; // headerLen annoncé plus grand que la trame
    expect(decodeTtsFrame(truncated)).toBeNull();

    const unknown = makeFrame({ v: 1, type: "tts_bogus" }, []);
    expect(decodeTtsFrame(unknown)).toBeNull();
  });

  it("renvoie null si byteLength ne correspond pas au payload réel", () => {
    const headerJson = new TextEncoder().encode(
      JSON.stringify({ v: 1, type: "tts_audio", byteLength: 999 }),
    );
    const out = new Uint8Array(8 + headerJson.length);
    out.set([0x59, 0x54, 0x41, 0x31], 0);
    out[7] = headerJson.length;
    out.set(headerJson, 8);
    expect(decodeTtsFrame(out)).toBeNull();
  });
});

/* ─── Lecteur : ordre, coussin, purge, contexte suspendu ────────────────── */

interface PlayerOptions {
  cushionMs?: number;
  volume?: number;
  contextOptions?: FakeContextOptions;
}

function makePlayer(options: PlayerOptions = {}) {
  const ctx = new FakeAudioContext(options.contextOptions ?? {});
  const events: Array<{ type: string; runId: string }> = [];
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const player = createTtsPlayer({
    audioContextFactory: () => ctx,
    logger,
    onEvent: (event: { type: string; runId: string }) => events.push(event),
    startupCushionMs: options.cushionMs ?? 100,
    ...(options.volume !== undefined ? { volume: options.volume } : {}),
  });
  return { player, ctx, events };
}

describe("lecteur TTS — ordonnancement et coussin", () => {
  it("respecte l'ordre des segments et enchaîne sans trou", () => {
    const { player, ctx } = makePlayer({ cushionMs: 100 });
    // Segment 0 : 2 chunks (2 + 2 octets = 2 frames de 16 bits) puis clôture.
    player.handleFrame(decodeOk(audioFrame({ segmentIndex: 0, chunkIndex: 0 }, [0, 0])));
    player.handleFrame(decodeOk(audioFrame({ segmentIndex: 0, chunkIndex: 1 }, [0, 0])));
    player.handleFrame(
      decodeOk(audioFrame({ segmentIndex: 0, chunkIndex: 2, final: true }, [])),
    );
    // Segment 1 : clôture directe, 2 octets = 1 frame.
    player.handleFrame(decodeOk(audioFrame({ segmentIndex: 1, chunkIndex: 0 }, [0, 0])));
    player.handleFrame(
      decodeOk(audioFrame({ segmentIndex: 1, chunkIndex: 1, final: true }, [])),
    );

    expect(ctx.sources).toHaveLength(2);
    // 2 frames pour le segment 0, 1 frame pour le segment 1.
    expect(ctx.buffers[0]?.length).toBe(2);
    expect(ctx.buffers[1]?.length).toBe(1);
    // Coussin appliqué au premier segment : 0 + 100 ms.
    expect(ctx.sources[0]?.startTime).toBeCloseTo(0.1, 6);
    // Second segment enchaîné EXACTEMENT après le premier (2/16000 s).
    expect(ctx.sources[1]?.startTime).toBeCloseTo(0.1 + 2 / 16000, 6);
  });

  it("concatène les chunks quel que soit leur ordre d'arrivée", () => {
    const { player, ctx } = makePlayer();
    player.handleFrame(decodeOk(audioFrame({ chunkIndex: 1 }, [0, 0])));
    player.handleFrame(decodeOk(audioFrame({ chunkIndex: 2, final: true }, [])));
    // Chunk 0 arrive en dernier : le segment ne se monte qu'à ce moment.
    player.handleFrame(decodeOk(audioFrame({ chunkIndex: 0 }, [0, 0])));
    expect(ctx.sources).toHaveLength(1);
    expect(ctx.buffers[0]?.length).toBe(2);
  });

  it("tolère un segment perdu (trou journalisé, pas d'attente infinie)", () => {
    const { player, ctx } = makePlayer();
    // Segment 0 absent ; segment 5 arrive directement.
    player.handleFrame(decodeOk(audioFrame({ segmentIndex: 5, chunkIndex: 0 }, [0, 0])));
    player.handleFrame(
      decodeOk(audioFrame({ segmentIndex: 5, chunkIndex: 1, final: true }, [0, 0])),
    );
    expect(ctx.sources).toHaveLength(1);
  });

  it("émet `started` une seule fois, avec le bon runId", () => {
    const { player, events } = makePlayer();
    player.handleFrame(decodeOk(audioFrame({ segmentIndex: 0 }, [0, 0])));
    player.handleFrame(
      decodeOk(audioFrame({ segmentIndex: 0, chunkIndex: 1, final: true }, [])),
    );
    player.handleFrame(decodeOk(audioFrame({ segmentIndex: 1 }, [0, 0])));
    player.handleFrame(
      decodeOk(audioFrame({ segmentIndex: 1, chunkIndex: 1, final: true }, [])),
    );
    expect(events).toEqual([{ type: "started", runId: "r1" }]);
  });
});

describe("lecteur TTS — purge barge-in (tts_cancel)", () => {
  it("arrête net la source en cours et vide la file", () => {
    const { player, ctx, events } = makePlayer();
    player.handleFrame(decodeOk(audioFrame({ segmentIndex: 0 }, [0, 0])));
    player.handleFrame(
      decodeOk(audioFrame({ segmentIndex: 0, chunkIndex: 1, final: true }, [])),
    );
    expect(ctx.sources[0]?.stopped).toBe(false);

    player.handleFrame(
      decodeOk(makeFrame({ v: 1, type: "tts_cancel", runId: "r1" }, [])),
    );
    expect(ctx.sources[0]?.stopped).toBe(true);
    expect(events).toEqual([
      { type: "started", runId: "r1" },
      { type: "aborted", runId: "r1" },
    ]);

    // Les trames suivantes du run annulé sont ignorées.
    player.handleFrame(decodeOk(audioFrame({ segmentIndex: 2 }, [0, 0])));
    expect(ctx.sources).toHaveLength(1);
  });

  it("stopAll() arrête tout et remonte l'interruption", () => {
    const { player, ctx, events } = makePlayer();
    player.handleFrame(decodeOk(audioFrame({ segmentIndex: 0 }, [0, 0])));
    player.handleFrame(
      decodeOk(audioFrame({ segmentIndex: 0, chunkIndex: 1, final: true }, [])),
    );
    const stopped = player.stopAll();
    expect(stopped).toBe(true);
    expect(ctx.sources[0]?.stopped).toBe(true);
    expect(events[1]).toEqual({ type: "aborted", runId: "r1" });
  });

  it("ne remonte pas `aborted` si rien n'avait commencé", () => {
    const { player, events } = makePlayer();
    player.cancel("r1");
    expect(events).toEqual([]);
  });
});

describe("lecteur TTS — politiques d'autoplay et volume", () => {
  it("appelle resume() sur le geste utilisateur (contexte suspendu)", async () => {
    const { player, ctx } = makePlayer({
      contextOptions: { state: "suspended" },
    });
    const ok = await player.unlock();
    expect(ok).toBe(true);
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe("running");
  });

  it("ne lève pas si resume() échoue (pas de geste)", async () => {
    const { player, ctx } = makePlayer({
      contextOptions: {
        state: "suspended",
        resumeImpl: () => Promise.reject(new Error("not allowed")),
      },
    });
    await expect(player.unlock()).resolves.toBe(false);
    expect(ctx.resumeCalls).toBe(1);
  });

  it("applique le volume via le GainNode", () => {
    const { player } = makePlayer({ volume: 100 });
    // Le contexte (et son gain) est créé au premier segment planifié.
    player.handleFrame(decodeOk(audioFrame({ segmentIndex: 0 }, [0, 0])));
    player.handleFrame(
      decodeOk(audioFrame({ segmentIndex: 0, chunkIndex: 1, final: true }, [])),
    );
    expect(player.gainValue).toBe(1);
    player.setVolume(50);
    expect(player.volume).toBe(50);
    expect(player.gainValue).toBeCloseTo(0.5, 6);
  });
});

describe("lecteur TTS — robustesse", () => {
  it("ne lève jamais sur une trame décodée malformée", () => {
    const { player, ctx } = makePlayer();
    expect(() => {
      player.handleFrame(null);
      player.handleFrame({});
      player.handleFrame({ header: null });
      player.handleFrame({ header: { type: "tts_audio" } });
      player.handleFrame({
        header: { type: "tts_audio", sampleRate: 0, segmentIndex: 0, chunkIndex: 0 },
        payload: new Uint8Array(0),
      });
    }).not.toThrow();
    expect(ctx.sources).toHaveLength(0);
  });

  it("joue un extrait WAV par decodeAudioData", async () => {
    const { player, ctx } = makePlayer();
    const ok = await player.playWav(new ArrayBuffer(16));
    expect(ok).toBe(true);
    expect(ctx.sources.length).toBe(1);
    expect(ctx.sources[0]?.startTime).toBe(0);
  });
});

/* ─── Préférence / état d'affichage ─────────────────────────────────────── */

function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string): string | null => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string): void => {
      map.set(key, String(value));
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
  } as unknown as Storage;
}

describe("préférence locale de sourdine", () => {
  it("lit/écrit la sourdine dans le stockage", () => {
    const storage = memoryStorage();
    expect(readMuted(storage)).toBe(false);
    writeMuted(true, storage);
    expect(readMuted(storage)).toBe(true);
    const pref = createTtsPreference(storage);
    expect(pref.muted).toBe(true);
    expect(pref.toggle()).toBe(false);
    expect(storage.getItem("yuki-tts-muted")).toBe("0");
  });

  it("reste silencieuse si le stockage est indisponible", () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error("quota");
      },
      setItem: (): void => {
        throw new Error("quota");
      },
    };
    expect(readMuted(broken as unknown as Storage)).toBe(false);
    expect(() => writeMuted(true, broken as unknown as Storage)).not.toThrow();
  });
});

describe("état d'affichage du bouton voix", () => {
  it("serveur off → état off non ambigu", () => {
    const state = resolveSpeechState({ serverEnabled: false, muted: false });
    expect(state.state).toBe("off");
    expect(state.audible).toBe(false);
    expect(state.pressed).toBe(false);
  });

  it("serveur on + sourdine → muted", () => {
    const state = resolveSpeechState({ serverEnabled: true, muted: true });
    expect(state.state).toBe("muted");
    expect(state.audible).toBe(false);
  });

  it("serveur on + non sourd → on audible", () => {
    const state = resolveSpeechState({ serverEnabled: true, muted: false });
    expect(state.state).toBe("on");
    expect(state.audible).toBe(true);
    expect(state.pressed).toBe(true);
  });
});
