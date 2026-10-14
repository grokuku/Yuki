/**
 * Façade « notifications » (PWA + Web Push).
 *
 * Point d'entrée unique : le reste du code n'importe PAS les modules internes
 * (`vapid`, `payload`, `sender`, `store`, `service`, `decision`).
 */

export {
  buildNotification,
  createPushService,
  MAX_NOTIFICATION_BODY_CHARS,
  PushService,
  type PushServiceDeps,
  type PushStatusView,
} from "./service.js";
export { isWatching, shouldNotify } from "./decision.js";
export { DEFAULT_RECORD_SIZE, encryptPayload, PushCryptoError, type SubscriberKeys } from "./payload.js";
export {
  createPushSender,
  DEFAULT_SEND_TIMEOUT_MS,
  DEFAULT_TTL_SECONDS,
  audienceOfEndpoint,
  type PushSender,
  type PushSenderOptions,
} from "./sender.js";
export {
  DEVICE_ID_PATTERN,
  isValidDeviceId,
  PUSH_STORE_SCHEMA_VERSION,
  PushSubscriptionStore,
  type PushSubscriptionStoreOptions,
} from "./store.js";
export type {
  NotifyEvent,
  NotifyKind,
  NotifyResult,
  NotificationPayload,
  PresenceView,
  PushSendOutcome,
  PushSubscribeInput,
  PushSubscriptionRecord,
} from "./types.js";
export {
  generateVapidKeys,
  loadOrCreateVapidKeys,
  privateKeyObject,
  VAPID_FILE_SCHEMA_VERSION,
  vapidAuthorization,
  type LoadVapidResult,
  type VapidKeys,
} from "./vapid.js";
