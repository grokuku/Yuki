/**
 * Domaine « mémoire durable » de Yuki (Lot 12) — surface publique.
 *
 * Types PURS + implémentations locales (store JSONL, index FTS5, service).
 * Aucun import SDK/typebox : l'injection dans la conversation est confinée à
 * `src/pi/sdk/**`.
 */

export {
  MEMORY_CATEGORIES,
  type BeforeCompactInput,
  type ConsolidateMessage,
  type MemoryAdminInfo,
  type MemoryAdminPort,
  type MemoryBounds,
  type MemoryCategory,
  type MemoryChange,
  type MemoryEntry,
  type MemoryEvent,
  type MemoryExtractor,
  type MemoryLogger,
  type MemoryOp,
  type MemoryPort,
  type MemoryRecallResult,
  type MemoryResetResult,
  type TurnEndInput,
} from "./types.js";

export {
  MEMORY_ARCHIVE_DIR_NAME,
  MEMORY_FILE_HEADER,
  MEMORY_TEXT_MAX_CHARS,
  MemoryStore,
  clampMemoryText,
  normalizeCategory,
  parseEvent,
  type AddResult,
  type MemoryDraft,
  type MemoryStoreOptions,
  type MemoryUpdatePatch,
} from "./store.js";

export { MemoryIndex, type MemoryIndexOptions } from "./index-db.js";

export {
  buildConsolidationPrompt,
  buildTurnExtractionPrompt,
  HERITAGE_EXTRACTION_INSTRUCTION,
  parseMemoryOps,
} from "./extract.js";

export {
  HERITAGE_DATA_REMINDER,
  HERITAGE_DEFAULT_PERIODE,
  HERITAGE_DEFAULT_PROVENANCE,
  HERITAGE_DELETED_DIR,
  HERITAGE_DIR_NAME,
  HERITAGE_ENTRIES_DIR,
  HERITAGE_JOURNAL_FILE,
  HERITAGE_LABEL,
  HERITAGE_MANIFEST_FILE,
  HERITAGE_README_FILE,
  HERITAGE_TAG,
  HERITAGE_TEXT_MAX_CHARS,
  HERITAGE_TITRE_MAX_CHARS,
  HERITAGE_WRITE_TEXT_MAX_CHARS,
  buildHeritageReadme,
  clampHeritageWriteText,
  defaultManifest,
  escapeHeritageText,
  frameHeritageEntry,
  frameHeritageInfo,
  heritageSlug,
  idFromFilename,
  looksLikeHeritage,
  normalizeHeritageCategorie,
  normalizeHeritageTitre,
  parseHeritageEntry,
  parseHeritageManifest,
  serializeHeritageEntry,
  type HeritageAdminDetail,
  type HeritageAdminEntry,
  type HeritageAdminInfo,
  type HeritageAdminPort,
  type HeritageDefaults,
  type HeritageDeleteResult,
  type HeritageEntry,
  type HeritageEntryContent,
  type HeritageInfo,
  type HeritageManifest,
  type HeritagePort,
  type HeritageProvenance,
  type HeritageTextClamp,
  type HeritageWriteInput,
  type HeritageWriteResult,
} from "./heritage.js";

export {
  HERITAGE_ENTRY_EXTENSIONS,
  HeritageStore,
  type HeritageStoreOptions,
} from "./heritage-store.js";

export {
  HeritageAdminError,
  HeritageAdminService,
  type HeritageAdminServiceOptions,
} from "./heritage-admin.js";

export {
  MEMORY_BLOCK_HEADER,
  MemoryService,
  formatMemoryBlock,
  type MemoryServiceOptions,
} from "./service.js";

export { buildMatchQuery, fingerprint, foldText } from "./normalize.js";
