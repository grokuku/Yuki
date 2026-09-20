/**
 * Lecture et validation des échantillons WAV (Lot 7, §10.3).
 */

import { describe, expect, it } from "vitest";

import {
  MAX_VOICE_DURATION_SECONDS,
  findWavDataOffset,
  readWavDataInfo,
  readWavInfo,
  validateVoiceSample,
} from "../../src/tts/wav.js";
import { makeWav } from "./wav-fixture.js";

const MAX = 3_000_000;

describe("readWavInfo", () => {
  it("lit l'en-tête d'un WAV PCM mono 16 bits", () => {
    const info = readWavInfo(makeWav({ sampleRate: 24_000, seconds: 1 }));
    expect(info).not.toBeNull();
    expect(info?.audioFormat).toBe(1);
    expect(info?.channels).toBe(1);
    expect(info?.sampleRate).toBe(24_000);
    expect(info?.bitsPerSample).toBe(16);
    expect(info?.durationSeconds).toBeCloseTo(1, 2);
  });

  it("tolère un chunk inconnu et le rembourrage des chunks impairs", () => {
    const base = makeWav({ seconds: 1 });
    // Insère un chunk JUNK de taille IMPAIRE (5) juste après "WAVE".
    const junk = Buffer.concat([
      Buffer.from("JUNK", "ascii"),
      (() => {
        const size = Buffer.alloc(4);
        size.writeUInt32LE(5, 0);
        return size;
      })(),
      Buffer.from("abcde\0", "ascii"), // 5 octets + 1 de rembourrage
    ]);
    const patched = Buffer.concat([
      base.subarray(0, 12),
      junk,
      base.subarray(12),
    ]);
    const info = readWavInfo(patched);
    expect(info?.sampleRate).toBe(24_000);
    expect(info?.durationSeconds).toBeCloseTo(1, 2);
  });

  it("renvoie null sans conteneur RIFF/WAVE", () => {
    expect(readWavInfo(Buffer.from("not a wav"))).toBeNull();
    const fake = Buffer.alloc(64);
    fake.write("RIFX", 0, "ascii");
    expect(readWavInfo(fake)).toBeNull();
  });
});

describe("validateVoiceSample", () => {
  it("accepte un WAV PCM valide", () => {
    const result = validateVoiceSample(makeWav({ seconds: 3 }), { maxBytes: MAX });
    expect(result.ok).toBe(true);
  });

  it("refuse un corps vide", () => {
    const result = validateVoiceSample(Buffer.alloc(0), { maxBytes: MAX });
    expect(result).toMatchObject({ ok: false, code: "empty_body" });
  });

  it("refuse un conteneur non RIFF/WAVE", () => {
    const result = validateVoiceSample(Buffer.from("hello world"), { maxBytes: MAX });
    expect(result).toMatchObject({ ok: false, code: "not_wav" });
  });

  it("refuse une durée supérieure à la borne", () => {
    const result = validateVoiceSample(
      makeWav({ seconds: MAX_VOICE_DURATION_SECONDS + 2 }),
      { maxBytes: MAX },
    );
    expect(result).toMatchObject({ ok: false, code: "too_long" });
  });

  it("refuse au-delà de la taille maximale", () => {
    const result = validateVoiceSample(makeWav({ seconds: 1 }), { maxBytes: 10 });
    expect(result).toMatchObject({ ok: false, code: "too_large" });
  });

  it("refuse un format compressé (non PCM)", () => {
    const wav = makeWav({ seconds: 1 });
    wav.writeUInt16LE(3, 20); // IEEE float
    const result = validateVoiceSample(wav, { maxBytes: MAX });
    expect(result).toMatchObject({ ok: false, code: "unsupported_format" });
  });

  it("refuse plus de deux canaux", () => {
    const result = validateVoiceSample(makeWav({ channels: 3, seconds: 1 }), {
      maxBytes: MAX,
    });
    expect(result).toMatchObject({ ok: false, code: "unsupported_channels" });
  });
});

describe("findWavDataOffset / readWavDataInfo (parsing incrémental)", () => {
  it("localise le payload PCM après l'en-tête", () => {
    const wav = makeWav({ sampleRate: 24_000, seconds: 1 });
    expect(findWavDataOffset(wav)).toBe(44);
    const layout = readWavDataInfo(wav);
    expect(layout?.info.sampleRate).toBe(24_000);
    expect(layout?.info.channels).toBe(1);
    expect(layout?.dataOffset).toBe(44);
  });

  it("renvoie null tant que l'en-tête est incomplet", () => {
    const wav = makeWav({ seconds: 1 });
    expect(readWavDataInfo(wav.subarray(0, 10))).toBeNull();
    // `fmt ` présent mais `data` pas encore atteint → offset indisponible.
    expect(findWavDataOffset(wav.subarray(0, 36))).toBeNull();
  });
});
