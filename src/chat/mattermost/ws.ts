/**
 * WebSocket Mattermost v4 (lot 18, lot 2).
 *
 * Trame d'authentification VÉRIFIÉE dans la spécification officielle
 * (`api/v4/source/introduction.yaml`, section « WebSocket → Authentication ») :
 *
 * ```json
 * {"seq": 1, "action": "authentication_challenge",
 *  "data": {"token": "mattermosttokengoeshere"}}
 * ```
 * et la réponse de succès est `{"status": "OK", "seq_reply": 1}`, suivie de
 * l'événement `hello`. ⚠️ Le jeton ne circule QUE dans cette trame, sur la
 * connexion serveur→serveur : il ne part JAMAIS vers un navigateur (la CSP
 * interdit de toute façon tout appel du navigateur vers Mattermost).
 *
 * Événements retenus : `posted`, `post_edited`, `post_deleted` — les autres
 * (`channel_viewed`, `typing`, `status_change`…) sont ignorés en silence : ce ne
 * sont pas des messages.
 *
 * ⚠️ RECONNEXION : backoff exponentiel BORNÉ (1 s → 60 s) avec gigue, compteur de
 * tentatives VISIBLE dans `status()`. Jamais de reconnexion silencieuse à
 * l'infini : au-delà de `maxAttempts`, le client s'arrête et l'ÉTAT LE DIT (le
 * rattrapage REST périodique reste, lui, la ceinture de sécurité).
 */

import { WebSocket } from "ws";

import { mattermostWebSocketUrl } from "./client.js";
import {
  messageOf,
  postOfEventData,
  type MattermostPostEvent,
  type MattermostWsFrame,
} from "./types.js";

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface MattermostSocketLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
}

/** Doublure minimale de `WebSocket` (tests : serveur fixture local). */
export interface WebSocketLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  removeAllListeners?(): unknown;
}

export interface MattermostSocketOptions {
  /** URL de base du serveur, RELUE à chaque tentative. */
  baseUrl: () => string;
  /** Jeton du bot, RELU à chaque tentative. ⚠️ Jamais journalisé. */
  token: () => string | undefined;
  /** Reçoit chaque événement de post RETENU (`posted`, `post_edited`, `post_deleted`). */
  onEvent: (event: MattermostPostEvent) => void;
  /** Prévient d'un changement d'état (connexion perdue, reprise…). */
  onStateChange?: (status: MattermostSocketStatus) => void;
  logger?: MattermostSocketLogger;
  /** Fabrique de WebSocket (tests) ; par défaut la classe `ws`. */
  createSocket?: (url: string) => WebSocketLike;
  random?: () => number;
  /** Délai de la PREMIÈRE reconnexion (défaut 1 s). */
  baseDelayMs?: number;
  /** Délai MAXIMAL entre deux tentatives (défaut 60 s). */
  maxDelayMs?: number;
  /** Nombre maximal de tentatives consécutives avant arrêt (défaut 20). */
  maxAttempts?: number;
  /** Délai d'attente d'authentification après l'ouverture (défaut 10 s). */
  authTimeoutMs?: number;
  /** Gigue ajoutée au backoff (défaut 250 ms). */
  jitterMs?: number;
}

/** État du socket, lu par le statut de la plateforme (jamais un jeton). */
export interface MattermostSocketStatus {
  /** `true` entre l'authentification réussie et la perte de connexion. */
  connecte: boolean;
  /** Connexion TCP/WS ouverte mais pas encore authentifiée. */
  connexion: boolean;
  /** Nombre de tentatives de reconnexion consécutives (0 = connexion saine). */
  tentatives: number;
  /** Délai avant la prochaine tentative, si une reconnexion est planifiée (ms). */
  prochainEssaiMs?: number;
  /** Dernière erreur, en français (jamais un jeton, jamais une URL complète). */
  derniereErreur?: string;
  /** `true` quand le nombre maximal de tentatives est atteint (arrêt assumé). */
  abandonne: boolean;
}

const POST_EVENTS = new Set(["posted", "post_edited", "post_deleted"]);

export class MattermostSocket {
  private readonly options: MattermostSocketOptions;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly random: () => number;
  private socket: WebSocketLike | null = null;
  private running = false;
  private authentifie = false;
  private tentatives = 0;
  private prochainEssaiMs: number | undefined;
  private derniereErreur: string | undefined;
  private abandonne = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MattermostSocketOptions) {
    this.options = options;
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.random = options.random ?? Math.random;
  }

  status(): MattermostSocketStatus {
    return {
      connecte: this.authentifie,
      connexion: this.socket !== null && !this.authentifie,
      tentatives: this.tentatives,
      ...(this.prochainEssaiMs !== undefined ? { prochainEssaiMs: this.prochainEssaiMs } : {}),
      ...(this.derniereErreur !== undefined ? { derniereErreur: this.derniereErreur } : {}),
      abandonne: this.abandonne,
    };
  }

  /** Ouvre la connexion (idempotent : deux appels ne créent pas deux sockets). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abandonne = false;
    this.tentatives = 0;
    this.derniereErreur = undefined;
    await this.open();
  }

  /** Ferme la connexion et ANNULAIT toute reconnexion (idempotent). */
  async stop(): Promise<void> {
    this.running = false;
    this.clearTimers();
    this.closeSocket();
    this.authentifie = false;
    this.prochainEssaiMs = undefined;
    this.notify();
  }

  /** Marque une nouvelle tentative (le polling REST reste la ceinture de sécurité). */
  private async open(): Promise<void> {
    this.prochainEssaiMs = undefined;
    const token = this.options.token()?.trim() ?? "";
    if (token === "") {
      this.derniereErreur =
        "Le jeton du bot Mattermost n'est pas enregistré : le temps réel est arrêté " +
        "(la synchronisation périodique reste active).";
      this.notify();
      return;
    }
    let url: string;
    try {
      url = mattermostWebSocketUrl(this.options.baseUrl());
    } catch (error) {
      // ⚠️ Le message de `mattermostApiBase` ne contient jamais le jeton.
      this.derniereErreur = messageOf(error);
      this.notify();
      return;
    }

    let socket: WebSocketLike;
    try {
      socket = this.createSocket(url);
    } catch (error) {
      this.derniereErreur = `Connexion temps réel impossible (${messageOf(error)}).`;
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.authentifie = false;
    this.notify();

    socket.on("open", () => {
      if (this.socket !== socket) return;
      // ⚠️ Authentification EN PREMIER MESSAGE (contrat de l'API).
      socket.send(
        JSON.stringify({
          seq: 1,
          action: "authentication_challenge",
          data: { token },
        }),
      );
      this.authTimer = setTimeout(() => {
        if (this.socket !== socket || this.authentifie) return;
        this.derniereErreur =
          "Le serveur Mattermost n'a pas confirmé l'authentification temps réel " +
          "(délai dépassé) : nouvelle tentative.";
        this.failSocket(socket);
      }, this.options.authTimeoutMs ?? 10_000);
      if (typeof (this.authTimer as { unref?: () => void }).unref === "function") {
        (this.authTimer as { unref: () => void }).unref();
      }
    });

    socket.on("message", (raw: unknown) => {
      if (this.socket !== socket) return;
      this.handleFrame(raw);
    });

    socket.on("error", (error: unknown) => {
      if (this.socket !== socket) return;
      this.derniereErreur = `Connexion temps réel en erreur (${messageOf(error)}).`;
    });

    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.failSocket(socket);
    });
  }

  /** Traite une trame reçue : réponse d'action ou événement. */
  private handleFrame(raw: unknown): void {
    let frame: MattermostWsFrame;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : String(raw)) as MattermostWsFrame;
    } catch {
      return; // Trame illisible : ignorée, la connexion reste vivante.
    }
    if (!frame || typeof frame !== "object") return;

    // 1. Réponse à notre `authentication_challenge`.
    if (frame.seq_reply === 1 || frame.status !== undefined) {
      if (frame.status === "OK") {
        this.authentifie = true;
        this.tentatives = 0;
        this.derniereErreur = undefined;
        this.clearAuthTimer();
        this.notify();
        this.options.logger?.info("chat.mattermost.ws.authentifie", {});
      } else if (frame.status === "FAIL") {
        // ⚠️ Le message d'erreur du serveur peut être anglais : on le range en
        // DETAIL, la phrase principale reste en français.
        const detail = frame.error?.id ?? frame.error?.message ?? "refus sans détail";
        this.derniereErreur =
          `Le serveur Mattermost a refusé l'authentification temps réel (${detail}). ` +
          "Vérifiez le jeton du bot.";
        this.abandonne = true; // Un jeton refusé ne se répare pas en réessayant.
        this.running = false;
        this.closeSocket();
        this.notify();
        return;
      }
    }

    // 2. Événement `hello` : confirmation implicite d'authentification.
    if (frame.event === "hello" && !this.authentifie) {
      this.authentifie = true;
      this.tentatives = 0;
      this.clearAuthTimer();
      this.notify();
      return;
    }

    // 3. Événements de POST.
    const event = typeof frame.event === "string" ? frame.event : "";
    if (!POST_EVENTS.has(event)) return;
    const post = postOfEventData(frame.data);
    if (!post) {
      this.options.logger?.warn("chat.mattermost.ws.post_illisible", { event });
      return;
    }
    try {
      this.options.onEvent({ kind: event as MattermostPostEvent["kind"], post });
    } catch (error) {
      // Un consommateur fautif ne doit pas tuer la connexion.
      this.options.logger?.warn("chat.mattermost.ws.consumer_failed", {
        error: messageOf(error),
      });
    }
  }

  /** Perte de connexion : état, puis reconnexion planifiée (bornée). */
  private failSocket(socket: WebSocketLike): void {
    this.clearTimers();
    this.authentifie = false;
    if (this.socket === socket) this.socket = null;
    try {
      socket.removeAllListeners?.();
    } catch {
      // Meilleur effort.
    }
    if (!this.running) {
      this.notify();
      return;
    }
    this.scheduleReconnect();
  }

  /** Planifie une reconnexion avec backoff borné + gigue ; s'arrête au plafond. */
  private scheduleReconnect(): void {
    const maxAttempts = this.options.maxAttempts ?? 20;
    if (this.tentatives >= maxAttempts) {
      this.abandonne = true;
      this.prochainEssaiMs = undefined;
      this.derniereErreur =
        `Le temps réel Mattermost est arrêté après ${maxAttempts} tentatives : ` +
        "la synchronisation périodique continue de rattraper les messages.";
      this.options.logger?.warn("chat.mattermost.ws.abandon", { tentatives: this.tentatives });
      this.notify();
      return;
    }
    const base = this.options.baseDelayMs ?? 1_000;
    const max = this.options.maxDelayMs ?? 60_000;
    const jitter = this.options.jitterMs ?? 250;
    const delay = Math.min(max, base * 2 ** this.tentatives) + Math.round(this.random() * jitter);
    this.tentatives += 1;
    this.prochainEssaiMs = delay;
    this.derniereErreur ??= "Connexion temps réel interrompue : reconnexion planifiée.";
    this.notify();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running) return;
      void this.open();
    }, delay);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  private clearTimers(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.clearAuthTimer();
  }

  private clearAuthTimer(): void {
    if (this.authTimer !== null) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.removeAllListeners?.();
    } catch {
      // Meilleur effort.
    }
    try {
      socket.close(1000, "arret");
    } catch {
      try {
        socket.terminate?.();
      } catch {
        // Meilleur effort.
      }
    }
  }

  private notify(): void {
    try {
      this.options.onStateChange?.(this.status());
    } catch {
      // Un observateur fautif ne casse pas le socket.
    }
  }
}
