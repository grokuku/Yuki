/**
 * Pipeline TTS (Lot 7, Lot B) — file/prefetch, ordre, purge, instrumentation,
 * retry et no-op. Aucun moteur réel : la synthèse est injectée.
 */

import { describe, expect, it } from "vitest";

import { AudioCppBusyError } from "../../src/tts/audio-cpp.js";
import { decodeTtsFrame } from "../../src/tts/framing.js";
import {
  TtsPipeline,
  TtsQueue,
  type TtsPipelineConfig,
  type TtsPipelineDeps,
  type TtsRunMetrics,
} from "../../src/tts/pipeline.js";
import type { SegmentSynthesizer } from "../../src/tts/synthesizer.js";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeConfig(
  overrides: Record<string, string | number> = {},
): TtsPipelineConfig {
  const values: Record<string, string | number> = {
    "tts.prefetchDepth": 2,
    "tts.minSentenceChars": 1,
    "tts.maxSentenceChars": 500,
    "tts.engine": "chatterbox",
    "tts.voice": "",
    "tts.emotion": "neutre",
    "tts.exaggeration": 500,
    "tts.cfg": 500,
    "tts.speed": 100,
    "tts.language": "fr",
    ...overrides,
  };
  return {
    getString: (path) => String(values[path] ?? ""),
    getNumber: (path) => Number(values[path] ?? 0),
  };
}

function synthFrom(map: Record<string, Buffer[]>): SegmentSynthesizer {
  return async (request) => {
    const chunks = map[request.text] ?? [Buffer.from([request.text.length])];
    return (async function* () {
      yield { type: "format" as const, sampleRate: 16_000, channels: 1 };
      for (const bytes of chunks) yield { type: "data" as const, bytes };
    })();
  };
}

class Capture {
  readonly raw: Buffer[] = [];
  readonly stages: { runId: string; stage: string }[] = [];
  readonly metrics: { runId: string; metrics: TtsRunMetrics }[] = [];
}

function buildPipeline(
  deps: Partial<TtsPipelineDeps> = {},
  cap = new Capture(),
): { pipeline: TtsPipeline; cap: Capture } {
  const pipeline = new TtsPipeline(
    {
      enabled: true,
      config: makeConfig(),
      synthesizer: synthFrom({}),
      resolveVoice: () => null,
      logger,
      sleep: async () => undefined,
      ...deps,
    },
    {
      emitAudio: (_sessionId, frame) => cap.raw.push(frame),
      emitControl: (_sessionId, frame) => cap.raw.push(frame),
      onStage: (_sessionId, runId, stage) => cap.stages.push({ runId, stage }),
      onMetrics: (_sessionId, runId, metrics) =>
        cap.metrics.push({ runId, metrics }),
    },
  );
  return { pipeline, cap };
}

function decoded(raw: Buffer[]) {
  return raw
    .map((frame) => decodeTtsFrame(frame))
    .filter((value): value is NonNullable<typeof value> => value !== null);
}

async function until(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout en attendant");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("TtsQueue — borne de prefetch", () => {
  it("borne les segments préparés et conserve les autres en attente", () => {
    const queue = new TtsQueue(3);
    for (let i = 0; i < 5; i += 1) {
      queue.push({ index: i, text: `p${i}` });
    }
    expect(queue.size).toBe(3);
    expect(queue.pending).toBe(2);
    expect(queue.total).toBe(5);

    expect(queue.shift()?.index).toBe(0);
    // La place libérée est immédiatement réapprovisionnée.
    expect(queue.size).toBe(3);
    expect(queue.pending).toBe(1);

    const indices: number[] = [];
    while (queue.total > 0) {
      const segment = queue.shift();
      if (segment) indices.push(segment.index);
    }
    expect(indices).toEqual([1, 2, 3, 4]);
  });

  it("vide tout", () => {
    const queue = new TtsQueue(2);
    queue.push({ index: 0, text: "a" });
    queue.push({ index: 1, text: "b" });
    queue.push({ index: 2, text: "c" });
    queue.clear();
    expect(queue.total).toBe(0);
    expect(queue.shift()).toBeUndefined();
  });
});

describe("TtsPipeline — no-op quand désactivé", () => {
  it("n'émet rien si tts.enabled = off", async () => {
    const { pipeline, cap } = buildPipeline({ enabled: false });
    pipeline.onRunStarted("sess", "run", 0);
    pipeline.onContent("sess", "run", "Un. Deux. Trois.");
    pipeline.onRunFinished("sess", "run", "done");
    await delay(30);
    expect(cap.raw).toEqual([]);
    expect(cap.stages).toEqual([]);
    expect(cap.metrics).toEqual([]);
  });
});

describe("TtsPipeline — ordre garanti et framing", () => {
  it("émet les segments dans l'ordre avec index monotone", async () => {
    const a = Buffer.from([1, 1, 1, 1]);
    const b = Buffer.from([2, 2]);
    const c = Buffer.from([3, 3, 3]);
    const d = Buffer.from([4]);
    const { pipeline, cap } = buildPipeline({
      synthesizer: synthFrom({ "Un.": [a], "Deux.": [b, c], "Trois.": [d] }),
    });

    pipeline.onRunStarted("sess", "run", 0);
    pipeline.onContent("sess", "run", "Un. Deux. Trois.");
    pipeline.onRunFinished("sess", "run", "done");

    await until(() =>
      decoded(cap.raw).some((frame) => frame.header.type === "tts_end"),
    );

    const frames = decoded(cap.raw);
    const audio = frames.filter((frame) => frame.header.type === "tts_audio");
    expect(audio.map((frame) => frame.header.segmentIndex)).toEqual([
      0, 0, 1, 1, 1, 2, 2,
    ]);
    expect(audio.map((frame) => frame.header.chunkIndex)).toEqual([
      0, 1, 0, 1, 2, 0, 1,
    ]);
    expect(audio.every((frame) => frame.header.sampleRate === 16_000)).toBe(true);
    expect(audio.every((frame) => frame.header.channels === 1)).toBe(true);
    // Contenu PCM concaténé par segment.
    const seg0 = Buffer.concat(
      audio
        .filter((frame) => frame.header.segmentIndex === 0)
        .map((frame) => frame.payload),
    );
    expect(seg0.equals(a)).toBe(true);
    const seg1 = Buffer.concat(
      audio
        .filter((frame) => frame.header.segmentIndex === 1)
        .map((frame) => frame.payload),
    );
    expect(seg1.equals(Buffer.concat([b, c]))).toBe(true);
    // Clôture : `final` uniquement sur le dernier bloc de chaque segment.
    const finals = audio.filter((frame) => frame.header.final);
    expect(finals.map((frame) => frame.header.segmentIndex)).toEqual([0, 1, 2]);
    expect(frames[frames.length - 1]?.header.type).toBe("tts_end");
  });

  it("émet les étages d'instrumentation attendus", async () => {
    const { pipeline, cap } = buildPipeline();
    pipeline.onRunStarted("sess", "run", 0);
    pipeline.onContent("sess", "run", "Un. Deux.");
    pipeline.onRunFinished("sess", "run", "done");
    await until(() =>
      decoded(cap.raw).some((frame) => frame.header.type === "tts_end"),
    );
    const stages = cap.stages.map((entry) => entry.stage);
    for (const expected of [
      "sentence_segmented",
      "tts_queued",
      "tts_requested",
      "tts_first_byte",
      "tts_segment_done",
    ]) {
      expect(stages).toContain(expected);
    }
  });
});

describe("TtsPipeline — métriques", () => {
  it("alimente ttfaMs, ttsSegments et ttsSynthMs", async () => {
    let clock = 1_000;
    const now = (): number => {
      clock += 10;
      return clock;
    };
    const { pipeline, cap } = buildPipeline({ now });
    pipeline.onRunStarted("sess", "run", 1_000);
    pipeline.onContent("sess", "run", "Un. Deux.");
    pipeline.onRunFinished("sess", "run", "done");
    await until(() => cap.metrics.some((m) => m.metrics.ttsSegments === 2));
    const last = cap.metrics[cap.metrics.length - 1]!.metrics;
    expect(last.ttsSegments).toBe(2);
    expect(last.ttfaMs).toBeGreaterThanOrEqual(0);
    expect(last.ttsSynthMs).toBeGreaterThanOrEqual(0);
  });
});

describe("TtsPipeline — retry et moteur absent", () => {
  it("réessaie un 503 borné puis réussit", async () => {
    let calls = 0;
    const flaky: SegmentSynthesizer = async (_request) => {
      calls += 1;
      if (calls <= 2) throw new AudioCppBusyError();
      return (async function* () {
        yield { type: "format" as const, sampleRate: 16_000, channels: 1 };
        yield { type: "data" as const, bytes: Buffer.from([9, 9]) };
      })();
    };
    const { pipeline, cap } = buildPipeline({ synthesizer: flaky, maxRetries: 2 });
    pipeline.onRunStarted("sess", "run", 0);
    pipeline.onContent("sess", "run", "Un.");
    pipeline.onRunFinished("sess", "run", "done");
    await until(() =>
      decoded(cap.raw).some((frame) => frame.header.type === "tts_end"),
    );
    expect(calls).toBe(3);
    expect(cap.stages.filter((entry) => entry.stage === "tts_retry").length).toBe(2);
    expect(
      decoded(cap.raw).some(
        (frame) => frame.header.type === "tts_audio" && frame.payload.length > 0,
      ),
    ).toBe(true);
  });

  it("abandonne le segment après épuisement des réessais, sans casser le run", async () => {
    let calls = 0;
    const failing: SegmentSynthesizer = async () => {
      calls += 1;
      throw new AudioCppBusyError();
    };
    const { pipeline, cap } = buildPipeline({ synthesizer: failing, maxRetries: 1 });
    pipeline.onRunStarted("sess", "run", 0);
    pipeline.onContent("sess", "run", "Un. Deux.");
    pipeline.onRunFinished("sess", "run", "done");
    await until(() =>
      decoded(cap.raw).some((frame) => frame.header.type === "tts_end"),
    );
    // 2 segments × (1 essai + 1 retry).
    expect(calls).toBe(4);
    const audio = decoded(cap.raw).filter(
      (frame) => frame.header.type === "tts_audio",
    );
    expect(audio).toEqual([]);
    expect(decoded(cap.raw).some((frame) => frame.header.type === "tts_end")).toBe(
      true,
    );
  });
});

describe("TtsPipeline — purge / barge-in", () => {
  function blockingSynth(): SegmentSynthesizer {
    return async (request) =>
      (async function* () {
        yield { type: "format" as const, sampleRate: 16_000, channels: 1 };
        yield { type: "data" as const, bytes: Buffer.from([1, 2]) };
        await new Promise<void>((resolve) => {
          if (request.signal.aborted) {
            resolve();
            return;
          }
          request.signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
      })();
  }

  it("annule la synthèse en vol et émet un marqueur de purge", async () => {
    const { pipeline, cap } = buildPipeline({ synthesizer: blockingSynth() });
    pipeline.onRunStarted("sess", "run", 0);
    pipeline.onContent("sess", "run", "Un.");
    await until(() =>
      decoded(cap.raw).some(
        (frame) => frame.header.type === "tts_audio" && frame.payload.length > 0,
      ),
    );

    pipeline.cancel("sess", "run");
    await until(() =>
      decoded(cap.raw).some((frame) => frame.header.type === "tts_cancel"),
    );

    expect(pipeline.runCount).toBe(0);
    const finals = decoded(cap.raw).filter(
      (frame) => frame.header.type === "tts_audio" && frame.header.final,
    );
    expect(finals).toEqual([]);
  });

  it("une raison non `done` purge au lieu de clore", async () => {
    const { pipeline, cap } = buildPipeline({ synthesizer: blockingSynth() });
    pipeline.onRunStarted("sess", "run", 0);
    pipeline.onContent("sess", "run", "Un.");
    pipeline.onRunFinished("sess", "run", "abort");
    await until(() =>
      decoded(cap.raw).some((frame) => frame.header.type === "tts_cancel"),
    );
    expect(decoded(cap.raw).some((frame) => frame.header.type === "tts_end")).toBe(
      false,
    );
    expect(pipeline.runCount).toBe(0);
  });

  it("un nouveau tour annule la voix résiduelle du précédent", async () => {
    const { pipeline, cap } = buildPipeline({ synthesizer: blockingSynth() });
    pipeline.onRunStarted("sess", "run-1", 0);
    pipeline.onContent("sess", "run-1", "Un.");
    await until(() =>
      decoded(cap.raw).some(
        (frame) => frame.header.type === "tts_audio" && frame.payload.length > 0,
      ),
    );

    pipeline.onRunStarted("sess", "run-2", 0);
    await until(() =>
      decoded(cap.raw).some((frame) => frame.header.type === "tts_cancel"),
    );
    expect(pipeline.runCount).toBe(1);
    expect(decoded(cap.raw).some((frame) => frame.header.type === "tts_cancel")).toBe(
      true,
    );
    pipeline.cancelAll();
    expect(pipeline.runCount).toBe(0);
  });
});

describe("TtsPipeline — texte parlé nettoyé (Lot 8)", () => {
  it("transmet au synthétiseur un texte débarrassé des emojis et symboles", async () => {
    const requested: string[] = [];
    const synthesizer: SegmentSynthesizer = async (request) => {
      requested.push(request.text);
      return (async function* () {
        yield { type: "format" as const, sampleRate: 16_000, channels: 1 };
        yield { type: "data" as const, bytes: Buffer.from([1, 2]) };
      })();
    };
    const { pipeline, cap } = buildPipeline({ synthesizer });

    pipeline.onRunStarted("sess", "run", 0);
    pipeline.onContent("sess", "run", "Bonjour ! 😊 Ensuite, 🎉 ça continue → fin.");
    pipeline.onRunFinished("sess", "run", "done");

    await until(() =>
      decoded(cap.raw).some((frame) => frame.header.type === "tts_end"),
    );

    const spoken = requested.join(" ");
    expect(spoken).toContain("Bonjour !");
    expect(spoken).toContain("ça continue");
    expect(spoken).not.toContain("😊");
    expect(spoken).not.toContain("🎉");
    expect(spoken).not.toContain("→");
    // La ponctuation de fin de phrase est préservée : deux segments.
    expect(requested).toEqual([
      "Bonjour !",
      "Ensuite, ça continue fin.",
    ]);
  });
});
