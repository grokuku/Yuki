/**
 * Domaine « personnalité » de Yuki — surface publique.
 *
 * Types PURS + implémentation locale (store fichier + historique + journal).
 * Aucun import SDK/typebox : l'injection dans la conversation est confinée à
 * `src/pi/sdk/**`.
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
  type ClampedPersonality,
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
