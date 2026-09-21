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

/** Objet `options` du corps (émotion), ou `null` s'il est absent. */
function optionsOf(request: { body: string }): Record<string, unknown> | null {
  const value = bodyOf(request).options;
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

describe("toAudioCppRequest", () => {
  it("construit l'URL et les clés attestées/hypothétiques", () => {
    const request = toAudioCppRequest(voice, "Bonjour.", {
      ...baseOptions,
      emotion: "expressive",
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
    // L'émotion n'est JAMAIS au top-level : elle vit dans `options`.
    expect(body.exaggeration).toBeUndefined();
    expect(body.cfg).toBeUndefined();
    // expressive → (700, 400) pour-mille → réels, dans `options`.
    const options = optionsOf(request)!;
    expect(options.exaggeration).toBeCloseTo(0.7, 5);
    expect(options.guidance_scale).toBeCloseTo(0.4, 5);
  });

  it("honore le cran personnalisee (valeurs fines)", () => {
    const options = optionsOf(
      toAudioCppRequest(voice, "x", {
        ...baseOptions,
        emotion: "personnalisee",
        exaggeration: 900,
        cfg: 100,
      }),
    )!;
    expect(options.exaggeration).toBeCloseTo(0.9, 5);
    expect(options.guidance_scale).toBeCloseTo(0.1, 5);
  });

  it("sans voix, n'envoie ni voice ni voice_ref (défaut du service)", () => {
    const request = toAudioCppRequest(null, "x", baseOptions);
    const body = bodyOf(request);
    expect(body.voice).toBeUndefined();
    expect(body.voice_ref).toBeUndefined();
    const options = optionsOf(request)!;
    expect(options.exaggeration).toBeCloseTo(0.5, 5);
    expect(options.guidance_scale).toBeCloseTo(0.5, 5);
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

/**
 * Émotion : le serveur ne lit `exaggeration` / `guidance_scale` que dans
 * l'objet `options` (jamais au top-level), et **seule la famille Chatterbox**
 * les lit (`src/models/chatterbox/session.cpp:42-60`,
 * `app/server/runtime.cpp:1994-2006`). Preuve : nom exact de la clé (le « cfg »
 * de Yuki = `guidance_scale` = `cfg_weight` Python/T3 CFG ; `s3gen_cfg_rate`
 * est un AUTRE étage), niveau (`options`) et échelle (pour-mille → réel).
 */
describe("toAudioCppRequest — émotion (`options`) par moteur", () => {
  const at = (engine: string, exaggeration: number, cfg: number) =>
    optionsOf(
      toAudioCppRequest(voice, "x", {
        ...baseOptions,
        engine,
        emotion: "personnalisee",
        exaggeration,
        cfg,
      }),
    );

  it("chatterbox : émotion dans `options` avec les noms réels", () => {
    const options = at("chatterbox", 700, 400)!;
    expect(options).not.toBeNull();
    expect(options.exaggeration).toBeCloseTo(0.7, 5);
    expect(options.guidance_scale).toBeCloseTo(0.4, 5);
    // `s3gen_cfg_rate` (CFG du flux S3Gen, défaut moteur 0.7) n'est PAS piloté.
    expect(options.s3gen_cfg_rate).toBeUndefined();
    // Le faux nom top-level `cfg` n'existe nulle part.
    expect(options.cfg).toBeUndefined();
  });

  it("échelle : 0 / 500 / 1000 / 1500 ‰ → 0.0 / 0.5 / 1.0 / 1.5", () => {
    for (const [permille, real] of [
      [0, 0],
      [500, 0.5],
      [1000, 1],
      [1500, 1.5],
    ] as const) {
      const options = at("chatterbox", permille, permille)!;
      expect(options.exaggeration, `exaggeration ${permille}‰`).toBeCloseTo(real, 5);
      expect(options.guidance_scale, `guidance_scale ${permille}‰`).toBeCloseTo(real, 5);
    }
  });

  it("aucune autre famille ne reçoit l'émotion (ni top-level, ni `options`)", () => {
    for (const engine of ["qwen3-tts", "cosyvoice3", "kokoro", "sanotts", "inconnu"]) {
      const request = toAudioCppRequest(voice, "x", {
        ...baseOptions,
        engine,
        emotion: "expressive",
      });
      expect(optionsOf(request), engine).toBeNull();
      expect(bodyOf(request).exaggeration, engine).toBeUndefined();
      expect(bodyOf(request).cfg, engine).toBeUndefined();
    }
  });
});

/**
 * Débit : le serveur n'honore `speed` que si le modèle le supporte ; sinon il
 * **rejette** (HTTP 500) ou l'**ignore**. Yuki ne doit donc l'envoyer qu'aux
 * moteurs qui l'appliquent réellement (`engineSupportsSpeed`). Preuve moteur :
 * `app/server/runtime.cpp:2112-2124`, `model_specs/*.json` (`options.request`).
 */
describe("toAudioCppRequest — débit (`speed`) par moteur", () => {
  it("kokoro : 50/200 → 0.5/2.0 (multiplicateur), 100 → clé omise", () => {
    const at = (speed: number, engine: string) =>
      bodyOf(toAudioCppRequest(voice, "x", { ...baseOptions, engine, speed }));
    expect(at(50, "kokoro").speed).toBeCloseTo(0.5, 5);
    expect(at(200, "kokoro").speed).toBeCloseTo(2.0, 5);
    expect(at(100, "kokoro").speed).toBeUndefined();
  });

  it("sanotts : `speed` envoyé (le serveur l'applique comme `speaking_rate`)", () => {
    const body = bodyOf(
      toAudioCppRequest(voice, "x", { ...baseOptions, engine: "sanotts", speed: 150 }),
    );
    expect(body.speed).toBeCloseTo(1.5, 5);
  });

  it("chatterbox : aucun `speed` (ignoré/rejeté par le modèle → sans effet)", () => {
    const body = bodyOf(
      toAudioCppRequest(voice, "x", { ...baseOptions, engine: "chatterbox", speed: 200 }),
    );
    expect(body.speed).toBeUndefined();
  });

  it("qwen3-tts / cosyvoice3 : aucun `speed` (sinon HTTP 500 côté moteur)", () => {
    for (const engine of ["qwen3-tts", "cosyvoice3"]) {
      const body = bodyOf(
        toAudioCppRequest(voice, "x", { ...baseOptions, engine, speed: 50 }),
      );
      expect(body.speed, engine).toBeUndefined();
    }
  });

  it("moteur inconnu : omission prudente (jamais de rejet dur)", () => {
    const body = bodyOf(
      toAudioCppRequest(voice, "x", { ...baseOptions, engine: "inconnu", speed: 150 }),
    );
    expect(body.speed).toBeUndefined();
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
