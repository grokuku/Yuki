/**
 * Adaptateur MATTERMOST (lot 18, lot 2).
 *
 * Il assemble quatre pièces et ne fait rien d'autre :
 *  - `MattermostClient` (REST) — canaux, posts, envoi ;
 *  - `MattermostSocket` (temps réel) — `posted` / `post_edited` / `post_deleted` ;
 *  - `ChatMirrorStore` (miroir persistant) — idempotence, éditions, suppressions ;
 *  - `ChatSyncService` (orchestration) — backfill 2 semaines + rattrapage 60 s.
 *
 * ⚠️ CE QUE CET ADAPTATEUR NE FAIT PAS (limites assumées, dites dans la doc) :
 *  - aucun relais d'APPROBATION (lot 3 : les types existent, rien n'est branché) ;
 *  - aucune MÉMOIRE durable (`chat.remoteMemory` reste `desactive`) ;
 *  - aucun jeton vers un navigateur (il ne quitte jamais le serveur).
 *
 * ⚠️ ANTI-BOUCLE : un message dont l'auteur est `botUserId` ne déclenche jamais de
 * réponse. Le contrôle est fait DEUX fois — ici (avant de solliciter le générateur)
 * et dans `decideReply` (règle qui prime sur le mode) — parce qu'une boucle de
 * réponse est le seul défaut capable de saturer un canal sans intervention humaine.
 */

import { MattermostClient, type MattermostClientLogger } from "./client.js";
import { MattermostSocket, type MattermostSocketLogger } from "./ws.js";
import {
  conversationIdOfChannel,
  ingestPost,
  postToRemoteMessage,
  type IngestContext,
} from "../mirror/ingest.js";
import type { MattermostPost, MattermostUser } from "./types.js";
import { MAX_MIRRORED_CONVERSATIONS, type ChatMirrorStore } from "../mirror/store.js";
import { mirrorPlatformOf } from "../mirror.js";
import {
  DEFAULT_REPLY_MODE,
  botAliases,
  decideReply,
  type ChatReplyJudge,
} from "../reply/responder.js";
import { ChatSyncService } from "../sync/service.js";
import type { ChatSyncChannel, ChatSyncPlatform } from "../sync/platform.js";
import {
  CHAT_REPLY_MODES,
  type ChatAdapter,
  type ChatAdapterStatus,
  type ChatFetchOptions,
  type ChatFetchPage,
  type ChatOutboundMessage,
  type ChatReplyMode,
  type RemoteConversation,
  type RemoteMessage,
} from "../types.js";

/** Raison EXACTE affichée quand rien n'est configuré (jamais un « erreur »). */
export const MATTERMOST_NOT_CONFIGURED_REASON =
  "Mattermost n'est pas configuré : renseignez l'URL du serveur et le jeton du bot " +
  "dans /config → Discussions.";

/** Générateur de réponse : `transcript + message → texte` (injecté, jamais deviné). */
export type MattermostReplyGenerator = (input: {
  channelTitle: string;
  transcript: readonly RemoteMessage[];
  message: RemoteMessage;
}) => Promise<string>;

/** Ce dont l'adaptateur a besoin du reste du programme (aucun secret en dur). */
export interface MattermostAdapterDeps {
  /** URL du serveur Mattermost (lue à chaud, stockée dans `chat-mirror.json`). */
  baseUrl: () => string;
  /** Jeton du bot, lu dans le coffre à chaud. ⚠️ Jamais journalisé. */
  token: () => string | undefined;
  /** Miroir persistant (idempotence, éditions, suppressions). */
  store: ChatMirrorStore;
  logger?: MattermostClientLogger & MattermostSocketLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Fabrique de WebSocket (tests : serveur fixture local). */
  createSocket?: (url: string) => {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate?(): void;
    removeAllListeners?(): unknown;
  };
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Générateur de réponse (`undefined` ⇒ réponse NON générée, et c'est DIT). */
  generateReply?: MattermostReplyGenerator;
  /** Juge du mode `auto` (`undefined` ⇒ mode `auto` indisponible, et c'est DIT). */
  judge?: ChatReplyJudge;
  /** Nombre maximal de canaux suivis (défaut 50 : borne du miroir). */
  maxChannels?: number;
  /** Période du rattrapage REST (défaut 60 s). */
  pollIntervalMs?: number;
}

export class MattermostChatAdapter implements ChatAdapter, ChatSyncPlatform {
  readonly platform = "mattermost" as const;
  private readonly deps: MattermostAdapterDeps;
  private readonly client: MattermostClient;
  private readonly socket: MattermostSocket;
  private readonly sync: ChatSyncService;
  private readonly listeners = new Map<string, Set<(message: RemoteMessage) => void>>();
  /** Identifiants déjà jugés (`conversationId:remoteMessageId`) — borne n°2 du `auto`. */
  private readonly jugees = new Set<string>();
  private realTimeListener: ((message: RemoteMessage) => void) | null = null;
  private derniereErreur: string | undefined;
  private identite: { id: string; username?: string; displayName?: string } | null = null;
  private reponsesEnCours = 0;

  constructor(deps: MattermostAdapterDeps) {
    this.deps = deps;
    this.client = new MattermostClient({
      baseUrl: deps.baseUrl,
      token: deps.token,
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    this.socket = new MattermostSocket({
      baseUrl: deps.baseUrl,
      token: deps.token,
      onEvent: (event) => void this.onSocketEvent(event.kind, event.post),
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.createSocket ? { createSocket: deps.createSocket } : {}),
      ...(deps.random ? { random: deps.random } : {}),
    });
    this.sync = new ChatSyncService({
      platform: this,
      store: deps.store,
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
      onMessage: (message) => this.onNewMessage(message),
    });
  }

  // ─── Contrat `ChatAdapter` ────────────────────────────────────────────────

  /** Ouvre la connexion : identité, canaux, backfill, temps réel, rattrapage. */
  async connect(): Promise<void> {
    if (!this.client.isConfigured()) return;
    await this.sync.start();
    await this.socket.start();
  }

  async disconnect(): Promise<void> {
    await this.socket.stop();
    await this.sync.stop();
  }

  status(): ChatAdapterStatus {
    if (!this.client.isConfigured()) {
      return { etat: "off", raison: MATTERMOST_NOT_CONFIGURED_REASON };
    }
    const raisons: string[] = [];
    const rate = this.client.rateState();
    if (rate.ralenti) raisons.push(rate.raison ?? "Le serveur Mattermost limite le débit (429).");
    const socketStatus = this.socket.status();
    if (socketStatus.derniereErreur !== undefined) raisons.push(socketStatus.derniereErreur);
    if (this.derniereErreur !== undefined) raisons.push(this.derniereErreur);
    const synchro = this.sync.status();
    // ⚠️ « Connecté » exige l'authentification temps réel ET une synchronisation
    // démarrée : un canal suivi sans temps réel reste ◐ (« connexion »), pas ●.
    const etat = socketStatus.connecte && synchro.demarre ? "on" : "connexion";
    return {
      etat,
      ...(raisons.length > 0 ? { raison: raisons.join(" ") } : {}),
      ...(synchro.dernierContact !== undefined ? { dernierContact: synchro.dernierContact } : {}),
    };
  }

  async listConversations(): Promise<RemoteConversation[]> {
    return [...this.deps.store.conversations()];
  }

  /**
   * Page de messages d'une conversation miroir.
   *
   * Le curseur est un INDEX dans le fil du miroir (opaque pour l'appelant) : la
   * pagination d'une conversation déjà sur le disque n'interroge PAS la plateforme —
   * le miroir est la source de vérité de ce qui a été importé.
   */
  async fetchMessages(conversationId: string, options?: ChatFetchOptions): Promise<ChatFetchPage> {
    const messages = this.deps.store.messages(conversationId);
    const parsed = options?.cursor !== undefined ? Number.parseInt(options.cursor, 10) : 0;
    const from = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    const limit =
      options?.limit !== undefined && options.limit > 0 ? options.limit : messages.length;
    const slice = messages.slice(from, from + limit);
    const next = from + slice.length;
    return {
      messages: [...slice],
      ...(next < messages.length ? { cursor: String(next) } : {}),
    };
  }

  /**
   * Envoi d'un message sur le canal (`POST /api/v4/posts`).
   *
   * ⚠️ `root_id` : une réponse à un message de FIL repart DANS ce fil ; une réponse à
   * un message racine ouvre un fil SOUS lui — sans quoi le mode « répondre à tous »
   * noierait le canal.
   */
  async send(conversationId: string, message: ChatOutboundMessage): Promise<RemoteMessage> {
    const conversation = this.deps.store.conversations().find((item) => item.id === conversationId);
    if (!conversation) {
      throw new Error(
        "Ce canal distant n'existe pas dans le miroir : impossible d'y envoyer un message.",
      );
    }
    if (message.kind !== "texte") {
      // ⚠️ Le relais d'APPROBATIONS est le lot 3 : refus explicite plutôt qu'un bloc
      // incompréhensible publié dans un canal.
      throw new Error(
        "L'envoi de demandes d'approbation vers Mattermost n'est pas encore disponible " +
          "(il arrive au lot suivant).",
      );
    }
    const post = await this.client.createPost({
      channelId: conversation.remoteId,
      message: message.text,
      ...(message.threadRootId !== undefined && message.threadRootId !== ""
        ? { rootId: message.threadRootId }
        : {}),
    });
    // Le message envoyé entre dans le miroir comme n'importe quel autre : il sera
    // relu (donc affiché) et il ne déclenchera AUCUNE réponse (auteur = bot).
    const ctx = this.ingestContext(conversationId);
    ingestPost(this.deps.store, post, ctx);
    const stored = this.deps.store.message(conversationId, post.id);
    if (stored) return stored;
    return {
      remoteId: post.id,
      conversationId,
      author: {
        id: this.identite?.id ?? "bot",
        nom: this.identite?.username ?? "Yuki",
        estBot: true,
      },
      role: "assistant",
      text: message.text,
      sentAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
    };
  }

  /** Abonnement aux nouveaux messages d'UNE conversation miroir. */
  subscribe(conversationId: string, listener: (message: RemoteMessage) => void): () => void {
    const set = this.listeners.get(conversationId) ?? new Set();
    set.add(listener);
    this.listeners.set(conversationId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(conversationId);
    };
  }

  // ─── Contrat `ChatSyncPlatform` ───────────────────────────────────────────

  async identity(): Promise<{ id: string; username?: string; displayName?: string }> {
    if (this.identite !== null && this.identite.id !== "") return this.identite;
    const me = await this.client.me();
    const display = [me.first_name, me.last_name]
      .filter((part): part is string => typeof part === "string" && part.trim() !== "")
      .join(" ")
      .trim();
    this.identite = {
      id: me.id,
      ...(typeof me.username === "string" && me.username !== "" ? { username: me.username } : {}),
      ...(display !== "" ? { displayName: display } : {}),
    };
    return this.identite;
  }

  /** Canaux où Yuki est membre, toutes équipes confondues (borne 50, refus explicite). */
  async channels(): Promise<ChatSyncChannel[]> {
    const max = this.deps.maxChannels ?? MAX_MIRRORED_CONVERSATIONS;
    const teams = await this.client.teams();
    const out: ChatSyncChannel[] = [];
    const seen = new Set<string>();
    for (const team of teams) {
      if (out.length >= max) break;
      let channels;
      try {
        channels = await this.client.channelsForTeam(team.id);
      } catch {
        this.derniereErreur =
          `Les canaux de l'équipe « ${team.display_name ?? team.name ?? team.id} » ` +
          "n'ont pas pu être lus.";
        continue;
      }
      for (const channel of channels) {
        if (out.length >= max) break;
        if (seen.has(channel.id)) continue;
        // ⚠️ Les conversations DIRECTES (`D`) et de GROUPE (`G`) ne sont pas des
        // canaux : pas de titre, pas de fil — on ne les miroite pas.
        if (channel.type === "D" || channel.type === "G") continue;
        seen.add(channel.id);
        const title = (channel.display_name ?? channel.name ?? channel.id).trim();
        out.push({
          conversationId: conversationIdOfChannel(channel.id),
          plateforme: "mattermost",
          remoteId: channel.id,
          title: title !== "" ? title : channel.id,
        });
      }
    }
    return out;
  }

  /**
   * Posts créés ou MODIFIÉS depuis `since` (le serveur borne à 1 000 par appel).
   *
   * ⚠️ Les noms d'auteurs sont résolus en UN appel groupé (`POST /users/ids`), jamais
   * un appel par message : sur un backfill de 1 000 messages, la différence est un
   * bannissement pour débit.
   */
  async postsSince(
    remoteChannelId: string,
    since: string,
  ): Promise<{ messages: RemoteMessage[]; historiqueAnterieur: boolean }> {
    const sinceMs = Math.max(1, Date.parse(since) || 1);
    const page = await this.client.channelPostsSince(remoteChannelId, sinceMs);
    const conversationId = conversationIdOfChannel(remoteChannelId);
    const base = this.ingestContext(conversationId);
    const known = base.users ?? new Map<string, MattermostUser>();
    const wanted = [
      ...new Set(
        page.posts
          .map((post) => post.user_id)
          .filter((id): id is string => typeof id === "string" && id !== "" && !known.has(id)),
      ),
    ];
    let users = known;
    if (wanted.length > 0) {
      try {
        const resolved = await this.client.usersByIds(wanted);
        const map = new Map(known);
        for (const user of resolved) map.set(user.id, user);
        users = map;
      } catch (error) {
        // Les noms manqueront : les messages s'afficheront avec leur identifiant.
        this.deps.logger?.warn("chat.mattermost.users_unresolved", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const ctx: IngestContext = { ...base, users };
    return {
      messages: page.posts.map((post) => postToRemoteMessage(post, ctx)),
      // ⚠️ `hasNext` d'une lecture `since` signifie « la borne de 1 000 du serveur a
      // peut-être été atteinte ». L'API n'autorisant PAS de paginer un `since`, on
      // l'annonce : « historique antérieur non importé ».
      historiqueAnterieur: page.hasNext,
    };
  }

  subscribePosts(listener: (message: RemoteMessage) => void): () => void {
    this.realTimeListener = listener;
    return () => {
      this.realTimeListener = null;
    };
  }

  // ─── Interne ─────────────────────────────────────────────────────────────

  private ingestContext(conversationId: string): IngestContext {
    const bot = this.deps.store.bot();
    return {
      platform: "mattermost",
      conversationId,
      ...(bot.id !== undefined ? { botUserId: bot.id } : {}),
    };
  }

  /** Événement temps réel : ingestion (idempotente) puis diffusion. */
  private async onSocketEvent(
    kind: "posted" | "post_edited" | "post_deleted",
    post: MattermostPost,
  ): Promise<void> {
    const channelId = post.channel_id ?? this.channelOfPost(post.id);
    if (channelId === undefined) return;
    const conversationId = conversationIdOfChannel(channelId);
    // ⚠️ On n'ingère QUE les canaux suivis : l'événement d'un canal non miroité est
    // ignoré (sinon le miroir se remplirait de canaux que personne n'a choisis).
    if (!this.deps.store.record(conversationId)) return;
    const ctx = this.ingestContext(conversationId);
    const outcome = ingestPost(this.deps.store, post, ctx);
    if (outcome !== "insere" || kind !== "posted") return;
    const message = this.deps.store.message(conversationId, post.id);
    if (!message) return;
    // ⚠️ UN SEUL chemin : l'observateur du service de synchronisation, qui redistribue
    // (`deliver` → `onMessage`). Appeler EN PLUS `onNewMessage` ici doublerait la
    // diffusion ET la réponse (deux messages identiques publiés dans le canal).
    this.realTimeListener?.(message);
  }

  /** Canal d'un post déjà connu (les charges `post_deleted` peuvent être partielles). */
  private channelOfPost(postId: string): string | undefined {
    for (const [conversationId] of Object.entries(this.deps.store.records())) {
      if (this.deps.store.has(conversationId, postId)) {
        return this.deps.store.record(conversationId)?.remoteId;
      }
    }
    return undefined;
  }

  /** Nouveau message : diffusion aux abonnés, puis moteur de RÉPONSE. */
  private onNewMessage(message: RemoteMessage): void {
    for (const listener of this.listeners.get(message.conversationId) ?? []) {
      try {
        listener(message);
      } catch (error) {
        this.deps.logger?.warn("chat.mattermost.listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    void this.maybeReply(message);
  }

  /**
   * Décide — et seulement alors — de répondre, puis publie.
   *
   * ⚠️ Toute défaillance est VISIBLE : journal + `derniereErreur` remontée par
   * `status()`. Un échec d'envoi silencieux laisserait croire que Yuki a répondu.
   */
  private async maybeReply(message: RemoteMessage): Promise<void> {
    const record = this.deps.store.record(message.conversationId);
    if (!record) return;
    const bot = this.deps.store.bot();
    const mode = normalizeReplyMode(record.replyMode) ?? DEFAULT_REPLY_MODE;
    const decision = await decideReply({
      message,
      replyMode: mode,
      ...(bot.id !== undefined ? { botUserId: bot.id } : {}),
      aliases: botAliases({
        ...(bot.id !== undefined ? { botUserId: bot.id } : {}),
        ...(bot.username !== undefined ? { botUsername: bot.username } : {}),
        ...(this.identite?.displayName !== undefined
          ? { displayName: this.identite.displayName }
          : {}),
      }),
      channelTitle: record.title,
      ...(this.deps.judge ? { judge: this.deps.judge } : {}),
      dejaJuge: (remoteId) => this.jugees.has(`${message.conversationId}:${remoteId}`),
    });
    if (mode === "auto") {
      // ⚠️ Borne n°2 : un message n'est jugé qu'UNE fois, qu'il ait été retenu ou non.
      this.rememberJudged(message.conversationId, message.remoteId);
    }
    if (!decision.repondre) return;
    await this.produceReply(message, record.title);
  }

  /** Génère puis publie la réponse (dans le fil du message déclencheur). */
  private async produceReply(message: RemoteMessage, channelTitle: string): Promise<void> {
    if (!this.deps.generateReply) {
      this.derniereErreur =
        "Yuki ne peut pas encore RÉDIGER de réponse dans un canal distant : le générateur " +
        "de réponse n'est pas disponible (modèle léger absent). Aucun message n'a été envoyé.";
      this.deps.logger?.warn("chat.mattermost.reply.unavailable", {
        conversation: message.conversationId,
      });
      return;
    }
    this.reponsesEnCours += 1;
    try {
      const transcript = this.deps.store.messages(message.conversationId);
      const text = (await this.deps.generateReply({ channelTitle, transcript, message })).trim();
      if (text === "") {
        this.derniereErreur = "Le générateur n'a produit aucun texte : rien n'a été publié.";
        return;
      }
      const rootId =
        message.threadRootId !== undefined && message.threadRootId !== ""
          ? message.threadRootId
          : message.remoteId;
      await this.send(message.conversationId, { kind: "texte", text, threadRootId: rootId });
      this.derniereErreur = undefined;
    } catch (error) {
      // ⚠️ ÉCHEC VISIBLE : jamais silencieux.
      this.derniereErreur =
        `La réponse n'a pas pu être publiée sur Mattermost (${
          error instanceof Error ? error.message : String(error)
        }).`;
      this.deps.logger?.warn("chat.mattermost.reply.failed", {
        conversation: message.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.reponsesEnCours -= 1;
    }
  }

  /** Mémorise un identifiant jugé (mémoire bornée : on ne garde que les derniers). */
  private rememberJudged(conversationId: string, remoteId: string): void {
    this.jugees.add(`${conversationId}:${remoteId}`);
    if (this.jugees.size > 5_000) {
      const first = this.jugees.values().next();
      if (first.done !== true) this.jugees.delete(first.value);
    }
  }

  /** Nombre de réponses en cours de rédaction (mesure, tests). */
  get pendingReplies(): number {
    return this.reponsesEnCours;
  }

  /** Mode de réponse persisté d'un canal, ou `undefined`. */
  replyMode(conversationId: string): ChatReplyMode | undefined {
    return normalizeReplyMode(this.deps.store.record(conversationId)?.replyMode);
  }

  /** Démarre explicitement la synchronisation (bouton « Se connecter »). */
  async connectNow(): Promise<void> {
    await this.connect();
  }

  /** Vue de synchronisation (canaux, backfill, dernière erreur) pour l'interface. */
  syncStatus(): ReturnType<ChatSyncService["status"]> {
    return this.sync.status();
  }
}

/** Valide un mode de réponse reçu d'une interface (jamais une valeur devinée). */
export function normalizeReplyMode(value: unknown): ChatReplyMode | undefined {
  return typeof value === "string" && (CHAT_REPLY_MODES as readonly string[]).includes(value)
    ? (value as ChatReplyMode)
    : undefined;
}

/** Plateforme d'un identifiant miroir (`mm-…` ⇒ `mattermost`). */
export function isMattermostConversation(conversationId: string): boolean {
  return mirrorPlatformOf(conversationId) === "mattermost";
}
