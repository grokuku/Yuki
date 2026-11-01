/**
 * PORT de synchronisation (lot 18, lot 2).
 *
 * ⚠️ Ce contrat est ce qui permet au service de synchronisation d'être TESTÉ sans
 * Mattermost : il ne parle ni jeton, ni HTTP, ni WebSocket. Une plateforme
 * l'implémente (`src/chat/mattermost/adapter.ts`) ; le service orchestre.
 */

import type { ChatAdapterStatus, ChatStateCode, RemoteMessage, RemotePlatform } from "../types.js";

/** Un canal synchronisé (déjà converti en conversation Yuki préfixée). */
export interface ChatSyncChannel {
  /** Conversation Yuki (`mm-<channelId>`). */
  conversationId: string;
  plateforme: RemotePlatform;
  /** Identifiant d'origine chez la plateforme. */
  remoteId: string;
  /** Titre affichable (nom du canal, jamais vide). */
  title: string;
}

/** Ce que le service de synchronisation attend d'une plateforme. */
export interface ChatSyncPlatform {
  /**
   * Identité du compte Yuki chez la plateforme (`users/me`).
   *
   * ⚠️ Le port n'expose VOLONTAIREMENT ni `connect()` ni `disconnect()` : la
   * synchronisation n'ouvre pas la connexion, elle l'UTILISE. Les exposer ici créait un
   * interblocage — `adapter.connect()` → `sync.start()` → `platform.connect()` →
   * `adapter.connect()` → attente de soi-même.
   */
  identity(): Promise<{ id: string; username?: string; displayName?: string }>;
  /** Canaux où Yuki est membre (déjà bornés côté plateforme). */
  channels(): Promise<ChatSyncChannel[]>;
  /**
   * Posts CRÉÉS OU MODIFIÉS depuis `since` (ISO).
   *
   * `historiqueAnterieur` à `true` signifie que la plateforme n'a pas pu tout
   * rendre (borne de son côté) : l'interface doit le DIRE.
   */
  postsSince(
    remoteChannelId: string,
    since: string,
  ): Promise<{ messages: RemoteMessage[]; historiqueAnterieur: boolean }>;
  /** Abonnement temps réel aux nouveaux messages (rend le désabonnement). */
  subscribePosts(listener: (message: RemoteMessage) => void): () => void;
  /** État BRUT de la plateforme (débit, temps réel, erreurs). */
  status(): ChatAdapterStatus;
}

/**
 * État AFFICHABLE, à partir de l'état de la plateforme et de « la synchronisation
 * a-t-elle démarré ? ».
 *
 * ⚠️ Fonction PURE et sans rappel : elle existe pour que la synchronisation n'ait JAMAIS
 * à interroger la plateforme pour calculer son propre statut (ce qui boucherait :
 * `adapter.status()` → `sync.status()` → `plateforme.status()` → `adapter.status()`…).
 *
 *  - plateforme `off` (non configurée) ⇒ `off`, quoi qu'il arrive ;
 *  - plateforme joignable mais synchronisation pas encore démarrée ⇒ `connexion` (le badge
 *    ◐ dit la vérité : configuré, pas encore connecté) ;
 *  - sinon ⇒ l'état de la plateforme.
 */
export function syncEtatOf(base: ChatAdapterStatus, demarre: boolean): ChatStateCode {
  if (base.etat === "off") return "off";
  if (!demarre) return "connexion";
  return base.etat;
}
