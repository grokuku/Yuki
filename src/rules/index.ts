/**
 * Domaine « règles strictes » de Yuki — surface publique.
 *
 * Types PURS + implémentation locale (store fichier + historique + journal,
 * socle partagé `TextDocumentStore`). Aucun import SDK/typebox : l'injection
 * dans la conversation est confinée à `src/pi/sdk/**`.
 */

export {
  RULES_BLOCK_HEADER,
  RULES_FILE_NAME,
  RULES_HISTORY_DIR_NAME,
  RULES_HISTORY_MAX,
  RULES_JOURNAL_FILE_NAME,
  RULES_MAX_CHARS,
  RULES_TAG,
  clampRulesText,
  frameRules,
  type ClampedRules,
} from "./rules.js";

export { RulesStore, type RulesStoreOptions } from "./store.js";

export type {
  RulesAdminPort,
  RulesDocument,
  RulesHistoryEntry,
  RulesLogger,
  RulesPort,
  RulesSource,
  RulesWriteResult,
} from "./types.js";

export {
  candidatsRegles,
  lireDocumentRegles,
  portReglesBot,
  portReglesDuBot,
  reglesEffectives,
  type CandidatFichierRegles,
  type LoggerReglesBot,
  type OptionsReglesBot,
  type PorteeFichierRegles,
  type PortReglesBot,
  type ProvenanceRegles,
  type ReglesBot,
} from "./regles-bot.js";

export {
  ReglesAdminEffectives,
  type EmplacementRegles,
  type OptionsReglesAdmin,
} from "./admin.js";
