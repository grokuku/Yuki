/**
 * Domaine « libraire » de Pi-Web (recherche documentaire + web) — surface
 * publique.
 *
 * ⚠️ AUCUN import SDK/typebox : l'injection dans la conversation est confinée à
 * `src/pi/sdk/**`. Le libraire est un service EXTERNE joint en HTTP ; Yuki ne va
 * JAMAIS chercher une page web elle-même (tout passe par le libraire).
 */

export {
  LIBRARIAN_ERROR_MESSAGES,
  LibrarianError,
  isLibrarianError,
  librarianErrorFromStatus,
  messageOfLibrarianError,
  type LibrarianErrorCode,
} from "./errors.js";

export type {
  LibrarianArchiveContent,
  LibrarianArchiveInput,
  LibrarianArchivePayload,
  LibrarianArchivePort,
  LibrarianArchiveReceipt,
  LibrarianConfig,
  LibrarianConfigProvider,
  LibrarianDoc,
  LibrarianLibrary,
  LibrarianLibraryEntry,
  LibrarianLogger,
  LibrarianPort,
  LibrarianProbePort,
  LibrarianScheduleOutcome,
  LibrarianScreenshot,
  LibrarianScreenshotOptions,
  LibrarianScreenshotPort,
  LibrarianSearchOutcome,
  LibrarianSearchResult,
  LibrarianShotImage,
  LibrarianStatus,
  LibrarianSynthesizer,
} from "./types.js";

export {
  DEFAULT_LIBRARIAN_SCREENSHOT_TIMEOUT_MS,
  DEFAULT_LIBRARIAN_SEARCH_TIMEOUT_MS,
  DEFAULT_LIBRARIAN_TIMEOUT_MS,
  LibrarianClient,
  createLibrarianClient,
  type LibrarianClientOptions,
} from "./client.js";

export {
  parseDoc,
  parseLibrary,
  parseScreenshot,
  parseSearchOutcome,
  parseStatus,
} from "./parse.js";

export {
  MAX_CAPTURE_URL_CHARS,
  MAX_PATH_COMPONENT_CHARS,
  validateCaptureUrl,
  validatePathComponent,
  type CaptureUrlValidation,
  type PathComponentValidation,
} from "./validation.js";

export {
  LIBRARIAN_DATA_REMINDER,
  LIBRARIAN_TAG,
  MAX_DOC_FIELD_CHARS,
  MAX_DOC_RAW_CHARS,
  MAX_LIBRARY_ENTRIES,
  MAX_LOCAL_CONTENT_CHARS,
  MAX_SEARCH_RESULTS,
  MAX_SNIPPET_CHARS,
  frameLibrarianDoc,
  frameLibrarianLibrary,
  frameLibrarianScreenshot,
  frameLibrarianSearch,
  type LibrarianScreenshotFrame,
} from "./output.js";

export {
  MAX_LIBRARIAN_SHOT_BYTES,
  LibrarianShotsStore,
  librarianShotHost,
  type LibrarianShotInput,
  type LibrarianShotRecord,
  type LibrarianShotView,
  type LibrarianShotsPort,
  type LibrarianShotsStoreOptions,
} from "./shots.js";

export {
  LIBRARIAN_SYNTHESIZER_SYSTEM_PROMPT,
  MAX_MATERIAL_CHARS,
  buildSynthesisPrompt,
  parseSynthesis,
} from "./prompt.js";

export {
  DEFAULT_LIBRARIAN_MAX_CONCURRENT,
  DEFAULT_LIBRARIAN_MAX_QUEUE,
  ORIGIN_JOB_REPORT,
  ORIGIN_LIBRARIAN_ARCHIVE,
  LibrarianArchiveService,
  createLibrarianArchiveService,
  type LibrarianArchiveServiceOptions,
} from "./archive.js";
