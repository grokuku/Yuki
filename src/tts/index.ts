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
  VoiceReferenceError,
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
  voiceRefOf,
  engineSupportsSpeed,
  engineSupportsEmotion,
  AUDIO_CPP_KEYS,
  AUDIO_CPP_SPEECH_PATH,
  AUDIO_CPP_ERROR_BODY_LIMIT,
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
  MUTE_BLOCK_LABEL,
  MUTE_BLOCK_LABELS,
  isMuteInfoString,
} from "./mute.js";

export { SpeechSanitizer } from "./sanitize.js";

export {
  SentenceSegmenter,
  findSentenceEnd,
  forcedCutIndex,
  type SegmenterOptions,
  type SentenceEndOptions,
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

// --- Lot 9 : configuration STRUCTURÉE du moteur (`server.json`) -------------

export {
  EngineConfigStore,
  EngineConfigError,
  EngineCapabilitiesProbe,
  ENGINE_CONFIG_FILENAME,
  MODELS_DOWNLOADS_SUBDIR,
  ENGINE_TASK_TOKENS,
  ENGINE_MODES,
  ENGINE_FAMILIES,
  ENGINE_IDS,
  ENGINE_FORCE_OFFLINE_FAMILIES,
  ENGINE_GLOBAL_SCHEMA,
  ENGINE_UNLOAD_ROUTE,
  DISK_SCAN_MAX_DEPTH,
  DISK_SCAN_MAX_FILES,
  validateEngineConfig,
  type EngineConfigReport,
  type EngineConfigStoreOptions,
  type EngineConfigRaw,
  type EngineModelEntry,
  type EngineModelView,
  type EngineGlobalDescriptor,
  type EngineGlobalType,
  type EngineCapabilitiesReport,
  type EngineCapabilitiesOptions,
  type DiskModel,
  type MountState,
  type PathStatus,
  type FieldError,
} from "./engine-config.js";

// --- Lot 9, étape 2 : catalogue + téléchargement des modèles ----------------

export {
  CATALOG_SCHEMA_VERSION,
  CATALOG_ALLOWED_LICENSES,
  CATALOG_ENTRIES,
  CATALOG_REJECTIONS,
  DOWNLOAD_FILE_NAME,
  DOWNLOAD_PART_SUFFIX,
  HF_RESOLVE_BASE,
  HF_API_BASE,
  CatalogResolveError,
  findCatalogEntry,
  hfResolveUrl,
  hfTreeUrl,
  isAllowedLicense,
  resolveCatalogPackage,
  downloadEngineDir,
  downloadEnginePath,
  type CatalogEntry,
  type CatalogRejection,
  type ResolvedPackage,
  type ResolvedCatalogPackage,
  type ResolveCatalogOptions,
  type ResolveSource,
} from "./catalog-data.js";

export {
  DOWNLOAD_SCHEMA_VERSION,
  DOWNLOAD_TERMINAL_STATUSES,
  DEFAULT_DISK_MARGIN_BYTES,
  DEFAULT_PROGRESS_INTERVAL_MS,
  DEFAULT_RESOLVE_TIMEOUT_MS,
  TtsDownloadManager,
  TtsDownloadError,
  contentRangeTotal,
  hashFileInto,
  isDownloadTerminal,
  type DownloadLogger,
  type DownloadStatus,
  type DownloadTask,
  type TtsDownloadManagerOptions,
} from "./downloads.js";
