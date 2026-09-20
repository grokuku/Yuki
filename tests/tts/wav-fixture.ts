/**
 * Générateur de WAV PCM minimal pour les tests TTS (AUCUN moteur requis).
 *
 * Produit un conteneur RIFF/WAVE mono PCM 16 bits conforme, de durée
 * paramétrable — c'est ce que les agents peuvent valider sans GPU ni service
 * `audio.cpp` (spec §13 : la qualité acoustique n'est pas vérifiable ici).
 */

export interface WavOptions {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  seconds?: number;
}

/** Construit un WAV PCM entête + données (44 octets d'en-tête standard). */
export function makeWav(options: WavOptions = {}): Buffer {
  const sampleRate = options.sampleRate ?? 24_000;
  const channels = options.channels ?? 1;
  const bitsPerSample = options.bitsPerSample ?? 16;
  const seconds = options.seconds ?? 1;
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = Math.floor(sampleRate * seconds) * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}
