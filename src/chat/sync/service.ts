/**
 * SYNCHRONISATION d'une plateforme de discussion vers le miroir (lot 18, lot 2).
 *
 * Le service est VOLONTAIREMENT agnostique de la plateforme : il ne connaît qu'un
 * PORT (`ChatSyncPlatform`) qui sait énumérer des canaux, rendre les posts modifiés
 * depuis un instant, et pousser les nouveaux messages en temps réel. Mattermost
 * l'implémente dans `src/chat/mattermost/adapter.ts`.
 *
 * ⚠️ DÉCISION DU LOT 1, TENUE ICI : c'est la CONFIGURATION qui déclenche la
 * synchronisation, pas un mode. Il n'y a plus de « mode courant » (les plateformes
 * sont des interrupteurs indépendants) : un
 * canal doit continuer d'être ingéré même quand l'utilisateur regarde le mode local —
 * sinon les messages reçus pendant ce temps seraient perdus.
 *
 * ⚠️ BACKFILL = 2 SEMAINES, borné en DATE **et** en MESSAGES :
 *  - `since = maintenant − 14 jours` (la borne de date est passée à l'API) ;
 *  - borne DURE de 1 000 messages par canal ; si elle est atteinte, le canal est
 *    marqué `historiqueAnterieur` et l'interface affiche « historique antérieur non
 *    importé ». Jamais une coupe silencieuse.
 *
 * ⚠️ FILET DE SÉCURITÉ : un RATTRAPAGE REST périodique (60 s par défaut) relit le
 * canal depuis le CURSEUR persisté. Le temps réel peut être coupé ; les messages ne
 * sont jamais perdus pour autant, et l'idempotence du miroir rend le double chemin
 * inoffensif.
 *
 * ⚠️ HISTORIQUE ≠ TEMPS RÉEL (`ChatSyncDelivery.historique`) : le backfill rejoue
 * jusqu'à 1 000 messages par canal, dont des mentions vieilles de deux semaines. Le
 * message est TOUJOURS livré (l'interface doit voir l'historique), mais il est étiqueté
 * `historique: true` pour que le moteur de RÉPONSE s'abstienne : sans cette étiquette,
 * le premier branchement répondrait à quatorze jours de mentions. Le RATTRAPAGE, lui,
 * n'est PAS de l'historique : ce sont des messages récents que le temps réel a manqués,
 * ils méritent une réponse.
 */

import type { ChatSyncPlatform } from "./platform.js";
import type { ChatMirrorStore } from "../mirror/store.js";
import type { RemoteMessage } from "../types.js";

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface ChatSyncLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Fenêtre du backfill initial (jours). */
export const BACKFILL_DAYS = 14;

/** Borne DURE de messages importés par canal au backfill. */
export const BACKFILL_MAX_MESSAGES = 1_000;

/** Période du rattrapage REST (filet de sécurité du temps réel). */
export const DEFAULT_POLL_INTERVAL_MS = 60_000;

/**
 * Passe de rattrapage sur combien avant de RÉ-ÉNUMÉRER les canaux.
 * ⚠️ 5 passes ≈ 5 minutes : c'est le délai maximal avant qu'un canal ajouté
 * (sans événement temps réel reçu) n'apparaisse. Le coût est de deux appels
 * (`/users/me/teams` puis les canaux par équipe) — pas un par canal.
 */
export const DEFAULT_RESCAN_EVERY_POLLS = 5;

/**
 * PROVENANCE d'une livraison.
 *
 * ⚠️ `historique` n'est pas décoratif : c'est la seule chose qui distingue une mention
 * de la semaine dernière (backfill) d'un message qui vient d'arriver (temps réel ou
 * rattrapage). Elle décide, et elle seule, si le moteur de réponse a le droit de courir.
 */
export interface ChatSyncDelivery {
  /** `true` quand le message est rejoué par le backfill initial. */
  historique: boolean;
}

export interface ChatSyncOptions {
  platform: ChatSyncPlatform;
  store: ChatMirrorStore;
  logger?: ChatSyncLogger;
  now?: () => number;
  /** Période du rattrapage REST. */
  pollIntervalMs?: number;
  /**
   * ⚠️ RÉ-ÉNUMÉRATION PÉRIODIQUE DES CANAUX (en nombre de passes de rattrapage) :
   * un canal où le bot vient d'être ajouté doit apparaître même si l'événement
   * temps réel a été manqué (reconnexion, redémarrage du serveur). Défaut 5 passes
   * (≈ 5 min). `0` désactive — le temps réel et la resynchronisation explicite
   * restent les déclencheurs.
   */
  rescanEveryPolls?: number;
  /** Fenêtre du backfill initial (jours, défaut 14). */
  backfillDays?: number;
  /** Borne dure de messages par canal (défaut 1 000). */
  backfillMaxMessages?: number;
  /**
   * Appelé pour CHAQUE message nouvellement inséré (temps réel, rattrapage ET backfill).
   * C'est le point d'entrée des abonnés ET du moteur de réponse, jamais un envoi direct.
   *
   * ⚠️ Le second argument dit d'où vient le message : `historique: true` = rejoué par
   * le backfill. L'abonné d'interface le diffuse quand même ; SEUL le moteur de réponse
   * doit s'abstenir.
   */
  onMessage?: (message: RemoteMessage, delivery: ChatSyncDelivery) => void;
  /** Planificateur injectable (tests) — par défaut `setTimeout`. */
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
}

/**
 * Vue de synchronisation, exposée par le statut de la plateforme.
 *
 * ⚠️ Elle ne porte AUCUN état de plateforme : le calculer ici obligerait à interroger
 * l'adaptateur, qui interroge déjà la synchronisation (boucle). L'état affichable est
 * composé par l'APPELANT (`syncEtatOf`, `src/chat/sync/platform.ts`).
 */
export interface ChatSyncStatus {
  /** `true` dès que `start()` a abouti au moins une fois. */
  demarre: boolean;
  /** Dernier contact RÉUSSI connu du miroir (ISO). */
  dernierContact?: string;
  /** Nombre de canaux suivis (borné à 50 par le miroir). */
  canauxSuivis: number;
  /** Avancement du backfill (tous canaux confondus). */
  backfill: {
    fait: boolean;
    depuis?: string;
    imports: number;
    /** `true` si au moins un canal a atteint sa borne (bandeau à afficher). */
    borneAtteinte: boolean;
  };
  /** Dernière erreur, en français (jamais un jeton, jamais une URL complète). */
  derniereErreur?: string;
  /** `true` quand le rattrapage périodique tourne. */
  rattrapageActif: boolean;
}

export class ChatSyncService {
  private readonly options: ChatSyncOptions;
  private readonly store: ChatMirrorStore;
  private readonly now: () => number;
  private readonly pollIntervalMs: number;
  private readonly rescanEveryPolls: number;
  private passes = 0;
  private readonly backfillDays: number;
  private readonly backfillMaxMessages: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private demarre = false;
  private rattrapageActif = false;
  private imports = 0;
  private derniereErreur: string | undefined;
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private enCours: Promise<void> | null = null;

  constructor(options: ChatSyncOptions) {
    this.options = options;
    this.store = options.store;
    this.now = options.now ?? (() => Date.now());
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.rescanEveryPolls = options.rescanEveryPolls ?? DEFAULT_RESCAN_EVERY_POLLS;
    this.backfillDays = options.backfillDays ?? BACKFILL_DAYS;
    this.backfillMaxMessages = options.backfillMaxMessages ?? BACKFILL_MAX_MESSAGES;
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        // Un rattrapage ne doit pas retenir le processus en vie.
        (handle as { unref?: () => void }).unref?.();
        return handle;
      });
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** État de la synchronisation (jamais un jeton, jamais une URL complète). */
  status(): ChatSyncStatus {
    const records = this.store.records();
    const ids = Object.keys(records);
    const valeurs = ids.map((id) => records[id]);
    const fait = valeurs.length > 0 && valeurs.every((record) => record.backfillDone);
    const depuis = valeurs
      .map((record) => record.backfillDepuis)
      .filter((value): value is string => value !== undefined)
      .sort()[0];
    const borneAtteinte = valeurs.some(
      (record) => record.historiqueAnterieur === true || record.borneAtteinte === true,
    );
    // Plus récente activité connue du miroir (ISO) : jamais une date inventée.
    const dernierContact = valeurs
      .map((record) => record.dernierMessage)
      .filter((value): value is string => value !== undefined)
      .sort()
      .at(-1);
    return {
      demarre: this.demarre,
      ...(dernierContact !== undefined ? { dernierContact } : {}),
      canauxSuivis: ids.length,
      backfill: {
        fait,
        ...(depuis !== undefined ? { depuis } : {}),
        imports: this.imports,
        borneAtteinte,
      },
      ...(this.derniereErreur !== undefined ? { derniereErreur: this.derniereErreur } : {}),
      rattrapageActif: this.rattrapageActif,
    };
  }

  /**
   * Démarre la synchronisation (idempotent).
   *
   * Ordre : identité du bot ⇒ canaux ⇒ backfill ⇒ temps réel ⇒ rattrapage périodique.
   * Une erreur n'abandonne pas tout : on mémorise la raison, on garde le rattrapage
   * périodique (il retentera), et l'état devient `connexion`.
   */
  async start(): Promise<void> {
    if (this.enCours) return this.enCours;
    this.enCours = this.run().finally(() => {
      this.enCours = null;
    });
    return this.enCours;
  }

  /** Arrête tout (idempotent) : plus aucune reconnexion, plus aucun rattrapage. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.rattrapageActif = false;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.demarre = false;
  }

  private async run(): Promise<void> {
    try {
      const identity = await this.options.platform.identity();
      this.store.setBot(
        { id: identity.id, ...(identity.username ? { username: identity.username } : {}) },
        // ⚠️ Identité rangée PAR PLATEFORME : deux plateformes, deux bots, deux identités.
        this.options.platform.platform ?? "mattermost",
      );
    } catch (error) {
      this.fail(error);
      return;
    }

    try {
      await this.backfillAll();
    } catch (error) {
      this.fail(error);
    }

    try {
      this.unsubscribe?.();
      this.unsubscribe = this.options.platform.subscribePosts((message) =>
        // ⚠️ TEMPS RÉEL : jamais de l'historique, donc le moteur de réponse est autorisé.
        this.deliver(message, { historique: false }),
      );
    } catch (error) {
      this.fail(error);
    }

    this.demarre = true;
    this.startPolling();
  }

  /** Backfill initial de TOUS les canaux (2 semaines, borne 1 000 messages). */
  async backfillAll(): Promise<void> {
    const channels = await this.options.platform.channels();
    const since = new Date(this.now() - this.backfillDays * 86_400_000).toISOString();
    for (const channel of channels) {
      const conversationId = channel.conversationId;
      const created = this.store.ensureConversation({
        conversationId,
        platform: channel.plateforme,
        remoteId: channel.remoteId,
        title: channel.title,
      });
      if (!created) continue; // Borne de 50 canaux atteinte : REFUS journalisé.
      const record = this.store.record(conversationId);
      if (record?.backfillDone === true) continue;
      try {
        const page = await this.options.platform.postsSince(channel.remoteId, since);
        const kept = page.messages.slice(-this.backfillMaxMessages);
        for (const message of kept) {
          // ⚠️ HISTORIQUE : livré aux abonnés, JAMAIS soumis au moteur de réponse.
          const outcome = this.ingest(message, conversationId, true);
          if (outcome === "insere") this.imports += 1;
        }
        this.store.markBackfill(conversationId, {
          depuis: since,
          historiqueAnterieur: page.historiqueAnterieur || page.messages.length > kept.length,
        });
      } catch (error) {
        // Un canal en échec n'empêche pas les autres ; il ne sera PAS marqué fait.
        this.options.logger?.warn("chat.sync.backfill_failed", {
          canal: channel.remoteId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.derniereErreur = `Le canal « ${channel.title} » n'a pas pu être importé.`;
      }
    }
  }

  /**
   * UNE passe de rattrapage : relit chaque canal depuis son CURSEUR persisté.
   * Idempotent (le miroir refuse les doublons) ⇒ le double chemin temps réel +
   * rattrapage ne produit jamais de message en double.
   */
  async pollOnce(): Promise<void> {
    const records = this.store.records();
    for (const [conversationId, record] of Object.entries(records)) {
      const since = record.curseur ?? record.backfillDepuis;
      if (since === undefined) continue;
      try {
        const page = await this.options.platform.postsSince(record.remoteId, since);
        // ⚠️ PAS de l'historique : le rattrapage ramène des messages RÉCENTS que le temps
        // réel a manqués. Ils méritent une réponse comme les autres.
        for (const message of page.messages) this.ingest(message, conversationId, false);
        if (page.historiqueAnterieur && record.historiqueAnterieur !== true) {
          this.store.markBackfill(conversationId, {
            depuis: record.backfillDepuis ?? since,
            historiqueAnterieur: true,
          });
        }
      } catch (error) {
        this.fail(error, { canal: record.remoteId });
      }
    }
  }

  /** Démarre la boucle de rattrapage (une seule à la fois). */
  private startPolling(): void {
    if (this.rattrapageActif) return;
    if (this.pollIntervalMs <= 0) return;
    this.rattrapageActif = true;
    const tick = () => {
      this.timer = null;
      if (!this.rattrapageActif) return;
      void this.pollOnce()
        .catch((error: unknown) => this.fail(error))
        .then(() => this.redecouvrirSiNecessaire())
        .finally(() => {
          if (!this.rattrapageActif) return;
          this.timer = this.schedule(tick, this.pollIntervalMs);
        });
    };
    this.timer = this.schedule(tick, this.pollIntervalMs);
  }

  /**
   * Ré-énumère les canaux toutes les `rescanEveryPolls` passes.
   *
   * ⚠️ FILE DE SÉCURITÉ DE LA DÉCOUVERTE : le temps réel signale une adhésion
   * (`added_to_channel`), mais un événement manqué pendant une coupure laisserait
   * le canal absent pour toujours. `backfillAll` recrée alors les conversations
   * manquantes (les autres sont SAUTÉES : coût quasi nul).
   */
  private async redecouvrirSiNecessaire(): Promise<void> {
    if (this.rescanEveryPolls <= 0) return;
    this.passes += 1;
    if (this.passes % this.rescanEveryPolls !== 0) return;
    try {
      await this.backfillAll();
      this.options.logger?.info("chat.sync.canaux_redecouverts", {
        canaux: Object.keys(this.store.records()).length,
      });
    } catch (error) {
      // Une découverte en échec n'arrête pas le rattrapage : il retentera.
      this.fail(error, { etape: "decouverte" });
    }
  }

  /**
   * Ingère un message et prévient l'observateur (jamais un envoi direct).
   *
   * ⚠️ `historique` traverse TOUTE la chaîne (ingest → deliver → `onMessage`) : c'est le
   * seul moyen pour que l'étiquette ne se perde pas en chemin.
   */
  private ingest(
    message: RemoteMessage,
    conversationId: string,
    historique: boolean,
  ): "insere" | "mis_a_jour" | "doublon" | "ignore" | "borne" {
    if (message.conversationId !== conversationId) {
      message = { ...message, conversationId };
    }
    const outcome = this.store.upsert(message, {
      update: this.store.has(conversationId, message.remoteId),
    });
    // ⚠️ Seule une INSERTION est livrée : une édition ne redéclenche rien.
    if (outcome === "insere") this.deliver(message, { historique });
    return outcome;
  }

  private deliver(message: RemoteMessage, delivery: ChatSyncDelivery): void {
    try {
      this.options.onMessage?.(message, delivery);
    } catch (error) {
      this.options.logger?.warn("chat.sync.consumer_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private fail(error: unknown, fields: Record<string, unknown> = {}): void {
    const message = error instanceof Error ? error.message : String(error);
    this.derniereErreur = message;
    this.options.logger?.warn("chat.sync.failed", { ...fields, error: message });
  }
}
