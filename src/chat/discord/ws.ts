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
 * ⚠️ Backoff PLAFONNÉ EN DÉLAI (1 s → 60 s) avec gigue et compteur VISIBLE (`tentatives`)
 * et JAMAIS d'abandon définitif (corrigé le 2026-11-18 : l'ancienne version s'arrêtait
 * après `maxAttempts` essais, donc une coupure prolongée laissait le bot hors ligne pour
 * de bon — même symptôme que Mattermost). Le rattrapage REST périodique reste la
 * ceinture de sécurité.
 *
 * ⚠️ MORT DÉTECTÉE : sans `HEARTBEAT_ACK` (op 11) au battement suivant, la connexion est
 * « zombifiée » (half-open) ⇒ on la coupe et on reprend, comme la doc l'exige. Sans
 * `HELLO` (op 10) dans le délai imparti, la même conclusion s'impose : la socket est
 * ouverte mais la passerelle ne répond pas.
 *
 * ⚠️ Le jeton ne circule QUE dans les trames `IDENTIFY`/`RESUME`, qui vont au serveur de
 * Discord. Il n'est jamais journalisé et n'apparaît dans aucun message d'état.
 */

import { WebSocket } from "ws";

import {
  PHRASE_SERVEUR_INJOIGNABLE,
  classifierMotif,
  delaiRelance,
  motifAffiche,
  texteRaisonFermeture,
  type MotifCoupure,
  type ReconnexionEnCours,
} from "../reconnexion.js";
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
  /**
   * ⚠️ PLUS UTILISÉ : la reconnexion ne s'arrête JAMAIS (correctif du 2026-11-18).
   * Conservé pour ne pas casser les appelants existants ; `status().abandonne` ne vaut
   * plus `true` que pour un ARRÊT NET voulu par Discord (jeton refusé, intent interdit).
   */
  maxAttempts?: number;
  /** Gigue ajoutée au backoff (défaut 250 ms). */
  jitterMs?: number;
  /**
   * Délai maximal pour recevoir `HELLO` après l'ouverture (défaut 15 s).
   * ⚠️ Sans cette borne, une socket ouverte mais muette resterait en `connexion` pour
   * toujours : aucun battement n'est encore programmé avant `HELLO`.
   */
  helloTimeoutMs?: number;
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
  /** Motif de la DERNIÈRE coupure (conservé après une reprise réussie), en français. */
  derniereCoupure?: string;
  /**
   * Reconnexion PROGRAMMÉE : essai + motif, pour que l'interface dise « Reconnexion en
   * cours (essai N) » au lieu d'un « absent » muet.
   */
  reconnexion?: ReconnexionEnCours;
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
  private derniereCoupure: string | undefined;
  private reconnexion: ReconnexionEnCours | undefined;
  private abandonne = false;
  /**
   * Début de la panne EN COURS (première coupure non encore réparée).
   * ⚠️ Sert à afficher « depuis 8 h 12 min » au lieu d'« essai 480 » quand la passerelle
   * reste injoignable des heures. Remis à `undefined` dès qu'une session est prête.
   */
  private debutPanneMs: number | undefined;
  /** Dernière classe de motif JOURNALISÉE (évite un journal identique à chaque essai). */
  private derniereClasseMotif: MotifCoupure | undefined;
  private intentContentManquant = false;
  private reprise = false;
  /** Intent privilégié effectivement demandé (bascule à `false` après un 4014). */
  private demanderContent: boolean;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private firstBeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** ⚠️ Attente de `HELLO` : sans elle, une socket muette resterait « en connexion » à vie. */
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
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
      ...(this.derniereCoupure !== undefined ? { derniereCoupure: this.derniereCoupure } : {}),
      ...(this.reconnexion !== undefined ? { reconnexion: { ...this.reconnexion } } : {}),
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
    this.derniereCoupure = undefined;
    this.reconnexion = undefined;
    this.sessionId = undefined;
    this.sequence = null;
    this.resumeUrl = undefined;
    this.debutPanneMs = undefined;
    this.derniereClasseMotif = undefined;
    this.open();
  }

  /**
   * Ferme la connexion et ANNULE toute reconnexion (idempotent).
   *
   * ⚠️ `running = false` est ce qui distingue un arrêt VOLONTAIRE (bouton Stop, plateforme
   * désactivée, `rafraichirBot` qui détruit l'adaptateur) d'une panne : plus aucune
   * branche ne reprogramme quoi que ce soit.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.clearTimers();
    this.closeSocket(1000, "arret");
    this.sessionReady = false;
    this.prochainEssaiMs = undefined;
    this.reconnexion = undefined;
    this.debutPanneMs = undefined;
    this.derniereClasseMotif = undefined;
    this.notify();
  }

  // ─── Connexion ───────────────────────────────────────────────────────────

  private open(): void {
    this.prochainEssaiMs = undefined;
    this.reconnexion = undefined;
    const token = this.options.token()?.trim() ?? "";
    if (token === "") {
      // ⚠️ Le jeton est RELU à chaque tentative : un jeton enregistré pendant la panne se
      // raccroche tout seul. On ne s'arrête pas pour autant.
      this.derniereCoupure =
        "Le jeton du bot Discord n'est pas enregistré : le temps réel ne peut pas se " +
        "connecter (la synchronisation périodique reste active).";
      this.derniereErreur = this.derniereCoupure;
      this.scheduleReconnect();
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
      // ⚠️ Mais on ne l'attend pas INDÉFINIMENT : une socket ouverte et muette est morte
      // pour l'usage (aucun battement n'est programmé avant `HELLO`).
      this.surveillerHello(socket);
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
      this.onClose(
        typeof code === "number" ? code : undefined,
        texteRaisonFermeture(reason),
      );
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
        this.clearHelloTimer();
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
      case 7: {
        // `RECONNECT` : on reprend la session, sans nouvel `IDENTIFY`.
        // ⚠️ C'est une coupure DEMANDÉE par Discord : elle est mémorisée comme motif, donc
        // lisible ensuite dans l'état (l'utilisateur voit pourquoi le bot a repris).
        this.derniereCoupure = "Discord a demandé une reconnexion : reprise de la session.";
        this.derniereErreur = this.derniereCoupure;
        this.reconnectNow({ motif: this.derniereCoupure });
        return;
      }
      case 9: {
        // `INVALID_SESSION` : `d === true` ⇒ reprise possible, sinon session neuve.
        const resumable = (frame.d as boolean | undefined) === true;
        if (!resumable) {
          this.sessionId = undefined;
          this.sequence = null;
          this.resumeUrl = undefined;
          this.reprise = false;
        }
        this.derniereCoupure = resumable
          ? "Discord a invalidé la session (reprise possible) : reprise en cours."
          : "Discord a invalidé la session : nouvelle session (les événements manqués " +
            "seront rattrapés par la synchronisation périodique).";
        this.derniereErreur = this.derniereCoupure;
        this.sessionReady = false;
        this.reconnectNow({ motif: this.derniereCoupure });
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
      const essais = this.tentatives;
      this.tentatives = 0;
      this.reconnexion = undefined;
      this.prochainEssaiMs = undefined;
      // ⚠️ La panne est FINIE : la prochaine mesurera sa propre durée depuis zéro.
      this.debutPanneMs = undefined;
      this.derniereClasseMotif = undefined;
      // ⚠️ Un intent manquant reste DIT après une reconnexion réussie : sinon la cause du
      // « bot muet » disparaîtrait de l'écran au moment précis où elle explique tout.
      this.derniereErreur = this.intentContentManquant ? DISCORD_INTENT_CONTENT_REASON : undefined;
      this.notify();
      if (essais > 0) {
        this.options.logger?.info("chat.discord.ws.reconnecte", { essais });
      }
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
      const essais = this.tentatives;
      this.tentatives = 0;
      this.reconnexion = undefined;
      this.prochainEssaiMs = undefined;
      this.debutPanneMs = undefined;
      this.derniereClasseMotif = undefined;
      this.derniereErreur = this.intentContentManquant ? DISCORD_INTENT_CONTENT_REASON : undefined;
      this.notify();
      this.options.logger?.info("chat.discord.ws.reprise", { essais });
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
      // ⚠️ Aucun ACK reçu depuis le dernier battement : connexion « zombifiée » (half-open).
      // La doc demande de terminer la connexion (code ≠ 1000/1001) puis de reprendre.
      // ⚠️ On passe par le BACKOFF normal (`reconnectNow` sans forçage) : un `ack` manquant
      // qui se répète ne doit pas produire une boucle de reconnexions immédiates.
      const motif =
        "Discord n'a pas acquitté le dernier battement : connexion interrompue, " +
        "reprise en cours.";
      this.derniereCoupure = motif;
      this.derniereErreur = motif;
      this.options.logger?.warn("chat.discord.ws.battement_perdu", {});
      this.reconnectNow({ motif, code: 4000 });
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
    this.clearHelloTimer();
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
      this.reconnexion = undefined;
      this.prochainEssaiMs = undefined;
      this.derniereErreur =
        code === 4004
          ? "Discord a refusé le jeton du bot (fermeture 4004) : le temps réel est arrêté. " +
            "Vérifiez le jeton dans /config → Conversation → « Discussions — Discord », " +
            "puis relancez la connexion."
          : `Discord a fermé la connexion (code ${code}${reason !== undefined && reason !== "" ? `, ${reason}` : ""}) : ` +
            "le temps réel est arrêté, aucun nouvel essai.";
      this.derniereCoupure = this.derniereErreur;
      this.options.logger?.warn("chat.discord.ws.fermeture_definitive", { code });
      // ⚠️ Journal DÉDIÉ pour un JETON refusé : la cause est l'authentification, pas le
      // réseau. Ce texte ne doit jamais être confondu avec « serveur injoignable ».
      if (code === 4004) {
        this.options.logger?.warn("chat.discord.ws.authentification_refusee", { detail: reason });
      }
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
      this.derniereCoupure =
        "Discord a refusé l'intent privilégié MESSAGE_CONTENT (fermeture 4014) : " +
        "reconnexion SANS cet intent.";
      this.derniereErreur =
        `${DISCORD_INTENT_CONTENT_REASON} (Discord a fermé la connexion avec le code 4014 : ` +
        "Yuki se reconnecte SANS cet intent.)";
      this.options.logger?.warn("chat.discord.ws.intent_content_manquant", {});
      this.notify();
      this.scheduleReconnect();
      return;
    }

    // ⚠️ Motif de la DERNIÈRE coupure : code + raison du serveur. C'est ce que l'interface
    // affiche à côté de « Reconnexion en cours », sinon l'utilisateur ne peut rien en faire.
    const motif = this.motifDeFermeture(code, reason);
    if (motif !== undefined) {
      this.derniereCoupure = motif;
      this.derniereErreur = motif;
    }
    this.options.logger?.warn("chat.discord.ws.coupure", {
      ...(code !== undefined ? { code } : {}),
      motif: motif ?? "cause inconnue",
    });
    this.derniereErreur ??= "Connexion temps réel interrompue : reconnexion planifiée.";
    if (!this.running) {
      this.notify();
      return;
    }
    this.scheduleReconnect();
  }

  /** Phrase française décrivant la fermeture reçue (jamais un jeton, jamais une URL). */
  private motifDeFermeture(code: number | undefined, reason: string | undefined): string | undefined {
    if (code === undefined) return undefined;
    const raison = reason !== undefined && reason !== "" ? `, ${reason}` : "";
    return `Discord a fermé la connexion temps réel (code ${code}${raison}).`;
  }

  /**
   * Coupe court : la prochaine tentative part au DÉLAI DE BASE (pas au bout du backoff).
   *
   * ⚠️ Le délai n'est jamais nul : une passerelle qui redemanderait une reconnexion en
   * boucle ne doit pas produire une rafale de connexions (le compteur, lui, continue de
   * monter, donc le backoff normal reprend la main à la coupure suivante).
   */
  private reconnectNow(options: { motif?: string; code?: number } = {}): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try {
        socket.removeAllListeners?.();
      } catch {
        // Meilleur effort.
      }
      try {
        socket.close(options.code ?? 4000, "reprise");
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
    this.clearHelloTimer();
    if (options.motif !== undefined) {
      this.derniereCoupure = options.motif;
      this.derniereErreur = options.motif;
    }
    if (!this.running) {
      this.reconnexion = undefined;
      this.prochainEssaiMs = undefined;
      this.notify();
      return;
    }
    this.scheduleReconnect({ immediat: true });
  }

  /**
   * Planifie une reconnexion : backoff PLAFONNÉ EN DÉLAI + GIGUE, sans jamais abandonner.
   *
   * ⚠️ LE correctif du 2026-11-18 : l'ancienne version s'arrêtait après `maxAttempts`
   * (20) essais. Une coupure plus longue que la somme des 20 délais laissait le bot hors
   * ligne DÉFINITIVEMENT. Seul le DÉLAI est plafonné (60 s), jamais le nombre d'essais.
   */
  private scheduleReconnect(options: { immediat?: boolean } = {}): void {
    if (!this.running) {
      // Arrêt VOLONTAIRE pendant une tentative : aucune reconnexion ne doit survivre.
      this.reconnexion = undefined;
      this.prochainEssaiMs = undefined;
      this.notify();
      return;
    }
    const delay = delaiRelance({
      essai: options.immediat === true ? 0 : this.tentatives,
      ...(this.options.baseDelayMs !== undefined ? { baseDelayMs: this.options.baseDelayMs } : {}),
      ...(this.options.maxDelayMs !== undefined ? { maxDelayMs: this.options.maxDelayMs } : {}),
      ...(this.options.jitterMs !== undefined ? { jitterMs: this.options.jitterMs } : {}),
      random: this.random,
    });
    this.tentatives += 1;
    this.prochainEssaiMs = delay;
    // ⚠️ DEPUIS QUAND ça dure : la première coupure de la panne en cours.
    this.debutPanneMs ??= Date.now();
    const motif = this.motifDePanne();
    this.journaliserMotif(this.tentatives);
    this.reconnexion = {
      essai: this.tentatives,
      motif,
      dansMs: delay,
      depuisMs: Math.max(0, Date.now() - this.debutPanneMs),
    };
    this.options.logger?.warn("chat.discord.ws.reconnexion_planifiee", {
      essai: this.tentatives,
      dansMs: delay,
    });
    this.notify();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      this.open();
    }, delay);
    unref(this.reconnectTimer);
  }

  /**
   * Surveille l'arrivée de `HELLO` après l'ouverture.
   * ⚠️ Une socket ouverte mais muette (proxy qui avale les trames) resterait sinon en
   * « connexion » POUR TOUJOURS : aucun battement n'existe avant `HELLO`.
   */
  private surveillerHello(socket: WebSocketLike): void {
    this.clearHelloTimer();
    const delai = Math.max(1_000, this.options.helloTimeoutMs ?? 15_000);
    this.helloTimer = setTimeout(() => {
      this.helloTimer = null;
      if (this.socket !== socket || this.sessionReady) return;
      const motif =
        "Discord n'a pas envoyé HELLO dans le délai imparti : la connexion est " +
        "considérée morte, nouvelle tentative.";
      this.derniereCoupure = motif;
      this.derniereErreur = motif;
      this.options.logger?.warn("chat.discord.ws.hello_absent", { delaiMs: delai });
      this.reconnectNow({ motif, code: 4000 });
    }, delai);
    unref(this.helloTimer);
  }

  /**
   * Motif AFFICHABLE de la panne, honnête sur la cause.
   *
   * ⚠️ Une passerelle injoignable (erreur réseau, `close` 1006 consécutif) est DITE comme
   * telle : c'est un cas normal (serveur éteint, réseau coupé) qui se répare seul, pas une
   * panne du bot.
   */
  private motifDePanne(): string {
    const coupure = this.derniereCoupure;
    const erreur = this.derniereErreur;
    const contexte = [coupure, erreur].filter((texte) => texte !== undefined).join(" ");
    if (classifierMotif(contexte) === "serveur_injoignable") return PHRASE_SERVEUR_INJOIGNABLE;
    return motifAffiche(coupure ?? erreur);
  }

  /**
   * Journalise la CLASSE du motif — une fois par changement, pas à chaque essai.
   *
   * ⚠️ Deux journaux distincts et deux niveaux distincts : passerelle injoignable =
   * NORMAL (`info`), jeton refusé = ANOMALIE À CORRIGER (`warn`).
   */
  private journaliserMotif(essai: number): void {
    const contexte = [this.derniereCoupure, this.derniereErreur]
      .filter((texte) => texte !== undefined)
      .join(" ");
    const classe = classifierMotif(contexte);
    if (classe === this.derniereClasseMotif) return;
    this.derniereClasseMotif = classe;
    if (classe === "serveur_injoignable") {
      this.options.logger?.info("chat.discord.ws.serveur_injoignable", { essai, detail: contexte });
    } else if (classe === "authentification_refusee") {
      this.options.logger?.warn("chat.discord.ws.authentification_refusee", {
        essai,
        detail: contexte,
      });
    }
  }

  private clearHelloTimer(): void {
    if (this.helloTimer !== null) {
      clearTimeout(this.helloTimer);
      this.helloTimer = null;
    }
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
    this.clearHelloTimer();
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
