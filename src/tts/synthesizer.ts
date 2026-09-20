/**
 * Synthèse d'un segment de texte → flux PCM (Lot 7).
 *
 * Le pipeline TTS dépend d'une interface **injectable** (`SegmentSynthesizer`)
 * pour rester testable **sans moteur** : les tests fournissent un flux
 * déterministe. L'implémentation par défaut s'appuie sur le client HTTP du
 * moteur `audio.cpp`.
 *
 * ⚠️ Contrat moteur. Le seul contrat **attesté** (socle Lot A) est le mode
 * **WAV** (`response_format: "wav"`, `accept: audio/wav`). Le parsing du WAV se
 * fait de façon **incrémentale** : dès que les blocs `fmt ` + `data` sont lus,
 * la fréquence **native** est connue (aucun rééchantillonnage) et le payload PCM
 * est relayé au fil de l'eau. Le mode SSE (`stream_format: "sse"`) n'est pas
 * employé ici : son découpage exact n'est pas prouvé (spec §10.2, C1) ; le point
 * de branchement reste l'interface injectable.
 */

import {
  AudioCppError,
  type AudioCppClient,
  type SpeechStreamResult,
} from "./audio-cpp.js";
import type { TtsLogger } from "./audio-cpp.js";
import type { TtsOptions, Voice } from "./types.js";
import { findWavDataOffset, readWavInfo } from "./wav.js";

/** Taille maximale tolérée pour l'en-tête WAV avant abandon. */
const MAX_WAV_HEADER_BYTES = 1 << 20;
/** Fréquence supposée si le moteur renvoie du PCM brut sans en-tête. */
export const DEFAULT_SAMPLE_RATE = 24_000;

/** Premier événement = format natif ; suivants = blocs PCM (`pcm_s16le`). */
export type AudioStreamEvent =
  | { type: "format"; sampleRate: number; channels: number }
  | { type: "data"; bytes: Buffer };

export interface SynthesizeRequest {
  voice: Voice | null;
  text: string;
  options: TtsOptions;
  engine: string;
  /** Annulation (barge-in / purge). */
  signal: AbortSignal;
}

/** Fonction de synthèse d'un segment (injectable pour les tests). */
export type SegmentSynthesizer = (
  request: SynthesizeRequest,
) => Promise<AsyncIterable<AudioStreamEvent>>;

export interface AudioCppSynthesizerOptions {
  /** Chemin de montage des voix dans le conteneur `tts` (défaut `/voices`). */
  voiceBaseDir?: string;
  logger?: TtsLogger;
}

function abortedError(): AudioCppError {
  return new AudioCppError("aborted", "Synthèse annulée (barge-in).");
}

async function cancelReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // La source peut déjà être fermée/annulée : sans conséquence.
  }
}

/** Relaie un flux WAV reçu : format natif dès l'en-tête, puis PCM. */
async function* streamWav(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<AudioStreamEvent> {
  const reader = body.getReader();
  let pending = Buffer.alloc(0);
  let headerDone = false;
  try {
    for (;;) {
      if (signal.aborted) throw abortedError();
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (headerDone) {
        if (chunk.length > 0) yield { type: "data", bytes: chunk };
        continue;
      }
      pending = Buffer.concat([pending, chunk]);
      const info = readWavInfo(pending);
      const dataOffset = findWavDataOffset(pending);
      if (info && dataOffset !== null) {
        yield {
          type: "format",
          sampleRate: info.sampleRate,
          channels: info.channels,
        };
        if (pending.length > dataOffset) {
          yield { type: "data", bytes: pending.subarray(dataOffset) };
        }
        pending = Buffer.alloc(0);
        headerDone = true;
      } else if (pending.length > MAX_WAV_HEADER_BYTES) {
        throw new AudioCppError("http_error", "En-tête WAV illisible ou trop long.");
      }
    }
    if (!headerDone) {
      throw new AudioCppError("http_error", "Réponse WAV incomplète.");
    }
  } finally {
    await cancelReader(reader);
  }
}

/** Relaie un flux PCM brut (format supposé, faute de contrat SSE prouvé). */
async function* streamRawPcm(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  sampleRate: number,
): AsyncGenerator<AudioStreamEvent> {
  const reader = body.getReader();
  yield { type: "format", sampleRate, channels: 1 };
  try {
    for (;;) {
      if (signal.aborted) throw abortedError();
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      if (chunk.length > 0) yield { type: "data", bytes: chunk };
    }
  } finally {
    await cancelReader(reader);
  }
}

/**
 * Synthétiseur par défaut : appelle `POST /v1/audio/speech` et relaie le PCM.
 * Un flux sans corps (réponse vide) est refusé explicitement.
 */
export function createAudioCppSynthesizer(
  client: AudioCppClient,
  options: AudioCppSynthesizerOptions = {},
): SegmentSynthesizer {
  return async (request: SynthesizeRequest): Promise<AsyncIterable<AudioStreamEvent>> => {
    let result: SpeechStreamResult;
    try {
      result = await client.synthesize({
        voice: request.voice,
        text: request.text,
        options: request.options,
        engine: request.engine,
        signal: request.signal,
        ...(options.voiceBaseDir ? { voiceBaseDir: options.voiceBaseDir } : {}),
      });
    } catch (error) {
      if (error instanceof AudioCppError) throw error;
      throw new AudioCppError(
        "network_error",
        error instanceof Error ? error.message : String(error),
      );
    }
    const body = result.body;
    if (!body) {
      throw new AudioCppError("http_error", "Réponse TTS sans corps.");
    }
    const contentType = (result.contentType ?? "").toLowerCase();
    if (contentType.includes("wav")) {
      return streamWav(body, request.signal);
    }
    if (contentType.includes("event-stream")) {
      // Le découpage SSE n'est pas attesté (spec §10.2, C1) : mieux vaut un
      // échec explicite (retry borné puis abandon) que lire du texte comme du PCM.
      throw new AudioCppError(
        "http_error",
        "Réponse TTS SSE non prise en charge (contrat non prouvé).",
      );
    }
    return streamRawPcm(body, request.signal, DEFAULT_SAMPLE_RATE);
  };
}
