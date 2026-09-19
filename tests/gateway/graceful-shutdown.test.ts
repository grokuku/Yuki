/**
 * Code de sortie émis par l'arrêt gracieux selon le motif.
 *
 * Le chemin « redémarrage demandé » (`POST /api/admin/restart`, motif
 * `RESTART`) sort en **75** : le superviseur interne relance alors le programme
 * SANS redémarrer le conteneur. Tous les autres motifs (`SIGTERM`/`SIGINT`,
 * `docker compose stop`) sortent en **0** — le conteneur ne doit pas être
 * relancé après un arrêt volontaire.
 *
 * `exit` est injecté : le processus de test n'est jamais tué.
 */

import { createServer as createHttpServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  installGracefulShutdown,
  RESTART_EXIT_CODE,
  RESTART_REASON,
} from "../../src/gateway/server.js";
import { createLogger } from "../../src/observability/logger.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
});

interface Harness {
  trigger: (reason: string) => void;
  exitCode: Promise<number>;
}

/** Serveur en écoute + déclencheur d'arrêt dont la sortie est capturée. */
function setup(): Promise<Harness> {
  return new Promise((resolve) => {
    const server = createHttpServer();
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      let resolveCode: (code: number) => void = () => {};
      const exitCode = new Promise<number>((r) => {
        resolveCode = r;
      });
      const trigger = installGracefulShutdown(server, logger, {
        registerSignals: false,
        exit: (code) => resolveCode(code),
        beforeClose: async () => {},
      });
      resolve({ trigger, exitCode });
    });
  });
}

describe("installGracefulShutdown — code de sortie par motif", () => {
  it("le motif RESTART (bouton /api/admin/restart) sort avec le code 75", async () => {
    expect(RESTART_REASON).toBe("RESTART");
    expect(RESTART_EXIT_CODE).toBe(75);
    const { trigger, exitCode } = await setup();
    trigger(RESTART_REASON);
    await expect(exitCode).resolves.toBe(RESTART_EXIT_CODE);
  });

  it("SIGTERM (docker compose stop) sort avec 0 — aucune relance", async () => {
    const { trigger, exitCode } = await setup();
    trigger("SIGTERM");
    await expect(exitCode).resolves.toBe(0);
  });

  it("SIGINT sort avec 0", async () => {
    const { trigger, exitCode } = await setup();
    trigger("SIGINT");
    await expect(exitCode).resolves.toBe(0);
  });
});
