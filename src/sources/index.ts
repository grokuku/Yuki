/**
 * Domaine « SOURCES » — API générique permettant à N'IMPORTE QUEL programme de
 * réveiller Yuki (agrégateur de news, client de messagerie, script maison…).
 *
 * Un programme se déclare par un `nom` et reçoit un `jeton` (coffre). Il pousse
 * ensuite ses messages sur `POST /api/sources/<nom>/messages`.
 *
 * ⚠️ Modèle v2 : la VISIBILITÉ décide de tout (`visibilite`) —
 *  - `silencieux` (défaut) : le contenu reçu n'apparaît nulle part ; si Yuki n'a
 *    rien à dire elle répond exactement `RIEN` (journal `silence`), sinon son
 *    RÉSULTAT est publié dans l'unique fil « Déclencheurs » (journal `publie`) ;
 *  - `visible` : comportement du lot 17 (OÙ `destination`, TOUR `tour`,
 *    NOTIFIER `notifier` + boîte « Notifications »).
 *
 * ⚠️ Le contenu d'une source est une DONNÉE, jamais une instruction : il est
 * encadré et échappé (`frame.ts`, calqué sur `src/files/frame.ts`).
 */

export {
  DECLENCHEURS_SESSION_TITLE,
  DEFAULT_FUSEAU,
  DEFAULT_MAX_TOURS_PAR_JOUR,
  DEFAULT_PLAFOND_MS,
  DEFAULT_SOURCE_CHEVAUCHEMENT,
  DEFAULT_SOURCE_DECLENCHEUR,
  DEFAULT_SOURCE_RATTRAPAGE,
  DEFAULT_SOURCE_VISIBILITE,
  MAX_CONSIGNE_CHARS,
  MAX_ETAPES_CHAINE,
  MAX_FICHIERS_ETAPE,
  MAX_INBOX_ENTRIES,
  MAX_INSTRUCTION_TACHE_CHARS,
  MAX_OCCURRENCES,
  MAX_TACHES_PONCTUELLES,
  MAX_TEXTE_ETAPE_CHARS,
  MIN_ETAPES_CHAINE,
  MIN_OCCURRENCES,
  isSourceDeclencheurPonctuel,
  MAX_PLAFOND_MS,
  MAX_REPLY_CHARS,
  MAX_SOURCES,
  MAX_SOURCE_MESSAGE_BYTES,
  MAX_TITRE_CHARS,
  MAX_TOURS_PAR_JOUR_LIMITE,
  MIN_PLAFOND_MS,
  RATTRAPAGE_MAX_MS,
  SILENCE_REPLY,
  SOURCE_RATE_LIMIT_PER_MINUTE,
  SOURCE_SESSION_ID_PATTERN,
  isSourceChevauchement,
  isSourceDeclencheur,
  isSourceDeclencheurPlanning,
  isSourceDeclencheurWebhook,
  isSourceDestination,
  isSourceRattrapage,
  isSourceSessionTarget,
  isSourceVisibilite,
  sourceTokenName,
} from "./types.js";
export type {
  InboxEntry,
  InboxEntryState,
  SourceChevauchement,
  SourceConversation,
  SourceConversationView,
  SourceDeclencheur,
  SourceDeclencheurPlanning,
  SourceDeclencheurPonctuel,
  SourceDeclencheurType,
  SourceChaine,
  SourceChaineInput,
  SourceEtapeInput,
  ResultatEtape,
  SourceSerieEchecs,
  SourceDeclencheurWebhook,
  SourceDelivery,
  SourceDestination,
  SourceEtat,
  SourceMessageInput,
  SourceRattrapage,
  SourceRecord,
  SourceSettingsInput,
  SourceTurn,
  SourceView,
  SourceVisibilite,
} from "./types.js";

export {
  CRON_FIELD_COUNT,
  CRON_MAX_LOOKAHEAD_YEARS,
  CRON_SYNTAX_HELP,
  CronError,
  apercuCron,
  correspond,
  instantsDeLHeureLocale,
  isCronExpression,
  jourCorrespond,
  jourLocal,
  parseCron,
  partiesLocales,
  prochainPassage,
  validateFuseau,
} from "./cron.js";
export type {
  ApercuResultat,
  CronErrorCode,
  CronExpression,
  CronField,
  PartiesLocales,
  ProchainPassageOptions,
} from "./cron.js";

export {
  BALAYAGE_INTERVAL_MS,
  DeclencheurBalayeur,
  GRACE_APRES_ABORT_MS,
  RAISON_TACHE_EN_COURS,
  raisonFinDate,
  raisonFinOccurrences,
  raisonGardeFouQuotidien,
} from "./scheduler.js";
export type {
  BalayeurLogger,
  BalayeurStore,
  DeclencheurBalayeurOptions,
  DeclencheurRunner,
  EnvoisProgrammesRunner,
  PasseHebdoRunner,
} from "./scheduler.js";

export {
  ORIGIN_DECLENCHEUR,
  ORIGIN_SOURCE,
  MARQUEUR_DESACTIVATION,
  SOURCES_DESACTIVATION_REMINDER,
  SOURCES_REMINDER,
  SOURCES_SILENCE_REMINDER,
  SOURCES_TAG,
  frameSources,
  separerMarqueurDesactivation,
  stripSourcesBlock,
} from "./frame.js";
export type { SourceFrameInput, SourceFrameOptions } from "./frame.js";

export {
  SOURCES_STORE_BACKUP_SUFFIX,
  SOURCES_STORE_LEGACY_VERSION,
  SOURCES_STORE_SCHEMA_VERSION,
  ChainesFullError,
  SourcesFullError,
  SourcesStore,
  SourceValidationError,
  TachesPonctuellesFullError,
  slugifierNomTache,
  validateConversation,
  validateDeclencheur,
  validateSourceName,
} from "./store.js";
export type { SourcesStoreLogger, SourcesStoreOptions } from "./store.js";

export {
  InboxFullError,
  SOURCES_INBOX_SCHEMA_VERSION,
  SourcesInbox,
  dedupeKey,
} from "./inbox.js";
export type { InboxAddInput, InboxLogger, SourcesInboxOptions } from "./inbox.js";

export {
  DECLENCHEURS_JOURNAL_FILE,
  DECLENCHEUR_EVENTS,
  DeclencheurJournal,
  JOURNAL_RETENTION_DAYS,
  MAX_JOURNAL_CONTENT_CHARS,
  boundJournalContent,
  isDeclencheurEvent,
} from "./journal.js";
export type {
  DeclencheurEvent,
  DeclencheurJournalFilter,
  DeclencheurJournalLogger,
  DeclencheurJournalOptions,
  DeclencheurJournalRecord,
} from "./journal.js";

export {
  ORIGINE_HORLOGE,
  RAISON_DESACTIVATION,
  SourceApiError,
  SourcesService,
  describeWakeFailure,
  isSilenceReply,
  resoudrePlafond,
  tokensMatch,
  validateMessage,
} from "./service.js";
export { tacheDeDeclencheur } from "./service.js";
export type { PlanificationTacheOutcome } from "./service.js";
export {
  MAX_LIBELLE_TACHE_CHARS,
  RAISON_INSTRUCTION_TROP_LONGUE,
  RAISON_INSTRUCTION_VIDE,
  RAISON_TACHE_DELAI_MIN,
  RAISON_TACHE_HORIZON,
  RAISON_TACHE_PASSEE,
  libelleDeTache,
  tachePonctuelle,
  validerPlanificationTache,
} from "./taches.js";
export type {
  PlanificationTacheInput,
  PlanificationValidee,
  ValidationPlanification,
} from "./taches.js";
export type {
  DeclenchementFin,
  DeclenchementOptions,
  DeclenchementResult,
  DeclencheurJobsPort,
  DeclencheurPublicationPort,
  FichierPublie,
  SourceOpenResult,
  SourcesHostEvent,
  SourcesLogger,
  SourcesServiceOptions,
  SourcesTokenVault,
  SourcesWaker,
} from "./service.js";
