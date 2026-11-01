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
  type ChatAdapterErrorCode,
} from "./adapter.js";
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
