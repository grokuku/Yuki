/**
 * Harnais E2E JETABLE — ENVOI ET RÉCEPTION DE FICHIERS.
 *
 * Gateway RÉEL (routes HTTP + transport WS + UI réelle) avec un hôte Pi RÉEL
 * hors ligne, un stockage de fichiers RÉEL (répertoire temporaire) et une HORLOGE
 * INJECTABLE : l'expiration à 30 jours se teste sans attendre.
 *
 * Trois endpoints JETABLES (hors application) :
 *   - `POST /e2e/advance-days?d=N` : avance l'horloge de N jours puis PURGE ;
 *     renvoie le nombre de fichiers supprimés.
 *   - `POST /e2e/send-file` : fait ENVOYER par Yuki le dernier fichier de la
 *     conversation (CAS A : elle renvoie un fichier reçu) → trame `file_sent`.
 *   - `GET  /e2e/state` : métadonnées du stockage (identifiants, noms) — jamais
 *     un contenu.
 *
 * ⚠️ Ne produit AUCUNE capture PNG suivie (le dossier de captures du E2E est
 * temporaire).
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-files-serve.ts"
 * Env :
 *   YUKI_E2E_FILES_DIR     dossier d'état (OBLIGATOIRE).
 *   YUKI_E2E_MAX_BYTES     plafond par fichier (défaut 2 Gio ; le E2E le baisse
 *                          pour prouver le REFUS).
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost } from "../../src/pi/host.js";
import { createFilesService, FilesStore } from "../../src/files/index.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_FILES_DIR;
if (!stateDir) throw new Error("YUKI_E2E_FILES_DIR requis");
const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
const filesDir = join(stateDir, "files");
for (const dir of [agentDir, cwd, sessionsDir, filesDir]) mkdirSync(dir, { recursive: true });

const maxBytes = Number(process.env.YUKI_E2E_MAX_BYTES ?? 2 * 1024 * 1024 * 1024);

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
  YUKI_FILES_DIR: filesDir,
});

const host = createPiHost({
  agentDir,
  cwd,
  home: join(stateDir, "home"),
  sessionsDir,
  systemPrompt: "# Yuki\n\nAssistant de test E2E.\n",
  settingsSeedPath: "config/pi/settings.json",
  logger,
});
await host.start();

const sessionId = host.currentSessionId();
if (!sessionId) throw new Error("aucune session courante");

/**
 * SONDE du TEXTE RÉELLEMENT TRANSMIS AU SDK.
 *
 * ⚠️ Le modèle est HORS LIGNE dans ce harnais : le SDK rejette le prompt, donc
 * rien n'est écrit dans le fichier de session. On observe donc le TEXTE EXACT que
 * la façade `send` reçoit — c'est précisément ce que le SDK transmet au modèle
 * (bloc `<fichiers>` compris). Aucune valeur n'est inventée : c'est une
 * interception de l'appel réel.
 */
let lastPrompt = "";
const originalSend = host.send.bind(host);
host.send = ((target: string, text: string, opts?: Parameters<typeof originalSend>[2]) => {
  lastPrompt = text;
  return originalSend(target, text, opts);
}) as typeof host.send;

/* ─── Stockage RÉEL, horloge INJECTABLE, bornes baissées pour le E2E ──────── */
let clock = Date.now();
const store = new FilesStore({
  dir: filesDir,
  logger,
  now: () => clock,
  maxBytes: () => maxBytes,
  retentionDays: () => 30,
});
store.ensureLayout();
const files = createFilesService({
  store,
  logger,
  maxAttachments: () => 5,
  // Borne d'injection BASSE : la troncature est ainsi prouvable en E2E.
  promptChars: () => 2000,
  promptTotalChars: () => 4000,
});

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  files,
});

const context: AppContext = {
  env,
  report: {} as GpuReport,
  gatePassed: true,
  startedAt: Date.now(),
  volumes: [],
  publicDir: "public/ui",
  files: { service: files, logger },
};

const app = createApp(context);
const server = createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/e2e/advance-days") {
    const days = Number(url.searchParams.get("d") ?? "31");
    clock += days * 86_400_000;
    const purged = store.purgeExpired();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ purged, clock: new Date(clock).toISOString() }));
    return;
  }
  if (url.pathname === "/e2e/send-file") {
    const available = files.listForSession(sessionId);
    const wanted = url.searchParams.get("name");
    const last = wanted
      ? available.find((file) => file.name === wanted)
      : available[available.length - 1];
    if (!last) {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no_file", sessionId, wanted }));
      return;
    }
    const sent = files.send(sessionId, last.id);
    res.writeHead(sent ? 200 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify({ sent, count: available.length }));
    return;
  }
  if (url.pathname === "/e2e/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        sessionId,
        maxBytes,
        lastPrompt,
        files: files.listForSession(sessionId).map((file) => ({
          id: file.id,
          name: file.name,
          bytes: file.bytes,
          kind: file.kind,
          readable: file.readable,
          url: file.url,
        })),
      }),
    );
    return;
  }
  app(req, res);
});
transport.attach(server);
server.listen(0, "127.0.0.1", () => {
  const address = server.address() as AddressInfo;
  console.log(`READY http://127.0.0.1:${address.port}`);
});
setInterval(() => {}, 1 << 30);
