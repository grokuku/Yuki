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
 *  - aucune MÉMOIRE durable (aucun réglage : `chat.remoteMemory` a été retiré) ;
 *  - aucun jeton vers un navigateur (il ne quitte jamais le serveur).
 *
 * ⚠️ ANTI-BOUCLE : un message dont l'auteur est un ROBOT (Yuki ou un autre bot,
 * `author.estBot`) ne déclenche jamais de réponse. Le contrôle est fait DEUX fois — dans
 * `decideReply` (règle qui prime sur le mode) et par `isOwnMessage` (second filet pour un
 * message ingéré avant que le miroir ne connaisse l'identifiant du bot) — parce qu'une
 * boucle de réponse est le seul défaut capable de saturer un canal sans intervention
 * humaine.
 */

import { MattermostClient, type MattermostClientLogger } from "./client.js";
import { MattermostSocket, type MattermostSocketLogger } from "./ws.js";
import {
  authorNameOf,
  conversationIdOfChannel,
  ingestPost,
  postToRemoteMessage,
  type IngestContext,
} from "../mirror/ingest.js";
import { AUTHOR_NAME_BATCH_SIZE } from "../mirror/names.js";
import { MM_MAX_UPLOAD_BYTES, type MattermostPost, type MattermostUser } from "./types.js";
import type { FileImageContent, FilesPort } from "../../files/types.js";
import {
  MAX_MIRRORED_CONVERSATIONS,
  effectiveQuoteAuthor,
  effectiveReplyStyle,
  type ChatMirrorStore,
} from "../mirror/store.js";
import { mirrorPlatformOf } from "../mirror.js";
import { ReplyLimiter } from "../reply/limiter.js";
import { ConversationSendQueue } from "../reply/send-queue.js";
// ⚠️ RAPPORT SYSTÈME (un seul rédacteur dans un canal) : mise en forme du message
// injecté et reconnaissance de l'auteur synthétique.
import { estRapportSysteme, messageRapportSysteme } from "../reply/job-report.js";
import { isOwnMessage } from "../mirror/ingest.js";
import {
  DEFAULT_REPLY_MODE,
  botAliases,
  composeReply,
  decideReply,
  rootIdForReply,
  type ChatReplyJudge,
} from "../reply/responder.js";
import { ChatSyncService } from "../sync/service.js";
import type { ChatSyncDelivery } from "../sync/service.js";
import type { ChatSyncChannel, ChatSyncPlatform } from "../sync/platform.js";
import {
  CHAT_REPLY_MODES,
  type ChatAdapter,
  type ChatAdapterStatus,
  type ChatFetchOptions,
  type ChatFetchPage,
  type ChatOutboundMessage,
  type ChatReplyMode,
  type ChatReplySettings,
  type ChatWakeRequest,
  type RemoteConversation,
  type RemoteMessage,
} from "../types.js";

/** Raison EXACTE affichée quand rien n'est configuré (jamais un « erreur »). */
export const MATTERMOST_NOT_CONFIGURED_REASON =
  "Mattermost n'est pas configuré : renseignez l'URL du serveur et le jeton du bot " +
  "dans /config → Conversation → « Discussions — Mattermost ».";

/**
 * Générateur de réponse : `transcript + message → texte` (injecté, jamais deviné).
 *
 * ⚠️ Il peut aussi rendre des FICHIERS à joindre : le run distant peut GÉNÉRER UNE
 * IMAGE (`generer_image`), et cette image doit arriver dans le canal. Les identifiants
 * sont ceux du STORE de Yuki : l'adaptateur lève les octets par son port de fichiers,
 * les téléverse (`POST /files`) puis les attache au post (`file_ids`). La forme texte
 * nue reste acceptée (aucun fichier produit) — c'est le cas d'un message ordinaire.
 */
export type MattermostReplyGenerator = (input: {
  channelTitle: string;
  transcript: readonly RemoteMessage[];
  message: RemoteMessage;
  /**
   * IMAGES de pièces jointes du message (déjà bornées par la politique de vision).
   * ⚠️ Absent = message sans image, ou vision indisponible : le prompt reste du texte.
   */
  images?: readonly FileImageContent[];
  /**
   * Ce qui n'a PAS pu être joint (fichier non image, trop lourd, illisible) — phrases
   * françaises, transmises au rédacteur pour qu'il réponde en connaissance de cause.
   */
  notes?: readonly string[];
  /**
   * Publication INTERMÉDIAIRE (accusé, image produite, échec) — déjà ancrée au fil.
   * ⚠️ Absente ⇒ un seul message à la fin (comportement antérieur).
   */
  publier?: (message: { text: string; fichiers?: readonly string[] }) => Promise<void>;
}) => Promise<string | { text: string; fichiers?: readonly string[] }>;

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
  /**
   * ⚠️ BOT DE CET ADAPTATEUR — celui qui a reçu le message.
   *
   * C'est la SEULE source fiable : un adaptateur est construit PAR BOT
   * (`AdaptateursChatBots.creer(jeton)`), donc il sait à qui il appartient. Déduire
   * le bot de la conversation retombait sur le bot du run tant qu'aucun canal n'avait
   * publié (bug du 2026-11-14 : Mattermost ET Discord répondaient « je suis Yuki »).
   */
  botId?: string;
  /** Juge du mode `auto` (`undefined` ⇒ mode `auto` indisponible, et c'est DIT). */
  judge?: ChatReplyJudge;
  /**
   * STORE DES FICHIERS de Yuki — sert à JOINDRE une image (ou un fichier) à un message
   * publié. ⚠️ Aucun accès disque direct : uniquement `get`/`readBytes`.
   */
  files?: Pick<FilesPort, "get" | "readBytes">;
  /** Borne d'envoi par fichier (octets), relue à chaque message (défaut 100 Mo). */
  maxUploadBytes?: () => number;
  /**
   * Borne d'un MESSAGE publié (caractères), relue à chaque envoi.
   *
   * ⚠️ Mattermost REFUSE (`400`) un message plus long que `ServiceSettings.MaxPostSize`
   * — et le POST entier est perdu, donc la réponse entière. Le défaut est prudent
   * (16 383 caractères, valeur par défaut du serveur) ; une instance configurée autrement
   * peut être desserrée en injectant cette fabrique.
   */
  maxPostChars?: () => number;
  /**
   * Prépare les IMAGES des pièces jointes du message déclencheur pour le modèle.
   *
   * ⚠️ Injecté par le câblage (cache + politique de vision partagée). Absent ⇒ aucune
   * image n'est transmise, et ce n'est pas une erreur : un message texte n'en a pas.
   */
  readImages?: (input: {
    conversationId: string;
    message: RemoteMessage;
  }) => Promise<{ images: FileImageContent[]; notes: string[] }>;
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
  /**
   * AVERTISSEMENT du dernier envoi (pièce jointe refusée), distinct de `derniereErreur` :
   * un échec d'upload ne fait PAS échouer la réponse, et il ne doit pas être effacé par
   * le succès du texte qui, lui, est bien parti.
   */
  private derniereAvertissement: string | undefined;
  private identite: { id: string; username?: string; displayName?: string } | null = null;
  /**
   * ⚠️ AVERTISSEMENT DE DÉCOUVERTE ("ce bot ne voit aucun canal"), distinct d'une
   * erreur : la connexion a réussi, mais l'équipe ne contient aucun canal où le
   * bot soit membre. Sans ce champ, la liste restait VIDE et MUETTE (symptôme
   * signalé le 2026-11-14 : « le canal n'apparaît pas dans l'interface web »).
   */
  private avertissementCanaux: string | undefined;
  /**
   * ⚠️ RESYNCHRONISATION DEMANDÉE PAR LE TEMPS RÉEL (adhésion à un canal).
   *
   * Coalescée : Mattermost émet plusieurs événements d'affilée quand un bot rejoint
   * un canal, et `backfillAll` interroge l'API. On regroupe donc dans une fenêtre
   * courte, et on ne superpose jamais deux résynchronisations.
   */
  private resynchronisationPlanifiee: ReturnType<typeof setTimeout> | null = null;
  private resynchronisationEnCours = false;
  /**
   * Identifiants d'auteurs DÉJÀ demandés à `POST /users/ids` (succès comme « inconnu »).
   *
   * ⚠️ C'est le CACHE de résolution : un second message du même auteur ne doit produire
   * AUCUN appel réseau. Un lot en ÉCHEC est retiré de cet ensemble (on réessaiera), un
   * utilisateur supprimé y reste (le serveur a répondu, il n'existe plus).
   */
  private readonly nomsDemandes = new Set<string>();
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

  constructor(deps: MattermostAdapterDeps) {
    this.deps = deps;
    // ⚠️ Construit ICI (jamais par initialisation de champ) : la borne journalise et lit
    // `deps`, qui n'est affecté qu'à l'entrée du constructeur.
    this.reponses = new ReplyLimiter({
      plateforme: "mattermost",
      ...(deps.logger ? { logger: deps.logger } : {}),
    });
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
      // ⚠️ ADHÉSION : le bot rejoint un canal (ou une équipe) ⇒ la liste des canaux
      // a changé. On ré-énumère, sinon le canal reste invisible jusqu'au redémarrage.
      onMembership: () => this.planifierResynchronisation(),
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
      onMessage: (message, delivery) => this.onNewMessage(message, delivery),
    });
  }

  /**
   * Client REST sous-jacent, exposé en LECTURE pour que le câblage partage le MÊME débit
   * (téléchargement des pièces jointes). ⚠️ Il ne porte aucun état secret relisible : le
   * jeton n'est qu'une FABRIQUE lue à chaque appel, jamais une valeur stockée ici.
   */
  get rest(): MattermostClient {
    return this.client;
  }

  // ─── Contrat `ChatAdapter` ────────────────────────────────────────────────

  /** Ouvre la connexion : identité, canaux, backfill, temps réel, rattrapage. */
  async connect(): Promise<void> {
    if (!this.client.isConfigured()) return;
    await this.sync.start();
    await this.socket.start();
    // ⚠️ RATTRAPAGE DES NOMS (indépendant de la connexion) : les messages ingérés AVANT
    // la résolution portent l'identifiant de leur auteur. On complète l'annuaire une
    // fois, en arrière-plan, sans jamais retarder le temps réel ni réécrire le miroir.
    void this.rattraperNoms().catch((error: unknown) => {
      this.deps.logger?.warn("chat.mattermost.names_catchup_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async disconnect(): Promise<void> {
    if (this.resynchronisationPlanifiee !== null) {
      clearTimeout(this.resynchronisationPlanifiee);
      this.resynchronisationPlanifiee = null;
    }
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
    if (this.derniereAvertissement !== undefined) raisons.push(this.derniereAvertissement);
    if (this.avertissementCanaux !== undefined) raisons.push(this.avertissementCanaux);
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
   * Envoi d'un message sur le canal (`POST /api/v4/posts`) — hors file d'attente.
   *
   * ⚠️ `root_id` : c'est l'APPELANT qui le choisit (`rootIdForReply`, selon `replyStyle`
   * du canal). Une réponse à un message racine ouvre un fil SOUS lui — sans quoi le mode
   * « répondre à tous » noierait le canal — et un fil existant repart de SA RACINE.
   *
   * ⚠️ `fichiers` : identifiants du store de Yuki. Chacun est téléversé AVANT le post
   * (`POST /files`), puis attaché par `file_ids`. Un refus n'annule pas le texte.
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
      // ⚠️ Le relais d'APPROBATIONS est le lot 3 : refus explicite plutôt qu'un bloc
      // incompréhensible publié dans un canal.
      throw new Error(
        "L'envoi de demandes d'approbation vers Mattermost n'est pas encore disponible " +
          "(il arrive au lot suivant).",
      );
    }
    // ⚠️ PIÈCES JOINTES : `POST /files` (une par fichier) PUIS `POST /posts` avec
    // `file_ids`. Un fichier refusé n'empêche PAS le texte de partir — mais l'échec est
    // VISIBLE (journal + raison remontée par `status()` + ligne dans le message publié),
    // parce que la personne qui a demandé l'image doit savoir qu'elle n'arrive pas.
    const fileIds: string[] = [];
    const echecs: string[] = [];
    for (const fichier of message.fichiers ?? []) {
      const joint = await this.joindreFichier(conversation.remoteId, fichier);
      if (joint.ok) fileIds.push(joint.id);
      else echecs.push(joint.raison);
    }
    // ⚠️ AVERTISSEMENTS, pas une erreur : le texte part quand même. Champ SÉPARÉ pour
    // qu'un envoi réussi de la réponse n'efface pas silencieusement ces incidents.
    const avertissements: string[] = [];
    if (echecs.length > 0) avertissements.push(`Pièce jointe non envoyée : ${echecs.join(" ")}`);
    const complet =
      echecs.length > 0
        ? `${message.text}${message.text.trim() === "" ? "" : "\n\n"}_(${echecs.join(" ")})_`
        : message.text;
    // ⚠️ BORNE D'ENVOI, SYMÉTRIQUE de Discord : Mattermost répond `400` à un message plus
    // long que `MaxPostSize`, et le POST entier est perdu — donc la réponse entière. On
    // tronque donc AVANT l'appel, et on le DIT (suffixe + avertissement + journal).
    const borne = Math.max(1, Math.trunc(this.deps.maxPostChars?.() ?? MM_DEFAULT_MAX_POST_CHARS));
    const { texte, tronque } = fitMattermostContent(complet, borne);
    if (tronque) {
      avertissements.push(`Réponse tronquée à ${borne} caractères (limite du serveur Mattermost).`);
      this.deps.logger?.warn("chat.mattermost.reply.truncated", {
        conversation: conversationId,
        limite: borne,
        longueur: [...complet].length,
      });
    }
    this.derniereAvertissement =
      avertissements.length > 0 ? avertissements.join(" ") : undefined;
    const post = await this.client.createPost({
      channelId: conversation.remoteId,
      message: texte,
      ...(message.threadRootId !== undefined && message.threadRootId !== ""
        ? { rootId: message.threadRootId }
        : {}),
      ...(fileIds.length > 0 ? { fileIds } : {}),
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
      text: texte,
      sentAt: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
    };
  }

  /**
   * Téléverse UN fichier du store Yuki vers Mattermost et rend son `file_id`.
   *
   * ⚠️ ÉCHEC NON FATAL : un refus rend une RAISON en français (jamais un jeton, jamais un
   * chemin disque). L'appelant publie quand même le texte et signale l'échec.
   */
  private async joindreFichier(
    channelId: string,
    fileId: string,
  ): Promise<{ ok: true; id: string } | { ok: false; raison: string }> {
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
    const borne = Math.max(1, Math.trunc(this.deps.maxUploadBytes?.() ?? MM_MAX_UPLOAD_BYTES));
    if (bytes.length > borne) {
      // ⚠️ REFUS EXPLICITE avant tout appel réseau : jamais de troncature silencieuse.
      return {
        ok: false,
        raison:
          `« ${record.name} » (${bytes.length} octets) dépasse la borne d'envoi ` +
          `(${borne} octets)`,
      };
    }
    try {
      const info = await this.client.uploadFile({
        channelId,
        filename: record.name,
        mimeType: record.mimeType,
        bytes,
        maxBytes: borne,
      });
      return { ok: true, id: info.id };
    } catch (error) {
      // ⚠️ Le message d'erreur du client ne contient NI jeton NI URL complète.
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger?.warn("chat.mattermost.upload.failed", {
        file: fileId,
        bytes: bytes.length,
        error: message,
      });
      return { ok: false, raison: `« ${record.name} » n'a pas pu être envoyé (${message})` };
    }
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
    // ⚠️ Le compte de YUKI entre aussi dans l'annuaire : sans cela, les messages qu'elle
    // publie elle-même s'affichaient avec l'identifiant brut du bot dans le fil.
    this.deps.store.rememberPlatformAuthorNames("mattermost", [[me.id, authorNameOf(me, me.id)]]);
    return this.identite;
  }

  /** Canaux où Yuki est membre, toutes équipes confondues (borne 50, refus explicite). */
  async channels(): Promise<ChatSyncChannel[]> {
    const max = this.deps.maxChannels ?? MAX_MIRRORED_CONVERSATIONS;
    const teams = await this.client.teams();
    if (teams.length === 0) {
      // ⚠️ UN FAIT DIT, JAMAIS UNE LISTE VIDE MUETTE : un compte sans équipe ne
      // verra aucun canal, et l'utilisateur doit pouvoir le constater.
      this.avertissementCanaux =
        "Ce bot n'appartient à AUCUNE équipe sur ce serveur : il ne peut voir aucun canal.";
    }
    const out: ChatSyncChannel[] =
      [];
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
    // ⚠️ ZÉRO CANAL APRÈS AVOIR INTERROGÉ LES ÉQUIPES : ce n'est pas « rien à
    // importer », c'est « ce bot n'est membre d'aucun canal » — on le DIT (et le
    // message est remonté par `status().raison`, donc visible dans l'interface).
    if (out.length === 0 && this.avertissementCanaux === undefined) {
      this.avertissementCanaux =
        "Ce bot ne voit aucun canal : vérifiez qu'il a bien été ajouté à un canal " +
        "de l'équipe (Mattermost → équipe → Ajouter des membres).";
      this.deps.logger?.warn("chat.mattermost.aucun_canal", {
        equipes: teams.length,
        bot: this.deps.store.bot().username ?? this.deps.store.bot().id ?? "inconnu",
      });
    }
    if (out.length > 0) this.avertissementCanaux = undefined;
    return out;
  }

  /**
   * RESYNCHRONISE la découverte des canaux SANS fermer le temps réel.
   *
   * ⚠️ CAS COUVERT : un canal où le bot vient d'être ajouté. Le backfill initial
   * n'énumère les canaux qu'une fois ; sans ce point d'entrée, le canal restait
   * absent tant que le processus n'avait pas redémarré. `sync.start()` est
   * idempotent (`backfillAll` saute les canaux déjà importés : coût nul pour les
   * autres) et c'est lui qui crée les conversations manquantes dans le miroir.
   */
  async resynchroniser(): Promise<void> {
    if (!this.client.isConfigured()) return;
    if (this.resynchronisationEnCours) return;
    this.resynchronisationEnCours = true;
    try {
      await this.sync.start();
      this.deps.logger?.info("chat.mattermost.resynchronisee", {
        canaux: this.deps.store.conversations().length,
      });
    } finally {
      this.resynchronisationEnCours = false;
    }
  }

  /**
   * Resynchronisation DIFFÉRÉE et COALESCÉE, déclenchée par le temps réel (adhésion).
   * ⚠️ Elle ne ferme ni le WebSocket ni la synchronisation : `backfillAll` saute les
   * canaux déjà importés, seuls les nouveaux sont ajoutés au miroir.
   */
  planifierResynchronisation(delaiMs = RESYNC_DEBOUNCE_MS): void {
    if (this.resynchronisationPlanifiee !== null) return;
    const handle = setTimeout(() => {
      this.resynchronisationPlanifiee = null;
      void this.resynchroniser().catch((error: unknown) => {
        this.deps.logger?.warn("chat.mattermost.resynchronisation_echec", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, delaiMs);
    (handle as { unref?: () => void }).unref?.();
    this.resynchronisationPlanifiee = handle;
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
    // ⚠️ La résolution précède la CONVERSION : sans elle, `authorOf` écrit l'identifiant
    // brut dans `nom` (c'était exactement le défaut de production : un auteur affiché
    // « g68qpnp8pykm89pj3eqn1khhe »).
    const users = await this.resoudreAuteurs(
      page.posts.map((post) => post.user_id),
      conversationId,
    );
    // ⚠️ Le contexte est construit APRÈS la résolution : il porte donc les noms fraîchement
    // appris (`ingestContext` lit l'annuaire).
    const ctx: IngestContext = { ...this.ingestContext(conversationId), users };
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
      // ⚠️ Les noms DÉJÀ connus entrent dans l'ingestion : un message dont l'auteur a
      // été résolu une fois est écrit AVEC son nom, sans appel réseau.
      names: this.deps.store.authorNamesOf(conversationId),
    };
  }

  /**
   * Résout des identifiants d'auteurs en LOTS BORNÉS, avec cache (`nomsDemandes`).
   *
   * ⚠️ Trois règles, chacune pour une raison mesurable :
   *  1. un identifiant dont l'ANNUAIRE connaît le nom ne provoque AUCUN appel (sinon un
   *     canal actif ferait un `POST /users/ids` par message) ;
   *  2. les identifiants sont groupés par `AUTHOR_NAME_BATCH_SIZE` (50) : au-delà, on
   *     fragmente la requête et on s'expose au `429` de l'instance ;
   *  3. un lot en ÉCHEC ne condamne pas l'auteur : il est retiré du cache pour être
   *     redemandé (un utilisateur SUPPRIMÉ, lui, reste inconnu : le serveur a répondu).
   *
   * Rend les utilisateurs résolus (l'appelant s'en sert pour `estBot`, que l'annuaire
   * ne porte pas).
   */
  private async resoudreAuteurs(
    ids: readonly (string | undefined)[],
    conversationId: string,
  ): Promise<Map<string, MattermostUser>> {
    const out = new Map<string, MattermostUser>();
    const wanted: string[] = [];
    for (const id of new Set(ids)) {
      if (typeof id !== "string" || id === "" || id === "inconnu") continue;
      if (this.nomsDemandes.has(id)) continue;
      // Nom DÉJÀ connu (annuaire persistant) : aucun appel réseau.
      if (this.deps.store.authorName(conversationId, id) !== undefined) continue;
      wanted.push(id);
    }
    for (let index = 0; index < wanted.length; index += AUTHOR_NAME_BATCH_SIZE) {
      const lot = wanted.slice(index, index + AUTHOR_NAME_BATCH_SIZE);
      // ⚠️ Marqués AVANT l'appel : deux événements simultanés du même auteur ne
      // produisent pas deux requêtes identiques.
      for (const id of lot) this.nomsDemandes.add(id);
      try {
        const users = await this.client.usersByIds(lot);
        for (const user of users) out.set(user.id, user);
        // Les noms sont PERSISTÉS (annuaire) : les entrées déjà écrites dans le miroir
        // deviennent lisibles à la LECTURE, sans réécrire le `.jsonl`.
        this.deps.store.rememberAuthorNames(
          conversationId,
          users.map((user) => [user.id, authorNameOf(user, user.id)] as const),
        );
      } catch (error) {
        // Les noms manqueront POUR L'INSTANT : le message s'affichera avec la forme
        // courte de l'identifiant, et le nom sera redemandé au prochain message.
        for (const id of lot) this.nomsDemandes.delete(id);
        this.deps.logger?.warn("chat.mattermost.users_unresolved", {
          conversation: conversationId,
          demandes: lot.length,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out;
  }

  /**
   * RATTRAPE les noms des auteurs DÉJÀ présents dans le miroir (messages anciens).
   *
   * ⚠️ Borné par canal (`AUTHOR_NAME_BATCH_SIZE` identifiants) : un canal de 20 000
   * messages ne déclenche pas 400 requêtes au démarrage. Les auteurs non traités cette
   * fois seront résolus dès qu'ils écriront (chemin temps réel) ou au prochain
   * démarrage — et leur affichage reste lisible entre-temps (forme courte).
   */
  private async rattraperNoms(): Promise<void> {
    if (!this.client.isConfigured()) return;
    for (const [conversationId, record] of Object.entries(this.deps.store.records())) {
      if (record.platform !== "mattermost") continue;
      const ids = this.deps.store.authorIdsWithoutName(conversationId, AUTHOR_NAME_BATCH_SIZE);
      if (ids.length === 0) continue;
      await this.resoudreAuteurs(ids, conversationId);
    }
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
    // ⚠️ CAUSE DU DÉFAUT DE PRODUCTION (2026-11-02) : ce chemin n'avait AUCUNE table
    // d'utilisateurs — le message était donc ingéré avec l'identifiant de son auteur dans
    // `nom`, et l'interface affichait « g68pqnp8pykm89pj3eqn1khhe ». La résolution est
    // faite ICI, AVANT l'écriture, et elle est attendue (un appel groupé au premier
    // message d'un auteur, ZÉRO ensuite grâce à l'annuaire).
    const users = await this.resoudreAuteurs([post.user_id], conversationId);
    const ctx: IngestContext = { ...this.ingestContext(conversationId), users };
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
        this.deps.logger?.warn("chat.mattermost.listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (delivery.historique) return;
    // ⚠️ Jamais un rejet non traité : un juge ou un store défaillant ne doit pas faire
    // tomber le processus à cause d'une réponse.
    void this.maybeReply(message).catch((error: unknown) => {
      this.deps.logger?.warn("chat.mattermost.reply_failed", {
        conversation: message.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * RÉVEIL du canal par un RAPPORT SYSTÈME (fin d'une tâche d'arrière-plan).
   *
   * ⚠️ INVARIANT (`docs/lot18-chat.md`) : **dans un canal, un seul rédacteur — le
   * tour de Yuki**. Cette méthode ne publie donc RIEN elle-même : elle injecte le
   * rapport comme message déclencheur, laisse Yuki rédiger, et c'est SA réponse qui
   * part (avec les fichiers du job).
   *
   * ⚠️ Elle LÈVE quand le tour n'a rien publié (générateur absent, canal disparu,
   * modèle injoignable) : l'appelant (`src/chat/reply/channel-waker.ts`) publie alors
   * le rapport en TEXTE, en le disant — c'est le seul cas où le serveur parle.
   */
  async wakeReport(input: ChatWakeRequest): Promise<void> {
    const record = this.deps.store.record(input.conversationId);
    if (!record || record.platform !== "mattermost") {
      throw new Error(
        `Le canal « ${input.conversationId} » n'est pas suivi : aucune réponse n'a pu y ` +
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
        this.derniereErreur ?? "le tour de rédaction n'a rien publié dans ce canal.",
      );
    }
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
      // ⚠️ Le bot qui a REÇU ce message : il sert au juge (sa question nomme CE bot).
      ...(this.deps.botId !== undefined ? { botId: this.deps.botId } : {}),
      // ⚠️ PREUVE D'ADRESSE AVANT LE JUGE (2026-11-14) : les noms NUS du bot
      // (pseudo, nom affiché) sont cherchés comme des MOTS dans le texte, et une
      // réponse de fil à un de ses messages compte comme une adresse. Dans les deux
      // cas on répond DIRECTEMENT, sans appel au modèle juge.
      botNames: this.nomsNusDuBot(bot.username),
      repondAuBot: (candidat) => this.repondAUnMessageDuBot(candidat, bot.id),
      ...(this.deps.logger
        ? {
            logger: {
              info: (evenement: string, champs?: Record<string, unknown>) =>
                this.deps.logger?.info(evenement, champs),
              warn: (evenement: string, champs?: Record<string, unknown>) =>
                this.deps.logger?.warn(evenement, champs),
            },
          }
        : {}),
    });
    if (mode === "auto") {
      // ⚠️ Borne n°2 : un message n'est jugé qu'UNE fois, qu'il ait été retenu ou non.
      this.rememberJudged(message.conversationId, message.remoteId);
    }
    if (!decision.repondre) return;
    await this.produceReply(message, record.title);
  }

  /**
   * Génère puis publie la réponse — SOUS LA BORNE des réponses simultanées.
   *
   * ⚠️ La borne est posée ICI, pas dans `maybeReply` : c'est ce qui empêche un canal
   * actif de lancer des dizaines de runs (`generer_image` compris) en même temps.
   * Au-delà de `REPLY_MAX_CONCURRENT` rédactions, le message ATTEND dans une file bornée ;
   * au-delà de la file, le refus est JOURNALISÉ et REMONTÉ (`derniereErreur`) — jamais un
   * silence.
   *
   * Rend `true` quand quelque chose a été PUBLIÉ (réponse ou message intermédiaire),
   * `false` sinon : le réveil de canal a besoin de le savoir pour ne pas laisser un
   * rapport de tâche sans aucune trace (`wakeReport`).
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
      this.deps.logger?.warn("chat.mattermost.reply.unavailable", {
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
        "Trop de réponses en attente sur ce canal : la file est pleine, un message est " +
        "resté sans réponse.";
      return false;
    }
    return publie === true;
  }

  /**
   * Rédaction + publication d'UNE réponse (appelée seulement avec une place RÉSERVÉE).
   *
   * Rend `true` quand au moins un message est PARTI dans le canal.
   */
  private async redigerEtPublier(
    message: RemoteMessage,
    channelTitle: string,
    options?: { fichiersDuJob?: readonly string[] },
  ): Promise<boolean> {
    if (!this.deps.generateReply) return false;
    // ⚠️ RAPPORT SYSTÈME : son identifiant distant n'existe PAS chez la plateforme.
    // Répondre « dans son fil » ou le citer produirait un post refusé (ou du bruit) :
    // on répond donc à la RACINE du canal, sans citation.
    const rapport = estRapportSysteme(message);
    try {
      const transcript = this.deps.store.messages(message.conversationId);
      // ⚠️ COMMENT répondre : réglage PAR CANAL, persisté. `fil` (défaut) repart de la
      // RACINE du fil — jamais du message lui-même, sinon Mattermost créerait un fil
      // imbriqué ; `nouveau` n'envoie AUCUN `root_id`, même sur un message de fil.
      // ⚠️ Calculé AVANT le run : les messages INTERMÉDIAIRES (accusé, image) doivent
      // être ancrés au MÊME message que la réponse.
      const record = this.deps.store.record(message.conversationId);
      const rootId = rapport
        ? undefined
        : rootIdForReply({ replyStyle: effectiveReplyStyle(record), message });
      // ⚠️ AUCUNE MENTION sur les STATUTS (accusé, résultat d'outil, image) — décision
      // utilisateur du 2026-11-02 : un statut qui notifierait la personne à chaque outil
      // serait insupportable, et l'accusé n'a pas à re-notifier celle qui vient d'écrire.
      // ⚠️ L'ANCRAGE INTER-RUNS ne repose donc plus que sur `root_id` : c'est une LIMITE
      // ASSUMÉE — deux runs simultanés dans le MÊME fil ne sont plus distingués par le
      // préfixe (`root_id` reste le seul rattachement, et il est posé ci-dessous).
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
      // ⚠️ PIÈCES JOINTES du message déclencheur : préparées ICI, à la demande (jamais
      // pendant la synchronisation), par la politique de vision partagée. Ce qui n'a pas
      // pu être joint est transmis au rédacteur (`notes`) : jamais un silence.
      const joints = this.deps.readImages
        ? await this.deps.readImages({ conversationId: message.conversationId, message })
        : { images: [], notes: [] };
      const brut = await this.deps.generateReply({
        channelTitle,
        transcript,
        message,
        // ⚠️ LE BOT DE CET ADAPTATEUR : nom, personnalité, outils, délégation et
        // canaux du tour sont LES SIENS. Jamais le bot du run (bug du 2026-11-14).
        ...(this.deps.botId !== undefined ? { botId: this.deps.botId } : {}),
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
      // ⚠️ Le générateur peut encore rendre des FICHIERS (ceux qu'il n'a pas déjà
      // postés) : ils partent dans le MÊME post, par `file_ids`.
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
      // ⚠️ MENTION NATIVE de l'auteur (`@pseudo`), JAMAIS une citation de son texte :
      // la plateforme affiche déjà le message d'origine au-dessus de la réponse.
      // ⚠️ Un rapport système n'a pas d'auteur humain : aucune mention.
      const texte = composeReply({
        text,
        message,
        quoteAuthor: rapport ? "non" : effectiveQuoteAuthor(record),
        platform: "mattermost",
        ...(this.identite?.id !== undefined ? { botUserId: this.identite.id } : {}),
      }).text;
      const fichiers = reponse.fichiers ?? [];
      await this.send(message.conversationId, {
        kind: "texte",
        text: texte,
        ...(rootId !== undefined ? { threadRootId: rootId } : {}),
        ...(fichiers.length > 0 ? { fichiers } : {}),
      });
      this.derniereErreur = undefined;
      return true;
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
      return false;
    }
  }

  /** Mémorise un identifiant jugé (mémoire bornée : on ne garde que les derniers). */
  /**
   * Noms NUS du bot, pour la détection d'adresse PAR LE NOM (avant le juge).
   *
   * ⚠️ Uniquement des formes EXPLICITES : pseudo du miroir, pseudo et nom affiché
   * renvoyés par le serveur. Aucun nom inventé, aucun alias déduit.
   */
  private nomsNusDuBot(botUsername: string | undefined): string[] {
    const noms = new Set<string>();
    for (const valeur of [botUsername, this.identite?.username, this.identite?.displayName]) {
      const nom = (valeur ?? "").trim();
      if (nom !== "") noms.add(nom);
    }
    return [...noms];
  }

  /**
   * `true` quand le message répond à un message DU BOT (racine de son fil).
   *
   * ⚠️ Une réponse de fil EST une adresse quand la racine est un message du bot :
   * c'est ainsi qu'on lui répond dans Mattermost. La racine est lue dans SON miroir
   * (déjà synchronisé) — aucun appel réseau supplémentaire.
   */
  private repondAUnMessageDuBot(
    message: RemoteMessage,
    botUserId: string | undefined,
  ): boolean {
    const racine = message.threadRootId;
    if (racine === undefined || racine === "") return false;
    const parent = this.deps.store
      .messages(message.conversationId)
      .find((item) => item.remoteId === racine);
    return parent !== undefined && isOwnMessage(parent, botUserId);
  }

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

  /**
   * Réglages de réponse EFFECTIFS d'un canal (mode, style, citation).
   *
   * ⚠️ `undefined` quand le canal n'est pas dans le miroir : l'appelant répond alors 404
   * plutôt que d'inventer des réglages.
   */
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

/**
 * Borne d'un message publié par DÉFAUT (caractères).
 *
 * ⚠️ 16 383 = valeur par défaut de `ServiceSettings.MaxPostSize` côté serveur. Une
 * instance bridée plus bas renverrait `400` : la réponse ENTIÈRE serait perdue. On reste
 * donc SOUS la limite par défaut, et on l'annonce quand on coupe.
 */
export const MM_DEFAULT_MAX_POST_CHARS = 16_383;

/**
 * Fenêtre de coalescence d'une resynchronisation déclenchée par l'adhésion du bot
 * à un canal : plusieurs événements Mattermost arrivent d'affilée, un seul
 * `backfillAll` suffit.
 */
export const RESYNC_DEBOUNCE_MS = 3_000;

/**
 * Tronque un texte à la limite de Mattermost **en le DISANT**.
 *
 * ⚠️ Symétrique de `fitDiscordContent` (`src/chat/discord/adapter.ts`) : une troncature
 * silencieuse laisserait croire que la réponse est complète. Le suffixe est compté DANS
 * la limite, sinon le message resterait trop long et le `400` reviendrait.
 */
export function fitMattermostContent(
  text: string,
  maxChars: number = MM_DEFAULT_MAX_POST_CHARS,
): { texte: string; tronque: boolean } {
  const limite = Math.max(1, Math.trunc(maxChars));
  // Comptage par POINTS DE CODE (un emoji ne compte pas double à la coupe).
  const caracteres = [...text];
  if (caracteres.length <= limite) return { texte: text, tronque: false };
  const suffixe = ` [… message tronqué : limite Mattermost de ${limite} caractères]`;
  const garde = Math.max(0, limite - [...suffixe].length);
  return { texte: `${caracteres.slice(0, garde).join("")}${suffixe}`, tronque: true };
}
