/**
 * Synthétiseur par défaut (`createAudioCppSynthesizer`) — parsing WAV
 * incrémental et refus explicite du SSE non prouvé. Aucun moteur : `fetch` est
 * injecté.
 */

import { describe, expect, it } from "vitest";

import { AudioCppClient, AudioCppError } from "../../src/tts/audio-cpp.js";
import {
  createAudioCppSynthesizer,
  type AudioStreamEvent,
  type SynthesizeRequest,
} from "../../src/tts/synthesizer.js";
import type { TtsOptions } from "../../src/tts/types.js";
import { makeWav } from "./wav-fixture.js";

const OPTIONS: TtsOptions = {
  language: "fr",
  emotion: "neutre",
  exaggeration: 500,
  cfg: 500,
  speed: 100,
};

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) controller.enqueue(chunks[index++]!);
      else controller.close();
    },
  });
}

function clientFetching(
  body: ReadableStream<Uint8Array>,
  contentType: string,
): AudioCppClient {
  const fetchImpl = (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": contentType },
    })) as unknown as typeof fetch;
  return new AudioCppClient({ baseUrl: "http://tts:8081", timeoutMs: 1000, fetchImpl });
}

function request(signal: AbortSignal): SynthesizeRequest {
  return { voice: null, text: "Bonjour.", options: OPTIONS, engine: "chatterbox", signal };
}

async function collect(iterable: AsyncIterable<AudioStreamEvent>): Promise<AudioStreamEvent[]> {
  const events: AudioStreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("createAudioCppSynthesizer — WAV incrémental", () => {
  it("expose la fréquence native et relaie le PCM", async () => {
    const wav = makeWav({ sampleRate: 16_000, seconds: 1 });
    const synth = createAudioCppSynthesizer(clientFetching(streamOf([wav]), "audio/wav"));
    const events = await collect(await synth(request(new AbortController().signal)));

    expect(events[0]).toEqual({ type: "format", sampleRate: 16_000, channels: 1 });
    const pcm = Buffer.concat(
      events.filter((e): e is { type: "data"; bytes: Buffer } => e.type === "data").map(
        (e) => e.bytes,
      ),
    );
    expect(pcm.equals(wav.subarray(44))).toBe(true);
  });

  it("gère un en-tête coupé entre deux lectures", async () => {
    const wav = makeWav({ sampleRate: 22_050, seconds: 1 });
    const synth = createAudioCppSynthesizer(
      clientFetching(streamOf([wav.subarray(0, 20), wav.subarray(20)]), "audio/wav"),
    );
    const events = await collect(await synth(request(new AbortController().signal)));
    expect(events[0]).toEqual({ type: "format", sampleRate: 22_050, channels: 1 });
    const pcm = Buffer.concat(
      events.filter((e): e is { type: "data"; bytes: Buffer } => e.type === "data").map(
        (e) => e.bytes,
      ),
    );
    expect(pcm.length).toBe(wav.length - 44);
  });
});

describe("createAudioCppSynthesizer — refus explicite", () => {
  it("refuse une réponse SSE (contrat non prouvé)", async () => {
    const synth = createAudioCppSynthesizer(
      clientFetching(streamOf([Buffer.from("data: xx\n\n")]), "text/event-stream"),
    );
    await expect(synth(request(new AbortController().signal))).rejects.toBeInstanceOf(
      AudioCppError,
    );
  });

  it("refuse une réponse WAV sans corps", async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 200, headers: { "content-type": "audio/wav" } })) as unknown as typeof fetch;
    const client = new AudioCppClient({ baseUrl: "http://tts:8081", timeoutMs: 1000, fetchImpl });
    const synth = createAudioCppSynthesizer(client);
    await expect(synth(request(new AbortController().signal))).rejects.toBeInstanceOf(
      AudioCppError,
    );
  });
});
