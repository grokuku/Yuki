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

/**
 * Motif d'arrêt déclenché par la route `POST /api/admin/restart`.
 * C'est le SEUL motif qui termine avec `RESTART_EXIT_CODE`.
 */
export const RESTART_REASON = "RESTART";
/**
 * Code de sortie signifiant « redémarrage demandé » (`EX_TEMPFAIL`). Le
 * superviseur interne (`infra/gateway/supervisor.mjs`) le reconnait et relance
 * le programme SANS redémarrer le conteneur. Les autres chemins de sortie
 * (erreur fatale, `docker compose stop`) gardent leur code : c'est ce qui
 * distingue un redémarrage demandé d'un échec.
 */
export const RESTART_EXIT_CODE = 75;

export interface ShutdownOptions {
  /** Durée avant sortie forcée. */
  timeoutMs?: number;
  /**
   * Fermetures à effectuer AVANT `server.close()` (ex. fermer les sockets WS
   * puis le PiHost). Chaque hook est isolé : un échec n'empêche pas les autres.
   */
  beforeClose?: () => Promise<void>;
  /**
   * Sortie finale du processus. Injectable pour les tests (défaut :
   * `process.exit`), afin de vérifier le code émis sans tuer le test.
   */
  exit?: (code: number) => void;
  /**
   * Installe les écouteurs `SIGTERM`/`SIGINT`. `false` dans les tests pour
   * éviter d'accumuler des écouteurs sur le processus de test.
   */
  registerSignals?: boolean;
}

/**
 * Déclencheur d'arrêt gracieux. `reason` apparaît dans les journaux (signaux
 * `SIGTERM`/`SIGINT`, ou `RESTART` pour la route d'administration) et détermine
 * le code de sortie : `RESTART` ⇒ 75, tout le reste ⇒ 0.
 */
export type ShutdownTrigger = (reason: string) => void;

/**
 * Installe l'arrêt gracieux : SIGTERM/SIGINT (et un déclencheur programmatique,
 * ex. `POST /api/admin/restart`) ferment d'abord le transport (sockets WS), puis
 * le serveur HTTP, puis forcent la sortie après `timeoutMs` si des connexions
 * traînent. Le motif `RESTART` sort avec `RESTART_EXIT_CODE` (75), les autres
 * avec 0. Renvoie le déclencheur (testable / réutilisable par l'administration).
 */
export function installGracefulShutdown(
  server: Server,
  logger: Logger,
  options: ShutdownOptions = {},
): ShutdownTrigger {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const exit =
    options.exit ??
    ((code: number): void => {
      process.exit(code);
    });
  let shuttingDown = false;

  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("gateway.shutdown", { signal: reason });
    // Code de sortie : 75 UNIQUEMENT sur le chemin « redémarrage demandé »
    // (le superviseur interne relance alors le programme). Tous les autres
    // motifs (SIGTERM/SIGINT, `docker compose stop`) sortent en 0 : le
    // conteneur ne doit PAS être relancé après un arrêt volontaire.
    const code = reason === RESTART_REASON ? RESTART_EXIT_CODE : 0;
    const force = setTimeout(() => {
      logger.warn("gateway.shutdown forced", { signal: reason, timeoutMs });
      exit(code);
    }, timeoutMs);
    force.unref();

    const closeHttp = (): void => {
      server.close((error) => {
        if (error) {
          logger.error("gateway.shutdown error", { signal: reason, error: error.message });
        }
        clearTimeout(force);
        logger.info("gateway.stopped", { signal: reason, exitCode: error ? 1 : code });
        exit(error ? 1 : code);
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
          signal: reason,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(closeHttp);
  };

  if (options.registerSignals !== false) {
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  }
  return shutdown;
}
