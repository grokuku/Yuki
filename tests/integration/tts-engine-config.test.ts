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
  /** Lignes de log capturées (uniquement si `options.logs` est fourni). */
  logs: string[];
}

async function startHarness(
  options: {
    mountConfig?: boolean;
    noEngineConfig?: boolean;
    capabilityFetch?: typeof fetch;
    logs?: string[];
  } = {},
): Promise<Harness> {
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
    YUKI_TTS_ENGINE_MODELS_DIR: "/models",
    YUKI_TTS_ENGINE_CONFIG_DIR: "/config",
  });
  const logger = createLogger({
    // Niveau `info` seulement quand on CAPTURE les lignes (instrumentation).
    level: options.logs ? "info" : "error",
    sink: options.logs ? (line) => options.logs?.push(line) : () => {},
    secretValues: [],
  });
  const store = new EngineConfigStore({
    configDir,
    engineConfigDir: "/config",
    modelsDir,
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
    logs: options.logs ?? [],
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

describe("PUT /api/tts/engine-config — garde-fou famille ↔ fichier du catalogue", () => {
  const QWEN_PATH = "/models/downloads/qwen3-tts/model.gguf";
  const qwenEntry = (overrides: Record<string, unknown> = {}) => ({
    id: "qwen3-tts",
    family: "qwen3_tts",
    task: "tts",
    mode: "offline",
    path: QWEN_PATH,
    ...overrides,
  });

  it("refuse une famille incohérente pour un chemin du catalogue (400 + message nommant tout)", async () => {
    const { baseUrl, configDir } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      // Cas RÉEL : le chemin du fichier Qwen déclaré avec la famille « chatterbox ».
      body: JSON.stringify({ models: [qwenEntry({ id: "chatterbox", family: "chatterbox" })] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      message: string;
      fields: Array<{ path: string; code: string; message: string }>;
    };
    expect(body.code).toBe("invalid_engine_config");
    const field = body.fields.find((f) => f.path === "models[0].family");
    expect(field).toBeTruthy();
    // Nomme l'entrée, le chemin, la valeur ATTENDUE et la valeur REÇUE.
    expect(body.message).toContain("chatterbox");
    expect(body.message).toContain("qwen3_tts");
    expect(body.message).toContain(QWEN_PATH);
    expect(body.message).toMatch(/Corrigez la famille/);
    // Rien n'a été écrit (le fichier n'existe pas encore).
    expect(existsSync(join(configDir, "server.json"))).toBe(false);
  });

  it("accepte la famille cohérente du catalogue (200 + fichier écrit)", async () => {
    const { baseUrl, configDir } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({ models: [qwenEntry()] }),
    });
    expect(response.status).toBe(200);
    const written = JSON.parse(readFileSync(join(configDir, "server.json"), "utf8"));
    expect(written.models[0]).toEqual({
      id: "qwen3-tts",
      family: "qwen3_tts",
      path: QWEN_PATH,
      task: "tts",
      mode: "offline",
    });
  });

  it("refuse une tâche incohérente pour un chemin du catalogue", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({ models: [qwenEntry({ task: "clon" })] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { fields: Array<{ path: string; code: string }> };
    expect(body.fields.some((f) => f.path === "models[0].task" && f.code === "catalog_task_mismatch")).toBe(
      true,
    );
  });

  it("refuse un mode incohérent pour un chemin du catalogue", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({ models: [qwenEntry({ mode: "streaming" })] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { fields: Array<{ path: string; code: string }> };
    expect(body.fields.some((f) => f.path === "models[0].mode" && f.code === "catalog_mode_mismatch")).toBe(
      true,
    );
  });

  it("accepte un chemin INCONNU du catalogue (GGUF personnel ou moteur hors catalogue)", async () => {
    const { baseUrl, configDir } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({
        models: [
          { id: "perso", family: "kokoro_tts", task: "tts", mode: "streaming", path: "/models/perso.gguf" },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const written = JSON.parse(readFileSync(join(configDir, "server.json"), "utf8"));
    expect(written.models[0].family).toBe("kokoro_tts");
  });

  it("le fichier EXISTANT incohérent reste éditable (le garde-fou ne l'invalide pas)", async () => {
    const { baseUrl, configDir } = await startHarness();
    // 1) on écrit un chemin catalogue avec une famille VOLONTAIREMENT fausse via
    //    le catalogue mocké d'un AUTRE id (aucun garde-fou) : on simule l'état cassé.
    writeFileSync(
      join(configDir, "server.json"),
      `${JSON.stringify(
        {
          models: [
            { id: "chatterbox", family: "chatterbox", path: "/models/chatterbox-q8_0.gguf", task: "clon", mode: "offline" },
            { id: "qwen3-tts", family: "chatterbox", path: QWEN_PATH, task: "clon", mode: "offline" },
          ],
        },
        null,
        2,
      )}\n`,
    );
    // 2) l'éditeur peut CORRIGER la famille : la lecture ne bloque pas (pas de 422).
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({
        models: [
          { id: "chatterbox", family: "chatterbox", path: "/models/chatterbox-q8_0.gguf", task: "clon", mode: "offline" },
          qwenEntry(),
        ],
      }),
    });
    expect(response.status).toBe(200);
    const written = JSON.parse(readFileSync(join(configDir, "server.json"), "utf8"));
    expect(written.models[1].family).toBe("qwen3_tts");
  });
});

describe("PUT /api/tts/engine-config — garde-fou sur les chemins MANUELS", () => {
  const MANUAL = "/models/chatterbox-q8_0.gguf";

  function manualEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: "chatterbox",
      family: "chatterbox",
      task: "clon",
      mode: "offline",
      path: MANUAL,
      ...overrides,
    };
  }

  it("refuse une famille incohérente sur un chemin manuel reconnu (basename)", async () => {
    const { baseUrl, configDir } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({ models: [manualEntry({ family: "qwen3_tts", task: "tts" })] }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      code: string;
      message: string;
      fields: Array<{ path: string; code: string; message: string }>;
    };
    expect(body.code).toBe("invalid_engine_config");
    const field = body.fields.find((f) => f.code === "catalog_family_mismatch");
    expect(field?.path).toBe("models[0].family");
    // Nomme le fichier reconnu, la valeur attendue et la valeur reçue.
    expect(field?.message).toContain("chatterbox-q8_0.gguf");
    expect(field?.message).toContain("chatterbox");
    expect(field?.message).toContain("qwen3_tts");
    expect(field?.message).toContain(MANUAL);
    expect(existsSync(join(configDir, "server.json"))).toBe(false);
  });

  it("accepte un chemin INCONNU (GGUF personnel / moteur hors catalogue)", async () => {
    const { baseUrl, configDir } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({
        models: [
          { id: "perso", family: "kokoro_tts", task: "tts", mode: "streaming", path: "/models/mon-perso.gguf" },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const written = JSON.parse(readFileSync(join(configDir, "server.json"), "utf8"));
    expect(written.models[0].family).toBe("kokoro_tts");
  });

  it("accepte la famille cohérente sur un chemin manuel reconnu", async () => {
    const { baseUrl, configDir } = await startHarness();
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({ models: [manualEntry()] }),
    });
    expect(response.status).toBe(200);
    const written = JSON.parse(readFileSync(join(configDir, "server.json"), "utf8"));
    expect(written.models[0].family).toBe("chatterbox");
  });

  it("SIGNALE une config déjà incohérente SANS la bloquer, puis la RÉPARE", async () => {
    const { baseUrl, configDir } = await startHarness();
    // État cassé PERSISTÉ à la main (comme chez l'utilisateur) : un chemin
    // chatterbox déclaré avec la famille « qwen3_tts ».
    writeFileSync(
      join(configDir, "server.json"),
      `${JSON.stringify(
        { models: [manualEntry({ family: "qwen3_tts", task: "tts" })] },
        null,
        2,
      )}\n`,
    );
    // 1) La LECTURE signale l'incohérence (même si elle n'est pas bloquante).
    const getResponse = await fetch(`${baseUrl}/api/tts/engine-config`);
    expect(getResponse.status).toBe(200);
    const report = (await getResponse.json()) as {
      valid: boolean;
      models: Array<{ id: string; coherenceIssues: Array<{ code: string; message: string }> }>;
    };
    expect(report.valid).toBe(true);
    expect(report.models[0]?.coherenceIssues.length).toBeGreaterThan(0);
    expect(report.models[0]?.coherenceIssues[0]?.code).toBe("catalog_family_mismatch");
    // 2) L'enregistrement n'est PAS bloqué par l'état cassé : on répare.
    const putResponse = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({ models: [manualEntry()] }),
    });
    expect(putResponse.status).toBe(200);
    const written = JSON.parse(readFileSync(join(configDir, "server.json"), "utf8"));
    expect(written.models[0].family).toBe("chatterbox");
  });
});

describe("Instrumentation — chaque écriture du moteur journalise le FLUX + le patch", () => {
  function writeLines(logs: string[]): Array<Record<string, unknown>> {
    return logs
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is Record<string, unknown> => entry !== null)
      .filter((entry) => entry.msg === "tts.engine_config.write");
  }

  it("un PUT accepté journalise le flux, le résultat et le contenu borné du patch", async () => {
    const logs: string[] = [];
    const { baseUrl } = await startHarness({ logs });
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: { ...WRITE, "x-yuki-config-flow": "declare-model" },
      body: JSON.stringify({ models: [VALID_MODEL] }),
    });
    expect(response.status).toBe(200);
    const writes = writeLines(logs);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.flow).toBe("declare-model");
    expect(writes[0]?.result).toBe("accepted");
    expect(writes[0]?.action).toBe("put");
    const models = writes[0]?.models as Array<Record<string, unknown>>;
    expect(models[0]?.family).toBe("chatterbox");
    expect(models[0]?.path).toBe("/models/chatterbox.gguf");
    expect(writes[0]?.modelCount).toBe(1);
  });

  it("un refus journalise le flux, la raison et le patch (niveau warn)", async () => {
    const logs: string[] = [];
    const { baseUrl } = await startHarness({ logs });
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: { ...WRITE, "x-yuki-config-flow": "engine-editor-save" },
      body: JSON.stringify({
        models: [{ ...VALID_MODEL, family: "qwen3_tts", path: "/models/chatterbox-q8_0.gguf" }],
      }),
    });
    expect(response.status).toBe(400);
    const writes = writeLines(logs);
    const refusal = writes.find((entry) => entry.result === "refused");
    expect(refusal?.flow).toBe("engine-editor-save");
    expect(refusal?.level).toBe("warn");
    expect(refusal?.code).toBe("invalid_engine_config");
    expect((refusal?.models as Array<Record<string, unknown>>)[0]?.path).toBe(
      "/models/chatterbox-q8_0.gguf",
    );
  });

  it("sans en-tête de flux, la valeur de repli est `unspecified` (compatibilité)", async () => {
    const logs: string[] = [];
    const { baseUrl } = await startHarness({ logs });
    const response = await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: WRITE,
      body: JSON.stringify({ models: [VALID_MODEL] }),
    });
    expect(response.status).toBe(200);
    expect(writeLines(logs)[0]?.flow).toBe("unspecified");
  });

  it("un flux mal formé n'est jamais recopié tel quel (jeton borné)", async () => {
    const logs: string[] = [];
    const { baseUrl } = await startHarness({ logs });
    await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: { ...WRITE, "x-yuki-config-flow": "bad flow with spaces!" },
      body: JSON.stringify({ models: [VALID_MODEL] }),
    });
    expect(writeLines(logs)[0]?.flow).toBe("unspecified");
  });

  it("la restauration journalise aussi le flux", async () => {
    const logs: string[] = [];
    const { baseUrl } = await startHarness({ logs });
    // Crée une sauvegarde via une première écriture, puis restaure.
    await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: { ...WRITE, "x-yuki-config-flow": "engine-editor-save" },
      body: JSON.stringify({ models: [VALID_MODEL] }),
    });
    await fetch(`${baseUrl}/api/tts/engine-config`, {
      method: "PUT",
      headers: { ...WRITE, "x-yuki-config-flow": "engine-editor-save" },
      body: JSON.stringify({ models: [{ ...VALID_MODEL, id: "kokoro", family: "kokoro_tts", task: "tts", path: "/models/kokoro.gguf" }] }),
    });
    const response = await fetch(`${baseUrl}/api/tts/engine-config/revert`, {
      method: "POST",
      headers: { ...WRITE, "x-yuki-config-flow": "revert-engine-config" },
    });
    expect(response.status).toBe(200);
    const reverts = writeLines(logs).filter((entry) => entry.action === "revert");
    expect(reverts).toHaveLength(1);
    expect(reverts[0]?.flow).toBe("revert-engine-config");
    expect(reverts[0]?.result).toBe("accepted");
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
