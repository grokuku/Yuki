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
  stats(): TransportStats;
  /** Ferme proprement toutes les connexions avant `server.close()`. */
  close(): Promise<void>;
}
