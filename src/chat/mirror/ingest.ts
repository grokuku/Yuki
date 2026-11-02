/**
 * INGESTION d'un post Mattermost dans le miroir (lot 18, lot 2).
 *
 * Traduit la charge utile de la plateforme (`MattermostPost`) en modèle commun
 * (`RemoteMessage`) puis l'écrit dans le miroir — avec trois règles non
 * négociables :
 *
 *  1. **Idempotence stricte** : la clé `(platform, conversationId,
 *     remoteMessageId)` est vérifiée AVANT toute écriture. Deux `posted`
 *     identiques produisent UN message ; aucune heuristique de hachage de texte
 *     (deux messages distincts peuvent porter le même texte).
 *  2. **Édition ≠ nouvelle bulle** : un post édité (`edit_at`) met à jour
 *     l'entrée existante (`editedAt`), il n'en crée pas une seconde.
 *  3. **Suppression ≠ disparition** : un post supprimé (`delete_at`) GARDE son
 *     entrée, avec la mention explicite « supprimé sur Mattermost ». Le texte
 *     d'origine est conservé s'il était connu (on ne réécrit pas l'histoire).
 *
 * ⚠️ RÔLE : `botUserId` ⇒ `assistant` (c'est Yuki elle-même), tout le reste ⇒
 * `user`. Ce mapping est la SEULE chose qui distingue Yuki d'un humain : c'est lui
 * qui permet (plus haut) de ne JAMAIS répondre à son propre message — sans quoi le
 * canal boucle à l'infini.
 */

import { deletedNoticeOf, isDeletedNotice, type ChatMirrorStore } from "./store.js";
import {
  isoOf,
  type MattermostPost,
  type MattermostUser,
} from "../mattermost/types.js";
import type { DiscordMessage } from "../discord/types.js";
import type { RemoteAttachment, RemoteAuthor, RemoteMessage, RemotePlatform } from "../types.js";
import { mirrorConversationId } from "../mirror.js";

/** Contexte d'ingestion : ce que la plateforme ne dit pas dans le post lui-même. */
export interface IngestContext {
  platform: RemotePlatform;
  /** Conversation Yuki préfixée (`mm-<channelId>`). */
  conversationId: string;
  /** Identifiant du compte BOT de Yuki (ses messages deviennent `assistant`). */
  botUserId?: string;
  /** Auteurs déjà résolus (`users/ids`), pour les noms affichables. */
  users?: ReadonlyMap<string, MattermostUser>;
}

/** Résultat d'une ingestion (jamais un booléen nu : on veut savoir QUOI). */
export type IngestOutcome = "insere" | "mis_a_jour" | "doublon" | "ignore" | "borne";

/** Nom affichable d'un auteur Mattermost (jamais vide). */
export function authorNameOf(user: MattermostUser | undefined, fallbackId: string): string {
  if (!user) return fallbackId;
  for (const candidate of [user.username, user.nickname]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  const full = [user.first_name, user.last_name]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join(" ")
    .trim();
  return full !== "" ? full : fallbackId;
}

/** Auteur commun d'un post (`botUserId` ⇒ robot). */
function authorOf(post: MattermostPost, ctx: IngestContext): RemoteAuthor {
  const id = typeof post.user_id === "string" && post.user_id !== "" ? post.user_id : "inconnu";
  const user = ctx.users?.get(id);
  return {
    id,
    nom: authorNameOf(user, id),
    estBot: ctx.botUserId !== undefined && id === ctx.botUserId,
  };
}

/**
 * `true` si le message vient de Yuki elle-même.
 *
 * ⚠️ Double critère : l'identifiant du bot ET le rôle calculé. Si l'identité du
 * bot n'est pas encore connue (`botUserId` absent), un message déjà classé
 * `assistant` reste reconnu — la boucle est donc impossible même pendant la
 * première seconde de synchronisation.
 */
export function isOwnMessage(
  message: Pick<RemoteMessage, "author" | "role">,
  botUserId?: string,
): boolean {
  if (message.role === "assistant") return true;
  if (botUserId !== undefined && botUserId !== "" && message.author.id === botUserId) return true;
  return false;
}

/**
 * Convertit un post Mattermost en message commun.
 *
 * ⚠️ `threadRootId` est TOUJOURS calculé (même absent) : c'est ce qui rend les
 * fils dépliables possibles sans re-synchronisation.
 */
export function postToRemoteMessage(post: MattermostPost, ctx: IngestContext): RemoteMessage {
  const sentAt = isoOf(post.create_at) ?? isoOf(post.update_at) ?? new Date(0).toISOString();
  const editedAt = isoOf(post.edit_at);
  const deleted = typeof post.delete_at === "number" && post.delete_at > 0;
  const author = authorOf(post, ctx);
  const rootId = typeof post.root_id === "string" && post.root_id !== "" ? post.root_id : undefined;
  const text =
    deleted && (post.message ?? "") === ""
      ? deletedNoticeOf("mattermost")
      : post.message ?? "";
  // ⚠️ PIÈCES JOINTES : un post Mattermost ne porte QUE des identifiants (`file_ids`),
  // jamais le nom ni la taille. On conserve donc l'identifiant (seule chose nécessaire
  // au téléchargement à la demande) et, provisoirement, l'identifiant comme nom : lire
  // les métadonnées ici coûterait un appel `GET /files/<id>/info` PAR FICHIER pendant la
  // synchronisation (des milliers d'appels en arrière-plan). Elles sont renseignées plus
  // tard, à la DEMANDE (`MattermostAttachmentCache`).
  const attachments = attachmentIdsOf(post).map((id) => ({ id, nom: id }));
  return {
    remoteId: post.id,
    conversationId: ctx.conversationId,
    ...(rootId !== undefined ? { threadRootId: rootId } : {}),
    author,
    role: ctx.botUserId !== undefined && author.id === ctx.botUserId ? "assistant" : "user",
    text,
    sentAt,
    ...(editedAt !== undefined ? { editedAt } : {}),
    ...(deleted ? { deleted: true } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/** Identifiants de fichiers VALIDES d'un post (`file_ids` peut être absent ou vide). */
export function attachmentIdsOf(post: Pick<MattermostPost, "file_ids">): string[] {
  const raw = post.file_ids;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || value === "" || value.length > 200) continue;
    if (out.includes(value)) continue;
    out.push(value);
  }
  return out;
}

/**
 * Écrit un message DÉJÀ converti dans le miroir, en respectant les trois règles
 * d'idempotence (doublon, édition, suppression).
 *
 * ⚠️ FACTORISÉ À DESSEIN (lot 21) : Mattermost et Discord produisent le même modèle
 * commun, la logique d'écriture ne doit donc exister QU'UNE fois. Deux copies auraient
 * divergées sur la conservation du texte d'origine (le cas d'une charge partielle de
 * suppression, où seule une plateforme envoie un message tronqué).
 */
export function applyMessageToMirror(
  store: ChatMirrorStore,
  conversationId: string,
  message: RemoteMessage,
): IngestOutcome {
  const known = store.has(conversationId, message.remoteId);
  if (!known) return store.upsert(message);
  // Message DÉJÀ connu : seule une ÉDITION ou une SUPPRESSION justifie une écriture
  // (mise à jour sur place). Sinon : doublon, aucune I/O.
  const previous = store.message(conversationId, message.remoteId);
  const deletedNow = message.deleted === true;
  const editedNow = message.editedAt !== undefined && message.editedAt !== previous?.editedAt;
  if (!deletedNow && !editedNow) return "doublon";
  const merged: RemoteMessage = {
    ...(previous ?? message),
    ...message,
    // ⚠️ Le texte d'origine est CONSERVÉ si la plateforme ne le renvoie plus
    // (cas d'une suppression, dont la charge utile est partielle).
    text:
      message.text !== "" && !isDeletedNotice(message.text)
        ? message.text
        : previous?.text ?? message.text,
    ...(previous?.threadRootId !== undefined ? { threadRootId: previous.threadRootId } : {}),
    // ⚠️ Les PIÈCES JOINTES connues survivent à une charge partielle (un événement
    // `MESSAGE_UPDATE` ne les transporte pas toujours).
    ...(message.attachments === undefined && previous?.attachments !== undefined
      ? { attachments: previous.attachments }
      : {}),
  };
  return store.update(merged);
}

/**
 * Ingère un post Mattermost dans le miroir.
 *
 * ⚠️ Le controle d'idempotence est fait dans `applyMessageToMirror`, pas par l'appelant :
 * on veut pouvoir le DIRE (`doublon`) sans écrire.
 */
export function ingestPost(
  store: ChatMirrorStore,
  post: MattermostPost,
  ctx: IngestContext,
): IngestOutcome {
  if (typeof post?.id !== "string" || post.id === "") return "ignore";
  return applyMessageToMirror(store, ctx.conversationId, postToRemoteMessage(post, ctx));
}

// ─── Discord (lot 21) ──────────────────────────────────────────────────────

/**
 * Contexte d'ingestion d'un message Discord.
 *
 * ⚠️ `conversationId` vient du SALON, pas du message : un message posté dans un FIL est
 * rangé dans la conversation de son SALON PARENT, avec le fil comme `threadRootId`. Un
 * fil n'est pas une conversation (décision du lot 21).
 */
export interface DiscordIngestContext {
  /** Conversation Yuki du salon parent (`dc-<channelId>`). */
  conversationId: string;
  /** Identifiant du compte BOT de Yuki (ses messages deviennent `assistant`). */
  botUserId?: string;
  /** Identifiant du message RACINE du fil, quand le message vient d'un fil. */
  threadRootId?: string;
}

/** Nom affichable d'un auteur Discord (jamais vide, jamais un identifiant nu). */
export function discordAuthorNameOf(author: { id: string; username?: string; global_name?: string | null }): string {
  for (const candidate of [author.global_name, author.username]) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return author.id;
}

/** Pièces jointes d'un message Discord (métadonnées DÉJÀ fournies, sans appel d'API). */
export function discordAttachmentsOf(message: Pick<DiscordMessage, "attachments">): RemoteAttachment[] {
  const raw = message.attachments;
  if (!Array.isArray(raw)) return [];
  const out: RemoteAttachment[] = [];
  for (const value of raw) {
    if (typeof value !== "object" || value === null) continue;
    const candidate = value as { id?: unknown; filename?: unknown; size?: unknown; content_type?: unknown; url?: unknown };
    if (typeof candidate.id !== "string" || candidate.id === "") continue;
    if (out.some((item) => item.id === candidate.id)) continue;
    out.push({
      id: candidate.id,
      nom:
        typeof candidate.filename === "string" && candidate.filename !== ""
          ? candidate.filename
          : candidate.id,
      ...(typeof candidate.size === "number" && candidate.size >= 0 ? { taille: candidate.size } : {}),
      ...(typeof candidate.content_type === "string" && candidate.content_type !== ""
        ? { mime: candidate.content_type }
        : {}),
      ...(typeof candidate.url === "string" && candidate.url !== "" ? { url: candidate.url } : {}),
    });
  }
  return out;
}

/**
 * Convertit un message Discord en message commun.
 *
 * ⚠️ `threadRootId` : dans un FIL, l'identifiant du fil EST celui du message racine
 * (`channel.mdx` — « The id of the created thread will be the same as the id of the
 * source message »). Le fil est donc le parent de ses propres messages, et sa
 * conversation reste celle du SALON qui le contient.
 */
export function discordMessageToRemoteMessage(
  message: DiscordMessage,
  ctx: DiscordIngestContext,
): RemoteMessage {
  const auteur = message.author;
  const id = typeof auteur?.id === "string" && auteur.id !== "" ? auteur.id : "inconnu";
  const author: RemoteAuthor = {
    id,
    nom: auteur ? discordAuthorNameOf({ id, ...(auteur.username !== undefined ? { username: auteur.username } : {}), ...(auteur.global_name !== undefined ? { global_name: auteur.global_name } : {}) }) : id,
    // ⚠️ `author.bot` couvre les AUTRES robots ; `botUserId` couvre Yuki elle-même.
    estBot: auteur?.bot === true || (ctx.botUserId !== undefined && id === ctx.botUserId),
  };
  const deleted = message.content === undefined && message.attachments === undefined && message.timestamp === undefined;
  const attachments = discordAttachmentsOf(message);
  const reference = message.message_reference?.message_id;
  const threadRootId =
    ctx.threadRootId ?? (typeof reference === "string" && reference !== "" ? reference : undefined);
  const editedAt = typeof message.edited_timestamp === "string" && message.edited_timestamp !== ""
    ? message.edited_timestamp
    : undefined;
  return {
    remoteId: message.id,
    conversationId: ctx.conversationId,
    ...(threadRootId !== undefined ? { threadRootId } : {}),
    author,
    role: ctx.botUserId !== undefined && id === ctx.botUserId ? "assistant" : "user",
    text: deleted ? deletedNoticeOf("discord") : message.content ?? "",
    sentAt:
      typeof message.timestamp === "string" && message.timestamp !== ""
        ? message.timestamp
        : new Date(0).toISOString(),
    ...(editedAt !== undefined ? { editedAt } : {}),
    ...(deleted ? { deleted: true } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/**
 * Ingère un message Discord dans le miroir.
 *
 * ⚠️ `MESSAGE_DELETE` n'envoie que `{ id, channel_id }` : `discordMessageToRemoteMessage`
 * en fait un message marqué `deleted`, dont le TEXTE d'origine est conservé par
 * `applyMessageToMirror` (on ne réécrit pas l'histoire).
 */
export function ingestDiscordMessage(
  store: ChatMirrorStore,
  message: DiscordMessage,
  ctx: DiscordIngestContext,
): IngestOutcome {
  if (typeof message?.id !== "string" || message.id === "") return "ignore";
  return applyMessageToMirror(store, ctx.conversationId, discordMessageToRemoteMessage(message, ctx));
}

/** Conversation Yuki d'un salon Discord (`dc-<channelId>`). */
export function conversationIdOfDiscordChannel(channelId: string): string {
  return mirrorConversationId("discord", channelId);
}

/** Conversation Yuki d'un canal Mattermost (`mm-<channelId>`). */
export function conversationIdOfChannel(channelId: string): string {
  return mirrorConversationId("mattermost", channelId);
}
