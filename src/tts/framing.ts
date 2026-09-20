/**
 * Framing binaire des trames audio (Lot 7, §4) — **contrat** serveur → client.
 *
 * Les trames audio transitent sur `/ws` en **binaire** (jamais dans le flux JSON
 * à `seq`). Format :
 *
 * ```
 * ┌────────────┬──────────────────┬───────────────────────┬──────────────────────┐
 * │ magic (4)  │ headerLen (4)    │ header JSON (UTF-8)   │ payload PCM (n octets) │
 * │ "YTA1"     │ u32 big-endian   │ { …métadonnées… }     │ s16le, mono            │
 * └────────────┴──────────────────┴───────────────────────┴──────────────────────┘
 * ```
 *
 * Le `headerLen` rend l'analyse robuste (le PCM peut contenir n'importe quel
 * octet) et le `magic` permet de rejeter proprement une trame inattendue.
 * Voir `docs/lot7.md` §4.5 pour le contrat complet.
 */

import type { TtsFrameType } from "./types.js";

/** Magic d'identification de la trame (« Yuki TTS Audio v1 »). */
export const TTS_FRAME_MAGIC = "YTA1";
/** Taille de l'en-tête de framing : magic (4) + headerLen (4). */
export const TTS_FRAME_PREFIX_BYTES = 8;
/** Version du framing. */
export const TTS_FRAME_VERSION = 1;
/** Codec audio transporté (PCM signé 16 bits little-endian, mono). */
export const TTS_FRAME_CODEC = "pcm_s16le";

/** Métadonnées de trame (`YTA1`). */
export interface TtsFrameHeader {
  /** Version du framing (`1`). */
  v: number;
  /** Nature de la trame. */
  type: TtsFrameType;
  sessionId: string;
  runId: string;
  /** Index de segment, monotone par run, ordonne la lecture. */
  segmentIndex: number;
  /** Index du bloc PCM dans le segment (concaténation ordonnée). */
  chunkIndex: number;
  /** Codec (`pcm_s16le`). */
  codec: string;
  /** Fréquence NATIVE du moteur (pas de rééchantillonnage). */
  sampleRate: number;
  /** Canaux (1 = mono). */
  channels: number;
  /** Octets de payload PCM. */
  byteLength: number;
  /** Dernier bloc PCM de **ce segment** (`true` sur la clôture de segment). */
  final: boolean;
}

export interface DecodedTtsFrame {
  header: TtsFrameHeader;
  payload: Buffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInt(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : fallback;
}

/** Encode une trame binaire `YTA1`. */
export function encodeTtsFrame(header: TtsFrameHeader, payload: Buffer): Buffer {
  const headerJson = Buffer.from(
    JSON.stringify({ ...header, byteLength: payload.length }),
    "utf8",
  );
  const prefix = Buffer.alloc(TTS_FRAME_PREFIX_BYTES);
  prefix.write(TTS_FRAME_MAGIC, 0, 4, "ascii");
  prefix.writeUInt32BE(headerJson.length, 4);
  return Buffer.concat([prefix, headerJson, payload]);
}

/**
 * Décode une trame binaire `YTA1`. Renvoie `null` si elle est invalide (magic
 * absent, en-tête tronqué, JSON illisible, longueur incohérente) — ne lève
 * jamais : une trame inattendue est ignorée proprement.
 */
export function decodeTtsFrame(frame: Buffer): DecodedTtsFrame | null {
  if (frame.length < TTS_FRAME_PREFIX_BYTES) return null;
  if (frame.toString("ascii", 0, 4) !== TTS_FRAME_MAGIC) return null;
  const headerLen = frame.readUInt32BE(4);
  if (headerLen <= 0 || TTS_FRAME_PREFIX_BYTES + headerLen > frame.length) {
    return null;
  }
  const json = frame.toString("utf8", TTS_FRAME_PREFIX_BYTES, TTS_FRAME_PREFIX_BYTES + headerLen);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const type = parsed.type;
  if (type !== "tts_audio" && type !== "tts_end" && type !== "tts_cancel") {
    return null;
  }
  const payload = frame.subarray(TTS_FRAME_PREFIX_BYTES + headerLen);
  const header: TtsFrameHeader = {
    v: asInt(parsed.v, TTS_FRAME_VERSION),
    type,
    sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "",
    runId: typeof parsed.runId === "string" ? parsed.runId : "",
    segmentIndex: asInt(parsed.segmentIndex),
    chunkIndex: asInt(parsed.chunkIndex),
    codec: typeof parsed.codec === "string" ? parsed.codec : TTS_FRAME_CODEC,
    sampleRate: asInt(parsed.sampleRate),
    channels: asInt(parsed.channels, 1),
    byteLength: asInt(parsed.byteLength, payload.length),
    final: parsed.final === true,
  };
  if (header.byteLength !== payload.length) return null;
  return { header, payload };
}
