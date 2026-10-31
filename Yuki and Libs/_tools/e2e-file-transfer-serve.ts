/**
 * Harnais E2E JETABLE — TRANSFERT DE FICHIERS DEPUIS UNE MACHINE (agent).
 *
 * Gateway RÉEL (routes HTTP + transport WS + UI réelle) avec un hôte Pi RÉEL
 * hors ligne, un stockage de fichiers RÉEL (répertoire temporaire), un service
 * de TRANSFERT RÉEL (`AgentFileTransferService`) et un FAUX AGENT qui sert un
 * fichier en réponse à un `file_get`.
 *
 * ⚠️ Ce harnais ne monte AUCUN serveur mTLS : le faux agent est un
 * `AgentConnection` alimenté directement par une paire de WebSocket en mémoire
 * (`ws` côté serveur et côté agent branchés l'un sur l'autre via un `Duplex`
 * factice). C'est suffisant pour exercer la CHAÎNE COMPLÈTE
 * `transfer.get` → `file_get`/`file_chunk` → écriture sur disque → trame de
 * contrôle `file_received` → carte « Inclure dans la discussion ».
 *
 * Endpoints JETABLES (hors application) :
 *   - `POST /e2e/fetch-file?path=/chemin/absolu` : demande le RÉCUPÉRATION d'un
 *     fichier depuis la machine simulée. Le faux agent sert un contenu FIXE
 *     (« contenu du fichier distant\n »).
 *   - `GET  /e2e/state` : métadonnées du stockage (identifiants, noms) — jamais
 *     un contenu.
 *
 * Usage : cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-file-transfer-serve.ts"
 * Env : YUKI_E2E_FILES_DIR (dossier d'état, OBLIGATOIRE).
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { createServer as createHttpServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

import { loadEnv } from "../../src/config/env.js";
import { createApp, type AppContext } from "../../src/gateway/app.js";
import { createWsTransport } from "../../src/gateway/ws/server.js";
import { createLogger } from "../../src/observability/logger.js";
import { createPiHost } from "../../src/pi/host.js";
import { createFilesService, FilesStore } from "../../src/files/index.js";
import {
  AgentFileTransferService,
  AgentHub,
  AgentStore,
  AuditLog,
  maxSizeBytesFromMb,
} from "../../src/agents/index.js";
import { AgentConnection } from "../../src/agents/connection.js";
import type { GpuReport } from "../../src/types/gpu.js";

const stateDir = process.env.YUKI_E2E_FILES_DIR;
if (!stateDir) throw new Error("YUKI_E2E_FILES_DIR requis");
const agentDir = join(stateDir, "agent");
const cwd = join(stateDir, "workspace");
const sessionsDir = join(agentDir, "sessions");
const filesDir = join(stateDir, "files");
for (const dir of [agentDir, cwd, sessionsDir, filesDir]) mkdirSync(dir, { recursive: true });

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

const store = new FilesStore({
  dir: filesDir,
  logger,
  maxBytes: () => 64 * 1024 * 1024,
  retentionDays: () => 30,
});
store.ensureLayout();
const files = createFilesService({
  store,
  logger,
  maxAttachments: () => 5,
  promptChars: () => 2000,
  promptTotalChars: () => 4000,
  imageMaxBytes: () => 3_500_000,
});

/* ─── Faux agent : un WebSocket en mémoire alimenté par l'autre bout ─────── */
const agentStore = AgentStore.open({
  path: join(stateDir, "agents.jsonl"),
  defaults: { level: "never", privilege: "normal" },
  logger,
});
const audit = AuditLog.open({
  path: join(stateDir, "audit.jsonl"),
  maxSizeBytes: maxSizeBytesFromMb(1),
  retentionDays: 30,
  logger,
});

/** Contenu servi par la machine simulée (fixe, vérifiable). */
const REMOTE_CONTENT = Buffer.from("contenu du fichier distant\n", "utf8");

const hub = new AgentHub({ logger });

// ⚠️ Vraie paire WebSocketServer/WebSocket en BOUCLE LOCALE, sans TLS ni
// certificat (ce harnais n'exerce PAS la couche mTLS, déjà couverte par
// `tests/agents/transfer.test.ts`) : il exerce la CHAÎNE applicative complète.
const wsServer = new (await import("ws")).WebSocketServer({ port: 0, host: "127.0.0.1" });
const wsPort = await new Promise<number>((resolve) => {
  wsServer.once("listening", () => {
    const address = wsServer.address() as AddressInfo;
    resolve(address.port);
  });
});
agentStore.markSeen("fake-agent");

let agentSocket: import("ws").WebSocket | undefined;
const agentConnectionReady = new Promise<void>((resolve) => {
  wsServer.once("connection", (ws) => {
    const connection = new AgentConnection({
      ws,
      agentId: "fake-agent",
      logger,
      onClose: (closed) => hub.unregister(closed),
    });
    hub.register(connection);
    resolve();
  });
});

agentSocket = new (await import("ws")).WebSocket(`ws://127.0.0.1:${wsPort}`);
await new Promise<void>((resolve, reject) => {
  agentSocket!.once("open", () => resolve());
  agentSocket!.once("error", reject);
});
await agentConnectionReady;

// Le faux agent annonce `files` dans son `hello`.
agentSocket.send(
  JSON.stringify({
    type: "hello",
    proto_version: 1,
    agent_id: "fake-agent",
    agent_version: "0.1.0",
    euid: 1000,
    caps: ["exec", "files"],
  }),
);
await new Promise((r) => setTimeout(r, 100));

// Le faux agent répond aux `file_get` en servant REMOTE_CONTENT par morceaux.
agentSocket.on("message", (raw: Buffer) => {
  const frame = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  if (frame.type !== "file_get") return;
  const cmdId = frame.cmd_id as string;
  const offset = typeof frame.offset === "number" ? frame.offset : 0;
  const chunkSize = typeof frame.chunk === "number" ? frame.chunk : 192 * 1024;
  const sha = createHash("sha256").update(REMOTE_CONTENT).digest("hex");
  let seq = 0;
  for (let pos = offset; pos < REMOTE_CONTENT.byteLength; pos += chunkSize) {
    const slice = REMOTE_CONTENT.subarray(pos, Math.min(pos + chunkSize, REMOTE_CONTENT.byteLength));
    const last = pos + slice.byteLength >= REMOTE_CONTENT.byteLength;
    agentSocket!.send(
      JSON.stringify({
        type: "file_chunk",
        proto_version: 1,
        cmd_id: cmdId,
        seq,
        offset: pos,
        data: slice.toString("base64"),
        ...(last ? { dernier: true, total: REMOTE_CONTENT.byteLength, sha256: sha } : {}),
      }),
    );
    seq += 1;
  }
});

const transfers = new AgentFileTransferService({
  store: agentStore,
  hub,
  audit,
  logger,
  files: store,
  limits: {
    maxBytes: () => 64 * 1024 * 1024,
    chunkBytes: () => 192 * 1024,
    timeoutMs: () => 10_000,
  },
});

const transport = createWsTransport({
  host,
  logger,
  serverVersion: "e2e-0.1.0",
  replayBufferSize: 1000,
  replayBufferBytes: 1_000_000,
  files,
  agentTransfers: transfers,
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
  if (url.pathname === "/e2e/fetch-file") {
    const path = url.searchParams.get("path") ?? "/tmp/rapport.txt";
    transfers
      .get({ agentId: "fake-agent", path, sessionId, origin: "recuperer_fichier" })
      .then((outcome) => {
        res.writeHead(outcome.status === "completed" ? 200 : 409, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ status: outcome.status, file: outcome.file ?? null, message: outcome.message }));
      })
      .catch((error: unknown) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    return;
  }
  if (url.pathname === "/e2e/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        sessionId,
        remoteContent: REMOTE_CONTENT.toString("utf8"),
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
