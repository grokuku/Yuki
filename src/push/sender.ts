/**
 * Envoi serveur → SERVICE DE PUSH (appel SORTANT HTTP).
 *
 * ⚠️ C'est le SEUL endroit qui sort du réseau local pour une notification.
 * Si l'environnement n'a pas d'accès sortant, l'appel échoue en réseau : on le
 * journalise honnêtement (`push.send.failed`) et on CONSERVE l'abonnement (un
 * échec réseau n'est pas un abonnement mort). Seule une réponse 404/410 du
 * service de push prouve que l'abonnement est MORT ⇒ on le retire.
 *
 * Aucune dépendance : `fetch` global de Node + `node:crypto` (VAPID/aes128gcm).
 */

import type { Logger } from "../observability/logger.js";
import { encryptPayload, PushCryptoError } from "./payload.js";
import type {
  NotificationPayload,
  PushSendOutcome,
  PushSubscriptionRecord,
} from "./types.js";
import { vapidAuthorization, type VapidKeys } from "./vapid.js";

/** Durée de vie d'une notification non délivrée (secondes) — 4 semaines. */
export const DEFAULT_TTL_SECONDS = 2_419_200;
/** Délai maximal d'un POST vers le service de push. */
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;

export interface PushSenderOptions {
  keys: VapidKeys;
  /** Sujet VAPID (`mailto:` ou URL) — relu à chaque envoi (réglage à chaud). */
  subject: () => string;
  logger: Logger;
  /** Injectable pour les tests. Défaut : `fetch` global. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** Audience VAPID : schéma + hôte du endpoint (sans chemin). */
export function audienceOfEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  return `${url.protocol}//${url.host}`;
}

export interface PushSender {
  send(subscription: PushSubscriptionRecord, payload: NotificationPayload): Promise<PushSendOutcome>;
}

/** Fabrique l'envoyeur (construit une seule fois, réutilisé pour chaque envoi). */
export function createPushSender(options: PushSenderOptions): PushSender {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const { keys, logger } = options;

  return {
    async send(subscription, payload): Promise<PushSendOutcome> {
      let authorisation: string;
      let body: Buffer;
      try {
        authorisation = vapidAuthorization({
          keys,
          audience: audienceOfEndpoint(subscription.endpoint),
          subject: options.subject(),
          nowMs: now(),
        });
        const encrypted = encryptPayload(
          { p256dh: subscription.p256dh, auth: subscription.auth },
          Buffer.from(JSON.stringify(payload), "utf8"),
        );
        body = encrypted.body;
      } catch (error) {
        // Clés d'abonnement inexploitables : l'abonnement est CORROMPU, pas mort
        // (un ré-enregistrement côté navigateur le réparera). On conserve.
        if (error instanceof PushCryptoError) {
          logger.warn("push.send.encrypt_failed", { error: error.message });
          return { status: "error", error: error.message };
        }
        throw error;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(subscription.endpoint, {
          method: "POST",
          headers: {
            authorization: authorisation,
            "content-encoding": "aes128gcm",
            "content-type": "application/octet-stream",
            ttl: String(DEFAULT_TTL_SECONDS),
          },
          body,
          signal: controller.signal,
        });
        if (response.status === 404 || response.status === 410) {
          return { status: "gone", statusCode: response.status };
        }
        if (response.ok) {
          return { status: "sent", statusCode: response.status };
        }
        return {
          status: "error",
          statusCode: response.status,
          error: `HTTP ${response.status}`,
        };
      } catch (error) {
        return {
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
