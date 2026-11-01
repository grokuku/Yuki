/**
 * Adaptateur du mode LOCAL (lot 18) : les conversations actuelles de Yuki.
 *
 * ⚠️ Lecture seule SUR LE CONCEPT : cet adaptateur ne fait rien d'autre que
 * DÉCLARER que le mode local n'est pas distant. Les conversations locales ne
 * passent pas par lui (elles vivent dans les sessions Pi, servies par l'hôte) :
 * il n'y a donc aucun risque de double source de vérité.
 *
 * Il existe pour que l'interface et le statut n'aient qu'UN vocabulaire : trois
 * modes, décrits par la même interface.
 */

import type {
  ChatAdapter,
  ChatAdapterStatus,
  ChatFetchOptions,
  ChatFetchPage,
  RemoteConversation,
  RemoteMessage,
} from "./types.js";

/** Motif affiché sous le badge en mode local (jamais une raison d'échec). */
export const LOCAL_MODE_REASON =
  "Mode local : les conversations sont celles de Yuki, aucune plateforme distante.";

export class LocalChatAdapter implements ChatAdapter {
  readonly platform = "local" as const;

  async connect(): Promise<void> {
    // Aucune connexion à ouvrir : les conversations locales existent déjà.
  }

  async disconnect(): Promise<void> {
    // Aucune connexion à fermer.
  }

  status(): ChatAdapterStatus {
    return { etat: "on", raison: LOCAL_MODE_REASON };
  }

  async listConversations(): Promise<RemoteConversation[]> {
    // Aucune conversation DISTANTE : la liste locale vient de l'hôte Pi.
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
