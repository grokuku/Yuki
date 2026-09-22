/**
 * Tests d'intégration — routes de configuration STRUCTURÉE du moteur (Lot 9)
 * via un VRAI serveur HTTP. Le moteur n'est pas requis : la sonde de capacités
 * utilise un `fetchImpl` injecté.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { inspectMountPoints, mountPoints } from "../../src/config/paths.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import type {
  EngineConfigPort,
  TtsApiDeps,
} from "../../src/gateway/routes/tts.js";
import { TtsDiagnostics } from "../../src/gateway/routes/tts.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
import { createLogger } from "../../src/observability/logger.js";
import {
  EngineCapabilitiesProbe,
  EngineConfigStore,
} from "../../src/tts/engine-config.js";

const profiles = loadProfiles();
const manifest = loadCompatManifest();

const tempDirs: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

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

const WRITE = { "x-yuki-config": "1", "content-type": "application/json" };

interface Harness {
  baseUrl: string;
  configDir: string;
  modelsDir: string;
  store: EngineConfigStore;
}

async function startHarness(options: { mountConfig?: boolean; noEngineConfig?: boolean; capabilityFetch?: typeof fetch } = {}): Promise<Harness> {
  const root = tempDir("yuki-engine-config-int-");
  const configDir = join(root, "tts-config");
  const modelsDir = join(root, "models");
  mkdirSync(modelsDir, { recursive: true });
  if (options.mountConfig !== false) mkdirSync(configDir, { recursive: true });
  writeFileSync(join(modelsDir, "chatterbox.gguf"), "gguf");

  const env = loadEnv({
    YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: join(root, "state", "config.json"),
    YUKI_MOUNT_VOICES: join(root, "voices"),
    YUKI_VOICES_DIR: join(root, "voices"),
    YUKI_MOUNT_MODELS: modelsDir,
    YUKI_TTS_CONFIG_DIR: configDir,
    YUKI_TTS_MODELS_WRITE_DIR: join(root, "models-dl"),
    YUKI_TTS_ENGINE_MODELS_DIR: "/models",
    YUKI_TTS_ENGINE_CONFIG_DIR: "/config",
  });
  const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
  const store = new EngineConfigStore({
    configDir,
    engineConfigDir: "/config",
    modelsDir,
    modelsWriteDir: join(root, "models-dl"),
    engineModelsDir: "/models",
  });
  const probe = new EngineCapabilitiesProbe(() => "http://tts:8081", {
    fetchImpl: options.capabilityFetch ?? (async () => new Response("", { status: 404 })),
    now: () => 1,
  });
  const engineConfig: EngineConfigPort = {
    report: () => store.report(),
    applyPatch: (patch) => store.applyPatch(patch),
    revert: () => store.revert(),
    capabilities: () => probe.probe(),
  };

  const diagnostics = new TtsDiagnostics(
    {
      enabled: () => false,
      engine: () => "chatterbox",
      baseUrl: () => "http://tts:8081",
    },
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
    ...(options.noEngineConfig ? {} : { engineConfig }),
  };

  const detection = detectGpus({
    command: env.gpuCmd,
    fixture: env.gpuFixture,
    commandFromEnv: env.gpuCmdFromEnv,
    cwd: process.cwd(),
  });
  const gate = runGate(
    {
      config: { compatMode: "strict", profile: null, minDriver: 580 },
      profiles,
      manifest,
      detection,
    },
    logger,
  );

  const server = createServer({
    env,
    report: gate.report,
    gatePassed: gate.passed,
    startedAt: Date.now(),
    volumes: inspectMountPoints(mountPoints(env)),
    tts: ttsDeps,
  });
  servers.push(server);
  const address = await startServer(server, "127.0.0.1", 0);
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    configDir,
    modelsDir,
    store,
  };
}

const VALID_MODEL = {
  id: "chatterbox",
  family: "chatterbox",
  task: "clon",
  mode: "offline",
  path: "/models/chatterbox.gguf",
};

describe("GET /api/tts/engine-config", () => {
  it("répond 200 avec l'état de montage et le catalogue disque", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.mounted).toBe(true);
    expect(body.writable).toBe(true);
    expect(body.engineConfigPath).toBe("/config/server.json");
    expect((body.diskModels as unknown[]).length).toBe(1);
  });

  it("dossier non monté → 200 avec un état honnête (jamais 500)", async () => {
    const { baseUrl } = await startHarness({ mountConfig: false });
    const response = await fetch(`${baseUrl}/api/tts/engine-config`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.mounted).toBe(false);
    expect(body.available).toBe(false);
  });

  it("port non câblé → 503 explicite", async () => {
    const { baseUrl } = await startHarness({ noEngineConfig: true });
    const response = await fetch(`${baseUrl}/api/tts/engine-config`);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("engine_config_unavailable");
  });
});

describe("PUT /api/tts/engine-config — garde-fous", () => {
  it("sans en-tête X-Yuki-Config → 403", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: [VALID_MODEL] }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("missing_config_header");
  });

  it("origine étrangère → 403 bad_origin", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: { ...WRITE, origin: "http://evil.example" },
      body: JSON.stringify({ models: [VALID_MODEL] }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("bad_origin");
  });
});

describe("PUT /api/tts/engine-config — patch valide / invalide", () => {
  it("patch valide → 200 ET fichier écrit avec le chemin moteur", async () => {
    const { baseUrl, configDir, modelsDir } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({
        models: [{ ...VALID_MODEL, path: join(modelsDir, "chatterbox.gguf") }],
      }),
    });
    expect(response.status).toBe(200);
    const written = JSON.parse(readFileSync(join(configDir, "server.json"), "utf8"));
    expect(written.models[0]).toEqual({
      id: "chatterbox",
      family: "chatterbox",
      path: "/models/chatterbox.gguf",
      task: "clon",
      mode: "offline",
    });
    expect(existsSync(join(configDir, "server.json"))).toBe(true);
  });

  it("patch invalide (`clone`) → 400 avec le détail champ par champ", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({ models: [{ ...VALID_MODEL, task: "clone" }] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; fields: Array<{ path: string; message: string }> };
    expect(body.code).toBe("invalid_engine_config");
    expect(body.fields[0]?.path).toBe("models[0].task");
    expect(body.fields[0]?.message).toContain("clon");
  });

  it("dossier non monté → 503 honnête (pas de 500)", async () => {
    const { baseUrl } = await startHarness({ mountConfig: false });
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({ models: [VALID_MODEL] }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe("config_dir_not_mounted");
  });

  it("JSON invalide → 400 invalid_json", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: "{ pas du json",
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("invalid_json");
  });
});

describe("POST /api/tts/engine-config/revert", () => {
  it("restaure la sauvegarde (garde-fou requis)", async () => {
    const { baseUrl, configDir } = await startHarness();
    const put = (body: unknown) =>
      fetch(`${baseUrl}/api/tts/engine-config`, {
        method: "PUT",
        headers: WRITE,
        body: JSON.stringify(body),
      });
    await put({ models: [VALID_MODEL] });
    await put({ globals: { port: 9100 } });
    const before = JSON.parse(readFileSync(join(configDir, "server.json"), "utf8"));
    expect(before.port).toBe(9100);

    const noGuard = await fetch(`${baseUrl}/api/tts/engine-config/revert`, { method: "POST" });
    expect(noGuard.status).toBe(403);

    const response = await fetch(`${baseUrl}/api/tts/engine-config/revert`, {
      method: "POST",
      headers: WRITE,
    });
    expect(response.status).toBe(200);
    const restored = JSON.parse(readFileSync(join(configDir, "server.json"), "utf8"));
    expect(restored.port).toBeUndefined();
  });

  it("sans sauvegarde → 404 no_backup", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config/revert`, {
      method: "POST",
      headers: WRITE,
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("no_backup");
  });
});

describe("GET /api/tts/capabilities — sonde sans effet de bord", () => {
  it("route absente (404) → unloadModels:false", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/capabilities`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { unloadModels: boolean | null; route: string };
    expect(body.unloadModels).toBe(false);
    expect(body.route).toBe("/v1/tasks/unload_models");
  });

  it("route présente (200) → unloadModels:true", async () => {
    const capabilityFetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const { baseUrl } = await startHarness({ capabilityFetch });
    const response = await fetch(`${baseUrl}/api/tts/capabilities`);
    const body = (await response.json()) as { unloadModels: boolean | null };
    expect(body.unloadModels).toBe(true);
  });

  it("moteur injoignable → indéterminé (null), jamais une erreur HTTP", async () => {
    const capabilityFetch = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const { baseUrl } = await startHarness({ capabilityFetch });
    const response = await fetch(`${baseUrl}/api/tts/capabilities`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { unloadModels: boolean | null; reachable: boolean };
    expect(body.reachable).toBe(false);
    expect(body.unloadModels).toBeNull();
  });
});
