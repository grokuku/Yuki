/**
 * Tests d'intégration — routes de téléchargement des modèles (Lot 9, étape 2)
 * via un VRAI serveur HTTP. Le fichier est servi par un PETIT serveur simulé :
 * aucun téléchargement réel de plusieurs Go.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer as createFileServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { inspectMountPoints, mountPoints } from "../../src/config/paths.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import type { AdminApiDeps } from "../../src/gateway/routes/admin.js";
import type { EngineConfigPort, TtsApiDeps } from "../../src/gateway/routes/tts.js";
import { TtsDiagnostics } from "../../src/gateway/routes/tts.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
import { createLogger } from "../../src/observability/logger.js";
import {
  EngineConfigStore,
  TtsDownloadManager,
  type CatalogEntry,
  type DownloadStatus,
} from "../../src/tts/index.js";

const profiles = loadProfiles();
const manifest = loadCompatManifest();

const tempDirs: string[] = [];
const servers: Server[] = [];
const fileServers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
  for (const server of fileServers.splice(0)) {
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

const WRITE = { "x-yuki-config": "1", "content-type": "application/json" };
const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const sha256 = (buffer: Buffer): string =>
  createHash("sha256").update(buffer).digest("hex");

interface FileServerState {
  body: Buffer;
  chunkSize: number;
  chunkDelayMs: number;
}

async function startBodyServer(
  state: FileServerState,
): Promise<{ url: string; state: FileServerState }> {
  const server = createFileServer((_req, res) => {
    const slice = state.body;
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(slice.length),
      "accept-ranges": "bytes",
    });
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
  });
  fileServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/model.gguf`, state };
}

interface Harness {
  baseUrl: string;
  modelsDir: string;
  configDir: string;
  downloadState: FileServerState;
  manager: TtsDownloadManager;
  shutdowns: string[];
}

async function startHarness(
  options: { noDownloads?: boolean; freeBytes?: number } = {},
): Promise<Harness> {
  const root = tempDir("yuki-downloads-int-");
  const configDir = join(root, "tts-config");
  const modelsDir = join(root, "models");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });

  const body = Buffer.from("GGUF-MODEL-".repeat(200));
  const fileServer = await startBodyServer({ body, chunkSize: body.length, chunkDelayMs: 0 });

  const env = loadEnv({
    YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: join(root, "state", "config.json"),
    YUKI_MOUNT_VOICES: join(root, "voices"),
    YUKI_VOICES_DIR: join(root, "voices"),
    YUKI_MOUNT_MODELS: modelsDir,
    YUKI_TTS_CONFIG_DIR: configDir,
    YUKI_TTS_ENGINE_MODELS_DIR: "/models",
    YUKI_TTS_ENGINE_CONFIG_DIR: "/config",
  });

  const store = new EngineConfigStore({
    configDir,
    engineConfigDir: "/config",
    modelsDir,
    engineModelsDir: "/models",
  });
  const engineConfig: EngineConfigPort = {
    report: () => store.report(),
    applyPatch: (patch) => store.applyPatch(patch),
    revert: () => store.revert(),
    capabilities: async () => ({
      reachable: false,
      baseUrl: "http://tts:8081",
      route: "/v1/tasks/unload_models",
      method: "POST",
      unloadModels: null,
      probeStatus: null,
      probeBody: null,
      detail: null,
      measuredAt: null,
    }),
  };

  const manager = new TtsDownloadManager({
    registryPath: join(root, "state", "tts-downloads.json"),
    modelsDir,
    engineModelsDir: "/models",
    resolve: async (entry: CatalogEntry) => ({
      resolved: {
        catalogId: entry.id,
        repo: entry.repo,
        path: `${entry.dir}/${entry.recommendedFile}`,
        fileName: entry.recommendedFile,
        url: fileServer.url,
        bytes: body.length,
        sha256: sha256(body),
      },
      source: "hf",
      warning: null,
    }),
    freeBytes: () => options.freeBytes ?? 1_000_000_000_000,
    progressIntervalMs: 0,
    logger,
  });

  const diagnostics = new TtsDiagnostics(
    { enabled: () => false, engine: () => "chatterbox", baseUrl: () => "http://tts:8081" },
    { fetchImpl: async () => new Response("", { status: 404 }), timeoutMs: 50, ttlMs: 0, logger },
  );

  const ttsDeps: TtsApiDeps = {
    config: {
      getString: (path) => (path === "tts.baseUrl" ? "http://tts:8081" : ""),
      getNumber: () => 0,
    },
    logger,
    voices: { get: () => null },
    diagnostics,
    modelsDir,
    engineConfig,
    ...(options.noDownloads ? {} : { downloads: manager }),
  };

  const shutdowns: string[] = [];
  const admin: AdminApiDeps = {
    logger,
    requestShutdown: () => shutdowns.push("shutdown"),
    downloads: {
      hasActive: () => manager.hasActive(),
      activeId: () => manager.activeId(),
    },
  };

  const detection = detectGpus({
    command: env.gpuCmd,
    fixture: env.gpuFixture,
    commandFromEnv: env.gpuCmdFromEnv,
    cwd: process.cwd(),
  });
  const gate = runGate(
    { config: { compatMode: "strict", profile: null, minDriver: 580 }, profiles, manifest, detection },
    logger,
  );

  const server = createServer({
    env,
    report: gate.report,
    gatePassed: gate.passed,
    startedAt: Date.now(),
    volumes: inspectMountPoints(mountPoints(env)),
    tts: ttsDeps,
    admin,
  });
  servers.push(server);
  const address = await startServer(server, "127.0.0.1", 0);
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    modelsDir,
    configDir,
    downloadState: fileServer.state,
    manager,
    shutdowns,
  };
}

async function waitForTask(
  baseUrl: string,
  id: string,
  statuses: DownloadStatus[],
  timeoutMs = 5_000,
): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const response = await fetch(`${baseUrl}/api/tts/downloads`);
    const body = (await response.json()) as { tasks: Array<Record<string, unknown>> };
    const task = body.tasks.find((entry) => entry.catalogId === id);
    if (task && statuses.includes(task.status as DownloadStatus)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`délai dépassé en attendant ${statuses.join("|")} pour ${id}`);
}

describe("GET /api/tts/catalog", () => {
  it("renvoie le catalogue fermé + l'état local + de quoi pré-remplir l'éditeur", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/catalog`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: Array<Record<string, unknown>>;
      notIncluded: Array<Record<string, unknown>>;
    };
    expect(body.entries).toHaveLength(4);
    const chatterbox = body.entries.find((entry) => entry.id === "chatterbox")!;
    expect(chatterbox.installed).toBe(false);
    expect(chatterbox.declared).toBe(false);
    expect(chatterbox.prefill).toEqual({
      id: "chatterbox",
      family: "chatterbox",
      task: "clon",
      mode: "offline",
      path: "/models/downloads/chatterbox/model.gguf",
    });
    expect(body.notIncluded.map((entry) => entry.id)).toContain("sanotts");
  });

  it("port non câblé → 503 explicite", async () => {
    const { baseUrl } = await startHarness({ noDownloads: true });
    const response = await fetch(`${baseUrl}/api/tts/catalog`);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("downloads_unavailable");
  });
});

describe("POST /api/tts/downloads", () => {
  it("sans en-tête → 403 ; identifiant inconnu → 400", async () => {
    const { baseUrl } = await startHarness();
    const noGuard = await fetch(`${baseUrl}/api/tts/downloads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogId: "chatterbox" }),
    });
    expect(noGuard.status).toBe(403);
    expect(((await noGuard.json()) as { code: string }).code).toBe("missing_config_header");

    const unknown = await fetch(`${baseUrl}/api/tts/downloads`, {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify({ catalogId: "inexistant" }),
    });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { code: string }).code).toBe("unknown_catalog_id");
  });

  it("télécharge de bout en bout puis le catalogue dit « installé »", async () => {
    const { baseUrl } = await startHarness();
    const start = await fetch(`${baseUrl}/api/tts/downloads`, {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify({ catalogId: "chatterbox" }),
    });
    expect(start.status).toBe(202);
    const done = await waitForTask(baseUrl, "chatterbox", ["done"]);
    expect(done.sha256Verified).toBe(true);

    const catalog = (await (await fetch(`${baseUrl}/api/tts/catalog`)).json()) as {
      entries: Array<Record<string, unknown>>;
    };
    const chatterbox = catalog.entries.find((entry) => entry.id === "chatterbox")!;
    expect(chatterbox.installed).toBe(true);
  });

  it("le `prefill` du catalogue est DIRECTEMENT déclarable par l'éditeur", async () => {
    const { baseUrl } = await startHarness();
    await fetch(`${baseUrl}/api/tts/downloads`, {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify({ catalogId: "qwen3-tts" }),
    });
    await waitForTask(baseUrl, "qwen3-tts", ["done"]);

    const catalog = (await (await fetch(`${baseUrl}/api/tts/catalog`)).json()) as {
      entries: Array<{ id: string; prefill: Record<string, unknown> }>;
    };
    const prefill = catalog.entries.find((entry) => entry.id === "qwen3-tts")!.prefill;

    // On envoie EXACTEMENT le pré-remplissage à l'éditeur existant.
    const put = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({ models: [prefill] }),
    });
    expect(put.status).toBe(200);

    const after = (await (await fetch(`${baseUrl}/api/tts/catalog`)).json()) as {
      entries: Array<Record<string, unknown>>;
    };
    const qwen = after.entries.find((entry) => entry.id === "qwen3-tts")!;
    expect(qwen.declared).toBe(true);
    expect(qwen.declaredPath).toBe("/models/downloads/qwen3-tts/model.gguf");
  });

  it("refuse un second démarrage du même modèle (409)", async () => {
    const { baseUrl, downloadState } = await startHarness();
    downloadState.chunkSize = 16;
    downloadState.chunkDelayMs = 10;
    await fetch(`${baseUrl}/api/tts/downloads`, {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify({ catalogId: "chatterbox" }),
    });
    const second = await fetch(`${baseUrl}/api/tts/downloads`, {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify({ catalogId: "chatterbox" }),
    });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { code: string }).code).toBe("download_in_progress");
    await fetch(`${baseUrl}/api/tts/downloads/chatterbox/cancel`, {
      method: "POST",
      headers: WRITE,
    });
  });

  it("refuse si l'espace disque est insuffisant (507, message exact)", async () => {
    const { baseUrl } = await startHarness({ freeBytes: 10 });
    const response = await fetch(`${baseUrl}/api/tts/downloads`, {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify({ catalogId: "chatterbox" }),
    });
    expect(response.status).toBe(507);
    const body = (await response.json()) as { code: string; message: string };
    expect(body.code).toBe("insufficient_disk_space");
    expect(body.message).toContain("Espace disque insuffisant");
  });
});

describe("POST /api/tts/downloads/{id}/cancel", () => {
  it("annule une tâche en cours (garde-fou requis)", async () => {
    const { baseUrl, downloadState } = await startHarness();
    downloadState.chunkSize = 16;
    downloadState.chunkDelayMs = 10;
    await fetch(`${baseUrl}/api/tts/downloads`, {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify({ catalogId: "cosyvoice3" }),
    });
    const noGuard = await fetch(`${baseUrl}/api/tts/downloads/cosyvoice3/cancel`, {
      method: "POST",
    });
    expect(noGuard.status).toBe(403);

    const cancel = await fetch(`${baseUrl}/api/tts/downloads/cosyvoice3/cancel`, {
      method: "POST",
      headers: WRITE,
    });
    expect(cancel.status).toBe(200);
    await waitForTask(baseUrl, "cosyvoice3", ["cancelled"]);
  });

  it("annuler un téléchargement inconnu → 404", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/downloads/inexistant/cancel`, {
      method: "POST",
      headers: WRITE,
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("unknown_download");
  });
});

describe("cohérence avec le redémarrage", () => {
  it("aucun téléchargement actif → redémarrage inchangé (200)", async () => {
    const { baseUrl, shutdowns } = await startHarness();
    const response = await fetch(`${baseUrl}/api/admin/restart`, {
      method: "POST",
      headers: WRITE,
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { restarting: boolean }).restarting).toBe(true);
    // L'arrêt est PLANIFIÉ (délai court) : on attend qu'il soit demandé.
    const t0 = Date.now();
    while (shutdowns.length === 0 && Date.now() - t0 < 2_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(shutdowns).toHaveLength(1);
  });

  it("téléchargement actif → redémarrage REFUSÉ (409), pas de demande d'arrêt", async () => {
    const { baseUrl, downloadState, shutdowns } = await startHarness();
    downloadState.chunkSize = 16;
    downloadState.chunkDelayMs = 10;
    await fetch(`${baseUrl}/api/tts/downloads`, {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify({ catalogId: "chatterbox" }),
    });
    await waitForTask(baseUrl, "chatterbox", ["downloading"]);

    const response = await fetch(`${baseUrl}/api/admin/restart`, {
      method: "POST",
      headers: WRITE,
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { code: string; activeDownload?: string };
    expect(body.code).toBe("download_in_progress");
    expect(body.activeDownload).toBe("chatterbox");
    expect(shutdowns).toHaveLength(0);

    await fetch(`${baseUrl}/api/tts/downloads/chatterbox/cancel`, {
      method: "POST",
      headers: WRITE,
    });
  });
});
