/**
 * CHAÎNE COMPLÈTE — un JOB qui produit une image ⇒ **c'est le TOUR DE YUKI qui
 * publie**, avec le fichier. AUCUNE publication du serveur.
 *
 * ⚠️ LE DÉFAUT QUE CE FICHIER VERROUILLE (production, 2026-11-02) : le rapport d'un job
 * était publié par le SERVEUR (`createChannelAwareWaker` → `post`), en plus de la
 * réponse de Yuki. Deux rédacteurs ⇒ deux messages collés, deux images, un ordre cassé.
 *
 * Ce que ce fichier prouve, de bout en bout (service de délégation RÉEL, réveil réel,
 * adaptateur Mattermost réel, serveur HTTP fixture) :
 *  ① le worker rend son fichier (`HeavyRunResult.fichiers`), il ne publie rien ;
 *  ② le service le JOURNALISE avec le résultat (il survit à un redémarrage) ;
 *  ③ le réveil INJECTE le rapport dans la conversation du canal (aucun `send`) ;
 *  ④ le tour de Yuki publie UN SEUL message : le sien, avec les `file_ids` du job,
 *     à la racine du canal (l'identifiant synthétique du rapport n'est jamais utilisé
 *     comme `root_id` : il n'existe pas chez la plateforme) ;
 *  ⑤ si le tour de Yuki n'a pas lieu (modèle injoignable), le repli est EXPLICITE :
 *     le rapport part en texte, précédé de la phrase qui dit que c'est un repli.
 *
 * ⚠️ Échoue sur le code d'origine : le réveil publiait lui-même le rapport
 * (`post`), et le tour de Yuki n'existait pas pour un rapport de job.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createChannelAwareWaker, reportFallbackText } from "../../src/chat/reply/channel-waker.js";
import { MattermostChatAdapter } from "../../src/chat/mattermost/adapter.js";
import { conversationIdOfChannel } from "../../src/chat/mirror/ingest.js";
import { ChatMirrorStore } from "../../src/chat/mirror/store.js";
import type { ChatReplyGenerator } from "../../src/chat/types.js";
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
  const dir = mkdtempSync(join(tmpdir(), `yuki-job-wake-${purpose}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

interface Fixture {
  baseUrl: string;
  /** Corps des posts publiés (par qui que ce soit). */
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
  throw new Error(`Délai dépasse en attendant : ${label}`.replace("dépasse", "dépassé"));
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

interface Banc {
  fixture: Fixture;
  delegation: ReturnType<typeof createDelegationService>;
  jobStore: JobStore;
  fichier: string;
  /** Entrées reçues par le générateur de réponse (ce que Yuki voit). */
  tours: Array<Record<string, unknown>>;
}

/**
 * Banc complet : store de fichiers RÉEL, miroir RÉEL, adaptateur RÉEL, service de
 * délégation RÉEL, et le générateur de réponse remplacé par un double qui enregistre
 * ce qu'il reçoit (le modèle n'est pas le sujet ici : le CÂBLAGE l'est).
 */
async function monterBanc(
  generer: ChatReplyGenerator,
): Promise<Banc> {
  const fixture = await startFixture();
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
  const fichier = enregistre.ok ? enregistre.record.id : "";

  const store = ChatMirrorStore.open({
    indexPath: join(tempDir("miroir"), "chat-mirror.json"),
    messagesDir: join(tempDir("miroir-msg"), "chat-mirror"),
  });
  store.ensureConversation({
    conversationId: CONVERSATION,
    platform: "mattermost",
    remoteId: CHANNEL,
    title: "Général",
  });

  const tours: Array<Record<string, unknown>> = [];
  const adapter = new MattermostChatAdapter({
    baseUrl: () => fixture.baseUrl,
    token: () => TOKEN,
    store,
    files: filesStore,
    // Double : il enregistre l'entrée reçue et rend une réponse de Yuki.
    generateReply: async (input) => {
      tours.push(input as unknown as Record<string, unknown>);
      return generer(input);
    },
  });

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
      // ⚠️ MÊME chemin qu'en production (`src/index.ts`) : le réveil passe par
      // l'adaptateur de la plateforme, qui ouvre un TOUR de Yuki.
      wake: (request) => adapter.wakeReport(request),
      // ⚠️ REPLI seulement : jamais le chemin normal.
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
  return { fixture, delegation, jobStore, fichier, tours };
}

async function lancerJob(banc: Banc): Promise<string> {
  const issue = await banc.delegation.delegate({
    task: "Génère une image d'un chat roux",
    lightSessionId: CONVERSATION,
    background: true,
  });
  expect(issue.status).toBe("dispatched");
  return issue.status === "dispatched" ? issue.job_id : "";
}

describe("rapport de job — UN SEUL rédacteur : le tour de Yuki", () => {
  it("le job produit une image : Yuki (et elle seule) publie, avec le fichier", async () => {
    const banc = await monterBanc(async (input) => ({
      text: "L'image demandée est prête.",
      // ⚠️ Le VRAI générateur rend les fichiers du job (ceux qui n'ont pas été publiés
      // ailleurs) : on reproduit ce contrat ici.
      ...(input.fichiersDuJob !== undefined ? { fichiers: input.fichiersDuJob } : {}),
    }));

    const jobId = await lancerJob(banc);
    // ① ② Le job a bien enregistré son fichier avec son résultat.
    expect(banc.jobStore.get(jobId)?.result.fichiers).toEqual([banc.fichier]);

    await waitFor(() => banc.fixture.created.length >= 1, "le message publié");

    // ③④ UN SEUL message publié, et c'est celui de Yuki — pas le rapport brut.
    expect(banc.fixture.created).toHaveLength(1);
    const post = banc.fixture.created[0]!;
    expect(String(post.message)).toContain("L'image demandée est prête.");
    expect(String(post.message)).not.toContain("RÉSULTAT DE TÂCHE");
    expect(String(post.message)).not.toContain("RAPPORT SYSTÈME");
    // Le fichier du job est bien parti avec elle.
    expect(banc.fixture.uploads).toHaveLength(1);
    expect(post.file_ids).toEqual(["fichier-1"]);
    // ⚠️ L'identifiant SYNTHÉTIQUE du rapport n'existe pas chez la plateforme : il ne
    // doit jamais servir de `root_id` (le post serait refusé).
    expect(post.root_id).toBeUndefined();

    // Le tour de Yuki a bien reçu l'ORIGINE et les FICHIERS du job : sans eux, elle ne
    // saurait pas d'où vient le rapport et ne pourrait pas publier l'image ailleurs.
    expect(banc.tours).toHaveLength(1);
    expect(banc.tours[0]?.origine).toBe("job");
    expect(banc.tours[0]?.fichiersDuJob).toEqual([banc.fichier]);
    const message = banc.tours[0]?.message as { text: string; author: { nom: string } };
    expect(message.author.nom).toBe("Rapport de tâche");
    expect(message.text).toContain("RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN");
  });

  it("Yuki ne peut pas rédiger (modèle injoignable) : repli TEXTE, et il est DIT", async () => {
    const banc = await monterBanc(() => {
      throw new Error("modèle indisponible");
    });

    await lancerJob(banc);
    await waitFor(() => banc.fixture.created.length >= 1, "le repli publié");

    // ⚠️ SEUL cas où le serveur parle : le rapport part en texte, précédé de la
    // phrase qui dit que c'est un repli.
    expect(banc.fixture.created).toHaveLength(1);
    const post = banc.fixture.created[0]!;
    const message = String(post.message);
    expect(message).toContain(reportFallbackText(undefined).slice(0, 25));
    expect(message).toContain("Repli");
    expect(message).toContain("RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN");
    // L'image n'est pas perdue : elle part avec le repli.
    expect(post.file_ids).toEqual(["fichier-1"]);
  });
});
