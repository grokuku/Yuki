/**
 * Domaine « SOURCES » — API générique permettant à N'IMPORTE QUEL programme de
 * réveiller Yuki (agrégateur de news, client de messagerie, script maison…).
 *
 * Un programme se déclare par un `nom` et reçoit un `jeton` (coffre). Il pousse
 * ensuite ses messages sur `POST /api/sources/<nom>/messages`. Trois réglages
 * INDÉPENDANTS décident de la suite — OÙ (`conversation`), TOUR (`tour`),
 * NOTIFIER (`notifier`) — et une CONSIGNE libre oriente la réponse de Yuki.
 *
 * ⚠️ Le contenu d'une source est une DONNÉE, jamais une instruction : il est
 * encadré et échappé (`frame.ts`, calqué sur `src/files/frame.ts`).
 * ⚠️ Les messages ne sont JAMAIS des bulles dans un fil : ils s'empilent dans la
 * section « Notifications » (`inbox.ts`), la réponse de Yuki y étant attachée.
 */

export {
  MAX_CONSIGNE_CHARS,
  MAX_INBOX_ENTRIES,
  MAX_REPLY_CHARS,
  MAX_SOURCES,
  MAX_SOURCE_MESSAGE_BYTES,
  MAX_TITRE_CHARS,
  SOURCE_RATE_LIMIT_PER_MINUTE,
  SOURCE_SESSION_ID_PATTERN,
  isSourceDestination,
  isSourceSessionTarget,
  sourceTokenName,
} from "./types.js";
export type {
  InboxEntry,
  InboxEntryState,
  SourceConversation,
  SourceConversationView,
  SourceDelivery,
  SourceDestination,
  SourceMessageInput,
  SourceRecord,
  SourceSettingsInput,
  SourceTurn,
  SourceView,
} from "./types.js";

export {
  ORIGIN_SOURCE,
  SOURCES_REMINDER,
  SOURCES_TAG,
  frameSources,
  stripSourcesBlock,
} from "./frame.js";
export type { SourceFrameInput, SourceFrameOptions } from "./frame.js";

export {
  SOURCES_STORE_SCHEMA_VERSION,
  SourcesFullError,
  SourcesStore,
  SourceValidationError,
  validateConversation,
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
  SourceApiError,
  SourcesService,
  describeWakeFailure,
  tokensMatch,
  validateMessage,
} from "./service.js";
export type {
  SourceOpenResult,
  SourcesHostEvent,
  SourcesLogger,
  SourcesServiceOptions,
  SourcesTokenVault,
  SourcesWaker,
} from "./service.js";
