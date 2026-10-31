/**
 * Service de notifications : DÉCLENCHEURS + décision + envoi + nettoyage.
 *
 * Câblage (façade) :
 *   - `notify(event)` : décide (logique PURE `decision.ts`) puis envoie à chaque
 *     appareil abonné et retire les abonnements MORTS (404/410).
 *   - `bindTriggers({host, approvals})` : abonne le service aux événements RÉELS
 *     — fin de tâche de fond (`job_report`), validation en attente
 *     (`approval.requested`), réponse prête (`run_finished`).
 *
 * ⚠️ Les déclencheurs sont branchés ICI, jamais dans la façade Pi : le service
 * reste une dépendance OPTIONNELLE, et son absence ne change rien au reste.
 */

import type { ApprovalViewEvent, ApprovalGatewayPort } from "../agents/execution.js";
import type { Logger } from "../observability/logger.js";
import type { PiEvent, PiHost } from "../pi/index.js";
import { shouldNotify } from "./decision.js";
import type { PushSubscriptionStore } from "./store.js";
import type {
  NotifyEvent,
  NotifyResult,
  NotificationPayload,
  PresenceView,
  PushSendOutcome,
  PushSubscriptionRecord,
} from "./types.js";

/** Longueur maximale du corps d'une notification (lisibilité). */
export const MAX_NOTIFICATION_BODY_CHARS = 160;

export interface PushServiceDeps {
  store: PushSubscriptionStore;
  logger: Logger;
  /** Clé publique VAPID exposée à l'API (jamais la privée). */
  publicKey: string;
  /** Activation côté serveur (`push.enabled === "on"`), relue à chaud. */
  enabled: () => boolean;
  /** Présence des clients connectés (pour la décision anti-spam). */
  presence: () => PresenceView[];
  /** Envoi vers un service de push (injectable en test). */
  send: (subscription: PushSubscriptionRecord, payload: NotificationPayload) => Promise<PushSendOutcome>;
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/** Construit le contenu d'une notification (PURE). */
export function buildNotification(event: NotifyEvent): NotificationPayload {
  const sessionId = typeof event.sessionId === "string" ? event.sessionId : undefined;
  const base = {
    tag: `yuki-${event.kind}-${sessionId ?? "global"}`,
    data: {
      kind: event.kind,
      ...(sessionId ? { sessionId } : {}),
      // Clic : on ouvre le chat sur la conversation concernée (l'UI adopte
      // `?session=<id>` au chargement), sinon la racine.
      url: sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/",
    },
  } as const;

  switch (event.kind) {
    case "approval":
      return {
        title: "Validation en attente",
        body: event.detail
          ? `Commande à valider : ${truncate(event.detail, MAX_NOTIFICATION_BODY_CHARS)}`
          : "Une commande attend votre décision.",
        ...base,
      };
    case "job_report":
      return {
        title: "Tâche de fond terminée",
        body: event.detail
          ? `Tâche terminée : ${truncate(event.detail, MAX_NOTIFICATION_BODY_CHARS)}`
          : "Yuki a terminé une tâche de fond.",
        ...base,
      };
    case "run_finished":
      return { title: "Réponse prête", body: "Yuki a terminé de répondre.", ...base };
    case "source":
      // ⚠️ Le contenu d'une source n'est JAMAIS recopié ici : la notification
      // annonce qu'il y a du nouveau, l'utilisateur lit le contenu dans la
      // section « Notifications » (où il est replié par défaut).
      return {
        title: "Nouveau message d'une source",
        body: event.detail
          ? truncate(event.detail, MAX_NOTIFICATION_BODY_CHARS)
          : "Un programme branché sur Yuki vous a envoyé quelque chose.",
        ...base,
      };
    default: {
      const exhaustive: never = event.kind;
      throw new Error(`Type de notification inconnu : ${String(exhaustive)}`);
    }
  }
}

export interface PushStatusView {
  enabled: boolean;
  /** Clé publique VAPID (base64url) — jamais la privée. */
  publicKey: string;
  deviceCount: number;
}

export class PushService {
  private readonly store: PushSubscriptionStore;
  private readonly logger: Logger;
  private readonly enabled: () => boolean;
  private readonly presence: () => PresenceView[];
  private readonly send: PushServiceDeps["send"];
  readonly publicKey: string;
  /** Runs de RAPPORT (`origin === "job_report"`) : évite une notification en double. */
  private readonly reportRuns = new Map<string, number>();
  private unsubscribe: (() => void) | undefined;

  constructor(deps: PushServiceDeps) {
    this.store = deps.store;
    this.logger = deps.logger;
    this.enabled = deps.enabled;
    this.presence = deps.presence;
    this.send = deps.send;
    this.publicKey = deps.publicKey;
  }

  status(): PushStatusView {
    return {
      enabled: this.enabled(),
      publicKey: this.publicKey,
      deviceCount: this.store.size,
    };
  }

  /**
   * Décide puis envoie. Ne lève jamais : un service de push injoignable ne doit
   * pas perturber le flux applicatif (le résultat est journalisé).
   */
  async notify(event: NotifyEvent): Promise<NotifyResult> {
    if (!this.enabled()) {
      return { sent: false, sentCount: 0, removedCount: 0, failedCount: 0, skipped: "disabled" };
    }
    if (this.store.size === 0) {
      return {
        sent: false,
        sentCount: 0,
        removedCount: 0,
        failedCount: 0,
        skipped: "no_subscriptions",
      };
    }
    if (!shouldNotify(event, this.presence())) {
      // L'utilisateur voit DÉJÀ le résultat (client actif sur la conversation,
      // ou fenêtre de validation globale affichée) : aucune notification.
      this.logger.debug("push.notify.suppressed", {
        kind: event.kind,
        session: event.sessionId ?? "",
      });
      return { sent: false, sentCount: 0, removedCount: 0, failedCount: 0, skipped: "watching" };
    }

    const payload = buildNotification(event);
    let sentCount = 0;
    let removedCount = 0;
    let failedCount = 0;

    for (const subscription of this.store.list()) {
      let outcome: PushSendOutcome;
      try {
        outcome = await this.send(subscription, payload);
      } catch (error) {
        failedCount += 1;
        this.logger.warn("push.send.threw", {
          kind: event.kind,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (outcome.status === "sent") {
        sentCount += 1;
        continue;
      }
      if (outcome.status === "gone") {
        // Abonnement MORT : on le RETIRE, on ne boucle pas dessus.
        const deviceId = this.store.removeByEndpoint(subscription.endpoint);
        removedCount += 1;
        this.logger.info("push.subscription.removed", {
          device: deviceId ?? subscription.deviceId,
          statusCode: outcome.statusCode,
          reason: "endpoint_expired",
        });
        continue;
      }
      failedCount += 1;
      this.logger.warn("push.send.failed", {
        kind: event.kind,
        statusCode: outcome.statusCode ?? 0,
        error: outcome.error,
      });
    }

    this.logger.info("push.notify", {
      kind: event.kind,
      session: event.sessionId ?? "",
      sent: sentCount,
      removed: removedCount,
      failed: failedCount,
    });
    return { sent: sentCount > 0, sentCount, removedCount, failedCount };
  }

  /**
   * Branche les DÉCLENCHEURS réels. Renvoie un désabonnement unique.
   * Idempotent : un second appel remplace le précédent.
   */
  bind(deps: { host: PiHost; approvals?: ApprovalGatewayPort }): () => void {
    this.unbind();
    const offHost = deps.host.subscribeAll((event) => this.onHostEvent(event));
    const offApprovals = deps.approvals?.subscribeApprovals((event) =>
      this.onApprovalEvent(event),
    );
    this.unsubscribe = () => {
      offHost();
      offApprovals?.();
      this.reportRuns.clear();
    };
    return this.unsubscribe;
  }

  unbind(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private onHostEvent(event: PiEvent): void {
    // Un run de RAPPORT suit un `job_report` (le rapport EST la « réponse
    // prête » de la tâche) : on le mémorise pour NE PAS notifier deux fois.
    if (event.type === "run_started" && event.origin === "job_report") {
      if (event.runId) {
        this.reportRuns.set(event.runId, Date.now());
        if (this.reportRuns.size > 100) {
          const oldest = [...this.reportRuns.entries()].sort((a, b) => a[1] - b[1])[0];
          if (oldest) this.reportRuns.delete(oldest[0]);
        }
      }
      return;
    }
    if (event.type === "job_report") {
      // La tâche de fond demandée par la conversation est TERMINÉE.
      void this.notify({ kind: "job_report", sessionId: event.sessionId }).catch(() => {});
      return;
    }
    if (event.type === "run_finished") {
      if (event.runId && this.reportRuns.has(event.runId)) {
        this.reportRuns.delete(event.runId);
        return; // rapport de tâche : déjà notifié par `job_report`.
      }
      // Annulation volontaire (`abort`) : l'utilisateur est DEVANT, il a agi.
      if (event.reason === "abort") return;
      void this.notify({ kind: "run_finished", sessionId: event.sessionId }).catch(() => {});
    }
  }

  private onApprovalEvent(event: ApprovalViewEvent): void {
    if (event.kind !== "requested") return;
    // ⚠️ LE PLUS IMPORTANT : une commande attend une décision humaine.
    void this.notify({
      kind: "approval",
      sessionId: event.approval.sessionId ?? null,
      detail: event.approval.command,
    }).catch(() => {});
  }
}

export function createPushService(deps: PushServiceDeps): PushService {
  return new PushService(deps);
}
