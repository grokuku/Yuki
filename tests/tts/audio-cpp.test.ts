/**
 * Adaptateur et client du moteur TTS (Lot 7 §10.2). Le contrat HTTP réel
 * d'`audio.cpp` N'EST PAS testable ici : on vérifie la SÉRIALISATION et la
 * gestion 503/timeout/annulation avec un `fetch` simulé.
 */

import { describe, expect, it } from "vitest";

import {
  AUDIO_CPP_SPEECH_PATH,
  AudioCppBusyError,
  AudioCppClient,
  toAudioCppRequest,
} from "../../src/tts/audio-cpp.js";
import type { TtsOptions, Voice } from "../../src/tts/types.js";

const voice: Voice = {
  id: "camille",
  label: "Camille",
  kind: "cloned",
  lang: "fr",
  refAudio: "cloned/camille.wav",
  refText: "bonjour",
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: "user",
};

const baseOptions: TtsOptions & { baseUrl: string; engine: string } = {
  language: "fr",
  emotion: "neutre",
  exaggeration: 500,
  cfg: 500,
  speed: 100,
  baseUrl: "http://tts:8081/",
  engine: "chatterbox",
};

function bodyOf(request: { body: string }): Record<string, unknown> {
  return JSON.parse(request.body) as Record<string, unknown>;
}

describe("toAudioCppRequest", () => {
  it("construit l'URL et les clés attestées/hypothétiques", () => {
    const request = toAudioCppRequest(voice, "Bonjour.", {
      ...baseOptions,
      emotion: "expressive",
      speed: 120,
    });
    expect(request.url).toBe(`http://tts:8081${AUDIO_CPP_SPEECH_PATH}`);
    expect(request.method).toBe("POST");
    const body = bodyOf(request);
    expect(body.model).toBe("chatterbox");
    expect(body.input).toBe("Bonjour.");
    expect(body.voice).toBe("camille");
    expect(body.voice_ref).toBe("/voices/cloned/camille.wav");
    expect(body.reference_text).toBe("bonjour");
    expect(body.language).toBe("fr");
    expect(body.response_format).toBe("wav");
    // expressive → (700, 400) pour-mille → réels.
    expect(body.exaggeration).toBeCloseTo(0.7, 5);
    expect(body.cfg).toBeCloseTo(0.4, 5);
    expect(body.speed).toBeCloseTo(1.2, 5);
  });

  it("honore le cran personnalisee (valeurs fines)", () => {
    const body = bodyOf(
      toAudioCppRequest(voice, "x", {
        ...baseOptions,
        emotion: "personnalisee",
        exaggeration: 900,
        cfg: 100,
      }),
    );
    expect(body.exaggeration).toBeCloseTo(0.9, 5);
    expect(body.cfg).toBeCloseTo(0.1, 5);
  });

  it("sans voix, n'envoie ni voice ni voice_ref (défaut du service)", () => {
    const body = bodyOf(toAudioCppRequest(null, "x", baseOptions));
    expect(body.voice).toBeUndefined();
    expect(body.voice_ref).toBeUndefined();
    expect(body.exaggeration).toBeCloseTo(0.5, 5);
    expect(body.cfg).toBeCloseTo(0.5, 5);
  });

  it("au débit par défaut, omet la clé speed", () => {
    const body = bodyOf(toAudioCppRequest(voice, "x", baseOptions));
    expect(body.speed).toBeUndefined();
  });

  it("demande le format SSE en mode streaming", () => {
    const request = toAudioCppRequest(voice, "x", { ...baseOptions, stream: true });
    expect(bodyOf(request).stream_format).toBe("sse");
  });

  it("respecte un montage moteur configuré différemment (voiceBaseDir)", () => {
    const body = bodyOf(
      toAudioCppRequest(voice, "x", { ...baseOptions, voiceBaseDir: "/moteur/voices/" }),
    );
    // `refAudio` est RELATIF (`cloned/camille.wav`) : le chemin envoyé est
    // TOUJOURS absolu, sous le point de montage du moteur (slashs en trop rognés).
    expect(body.voice_ref).toBe("/moteur/voices/cloned/camille.wav");
  });

  it("voix sans refAudio : `voice` envoyée, aucun `voice_ref`", () => {
    const preset: Voice = { ...voice, kind: "preset", refAudio: null, refText: null };
    const body = bodyOf(toAudioCppRequest(preset, "x", baseOptions));
    expect(body.voice).toBe("camille");
    expect(body.voice_ref).toBeUndefined();
    expect(body.reference_text).toBeUndefined();
  });
});

const synthParams = {
  voice,
  text: "Bonjour.",
  options: baseOptions,
  engine: "chatterbox",
};

describe("AudioCppClient", () => {
  it("matérialise le corps en `Buffer` sur 200", async () => {
    const fetchImpl = (async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-type": "audio/wav" },
      })) as unknown as typeof fetch;
    const client = new AudioCppClient({
      baseUrl: "http://tts:8081",
      timeoutMs: 1_000,
      fetchImpl,
    });
    const result = await client.synthesizeBuffer(synthParams);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe("audio/wav");
    expect(result.bytes).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("503 → AudioCppBusyError (code server_busy)", async () => {
    const fetchImpl = (async () =>
      new Response("busy", { status: 503 })) as unknown as typeof fetch;
    const client = new AudioCppClient({
      baseUrl: "http://tts:8081",
      timeoutMs: 1_000,
      fetchImpl,
    });
    await expect(client.synthesizeBuffer(synthParams)).rejects.toBeInstanceOf(
      AudioCppBusyError,
    );
    await expect(client.synthesizeBuffer(synthParams)).rejects.toMatchObject({
      code: "server_busy",
      status: 503,
    });
  });

  it("500 → AudioCppError http_error avec le statut", async () => {
    const fetchImpl = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const client = new AudioCppClient({
      baseUrl: "http://tts:8081",
      timeoutMs: 1_000,
      fetchImpl,
    });
    await expect(client.synthesizeBuffer(synthParams)).rejects.toMatchObject({
      code: "http_error",
      status: 500,
    });
  });

  it("capture le corps d'erreur du moteur (503 et 500)", async () => {
    const busy = (async () =>
      new Response('{"error":"Insufficient Memory"}', {
        status: 503,
      })) as unknown as typeof fetch;
    const busyClient = new AudioCppClient({
      baseUrl: "http://tts:8081",
      timeoutMs: 1_000,
      fetchImpl: busy,
    });
    await expect(busyClient.synthesizeBuffer(synthParams)).rejects.toMatchObject({
      code: "server_busy",
      status: 503,
      body: '{"error":"Insufficient Memory"}',
    });

    const failure = (async () =>
      new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const failureClient = new AudioCppClient({
      baseUrl: "http://tts:8081",
      timeoutMs: 1_000,
      fetchImpl: failure,
    });
    await expect(failureClient.synthesizeBuffer(synthParams)).rejects.toMatchObject({
      code: "http_error",
      status: 500,
      body: "boom",
    });
  });

  it("timeout → code timeout", async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as unknown as typeof fetch;
    const client = new AudioCppClient({
      baseUrl: "http://tts:8081",
      timeoutMs: 20,
      fetchImpl: hanging,
    });
    await expect(client.synthesizeBuffer(synthParams)).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it("annulation externe → code aborted", async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as unknown as typeof fetch;
    const client = new AudioCppClient({
      baseUrl: "http://tts:8081",
      timeoutMs: 5_000,
      fetchImpl: hanging,
    });
    const controller = new AbortController();
    const pending = client.synthesizeBuffer({ ...synthParams, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
});
