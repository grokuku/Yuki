/**
 * Serveur HTTP : création, écoute, transport temps réel et arrêt gracieux.
 */

import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Logger } from "../observability/logger.js";
import { createApp, type AppContext } from "./app.js";
import type { Transport } from "./ws/transport.js";

/**
 * Crée le serveur HTTP à partir du contexte applicatif et, si fourni, y
 * enregistre le transport temps réel (hook `upgrade`).
 */
export function createServer(context: AppContext, transport?: Transport): Server {
  const server = createHttpServer(createApp(context));
  transport?.attach(server);
  return server;
}

/** Démarre l'écoute et résout quand le port est effectivement ouvert. */
export function startServer(
  server: Server,
  host: string,
  port: number,
): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve(server.address() as AddressInfo);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export interface ShutdownOptions {
  /** Durée avant sortie forcée. */
  timeoutMs?: number;
  /**
   * Fermetures à effectuer AVANT `server.close()` (ex. fermer les sockets WS
   * puis le PiHost). Chaque hook est isolé : un échec n'empêche pas les autres.
   */
  beforeClose?: () => Promise<void>;
}

/**
 * Installe l'arrêt gracieux : SIGTERM/SIGINT ferment d'abord le transport
 * (sockets WS), puis le serveur HTTP, puis forcent la sortie après
 * `timeoutMs` si des connexions traînent.
 */
export function installGracefulShutdown(
  server: Server,
  logger: Logger,
  options: ShutdownOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("gateway.shutdown", { signal });
    const force = setTimeout(() => {
      logger.warn("gateway.shutdown forced", { signal, timeoutMs });
      process.exit(0);
    }, timeoutMs);
    force.unref();

    const closeHttp = (): void => {
      server.close((error) => {
        if (error) {
          logger.error("gateway.shutdown error", { signal, error: error.message });
        }
        clearTimeout(force);
        logger.info("gateway.stopped", { signal });
        process.exit(error ? 1 : 0);
      });
      server.closeIdleConnections?.();
    };

    const before = options.beforeClose;
    if (!before) {
      closeHttp();
      return;
    }
    before()
      .catch((error: unknown) => {
        logger.error("gateway.shutdown hook error", {
          signal,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(closeHttp);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
