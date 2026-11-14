/**
 * Domaine « DISCUSSIONS EXTERNES » (lot 18).
 *
 * Le socle : un CONTRAT d'adaptateur (`ChatAdapter`), un REGISTRE par plateforme,
 * le mode local décrit par la même interface, les clients MATTERMOST (lot 2) et DISCORD
 * (lot 21) derrière la MÊME abstraction, et le miroir en LECTURE SEULE.
 *
 * ⚠️ Ce que ce module garantit : le mode (`chat.mode`) est LU et CÂBLÉ, l'état est exposé
 * sans secret, et une conversation miroir est identifiée par son préfixe (`mm-…`,
 * `dc-…`) — donc jamais confondue avec une session Pi.
 */

export {
  DISCORD_MESSAGE_CONTENT_MISSING,
  DISCORD_NOT_CONFIGURED_REASON,
  DISCORD_PLATFORM,
  DiscordChatAdapter,
  discordAttachmentPort,
  fitDiscordContent,
  salonDuMessage,
  type DiscordAdapterDeps,
} from "./discord/adapter.js";
export {
  DISCORD_API_BASE,
  DISCORD_GATEWAY_URL,
  DISCORD_INTENTS_STANDARD,
  DISCORD_INTENTS_WITH_CONTENT,
  DISCORD_INTENT_MESSAGE_CONTENT,
  DISCORD_MAX_CONTENT_CHARS,
  DISCORD_MAX_DOWNLOAD_BYTES,
  DISCORD_MAX_PAGE,
  DISCORD_MAX_UPLOAD_BYTES,
  DISCORD_MAX_UPLOAD_CEILING,
  isConversationChannelType,
  isThreadChannelType,
  snowflakeOfTimestamp,
  timestampOfSnowflake,
  type DiscordAttachment,
  type DiscordChannel,
  type DiscordMessage,
  type DiscordMessageEvent,
  type DiscordUser,
} from "./discord/types.js";
export {
  DiscordApiError,
  DiscordClient,
  type DiscordApiErrorCode,
  type DiscordClientOptions,
  type DiscordMessagesPage,
} from "./discord/client.js";
export { DiscordSocket, type DiscordSocketStatus } from "./discord/ws.js";
export {
  ATTACHMENT_CACHE_MAX_BYTES,
  ATTACHMENT_CACHE_MAX_ENTRIES,
  ChatAttachmentCache,
  prepareMessageImages,
  type AttachmentReadOutcome,
  type ChatAttachmentPort,
  type PrepareMessageImagesInput,
  type PrepareMessageImagesResult,
} from "./attachments.js";
export {
  conversationIdOfDiscordChannel,
  discordAttachmentsOf,
  discordMessageToRemoteMessage,
  ingestDiscordMessage,
  applyMessageToMirror,
  type DiscordIngestContext,
} from "./mirror/ingest.js";
export { LOCAL_MODE_REASON, LocalChatAdapter } from "./local-adapter.js";
export {
  ChatAdapterError,
  getAdapter,
  listPlatforms,
  registerAdapter,
  registerAdapterProvider,
  unregisterAdapter,
  type ChatAdapterErrorCode,
} from "./adapter.js";
export {
  MattermostChatAdapter,
  MATTERMOST_NOT_CONFIGURED_REASON,
  MM_DEFAULT_MAX_POST_CHARS,
  fitMattermostContent,
  normalizeReplyMode,
  type MattermostAdapterDeps,
  type MattermostReplyGenerator,
} from "./mattermost/adapter.js";
export {
  MattermostApiError,
  MattermostClient,
  mattermostApiBase,
  mattermostWebSocketUrl,
  type MattermostApiErrorCode,
  type MattermostClientOptions,
  type MattermostPostsPage,
} from "./mattermost/client.js";
export { MattermostSocket, type MattermostSocketStatus } from "./mattermost/ws.js";
export {
  MattermostAttachmentCache,
  mattermostAttachmentPort,
  type MattermostAttachmentCacheOptions,
} from "./mattermost/attachments.js";
export {
  DELETED_NOTICE,
  deletedNoticeOf,
  isDeletedNotice,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_CONVERSATION,
  MAX_MIRRORED_CONVERSATIONS,
  ChatMirrorStore,
  TRUNCATION_SUFFIX,
  effectiveQuoteAuthor,
  effectiveReplyStyle,
  truncateUtf8,
  type ChatMirrorConversationRecord,
  type ChatMirrorWriteOutcome,
} from "./mirror/store.js";
export {
  conversationIdOfChannel,
  ingestPost,
  isOwnMessage,
  postToRemoteMessage,
  type IngestContext,
  type IngestOutcome,
} from "./mirror/ingest.js";
export {
  BACKFILL_DAYS,
  BACKFILL_MAX_MESSAGES,
  ChatSyncService,
  DEFAULT_POLL_INTERVAL_MS,
  type ChatSyncStatus,
} from "./sync/service.js";
export type { ChatSyncChannel, ChatSyncPlatform } from "./sync/platform.js";
export {
  CHAT_JOB_REPORT_INSTRUCTION,
  CHAT_DEFAULT_BOT_NAME,
  CHAT_JUDGE_SYSTEM_PROMPT,
  CHAT_REPLY_SYSTEM_PROMPT,
  CHAT_JUDGE_TIMEOUT_MS,
  CHAT_REPLY_TIMEOUT_MS,
  CHAT_REPLY_TRANSCRIPT_MAX_CHARS,
  CHAT_PARTIAL_HISTORY_NOTICE,
  buildJudgePrompt,
  buildReplyPrompt,
  chatJudgeSystemPrompt,
  chatReplySystemPrompt,
  formatLineTimestamp,
  nomDeBotPourPrompt,
  parseJudgeAnswer,
} from "./reply/prompt.js";
export {
  promptRedacteurDuBot,
  type LoggerPromptRedacteur,
  type OptionsPromptRedacteurBot,
  type PersonnaliteDuBot,
} from "./reply/prompt-bot.js";
export {
  createRemoteReplyGenerator,
  runPlatformOf,
  type RemoteReplyGeneratorOptions,
  type RemoteReplyInput,
  type RemoteReplyOutcome,
  type ReplyRun,
} from "./reply/generate.js";
export {
  CHANNEL_REPORT_MAX_CHARS,
  CHANNEL_REPORT_MAX_FILES,
  createChannelAwareWaker,
  filesFailureText,
  filesOmittedText,
  reportFallbackText,
  type ChannelWakeRequest,
  type ChannelWakerLogger,
  type ChannelWakerOptions,
} from "./reply/channel-waker.js";
export {
  RAPPORT_SYSTEME_AUTHOR_ID,
  RAPPORT_SYSTEME_AUTHOR_NAME,
  RAPPORT_SYSTEME_ENTETE,
  RAPPORT_SYSTEME_FICHIERS_ENTETE,
  RAPPORT_SYSTEME_RAPPEL,
  estRapportSysteme,
  frameRapportSysteme,
  messageRapportSysteme,
  type RapportSystemeInput,
} from "./reply/job-report.js";
export {
  createChannelPostRecorder,
  type ChannelPostFailure,
  type ChannelPostRecorder,
} from "./reply/channel-post-recorder.js";
export { ConversationSendQueue } from "./reply/send-queue.js";
// ENVOIS PROGRAMMÉS (lot 28) : « poste cette image à 16h10 ». Le service porte les
// bornes et la persistance ; le balayeur des déclencheurs l'exécute (`executerDus`).
export {
  DELAI_MIN_MS,
  ENVOIS_PROGRAMMES_FILE,
  HORIZON_MAX_MS,
  MAX_ENVOIS_EN_ATTENTE,
  RATTRAPAGE_MAX_ENVOI_MS,
  EnvoisProgrammesService,
  EnvoisProgrammesStore,
  FUSEAU_ENVOIS,
  QUAND_FORMES_ATTENDUES,
  analyserQuand,
  formaterInstantEnvoi,
  libelleCible,
} from "./envois/index.js";
export type {
  CibleEnvoi,
  EnvoiJournalEvent,
  EnvoiProgramme,
  EnvoisJournalPort,
  EnvoisProgrammesServiceOptions,
  EnvoisProgrammesStoreOptions,
  EtatEnvoi,
  ProgrammationInput,
  ProgrammationOutcome,
} from "./envois/index.js";
export {
  REPLY_MAX_CONCURRENT,
  REPLY_MAX_QUEUE,
  ReplyLimiter,
  type ReplyLimiterLogger,
  type ReplyLimiterOptions,
} from "./reply/limiter.js";
export {
  PROGRESS_IMAGE_TEXT,
  PROGRESS_LONG_TOOL_MS,
  PROGRESS_LONG_TOOL_TEXT,
  PROGRESS_MAX_RESULTS,
  PROGRESS_MESSAGE_TOOL,
  PROGRESS_SUPPRESSED_TEXT,
  ReplyProgress,
  progressErrorText,
  type ProgressLogger,
  type ProgressMessage,
  type ProgressPublisher,
  type AckSource,
  type ReplyProgressOptions,
} from "./reply/progress.js";
export {
  DEFAULT_REPLY_MODE,
  DEFAULT_REPLY_MODE_BY_PLATFORM,
  QUOTE_AUTHOR_LABELS,
  REPLY_MODE_LABELS,
  REPLY_MENTION_MAX_CHARS,
  REPLY_STYLE_LABELS,
  botAliases,
  composeReply,
  decideReply,
  defaultReplyModeFor,
  isBotMentioned,
  mentionOfAuthor,
  rootIdForReply,
  type AuthorMention,
  type ChatReplyJudge,
  type ComposedReply,
  type DecideReplyInput,
  type ReplyDecision,
  type ReplyReason,
} from "./reply/responder.js";
export {
  CANAL_AUTRE_PLATEFORME_RAISON,
  CANAL_NON_SUIVI_RAISON,
  CHANNEL_POST_MAX_FILES,
  FICHIER_AUTRE_CONVERSATION_RAISON,
  FICHIER_AUTRE_PLATEFORME_RAISON,
  FICHIER_INDISPONIBLE_RAISON,
  couperPourPlateforme,
  createChannelPostPort,
  normaliserNomCanal,
  resoudreCanal,
  type ChannelPostPortOptions,
} from "./reply/channel-post.js";
export {
  createReplyMessagePort,
  type ReplyMessagePortOptions,
} from "./reply/message-send.js";
export {
  MIRROR_ID_PREFIX,
  emptyChatMirror,
  isMirrorConversationId,
  mirrorConversationId,
  mirrorPlatformOf,
  mirrorTranscript,
  remoteMessageToTranscript,
  type ChatMirror,
} from "./mirror.js";
export {
  ChatService,
  type ChatRemoteCapability,
  type ChatServiceOptions,
  type ChatStatusView,
} from "./service.js";
export {
  AuthorDirectory,
  AUTHOR_NAME_BATCH_SIZE,
  auteurAffichable,
  formeCourteAuteur,
} from "./mirror/names.js";
export {
  CHAT_MODES,
  CHAT_QUOTE_AUTHORS,
  CHAT_REPLY_MODES,
  CHAT_REPLY_STYLES,
  DEFAULT_QUOTE_AUTHOR,
  DEFAULT_REPLY_STYLE,
  REMOTE_PLATFORMS,
  type ChatAdapter,
  type ChatAdapterStatus,
  type ChatApprovalDecision,
  type ChatApprovalOption,
  type ChatApprovalRequest,
  type ChatOutboundMessage,
  type ChatRunOrigin,
  type ChatWakeRequest,
  type ChatFetchOptions,
  type ChatFetchPage,
  type ChatMode,
  type ChatQuoteAuthor,
  type ChatReplyMode,
  type ChatReplySettings,
  type ChatReplyGenerator,
  type ChatReplySettingsPatch,
  type ChatReplyStyle,
  type ChatStateCode,
  type RemoteAttachment,
  type RemoteAuthor,
  type RemoteConversation,
  type RemoteMessage,
  type RemotePlatform,
} from "./types.js";
