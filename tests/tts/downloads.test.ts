/**
 * Tests unitaires — téléchargeur de modèles TTS (Lot 9, étape 2).
 *
 * ⚠️ Aucun téléchargement réel de plusieurs Go : un PETIT serveur HTTP simulé
 * sert quelques Ko. On vérifie le COMPORTEMENT : atomicité (`.part` + `rename`),
 * reprise `Range`, annulation, contrôle de taille, intégrité, espace disque,
 * un-seul-à-la-fois et registre persistant.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "../../src/observability/logger.js";
import {
  DOWNLOAD_FILE_NAME,
  DOWNLOAD_PART_SUFFIX,
  TtsDownloadError,
  TtsDownloadManager,
  contentRangeTotal,
  type CatalogEntry,
  type DownloadStatus,
  type ResolvedCatalogPackage,
} from "../../src/tts/index.js";

const tempDirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/* ─── Petit serveur HTTP de fichiers (simulé) ─────────────────────────────── */

interface FileServer {
  url: string;
  requests: Array<string | null>;
  state: {
    body: Buffer;
    supportRange: boolean;
    delayMs: number;
    chunkSize: number;
    chunkDelayMs: number;
  };
}

async function startFileServer(body: Buffer): Promise<FileServer> {
  const state = {
    body,
    supportRange: true,
    delayMs: 0,
    chunkSize: body.length,
    chunkDelayMs: 0,
  };
  const requests: Array<string | null> = [];
  const server = createServer((req, res) => {
    requests.push(typeof req.headers.range === "string" ? req.headers.range : null);
    const send = (): void => {
      let start = 0;
      const range = req.headers.range;
      if (state.supportRange && typeof range === "string") {
        const match = /^bytes=(\d+)-/.exec(range);
        if (match) start = Number.parseInt(match[1]!, 10);
      }
      const slice = state.body.subarray(start);
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        "content-length": String(slice.length),
        "accept-ranges": state.supportRange ? "bytes" : "none",
        etag: '"server-etag"',
      };
      if (start > 0) {
        headers["content-range"] = `bytes ${start}-${state.body.length - 1}/${state.body.length}`;
      }
      res.writeHead(start > 0 ? 206 : 200, headers);
      if (state.chunkDelayMs <= 0 || state.chunkSize >= slice.length) {
        res.end(slice);
        return;
      }
      let offset = 0;
      const tick = (): void => {
        if (res.writableEnded || res.destroyed) return;
        const end = Math.min(offset + state.chunkSize, slice.length);
        res.write(slice.subarray(offset, end));
        offset = end;
        if (offset >= slice.length) {
          res.end();
          return;
        }
        setTimeout(tick, state.chunkDelayMs);
      };
      tick();
    };
    if (state.delayMs > 0) setTimeout(send, state.delayMs);
    else send();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/file.gguf`, requests, state };
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/* ─── Fixture du gestionnaire ─────────────────────────────────────────────── */

interface Fixture {
  root: string;
  modelsDir: string;
  registryPath: string;
  manager: TtsDownloadManager;
}

function makeManager(options: {
  root: string;
  url: string;
  bytes: number;
  expectedSha256: string | null;
  freeBytes?: () => number;
  catalog?: readonly CatalogEntry[];
}): Fixture {
  const modelsDir = join(options.root, "models");
  mkdirSync(modelsDir, { recursive: true });
  const registryPath = join(options.root, "state", "tts-downloads.json");
  const resolve = async (entry: CatalogEntry): Promise<ResolvedCatalogPackage> => ({
    resolved: {
      catalogId: entry.id,
      repo: "test/repo",
      path: `dir/${entry.recommendedFile}`,
      fileName: entry.recommendedFile,
      url: options.url,
      bytes: options.bytes,
      sha256: options.expectedSha256,
    },
    source: "hf",
    warning: null,
  });
  const manager = new TtsDownloadManager({
    registryPath,
    modelsDir,
    engineModelsDir: "/models",
    resolve,
    freeBytes: options.freeBytes ?? (() => 1_000_000_000_000),
    progressIntervalMs: 0,
    logger,
  });
  return { root: options.root, modelsDir, registryPath, manager };
}

async function waitForStatus(
  manager: TtsDownloadManager,
  id: string,
  statuses: DownloadStatus[],
  timeoutMs = 5_000,
): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const task = manager.get(id);
    if (task && statuses.includes(task.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `délai dépassé en attendant ${statuses.join("|")} (état=${manager.get(id)?.status})`,
  );
}

function destPath(fx: Fixture, id: string): string {
  return join(fx.modelsDir, "downloads", id, DOWNLOAD_FILE_NAME);
}

/* ─── Tests ───────────────────────────────────────────────────────────────── */

describe("TtsDownloadManager — téléchargement nominal", () => {
  it("publie le fichier par `rename` atomique, aucune `.part` résiduelle", async () => {
    const body = Buffer.from("MODEL-CONTENT-".repeat(300));
    const server = await startFileServer(body);
    const fx = makeManager({
      root: tempDir("yuki-dl-"),
      url: server.url,
      bytes: body.length,
      expectedSha256: sha256(body),
    });
    await fx.manager.start("chatterbox");
    await waitForStatus(fx.manager, "chatterbox", ["done"]);

    const task = fx.manager.get("chatterbox")!;
    expect(task.status).toBe("done");
    expect(task.sha256Verified).toBe(true);
    expect(task.sha256).toBe(sha256(body));
    expect(readFileSync(destPath(fx, "chatterbox")).equals(body)).toBe(true);
    expect(existsSync(`${destPath(fx, "chatterbox")}${DOWNLOAD_PART_SUFFIX}`)).toBe(false);
    expect(task.enginePath).toBe("/models/downloads/chatterbox/model.gguf");
  });

  it("enregistre le SHA-256 SANS le prétendre vérifié si HF n'annonce rien", async () => {
    const body = Buffer.from("x".repeat(2048));
    const server = await startFileServer(body);
    const fx = makeManager({
      root: tempDir("yuki-dl-"),
      url: server.url,
      bytes: body.length,
      expectedSha256: null,
    });
    await fx.manager.start("chatterbox");
    await waitForStatus(fx.manager, "chatterbox", ["done"]);
    const task = fx.manager.get("chatterbox")!;
    expect(task.sha256).toBe(sha256(body));
    expect(task.sha256Verified).toBe(false);
  });
});

describe("TtsDownloadManager — reprise `Range`", () => {
  it("reprend un `.part` existant quand le serveur annonce 206", async () => {
    const body = Buffer.from("ABCDEFGHIJ".repeat(200));
    const server = await startFileServer(body);
    const fx = makeManager({
      root: tempDir("yuki-dl-"),
      url: server.url,
      bytes: body.length,
      expectedSha256: sha256(body),
    });
    // Pré-remplit la moitié du fichier partiel.
    const partPath = `${destPath(fx, "chatterbox")}${DOWNLOAD_PART_SUFFIX}`;
    mkdirSync(join(fx.modelsDir, "downloads", "chatterbox"), { recursive: true });
    writeFileSync(partPath, body.subarray(0, 900));

    await fx.manager.start("chatterbox");
    await waitForStatus(fx.manager, "chatterbox", ["done"]);
    expect(server.requests.some((range) => range === "bytes=900-")).toBe(true);
    expect(fx.manager.get("chatterbox")!.resumedFromBytes).toBe(900);
    expect(readFileSync(destPath(fx, "chatterbox")).equals(body)).toBe(true);
  });

  it("repart de zéro si le serveur IGNORE `Range` (200)", async () => {
    const body = Buffer.from("Z".repeat(1000));
    const server = await startFileServer(body);
    server.state.supportRange = false;
    const fx = makeManager({
      root: tempDir("yuki-dl-"),
      url: server.url,
      bytes: body.length,
      expectedSha256: sha256(body),
    });
    const partPath = `${destPath(fx, "chatterbox")}${DOWNLOAD_PART_SUFFIX}`;
    mkdirSync(join(fx.modelsDir, "downloads", "chatterbox"), { recursive: true });
    writeFileSync(partPath, body.subarray(0, 500));

    await fx.manager.start("chatterbox");
    await waitForStatus(fx.manager, "chatterbox", ["done"]);
    expect(fx.manager.get("chatterbox")!.resumedFromBytes).toBe(0);
    expect(readFileSync(destPath(fx, "chatterbox")).equals(body)).toBe(true);
  });

  it("refuse de reprendre si la taille distante a changé", async () => {
    const body = Buffer.from("Q".repeat(1000));
    const server = await startFileServer(body);
    const fx = makeManager({
      root: tempDir("yuki-dl-"),
      url: server.url,
      // Taille annoncée différente de la réalité → Content-Range incohérent.
      bytes: 1000,
      expectedSha256: null,
    });
    // Fabrique un `.part` puis force une réponse 206 dont le total diffère.
    const partDir = join(fx.modelsDir, "downloads", "chatterbox");
    mkdirSync(partDir, { recursive: true });
    writeFileSync(`${destPath(fx, "chatterbox")}${DOWNLOAD_PART_SUFFIX}`, body.subarray(0, 400));
    // Le serveur renvoie un total de 1000 alors que le manager attend 1000 :
    // on modifie l'état pour un total différent en tronquant le corps servi.
    server.state.body = Buffer.from("Q".repeat(1200));
    await fx.manager.start("chatterbox");
    await waitForStatus(fx.manager, "chatterbox", ["failed"]);
    // Le total résolu (1000) diffère de Content-Range (1200) → échec explicite.
    expect(fx.manager.get("chatterbox")!.code).toBe("size_changed");
  });
});

describe("TtsDownloadManager — erreurs", () => {
  it("échoue sur une taille reçue différente de la taille annoncée", async () => {
    const body = Buffer.from("s".repeat(100));
    const server = await startFileServer(body);
    const fx = makeManager({
      root: tempDir("yuki-dl-"),
      url: server.url,
      bytes: 200, // annonce 200, en reçoit 100
      expectedSha256: null,
    });
    await fx.manager.start("chatterbox");
    await waitForStatus(fx.manager, "chatterbox", ["failed"]);
    expect(fx.manager.get("chatterbox")!.code).toBe("size_mismatch");
    expect(existsSync(destPath(fx, "chatterbox"))).toBe(false);
  });

  it("échoue et supprime le fichier si le SHA-256 ne correspond pas", async () => {
    const body = Buffer.from("i".repeat(300));
    const server = await startFileServer(body);
    const fx = makeManager({
      root: tempDir("yuki-dl-"),
      url: server.url,
      bytes: body.length,
      expectedSha256: "0".repeat(64),
    });
    await fx.manager.start("chatterbox");
    await waitForStatus(fx.manager, "chatterbox", ["failed"]);
    expect(fx.manager.get("chatterbox")!.code).toBe("integrity_mismatch");
    expect(existsSync(destPath(fx, "chatterbox"))).toBe(false);
    expect(existsSync(`${destPath(fx, "chatterbox")}${DOWNLOAD_PART_SUFFIX}`)).toBe(false);
  });

  it("refuse AVANT écriture si l'espace disque est insuffisant (507)", async () => {
    const body = Buffer.from("d".repeat(1000));
    const server = await startFileServer(body);
    const fx = makeManager({
      root: tempDir("yuki-dl-"),
      url: server.url,
      bytes: body.length,
      expectedSha256: null,
      freeBytes: () => 10,
    });
    const error = await fx.manager.start("chatterbox").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TtsDownloadError);
    expect((error as TtsDownloadError).code).toBe("insufficient_disk_space");
    expect((error as TtsDownloadError).status).toBe(507);
    expect((error as TtsDownloadError).message).toContain("Espace disque insuffisant");
    expect(fx.manager.get("chatterbox")).toBeUndefined();
  });

  it("refuse si le dossier des modèles n'est pas un répertoire exploitable (message exact)", async () => {
    const root = tempDir("yuki-dl-");
    // `models` est un FICHIER : la création du sous-dossier échoue (ENOTDIR).
    const notADir = join(root, "models");
    writeFileSync(notADir, "fichier");
    const registryPath = join(root, "state", "tts-downloads.json");
    const manager = new TtsDownloadManager({
      registryPath,
      modelsDir: notADir,
      engineModelsDir: "/models",
      resolve: async (entry) => ({
        resolved: {
          catalogId: entry.id,
          repo: "r",
          path: "p",
          fileName: "f.gguf",
          url: "http://127.0.0.1:1/x",
          bytes: 10,
          sha256: null,
        },
        source: "hf",
        warning: null,
      }),
      freeBytes: () => 1_000_000_000_000,
      logger,
    });
    const error = await manager.start("chatterbox").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TtsDownloadError);
    expect((error as TtsDownloadError).code).toBe("models_dir_unwritable");
    expect((error as TtsDownloadError).status).toBe(503);
    expect((error as TtsDownloadError).message).toContain("répertoire exploitable");
  });

  it("refuse un identifiant inconnu (400) et un second démarrage (409)", async () => {
    const body = Buffer.from("c".repeat(500));
    const server = await startFileServer(body);
    const fx = makeManager({
      root: tempDir("yuki-dl-"),
      url: server.url,
      bytes: body.length,
      expectedSha256: null,
    });
    const unknown = await fx.manager.start("inexistant").catch((e: unknown) => e);
    expect((unknown as TtsDownloadError).code).toBe("unknown_catalog_id");

    server.state.delayMs = 200;
    await fx.manager.start("chatterbox");
    const second = await fx.manager.start("chatterbox").catch((e: unknown) => e);
    expect((second as TtsDownloadError).code).toBe("download_in_progress");
    expect((second as TtsDownloadError).status).toBe(409);
    fx.manager.cancel("chatterbox");
    await waitForStatus(fx.manager, "chatterbox", ["cancelled"]);
  });
});

describe("TtsDownloadManager — annulation et un-seul-à-la-fois", () => {
  it("annule une tâche en cours (jamais `done`)", async () => {
    const body = Buffer.from("m".repeat(200_000));
    const server = await startFileServer(body);
    server.state.chunkSize = 4_096;
    server.state.chunkDelayMs = 5;
    const fx = makeManager({
      root: tempDir("yuki-dl-"),
      url: server.url,
      bytes: body.length,
      expectedSha256: null,
    });
    await fx.manager.start("chatterbox");
    await waitForStatus(fx.manager, "chatterbox", ["downloading"]);
    const cancelled = fx.manager.cancel("chatterbox");
    expect(cancelled.status).toBe("cancelled");
    await waitForStatus(fx.manager, "chatterbox", ["cancelled"]);
    expect(existsSync(destPath(fx, "chatterbox"))).toBe(false);
    // Annuler une tâche terminale est refusé (409).
    const error = (() => {
      try {
        fx.manager.cancel("chatterbox");
        return null;
      } catch (thrown) {
        return thrown as TtsDownloadError;
      }
    })();
    expect(error?.code).toBe("download_not_active");
    expect(error?.status).toBe(409);
  });

  it("ne démarre qu'un téléchargement à la fois ; les autres restent `queued`", async () => {
    const body = Buffer.from("p".repeat(200_000));
    const server = await startFileServer(body);
    server.state.chunkSize = 4_096;
    server.state.chunkDelayMs = 5;
    const fx = makeManager({
      root: tempDir("yuki-dl-"),
      url: server.url,
      bytes: body.length,
      expectedSha256: null,
    });
    await fx.manager.start("chatterbox");
    await fx.manager.start("kokoro");
    await waitForStatus(fx.manager, "chatterbox", ["downloading"]);
    expect(fx.manager.get("kokoro")!.status).toBe("queued");
    expect(fx.manager.activeId()).toBe("chatterbox");
    fx.manager.cancel("chatterbox");
    fx.manager.cancel("kokoro");
    await waitForStatus(fx.manager, "kokoro", ["cancelled"]);
  });
});

describe("TtsDownloadManager — registre persistant", () => {
  it("recharge une tâche `done` depuis le disque (survit au redémarrage)", async () => {
    const body = Buffer.from("r".repeat(400));
    const server = await startFileServer(body);
    const root = tempDir("yuki-dl-");
    const fx = makeManager({
      root,
      url: server.url,
      bytes: body.length,
      expectedSha256: sha256(body),
    });
    await fx.manager.start("chatterbox");
    await waitForStatus(fx.manager, "chatterbox", ["done"]);

    const reopened = new TtsDownloadManager({
      registryPath: fx.registryPath,
      modelsDir: fx.modelsDir,
      engineModelsDir: "/models",
      resolve: async () => {
        throw new Error("ne doit pas être appelé");
      },
      logger,
    });
    const task = reopened.get("chatterbox");
    expect(task?.status).toBe("done");
    expect(task?.sha256Verified).toBe(true);
  });

  it("passe une tâche `downloading` en `interrupted` à la réouverture — jamais `done`", () => {
    const root = tempDir("yuki-dl-");
    const registryPath = join(root, "state", "tts-downloads.json");
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      registryPath,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            schemaVersion: 1,
            catalogId: "chatterbox",
            label: "Chatterbox",
            status: "downloading",
            enginePath: "/models/downloads/chatterbox/model.gguf",
            gatewayPath: join(root, "models", "downloads", "chatterbox", "model.gguf"),
            url: "http://x",
            fileName: "chatterbox-q8_0.gguf",
            totalBytes: 10,
            bytesDownloaded: 4,
            sha256: null,
            sha256Verified: false,
            expectedSha256: null,
            source: "hf",
            warning: null,
            error: null,
            code: null,
            resumedFromBytes: 0,
            etag: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const manager = new TtsDownloadManager({
      registryPath,
      modelsDir: join(root, "models"),
      engineModelsDir: "/models",
      logger,
    });
    expect(manager.get("chatterbox")?.status).toBe("interrupted");
    // Persisté : une seconde ouverture ne « re-interrompt » pas depuis `done`.
    const reopened = new TtsDownloadManager({
      registryPath,
      modelsDir: join(root, "models"),
      engineModelsDir: "/models",
      logger,
    });
    expect(reopened.get("chatterbox")?.status).toBe("interrupted");
  });
});

describe("contentRangeTotal", () => {
  it("extrait le total d'un en-tête Content-Range", () => {
    expect(contentRangeTotal("bytes 100-199/1000")).toBe(1000);
    expect(contentRangeTotal(null)).toBeNull();
    expect(contentRangeTotal("bytes */1000")).toBeNull();
  });
});
