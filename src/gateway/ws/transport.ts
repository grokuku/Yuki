/**
 * Abstraction `Transport`.
 *
 * Le Lot 1 ne fournit qu'une implémentation WebSocket (`./server.ts`). Cette
 * surface est conçue pour accueillir un `SseTransport` ultérieur réutilisant
 * `./session-stream.ts` sans refonte : la logique de buffer/seq/rejeu est
 * indépendante du protocole de transport.
 */

import type { Server } from "node:http";

export type TransportProtocol = "ws" | "sse";

/**
 * Présence déclarée par un client connecté — sert à la DÉCISION anti-spam des
 * notifications (voir `src/push/decision.ts`).
 *  - `sessionId` : conversation FOCALISÉE (celle que l'utilisateur regarde) ;
 *  - `visible` : onglet affiché (`visibilityState === "visible"`) ;
 *  - `focused` : fenêtre au premier plan (`document.hasFocus()`).
 *
 * ⚠️ « connecté » ≠ « regarde » : un onglet en arrière-plan reste connecté mais
 * `visible` vaut `false`. On ne déduit donc jamais la présence de la connexion.
 */
export interface PresenceView {
  sessionId: string | null;
  visible: boolean;
  focused: boolean;
}

export interface TransportStats {
  /** Nombre de clients connectés. */
  clients: number;
  /** Capacité configurée du buffer de rejeu (en trames). */
  replayBufferSize: number;
  /** Capacité configurée du buffer de rejeu (en octets). */
  replayBufferBytes: number;
}

export interface Transport {
  readonly protocol: TransportProtocol;
  /** Enregistre le point d'entrée sur le serveur HTTP (ex. hook `upgrade`). */
  attach(server: Server): void;
  /** Nombre de clients connectés. */
  clientCount(): number;
  /**
   * Présence des clients connectés (état DÉCLARÉ par chacun). Un transport qui
   * ne la connaît pas renvoie une liste vide : la décision de notification
   * reste correcte (aucun client « regarde » ⇒ on notifie).
   */
  presenceView?(): PresenceView[];
  stats(): TransportStats;
  /** Ferme proprement toutes les connexions avant `server.close()`. */
  close(): Promise<void>;
}
