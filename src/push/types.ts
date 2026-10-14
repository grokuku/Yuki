/**
 * Domaine « notifications » (PWA + Web Push).
 *
 * Aucun import SDK : types purs, sérialisables, et la vue de présence d'un
 * client (pour la logique de SUPPRESSION anti-spam, `decision.ts`).
 *
 * ⚠️ La clé PRIVÉE VAPID ne doit JAMAIS traverser cette surface publique :
 * seul `publicKey` est exposé (à l'API comme au client navigateur).
 */

import type { PresenceView } from "../gateway/ws/transport.js";

export type { PresenceView };

/** Nature d'un événement susceptible de déclencher une notification. */
export type NotifyKind = "approval" | "job_report" | "run_finished";

/**
 * Événement soumis à la décision « faut-il notifier ? ». `sessionId` = la
 * conversation CONCERNÉE (celle qui voit le résultat), pas la conversation
 * focalisée par l'utilisateur.
 */
export interface NotifyEvent {
  kind: NotifyKind;
  sessionId?: string | null;
  /** Détail affiché (commande à valider, intitulé de tâche…), jamais un secret. */
  detail?: string;
}

/** Contenu d'une notification, tel qu'envoyé (chiffré) au service de push. */
export interface NotificationPayload {
  title: string;
  body: string;
  /** Étiquette de regroupement : deux notifications de même `tag` se remplacent. */
  tag: string;
  data: {
    kind: NotifyKind;
    sessionId?: string;
    /** URL same-origin ouverte au clic. */
    url: string;
  };
}

/** Abonnement d'un appareil (clés de chiffrement du service de push). */
export interface PushSubscriptionRecord {
  /** Identifiant d'appareil STABLE (généré et conservé côté navigateur). */
  deviceId: string;
  /** URL du service de push (fournie par le navigateur). */
  endpoint: string;
  /** Clé publique P-256 de l'abonné (base64url, point non compressé 65 octets). */
  p256dh: string;
  /** Secret d'authentification (base64url, 16 octets). */
  auth: string;
  createdAt: string;
  updatedAt: string;
  /** Libellé facultatif (User-Agent, nom d'appareil). Jamais un secret. */
  label?: string;
}

/** Entrée d'abonnement reçue du navigateur (avant horodatage/stockage). */
export interface PushSubscribeInput {
  deviceId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label?: string;
}

/**
 * Issue d'une tentative d'envoi vers le service de push.
 *  - `sent`  : le service a accepté (2xx) ;
 *  - `gone`  : abonnement MORT (404/410) ⇒ à RETIRER, jamais à réessayer ;
 *  - `error` : échec réseau ou statut inattendu ⇒ on conserve l'abonnement.
 */
export type PushSendOutcome =
  | { status: "sent"; statusCode: number }
  | { status: "gone"; statusCode: number }
  | { status: "error"; statusCode?: number; error: string };

/** Bilan d'un `notify()` (journalisé, jamais un secret). */
export interface NotifyResult {
  /** `true` si une notification a été réellement transmise à au moins un service. */
  sent: boolean;
  sentCount: number;
  removedCount: number;
  failedCount: number;
  /** Motif d'abstention (`disabled`, `no_subscriptions`, `watching`). */
  skipped?: "disabled" | "no_subscriptions" | "watching";
}
