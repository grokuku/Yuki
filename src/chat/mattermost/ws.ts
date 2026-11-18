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
 * ⚠️ RECONNEXION (corrigé le 2026-11-18) : backoff exponentiel PLAFONNÉ EN DÉLAI
 * (1 s → 60 s) avec GIGUE, compteur d'essais VISIBLE dans `status()` et JAMAIS
 * d'abandon définitif — la version précédente s'arrêtait après `maxAttempts` essais et
 * le bot restait alors « absent » jusqu'au redémarrage (symptôme exact signalé).
 *
 * ⚠️ MORT DÉTECTÉE, pas seulement SUBIE : le serveur Mattermost envoie des `ping`
 * protocolaires (~54 s, `pongWait` 60 s côté serveur, `api/v4` → `web/websocket`). Une
 * socket à moitié morte (NAT expiré, proxy, coupure réseau) ne produit AUCUN `close` :
 * sans surveillance, on attend indéfiniment un message qui n'arrivera jamais. On émet
 * donc notre propre `ping` toutes les `battementMs` et on considère la connexion morte
 * après `inactiviteMs` sans la moindre trame (message, `ping` ou `pong`).
 *
 * ⚠️ Seul un REFUS D'AUTHENTIFICATION arrête le temps réel (un jeton refusé ne se
 * répare pas en réessayant) : c'est un arrêt ASSUMÉ, dit dans l'état, et il se répare
 * en corrigeant le jeton (les plateformes à chaud reconnectent alors sans redémarrage).
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
  /**
   * `ping` PROTOCOLAIRE (facultatif : une doublure de test peut ne pas l'offrir).
   * ⚠️ C'est la seule sonde de vie disponible sans action applicative inventée : un
   * serveur Mattermost n'attend aucune action périodique du client.
   */
  ping?(data?: unknown): void;
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
  /**
   * ⚠️ Le BOT a rejoint un canal, ou un canal a été créé : sa liste de canaux a
   * changé. Sans ce signal, un canal ajouté APRÈS la synchronisation initiale
   * restait invisible jusqu'au redémarrage (cas exact signalé le 2026-11-14).
   */
  onMembership?: (kind: MattermostMembershipEvent) => void;
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
  /**
   * ⚠️ PLUS UTILISÉ : la reconnexion ne s'arrête JAMAIS (c'est le correctif du
   * 2026-11-18). Conservé uniquement pour ne pas casser les appelants existants ;
   * `status().abandonne` ne vaut plus `true` que pour un jeton REFUSÉ.
   */
  maxAttempts?: number;
  /** Délai d'attente d'authentification après l'ouverture (défaut 10 s). */
  authTimeoutMs?: number;
  /** Gigue ajoutée au backoff (défaut 250 ms). */
  jitterMs?: number;
  /** Cadence de la sonde de vie (`ping` protocolaire) — défaut 25 s. */
  battementMs?: number;
  /**
   * Inactivité TOLÉRÉE avant de déclarer la socket morte — défaut 90 s.
   * ⚠️ Doit rester SUPÉRIEUR à l'intervalle des `ping` du serveur (~54 s), sinon une
   * connexion saine serait coupée entre deux `ping`.
   */
  inactiviteMs?: number;
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
  /** Motif de la DERNIÈRE coupure (conservé après une reprise réussie), en français. */
  derniereCoupure?: string;
  /**
   * Reconnexion PROGRAMMÉE : essai + motif, pour que l'interface dise « Reconnexion en
   * cours (essai N) » au lieu d'un « absent » muet. Absent quand la connexion est saine.
   */
  reconnexion?: ReconnexionEnCours;
  /** `true` seulement pour un arrêt ASSUMÉ (jeton refusé) : plus aucune tentative. */
  abandonne: boolean;
}

const POST_EVENTS = new Set(["posted", "post_edited", "post_deleted"]);

/**
 * Événements d'ADHÉSION retenus : ils changent la liste des canaux visibles.
 * ⚠️ `added_to_channel` = le bot vient d'être ajouté (le cas de l'utilisateur) ;
 * `channel_created` = un canal neuf dans une équipe dont il est membre ;
 * `user_added_to_team` = il rejoint une équipe entière.
 */
export type MattermostMembershipEvent =
  | "added_to_channel"
  | "channel_created"
  | "user_added_to_team";

const MEMBERSHIP_EVENTS = new Set<string>([
  "added_to_channel",
  "channel_created",
  "user_added_to_team",
]);

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
  private derniereCoupure: string | undefined;
  private reconnexion: ReconnexionEnCours | undefined;
  private abandonne = false;
  /**
   * Début de la panne EN COURS (première coupure non encore réparée).
   * ⚠️ Sert à afficher « depuis 8 h 12 min » au lieu d'« essai 480 » quand le serveur reste
   * éteint toute la nuit. Remis à `undefined` dès qu'une connexion réussit.
   */
  private debutPanneMs: number | undefined;
  /** Dernière classe de motif JOURNALISÉE (évite un journal identique toutes les 60 s). */
  private derniereClasseMotif: MotifCoupure | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sonde de vie : `ping` protocolaire + détection d'inactivité. */
  private surveillanceTimer: ReturnType<typeof setInterval> | null = null;
  /** Horodatage de la dernière preuve de vie (trame, `ping` ou `pong`). */
  private derniereActiviteMs = 0;
  /**
   * Compteur `seq` des actions SANS réponse (`user_typing`).
   *
   * ⚠️ Il ne repart JAMAIS de 1 : cette valeur est réservée à l'authentification
   * (`seq_reply === 1`), et confondre les deux ferait passer une réponse de frappe pour
   * un refus de jeton.
   */
  private seqAction = 1;

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
      ...(this.derniereCoupure !== undefined ? { derniereCoupure: this.derniereCoupure } : {}),
      ...(this.reconnexion !== undefined ? { reconnexion: { ...this.reconnexion } } : {}),
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
    this.derniereCoupure = undefined;
    this.reconnexion = undefined;
    this.debutPanneMs = undefined;
    this.derniereClasseMotif = undefined;
    await this.open();
  }

  /**
   * Ferme la connexion et ANNULE toute reconnexion (idempotent).
   *
   * ⚠️ C'est ce qui distingue un arrêt VOLONTAIRE (bouton Stop, plateforme désactivée,
   * `rafraichirBot` qui détruit l'adaptateur) d'une PANNE : `running = false` fait que
   * ni `failSocket` ni le minuteur ne reprogramment quoi que ce soit.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.clearTimers();
    this.closeSocket();
    this.authentifie = false;
    this.prochainEssaiMs = undefined;
    this.reconnexion = undefined;
    this.debutPanneMs = undefined;
    this.derniereClasseMotif = undefined;
    this.notify();
  }

  /** Marque une nouvelle tentative (le polling REST reste la ceinture de sécurité). */
  private async open(): Promise<void> {
    this.prochainEssaiMs = undefined;
    this.reconnexion = undefined;
    const token = this.options.token()?.trim() ?? "";
    if (token === "") {
      // ⚠️ Le jeton est RELU à chaque tentative : une configuration corrigée pendant la
      // panne se raccroche donc toute seule. On ne s'arrête pas pour autant — « jamais
      // d'abandon définitif » vaut aussi pour une configuration incomplète.
      this.derniereCoupure =
        "Le jeton du bot Mattermost n'est pas enregistré : le temps réel ne peut pas " +
        "se connecter (la synchronisation périodique reste active).";
      this.derniereErreur = this.derniereCoupure;
      this.scheduleReconnect();
      return;
    }
    let url: string;
    try {
      url = mattermostWebSocketUrl(this.options.baseUrl());
    } catch (error) {
      // ⚠️ Le message de `mattermostApiBase` ne contient jamais le jeton.
      this.derniereCoupure = messageOf(error);
      this.derniereErreur = messageOf(error);
      this.scheduleReconnect();
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
    this.derniereActiviteMs = Date.now();
    this.notify();

    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.derniereActiviteMs = Date.now();
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
      // ⚠️ TOUTE trame est une preuve de vie, y compris celles qu'on ignore ensuite
      // (`typing`, `status_change`, réponse à `user_typing`) : la sonde de vie ne doit
      // jamais dépendre du contenu.
      this.derniereActiviteMs = Date.now();
      this.handleFrame(raw);
    });

    // ⚠️ `ping` du SERVEUR et `pong` à NOTRE `ping` : les deux comptent comme activité.
    // `ws` répond seul au `ping` protocolaire ; on écoute pour dater la preuve de vie.
    socket.on("ping", () => {
      if (this.socket !== socket) return;
      this.derniereActiviteMs = Date.now();
    });
    socket.on("pong", () => {
      if (this.socket !== socket) return;
      this.derniereActiviteMs = Date.now();
    });

    socket.on("error", (error: unknown) => {
      if (this.socket !== socket) return;
      this.derniereErreur = `Connexion temps réel en erreur (${messageOf(error)}).`;
      this.options.logger?.warn("chat.mattermost.ws.erreur", { error: messageOf(error) });
    });

    socket.on("close", (code: unknown, reason: unknown) => {
      if (this.socket !== socket) return;
      const raison = texteRaisonFermeture(reason);
      this.failSocket(socket, {
        ...(typeof code === "number" ? { code } : {}),
        ...(raison !== undefined ? { reason: raison } : {}),
      });
    });

    this.demarrerSurveillance(socket);
  }

  /**
   * Sonde de VIE : `ping` protocolaire périodique + détection d'INACTIVITÉ.
   *
   * ⚠️ C'est la seule façon de voir une socket HALF-OPEN : le TCP ne signale rien, aucun
   * `close` n'arrive, et sans cette surveillance le bot restait « absent » pour toujours
   * (le symptôme du 2026-11-18).
   */
  private demarrerSurveillance(socket: WebSocketLike): void {
    this.clearSurveillance();
    const cadence = Math.max(1_000, this.options.battementMs ?? 25_000);
    const inactivite = Math.max(cadence * 2, this.options.inactiviteMs ?? 90_000);
    this.surveillanceTimer = setInterval(() => {
      if (this.socket !== socket) return;
      const depuis = Date.now() - this.derniereActiviteMs;
      if (depuis >= inactivite) {
        const motif =
          `Aucune trame du serveur Mattermost depuis ${Math.round(depuis / 1_000)} s : ` +
          "connexion considérée morte (socket à moitié ouverte).";
        this.derniereErreur = motif;
        this.options.logger?.warn("chat.mattermost.ws.inactivite", { depuisMs: depuis });
        this.failSocket(socket, { motif });
        return;
      }
      try {
        // Sonde facultative : une doublure sans `ping` laisse la détection d'inactivité
        // jouer seule (le serveur réel, lui, envoie ses propres `ping`).
        socket.ping?.();
      } catch {
        // Socket déjà en cours de fermeture : le `close` (ou l'inactivité) tranchera.
      }
    }, cadence);
    if (typeof (this.surveillanceTimer as { unref?: () => void }).unref === "function") {
      (this.surveillanceTimer as { unref: () => void }).unref();
    }
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

    // 1. Réponse à notre `authentication_challenge` — UNIQUEMENT tant que la connexion
    // n'est pas authentifiée.
    // ⚠️ GARDE : une fois authentifié, aucune trame `status` ne concerne le jeton. Une
    // réponse `FAIL` à une autre action (`user_typing` — certains serveurs répondent
    // `seq_reply: 1` à toute action inconnue) ne doit JAMAIS faire croire à un jeton
    // refusé : cela fermerait le temps réel pour de bon. Les trames `status` sans
    // `seq_reply` reçues avant l'authentification restent traitées comme avant.
    if (
      !this.authentifie &&
      (frame.seq_reply === 1 || (frame.seq_reply === undefined && frame.status !== undefined))
    ) {
      if (frame.status === "OK") {
        this.marquerAuthentifie();
        this.options.logger?.info("chat.mattermost.ws.authentifie", {});
      } else if (frame.status === "FAIL") {
        // ⚠️ Le message d'erreur du serveur peut être anglais : on le range en
        // DETAIL, la phrase principale reste en français.
        const detail = frame.error?.id ?? frame.error?.message ?? "refus sans détail";
        this.derniereErreur =
          `Le serveur Mattermost a refusé l'authentification temps réel (${detail}). ` +
          "Vérifiez le jeton du bot.";
        this.abandonne = true; // Un jeton refusé ne se répare pas en réessayant.
        // ⚠️ Journal DÉDIÉ (et non « coupure ») : la cause est un JETON, pas le réseau. Ce
        // texte ne doit jamais être confondu avec « serveur injoignable » (cas normal).
        this.options.logger?.warn("chat.mattermost.ws.authentification_refusee", { detail });
        this.running = false;
        this.reconnexion = undefined;
        this.prochainEssaiMs = undefined;
        this.clearTimers();
        this.closeSocket();
        this.notify();
        return;
      }
    }

    // 2. Événement `hello` : confirmation implicite d'authentification.
    if (frame.event === "hello" && !this.authentifie) {
      this.marquerAuthentifie();
      return;
    }

    // 2 bis. Événements d'ADHÉSION : la liste des canaux a changé.
    const nom = typeof frame.event === "string" ? frame.event : "";
    if (MEMBERSHIP_EVENTS.has(nom)) {
      try {
        this.options.onMembership?.(nom as MattermostMembershipEvent);
      } catch (error) {
        // Un consommateur fautif ne doit pas tuer la connexion.
        this.options.logger?.warn("chat.mattermost.ws.consumer_failed", {
          error: messageOf(error),
        });
      }
      return;
    }

    // 3. Événements de POST.
    const event = nom;
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

  /**
   * Émet un événement `user_typing` (indicateur « en train d'écrire »).
   *
   * Trame vérifiée dans la spécification (`api/v4/source/websocket.yaml`, action
   * `user_typing`) : `{"action":"user_typing","seq":N,"data":{"channel_id":"…"}}`.
   * ⚠️ L'indicateur EXPIRE au bout de ~5 s côté Mattermost : c'est l'appelant
   * (`IndicateursEcriture`, `src/chat/reply/indicateur.ts`) qui le réémet.
   *
   * Rend `false` quand le temps réel n'est pas authentifié (aucune trame envoyée) :
   * l'appelant peut alors journaliser l'échec — jamais bloquer.
   */
  envoyerFrappe(channelId: string): boolean {
    const id = channelId.trim();
    if (id === "" || !this.authentifie || this.socket === null) return false;
    this.seqAction += 1;
    try {
      this.socket.send(
        JSON.stringify({
          action: "user_typing",
          seq: this.seqAction,
          data: { channel_id: id },
        }),
      );
      return true;
    } catch (error) {
      this.derniereErreur = `Émission de l'indicateur de frappe impossible (${messageOf(error)}).`;
      return false;
    }
  }

  /**
   * Authentification CONFIRMÉE (réponse `OK` ou `hello`).
   *
   * ⚠️ Remet le compteur d'essais à zéro (une connexion saine n'est pas « en échec »),
   * efface la reconnexion programmée et JOURNALISE la reprise : c'est l'événement que
   * l'utilisateur peut chercher pour savoir si son bot s'est bien reconnecté tout seul.
   */
  private marquerAuthentifie(): void {
    const essais = this.tentatives;
    this.authentifie = true;
    this.tentatives = 0;
    this.derniereErreur = undefined;
    this.reconnexion = undefined;
    this.prochainEssaiMs = undefined;
    // ⚠️ La panne est FINIE : la prochaine mesurera sa propre durée depuis zéro.
    this.debutPanneMs = undefined;
    this.derniereClasseMotif = undefined;
    this.clearAuthTimer();
    this.derniereActiviteMs = Date.now();
    this.notify();
    if (essais > 0) {
      this.options.logger?.info("chat.mattermost.ws.reconnecte", { essais });
    }
  }

  /**
   * Perte de connexion : état, puis reconnexion planifiée — INDIFFINIMENT.
   *
   * ⚠️ `fermeture` porte le code et le motif du `close` (ou la cause interne :
   * inactivité) : c'est le « motif de la dernière coupure » que l'interface affiche.
   */
  private failSocket(
    socket: WebSocketLike,
    fermeture?: { code?: number; reason?: string; motif?: string },
  ): void {
    this.clearTimers();
    this.authentifie = false;
    if (this.socket === socket) this.socket = null;
    try {
      socket.removeAllListeners?.();
    } catch {
      // Meilleur effort.
    }
    const motif = fermeture?.motif ?? this.motifDeFermeture(fermeture);
    if (motif !== undefined) {
      this.derniereCoupure = motif;
      this.derniereErreur = motif;
    }
    this.options.logger?.warn("chat.mattermost.ws.coupure", {
      ...(fermeture?.code !== undefined ? { code: fermeture.code } : {}),
      motif: motif ?? "cause inconnue",
    });
    if (!this.running) {
      this.notify();
      return;
    }
    this.scheduleReconnect();
  }

  /** Phrase française décrivant la fermeture reçue (jamais un jeton, jamais une URL). */
  private motifDeFermeture(
    fermeture?: { code?: number; reason?: string },
  ): string | undefined {
    if (fermeture?.code === undefined) return undefined;
    const raison = fermeture.reason !== undefined ? `, ${fermeture.reason}` : "";
    return `Le serveur Mattermost a fermé la connexion temps réel (code ${fermeture.code}${raison}).`;
  }

  /**
   * Planifie une reconnexion : backoff PLAFONNÉ EN DÉLAI + GIGUE, sans jamais abandonner.
   *
   * ⚠️ C'est LE correctif du 2026-11-18 : l'ancienne version s'arrêtait après
   * `maxAttempts` (20) tentatives, donc une coupure de plus d'un quart d'heure laissait le
   * bot hors ligne DÉFINITIVEMENT. Ici le délai seul est plafonné (60 s) ; le nombre
   * d'essais ne l'est pas.
   */
  private scheduleReconnect(): void {
    if (!this.running) {
      // Arrêt VOLONTAIRE pendant une tentative : aucune reconnexion ne doit survivre.
      this.reconnexion = undefined;
      this.prochainEssaiMs = undefined;
      this.notify();
      return;
    }
    const delay = delaiRelance({
      essai: this.tentatives,
      ...(this.options.baseDelayMs !== undefined ? { baseDelayMs: this.options.baseDelayMs } : {}),
      ...(this.options.maxDelayMs !== undefined ? { maxDelayMs: this.options.maxDelayMs } : {}),
      ...(this.options.jitterMs !== undefined ? { jitterMs: this.options.jitterMs } : {}),
      random: this.random,
    });
    this.tentatives += 1;
    this.prochainEssaiMs = delay;
    // ⚠️ DEPUIS QUAND ça dure : la première coupure de la panne en cours. C'est ce qui
    // permet d'écrire une DURÉE au lieu d'un numéro d'essai à trois chiffres.
    this.debutPanneMs ??= Date.now();
    const motif = this.motifDePanne();
    this.journaliserMotif(this.tentatives);
    this.reconnexion = {
      essai: this.tentatives,
      motif,
      dansMs: delay,
      depuisMs: Math.max(0, Date.now() - this.debutPanneMs),
    };
    this.derniereErreur ??= "Connexion temps réel interrompue : reconnexion planifiée.";
    this.options.logger?.warn("chat.mattermost.ws.reconnexion_planifiee", {
      essai: this.tentatives,
      dansMs: delay,
    });
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

  /**
   * Motif AFFICHABLE de la panne, honnête sur la cause.
   *
   * ⚠️ Quand le serveur est simplement éteint (`ECONNREFUSED`, réseau, `close` 1006
   * consécutif à une erreur de connexion), on l'ÉCRIT (`PHRASE_SERVEUR_INJOIGNABLE`) :
   * l'utilisateur ne doit pas chercher une panne du bot là où il n'y a qu'un serveur
   * arrêté — cas NORMAL qui se répare tout seul au retour du serveur.
   */
  private motifDePanne(): string {
    const coupure = this.derniereCoupure;
    const erreur = this.derniereErreur;
    const contexte = [coupure, erreur].filter((texte) => texte !== undefined).join(" ");
    if (classifierMotif(contexte) === "serveur_injoignable") return PHRASE_SERVEUR_INJOIGNABLE;
    // ⚠️ `derniereCoupure` d'abord : c'est la cause de CETTE panne (
    // `derniereErreur` peut décrire une tentative intermédiaire).
    return motifAffiche(coupure ?? erreur);
  }

  /**
   * Journalise la CLASSE du motif — une fois par changement, pas à chaque essai.
   *
   * ⚠️ Deux journaux distincts, à deux niveaux distincts : un serveur injoignable est
   * NORMAL (`info`, aucune alerte), un jeton refusé est une ANOMALIE À CORRIGER (`warn`).
   * Les confondre ferait chercher une panne du bot là où il n'y en a pas.
   */
  private journaliserMotif(essai: number): void {
    const contexte = [this.derniereCoupure, this.derniereErreur]
      .filter((texte) => texte !== undefined)
      .join(" ");
    const classe = classifierMotif(contexte);
    if (classe === this.derniereClasseMotif) return;
    this.derniereClasseMotif = classe;
    if (classe === "serveur_injoignable") {
      this.options.logger?.info("chat.mattermost.ws.serveur_injoignable", { essai, detail: contexte });
    } else if (classe === "authentification_refusee") {
      this.options.logger?.warn("chat.mattermost.ws.authentification_refusee", {
        essai,
        detail: contexte,
      });
    }
  }

  private clearTimers(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.clearAuthTimer();
    this.clearSurveillance();
  }

  private clearSurveillance(): void {
    if (this.surveillanceTimer !== null) {
      clearInterval(this.surveillanceTimer);
      this.surveillanceTimer = null;
    }
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
