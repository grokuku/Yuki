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

import { DELETED_NOTICE, type ChatMirrorStore } from "./store.js";
import {
  isoOf,
  type MattermostPost,
  type MattermostUser,
} from "../mattermost/types.js";
import type { RemoteAuthor, RemoteMessage, RemotePlatform } from "../types.js";
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
  const text = deleted && (post.message ?? "") === "" ? DELETED_NOTICE : post.message ?? "";
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
  };
}

/**
 * Ingère un post dans le miroir.
 *
 * ⚠️ Le controle d'idempotence est fait ICI, pas par l'appelant : `upsert` refuse
 * déjà un doublon, mais on veut pouvoir le DIRE (`doublon`) sans écrire.
 */
export function ingestPost(
  store: ChatMirrorStore,
  post: MattermostPost,
  ctx: IngestContext,
): IngestOutcome {
  if (typeof post?.id !== "string" || post.id === "") return "ignore";
  const known = store.has(ctx.conversationId, post.id);
  const message = postToRemoteMessage(post, ctx);
  if (known) {
    // Message DÉJÀ connu : seule une ÉDITION ou une SUPPRESSION justifie une
    // écriture (mise à jour sur place). Sinon : doublon, aucune I/O.
    const previous = store.message(ctx.conversationId, post.id);
    const deletedNow = message.deleted === true;
    const editedNow =
      message.editedAt !== undefined && message.editedAt !== previous?.editedAt;
    if (!deletedNow && !editedNow) return "doublon";
    const merged: RemoteMessage = {
      ...(previous ?? message),
      ...message,
      // ⚠️ Le texte d'origine est CONSERVÉ si la plateforme ne le renvoie plus
      // (cas d'un `post_deleted`, dont la charge utile est partielle).
      text:
        message.text !== "" && message.text !== DELETED_NOTICE
          ? message.text
          : previous?.text ?? DELETED_NOTICE,
      ...(previous?.threadRootId !== undefined
        ? { threadRootId: previous.threadRootId }
        : {}),
    };
    return store.update(merged);
  }
  return store.upsert(message);
}

/** Conversation Yuki d'un canal Mattermost (`mm-<channelId>`). */
export function conversationIdOfChannel(channelId: string): string {
  return mirrorConversationId("mattermost", channelId);
}
