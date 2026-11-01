/**
 * MIROIR des conversations distantes — identifiants et projection en transcript
 * (lot 18, lot 1).
 *
 * ⚠️ Ce fichier ne STOCKE rien : le stockage (`chat-mirror.json` +
 * `chat-mirror/<conversationId>.jsonl`) et la synchronisation sont le LOT 2. Il
 * fixe les deux choses dont dépendent déjà l'interface et le transport :
 *  1. la FORME des identifiants de conversation miroir (`mm-…`, `dc-…`) ;
 *  2. la PROJECTION d'un message distant en entrée de transcript, pour qu'un
 *     miroir s'affiche dans le fil EXISTANT avec les mêmes bulles.
 */

import type { TranscriptEntry } from "../pi/types.js";
import {
  REMOTE_PLATFORMS,
  type RemoteConversation,
  type RemoteMessage,
  type RemotePlatform,
} from "./types.js";

/**
 * Préfixes d'identifiant, PAR plateforme.
 *
 * ⚠️ Le préfixe est la SEULE chose qui distingue un miroir d'une session Pi :
 * c'est lui qui déclenche les refus d'écriture (`conversation_lecture_seule`) et
 * le chemin de sélection dédié. Il ne doit donc jamais changer sans migration.
 */
export const MIRROR_ID_PREFIX: Record<RemotePlatform, string> = {
  mattermost: "mm-",
  discord: "dc-",
};

/** Identifiant Yuki d'une conversation miroir (`mm-<channelId>`). */
export function mirrorConversationId(platform: RemotePlatform, remoteId: string): string {
  return `${MIRROR_ID_PREFIX[platform]}${remoteId}`;
}

/** Plateforme d'un identifiant miroir, ou `null` si ce n'en est pas un. */
export function mirrorPlatformOf(id: string): RemotePlatform | null {
  for (const platform of REMOTE_PLATFORMS) {
    if (id.startsWith(MIRROR_ID_PREFIX[platform])) return platform;
  }
  return null;
}

/** `true` si l'identifiant désigne une conversation MIROIR (lecture seule). */
export function isMirrorConversationId(id: string | undefined | null): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  return mirrorPlatformOf(id) !== null;
}

/**
 * Accès au miroir (LECTURE SEULE).
 *
 * ⚠️ Au lot 1, l'implémentation livrée est VIDE (`emptyChatMirror`) : aucune
 * synchronisation n'existe. L'interface et le transport consomment malgré tout
 * cette interface, donc le lot 2 n'aura qu'à fournir une implémentation — aucun
 * chemin de code ne sera réécrit.
 */
export interface ChatMirror {
  /** Conversations miroir disponibles (ordre indifférent : le transport trie). */
  conversations(): readonly RemoteConversation[];
  /** Messages d'une conversation miroir, en ordre CHRONOLOGIQUE. */
  messages(conversationId: string): readonly RemoteMessage[];
}

/** Miroir VIDE (lot 1) : aucune conversation, aucun message. */
export function emptyChatMirror(): ChatMirror {
  return {
    conversations: () => [],
    messages: () => [],
  };
}

/** Instant ISO → ms Unix, ou `undefined` si la valeur n'est pas exploitable. */
function timestampOf(iso: string | undefined): number | undefined {
  if (typeof iso !== "string" || iso.length === 0) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/**
 * Projette un message distant en entrée de transcript.
 *
 * ⚠️ L'AUTEUR et le PARENT sont conservés : sans eux, un canal miroir afficherait
 * tous les humains comme « l'utilisateur » et perdrait les fils. Un message
 * SUPPRIMÉ reste visible avec la mention explicite du texte : une suppression
 * chez la plateforme ne doit pas faire disparaître une ligne du fil sans le dire.
 */
export function remoteMessageToTranscript(message: RemoteMessage): TranscriptEntry {
  const timestamp = timestampOf(message.sentAt);
  const edited = message.editedAt !== undefined ? " (modifié)" : "";
  const text = message.deleted === true ? `(message supprimé)${edited}` : `${message.text}${edited}`;
  return {
    role: message.role,
    text,
    ...(timestamp !== undefined ? { timestamp } : {}),
    id: message.remoteId,
    author: { ...message.author },
    ...(message.threadRootId !== undefined ? { threadRootId: message.threadRootId } : {}),
  };
}

/** Transcript d'une conversation miroir (vide si elle est inconnue). */
export function mirrorTranscript(
  mirror: ChatMirror,
  conversationId: string,
): TranscriptEntry[] {
  return mirror.messages(conversationId).map(remoteMessageToTranscript);
}
