/**
 * Passerelle (WebSocket) Discord v10 (lot 21).
 *
 * Cycle VÉRIFIÉ dans la doc officielle (`events/gateway.mdx`) :
 *  1. `HELLO` (`op 10`) donne `heartbeat_interval` ;
 *  2. premier battement après `heartbeat_interval * jitter` (`jitter` = valeur aléatoire
 *     entre 0 et 1 — « to prevent too many clients from reconnecting at the exact same
 *     time »), puis un battement TOUTES les `heartbeat_interval` ms, avec le dernier `s`
 *     reçu (ou `null` au début) ;
 *  3. `IDENTIFY` (`op 2`) : `{ token, intents, properties: { os, browser, device } }` ;
 *  4. `READY` (`op 0 t=READY`) donne `session_id` et `resume_gateway_url` ;
 *  5. après une coupure, `RESUME` (`op 6`) : `{ token, session_id, seq }` sur
 *     `resume_gateway_url` — ⚠️ sans nouvel `IDENTIFY`.
 *
 * Codes de fermeture traîtés comme la doc l'exige (`topics/opcodes-and-status-codes`) :
 *  - `4004` (jeton invalide) ⇒ **ARRÊT NET**, aucun nouvel essai (une boucle de
 *    reconnexion avec un mauvais jeton ne fait que consommer le quota de sessions) ;
 *  - `4014` (intent non autorisé) ⇒ on réessaie UNE fois SANS l'intent privilégié
 *    `MESSAGE_CONTENT` et on DIT pourquoi les contenus seront vides ;
 *  - `7` (`RECONNECT`) et `9` (`INVALID_SESSION`) : reprise ou nouvelle session.
 *
 * ⚠️ Backoff BORNÉ (1 s → 60 s) avec gigue et compteur VISIBLE (`tentatives`) : jamais de
 * reconnexion silencieuse à l'infini. Le rattrapage REST périodique reste la ceinture de
 * sécurité.
 *
 * ⚠️ Le jeton ne circule QUE dans les trames `IDENTIFY`/`RESUME`, qui vont au serveur de
 * Discord. Il n'est jamais journalisé et n'apparaît dans aucun message d'état.
 */

import { WebSocket } from "ws";

import {
  DISCORD_GATEWAY_URL,
  DISCORD_INTENTS_STANDARD,
  DISCORD_INTENTS_WITH_CONTENT,
  isDiscordMessage,
  messageOf,
  type DiscordGatewayPayload,
  type DiscordMessage,
  type DiscordMessageEvent,
  type DiscordMessageEventKind,
  type DiscordReadyPayload,
} from "./types.js";

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface DiscordSocketLogger {
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

export interface DiscordSocketOptions {
  /** Jeton du bot, RELU à chaque tentative. ⚠️ Jamais journalisé. */
  token: () => string | undefined;
  /** Reçoit chaque événement de message RETENU (`MESSAGE_CREATE`/`UPDATE`/`DELETE`). */
  onEvent: (event: DiscordMessageEvent) => void;
  /** Prévient d'un changement d'état (connexion, session, échec). */
  onStateChange?: (status: DiscordSocketStatus) => void;
  /** Prévient quand une SESSION est prête (`READY`), avec l'identité du bot. */
  onReady?: (ready: { userId?: string; username?: string; sessionId?: string }) => void;
  logger?: DiscordSocketLogger;
  /** Fabrique de WebSocket (tests) ; par défaut la classe `ws`. */
  createSocket?: (url: string) => WebSocketLike;
  random?: () => number;
  /** URL de la passerelle (tests) ; par défaut `DISCORD_GATEWAY_URL`. */
  gatewayUrl?: string;
  /** Délai de la PREMIÈRE reconnexion (défaut 1 s). */
  baseDelayMs?: number;
  /** Délai MAXIMAL entre deux tentatives (défaut 60 s). */
  maxDelayMs?: number;
  /** Nombre maximal de tentatives consécutives avant arrêt (défaut 20). */
  maxAttempts?: number;
  /** Gigue ajoutée au backoff (défaut 250 ms). */
  jitterMs?: number;
  /**
   * Demander l'intent PRIVILÉGIÉ `MESSAGE_CONTENT` (défaut `true`).
   *
   * ⚠️ S'il n'est pas activé dans le portail développeur, Discord ferme la connexion
   * avec `4014` : le socket réessaie alors UNE fois sans lui, et l'état le dit.
   */
  requestMessageContent?: boolean;
}

/**
 * Phrase EXACTE affichée quand l'intent privilégié `MESSAGE_CONTENT` manque.
 *
 * ⚠️ Écrite UNE fois : le socket la met dans son état, l'adaptateur la reprend telle
 * quelle. Deux textes différents feraient douter de la cause.
 */
export const DISCORD_INTENT_CONTENT_REASON =
  "⚠️ L'intent privilégié MESSAGE_CONTENT n'est pas activé pour ce bot : Discord renvoie " +
  "des messages au contenu VIDE (Yuki ne lit que les messages où elle est citée). " +
  "Activez-le dans le portail développeur (Applications → votre bot → Bot → Privileged " +
  "Gateway Intents → MESSAGE CONTENT), puis relancez la connexion.";

/** État du socket, lu par le statut de la plateforme (jamais un jeton). */
export interface DiscordSocketStatus {
  /** `true` entre `READY`/`RESUMED` et la perte de connexion. */
  connecte: boolean;
  /** Connexion ouverte mais session pas encore établie. */
  connexion: boolean;
  /** Nombre de tentatives de reconnexion consécutives (0 = connexion saine). */
  tentatives: number;
  /** Délai avant la prochaine tentative, si une reconnexion est planifiée (ms). */
  prochainEssaiMs?: number;
  /** Dernière erreur, en français (jamais un jeton, jamais une URL complète). */
  derniereErreur?: string;
  /** `true` quand le nombre maximal de tentatives est atteint ou un arrêt net demandé. */
  abandonne: boolean;
  /** `true` quand l'intent `MESSAGE_CONTENT` n'a PAS pu être demandé (4014). */
  intentContentManquant: boolean;
  /** `true` quand la session courante est une REPRISE (`RESUMED`). */
  reprise: boolean;
}

/** Codes de fermeture qui interdisent toute reconnexion (doc officielle). */
const CLOSE_FATAL = new Set([4004, 4010, 4011, 4012, 4013]);
/** Code de fermeture « intent non autorisé » : on réessaie sans l'intent privilégié. */
const CLOSE_DISALLOWED_INTENT = 4014;

const MESSAGE_EVENTS = new Set<DiscordMessageEventKind>([
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
]);

export class DiscordSocket {
  private readonly options: DiscordSocketOptions;
  private readonly createSocket: (url: string) => WebSocketLike;
  private readonly random: () => number;
  private socket: WebSocketLike | null = null;
  private running = false;
  private sessionReady = false;
  private tentatives = 0;
  private prochainEssaiMs: number | undefined;
  private derniereErreur: string | undefined;
  private abandonne = false;
  private intentContentManquant = false;
  private reprise = false;
  /** Intent privilégié effectivement demandé (bascule à `false` après un 4014). */
  private demanderContent: boolean;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private firstBeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingAck = false;
  /** Dernier numéro de séquence reçu (`s`), pour les battements et la reprise. */
  private sequence: number | null = null;
  private sessionId: string | undefined;
  private resumeUrl: string | undefined;

  constructor(options: DiscordSocketOptions) {
    this.options = options;
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.random = options.random ?? Math.random;
    this.demanderContent = options.requestMessageContent !== false;
  }

  status(): DiscordSocketStatus {
    return {
      connecte: this.sessionReady,
      connexion: this.socket !== null && !this.sessionReady,
      tentatives: this.tentatives,
      ...(this.prochainEssaiMs !== undefined ? { prochainEssaiMs: this.prochainEssaiMs } : {}),
      ...(this.derniereErreur !== undefined ? { derniereErreur: this.derniereErreur } : {}),
      abandonne: this.abandonne,
      intentContentManquant: this.intentContentManquant,
      reprise: this.reprise,
    };
  }

  /** Ouvre la connexion (idempotent : deux appels ne créent pas deux sockets). */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abandonne = false;
    this.tentatives = 0;
    this.derniereErreur = undefined;
    this.sessionId = undefined;
    this.sequence = null;
    this.resumeUrl = undefined;
    this.open();
  }

  /** Ferme la connexion et ANNULE toute reconnexion (idempotent). */
  async stop(): Promise<void> {
    this.running = false;
    this.clearTimers();
    this.closeSocket(1000, "arret");
    this.sessionReady = false;
    this.prochainEssaiMs = undefined;
    this.notify();
  }

  // ─── Connexion ───────────────────────────────────────────────────────────

  private open(): void {
    this.prochainEssaiMs = undefined;
    const token = this.options.token()?.trim() ?? "";
    if (token === "") {
      this.derniereErreur =
        "Le jeton du bot Discord n'est pas enregistré : le temps réel est arrêté " +
        "(la synchronisation périodique reste active).";
      this.notify();
      return;
    }
    // ⚠️ Reprise : on utilise `resume_gateway_url` (doc : sinon « disconnects at a higher
    // rate than normal ») ; sinon l'URL standard avec version et encodage explicites.
    const url =
      this.sessionId !== undefined && this.resumeUrl !== undefined
        ? withQuery(this.resumeUrl)
        : (this.options.gatewayUrl ?? DISCORD_GATEWAY_URL);

    let socket: WebSocketLike;
    try {
      socket = this.createSocket(url);
    } catch (error) {
      this.derniereErreur = `Connexion temps réel impossible (${messageOf(error)}).`;
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.sessionReady = false;
    this.awaitingAck = false;
    this.notify();

    socket.on("open", () => {
      if (this.socket !== socket) return;
      // La session s'établit à `HELLO` : on n'identifie pas avant de l'avoir reçu.
    });

    socket.on("message", (raw: unknown) => {
      if (this.socket !== socket) return;
      this.handleFrame(raw);
    });

    socket.on("error", (error: unknown) => {
      if (this.socket !== socket) return;
      this.derniereErreur = `Connexion temps réel en erreur (${messageOf(error)}).`;
    });

    socket.on("close", (code: unknown, reason: unknown) => {
      if (this.socket !== socket) return;
      this.onClose(typeof code === "number" ? code : undefined, typeof reason === "string" ? reason : undefined);
    });
  }

  /** Traite une trame : `HELLO`, `HEARTBEAT_ACK`, `DISPATCH`, `RECONNECT`, `INVALID_SESSION`. */
  private handleFrame(raw: unknown): void {
    let frame: DiscordGatewayPayload;
    try {
      frame = JSON.parse(typeof raw === "string" ? raw : String(raw)) as DiscordGatewayPayload;
    } catch {
      return; // Trame illisible : ignorée, la connexion reste vivante.
    }
    if (!frame || typeof frame !== "object") return;
    const op = typeof frame.op === "number" ? frame.op : -1;

    switch (op) {
      case 10: {
        const interval = Number((frame.d as { heartbeat_interval?: unknown })?.heartbeat_interval);
        const cadence = Number.isFinite(interval) && interval > 0 ? interval : 41_250;
        this.startHeartbeat(cadence);
        if (this.sessionId !== undefined && this.sequence !== null) {
          this.sendResume();
        } else {
          this.sendIdentify();
        }
        return;
      }
      case 11:
        // `HEARTBEAT_ACK` : la connexion est vivante.
        this.awaitingAck = false;
        return;
      case 1:
        // Le serveur DEMANDE un battement immédiat (doc : « send back immediately »).
        this.sendHeartbeat();
        return;
      case 7:
        // `RECONNECT` : on reprend la session, sans nouvel `IDENTIFY`.
        this.derniereErreur = "Discord a demandé une reconnexion : reprise de la session.";
        this.reconnectNow();
        return;
      case 9: {
        // `INVALID_SESSION` : `d === true` ⇒ reprise possible, sinon session neuve.
        const resumable = (frame.d as boolean | undefined) === true;
        this.sessionReady = false;
        if (!resumable) {
          this.sessionId = undefined;
          this.sequence = null;
          this.resumeUrl = undefined;
          this.reprise = false;
        }
        this.derniereErreur = resumable
          ? "Discord a invalidé la session (reprise possible) : reprise en cours."
          : "Discord a invalidé la session : nouvelle session (les événements manqués " +
            "seront rattrapés par la synchronisation périodique).";
        this.reconnectNow();
        return;
      }
      case 0:
        this.handleDispatch(frame);
        return;
      default:
        return;
    }
  }

  /** Événement DISPATCH : séquence, `READY`, `RESUMED`, messages. */
  private handleDispatch(frame: DiscordGatewayPayload): void {
    if (typeof frame.s === "number") this.sequence = frame.s;
    const type = typeof frame.t === "string" ? frame.t : "";
    if (type === "READY") {
      const ready = (frame.d ?? {}) as DiscordReadyPayload;
      if (typeof ready.session_id === "string" && ready.session_id !== "") {
        this.sessionId = ready.session_id;
      }
      if (typeof ready.resume_gateway_url === "string" && ready.resume_gateway_url !== "") {
        this.resumeUrl = ready.resume_gateway_url;
      }
      this.sessionReady = true;
      this.reprise = false;
      this.tentatives = 0;
      // ⚠️ Un intent manquant reste DIT après une reconnexion réussie : sinon la cause du
      // « bot muet » disparaîtrait de l'écran au moment précis où elle explique tout.
      this.derniereErreur = this.intentContentManquant ? DISCORD_INTENT_CONTENT_REASON : undefined;
      this.notify();
      try {
        this.options.onReady?.({
          ...(typeof ready.user?.id === "string" ? { userId: ready.user.id } : {}),
          ...(typeof ready.user?.username === "string" ? { username: ready.user.username } : {}),
          ...(this.sessionId !== undefined ? { sessionId: this.sessionId } : {}),
        });
      } catch (error) {
        this.options.logger?.warn("chat.discord.ws.onready_failed", { error: messageOf(error) });
      }
      this.options.logger?.info("chat.discord.ws.pret", {});
      return;
    }
    if (type === "RESUMED") {
      this.sessionReady = true;
      this.reprise = true;
      this.tentatives = 0;
      this.derniereErreur = this.intentContentManquant ? DISCORD_INTENT_CONTENT_REASON : undefined;
      this.notify();
      this.options.logger?.info("chat.discord.ws.reprise", {});
      return;
    }
    if (!MESSAGE_EVENTS.has(type as DiscordMessageEventKind)) return;
    const message = frame.d as DiscordMessage | undefined;
    if (!isDiscordMessage(message)) {
      this.options.logger?.warn("chat.discord.ws.message_illisible", { event: type });
      return;
    }
    try {
      this.options.onEvent({ kind: type as DiscordMessageEventKind, message });
    } catch (error) {
      // Un consommateur fautif ne doit pas tuer la connexion.
      this.options.logger?.warn("chat.discord.ws.consumer_failed", { error: messageOf(error) });
    }
  }

  // ─── Battements ─────────────────────────────────────────────────────────

  /**
   * Démarre les battements.
   *
   * ⚠️ PREMIER battement après `interval * jitter` (gigue demandée par la spec), les
   * suivants à la cadence PLEINE.
   */
  private startHeartbeat(intervalMs: number): void {
    this.clearHeartbeat();
    const jitter = Math.min(1, Math.max(0, this.random()));
    const premier = Math.max(0, Math.round(intervalMs * jitter));
    this.firstBeatTimer = setTimeout(() => {
      this.firstBeatTimer = null;
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
      unref(this.heartbeatTimer);
    }, premier);
    unref(this.firstBeatTimer);
  }

  private sendHeartbeat(): void {
    if (this.awaitingAck) {
      // ⚠️ Aucun ACK reçu depuis le dernier battement : connexion « zombifiée ». La doc
      // demande de terminer la connexion (code ≠ 1000/1001) puis de reprendre.
      this.derniereErreur =
        "Discord n'a pas acquitté le dernier battement : connexion interrompue, " +
        "reprise en cours.";
      this.reconnectNow(4000);
      return;
    }
    this.awaitingAck = true;
    this.send({ op: 1, d: this.sequence });
  }

  // ─── Trames sortantes ────────────────────────────────────────────────────

  private sendIdentify(): void {
    const token = this.options.token()?.trim() ?? "";
    const intents = this.demanderContent ? DISCORD_INTENTS_WITH_CONTENT : DISCORD_INTENTS_STANDARD;
    this.send({
      op: 2,
      d: {
        token,
        intents,
        properties: { os: process.platform, browser: "Yuki", device: "Yuki" },
      },
    });
  }

  private sendResume(): void {
    const token = this.options.token()?.trim() ?? "";
    this.send({
      op: 6,
      d: {
        token,
        session_id: this.sessionId,
        seq: this.sequence,
      },
    });
  }

  private send(payload: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket) return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      this.options.logger?.warn("chat.discord.ws.send_failed", { error: messageOf(error) });
    }
  }

  // ─── Coupures ───────────────────────────────────────────────────────────

  /** Fermeture reçue : décide ARRÊT NET, nouvelle session ou reprise. */
  private onClose(code: number | undefined, reason: string | undefined): void {
    this.clearHeartbeat();
    this.clearReconnectTimer();
    this.sessionReady = false;
    if (this.socket !== null) {
      try {
        this.socket.removeAllListeners?.();
      } catch {
        // Meilleur effort.
      }
    }
    this.socket = null;

    if (code !== undefined && CLOSE_FATAL.has(code)) {
      // ⚠️ ARRÊT NET : un jeton invalide ou un intent refusé ne se répare pas en
      // réessayant (et 1 000 `IDENTIFY` par jour sont comptés par Discord).
      this.abandonne = true;
      this.running = false;
      this.sessionId = undefined;
      this.sequence = null;
      this.derniereErreur =
        code === 4004
          ? "Discord a refusé le jeton du bot (fermeture 4004) : le temps réel est arrêté. " +
            "Vérifiez le jeton dans /config → Discussions, puis relancez la connexion."
          : `Discord a fermé la connexion (code ${code}${reason !== undefined && reason !== "" ? `, ${reason}` : ""}) : ` +
            "le temps réel est arrêté, aucun nouvel essai.";
      this.options.logger?.warn("chat.discord.ws.fermeture_definitive", { code });
      this.notify();
      return;
    }

    if (code === CLOSE_DISALLOWED_INTENT && this.demanderContent) {
      // ⚠️ 4014 = intent privilégié non activé côté portail. On réessaie UNE fois sans
      // lui : Yuki lit alors les messages où elle est citée (mentionnés), et le statut
      // dit EXPLICITEMENT que `MESSAGE_CONTENT` manque.
      this.demanderContent = false;
      this.intentContentManquant = true;
      // ⚠️ Un `IDENTIFY` refusé ne crée AUCUNE session : repartir en `RESUME` avec un
      // `session_id` fantôme serait refusé à son tour. On repart donc d'une session neuve.
      this.sessionId = undefined;
      this.sequence = null;
      this.resumeUrl = undefined;
      this.derniereErreur =
        `${DISCORD_INTENT_CONTENT_REASON} (Discord a fermé la connexion avec le code 4014 : ` +
        "Yuki se reconnecte SANS cet intent.)";
      this.options.logger?.warn("chat.discord.ws.intent_content_manquant", {});
      this.notify();
      this.scheduleReconnect();
      return;
    }

    this.derniereErreur ??= "Connexion temps réel interrompue : reconnexion planifiée.";
    if (!this.running) {
      this.notify();
      return;
    }
    this.scheduleReconnect();
  }

  /** Coupe court : la prochaine tentative part tout de suite (reprise). */
  private reconnectNow(code = 4000): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.removeAllListeners?.();
      } catch {
        // Meilleur effort.
      }
      try {
        socket.close(code, "reprise");
      } catch {
        try {
          socket.terminate?.();
        } catch {
          // Meilleur effort.
        }
      }
    }
    this.sessionReady = false;
    this.clearHeartbeat();
    if (!this.running) {
      this.notify();
      return;
    }
    this.scheduleReconnect(0);
  }

  /** Planifie une reconnexion avec backoff borné + gigue ; s'arrête au plafond. */
  private scheduleReconnect(forceDelayMs?: number): void {
    const maxAttempts = this.options.maxAttempts ?? 20;
    if (this.tentatives >= maxAttempts) {
      this.abandonne = true;
      this.prochainEssaiMs = undefined;
      this.derniereErreur =
        `Le temps réel Discord est arrêté après ${maxAttempts} tentatives : ` +
        "la synchronisation périodique continue de rattraper les messages.";
      this.options.logger?.warn("chat.discord.ws.abandon", { tentatives: this.tentatives });
      this.notify();
      return;
    }
    const base = this.options.baseDelayMs ?? 1_000;
    const max = this.options.maxDelayMs ?? 60_000;
    const jitter = this.options.jitterMs ?? 250;
    const delay =
      forceDelayMs ??
      Math.min(max, base * 2 ** this.tentatives) + Math.round(this.random() * jitter);
    this.tentatives += 1;
    this.prochainEssaiMs = delay;
    this.notify();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      this.open();
    }, delay);
    unref(this.reconnectTimer);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.firstBeatTimer !== null) {
      clearTimeout(this.firstBeatTimer);
      this.firstBeatTimer = null;
    }
    this.awaitingAck = false;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    this.clearReconnectTimer();
  }

  private closeSocket(code: number, reason: string): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.removeAllListeners?.();
    } catch {
      // Meilleur effort.
    }
    try {
      socket.close(code, reason);
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

/** Une minuterie ne doit pas retenir le processus en vie. */
function unref(timer: unknown): void {
  const candidate = timer as { unref?: () => void } | null;
  if (candidate && typeof candidate.unref === "function") candidate.unref();
}

/** Ajoute `v`/`encoding` à une URL de reprise (doc : « same version and encoding »). */
function withQuery(raw: string): string {
  try {
    const url = new URL(raw);
    if (!url.searchParams.has("v")) url.searchParams.set("v", "10");
    if (!url.searchParams.has("encoding")) url.searchParams.set("encoding", "json");
    return url.toString();
  } catch {
    return DISCORD_GATEWAY_URL;
  }
}
