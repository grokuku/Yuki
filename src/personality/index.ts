/**
 * Domaine « personnalité » de Yuki — surface publique.
 *
 * Types PURS + implémentation locale (store fichier + historique + journal).
 * Aucun import SDK/typebox : la composition du prompt est confinée à
 * `src/llm/prompt-systeme.ts` (la personnalité n'est plus injectée par une
 * extension SDK).
 */

export {
  PERSONALITY_BLOCK_HEADER,
  PERSONALITY_FILE_NAME,
  PERSONALITY_HISTORY_DIR_NAME,
  PERSONALITY_HISTORY_MAX,
  PERSONALITY_JOURNAL_FILE_NAME,
  PERSONALITY_MAX_CHARS,
  PERSONALITY_TAG,
  clampPersonalityText,
  framePersonality,
  personnaliteEffective,
  type ClampedPersonality,
  type FichierPersonnalite,
  type OriginePersonnaliteEffective,
  type PersonnaliteEffective,
  type PorteeFichierPersonnalite,
  type ProvenancePersonnalite,
  type SourcesPersonnalite,
} from "./personality.js";

export { PersonalityStore, type PersonalityStoreOptions } from "./store.js";

export type {
  PersonalityAdminPort,
  PersonalityDocument,
  PersonalityHistoryEntry,
  PersonalityJournalEntry,
  PersonalityLogger,
  PersonalityPort,
  PersonalitySource,
  PersonalityWriteResult,
} from "./types.js";
