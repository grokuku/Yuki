/**
 * MIROIR PERSISTANT des conversations distantes (lot 18, lot 2).
 *
 * Deux fichiers, et rien d'autre :
 *  - `chat-mirror.json` : l'INDEX (mode, identité du bot, une entrée par canal
 *    synchronisé — plateforme, identifiant distant, titre, curseur, compteur,
 *    backfill effectué, mode de réponse) ;
 *  - `chat-mirror/<conversationId>.jsonl` : les messages, **append-only**.
 *
 * ⚠️ POURQUOI APPEND-ONLY MÊME POUR LES ÉDITIONS : un message édité chez la
 * plateforme doit tenir dans UNE bulle (pas une seconde), mais réécrire le fichier
 * en place exposerait le miroir à une perte totale sur une coupure au mauvais
 * moment. On ajoute donc une ligne PORTANT LE MÊME identifiant ; au chargement,
 * la DERNIÈRE ligne gagne. Résultat : une seule bulle à l'affichage, un fichier
 * qui ne perd jamais rien. Un message SUPPRIMÉ garde sa ligne (avec la mention
 * « supprimé ») : aucune suppression silencieuse.
 *
 * ⚠️ IDEMPOTENCE : la clé est `(platform, conversationId, remoteMessageId)`. Un
 * index en mémoire est construit au CHARGEMENT ; toute écriture est refusée si la
 * clé est déjà connue (`if (has(...)) return;`) — AVANT toute I/O. Aucune
 * heuristique de hachage de texte : deux messages différents peuvent avoir le même
 * texte, seul l'identifiant fait foi.
 *
 * Écriture ATOMIQUE (`tmp` + `rename`) en mode 0600 pour l'index ; le JSONL est
 * ouvert en `0600` et complété par des ajouts bornés.
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
  CHAT_QUOTE_AUTHORS,
  CHAT_REPLY_MODES,
  CHAT_REPLY_STYLES,
  DEFAULT_QUOTE_AUTHOR,
  DEFAULT_REPLY_STYLE,
  REMOTE_PLATFORMS,
  type ChatQuoteAuthor,
  type ChatReplyMode,
  type ChatReplySettingsPatch,
  type ChatReplyStyle,
  type RemoteAttachment,
  type RemoteConversation,
  type RemoteMessage,
  type RemotePlatform,
} from "../types.js";
import { mirrorPlatformOf, type ChatMirror } from "../mirror.js";
import { AuthorDirectory } from "./names.js";

export const CHAT_MIRROR_SCHEMA_VERSION = 1;

/** Nombre maximal de canaux suivis (borne EXPLICITE : refus, jamais une coupe muette). */
export const MAX_MIRRORED_CONVERSATIONS = 50;

/** Nombre maximal de messages conservés par canal (borne EXPLICITE). */
export const MAX_MESSAGES_PER_CONVERSATION = 20_000;

/** Taille maximale du CORPS d'un message conservé (16 Kio). */
export const MAX_MESSAGE_BYTES = 16 * 1024;

/** Mention ajoutée à un message tronqué (jamais une coupe silencieuse). */
export const TRUNCATION_SUFFIX = " [… message tronqué : 16 Kio dépassés]";

/**
 * Mention ajoutée à un message supprimé chez Mattermost.
 *
 * ⚠️ Conservée telle quelle (valeur ET nom) : des miroirs existants et des tests la
 * portent. La mention PUBLIÉE est désormais calculée par `deletedNoticeOf(platform)`.
 */
export const DELETED_NOTICE = "(supprimé sur Mattermost)";

/**
 * Mention « supprimé » d'une plateforme.
 *
 * ⚠️ Pourquoi une fonction : le texte est MONTRÉ à l'utilisateur et dans le prompt du
 * modèle. Écrire « supprimé sur Mattermost » sur un message Discord serait faux.
 */
export function deletedNoticeOf(platform: RemotePlatform): string {
  return platform === "discord" ? "(supprimé sur Discord)" : DELETED_NOTICE;
}

/** `true` si ce texte EST la mention de suppression d'une plateforme (jamais un contenu). */
export function isDeletedNotice(text: string): boolean {
  return text === DELETED_NOTICE || text === deletedNoticeOf("discord");
}

/** Journal minimal (le logger d'observabilité le satisfait). */
export interface ChatMirrorLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
}

/** Métadonnées d'un canal synchronisé (l'index du miroir). */
export interface ChatMirrorConversationRecord {
  platform: RemotePlatform;
  /** Identifiant d'origine chez la plateforme (canal). */
  remoteId: string;
  /** Titre affichable (nom du canal, jamais vide). */
  title: string;
  /** Curseur de reprise : instant ISO du dernier message ingéré. */
  curseur?: string;
  messageCount: number;
  /** `true` quand le backfill initial (2 semaines) a été effectué. */
  backfillDone: boolean;
  /** Début de la fenêtre importée (ISO) — `now - 14 j` au moment du backfill. */
  backfillDepuis?: string;
  /** `true` si la borne de messages a été atteinte : historique antérieur non importé. */
  historiqueAnterieur?: boolean;
  /** Mode de réponse du canal (`tout` | `auto` | `mention`). Absent = non choisi. */
  replyMode?: ChatReplyMode;
  /**
   * COMMENT répondre (`fil` | `nouveau`). Absent = jamais choisi ⇒ `fil`.
   *
   * ⚠️ Un miroir écrit par une version antérieure n'a pas cette clé : le défaut est
   * appliqué à la LECTURE (`effectiveReplyStyle`), jamais en réécrivant le fichier —
   * un miroir existant ne doit jamais être « cassé » par une montée de version.
   */
  replyStyle?: ChatReplyStyle;
  /** Citer l'auteur (`oui` | `non`). Absent = jamais choisi ⇒ `non`. */
  quoteAuthor?: ChatQuoteAuthor;
  /** Nombre de messages trop longs (marqués « tronqué »). */
  tronques?: number;
  /** `true` quand la borne de 20 000 messages est atteinte (plus rien n'est ajouté). */
  borneAtteinte?: boolean;
  /** Dernière activité connue (ISO). */
  dernierMessage?: string;
}

/** Contenu de `chat-mirror.json`. */
export interface ChatMirrorIndexFile {
  schemaVersion: number;
  settings: { baseUrl?: string };
  /**
   * Identité du bot Mattermost (champs HISTORIQUES, conservés tels quels : un miroir
   * écrit par une version antérieure doit rester lisible sans migration).
   */
  botUserId?: string;
  botUsername?: string;
  /**
   * Identité du bot PAR PLATEFORME (lot 21).
   *
   * ⚠️ Nécessaire dès qu'il y a DEUX plateformes : un seul `botUserId` ferait passer les
   * messages de Yuki sur Discord pour ceux d'un humain (ou l'inverse), et l'anti-boucle
   * dépend de cette identité.
   */
  bots?: Partial<Record<RemotePlatform, { id?: string; username?: string }>>;
  conversations: Record<string, ChatMirrorConversationRecord>;
}

/** Résultat d'une écriture dans le miroir. */
export type ChatMirrorWriteOutcome = "insere" | "mis_a_jour" | "doublon" | "borne";

export interface ChatMirrorStoreOptions {
  /** Chemin de l'index (`<state>/chat-mirror.json`). */
  indexPath: string;
  /** Dossier des JSONL (`<state>/chat-mirror`). */
  messagesDir?: string;
  logger?: ChatMirrorLogger;
  maxMessagesPerConversation?: number;
  maxMessageBytes?: number;
  /**
   * Chemin de l'ANNUAIRE des noms d'auteurs.
   *
   * ⚠️ Fichier SÉPARÉ à dessein : le miroir est append-only, une entrée déjà écrite
   * porte l'identifiant brut de son auteur. L'annuaire est consulté à la LECTURE
   * (`messages`, `message`), ce qui rend les entrées anciennes lisibles sans réécrire
   * une seule ligne du `.jsonl`. Défaut : `<messagesDir>/author-names.json`.
   */
  authorNamesPath?: string;
}

export class ChatMirrorStore implements ChatMirror {
  readonly indexPath: string;
  readonly messagesDir: string;
  private readonly logger: ChatMirrorLogger | undefined;
  private readonly maxMessages: number;
  private readonly maxMessageBytes: number;
  private index: ChatMirrorIndexFile;
  /** Messages chargés, par conversation (ordre d'insertion = ordre de première vue). */
  private readonly loaded = new Map<string, Map<string, RemoteMessage>>();
  /** Clés d'idempotence déjà vues : `(platform, conversationId, remoteMessageId)`. */
  private readonly seen = new Map<string, Set<string>>();
  /** Annuaire `(plateforme, id) → nom`, consulté à la LECTURE (jamais réécrit ici). */
  private readonly authorNames: AuthorDirectory;
  /** Observateurs (le transport les prévient pour rafraîchir la liste / le fil). */
  private readonly listeners = new Set<(conversationId?: string) => void>();

  private constructor(options: ChatMirrorStoreOptions) {
    this.indexPath = options.indexPath;
    this.messagesDir = options.messagesDir ?? join(dirname(options.indexPath), "chat-mirror");
    this.logger = options.logger;
    this.maxMessages = options.maxMessagesPerConversation ?? MAX_MESSAGES_PER_CONVERSATION;
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.authorNames = new AuthorDirectory({
      path: options.authorNamesPath ?? join(this.messagesDir, "author-names.json"),
      ...(options.logger ? { logger: options.logger } : {}),
    });
    this.index = this.loadIndex();
    this.loadMessages();
  }

  /** Ouvre (et crée au besoin) le miroir. Aucune exception : un index illisible ⇒ vide. */
  static open(options: ChatMirrorStoreOptions): ChatMirrorStore {
    return new ChatMirrorStore(options);
  }

  // ─── Lecture (interface `ChatMirror`) ────────────────────────────────────

  /** Conversations miroir disponibles (ordre d'insertion de l'index). */
  conversations(): readonly RemoteConversation[] {
    return Object.entries(this.index.conversations).map(([id, record]) => ({
      id,
      platform: record.platform,
      remoteId: record.remoteId,
      title: record.title,
      ...(record.dernierMessage !== undefined ? { updatedAt: record.dernierMessage } : {}),
      messageCount: record.messageCount,
      // ⚠️ Sens RESTREINT : rien ne s'écrit depuis l'interface web.
      readOnly: true,
      // ⚠️ Un canal miroir PEUT produire un run : il répond aux messages.
      canRun: true,
      ...(record.replyMode !== undefined ? { replyMode: record.replyMode } : {}),
      // ⚠️ Valeurs EFFECTIVES (défauts appliqués) : l'interface coche l'option
      // réellement active, sans garder d'état local qui divergerait du serveur.
      replyStyle: effectiveReplyStyle(record),
      quoteAuthor: effectiveQuoteAuthor(record),
    }));
  }

  /** Messages d'une conversation, en ordre CHRONOLOGIQUE. */
  messages(conversationId: string): readonly RemoteMessage[] {
    const platform = mirrorPlatformOf(conversationId);
    const rows = [...(this.loaded.get(conversationId)?.values() ?? [])];
    // Tri stable par instant d'envoi : deux messages du même instant gardent leur
    // ordre d'arrivée (jamais un ordre aléatoire d'un chargement à l'autre).
    return rows
      .map((message, position) => ({ message, position }))
      .sort((a, b) => {
        const ta = Date.parse(a.message.sentAt);
        const tb = Date.parse(b.message.sentAt);
        if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
        return a.position - b.position;
      })
      .map((entry) => this.avecNomConnu(platform, entry.message));
  }

  /** Un message précis, ou `undefined` (accès O(1), sans copier tout le fil). */
  message(conversationId: string, remoteId: string): RemoteMessage | undefined {
    const found = this.loaded.get(conversationId)?.get(remoteId);
    if (!found) return undefined;
    return this.avecNomConnu(mirrorPlatformOf(conversationId), found);
  }

  // ─── Annuaire des noms d'auteurs ─────────────────────────────────────────

  /** Nom connu d'un auteur (annuaire), ou `undefined`. */
  authorName(conversationId: string, authorId: string): string | undefined {
    const platform = mirrorPlatformOf(conversationId);
    if (platform === null) return undefined;
    return this.authorNames.name(platform, authorId);
  }

  /**
   * Tous les noms connus pour la plateforme d'une conversation (copie défensive).
   *
   * ⚠️ Sert à l'INGESTION : un message arrivé en temps réel est écrit avec son nom quand
   * l'annuaire le connaît déjà, sans le moindre appel réseau.
   */
  authorNamesOf(conversationId: string): Map<string, string> {
    const platform = mirrorPlatformOf(conversationId);
    if (platform === null) return new Map();
    return this.authorNames.namesOf(platform);
  }

  /**
   * Apprend des noms d'auteurs pour la plateforme d'une conversation.
   *
   * ⚠️ Rend le nombre de noms NOUVEAUX : c'est ce qui décide d'une notification (un
   * nom appris change l'affichage d'entrées DÉJÀ présentes dans le fil).
   */
  rememberAuthorNames(
    conversationId: string,
    entries: Iterable<readonly [string, string]>,
  ): number {
    const platform = mirrorPlatformOf(conversationId);
    if (platform === null) return 0;
    const changes = this.authorNames.remember(platform, entries);
    if (changes > 0) this.notifyChange(conversationId);
    return changes;
  }

  /**
   * Apprend des noms pour une PLATEFORME, sans conversation (identité du bot, par ex.).
   */
  rememberPlatformAuthorNames(
    platform: RemotePlatform,
    entries: Iterable<readonly [string, string]>,
  ): number {
    return this.authorNames.remember(platform, entries);
  }

  /**
   * Identifiants d'auteurs d'une conversation dont le nom n'est TOUJOURS PAS connu.
   *
   * ⚠️ Sert au RATTRAPAGE : les messages ingérés avant la résolution portent
   * l'identifiant dans `nom` (`authorOf`). On ne redemande jamais un identifiant déjà
   * présent dans l'annuaire. `limit` borne la passe (jamais 20 000 identifiants d'un
   * coup sur un canal ancien).
   */
  authorIdsWithoutName(conversationId: string, limit = 200): string[] {
    const platform = mirrorPlatformOf(conversationId);
    if (platform === null) return [];
    const wanted = new Set<string>();
    for (const message of this.loaded.get(conversationId)?.values() ?? []) {
      const id = message.author.id;
      if (typeof id !== "string" || id === "" || id === "inconnu") continue;
      const nom = typeof message.author.nom === "string" ? message.author.nom.trim() : "";
      // Nom DÉJÀ résolu (≠ identifiant) : rien à demander.
      if (nom !== "" && nom !== id) continue;
      if (this.authorNames.name(platform, id) !== undefined) continue;
      wanted.add(id);
      if (wanted.size >= Math.max(1, Math.trunc(limit))) break;
    }
    return [...wanted];
  }

  /** Taille de l'annuaire des noms (diagnostic). */
  authorNamesCount(): number {
    return this.authorNames.size;
  }

  /**
   * Applique le nom CONNU à un message dont l'auteur n'est pas résolu.
   *
   * ⚠️ Le marqueur d'échec est `author.nom === author.id` (voir `authorOf`, `ingest.ts`) :
   * un nom différent n'est JAMAIS écrasé, même si l'annuaire dit autre chose (le nom
   * écrit dans le message vient de la plateforme au moment du post).
   */
  private avecNomConnu(
    platform: RemotePlatform | null,
    message: RemoteMessage,
  ): RemoteMessage {
    if (platform === null) return message;
    const id = message.author.id;
    const nom = typeof message.author.nom === "string" ? message.author.nom.trim() : "";
    if (nom !== "" && nom !== id) return message;
    const connu = this.authorNames.name(platform, id);
    if (connu === undefined) return message;
    return { ...message, author: { ...message.author, nom: connu } };
  }

  /** Enregistrement d'index d'une conversation, ou `undefined`. */
  record(conversationId: string): ChatMirrorConversationRecord | undefined {
    const found = this.index.conversations[conversationId];
    return found ? { ...found } : undefined;
  }

  /** Tous les enregistrements d'index (copie défensive). */
  records(): Record<string, ChatMirrorConversationRecord> {
    const out: Record<string, ChatMirrorConversationRecord> = {};
    for (const [id, record] of Object.entries(this.index.conversations)) out[id] = { ...record };
    return out;
  }

  /** URL du serveur enregistrée (aucun jeton ici : il vit dans le coffre). */
  baseUrl(): string {
    return this.index.settings.baseUrl ?? "";
  }

  /**
   * Identité du bot connue pour une PLATEFORME (`users/me`).
   *
   * ⚠️ Défaut `mattermost` : c'est la plateforme livrée au lot 18, dont l'identité vit
   * dans les champs historiques `botUserId`/`botUsername`.
   */
  bot(platform: RemotePlatform = "mattermost"): { id?: string; username?: string } {
    const stored = this.index.bots?.[platform];
    if (stored) {
      return { id: stored.id, username: stored.username };
    }
    if (platform === "mattermost") {
      return { id: this.index.botUserId, username: this.index.botUsername };
    }
    return { id: undefined, username: undefined };
  }

  /**
   * S'abonne aux CHANGEMENTS du miroir (message ajouté/édité, canal découvert,
   * backfill terminé). Rend le désabonnement.
   *
   * ⚠️ L'observateur reçoit l'identifiant de la conversation concernée quand il est
   * connu : le transport ne renvoie alors le fil QU'AUX clients qui regardent ce canal.
   */
  onChange(listener: (conversationId?: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyChange(conversationId?: string): void {
    for (const listener of this.listeners) {
      try {
        listener(conversationId);
      } catch {
        // Un observateur fautif ne casse pas une écriture déjà faite.
      }
    }
  }

  /** Une clé d'idempotence est-elle déjà connue ? */
  has(conversationId: string, remoteMessageId: string): boolean {
    return this.seen.get(conversationId)?.has(remoteMessageId) === true;
  }

  // ─── Écriture ────────────────────────────────────────────────────────────

  /**
   * Ajoute un message, ou met à jour celui qui porte le même identifiant.
   *
   * ⚠️ L'idempotence est vérifiée AVANT toute écriture. Un message édité (même
   * identifiant) est MIS À JOUR (une seule entrée), jamais dupliqué.
   */
  upsert(message: RemoteMessage, options: { update?: boolean } = {}): ChatMirrorWriteOutcome {
    const conversationId = message.conversationId;
    const known = this.has(conversationId, message.remoteId);
    if (known && options.update !== true) return "doublon";
    const rows = this.loaded.get(conversationId) ?? new Map<string, RemoteMessage>();
    if (!known && rows.size >= this.maxMessages) {
      this.markOverflow(conversationId);
      return "borne";
    }
    const stored = this.clampMessage(message);
    const line = `${JSON.stringify(stored)}\n`;
    const file = this.fileOf(conversationId);
    try {
      mkdirSync(this.messagesDir, { recursive: true });
      appendFileSync(file, line, { mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        // Meilleur effort (systèmes de fichiers sans permissions POSIX).
      }
    } catch (error) {
      this.logger?.warn("chat.mirror.append_failed", {
        conversation: conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "borne";
    }
    rows.set(stored.remoteId, stored);
    this.loaded.set(conversationId, rows);
    if (!this.seen.has(conversationId)) this.seen.set(conversationId, new Set());
    this.seen.get(conversationId)?.add(stored.remoteId);
    this.touch(conversationId, stored);
    this.notifyChange(conversationId);
    return known ? "mis_a_jour" : "insere";
  }

  /** Met à jour un message DÉJÀ connu (édition ou suppression chez la plateforme). */
  update(message: RemoteMessage): ChatMirrorWriteOutcome {
    if (!this.has(message.conversationId, message.remoteId)) return this.upsert(message);
    return this.upsert(message, { update: true });
  }

  /** Enregistre l'URL du serveur (jamais un jeton). */
  setBaseUrl(baseUrl: string): void {
    this.index.settings = { ...this.index.settings, baseUrl: baseUrl.trim() };
    this.persistIndex();
  }

  /**
   * Enregistre l'identité du bot (`users/me`) pour une PLATEFORME.
   *
   * ⚠️ Pour Mattermost, les champs HISTORIQUES restent écrits : une version antérieure de
   * Yuki (ou un outil de diagnostic) continue de lire l'identité au même endroit.
   */
  setBot(identity: { id?: string; username?: string }, platform: RemotePlatform = "mattermost"): void {
    const bots = { ...(this.index.bots ?? {}) };
    const previous = bots[platform] ?? {};
    bots[platform] = {
      ...previous,
      ...(identity.id !== undefined ? { id: identity.id } : {}),
      ...(identity.username !== undefined ? { username: identity.username } : {}),
    };
    this.index.bots = bots;
    if (platform === "mattermost") {
      if (identity.id !== undefined) this.index.botUserId = identity.id;
      if (identity.username !== undefined) this.index.botUsername = identity.username;
    }
    this.persistIndex();
  }

  /**
   * Déclare un canal suivi (crée l'entrée d'index s'il n'existe pas).
   *
   * @returns `false` quand la borne de canaux suivis est atteinte (REFUS explicite,
   *   jamais une coupe silencieuse).
   */
  ensureConversation(input: {
    conversationId: string;
    platform: RemotePlatform;
    remoteId: string;
    title: string;
  }): boolean {
    if (this.index.conversations[input.conversationId]) {
      const record = this.index.conversations[input.conversationId];
      if (record.title !== input.title) {
        record.title = input.title;
        this.persistIndex();
      }
      return true;
    }
    if (Object.keys(this.index.conversations).length >= MAX_MIRRORED_CONVERSATIONS) {
      this.logger?.warn("chat.mirror.channels_full", {
        limit: MAX_MIRRORED_CONVERSATIONS,
        channel: input.remoteId,
      });
      return false;
    }
    this.index.conversations[input.conversationId] = {
      platform: input.platform,
      remoteId: input.remoteId,
      title: input.title,
      messageCount: 0,
      backfillDone: false,
    };
    this.persistIndex();
    this.notifyChange(input.conversationId);
    return true;
  }

  /** Mode de RÉPONSE d'un canal (`tout` | `auto` | `mention`), persisté. */
  setReplyMode(conversationId: string, mode: ChatReplyMode | undefined): void {
    const record = this.index.conversations[conversationId];
    if (!record) return;
    if (mode === undefined) delete record.replyMode;
    else record.replyMode = mode;
    this.persistIndex();
    this.notifyChange(conversationId);
  }

  /** Style de réponse d'un canal (`fil` | `nouveau`), persisté (`undefined` = défaut). */
  setReplyStyle(conversationId: string, style: ChatReplyStyle | undefined): void {
    const record = this.index.conversations[conversationId];
    if (!record) return;
    if (style === undefined) delete record.replyStyle;
    else record.replyStyle = style;
    this.persistIndex();
    this.notifyChange(conversationId);
  }

  /** Citation de l'auteur (`oui` | `non`), persistée (`undefined` = défaut). */
  setQuoteAuthor(conversationId: string, quote: ChatQuoteAuthor | undefined): void {
    const record = this.index.conversations[conversationId];
    if (!record) return;
    if (quote === undefined) delete record.quoteAuthor;
    else record.quoteAuthor = quote;
    this.persistIndex();
    this.notifyChange(conversationId);
  }

  /**
   * Applique un SOUS-ENSEMBLE de réglages de réponse en UNE écriture d'index.
   *
   * @returns `false` quand le canal n'est pas (encore) dans le miroir : l'appelant
   *   répond alors 404, jamais un succès supposé.
   */
  setReplySettings(conversationId: string, patch: ChatReplySettingsPatch): boolean {
    const record = this.index.conversations[conversationId];
    if (!record) return false;
    if (patch.replyMode !== undefined) {
      if (patch.replyMode === null) delete record.replyMode;
      else record.replyMode = patch.replyMode;
    }
    if (patch.replyStyle !== undefined) {
      if (patch.replyStyle === null) delete record.replyStyle;
      else record.replyStyle = patch.replyStyle;
    }
    if (patch.quoteAuthor !== undefined) {
      if (patch.quoteAuthor === null) delete record.quoteAuthor;
      else record.quoteAuthor = patch.quoteAuthor;
    }
    this.persistIndex();
    this.notifyChange(conversationId);
    return true;
  }

  /**
   * Pièce jointe d'un canal miroir : le message qui la porte, ou `undefined`.
   *
   * ⚠️ Sert à la garde de SÛRETÉ du téléchargement : un `file_id` deviné ne doit
   * jamais permettre de lire un fichier d'un canal qu'on ne suit pas.
   */
  attachmentMessage(conversationId: string, fileId: string): RemoteMessage | undefined {
    if (typeof fileId !== "string" || fileId === "") return undefined;
    for (const message of this.loaded.get(conversationId)?.values() ?? []) {
      if (message.attachments?.some((attachment) => attachment.id === fileId) === true) {
        return message;
      }
    }
    return undefined;
  }

  /**
   * Met à jour les MÉTADONNÉES d'une pièce jointe (nom, taille, type) sur le message
   * qui la porte, et le persiste.
   *
   * ⚠️ Appelé seulement À LA DEMANDE (lecture d'une image), jamais pendant la
   * synchronisation : `GET /files/<id>/info` coûterait un appel par fichier.
   */
  setAttachmentMeta(
    conversationId: string,
    fileId: string,
    meta: { nom?: string; taille?: number; mime?: string },
  ): boolean {
    const message = this.attachmentMessage(conversationId, fileId);
    if (!message || message.attachments === undefined) return false;
    const attachments = message.attachments.map((attachment) =>
      attachment.id === fileId
        ? {
            ...attachment,
            ...(meta.nom !== undefined && meta.nom !== "" ? { nom: meta.nom } : {}),
            ...(meta.taille !== undefined ? { taille: meta.taille } : {}),
            ...(meta.mime !== undefined && meta.mime !== "" ? { mime: meta.mime } : {}),
          }
        : attachment,
    );
    return this.update({ ...message, attachments }) !== "borne";
  }

  /** Curseur de reprise d'un canal (instant ISO du dernier message ingéré). */
  setCursor(conversationId: string, curseur: string | undefined): void {
    const record = this.index.conversations[conversationId];
    if (!record) return;
    if (curseur === undefined) delete record.curseur;
    else record.curseur = curseur;
    this.persistIndex();
  }

  /** Marque le backfill initial comme effectué (avec sa fenêtre et sa borne). */
  markBackfill(
    conversationId: string,
    info: { depuis: string; historiqueAnterieur: boolean },
  ): void {
    const record = this.index.conversations[conversationId];
    if (!record) return;
    record.backfillDone = true;
    record.backfillDepuis = info.depuis;
    if (info.historiqueAnterieur) record.historiqueAnterieur = true;
    else delete record.historiqueAnterieur;
    this.persistIndex();
  }

  /** Supprime un canal du miroir (le JSONL reste sur le disque : rien n'est détruit). */
  forget(conversationId: string): void {
    delete this.index.conversations[conversationId];
    this.persistIndex();
  }

  // ─── Interne ─────────────────────────────────────────────────────────────

  private fileOf(conversationId: string): string {
    // ⚠️ Les identifiants miroir respectent `[A-Za-z0-9_-]` (`mm-…`) : aucun
    // séparateur de chemin ne peut donc s'y glisser. On le VÉRIFIE quand même.
    const safe = /^[A-Za-z0-9_-]+$/.test(conversationId)
      ? conversationId
      : conversationId.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(this.messagesDir, `${safe}.jsonl`);
  }

  /** Tronque un corps trop long AVEC mention (jamais une coupe silencieuse). */
  private clampMessage(message: RemoteMessage): RemoteMessage {
    const size = Buffer.byteLength(message.text ?? "", "utf8");
    if (size <= this.maxMessageBytes) return message;
    const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
    const budget = Math.max(0, this.maxMessageBytes - suffixBytes);
    const truncated = truncateUtf8(message.text ?? "", budget) + TRUNCATION_SUFFIX;
    return { ...message, text: truncated };
  }

  private touch(conversationId: string, message: RemoteMessage): void {
    const record = this.index.conversations[conversationId];
    if (!record) {
      // Message arrivé pour un canal inconnu de l'index : on le CONSERVE et on
      // crée l'entrée (sinon il serait invisible alors qu'il est sur le disque).
      this.index.conversations[conversationId] = {
        platform: "mattermost",
        remoteId: conversationId.replace(/^[a-z]{2}-/, ""),
        title: conversationId,
        messageCount: 1,
        backfillDone: false,
        curseur: message.sentAt,
        dernierMessage: message.sentAt,
      };
      this.persistIndex();
      return;
    }
    const rows = this.loaded.get(conversationId);
    record.messageCount = rows?.size ?? record.messageCount;
    if (message.sentAt !== undefined) {
      if (record.curseur === undefined || message.sentAt > record.curseur) record.curseur = message.sentAt;
      if (record.dernierMessage === undefined || message.sentAt > record.dernierMessage) {
        record.dernierMessage = message.sentAt;
      }
    }
    this.persistIndex();
  }

  private markOverflow(conversationId: string): void {
    const record = this.index.conversations[conversationId];
    if (!record || record.borneAtteinte === true) return;
    record.borneAtteinte = true;
    this.persistIndex();
    this.logger?.warn("chat.mirror.messages_full", {
      conversation: conversationId,
      limit: this.maxMessages,
    });
  }

  private loadIndex(): ChatMirrorIndexFile {
    const empty: ChatMirrorIndexFile = {
      schemaVersion: CHAT_MIRROR_SCHEMA_VERSION,
      settings: {},
      conversations: {},
    };
    if (!existsSync(this.indexPath)) return empty;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.indexPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) return empty;
      const raw = parsed as Partial<ChatMirrorIndexFile>;
      const conversations: Record<string, ChatMirrorConversationRecord> = {};
      for (const [id, value] of Object.entries(raw.conversations ?? {})) {
        const record = sanitizeRecord(value);
        if (record) conversations[id] = record;
      }
      return {
        schemaVersion: CHAT_MIRROR_SCHEMA_VERSION,
        settings: typeof raw.settings === "object" && raw.settings !== null ? { ...raw.settings } : {},
        ...(typeof raw.botUserId === "string" ? { botUserId: raw.botUserId } : {}),
        ...(typeof raw.botUsername === "string" ? { botUsername: raw.botUsername } : {}),
        ...(sanitizeBots(raw.bots) !== undefined ? { bots: sanitizeBots(raw.bots) } : {}),
        conversations,
      };
    } catch (error) {
      this.logger?.warn("chat.mirror.index_invalid", {
        path: this.indexPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }
  }

  private loadMessages(): void {
    for (const conversationId of Object.keys(this.index.conversations)) {
      const rows = new Map<string, RemoteMessage>();
      const file = this.fileOf(conversationId);
      if (existsSync(file)) {
        try {
          const content = readFileSync(file, "utf8");
          for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (trimmed === "") continue;
            const message = sanitizeMessage(trimmed);
            if (!message) continue;
            // ⚠️ DERNIÈRE ligne gagnante : c'est ce qui fait qu'une édition tient
            // dans UNE entrée malgré le fichier append-only.
            rows.set(message.remoteId, message);
          }
        } catch (error) {
          this.logger?.warn("chat.mirror.messages_invalid", {
            conversation: conversationId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      this.loaded.set(conversationId, rows);
      this.seen.set(conversationId, new Set(rows.keys()));
      const record = this.index.conversations[conversationId];
      if (record && record.messageCount !== rows.size) record.messageCount = rows.size;
    }
  }

  private persistIndex(): void {
    mkdirSync(dirname(this.indexPath), { recursive: true });
    const tmp = `${this.indexPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    writeFileSync(tmp, `${JSON.stringify(this.index, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Meilleur effort.
    }
    renameSync(tmp, this.indexPath);
    try {
      chmodSync(this.indexPath, 0o600);
    } catch {
      // Meilleur effort.
    }
  }
}

/**
 * Identités de bot relues d'un index (champs invalides ignorés, jamais une exception).
 *
 * ⚠️ Rend `undefined` quand rien d'exploitable n'est présent : l'index garde alors sa
 * forme historique et n'est pas réécrit avec un objet vide.
 */
function sanitizeBots(
  raw: unknown,
): Partial<Record<RemotePlatform, { id?: string; username?: string }>> | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const out: Partial<Record<RemotePlatform, { id?: string; username?: string }>> = {};
  for (const platform of REMOTE_PLATFORMS) {
    const value = (raw as Record<string, unknown>)[platform];
    if (typeof value !== "object" || value === null) continue;
    const candidate = value as { id?: unknown; username?: unknown };
    const id = typeof candidate.id === "string" && candidate.id !== "" ? candidate.id : undefined;
    const username =
      typeof candidate.username === "string" && candidate.username !== ""
        ? candidate.username
        : undefined;
    if (id === undefined && username === undefined) continue;
    out[platform] = { ...(id !== undefined ? { id } : {}), ...(username !== undefined ? { username } : {}) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Style de réponse EFFECTIF d'un enregistrement de miroir.
 *
 * ⚠️ C'est ici — et nulle part ailleurs — que le défaut s'applique : un miroir écrit
 * avant l'ajout de `replyStyle` n'a pas la clé, et il reste parfaitement lisible.
 */
export function effectiveReplyStyle(record: { replyStyle?: ChatReplyStyle } | undefined): ChatReplyStyle {
  return record?.replyStyle ?? DEFAULT_REPLY_STYLE;
}

/** Citation de l'auteur EFFECTIVE d'un enregistrement de miroir (défaut `non`). */
export function effectiveQuoteAuthor(
  record: { quoteAuthor?: ChatQuoteAuthor } | undefined,
): ChatQuoteAuthor {
  return record?.quoteAuthor ?? DEFAULT_QUOTE_AUTHOR;
}

/** Tronque une chaîne UTF-8 sans couper un caractère en deux. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out;
}

/** Enregistrement d'index validé (une valeur illisible est IGNORÉE, pas devinée). */
function sanitizeRecord(value: unknown): ChatMirrorConversationRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<ChatMirrorConversationRecord>;
  const platform = raw.platform;
  if (typeof platform !== "string" || !(REMOTE_PLATFORMS as readonly string[]).includes(platform)) {
    return null;
  }
  if (typeof raw.remoteId !== "string" || raw.remoteId === "") return null;
  const replyMode =
    typeof raw.replyMode === "string" && (CHAT_REPLY_MODES as readonly string[]).includes(raw.replyMode)
      ? (raw.replyMode as ChatReplyMode)
      : undefined;
  // ⚠️ Valeur INCONNUE = clé IGNORÉE (donc défaut à la lecture), jamais une valeur
  // devinée : un fichier trafiqué ne peut pas faire prendre un style inédit.
  const replyStyle =
    typeof raw.replyStyle === "string" && (CHAT_REPLY_STYLES as readonly string[]).includes(raw.replyStyle)
      ? (raw.replyStyle as ChatReplyStyle)
      : undefined;
  const quoteAuthor =
    typeof raw.quoteAuthor === "string" &&
    (CHAT_QUOTE_AUTHORS as readonly string[]).includes(raw.quoteAuthor)
      ? (raw.quoteAuthor as ChatQuoteAuthor)
      : undefined;
  return {
    platform: platform as RemotePlatform,
    remoteId: raw.remoteId,
    title: typeof raw.title === "string" && raw.title !== "" ? raw.title : raw.remoteId,
    ...(typeof raw.curseur === "string" ? { curseur: raw.curseur } : {}),
    messageCount: typeof raw.messageCount === "number" && raw.messageCount >= 0 ? raw.messageCount : 0,
    backfillDone: raw.backfillDone === true,
    ...(typeof raw.backfillDepuis === "string" ? { backfillDepuis: raw.backfillDepuis } : {}),
    ...(raw.historiqueAnterieur === true ? { historiqueAnterieur: true } : {}),
    ...(replyMode !== undefined ? { replyMode } : {}),
    ...(replyStyle !== undefined ? { replyStyle } : {}),
    ...(quoteAuthor !== undefined ? { quoteAuthor } : {}),
    ...(typeof raw.tronques === "number" ? { tronques: raw.tronques } : {}),
    ...(raw.borneAtteinte === true ? { borneAtteinte: true } : {}),
    ...(typeof raw.dernierMessage === "string" ? { dernierMessage: raw.dernierMessage } : {}),
  };
}

/** Message d'une ligne JSONL validé (champs obligatoires seulement). */
function sanitizeMessage(line: string): RemoteMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const raw = parsed as Partial<RemoteMessage>;
  if (typeof raw.remoteId !== "string" || raw.remoteId === "") return null;
  if (typeof raw.conversationId !== "string" || raw.conversationId === "") return null;
  if (typeof raw.text !== "string") return null;
  if (typeof raw.sentAt !== "string") return null;
  const author =
    typeof raw.author === "object" && raw.author !== null && typeof raw.author.id === "string"
      ? {
          id: raw.author.id,
          nom: typeof raw.author.nom === "string" ? raw.author.nom : raw.author.id,
          estBot: raw.author.estBot === true,
        }
      : { id: "inconnu", nom: "inconnu", estBot: false };
  // ⚠️ Les PIÈCES JOINTES survivent au redémarrage : sans cela, une image postée sur
  // Mattermost serait « oubliée » au rechargement (son `file_id` n'existerait plus nulle
  // part) et ne pourrait plus jamais être montrée au modèle.
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.flatMap((value) => {
        if (typeof value !== "object" || value === null) return [];
        const candidate = value as Partial<RemoteAttachment>;
        if (typeof candidate.id !== "string" || candidate.id === "") return [];
        return [
          {
            id: candidate.id,
            nom: typeof candidate.nom === "string" && candidate.nom !== "" ? candidate.nom : candidate.id,
            ...(typeof candidate.taille === "number" && candidate.taille >= 0
              ? { taille: candidate.taille }
              : {}),
            ...(typeof candidate.mime === "string" && candidate.mime !== ""
              ? { mime: candidate.mime }
              : {}),
            // ⚠️ L'URL de contenu d'une pièce jointe Discord est SIGNÉE : elle survit au
            // redémarrage, sinon l'image d'un message ancien ne serait plus téléchargeable.
            ...(typeof candidate.url === "string" && candidate.url !== ""
              ? { url: candidate.url }
              : {}),
          },
        ];
      })
    : [];
  return {
    remoteId: raw.remoteId,
    conversationId: raw.conversationId,
    ...(typeof raw.threadRootId === "string" ? { threadRootId: raw.threadRootId } : {}),
    author,
    role: raw.role === "assistant" ? "assistant" : "user",
    text: raw.text,
    sentAt: raw.sentAt,
    ...(typeof raw.editedAt === "string" ? { editedAt: raw.editedAt } : {}),
    ...(raw.deleted === true ? { deleted: true } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}
