/**
 * Résolution de voix TTS — chaîne RÉELLE config → registre → pipeline →
 * adaptateur `audio.cpp` (Lot 8, correctif).
 *
 * Ce fichier reproduit **exactement** le câblage de `src/index.ts` :
 *   - résolveur = `VoiceStore.resolveVoice(id).voice` ;
 *   - synthétiseur du pipeline = `createAudioCppSynthesizer` sur un
 *     `AudioCppClient` dont le `fetch` est simulé (le moteur n'est pas requis).
 *
 * Objectif : prouver que le corps JSON envoyé au moteur contient bien
 * `voice_ref = /voices/presets/<id>.wav` quand `tts.voice` est **vide** (cas qui
 * échouait : « requires speaker reference audio »), et qu'un `refAudio` absent
 * échoue **proprement** côté Yuki (jamais un échec opaque du moteur).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AudioCppClient,
  toAudioCppRequest,
  type ToAudioCppOptions,
  type TtsLogger,
} from "../../src/tts/audio-cpp.js";
import { decodeTtsFrame } from "../../src/tts/framing.js";
import {
  TtsPipeline,
  type TtsPipelineConfig,
} from "../../src/tts/pipeline.js";
import {
  createAudioCppSynthesizer,
  type SegmentSynthesizer,
} from "../../src/tts/synthesizer.js";
import { VoiceStore } from "../../src/tts/voices-store.js";
import { makeWav } from "../tts/wav-fixture.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-voice-res-"));
  tempDirs.push(dir);
  return dir;
}

function seedPreset(dir: string, id = "voix-fr"): void {
  mkdirSync(join(dir, "presets"), { recursive: true });
  writeFileSync(join(dir, "presets", `${id}.wav`), makeWav());
  writeFileSync(
    join(dir, "voices.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      voices: [
        {
          id,
          label: "Voix française",
          kind: "preset",
          lang: "fr",
          refAudio: `presets/${id}.wav`,
          refText: "bonjour",
          createdAt: "2026-01-01T00:00:00.000Z",
          createdBy: "factory",
        },
      ],
    })}\n`,
  );
}

/** Logger qui capture les messages (diagnostic du garde-fou de référence). */
function captureLogger(): {
  logger: TtsLogger;
  warns: Array<{ message: string; fields?: Record<string, unknown> }>;
  errors: Array<{ message: string; fields?: Record<string, unknown> }>;
} {
  const warns: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const errors: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  const noop = (): void => undefined;
  return {
    warns,
    errors,
    logger: {
      debug: noop,
      info: noop,
      warn: (message, fields) => warns.push({ message, ...(fields ? { fields } : {}) }),
      error: (message, fields) => errors.push({ message, ...(fields ? { fields } : {}) }),
    },
  };
}

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

/** Client `audio.cpp` dont le `fetch` simule un moteur renvoyant un WAV. */
function recordingClient(captured: Captured[], logger: TtsLogger): AudioCppClient {
  const fetchImpl = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    captured.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(makeWav(), {
      status: 200,
      headers: { "content-type": "audio/wav" },
    });
  }) as unknown as typeof fetch;
  return new AudioCppClient({ baseUrl: "http://tts:8081", timeoutMs: 1_000, fetchImpl, logger });
}

function makeConfig(overrides: Record<string, string | number> = {}): TtsPipelineConfig {
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

async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout en attendant");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Lance un run d'une phrase et attend la fin (`tts_end`). */
async function runOnce(deps: {
  store: VoiceStore;
  synthesizer: SegmentSynthesizer;
  logger: TtsLogger;
  config?: TtsPipelineConfig;
}): Promise<void> {
  const frames: Buffer[] = [];
  const pipeline = new TtsPipeline(
    {
      enabled: true,
      config: deps.config ?? makeConfig(),
      synthesizer: deps.synthesizer,
      // Câblage EXACT de `src/index.ts`.
      resolveVoice: (id) => deps.store.resolveVoice(id).voice,
      logger: deps.logger,
      sleep: async () => undefined,
    },
    {
      emitAudio: (_s, frame) => frames.push(frame),
      emitControl: (_s, frame) => frames.push(frame),
      onStage: () => undefined,
      onMetrics: () => undefined,
    },
  );
  pipeline.onRunStarted("sess", "run", 0);
  pipeline.onContent("sess", "run", "Bonjour le monde.");
  pipeline.onRunFinished("sess", "run", "done");
  await until(() =>
    frames.some((frame) => decodeTtsFrame(frame)?.header.type === "tts_end"),
  );
}

describe("pipeline → adaptateur : voix envoyée au moteur", () => {
  it("registre avec un preset + `tts.voice` VIDE ⇒ voice_ref du preset (cas corrigé)", async () => {
    const dir = tempDir();
    seedPreset(dir);
    const store = new VoiceStore({ dir });
    const { logger } = captureLogger();
    const captured: Captured[] = [];
    const synthesizer = createAudioCppSynthesizer(recordingClient(captured, logger), {
      voiceBaseDir: "/voices",
    });

    await runOnce({ store, synthesizer, logger });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.body.voice).toBe("voix-fr");
    expect(captured[0]!.body.voice_ref).toBe("/voices/presets/voix-fr.wav");
    expect(captured[0]!.body.reference_text).toBe("bonjour");
    expect(captured[0]!.url).toBe("http://tts:8081/v1/audio/speech");
  });

  it("registre VIDE ⇒ aucune clé de voix (comportement conservé)", async () => {
    const store = new VoiceStore({ dir: tempDir() });
    const { logger } = captureLogger();
    const captured: Captured[] = [];
    const synthesizer = createAudioCppSynthesizer(recordingClient(captured, logger), {
      voiceBaseDir: "/voices",
    });

    await runOnce({ store, synthesizer, logger });

    expect(captured).toHaveLength(1);
    expect(captured[0]!.body.voice).toBeUndefined();
    expect(captured[0]!.body.voice_ref).toBeUndefined();
  });

  it("`tts.voice` INCONNU ⇒ repli sur le preset par défaut", async () => {
    const dir = tempDir();
    seedPreset(dir);
    const store = new VoiceStore({ dir });
    const { logger } = captureLogger();
    const captured: Captured[] = [];
    const synthesizer = createAudioCppSynthesizer(recordingClient(captured, logger), {
      voiceBaseDir: "/voices",
    });

    await runOnce({
      store,
      synthesizer,
      logger,
      config: makeConfig({ "tts.voice": "disparue" }),
    });

    expect(captured[0]!.body.voice).toBe("voix-fr");
    expect(captured[0]!.body.voice_ref).toBe("/voices/presets/voix-fr.wav");
  });

  it("`tts.voice` connu ⇒ cette voix précisément", async () => {
    const dir = tempDir();
    seedPreset(dir, "autre");
    const store = new VoiceStore({ dir });
    const { logger } = captureLogger();
    const captured: Captured[] = [];
    const synthesizer = createAudioCppSynthesizer(recordingClient(captured, logger), {
      voiceBaseDir: "/voices",
    });

    await runOnce({
      store,
      synthesizer,
      logger,
      config: makeConfig({ "tts.voice": "autre" }),
    });

    expect(captured[0]!.body.voice).toBe("autre");
    expect(captured[0]!.body.voice_ref).toBe("/voices/presets/autre.wav");
  });

  it("registre ajouté APRÈS l'init du store ⇒ vu sans redémarrage (aucun cache)", async () => {
    const dir = tempDir();
    const store = new VoiceStore({ dir }); // registre absent à l'instanciation
    expect(store.list()).toEqual([]);
    seedPreset(dir); // ajout après coup

    const { logger } = captureLogger();
    const captured: Captured[] = [];
    const synthesizer = createAudioCppSynthesizer(recordingClient(captured, logger), {
      voiceBaseDir: "/voices",
    });

    await runOnce({ store, synthesizer, logger });

    expect(captured[0]!.body.voice_ref).toBe("/voices/presets/voix-fr.wav");
  });
});

describe("garde-fou : `refAudio` absent ⇒ échec propre (pas d'appel moteur)", () => {
  it("le pipeline n'appelle PAS le moteur et journalise un message clair", async () => {
    const dir = tempDir();
    seedPreset(dir);
    rmSync(join(dir, "presets", "voix-fr.wav")); // entrée conservée, fichier disparu
    const store = new VoiceStore({ dir });
    const { logger, warns } = captureLogger();
    const captured: Captured[] = [];
    const base = createAudioCppSynthesizer(recordingClient(captured, logger), {
      voiceBaseDir: "/voices",
    });
    // Même garde-fou que `src/index.ts` (segmentSynthesizer).
    const guarded: SegmentSynthesizer = async (request) => {
      store.assertSample(request.voice);
      return base(request);
    };

    await runOnce({ store, synthesizer: guarded, logger });

    expect(captured).toEqual([]); // le moteur n'a jamais été appelé
    const failed = warns.find((entry) => entry.message === "tts.segment.failed");
    expect(failed).toBeDefined();
    expect(String(failed?.fields?.error)).toContain("Fichier de référence introuvable");
    expect(String(failed?.fields?.error)).toContain("voix-fr.wav");
  });
});

describe("cohérence pipeline / test-route : même résolution, même corps", () => {
  const adapterOptions: ToAudioCppOptions = {
    language: "fr",
    emotion: "neutre",
    exaggeration: 500,
    cfg: 500,
    speed: 100,
    baseUrl: "http://tts:8081",
    engine: "chatterbox",
    voiceBaseDir: "/voices",
  };

  it("voix par défaut (tts.voice vide) : corps identique dans les deux chemins", async () => {
    const dir = tempDir();
    seedPreset(dir);
    const store = new VoiceStore({ dir });
    const { logger } = captureLogger();

    // Chemin PIPELINE.
    const captured: Captured[] = [];
    const synthesizer = createAudioCppSynthesizer(recordingClient(captured, logger), {
      voiceBaseDir: "/voices",
    });
    await runOnce({ store, synthesizer, logger });

    // Chemin TEST/APERÇU : même résolveur, puis même adaptateur.
    const id = "";
    const voice = store.resolveVoice(id).voice;
    const testBody = JSON.parse(
      toAudioCppRequest(voice, "Bonjour le monde.", adapterOptions).body,
    ) as Record<string, unknown>;

    // Seul le texte diffère (segmenté) : les clés de voix sont identiques.
    expect(captured[0]!.body.voice).toBe(testBody.voice);
    expect(captured[0]!.body.voice_ref).toBe(testBody.voice_ref);
  });
});
