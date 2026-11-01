/**
 * Domaine « DISCUSSIONS EXTERNES » (lot 18).
 *
 * Le socle : un CONTRAT d'adaptateur (`ChatAdapter`), un REGISTRE par plateforme,
 * le mode local décrit par la même interface, un stub honnête pour Discord et le
 * miroir en LECTURE SEULE (vide au lot 1).
 *
 * ⚠️ Aucun client Mattermost, aucune synchronisation ici : c'est le lot 2. Ce
 * que ce module garantit déjà : le mode (`chat.mode`) est LU et CÂBLÉ, l'état est
 * exposé sans secret, et une conversation miroir est identifiée par son préfixe
 * (`mm-…`, `dc-…`) — donc jamais confondue avec une session Pi.
 */

export {
  DISCORD_NOT_CONFIGURED_REASON,
} from "./discord/adapter.js";
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
  DELETED_NOTICE,
  MAX_MESSAGE_BYTES,
  MAX_MESSAGES_PER_CONVERSATION,
  MAX_MIRRORED_CONVERSATIONS,
  ChatMirrorStore,
  TRUNCATION_SUFFIX,
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
  CHAT_JUDGE_SYSTEM_PROMPT,
  CHAT_REPLY_SYSTEM_PROMPT,
  CHAT_JUDGE_TIMEOUT_MS,
  CHAT_REPLY_TIMEOUT_MS,
  CHAT_REPLY_TRANSCRIPT_MAX_CHARS,
  buildJudgePrompt,
  buildReplyPrompt,
  parseJudgeAnswer,
} from "./reply/prompt.js";
export {
  DEFAULT_REPLY_MODE,
  REPLY_MODE_LABELS,
  botAliases,
  decideReply,
  isBotMentioned,
  type ChatReplyJudge,
  type DecideReplyInput,
  type ReplyDecision,
  type ReplyReason,
} from "./reply/responder.js";
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
  CHAT_MODES,
  CHAT_REPLY_MODES,
  REMOTE_PLATFORMS,
  type ChatAdapter,
  type ChatAdapterStatus,
  type ChatApprovalDecision,
  type ChatApprovalOption,
  type ChatApprovalRequest,
  type ChatOutboundMessage,
  type ChatRunOrigin,
  type ChatFetchOptions,
  type ChatFetchPage,
  type ChatMode,
  type ChatReplyMode,
  type ChatStateCode,
  type RemoteAttachment,
  type RemoteAuthor,
  type RemoteConversation,
  type RemoteMessage,
  type RemotePlatform,
} from "./types.js";
