#!/usr/bin/env node
/**
 * Superviseur minimal du gateway Yuki — Node, aucune dépendance.
 *
 * Rôle : lancer `node dist/index.js` en PROCESSUS ENFANT et le RELANCER quand
 * il sort avec le code convenu **75** (`EX_TEMPFAIL`) — le code que le chemin
 * « redémarrage demandé » (`POST /api/admin/restart`) émet. Yuki redémarre donc
 * son programme À L'INTÉRIEUR du conteneur, sans le redémarrer et sans jamais
 * accéder au socket Docker.
 *
 * Tout AUTRE code de sortie (crash, refus de démarrage, `docker compose stop`)
 * est PROPAGÉ puis le superviseur termine : une vraie panne n'est JAMAIS
 * masquée. `SIGTERM`/`SIGINT` sont relayés à l'enfant (on attend sa fin) afin
 * que `docker compose stop` reste propre et rapide.
 *
 * Aucune écriture disque (rootfs read-only) : uniquement stdout/stderr.
 *
 * Le script de l'enfant peut être surchargé par `argv[2]` (utilisé par les
 * tests, qui injectent un faux enfant au lieu de tuer le processus de test).
 */

import { spawn } from "node:child_process";

/** Code de sortie signifiant « redémarrage demandé » (`EX_TEMPFAIL`). */
const RESTART_EXIT_CODE = 75;
/** Garde-fou anti-boucle : nombre maximal de relances RAPPROCHÉES autorisées. */
const MAX_RAPID_RESTARTS = Number(process.env.YUKI_SUPERVISOR_MAX_RESTARTS ?? 5);
/** En deçà de cette durée de vie, une relance est jugée « rapprochée ». */
const RAPID_RESTART_MS = Number(process.env.YUKI_SUPERVISOR_RAPID_MS ?? 2_000);

/** Enfant par défaut : `dist/index.js` à côté du superviseur (image : /app). */
const DEFAULT_ENTRY = new URL("../../dist/index.js", import.meta.url).pathname;

let child;
let stopping = false;
let rapidRestarts = 0;

function log(message) {
  process.stdout.write(`[supervisor] ${new Date().toISOString()} ${message}\n`);
}

function launch() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [process.argv[2] ?? DEFAULT_ENTRY], { stdio: "inherit" });

  child.on("exit", (code, signal) => {
    if (stopping) {
      log(`enfant arrêté (${signal ?? `code ${code}`}) — sortie du superviseur`);
      process.exit(code ?? 0);
    }
    if (code !== RESTART_EXIT_CODE) {
      log(`enfant sorti (${signal ?? `code ${code}`}) — pas de relance (panne)`);
      process.exit(code ?? 1);
    }
    if (Date.now() - startedAt < RAPID_RESTART_MS) {
      if (++rapidRestarts > MAX_RAPID_RESTARTS) {
        log(`boucle détectée (${rapidRestarts} × code ${RESTART_EXIT_CODE} rapprochés) — abandon`);
        process.exit(1);
      }
    } else {
      rapidRestarts = 0;
    }
    log(`redémarrage demandé (code ${RESTART_EXIT_CODE}) — relance de l'enfant`);
    launch();
  });
}

process.on("SIGTERM", () => {
  stopping = true;
  child?.kill("SIGTERM");
});
process.on("SIGINT", () => {
  stopping = true;
  child?.kill("SIGINT");
});

launch();
