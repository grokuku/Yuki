/**
 * Framing binaire `YTA1` (Lot 7, §4.5) — encodage/décodage aller-retour.
 */

import { describe, expect, it } from "vitest";

import {
  decodeTtsFrame,
  encodeTtsFrame,
  TTS_FRAME_CODEC,
  TTS_FRAME_MAGIC,
  TTS_FRAME_VERSION,
  type TtsFrameHeader,
} from "../../src/tts/framing.js";

function header(overrides: Partial<TtsFrameHeader> = {}): TtsFrameHeader {
  return {
    v: TTS_FRAME_VERSION,
    type: "tts_audio",
    sessionId: "sess-1",
    runId: "run-1",
    segmentIndex: 2,
    chunkIndex: 1,
    codec: TTS_FRAME_CODEC,
    sampleRate: 24000,
    channels: 1,
    byteLength: 0,
    final: false,
    ...overrides,
  };
}

describe("framing YTA1 — aller-retour", () => {
  it("encode puis décode une trame audio avec payload", () => {
    const payload = Buffer.from([0, 1, 2, 3, 0xff, 0x7f, 0x80, 0x00]);
    const frame = encodeTtsFrame(header({ byteLength: payload.length }), payload);
    expect(frame.subarray(0, 4).toString("ascii")).toBe(TTS_FRAME_MAGIC);

    const decoded = decodeTtsFrame(frame);
    expect(decoded).not.toBeNull();
    expect(decoded?.header.type).toBe("tts_audio");
    expect(decoded?.header.segmentIndex).toBe(2);
    expect(decoded?.header.chunkIndex).toBe(1);
    expect(decoded?.header.codec).toBe(TTS_FRAME_CODEC);
    expect(decoded?.header.sampleRate).toBe(24000);
    expect(decoded?.header.channels).toBe(1);
    expect(decoded?.header.byteLength).toBe(payload.length);
    expect(decoded?.payload.equals(payload)).toBe(true);
  });

  it("le payload peut contenir n'importe quel octet (magic inclus)", () => {
    const payload = Buffer.from("YTA1YTA1YTA1", "ascii");
    const decoded = decodeTtsFrame(encodeTtsFrame(header(), payload));
    expect(decoded?.payload.toString("ascii")).toBe("YTA1YTA1YTA1");
  });

  it("encode une trame de contrôle (payload vide)", () => {
    const decoded = decodeTtsFrame(encodeTtsFrame(header({ type: "tts_cancel" }), Buffer.alloc(0)));
    expect(decoded?.header.type).toBe("tts_cancel");
    expect(decoded?.payload.length).toBe(0);
    expect(decoded?.header.byteLength).toBe(0);
  });

  it("force `byteLength` sur la taille réelle du payload", () => {
    const frame = encodeTtsFrame(header({ byteLength: 999 }), Buffer.alloc(4));
    expect(decodeTtsFrame(frame)?.header.byteLength).toBe(4);
  });
});

describe("framing YTA1 — robustesse (jamais d'exception)", () => {
  it("rejette une trame trop courte", () => {
    expect(decodeTtsFrame(Buffer.alloc(3))).toBeNull();
  });

  it("rejette un magic absent", () => {
    const frame = encodeTtsFrame(header(), Buffer.alloc(2));
    frame.write("XXXX", 0, 4, "ascii");
    expect(decodeTtsFrame(frame)).toBeNull();
  });

  it("rejette un headerLen incohérent", () => {
    const frame = encodeTtsFrame(header(), Buffer.alloc(2));
    frame.writeUInt32BE(10_000, 4);
    expect(decodeTtsFrame(frame)).toBeNull();
  });

  it("rejette un JSON illisible", () => {
    const prefix = Buffer.alloc(8);
    prefix.write(TTS_FRAME_MAGIC, 0, 4, "ascii");
    prefix.writeUInt32BE(3, 4);
    expect(decodeTtsFrame(Buffer.concat([prefix, Buffer.from("n/a")]))).toBeNull();
  });

  it("rejette un type inconnu", () => {
    const frame = encodeTtsFrame(
      { ...header(), type: "other" as TtsFrameHeader["type"] },
      Buffer.alloc(0),
    );
    expect(decodeTtsFrame(frame)).toBeNull();
  });
});
