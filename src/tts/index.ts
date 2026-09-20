/**
 * Domaine TTS (Lot 7) — socle serveur.
 *
 * Expose : le **magasin de voix** (registre + WAV), le **client HTTP** du moteur
 * `audio.cpp` et son **adaptateur unique** (`toAudioCppRequest`), la validation
 * des échantillons WAV et le pont de configuration (`tts.*`). Aucun câblage
 * dans le pipeline de conversation dans ce lot.
 */

export type {
  Voice,
  VoiceKind,
  VoiceCreator,
  VoicePublic,
  TtsEmotion,
  TtsOptions,
  TtsFrameType,
} from "./types.js";
export { toPublicVoice } from "./types.js";

export {
  readWavInfo,
  readWavDataInfo,
  findWavDataOffset,
  validateVoiceSample,
  MAX_VOICE_DURATION_SECONDS,
  type WavInfo,
  type WavValidation,
} from "./wav.js";

export {
  VoiceStore,
  VoiceStoreError,
  slugifyVoiceId,
  isValidVoiceId,
  MAX_VOICE_BODY_BYTES,
  DEFAULT_MAX_VOICES,
  DEFAULT_MAX_VOICES_BYTES,
  type VoiceStoreOptions,
  type CreateVoiceInput,
} from "./voices-store.js";

export {
  resolveEmotionValues,
  readTtsOptions,
  isTtsEnabled,
  type TtsConfigReader,
  type EmotionValues,
} from "./options.js";

export {
  AudioCppClient,
  AudioCppError,
  AudioCppBusyError,
  toAudioCppRequest,
  AUDIO_CPP_KEYS,
  AUDIO_CPP_SPEECH_PATH,
  type AudioCppClientOptions,
  type AudioCppRequest,
  type SynthesizeParams,
  type SpeechStreamResult,
  type SpeechBufferResult,
  type ToAudioCppOptions,
  type TtsLogger,
} from "./audio-cpp.js";

// --- Lot B : segmentation, framing, synthèse, pipeline ----------------------

export {
  MarkdownSpeechFilter,
  type MarkdownFilterOptions,
} from "./markdown.js";

export {
  SentenceSegmenter,
  findSentenceEnd,
  forcedCutIndex,
  type SegmenterOptions,
} from "./segmenter.js";

export {
  encodeTtsFrame,
  decodeTtsFrame,
  TTS_FRAME_MAGIC,
  TTS_FRAME_VERSION,
  TTS_FRAME_PREFIX_BYTES,
  TTS_FRAME_CODEC,
  type TtsFrameHeader,
  type DecodedTtsFrame,
} from "./framing.js";

export {
  createAudioCppSynthesizer,
  DEFAULT_SAMPLE_RATE,
  type SegmentSynthesizer,
  type SynthesizeRequest,
  type AudioStreamEvent,
  type AudioCppSynthesizerOptions,
} from "./synthesizer.js";

export {
  TtsPipeline,
  TtsQueue,
  type TtsRunMetrics,
  type TtsSegment,
  type TtsPipelineConfig,
  type TtsPipelineDeps,
  type TtsPipelineCallbacks,
} from "./pipeline.js";
