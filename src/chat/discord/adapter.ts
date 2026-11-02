/**
 * Adaptateur DISCORD (lot 21) — même modèle que Mattermost, sans duplication.
 *
 * Il assemble quatre pièces et ne fait rien d'autre :
 *  - `DiscordClient` (REST v10) — serveurs, salons, messages, envoi, pièces jointes ;
 *  - `DiscordSocket` (passerelle v10) — `MESSAGE_CREATE` / `UPDATE` / `DELETE` ;
 *  - `ChatMirrorStore` (miroir persistant, PARTAGÉ avec Mattermost) — idempotence,
 *    éditions, suppressions ;
 *  - `ChatSyncService` (orchestration, PARTAGÉ) — backfill 14 jours + rattrapage 60 s.
 *
 * ⚠️ CE QUI N'EST **PAS** DUPLIQUÉ (et ne doit jamais l'être) : la décision de répondre
 * (`decideReply`), la composition de la réponse (`composeReply`), le choix du fil
 * (`rootIdForReply`), la politique d'outils du run distant, le prompt et le générateur.
 * Tout cela vient de `src/chat/reply/**` et de `src/llm/tool-policy.ts`, identiquement
 * pour les deux plateformes.
 *
 * ⚠️ DIFFÉRENCES ASSUMÉES AVEC MATTERMOST (dites dans `docs/lot21-chat-discord.md`) :
 *  - le défaut de `replyMode` est `mention` **par plateforme**
 *    (`defaultReplyModeFor("discord")`) : un bot qui répond à tout dans un serveur actif
 *    est insupportable, et Discord n'a pas de fil par défaut ;
 *  - Discord n'a pas de `since` : le backfill DESCEND par identifiant jusqu'à la fenêtre
 *    de 14 jours ou la borne de 1 000 messages ;
 *  - les pièces jointes entrantes portent DÉJÀ leurs métadonnées (nom, taille, type, URL) :
 *    aucun appel d'API pour les lister, et le téléchargement se fait sur le CDN, SANS le
 *    jeton du bot ;
 *  - un fil Discord n'est PAS une conversation : ses messages rejoignent la conversation
 *    du salon parent, avec le fil comme `threadRootId`.
 *
 * ⚠️ LIMITES ASSUMÉES : aucun relais d'APPROBATION (une approbation ne peut pas être
 * donnée depuis un canal), aucune MÉMOIRE durable (aucun réglage : `chat.remoteMemory` a
 * été retiré), et le backfill ne remonte pas dans les FILS (seul le temps réel y voit).
 */

import type { ChatAttachmentPort } from "../attachments.js";
import { DiscordClient, type DiscordClientLogger } from "./client.js";
import { DISCORD_INTENT_CONTENT_REASON, DiscordSocket, type DiscordSocketLogger } from "./ws.js";
import {
  conversationIdOfDiscordChannel,
  discordMessageToRemoteMessage,
  ingestDiscordMessage,
  type DiscordIngestContext,
} from "../mirror/ingest.js";
import {
  DISCORD_APP_FLAG_MESSAGE_CONTENT,
  DISCORD_APP_FLAG_MESSAGE_CONTENT_LIMITED,
  DISCORD_MAX_CONTENT_CHARS,
  DISCORD_MAX_UPLOAD_BYTES,
  isConversationChannelType,
  isThreadChannelType,
  type DiscordChannel,
  type DiscordMessage,
} from "./types.js";
import type { FileImageContent, FilesPort } from "../../files/types.js";
import {
  MAX_MIRRORED_CONVERSATIONS,
  effectiveQuoteAuthor,
  effectiveReplyStyle,
  type ChatMirrorStore,
} from "../mirror/store.js";
import {
  botAliases,
  composeReply,
  decideReply,
  defaultReplyModeFor,
  rootIdForReply,
  type ChatReplyJudge,
} from "../reply/responder.js";
import { ChatSyncService } from "../sync/service.js";
import type { ChatSyncDelivery } from "../sync/service.js";
import { ReplyLimiter } from "../reply/limiter.js";
import { ConversationSendQueue } from "../reply/send-queue.js";
// ⚠️ RAPPORT SYSTÈME (un seul rédacteur dans un canal) : mise en forme du message
// injecté et reconnaissance de l'auteur synthétique.
import { estRapportSysteme, messageRapportSysteme } from "../reply/job-report.js";
import type { ChatSyncChannel, ChatSyncPlatform } from "../sync/platform.js";
import {
  CHAT_REPLY_MODES,
  type ChatAdapter,
  type ChatAdapterStatus,
  type ChatFetchOptions,
  type ChatFetchPage,
  type ChatOutboundMessage,
  type ChatReplyGenerator,
  type ChatReplyMode,
  type ChatReplySettings,
  type ChatWakeRequest,
  type RemoteConversation,
  type RemoteMessage,
  type RemotePlatform,
} from "../types.js";

/** Plateforme de cet adaptateur (constante, jamais une chaîne recopiée). */
export const DISCORD_PLATFORM: RemotePlatform = "discord";

/** Raison EXACTE affichée quand rien n'est configuré (jamais un « erreur »). */
export const DISCORD_NOT_CONFIGURED_REASON =
  "Discord n'est pas configuré : enregistrez le jeton du bot dans " +
  "/config → Conversation → « Discussions — Discord » " +
  "(et vérifiez que l'intent MESSAGE_CONTENT est activé dans le portail développeur).";

/**
 * Avertissement affiché quand l'intent privilégié `MESSAGE_CONTENT` manque.
 *
 * ⚠️ C'est LA cause n°1 de « ça ne marche pas » : sans lui, Discord envoie bien les
 * événements, mais `content`, `attachments` et `embeds` sont VIDES (sauf si le bot est
 * cité). L'utilisateur voit un bot « connecté mais muet ».
 */
export const DISCORD_MESSAGE_CONTENT_MISSING = DISCORD_INTENT_CONTENT_REASON;

/** Ce dont l'adaptateur a besoin du reste du programme (aucun secret en dur). */
export interface DiscordAdapterDeps {
  /** Jeton du bot, lu dans le coffre à chaud. ⚠️ Jamais journalisé. */
  token: () => string | undefined;
  /** Miroir persistant (PARTAGÉ avec Mattermost : un seul fichier d'index). */
  store: ChatMirrorStore;
  /**
   * Serveur à suivre. Chaîne vide = **tous les serveurs où le bot est présent**.
   *
   * ⚠️ C'est le choix TRANCHÉ au lot 21 : un seul identifiant de serveur, vide = tous.
   * Filtrer par défaut sur un serveur aurait rendu le bot muet sans que personne ne
   * comprenne pourquoi (le réglage est vide au départ) ; tout suivre reste borné par la
   * limite de 50 canaux du miroir, et l'utilisateur peut restreindre à un serveur.
   */
  guildId?: () => string;
  logger?: DiscordClientLogger & DiscordSocketLogger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Base de l'API (tests : serveur fixture). */
  apiBase?: string;
  /** URL de la passerelle (tests : serveur fixture). */
  gatewayUrl?: string;
  /** Fabrique de WebSocket (tests : serveur fixture local). */
  createSocket?: (url: string) => {
    on(event: string, listener: (...args: unknown[]) => void): unknown;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate?(): void;
    removeAllListeners?(): unknown;
  };
  random?: () => number;
  /** Générateur de réponse (`undefined` ⇒ réponse NON générée, et c'est DIT). */
  generateReply?: ChatReplyGenerator;
  /** Juge du mode `auto` (`undefined` ⇒ mode `auto` indisponible, et c'est DIT). */
  judge?: ChatReplyJudge;
  /** STORE DES FICHIERS de Yuki (images générées à joindre). Aucun accès disque direct. */
  files?: Pick<FilesPort, "get" | "readBytes">;
  /** Borne d'envoi par fichier (octets), relue à chaque message (défaut 8 Mio). */
  maxUploadBytes?: () => number;
  /** Prépare les IMAGES des pièces jointes du message déclencheur pour le modèle. */
  readImages?: (input: {
    conversationId: string;
    message: RemoteMessage;
  }) => Promise<{ images: FileImageContent[]; notes: string[] }>;
  /** Nombre maximal de canaux suivis (défaut 50 : borne du miroir). */
  maxChannels?: number;
  /** Période du rattrapage REST (défaut 60 s). */
  pollIntervalMs?: number;
}

/**
 * Cache de pièces jointes Discord : le port ne fait QUE télécharger l'URL stockée dans le
 * miroir (les métadonnées sont fournies par le message, donc aucun appel d'API).
 *
 * ⚠️ Une URL signée peut avoir EXPIRÉ (24 h). Dans ce cas seulement, on rafraîchit le
 * message par un appel REST (`GET /channels/{salon}/messages/{id}`) et on réessaie UNE
 * fois : une image ancienne reste ainsi consultable, sans boucle.
 *
 * ⚠️ SALON DU MESSAGE, PAS LE PARENT : un message d'un FIL vit dans le salon du fil
 * (`threadRootId`, dont l'identifiant EST celui du message racine — `channel.mdx`), pas
 * dans le salon parent. Interroger le parent rendait `404` et le rafraîchissement était
 * impossible. Un message RACINE (ou une simple réponse dans un salon, `threadRootId`
 * pointant sur le message cité) reste, lui, dans le salon de la conversation.
 */
export function discordAttachmentPort(client: DiscordClient): ChatAttachmentPort {
  return {
    platform: DISCORD_PLATFORM,
    async download(fileId, request) {
      const url = request.attachment?.url;
      if (url === undefined || url === "") {
        throw new Error(
          "cette pièce jointe n'a pas d'adresse de téléchargement connue (message trop " +
            "ancien ou incomplet)",
        );
      }
      try {
        return await client.downloadAttachment(url, { maxBytes: request.maxBytes });
      } catch (error) {
        const expiré =
          error instanceof Error && "code" in error && (error as { code?: string }).code === "not_found";
        const message = request.message;
        if (!expiré || message === undefined) throw error;
        // ⚠️ Rafraîchissement UNIQUE : on redemande le message, on reprend l'URL signée.
        const refreshed = await client.message(salonDuMessage(message), message.remoteId);
        const fresh = refreshed.attachments?.find((item) => item.id === fileId)?.url;
        if (fresh === undefined || fresh === "") throw error;
        return client.downloadAttachment(fresh, { maxBytes: request.maxBytes });
      }
    },
  };
}

/**
 * SALON où vit RÉELLEMENT un message Discord.
 *
 * ⚠️ Trois cas, et un seul bon salon par cas :
 *  - message d'un FIL ⇒ le salon du fil, c'est-à-dire `threadRootId` (dont l'identifiant
 *    est celui du message racine) ;
 *  - message RACINE du fil, ou message d'un salon qui RÉPOND à un autre ⇒ le salon de la
 *    conversation (`dc-<channelId>`), pas `threadRootId` ;
 *  - sinon ⇒ le salon de la conversation.
 * Se tromper rend un `404` : le rafraîchissement échoue et la pièce jointe reste illisible.
 */
export function salonDuMessage(message: RemoteMessage): string {
  const fil = message.threadRootId;
  // Le message RACINE d'un fil porte lui-même `threadRootId === son identifiant` : il vit
  // dans le salon PARENT, pas dans le fil (un fil ne contient pas son message racine).
  if (fil !== undefined && fil !== "" && fil !== message.remoteId) return fil;
  return conversationChannelOf(message.conversationId);
}

/** Identifiant de salon d'une conversation (`dc-<id>` ⇒ `<id>`). */
function conversationChannelOf(conversationId: string): string {
  return conversationId.startsWith("dc-") ? conversationId.slice(3) : conversationId;
}

export class DiscordChatAdapter implements ChatAdapter, ChatSyncPlatform {
  readonly platform = "discord" as const;
  private readonly deps: DiscordAdapterDeps;
  private readonly client: DiscordClient;
  private readonly socket: DiscordSocket;
  private readonly sync: ChatSyncService;
  private readonly listeners = new Map<string, Set<(message: RemoteMessage) => void>>();
  /** Identifiants déjà jugés (`conversationId:remoteMessageId`) — borne n°2 du `auto`. */
  private readonly jugees = new Set<string>();
  /**
   * Parents de FILS déjà résolus (`threadId` ⇒ salon parent).
   *
   * ⚠️ Un message reçu dans un fil ne transporte PAS `parent_id` : il faut le demander
   * (`GET /channels/{thread}`), une seule fois par fil, puis le garder.
   */
  private readonly threadParents = new Map<string, string | undefined>();
  private realTimeListener: ((message: RemoteMessage) => void) | null = null;
  private derniereErreur: string | undefined;
  private derniereAvertissement: string | undefined;
  private identite: { id: string; username?: string; displayName?: string } | null = null;
  /**
   * BORNE des réponses simultanées (⚠️ elle BLOQUE, elle ne compte pas).
   *
   * Au-delà de `REPLY_MAX_CONCURRENT` rédactions en cours, les messages attendent dans
   * une file bornée ; au-delà de la file, le refus est EXPLICITE et journalisé.
   */
  /**
   * FILE D'ENVOI par conversation : **une seule publication en vol à la fois**.
   *
   * ⚠️ Deux rédactions simultanées (voulu, `REPLY_MAX_CONCURRENT`) publiaient en
   * parallèle : deux `POST` en vol, donc un ordre non garanti et, côté lecture, deux
   * messages collés (`src/chat/reply/send-queue.ts`). Les RUNS restent concurrents :
   * ce sont les ENVOIS qui sont sérialisés, conversation par conversation.
   */
  private readonly envois = new ConversationSendQueue();

  private readonly reponses: ReplyLimiter;
  /** État de l'intent privilégié, lu sur `GET /applications/@me` (jamais deviné). */
  private intentContentActif: boolean | undefined;

  constructor(deps: DiscordAdapterDeps) {
    this.deps = deps;
    // ⚠️ Construit ICI (jamais par initialisation de champ) : la borne journalise et lit
    // `deps`, qui n'est affecté qu'à l'entrée du constructeur.
    this.reponses = new ReplyLimiter({
      plateforme: DISCORD_PLATFORM,
      ...(deps.logger ? { logger: deps.logger } : {}),
    });
    this.client = new DiscordClient({
      token: deps.token,
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      ...(deps.apiBase ? { apiBase: deps.apiBase } : {}),
    });
    this.socket = new DiscordSocket({
      token: deps.token,
      onEvent: (event) => void this.onSocketEvent(event.kind, event.message),
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.createSocket ? { createSocket: deps.createSocket } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      ...(deps.gatewayUrl ? { gatewayUrl: deps.gatewayUrl } : {}),
      // ⚠️ L'identité du bot arrive par `READY` : on la mémorise sans attendre un `users/@me`.
      onReady: (ready) => {
        if (ready.userId !== undefined) {
          this.deps.store.setBot(
            { id: ready.userId, ...(ready.username !== undefined ? { username: ready.username } : {}) },
            DISCORD_PLATFORM,
          );
        }
      },
    });
    this.sync = new ChatSyncService({
      platform: this,
      store: deps.store,
      ...(deps.logger ? { logger: deps.logger } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
      onMessage: (message, delivery) => this.onNewMessage(message, delivery),
    });
  }

  /**
   * Client REST sous-jacent, exposé en LECTURE pour que le câblage partage le MÊME débit
   * (cache des pièces jointes). ⚠️ Aucun état secret relisible : le jeton n'est qu'une
   * FABRIQUE lue à chaque appel.
   */
  get rest(): DiscordClient {
    return this.client;
  }

  // ─── Contrat `ChatAdapter` ────────────────────────────────────────────────

  /** Ouvre la connexion : intent, identité, salons, backfill, temps réel, rattrapage. */
  async connect(): Promise<void> {
    if (!this.client.isConfigured()) return;
    await this.refreshIntentState();
    await this.sync.start();
    await this.socket.start();
  }

  async disconnect(): Promise<void> {
    await this.socket.stop();
    await this.sync.stop();
  }

  status(): ChatAdapterStatus {
    if (!this.client.isConfigured()) {
      return { etat: "off", raison: DISCORD_NOT_CONFIGURED_REASON };
    }
    const raisons: string[] = [];
    // ⚠️ L'INTENT d'abord : c'est la cause la plus probable d'un « bot connecté mais
    // muet », et la dire en tête évite de chercher ailleurs.
    if (this.socket.status().intentContentManquant || this.intentContentActif === false) {
      raisons.push(DISCORD_MESSAGE_CONTENT_MISSING);
    }
    const rate = this.client.rateState();
    if (rate.ralenti) raisons.push(rate.raison ?? "Discord limite le débit (429).");
    const socketStatus = this.socket.status();
    if (socketStatus.derniereErreur !== undefined) raisons.push(socketStatus.derniereErreur);
    if (this.derniereErreur !== undefined) raisons.push(this.derniereErreur);
    if (this.derniereAvertissement !== undefined) raisons.push(this.derniereAvertissement);
    const synchro = this.sync.status();
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
   * Le curseur est un INDEX dans le fil du miroir (opaque pour l'appelant) : la pagination
   * d'une conversation déjà sur le disque n'interroge PAS la plateforme.
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
   * Envoi d'un message — SÉRIALISÉ PAR CONVERSATION.
   *
   * ⚠️ Une seule publication en vol à la fois pour une même conversation : deux tours
   * simultanés ne peuvent donc pas entrelacer leurs messages (accusé, image, réponse).
   * ⚠️ La file ne change RIEN à la sémantique : les erreurs remontent à l'appelant,
   * un envoi en échec ne bloque pas les suivants.
   */
  send(conversationId: string, message: ChatOutboundMessage): Promise<RemoteMessage> {
    return this.envois.run(conversationId, () => this.envoyerMaintenant(conversationId, message));
  }

  /**
   * Envoi d'un message (`POST /channels/{id}/messages`) — hors file d'attente.
   *
   * ⚠️ `message_reference` est posé SEULEMENT quand `replyStyle = "fil"` (décision de
   * l'appelant, `rootIdForReply`) et toujours avec `fail_if_not_exists: false` : si le
   * message d'origine a disparu, la réponse part quand même.
   *
   * ⚠️ `fichiers` : identifiants du store de Yuki. Discord les accepte dans le MÊME appel
   * (multipart `files[0]`), contrairement à Mattermost (`POST /files` puis `file_ids`).
   * Un refus n'annule pas le texte : l'échec est VISIBLE (journal + `status()` + ligne
   * dans le message publié).
   */
  private async envoyerMaintenant(
    conversationId: string,
    message: ChatOutboundMessage,
  ): Promise<RemoteMessage> {
    const conversation = this.deps.store.conversations().find((item) => item.id === conversationId);
    if (!conversation) {
      throw new Error(
        "Ce canal distant n'existe pas dans le miroir : impossible d'y envoyer un message.",
      );
    }
    if (message.kind !== "texte") {
      // ⚠️ Le relais d'APPROBATIONS n'existe pas : refus explicite plutôt qu'un bloc
      // incompréhensible publié dans un canal.
      throw new Error(
        "L'envoi de demandes d'approbation vers Discord n'est pas disponible : une " +
          "approbation s'affiche dans l'interface web de Yuki, jamais dans un canal.",
      );
    }
    const pieces: Array<{ filename: string; mimeType?: string; bytes: Uint8Array }> = [];
    const echecs: string[] = [];
    const borne = Math.max(1, Math.trunc(this.deps.maxUploadBytes?.() ?? DISCORD_MAX_UPLOAD_BYTES));
    for (const fichier of message.fichiers ?? []) {
      const joint = this.lireFichier(fichier, borne);
      if (joint.ok) pieces.push(joint.file);
      else echecs.push(joint.raison);
    }
    this.derniereAvertissement =
      echecs.length > 0 ? `Pièce jointe non envoyée : ${echecs.join(" ")}` : undefined;
    const texte =
      echecs.length > 0
        ? `${message.text}${message.text.trim() === "" ? "" : "\n\n"}_(${echecs.join(" ")})_`
        : message.text;
    // ⚠️ OÙ écrire : `threadRootId` désigne la RACINE du fil. Chez Discord, un fil est un
    // SALON à part entière (son identifiant EST celui du message racine) : si on le
    // connaît (`threadParents`), on écrit DEDANS, sans `message_reference` — une réponse
    // à un message d'un autre salon serait refusée par l'API. Sinon (fil jamais vu en
    // temps réel), on répond dans le salon parent en référençant la racine, qui y vit.
    const filConnu =
      message.threadRootId !== undefined && this.threadParents.get(message.threadRootId) !== undefined
        ? message.threadRootId
        : undefined;
    const cible = filConnu ?? conversation.remoteId;
    const reference =
      filConnu === undefined && message.threadRootId !== undefined && message.threadRootId !== ""
        ? message.threadRootId
        : undefined;
    const envoye = await this.client.createMessage({
      channelId: cible,
      content: fitDiscordContent(texte),
      ...(reference !== undefined ? { replyToMessageId: reference } : {}),
      ...(pieces.length > 0 ? { files: pieces, maxFileBytes: borne } : {}),
      ...(message.kind === "texte" && message.mentionUserIds !== undefined
        ? { mentionUserIds: message.mentionUserIds }
        : {}),
    });
    // Le message envoyé entre dans le miroir comme n'importe quel autre (il sera relu,
    // donc affiché) et ne déclenchera AUCUNE réponse (auteur = bot).
    const ctx = this.ingestContext(conversationId);
    ingestDiscordMessage(this.deps.store, envoye, ctx);
    const stored = this.deps.store.message(conversationId, envoye.id);
    if (stored) return stored;
    return {
      remoteId: envoye.id,
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

  /** Lit un fichier du store Yuki et vérifie la BORNE AVANT tout appel réseau. */
  private lireFichier(
    fileId: string,
    borne: number,
  ):
    | { ok: true; file: { filename: string; mimeType?: string; bytes: Uint8Array } }
    | { ok: false; raison: string } {
    if (!this.deps.files) {
      return {
        ok: false,
        raison: "le service de fichiers de Yuki n'est pas disponible dans ce processus",
      };
    }
    const record = this.deps.files.get(fileId);
    if (!record) {
      return { ok: false, raison: `le fichier « ${fileId} » est introuvable ou expiré` };
    }
    const bytes = this.deps.files.readBytes(fileId);
    if (!bytes) {
      return { ok: false, raison: `les octets du fichier « ${record.name} » sont illisibles` };
    }
    if (bytes.length > borne) {
      // ⚠️ REFUS EXPLICITE avant tout appel réseau : jamais de troncature silencieuse.
      return {
        ok: false,
        raison:
          `« ${record.name} » (${bytes.length} octets) dépasse la borne d'envoi ` +
          `(${borne} octets)`,
      };
    }
    return {
      ok: true,
      file: {
        filename: record.name,
        ...(record.mimeType !== undefined && record.mimeType !== ""
          ? { mimeType: record.mimeType }
          : {}),
        bytes,
      },
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
    const display = typeof me.global_name === "string" ? me.global_name.trim() : "";
    this.identite = {
      id: me.id,
      ...(typeof me.username === "string" && me.username !== "" ? { username: me.username } : {}),
      ...(display !== "" ? { displayName: display } : {}),
    };
    // ⚠️ Le compte de YUKI entre dans l'annuaire des noms : sinon ses propres messages
    // s'affichaient avec son identifiant brut (même défaut que côté Mattermost).
    this.deps.store.rememberPlatformAuthorNames("discord", [
      [me.id, display !== "" ? display : typeof me.username === "string" ? me.username : me.id],
    ]);
    return this.identite;
  }

  /**
   * SALONS TEXTE des serveurs suivis (borne 50, refus explicite).
   *
   * ⚠️ Les fils (types 10/11/12) ne sont JAMAIS des conversations : `GET
   * /guilds/{id}/channels` ne les renvoie de toute façon pas, et un message reçu dans un
   * fil rejoint la conversation de son salon parent (`threadRootId`).
   */
  async channels(): Promise<ChatSyncChannel[]> {
    const max = this.deps.maxChannels ?? MAX_MIRRORED_CONVERSATIONS;
    const voulu = this.deps.guildId?.().trim() ?? "";
    let guildes;
    try {
      guildes = await this.client.guilds();
    } catch (error) {
      this.derniereErreur =
        "Les serveurs Discord du bot n'ont pas pu être lus " +
        `(${error instanceof Error ? error.message : String(error)}).`;
      throw error;
    }
    const retenues = voulu === "" ? guildes : guildes.filter((guild) => guild.id === voulu);
    if (voulu !== "" && retenues.length === 0) {
      this.derniereErreur =
        `Le serveur configuré (${voulu}) n'est pas dans la liste des serveurs du bot : ` +
        "vérifiez l'identifiant dans /config → Conversation → « Discussions — Discord ».";
    }
    const out: ChatSyncChannel[] = [];
    const seen = new Set<string>();
    for (const guilde of retenues) {
      if (out.length >= max) break;
      let salons: DiscordChannel[];
      try {
        salons = await this.client.guildChannels(guilde.id);
      } catch (error) {
        this.derniereErreur =
          `Les salons du serveur « ${guilde.name ?? guilde.id} » n'ont pas pu être lus ` +
          `(${error instanceof Error ? error.message : String(error)}).`;
        continue;
      }
      for (const salon of salons) {
        if (out.length >= max) break;
        if (seen.has(salon.id)) continue;
        // ⚠️ Catégories, salons vocaux, forums : PAS des conversations.
        if (!isConversationChannelType(salon.type)) continue;
        seen.add(salon.id);
        const titre = (salon.name ?? "").trim();
        out.push({
          conversationId: conversationIdOfDiscordChannel(salon.id),
          plateforme: DISCORD_PLATFORM,
          remoteId: salon.id,
          title: titre !== "" ? titre : salon.id,
        });
      }
    }
    if (out.length >= max) {
      // ⚠️ Borne atteinte : on le DIT (jamais une coupe silencieuse de la liste).
      this.derniereAvertissement =
        `Seuls ${max} salons sont suivis (borne du miroir) : les autres ne sont pas lus.`;
    }
    return out;
  }

  /** Messages d'un salon depuis un instant — DESCENTE par identifiant (pas de `since`). */
  async postsSince(
    remoteChannelId: string,
    since: string,
  ): Promise<{ messages: RemoteMessage[]; historiqueAnterieur: boolean }> {
    const page = await this.client.channelMessagesSince(remoteChannelId, {
      since,
      maxMessages: 1_000,
    });
    const conversationId = conversationIdOfDiscordChannel(remoteChannelId);
    const ctx = this.ingestContext(conversationId);
    // ⚠️ Aucune écriture ici : c'est la SYNCHRONISATION qui ingère (une seule fois), avec
    // l'idempotence du miroir. Écrire ici doublerait les notifications et les réponses.
    return {
      messages: page.messages.map((message) => discordMessageToRemoteMessage(message, ctx)),
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

  private ingestContext(conversationId: string, threadRootId?: string): DiscordIngestContext {
    const bot = this.deps.store.bot(DISCORD_PLATFORM);
    return {
      conversationId,
      ...(bot.id !== undefined ? { botUserId: bot.id } : {}),
      ...(threadRootId !== undefined ? { threadRootId } : {}),
    };
  }

  /** Événement temps réel : résolution du fil, ingestion (idempotente), diffusion. */
  private async onSocketEvent(
    kind: "MESSAGE_CREATE" | "MESSAGE_UPDATE" | "MESSAGE_DELETE",
    message: DiscordMessage,
  ): Promise<void> {
    const channelId = message.channel_id;
    if (channelId === undefined || channelId === "") return;
    // ⚠️ Un message posté dans un FIL arrive avec `channel_id` = identifiant du fil. On le
    // range dans la conversation du SALON PARENT, avec le fil comme `threadRootId`.
    const fil = isThreadChannelType(message.channel_type);
    const parent = fil ? await this.threadParentOf(channelId) : undefined;
    const salon = parent ?? channelId;
    const conversationId = conversationIdOfDiscordChannel(salon);
    // ⚠️ On n'ingère QUE les salons suivis (sinon le miroir se remplirait de canaux que
    // personne n'a choisis).
    if (!this.deps.store.record(conversationId)) return;
    const ctx = this.ingestContext(
      conversationId,
      fil ? channelId : message.message_reference?.message_id,
    );
    const outcome = ingestDiscordMessage(this.deps.store, message, ctx);
    if (outcome !== "insere" || kind !== "MESSAGE_CREATE") return;
    const stocke = this.deps.store.message(conversationId, message.id);
    if (!stocke) return;
    // ⚠️ UN SEUL chemin de diffusion : l'observateur du service de synchronisation.
    this.realTimeListener?.(stocke);
  }

  /**
   * Salon PARENT d'un fil (`GET /channels/{thread}`), mémorisé.
   *
   * ⚠️ Une seule requête par fil : un fil qui reçoit cent messages ne coûte qu'un appel.
   * Un échec rend `undefined` (le message est alors ignoré plutôt que rangé au hasard).
   */
  private async threadParentOf(threadId: string): Promise<string | undefined> {
    if (this.threadParents.has(threadId)) return this.threadParents.get(threadId);
    try {
      const channel = await this.client.channel(threadId);
      const parent = typeof channel.parent_id === "string" && channel.parent_id !== ""
        ? channel.parent_id
        : undefined;
      if (this.threadParents.size > 500) this.threadParents.clear();
      this.threadParents.set(threadId, parent);
      return parent;
    } catch (error) {
      this.deps.logger?.warn("chat.discord.thread_parent_failed", {
        thread: threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Lit l'état RÉEL de l'intent `MESSAGE_CONTENT` (`GET /applications/@me`).
   *
   * ⚠️ Non bloquant : un échec laisse `intentContentActif` indéterminé (le statut ne ment
   * donc pas), et le socket saura le dire autrement s'il reçoit un `4014`.
   */
  private async refreshIntentState(): Promise<void> {
    try {
      const app = await this.client.application();
      const flags = Number(app.flags ?? 0);
      if (Number.isFinite(flags)) {
        this.intentContentActif =
          (flags & DISCORD_APP_FLAG_MESSAGE_CONTENT) !== 0 ||
          (flags & DISCORD_APP_FLAG_MESSAGE_CONTENT_LIMITED) !== 0;
      }
    } catch (error) {
      this.deps.logger?.warn("chat.discord.application.unreadable", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Nouveau message : diffusion aux abonnés, puis moteur de RÉPONSE.
   *
   * ⚠️ `historique: true` (backfill) : le message est DIFFUSÉ quand même (l'interface doit
   * voir l'historique) mais `maybeReply` est SAUTÉ. Sans cette étiquette, le premier
   * branchement répondrait aux mentions des deux dernières semaines — en mode `tout`,
   * jusqu'à mille runs d'un coup.
   */
  private onNewMessage(message: RemoteMessage, delivery: ChatSyncDelivery = { historique: false }): void {
    for (const listener of this.listeners.get(message.conversationId) ?? []) {
      try {
        listener(message);
      } catch (error) {
        this.deps.logger?.warn("chat.discord.listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (delivery.historique) return;
    // ⚠️ Jamais un rejet non traité : un juge ou un store défaillant ne doit pas faire
    // tomber le processus à cause d'une réponse.
    void this.maybeReply(message).catch((error: unknown) => {
      this.deps.logger?.warn("chat.discord.reply_failed", {
        conversation: message.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** Décide — et seulement alors — de répondre, puis publie. */
  private async maybeReply(message: RemoteMessage): Promise<void> {
    const record = this.deps.store.record(message.conversationId);
    if (!record) return;
    const bot = this.deps.store.bot(DISCORD_PLATFORM);
    // ⚠️ DÉFAUT PAR PLATEFORME : `mention` pour Discord (`defaultReplyModeFor`).
    const mode = normalizeReplyMode(record.replyMode) ?? defaultReplyModeFor(DISCORD_PLATFORM);
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

  /**
   * RÉVEIL du salon par un RAPPORT SYSTÈME (fin d'une tâche d'arrière-plan).
   *
   * ⚠️ INVARIANT (`docs/lot18-chat.md`) : **dans un canal, un seul rédacteur — le
   * tour de Yuki**. Cette méthode ne publie donc RIEN elle-même : elle injecte le
   * rapport comme message déclencheur, laisse Yuki rédiger, et c'est SA réponse qui
   * part (avec les fichiers du job).
   *
   * ⚠️ Elle LÈVE quand le tour n'a rien publié (générateur absent, salon disparu,
   * modèle injoignable) : l'appelant (`src/chat/reply/channel-waker.ts`) publie alors
   * le rapport en TEXTE, en le disant — c'est le seul cas où le serveur parle.
   */
  async wakeReport(input: ChatWakeRequest): Promise<void> {
    const record = this.deps.store.record(input.conversationId);
    if (!record || record.platform !== DISCORD_PLATFORM) {
      throw new Error(
        `Le salon « ${input.conversationId} » n'est pas suivi : aucune réponse n'a pu y ` +
          "être rédigée.",
      );
    }
    const message = messageRapportSysteme({
      conversationId: input.conversationId,
      texte: input.texte,
      ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    });
    const publie = await this.produceReply(message, record.title, {
      fichiersDuJob: input.fichiers ?? [],
    });
    if (!publie) {
      throw new Error(
        this.derniereErreur ?? "le tour de rédaction n'a rien publié dans ce salon.",
      );
    }
  }

  /**
   * Génère puis publie la réponse — SOUS LA BORNE des réponses simultanées.
   *
   * ⚠️ La borne est posée ICI, pas dans `maybeReply` : c'est ce qui empêche un salon
   * actif de lancer des dizaines de runs (`generer_image` compris) en même temps.
   * Au-delà de `REPLY_MAX_CONCURRENT` rédactions, le message ATTEND dans une file bornée ;
   * au-delà de la file, le refus est JOURNALISÉ et REMONTÉ (`derniereErreur`).
   *
   * Rend `true` quand quelque chose a été PUBLIÉ : le réveil de canal en a besoin pour
   * ne pas laisser un rapport de tâche sans aucune trace (`wakeReport`).
   */
  private async produceReply(
    message: RemoteMessage,
    channelTitle: string,
    options?: { fichiersDuJob?: readonly string[] },
  ): Promise<boolean> {
    if (!this.deps.generateReply) {
      this.derniereErreur =
        "Yuki ne peut pas encore RÉDIGER de réponse dans un canal distant : le générateur " +
        "de réponse n'est pas disponible (modèle léger absent). Aucun message n'a été envoyé.";
      this.deps.logger?.warn("chat.discord.reply.unavailable", {
        conversation: message.conversationId,
      });
      return false;
    }
    const avant = this.reponses.refuseesCount;
    const publie = await this.reponses.run(() =>
      this.redigerEtPublier(message, channelTitle, options),
    );
    if (this.reponses.refuseesCount > avant) {
      this.derniereErreur =
        "Trop de réponses en attente sur ce salon : la file est pleine, un message est " +
        "resté sans réponse.";
      return false;
    }
    return publie === true;
  }

  /**
   * Rédaction + publication d'UNE réponse (appelée seulement avec une place RÉSERVÉE).
   *
   * Rend `true` quand au moins un message est PARTI dans le salon.
   */
  private async redigerEtPublier(
    message: RemoteMessage,
    channelTitle: string,
    options?: { fichiersDuJob?: readonly string[] },
  ): Promise<boolean> {
    if (!this.deps.generateReply) return false;
    // ⚠️ RAPPORT SYSTÈME : son identifiant distant n'existe PAS chez la plateforme.
    // Le référencer comme fil parent, ou le citer, produirait un message refusé.
    const rapport = estRapportSysteme(message);
    try {
      const transcript = this.deps.store.messages(message.conversationId);
      const record = this.deps.store.record(message.conversationId);
      // ⚠️ `fil` ⇒ référence le message (ou la RACINE de son fil) ; `nouveau` ⇒ aucune
      // référence, le message part à la racine du salon. Calculé AVANT le run : les
      // messages intermédiaires doivent être ancrés au MÊME message que la réponse.
      const rootId = rapport
        ? undefined
        : rootIdForReply({ replyStyle: effectiveReplyStyle(record), message });
      // ⚠️ AUCUNE MENTION sur les STATUTS (accusé, résultat d'outil, image) — décision
      // utilisateur du 2026-11-02 : un statut qui notifierait la personne à chaque outil
      // serait insupportable. L'ancrage inter-runs ne repose donc plus que sur
      // `message_reference` : c'est une LIMITE ASSUMÉE (deux runs simultanés dans le même
      // fil ne sont plus distingués par le préfixe).
      let publies = 0;
      const publier = async (intermediaire: {
        text: string;
        fichiers?: readonly string[];
      }): Promise<void> => {
        const texte = composeReply({
          text: intermediaire.text,
          message,
          quoteAuthor: "non",
        }).text;
        const fichiers = intermediaire.fichiers ?? [];
        await this.send(message.conversationId, {
          kind: "texte",
          text: texte,
          ...(rootId !== undefined ? { threadRootId: rootId } : {}),
          ...(fichiers.length > 0 ? { fichiers } : {}),
        });
        publies += 1;
      };
      const joints = this.deps.readImages
        ? await this.deps.readImages({ conversationId: message.conversationId, message })
        : { images: [], notes: [] };
      const brut = await this.deps.generateReply({
        channelTitle,
        transcript,
        message,
        ...(joints.images.length > 0 ? { images: joints.images } : {}),
        ...(joints.notes.length > 0 ? { notes: joints.notes } : {}),
        publier,
        // ⚠️ ORIGINE et FICHIERS du job : sans eux, le tour de Yuki ne sait pas d'où
        // vient le rapport et ne peut pas publier les fichiers produits.
        ...(rapport ? { origine: "job" as const } : {}),
        ...(options?.fichiersDuJob !== undefined && options.fichiersDuJob.length > 0
          ? { fichiersDuJob: options.fichiersDuJob }
          : {}),
      });
      const reponse = typeof brut === "string" ? { text: brut } : brut;
      const text = reponse.text.trim();
      if (text === "") {
        // ⚠️ Un tour qui n'a fait qu'accuser et produire une image n'a RIEN de plus à
        // dire : ce n'est pas une erreur, c'est un silence voulu.
        if (publies > 0) {
          this.derniereErreur = undefined;
          return true;
        }
        this.derniereErreur = "Le générateur n'a produit aucun texte : rien n'a été publié.";
        return false;
      }
      // ⚠️ MENTION NATIVE (`<@identifiant>`), JAMAIS une citation du texte : la plateforme
      // affiche déjà le message d'origine au-dessus de la réponse.
      // ⚠️ `mentionUserIds` est INDISPENSABLE : ce client neutralise les mentions par
      // défaut (`allowed_mentions: { parse: [] }`), donc `<@id>` ne notifierait personne.
      const compose = composeReply({
        text,
        message,
        quoteAuthor: rapport ? "non" : effectiveQuoteAuthor(record),
        platform: "discord",
        ...(this.identite?.id !== undefined ? { botUserId: this.identite.id } : {}),
      });
      const texte = compose.text;
      const fichiers = reponse.fichiers ?? [];
      await this.send(message.conversationId, {
        kind: "texte",
        text: texte,
        ...(rootId !== undefined ? { threadRootId: rootId } : {}),
        ...(fichiers.length > 0 ? { fichiers } : {}),
        ...(compose.mentionUserIds.length > 0 ? { mentionUserIds: compose.mentionUserIds } : {}),
      });
      this.derniereErreur = undefined;
      return true;
    } catch (error) {
      // ⚠️ ÉCHEC VISIBLE : jamais silencieux.
      this.derniereErreur =
        `La réponse n'a pas pu être publiée sur Discord (${
          error instanceof Error ? error.message : String(error)
        }).`;
      this.deps.logger?.warn("chat.discord.reply.failed", {
        conversation: message.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
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
    return this.reponses.enCours;
  }

  /** Mode de réponse persisté d'un canal, ou `undefined`. */
  replyMode(conversationId: string): ChatReplyMode | undefined {
    return normalizeReplyMode(this.deps.store.record(conversationId)?.replyMode);
  }

  /** Réglages de réponse EFFECTIFS d'un canal, ou `undefined` s'il est inconnu. */
  replySettings(conversationId: string): ChatReplySettings | undefined {
    const record = this.deps.store.record(conversationId);
    if (!record) return undefined;
    const mode = normalizeReplyMode(record.replyMode);
    return {
      ...(mode !== undefined ? { replyMode: mode } : {}),
      replyStyle: effectiveReplyStyle(record),
      quoteAuthor: effectiveQuoteAuthor(record),
    };
  }

  /** Démarre explicitement la synchronisation (bouton « Se connecter »). */
  async connectNow(): Promise<void> {
    await this.connect();
  }

  /** Vue de synchronisation (canaux, backfill, dernière erreur) pour l'interface. */
  syncStatus(): ReturnType<ChatSyncService["status"]> {
    return this.sync.status();
  }

  /** État CONNU de l'intent `MESSAGE_CONTENT` (`undefined` = pas encore lu). */
  messageContentIntent(): boolean | undefined {
    if (this.socket.status().intentContentManquant) return false;
    return this.intentContentActif;
  }
}

/**
 * Tronque un texte à la limite de Discord (2 000 caractères) en le DISANT.
 *
 * ⚠️ Un dépassement n'est jamais silencieux : le message publié porte la mention de
 * troncature, et l'incident est journalisé par l'appelant. Un `400` de Discord aurait, lui,
 * perdu la réponse entière.
 */
export function fitDiscordContent(text: string): string {
  const caracteres = [...text];
  if (caracteres.length <= DISCORD_MAX_CONTENT_CHARS) return text;
  const suffixe = ` [… message tronqué : limite Discord de ${DISCORD_MAX_CONTENT_CHARS} caractères]`;
  const garde = Math.max(0, DISCORD_MAX_CONTENT_CHARS - [...suffixe].length);
  return `${caracteres.slice(0, garde).join("")}${suffixe}`;
}

/** Valide un mode de réponse reçu d'une interface (jamais une valeur devinée). */
export function normalizeReplyMode(value: unknown): ChatReplyMode | undefined {
  return typeof value === "string" && (CHAT_REPLY_MODES as readonly string[]).includes(value)
    ? (value as ChatReplyMode)
    : undefined;
}
