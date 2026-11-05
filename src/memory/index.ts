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
  type MemoryAdminEntry,
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
  type MemorySetAsideResult,
  type ReactionRegularityInput,
  type SessionMemoryPassInput,
  type SessionMemoryPassReason,
  type SessionMemoryPassResult,
  type SessionSetAsideInput,
  type SetAsideMessage,
  type TurnEndInput,
} from "./types.js";

export {
  MEMORY_ARCHIVE_DIR_NAME,
  MEMORY_FILE_HEADER,
  MEMORY_SET_ASIDE_FILE,
  MEMORY_TEXT_MAX_CHARS,
  MEMORY_WHY_MAX_CHARS,
  MemoryStore,
  clampMemoryText,
  clampMemoryWhy,
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
  DURABILITY_INSTRUCTION,
  HERITAGE_EXTRACTION_INSTRUCTION,
  parseMemoryOps,
} from "./extract.js";

export {
  EXCLUDED_FRAME_TAGS,
  EXCLUDED_PROMPT_PREFIXES,
  isExcludedMemoryText,
  sanitizeMemoryText,
  stripExcludedMemoryBlocks,
} from "./filter.js";

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
  REACTIONS_SOURCE,
  SET_ASIDE_DEFAULT_BOUNDS,
  SET_ASIDE_SOURCE,
  formatMemoryBlock,
  type MemoryServiceOptions,
  type SetAsideBounds,
} from "./service.js";

export {
  CONSOLIDATE_MESSAGE_MAX_CHARS,
  chunkMessages,
  sanitizeConsolidationMessages,
  type ChunkOptions,
  type ChunkedMessages,
  type RawConsolidateMessage,
} from "./consolidate.js";

export {
  NEAR_DUPLICATE_CONTAINMENT,
  NEAR_DUPLICATE_MIN_TOKENS,
  findNearDuplicate,
  isNearDuplicate,
  memoryTokens,
  type DedupEntry,
  type NearDuplicateMatch,
} from "./dedup.js";

export {
  ARCHIVE_MESSAGE_MAX_CHARS,
  ARCHIVE_SEARCH_DEFAULT_LIMIT,
  ARCHIVE_SEARCH_MAX_LIMIT,
  CONVERSATION_ARCHIVE_DATA_REMINDER,
  CONVERSATION_ARCHIVE_DIR_NAME,
  CONVERSATION_ARCHIVE_INDEX_FILE,
  CONVERSATION_ARCHIVE_LABEL,
  CONVERSATION_ARCHIVE_README_FILE,
  CONVERSATION_ARCHIVE_TAG,
  buildConversationArchiveReadme,
  conversationFileName,
  escapeArchiveText,
  frameArchiveSearch,
  type ArchiveSearchHit,
  type ArchiveWriteResult,
  type ArchivedConversation,
  type ArchivedConversationDraft,
  type ArchivedMessage,
  type ArchivedRole,
  type ConversationArchiveInfo,
  type ConversationArchivePort,
} from "./conversation-archive.js";

export {
  ConversationArchiveStore,
  parseArchivedConversation,
  type ConversationArchiveStoreOptions,
} from "./conversation-archive-store.js";

export { buildMatchQuery, fingerprint, foldText } from "./normalize.js";

export {
  memoryWriteModelReference,
  type MemoryWriteModelRoles,
} from "./write-model.js";

export {
  CONSOLIDATION_PROTOCOLE_VERSION,
  MARGE_SORTIE_TOKENS,
  PLAFOND_ENTREES,
  POURCENTAGE_SUPPRESSIONS_MAX,
  PROMPT_FIXE_TOKENS,
  TOKENS_PAR_CARACTERE,
  WEEKLY_OPS,
  WEEKLY_OPS_AVEC_RAISON,
  appliquerRegleContradiction,
  caracteresEntree,
  choisirGagnant,
  construirePromptHebdo,
  dateComparable,
  decouperEnLots,
  entreesExaminees,
  estimerTokens,
  mesurerConsolidation,
  parseReponseHebdo,
  suppressionsAutorisees,
  type MesureConsolidation,
  type ParseHebdoOptions,
  type ParseHebdoResult,
  type WeeklyOpName,
  type WeeklyOperation,
} from "./weekly.js";

export {
  NOM_VERSION_REGEX,
  RETENTION_DEFAUT,
  VERSION_MEMORY_FILE,
  VERSION_OPERATIONS_FILE,
  VERSION_RAPPORT_FILE,
  ConsolidationArchiveStore,
  nomVersion,
  nomVersionValide,
  type ArchiveLogger,
  type ConsolidationArchiveOptions,
  type ConsolidationVersion,
  type SauvegardeInput,
} from "./consolidation-archive.js";

export {
  BUDGET_TOKENS_DEFAUT,
  CRON_HEBDO_DEFAUT,
  FUSEAU_HEBDO_DEFAUT,
  RATTRAPAGE_HEBDO_MAX_MS,
  VERROU_ORPHELIN_MS,
  ConsolidationHebdo,
  contexteModeleDepuisFichier,
  type CompteursOperations,
  type ConsolidationHebdoOptions,
  type ConsolidationHebdoSettings,
  type EtatConsolidationVue,
  type RapportConsolidation,
} from "./consolidation-hebdo.js";
