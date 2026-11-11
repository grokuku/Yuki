/**
 * ⚠️ LOT 36 (L11) — LA VOIX EST CELLE DU BOT QUI PARLE.
 *
 * `tts.voice`, `tts.emotion`, `tts.speed`, `tts.exaggeration` et `tts.cfg` sont
 * des clés de portée `bot` (`src/config/schema.ts`). Le pipeline reçoit donc une
 * configuration PAR BOT (`configPour`) ; le moteur et la connexion restent
 * d'instance.
 *
 * ⚠️ Échoue sur le code d'origine : `configPour` n'existe pas, le pipeline ne
 * lit que la configuration d'instance — `kohai` parlait avec la voix de `yuki`.
 */

import { describe, expect, it } from "vitest";

import { decodeTtsFrame } from "../../src/tts/framing.js";
import {
  TtsPipeline,
  type TtsPipelineConfig,
  type TtsPipelineDeps,
} from "../../src/tts/pipeline.js";
import type { SegmentSynthesizer } from "../../src/tts/synthesizer.js";
import type { TtsOptions, Voice } from "../../src/tts/types.js";

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function config(voix: string, emotion = "neutre"): TtsPipelineConfig {
  const valeurs: Record<string, string | number> = {
    "tts.prefetchDepth": 2,
    "tts.minSentenceChars": 1,
    "tts.maxSentenceChars": 500,
    "tts.engine": "chatterbox",
    "tts.voice": voix,
    "tts.emotion": emotion,
    "tts.exaggeration": 500,
    "tts.cfg": 500,
    "tts.speed": 100,
    "tts.language": "fr",
  };
  return {
    getString: (chemin) => String(valeurs[chemin] ?? ""),
    getNumber: (chemin) => Number(valeurs[chemin] ?? 0),
  };
}

const voix = (id: string): Voice => ({ id, label: id }) as unknown as Voice;

interface Appel {
  voiceId: string | null;
  options: TtsOptions;
}

function banc() {
  const appels: Appel[] = [];
  const synthesizer: SegmentSynthesizer = async (request) => {
    appels.push({ voiceId: request.voice?.id ?? null, options: request.options });
    return (async function* () {
      yield { type: "format" as const, sampleRate: 16_000, channels: 1 };
      yield { type: "data" as const, bytes: Buffer.from([1, 2]) };
    })();
  };
  const deps: TtsPipelineDeps = {
    enabled: true,
    // Configuration d'INSTANCE (celle du bot de la pile).
    config: config("voix-yuki"),
    configPour: (botId) =>
      botId === "kohai" ? config("voix-kohai", "expressive") : config("voix-yuki"),
    synthesizer,
    resolveVoice: (id) => (id.length > 0 ? voix(id) : null),
    logger,
    sleep: async () => undefined,
  };
  const frames: Buffer[] = [];
  const pipeline = new TtsPipeline(deps, {
    emitAudio: (_sessionId, frame) => frames.push(frame),
    emitControl: (_sessionId, frame) => frames.push(frame),
    onStage: () => undefined,
    onMetrics: () => undefined,
  });
  return { pipeline, appels, frames, deps };
}

async function attendre(predicat: () => boolean, ms = 2_000): Promise<void> {
  const debut = Date.now();
  while (!predicat()) {
    if (Date.now() - debut > ms) throw new Error("timeout en attendant la synthèse");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("pipeline TTS par bot (lot 36, L11)", () => {
  it("`kohai` parle avec la voix de SON `configBot`, pas celle du principal", async () => {
    const b = banc();
    b.pipeline.onRunStarted("sess-kohai", "run-kohai", 0, "kohai");
    b.pipeline.onContent("sess-kohai", "run-kohai", "Bonjour. ");
    b.pipeline.onRunFinished("sess-kohai", "run-kohai", "done");
    await attendre(() => b.appels.length > 0);

    expect(b.appels[0]?.voiceId).toBe("voix-kohai");
    // ⚠️ Les options de synthèse suivent la même configuration (émotion `bot`).
    expect(b.appels[0]?.options.emotion).toBe("expressive");
  });

  it("le PRINCIPAL est inchangé : sans botId, la configuration d'instance est utilisée", async () => {
    const b = banc();
    b.pipeline.onRunStarted("sess-yuki", "run-yuki", 0);
    b.pipeline.onContent("sess-yuki", "run-yuki", "Bonjour. ");
    b.pipeline.onRunFinished("sess-yuki", "run-yuki", "done");
    await attendre(() => b.appels.length > 0);

    expect(b.appels[0]?.voiceId).toBe("voix-yuki");
    expect(b.appels[0]?.options.emotion).toBe("neutre");
  });

  it("un bot INCONNU retombe sur la configuration d'instance (jamais une voix muette)", async () => {
    const b = banc();
    b.pipeline.onRunStarted("sess-x", "run-x", 0, "senpai");
    b.pipeline.onContent("sess-x", "run-x", "Bonjour. ");
    b.pipeline.onRunFinished("sess-x", "run-x", "done");
    await attendre(() => b.appels.length > 0);

    expect(b.appels[0]?.voiceId).toBe("voix-yuki");
    // Et les trames audio sont bien produites (aucune régression de transport).
    await attendre(() =>
      b.frames.some((frame) => decodeTtsFrame(frame)?.header.type === "tts_audio"),
    );
  });
});
