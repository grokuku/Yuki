/**
 * Lecture et validation d'échantillons WAV (Lot 7, §10.3).
 *
 * Un échantillon de référence est **validé côté serveur** avant toute écriture :
 * conteneur RIFF/WAVE, bloc `fmt ` PCM, durée bornée. On ne fait **jamais**
 * confiance au nom ou au `content-type` fournis par le client.
 *
 * Le parseur est volontairement défensif : il borne chaque lecture dans le
 * `Buffer`, tolère les chunks inconnus (JUNK, LIST…) et le rembourrage des
 * chunks de taille impaire, et ne lève jamais.
 */

/** Durée maximale d'un échantillon de référence (secondes). */
export const MAX_VOICE_DURATION_SECONDS = 10;
/** Fréquence d'échantillonnage maximale plausible (garde-fou anti-abus). */
export const MAX_VOICE_SAMPLE_RATE = 192_000;
/** Formats PCM acceptés : PCM entier (1) et WAVE_FORMAT_EXTENSIBLE (0xFFFE). */
const PCM_FORMATS = new Set([1, 0xfffe]);
/** Profondeurs PCM acceptées (signées) — 24/32 bits restent rééchantillonnables. */
const PCM_BIT_DEPTHS = new Set([16, 24, 32]);

export interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  /** Octets de données PCM réellement présents (borné au buffer). */
  dataSize: number;
  durationSeconds: number;
}

export type WavValidation =
  | { ok: true; info: WavInfo }
  | { ok: false; code: string; message: string };

/**
 * Lit l'en-tête d'un WAV. Renvoie `null` si le conteneur RIFF/WAVE est absent ou
 * si les blocs `fmt `/`data` sont introuvables.
 */
export function readWavInfo(buffer: Buffer): WavInfo | null {
  if (buffer.length < 12) return null;
  if (buffer.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  let audioFormat: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let bitsPerSample: number | undefined;
  let blockAlign: number | undefined;
  let dataSize: number | undefined;

  let pos = 12;
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString("ascii", pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    const start = pos + 8;

    if (id === "fmt " && size >= 16 && start + 16 <= buffer.length) {
      audioFormat = buffer.readUInt16LE(start);
      channels = buffer.readUInt16LE(start + 2);
      sampleRate = buffer.readUInt32LE(start + 4);
      blockAlign = buffer.readUInt16LE(start + 12);
      bitsPerSample = buffer.readUInt16LE(start + 14);
    } else if (id === "data") {
      const available = buffer.length - start;
      // Certains encodeurs écrivent une taille sentinelle : on borne au réel.
      dataSize = Math.min(size, Math.max(0, available));
    }

    // Les chunks sont alignés sur un mot (rembourrage si taille impaire).
    const advance = size + (size % 2);
    if (advance <= 0 || start + advance > buffer.length) break;
    pos = start + advance;
  }

  if (
    audioFormat === undefined ||
    channels === undefined ||
    sampleRate === undefined ||
    bitsPerSample === undefined ||
    blockAlign === undefined ||
    dataSize === undefined
  ) {
    return null;
  }

  const bytesPerSecond = blockAlign * sampleRate;
  const durationSeconds =
    bytesPerSecond > 0 ? dataSize / bytesPerSecond : 0;
  return {
    audioFormat,
    channels,
    sampleRate,
    bitsPerSample,
    blockAlign,
    dataSize,
    durationSeconds,
  };
}

/**
 * Localise le début du payload PCM du bloc `data`. `null` s'il est absent.
 * (Sert au parsing **incrémental** d'un WAV reçu en flux : on connaît le format
 * dès que `fmt ` est lu, et on peut alors streamer le payload.)
 */
export function findWavDataOffset(buffer: Buffer): number | null {
  if (
    buffer.length < 12 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return null;
  }
  let pos = 12;
  while (pos + 8 <= buffer.length) {
    const id = buffer.toString("ascii", pos, pos + 4);
    const size = buffer.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (id === "data") return start;
    const advance = size + (size % 2);
    if (advance <= 0 || start + advance > buffer.length) break;
    pos = start + advance;
  }
  return null;
}

/**
 * Lit à la fois l'en-tête `fmt ` et l'offset du payload `data`. Renvoie `null`
 * tant que l'en-tête n'est pas encore complet (cas d'un flux WAV incrémental).
 */
export function readWavDataInfo(
  buffer: Buffer,
): { info: WavInfo; dataOffset: number } | null {
  const info = readWavInfo(buffer);
  if (!info) return null;
  const dataOffset = findWavDataOffset(buffer);
  if (dataOffset === null) return null;
  return { info, dataOffset };
}

/**
 * Valide un échantillon de référence destiné au clonage.
 *
 * Refus **explicites** (jamais un 500 muet) : conteneur, format PCM, canaux,
 * fréquence, durée. La **taille** est vérifiée en amont par la limite de corps
 * (`MAX_VOICE_BODY_BYTES`), mais on la contrôle aussi ici pour les appels
 * directs au store (tests, presets).
 */
export function validateVoiceSample(
  buffer: Buffer,
  options: { maxBytes: number },
): WavValidation {
  if (buffer.length === 0) {
    return { ok: false, code: "empty_body", message: "Échantillon vide." };
  }
  if (buffer.length > options.maxBytes) {
    return {
      ok: false,
      code: "too_large",
      message: `Échantillon trop volumineux (maximum ${options.maxBytes} octets).`,
    };
  }
  if (
    buffer.length < 12 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return {
      ok: false,
      code: "not_wav",
      message: "En-tête RIFF/WAVE attendu (fichier WAV non compressé).",
    };
  }

  const info = readWavInfo(buffer);
  if (!info || info.dataSize <= 0) {
    return {
      ok: false,
      code: "missing_fmt",
      message: "Blocs `fmt ` et `data` (PCM) introuvables dans le WAV.",
    };
  }
  if (!PCM_FORMATS.has(info.audioFormat)) {
    return {
      ok: false,
      code: "unsupported_format",
      message: "Seul le PCM non compressé est accepté.",
    };
  }
  if (!PCM_BIT_DEPTHS.has(info.bitsPerSample)) {
    return {
      ok: false,
      code: "unsupported_bit_depth",
      message: "Profondeur PCM acceptée : 16, 24 ou 32 bits.",
    };
  }
  if (info.channels < 1 || info.channels > 2) {
    return {
      ok: false,
      code: "unsupported_channels",
      message: "Mono ou stéréo uniquement.",
    };
  }
  if (
    info.blockAlign <= 0 ||
    info.sampleRate <= 0 ||
    info.sampleRate > MAX_VOICE_SAMPLE_RATE
  ) {
    return {
      ok: false,
      code: "invalid_sample_rate",
      message: `Fréquence d'échantillonnage invalide (maximum ${MAX_VOICE_SAMPLE_RATE} Hz).`,
    };
  }
  if (info.durationSeconds > MAX_VOICE_DURATION_SECONDS) {
    return {
      ok: false,
      code: "too_long",
      message: `Durée maximale : ${MAX_VOICE_DURATION_SECONDS} s (reçu ${info.durationSeconds.toFixed(1)} s).`,
    };
  }
  return { ok: true, info };
}
