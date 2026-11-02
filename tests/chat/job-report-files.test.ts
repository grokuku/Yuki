/**
 * CHAÎNE COMPLÈTE — un JOB qui produit une image ⇒ le fichier est POSTÉ DANS LE
 * CANAL (`POST /files` multipart, puis `POST /posts` avec `file_ids`).
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE (2026-11-02) : le rapport d'un job était
 * PUR TEXTE (`LightWaker.post(conversationId, text)`). Un `delegate` demandé depuis
 * Mattermost qui produisait une image annonçait donc « c'est fait »… et l'image
 * restait dans le store, invisible pour la personne du canal. C'est le prérequis
 * de tout l'objectif « Yuki orchestratrice en canal » : sans transport de fichier,
 * déléguer une image ne sert à rien.
 *
 * Ce que ce fichier prouve, de bout en bout (service de délégation RÉEL, réveil réel,
 * adaptateur Mattermost réel, serveur HTTP fixture) :
 *  ① le worker lourd rend son fichier (`HeavyRunResult.fichiers`) ;
 *  ② le service le JOURNALISE avec le résultat du job (donc il survit à un redémarrage) ;
 *  ③ le réveil le transporte jusqu'à la publication (`LightWaker.send(..., { fichiers })`) ;
 *  ④ l'adaptateur téléverse les octets (multipart) et attache `file_ids` au post.
 *
 * ⚠️ Échoue sur le code d'origine : `JobResult`/`HeavyRunResult`/`LightWaker` n'avaient
 * aucun champ de fichier, et rien ne publiait d'image à la fin d'un job.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createChannelAwareWaker } from "../../src/chat/reply/channel-waker.js";
import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { conversationIdOfChannel } from "../../src/chat/mirror/ingest.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import { createDelegationService } from "../../src/delegation/index.js";
import type { HeavyRunHandle, HeavyWorker } from "../../src/delegation/ports.js";
import { FilesStore } from "../../src/files/index.js";
import { JobQueue } from "../../src/jobs/queue.js";
import { JobStore } from "../../src/jobs/store.js";
import { createLogger } from "../../src/observability/logger.js";

const TOKEN = "jeton-bot-secret-0123456789";
const BOT_ID = "botidentifiant0123456789ab";
const CHANNEL = "canal-1";
const CONVERSATION = conversationIdOfChannel(CHANNEL);

/** PNG 1×1 valide : c'est le fichier « produit par le job ». */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(purpose: string): string {
  const dir = mkdtempSync(join(tmpdir(), `yuki-job-files-${purpose}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Fixture {
  baseUrl: string;
  /** Corps des posts publiés par Yuki. */
  created: Array<Record<string, unknown>>;
  /** Charges multipart des fichiers téléversés. */
  uploads: string[];
}

/** Serveur fixture : `POST /api/v4/files` (multipart) puis `POST /api/v4/posts`. */
async function startFixture(): Promise<Fixture> {
  const created: Array<Record<string, unknown>> = [];
  const uploads: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (url.pathname === "/api/v4/files") {
        uploads.push(`${String(req.headers["content-type"] ?? "")}\n${body}`);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            file_infos: [
              {
                id: `fichier-${uploads.length}`,
                name: "image-du-job.png",
                size: PNG.length,
                mime_type: "image/png",
              },
            ],
          }),
        );
        return;
      }
      if (url.pathname === "/api/v4/posts") {
        const payload = JSON.parse(body || "{}") as Record<string, unknown>;
        created.push(payload);
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `envoye-${created.length}`,
            channel_id: payload.channel_id,
            user_id: BOT_ID,
            message: payload.message,
            root_id: payload.root_id,
            file_ids: payload.file_ids,
            create_at: Date.now(),
          }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "inconnu" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  cleanups.push(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, created, uploads };
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const debut = Date.now();
  while (Date.now() - debut < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Délai dépassé en attendant : ${label}`);
}

/** Worker lourd en double : il a « généré » un fichier déjà présent dans le store. */
function heavyWorkerAvecFichier(fichier: string): HeavyWorker {
  return {
    run(): HeavyRunHandle {
      return {
        promise: Promise.resolve({
          status: "completed" as const,
          text: "J'ai généré l'image demandée.",
          fichiers: [fichier],
        }),
        async cancel(): Promise<void> {},
        async steer(): Promise<string> {
          return "injected";
        },
      } as unknown as HeavyRunHandle;
    },
  };
}

describe("rapport de job — le fichier arrive DANS le canal", () => {
  it("un job qui produit une image la publie : `POST /files` multipart puis `file_ids`", async () => {
    const fixture = await startFixture();

    // ── Le fichier « produit » par le job, dans le store du CANAL ─────────────
    const filesStore = new FilesStore({
      dir: tempDir("files"),
      logger,
      retentionDays: () => 30,
    });
    filesStore.ensureLayout();
    const enregistre = filesStore.saveBytes(PNG, {
      sessionId: CONVERSATION,
      name: "image-du-job.png",
      mimeType: "image/png",
      origin: "yuki",
    });
    expect(enregistre.ok).toBe(true);
    const fichier = enregistre.ok ? enregistre.record.id : "";

    // ── Le miroir et l'ADAPTATEUR réels (le seul chemin de publication) ───────
    const store = ChatMirrorStore.open({
      indexPath: join(tempDir("miroir"), "chat-mirror.json"),
      messagesDir: join(tempDir("miroir-msg"), "chat-mirror"),
    });
    expect(
      store.ensureConversation({
        conversationId: CONVERSATION,
        platform: "mattermost",
        remoteId: CHANNEL,
        title: "Général",
      }),
    ).toBe(true);
    const adapter = new MattermostChatAdapter({
      baseUrl: () => fixture.baseUrl,
      token: () => TOKEN,
      store,
      files: filesStore,
    });

    // ── Service de DÉLÉGATION réel + réveil de canal réel ─────────────────────
    const jobStore = JobStore.open({ path: join(tempDir("jobs"), "jobs.jsonl"), logger });
    const delegation = createDelegationService({
      store: jobStore,
      queue: new JobQueue({ maxConcurrent: 2, maxQueue: 4 }),
      heavy: heavyWorkerAvecFichier(fichier),
      availability: { isAvailable: () => true },
      idleTimeoutMs: 5_000,
      totalTimeoutMs: 5_000,
      // Fenêtre de lotissement nulle : le rapport part au tour suivant la fin.
      resultBatchWindowMs: 0,
      logger,
    });
    delegation.setWaker(
      createChannelAwareWaker({
        fallback: { send: () => undefined },
        summarize: async () => "L'image demandée est prête.",
        // ⚠️ MÊME chemin qu'en production (`envoyerDansCanal`, `src/index.ts`) :
        // un seul mécanisme de publication, jamais un second.
        post: async (conversationId, text, fichiers) => {
          await adapter.send(conversationId, {
            kind: "texte",
            text,
            ...(fichiers && fichiers.length > 0 ? { fichiers } : {}),
          });
        },
        logger,
      }),
    );

    const issue = await delegation.delegate({
      task: "Génère une image d'un chat roux",
      lightSessionId: CONVERSATION,
      background: true,
    });
    expect(issue.status).toBe("dispatched");

    await waitFor(() => fixture.created.length >= 1, "le post du rapport de job");

    // ① ② Le job a bien enregistré son fichier avec son résultat.
    const jobId = issue.status === "dispatched" ? issue.job_id : "";
    const job = jobStore.get(jobId);
    expect(job?.result.fichiers).toEqual([fichier]);

    // ③ ④ L'image est PARTIE : multipart, puis `file_ids` dans le post.
    expect(fixture.uploads).toHaveLength(1);
    expect(fixture.uploads[0]).toContain("multipart/form-data; boundary=");
    expect(fixture.uploads[0]).toContain(CHANNEL);
    const post = fixture.created[0]!;
    expect(post.file_ids).toEqual(["fichier-1"]);
    expect(String(post.message)).toContain("prête");
  });
});
