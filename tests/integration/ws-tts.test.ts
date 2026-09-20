/**
 * Intégration WS — transport TTS (Lot 7, Lot B).
 *
 * Un run simulé (`FakePiHost`) alimente le pipeline : on vérifie que des trames
 * **binaires `YTA1`** partent dans le bon ordre, qu'un `tts.enabled = off` n'en
 * produit **aucune**, que le canal `thinking` n'est **jamais** vocalisé, que le
 * barge-in purge, et que le chemin des deltas n'est **pas** ralenti par la
 * synthèse (anti-régression TTFT).
 */

import { afterEach, describe, expect, it } from "vitest";

import { decodeTtsFrame } from "../../src/tts/framing.js";
import type { AudioStreamEvent, SegmentSynthesizer } from "../../src/tts/synthesizer.js";
import type { TtsPipelineConfig, TtsPipelineDeps } from "../../src/tts/pipeline.js";
import { startHarness, TestClient, type Harness } from "../gateway/ws/harness.js";

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

interface TtsTest {
  deps: TtsPipelineDeps;
  requested: string[];
}

function makeTts(overrides: Partial<TtsPipelineDeps> = {}): TtsTest {
  const requested: string[] = [];
  const synthesizer: SegmentSynthesizer = async (request) => {
    requested.push(request.text);
    return (async function* () {
      yield { type: "format" as const, sampleRate: 16_000, channels: 1 };
      yield { type: "data" as const, bytes: Buffer.from([1, 2, 3, 4]) };
    })();
  };
  return {
    requested,
    deps: {
      enabled: true,
      config: makeConfig(),
      synthesizer,
      resolveVoice: () => null,
      logger,
      sleep: async () => undefined,
      ...overrides,
    },
  };
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout en attendant");
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

function decodedBinary(client: TestClient) {
  return client.binaryFrames
    .map((frame) => decodeTtsFrame(frame))
    .filter((value): value is NonNullable<typeof value> => value !== null);
}

const SENTENCES = {
  steps: [
    { kind: "delta" as const, channel: "content" as const, text: "Un. ", delayMs: 1 },
    { kind: "delta" as const, channel: "content" as const, text: "Deux. ", delayMs: 1 },
    { kind: "delta" as const, channel: "content" as const, text: "Trois. ", delayMs: 1 },
  ],
};

let harness: Harness | undefined;
const clients: TestClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await harness?.close();
  harness = undefined;
});

async function connect(h: Harness): Promise<TestClient> {
  const client = await TestClient.connect(h.url);
  clients.push(client);
  client.send({ type: "hello" });
  await client.waitFor((frame) => frame.type === "welcome");
  await client.waitFor((frame) => frame.type === "snapshot");
  return client;
}

describe("intégration WS — transport TTS", () => {
  it("émet des trames binaires ordonnées et un signal de fin", async () => {
    const tts = makeTts();
    harness = await startHarness({ scripts: [SENTENCES], tts: tts.deps });
    const client = await connect(harness);

    client.send({ type: "message", clientMsgId: "m1", text: "go" });
    await client.waitFor("run_started");
    await client.waitFor(
      (frame) => frame.type === "run_finished" && frame.reason === "done",
    );
    await until(() =>
      decodedBinary(client).some((frame) => frame.header.type === "tts_end"),
    );

    const frames = decodedBinary(client);
    const audio = frames.filter((frame) => frame.header.type === "tts_audio");
    expect(audio.map((frame) => frame.header.segmentIndex)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(audio.every((frame) => frame.header.runId.length > 0)).toBe(true);
    expect(frames[frames.length - 1]?.header.type).toBe("tts_end");
    expect(tts.requested).toEqual(["Un.", "Deux.", "Trois."]);
  });

  it("câble les étages d'instrumentation et alimente run_summary", async () => {
    const tts = makeTts();
    harness = await startHarness({ scripts: [SENTENCES], tts: tts.deps });
    const client = await connect(harness);

    client.send({ type: "message", clientMsgId: "m1", text: "go" });
    await client.waitFor("run_started");
    await client.waitFor(
      (frame) => frame.type === "run_summary",
    );
    await until(() =>
      decodedBinary(client).some((frame) => frame.header.type === "tts_end"),
    );

    const stages = client.frames
      .filter((frame) => frame.type === "phase")
      .map((frame) => (frame.type === "phase" ? frame.stage : ""));
    expect(stages).toContain("sentence_segmented");
    expect(stages).toContain("tts_requested");
    expect(stages).toContain("tts_first_byte");
    expect(stages).toContain("tts_segment_done");

    const summary = client.frames.find((frame) => frame.type === "run_summary");
    expect(summary?.type === "run_summary" && typeof summary.ttsSegments).toBe(
      "number",
    );
    expect(summary?.type === "run_summary" && typeof summary.ttfaMs).toBe("number");
  });

  it("ne vocalise jamais le canal thinking", async () => {
    const tts = makeTts();
    harness = await startHarness({
      scripts: [
        {
          steps: [
            { kind: "delta", channel: "thinking", text: "je réfléchis ", delayMs: 1 },
            { kind: "delta", channel: "thinking", text: "encore. ", delayMs: 1 },
            { kind: "delta", channel: "content", text: "Voici la réponse. ", delayMs: 1 },
          ],
        },
      ],
      tts: tts.deps,
    });
    const client = await connect(harness);
    client.send({ type: "message", clientMsgId: "m1", text: "raisonne" });
    await client.waitFor((frame) => frame.type === "run_finished");
    await until(() =>
      decodedBinary(client).some((frame) => frame.header.type === "tts_end"),
    );
    expect(tts.requested.join(" ")).toContain("Voici la réponse.");
    expect(tts.requested.join(" ")).not.toContain("réfléchis");
  });

  it("tts.enabled = off ne produit aucune trame binaire", async () => {
    const tts = makeTts({ enabled: false });
    harness = await startHarness({ scripts: [SENTENCES], tts: tts.deps });
    const client = await connect(harness);
    client.send({ type: "message", clientMsgId: "m1", text: "go" });
    await client.waitFor(
      (frame) => frame.type === "run_finished" && frame.reason === "done",
    );
    // Laisse le temps à un éventuel pipeline de produire (il ne doit rien faire).
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(client.binaryFrames).toEqual([]);
    const summary = client.frames.find((frame) => frame.type === "run_summary");
    expect(summary?.type === "run_summary" && summary.ttfaMs).toBeUndefined();
  });

  it("le barge-in purge la file et signale l'annulation au client", async () => {
    const blocking: SegmentSynthesizer = async () =>
      (async function* (): AsyncGenerator<AudioStreamEvent> {
        yield { type: "format" as const, sampleRate: 16_000, channels: 1 };
        yield { type: "data" as const, bytes: Buffer.from([1, 2]) };
        await new Promise<void>(() => {
          /* suspend la synthèse jusqu'à l'abort */
        });
      })();
    const tts = makeTts({ synthesizer: blocking });
    harness = await startHarness({
      scripts: [
        {
          steps: [
            { kind: "delta", channel: "content", text: "Un. ", delayMs: 1 },
            { kind: "delta", channel: "content", text: "Deux. ", delayMs: 300 },
          ],
        },
      ],
      tts: tts.deps,
    });
    const client = await connect(harness);
    client.send({ type: "message", clientMsgId: "m1", text: "go" });
    const started = await client.waitFor("run_started");
    await until(() =>
      decodedBinary(client).some(
        (frame) => frame.header.type === "tts_audio" && frame.payload.length > 0,
      ),
    );
    client.send({ type: "abort", runId: started.runId });
    await until(() =>
      decodedBinary(client).some((frame) => frame.header.type === "tts_cancel"),
    );
    const cancel = decodedBinary(client).find(
      (frame) => frame.header.type === "tts_cancel",
    );
    expect(cancel?.header.runId).toBe(started.runId);
  });

  it("rejette une trame playback invalide sans casser la session", async () => {
    harness = await startHarness({ scripts: [] });
    const client = await connect(harness);
    client.send({ type: "playback", runId: "r" });
    const error = await client.waitFor((frame) => frame.type === "error");
    expect(error.type === "error" && error.code).toBe("bad_request");
  });

  it("la synthèse ne bloque pas le chemin des deltas (anti-régression TTFT)", async () => {
    // Un synthétiseur qui ne rend JAMAIS la main : si le pipeline bloquait la
    // boucle des deltas, le run ne se terminerait pas.
    const hanging: SegmentSynthesizer = async () =>
      new Promise<AsyncIterable<AudioStreamEvent>>(() => {
        /* jamais résolu */
      });
    const tts = makeTts({ synthesizer: hanging });
    harness = await startHarness({ scripts: [SENTENCES, SENTENCES], tts: tts.deps });
    const client = await connect(harness);

    const before = Date.now();
    client.send({ type: "message", clientMsgId: "m1", text: "go" });
    const started = await client.waitFor("run_started");
    await client.waitFor(
      (frame) => frame.type === "run_finished" && frame.runId === started.runId,
    );
    const elapsed = Date.now() - before;

    const content = client.frames
      .filter((frame) => frame.type === "delta" && frame.channel === "content")
      .map((frame) => (frame.type === "delta" ? frame.text : ""))
      .join("");
    expect(content).toBe("Un. Deux. Trois. ");
    // Le run se termine sans attendre la synthèse (borné largement).
    expect(elapsed).toBeLessThan(2_000);
  });
});
