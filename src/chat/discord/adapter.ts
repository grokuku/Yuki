/**
 * Adaptateur DISCORD (lot 18) — **stub honnête**.
 *
 * ⚠️ Périmètre : ce mode n'est PAS configuré. L'adaptateur le DIT (`status()
 * ⇒ { etat: "off", raison: "Discord n'est pas encore configuré." }`) et
 * n'implémente rien d'autre : aucune connexion, aucune lecture, aucun envoi.
 *
 * Conséquence côté interface : le mode est proposé (l'utilisateur a demandé les
 * trois modes), mais il affiche un bandeau « non configuré » et la création de
 * conversation y est désactivée — jamais un bouton mort qui ne fait rien.
 */

import type {
  ChatAdapter,
  ChatAdapterStatus,
  ChatFetchOptions,
  ChatFetchPage,
  RemoteConversation,
  RemoteMessage,
} from "../types.js";

/** Raison EXACTE renvoyée par le statut (affichée telle quelle dans l'interface). */
export const DISCORD_NOT_CONFIGURED_REASON = "Discord n'est pas encore configuré.";

export class DiscordChatAdapter implements ChatAdapter {
  readonly platform = "discord" as const;

  async connect(): Promise<void> {
    // Rien à connecter : le mode n'est pas configuré.
  }

  async disconnect(): Promise<void> {
    // Rien à fermer.
  }

  status(): ChatAdapterStatus {
    return { etat: "off", raison: DISCORD_NOT_CONFIGURED_REASON };
  }

  async listConversations(): Promise<RemoteConversation[]> {
    return [];
  }

  async fetchMessages(
    _conversationId: string,
    _options?: ChatFetchOptions,
  ): Promise<ChatFetchPage> {
    return { messages: [] };
  }

  subscribe(
    _conversationId: string,
    _listener: (message: RemoteMessage) => void,
  ): () => void {
    return () => undefined;
  }
}
