/**
 * Diagnostic TTS (Lot 8) — routes `/api/tts/*` via un VRAI serveur HTTP.
 *
 * Le moteur `audio.cpp` est SIMULÉ (`fetchImpl` injecté) : seul le contrat HTTP
 * Yuki (statut, modèles, test de synthèse, robustesse) est vérifié ici. Aucun
 * moteur réel n'est requis.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { inspectMountPoints, mountPoints } from "../../src/config/paths.js";
import { createConfigRuntime, type ConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import type { SubsystemsSnapshot } from "../../src/gateway/routes/health.js";
import {
  DEFAULT_TTS_TEST_TEXT,
  TtsDiagnostics,
  TTS_MODELS_MAX_FILES,
  inspectModelsDir,
  type TtsApiDeps,
  type TtsSynthesizer,
  type TtsVoiceResolver,
} from "../../src/gateway/routes/tts.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
import { createLogger } from "../../src/observability/logger.js";
import { AudioCppBusyError, AudioCppError } from "../../src/tts/audio-cpp.js";
import type { Voice } from "../../src/tts/types.js";
import { makeWav } from "../tts/wav-fixture.js";

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

function jsonResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TTS_BASE = "http://tts:8081";

/** `fetch` simulé routant `/health` et `/v1/models`. */
function engineFetch(routes: {
  health?: () => Response | Promise<Response>;
  models?: () => Response | Promise<Response>;
}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url).pathname;
    if (path === "/health" && routes.health) return routes.health();
    if (path === "/v1/models" && routes.models) return routes.models();
    return jsonResponse(404, JSON.stringify({ error: `route absente: ${path}` }));
  }) as unknown as typeof fetch;
}

/** `fetch` qui ne répond qu'à l'annulation (moteur « injoignable », hang). */
const hangingFetch = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      },
      { once: true },
    );
  })) as unknown as typeof fetch;

const failingFetch = (async () => {
  throw new Error("connect ECONNREFUSED 172.18.0.9:8081");
}) as unknown as typeof fetch;

interface HarnessOptions {
  enabled?: boolean;
  engine?: string;
  selectedVoice?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  ttlMs?: number;
  synth?: TtsSynthesizer;
  voices?: TtsVoiceResolver;
  modelsDir?: string;
  now?: () => number;
  withSubsystems?: boolean;
}

interface Harness {
  baseUrl: string;
  runtime: ConfigRuntime;
  diagnostics: TtsDiagnostics;
}

async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = tempDir("yuki-tts-diag-");
  const voicesDir = join(root, "voices");
  mkdirSync(voicesDir, { recursive: true });
  const modelsDir = options.modelsDir ?? join(root, "models");

  const env = loadEnv({
    YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: join(root, "state", "config.json"),
    YUKI_MOUNT_VOICES: voicesDir,
    YUKI_VOICES_DIR: voicesDir,
    YUKI_MOUNT_MODELS: modelsDir,
  });
  const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
  const runtime = createConfigRuntime({
    env,
    store: new ConfigStore(env.configStorePath),
    processEnv: {},
    promptDefaults: { light: "P", heavy: "H" },
  });
  if (options.enabled) runtime.update({ "tts.enabled": "on" });
  if (options.engine) runtime.update({ "tts.engine": options.engine });
  if (options.selectedVoice !== undefined) {
    runtime.update({ "tts.voice": options.selectedVoice });
  }

  const diagnostics = new TtsDiagnostics(
    {
      enabled: () => runtime.getString("tts.enabled") === "on",
      engine: () => runtime.getString("tts.engine"),
      baseUrl: () => runtime.getString("tts.baseUrl"),
    },
    {
      timeoutMs: options.timeoutMs ?? 50,
      ttlMs: options.ttlMs ?? 0,
      fetchImpl: options.fetchImpl ?? engineFetch({}),
      ...(options.now ? { now: options.now } : {}),
      logger,
    },
  );

  const ttsDeps: TtsApiDeps = {
    config: {
      getString: (path) => runtime.getString(path),
      getNumber: (path) => runtime.getNumber(path),
    },
    logger,
    voices: options.voices ?? { get: () => null },
    diagnostics,
    modelsDir,
    ...(options.synth ? { synth: options.synth } : {}),
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

  const getSubsystems = options.withSubsystems
    ? (): SubsystemsSnapshot => {
        const report = diagnostics.cachedStatus();
        return {
          pi: {
            status: "ready",
            cwd: "/workspace",
            agentDir: "/data/pi/agent",
            sessionsDir: "/data/pi/agent/sessions",
            sessionsCount: 0,
            activeRuns: 0,
          },
          transport: { ws: { clients: 0, replayBufferSize: 1000 }, sse: false },
          llm: {
            light: {
              provider: "llm-light",
              model: "gemma4:31b",
              status: "ready",
              keyPresent: true,
            },
            heavy: {
              provider: "llm-heavy",
              model: "deepseek-v4.1-flash",
              status: "ready",
              keyPresent: true,
            },
          },
          jobs: {
            running: 0,
            queued: 0,
            completed: 0,
            failed: 0,
            interrupted: 0,
            maxConcurrent: 3,
          },
          tts: { status: report.state, modelCount: report.modelCount, engine: report.engine },
        };
      }
    : undefined;

  const server = createServer({
    env,
    report: gate.report,
    gatePassed: gate.passed,
    startedAt: Date.now(),
    volumes: inspectMountPoints(mountPoints(env)),
    tts: ttsDeps,
    ...(getSubsystems ? { getSubsystems } : {}),
  });
  servers.push(server);
  const address = await startServer(server, "127.0.0.1", 0);
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    runtime,
    diagnostics,
  };
}

const WRITE = { "x-yuki-config": "1" };

const voiceFixture: Voice = {
  id: "camille",
  label: "Camille",
  kind: "cloned",
  lang: "fr",
  refAudio: "cloned/camille.wav",
  refText: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  createdBy: "user",
};

const okSynth: TtsSynthesizer = {
  synthesize: async () => ({ contentType: "audio/wav", bytes: makeWav() }),
};

describe("GET /api/tts/status", () => {
  it("moteur absent : 200, reachable:false, state unreachable, sans bloquer", async () => {
    const { baseUrl } = await startHarness({ enabled: true, fetchImpl: failingFetch });
    const response = await fetch(`${baseUrl}/api/tts/status`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      enabled: boolean;
      reachable: boolean;
      ready: unknown;
      modelCount: unknown;
      engine: string;
      baseUrl: string;
      latencyMs: number;
      error: string;
      state: string;
      modelsDir: { dir: string; present: boolean };
    };
    expect(body.enabled).toBe(true);
    expect(body.reachable).toBe(false);
    expect(body.ready).toBeNull();
    expect(body.state).toBe("unreachable");
    expect(body.engine).toBe("chatterbox");
    expect(body.baseUrl).toBe(TTS_BASE);
    expect(typeof body.latencyMs).toBe("number");
    expect(body.error).toContain("ECONNREFUSED");
    expect(body.modelsDir.present).toBe(false);
  });

  it("désactivé : state off même si le moteur répond", async () => {
    const { baseUrl } = await startHarness({
      enabled: false,
      fetchImpl: engineFetch({
        health: () => jsonResponse(200, '{"ready":true,"model_count":1}'),
      }),
    });
    const body = (await (await fetch(`${baseUrl}/api/tts/status`)).json()) as {
      enabled: boolean;
      state: string;
      reachable: boolean;
    };
    expect(body.enabled).toBe(false);
    expect(body.state).toBe("off");
    expect(body.reachable).toBe(true);
  });

  it("joignable mais pas prêt : state starting", async () => {
    const { baseUrl } = await startHarness({
      enabled: true,
      fetchImpl: engineFetch({
        health: () => jsonResponse(200, '{"ready":false,"model_count":0}'),
      }),
    });
    const body = (await (await fetch(`${baseUrl}/api/tts/status`)).json()) as {
      state: string;
      ready: boolean;
      modelCount: number;
    };
    expect(body.state).toBe("starting");
    expect(body.ready).toBe(false);
    expect(body.modelCount).toBe(0);
  });

  it("prêt : state ready avec modelCount", async () => {
    const { baseUrl } = await startHarness({
      enabled: true,
      fetchImpl: engineFetch({
        health: () => jsonResponse(200, '{"ready":true,"model_count":2}'),
      }),
    });
    const body = (await (await fetch(`${baseUrl}/api/tts/status`)).json()) as {
      state: string;
      modelCount: number;
    };
    expect(body.state).toBe("ready");
    expect(body.modelCount).toBe(2);
  });

  it("réponse en erreur : remonte le code ET le corps", async () => {
    const { baseUrl } = await startHarness({
      enabled: true,
      fetchImpl: engineFetch({
        health: () => jsonResponse(503, '{"error":"Insufficient Memory"}'),
      }),
    });
    const body = (await (await fetch(`${baseUrl}/api/tts/status`)).json()) as {
      reachable: boolean;
      state: string;
      error: string;
    };
    expect(body.reachable).toBe(true);
    expect(body.state).toBe("error");
    expect(body.error).toContain("503");
    expect(body.error).toContain("Insufficient Memory");
  });

  it("réponse NON-JSON (2xx) : jamais « erreur », corps brut conservé", async () => {
    const { baseUrl } = await startHarness({
      enabled: true,
      fetchImpl: engineFetch({
        health: () => jsonResponse(200, "pas du json"),
      }),
    });
    const body = (await (await fetch(`${baseUrl}/api/tts/status`)).json()) as {
      state: string;
      error: unknown;
      payload: string;
    };
    expect(body.state).not.toBe("error");
    expect(body.error).toBeNull();
    expect(body.payload).toContain("pas du json");
  });

  it("délai dépassé : reachable:false + message de timeout", async () => {
    const { baseUrl } = await startHarness({
      enabled: true,
      fetchImpl: hangingFetch,
      timeoutMs: 30,
    });
    const body = (await (await fetch(`${baseUrl}/api/tts/status`)).json()) as {
      reachable: boolean;
      error: string;
    };
    expect(body.reachable).toBe(false);
    expect(body.error).toContain("Délai dépassé");
  });

  it("décrit le répertoire des modèles (non vide)", async () => {
    const modelsDir = tempDir("yuki-models-");
    writeFileSync(join(modelsDir, "chatterbox-q8.gguf"), Buffer.alloc(1234));
    const { baseUrl } = await startHarness({
      enabled: true,
      modelsDir,
      fetchImpl: engineFetch({
        health: () => jsonResponse(200, '{"ready":true,"model_count":1}'),
      }),
    });
    const body = (await (await fetch(`${baseUrl}/api/tts/status`)).json()) as {
      modelsDir: {
        dir: string;
        present: boolean;
        readable: boolean;
        fileCount: number;
        files: Array<{ name: string; size: number }>;
      };
    };
    expect(body.modelsDir.dir).toBe(modelsDir);
    expect(body.modelsDir.present).toBe(true);
    expect(body.modelsDir.readable).toBe(true);
    expect(body.modelsDir.fileCount).toBe(1);
    expect(body.modelsDir.files).toEqual([
      { name: "chatterbox-q8.gguf", size: 1234 },
    ]);
  });
});

/**
 * Cœur du lot : la sonde `/health` doit être TOLÉRANTE à la forme réelle
 * (inconnue) et ne JAMAIS produire un faux « erreur » sur un champ absent ou
 * incompris. Une vraie erreur reste `error` (HTTP ≠ 2xx, champ d'erreur
 * explicite).
 */
describe("sonde /health tolérante (formes variées)", () => {
  async function statusFor(
    options: HarnessOptions,
  ): Promise<Record<string, unknown>> {
    const { baseUrl } = await startHarness({ enabled: true, ...options });
    return (await (await fetch(`${baseUrl}/api/tts/status`)).json()) as Record<
      string,
      unknown
    >;
  }

  it("/api/tts/status reste TOUJOURS 200, quelle que soit la forme", async () => {
    const payloads = [
      "{\"ready\":true}",
      "pas du json",
      "",
      "<html></html>",
      '{"weird":1}',
    ];
    for (const payload of payloads) {
      const { baseUrl } = await startHarness({
        enabled: true,
        fetchImpl: engineFetch({
          health: () => new Response(payload, { status: 200 }),
        }),
      });
      const response = await fetch(`${baseUrl}/api/tts/status`);
      expect(response.status, payload).toBe(200);
    }
  });

  it("ready booléen true → ready (prouvé, non déduit)", async () => {
    const body = await statusFor({
      fetchImpl: engineFetch({
        health: () => jsonResponse(200, '{"ready":true,"model_count":1}'),
      }),
    });
    expect(body.state).toBe("ready");
    expect(body.readinessInferred).toBe(false);
  });

  it("ready booléen false → starting", async () => {
    const body = await statusFor({
      fetchImpl: engineFetch({ health: () => jsonResponse(200, '{"ready":false}') }),
    });
    expect(body.state).toBe("starting");
    expect(body.ready).toBe(false);
  });

  it('ready en chaîne "true"/"ready"/"ok" → ready', async () => {
    for (const value of ["true", "ready", "ok"]) {
      const body = await statusFor({
        fetchImpl: engineFetch({
          health: () =>
            jsonResponse(200, JSON.stringify({ ready: value, model_count: 1 })),
        }),
      });
      expect(body.state, `ready=${value}`).toBe("ready");
      expect(body.ready).toBe(true);
    }
  });

  it('ready en chaîne "starting"/"loading" → starting', async () => {
    for (const value of ["starting", "loading"]) {
      const body = await statusFor({
        fetchImpl: engineFetch({
          health: () => jsonResponse(200, JSON.stringify({ ready: value })),
        }),
      });
      expect(body.state, `ready=${value}`).toBe("starting");
      expect(body.ready).toBe(false);
    }
  });

  it("ready en nombre 1 → ready ; 0 → starting", async () => {
    const one = await statusFor({
      fetchImpl: engineFetch({
        health: () => jsonResponse(200, '{"ready":1,"model_count":1}'),
      }),
    });
    expect(one.state).toBe("ready");
    const zero = await statusFor({
      fetchImpl: engineFetch({ health: () => jsonResponse(200, '{"ready":0}') }),
    });
    expect(zero.state).toBe("starting");
  });

  it("ready absent mais modèles listés → ready DÉDUIT + note honnête", async () => {
    const body = await statusFor({
      fetchImpl: engineFetch({ health: () => jsonResponse(200, '{"model_count":1}') }),
    });
    expect(body.state).toBe("ready");
    expect(body.readinessInferred).toBe(true);
    expect(String(body.readinessNote)).toMatch(/déduite/i);
    expect(body.modelCountSource).toBe("health");
  });

  it("ready ET model_count absents, mais /v1/models liste → ready déduit (cas réel)", async () => {
    const body = await statusFor({
      fetchImpl: engineFetch({
        health: () => jsonResponse(200, '{"statusText":"running","uptime_s":12}'),
        models: () =>
          jsonResponse(200, '{"data":[{"id":"chatterbox","task":"tts"}]}'),
      }),
    });
    expect(body.state).toBe("ready");
    expect(body.readinessInferred).toBe(true);
    expect(body.modelCountSource).toBe("models");
    expect(body.state).not.toBe("error");
  });

  it("model_count via clés/variantes (models_total, models_loaded, models[])", async () => {
    for (const payload of [
      '{"ready":true,"models_total":3}',
      '{"ready":true,"models_loaded":"2"}',
      '{"ready":true,"models":[{"id":"a"},{"id":"b"}]}',
    ]) {
      const body = await statusFor({
        fetchImpl: engineFetch({ health: () => jsonResponse(200, payload) }),
      });
      expect(body.state, payload).toBe("ready");
      expect(typeof body.modelCount).toBe("number");
    }
  });

  it("model_count absent → modelCount null, sans erreur", async () => {
    const body = await statusFor({
      fetchImpl: engineFetch({ health: () => jsonResponse(200, '{"ready":true}') }),
    });
    expect(body.state).toBe("ready");
    expect(body.modelCount).toBeNull();
  });

  it("réponse VIDE (2xx) → pas d'erreur, jamais crash", async () => {
    const body = await statusFor({
      fetchImpl: engineFetch({ health: () => new Response("", { status: 200 }) }),
    });
    expect(body.state).not.toBe("error");
    expect(body.error).toBeNull();
  });

  it("réponse HTML (2xx) → pas d'erreur, corps conservé", async () => {
    const body = await statusFor({
      fetchImpl: engineFetch({
        health: () =>
          new Response("<html><body>hi</body></html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      }),
    });
    expect(body.state).not.toBe("error");
    expect(body.payload).toContain("<html>");
  });

  it("/health en 500 → VRAIE erreur (preuve HTTP)", async () => {
    const body = await statusFor({
      fetchImpl: engineFetch({ health: () => jsonResponse(500, '{"error":"boom"}') }),
    });
    expect(body.state).toBe("error");
    expect(String(body.error)).toContain("500");
  });

  it("/health OK sans modèles + /v1/models vide → error « aucun modèle »", async () => {
    const body = await statusFor({
      fetchImpl: engineFetch({
        health: () => jsonResponse(200, '{"status":"ok","model_count":0}'),
        models: () => jsonResponse(200, '{"data":[]}'),
      }),
    });
    expect(body.state).toBe("error");
    expect(String(body.readinessNote)).toMatch(/Aucun modèle/i);
  });

  it("/v1/models vide alors que /health OK (sans compte) → error", async () => {
    const body = await statusFor({
      fetchImpl: engineFetch({
        health: () => jsonResponse(200, '{"status":"ok"}'),
        models: () => jsonResponse(200, '{"data":[]}'),
      }),
    });
    expect(body.state).toBe("error");
  });

  it("champ d'erreur explicite (2xx) → error", async () => {
    const body = await statusFor({
      fetchImpl: engineFetch({
        health: () => jsonResponse(200, '{"error":"model load failed"}'),
      }),
    });
    expect(body.state).toBe("error");
    expect(String(body.error)).toContain("model load failed");
  });

  it('état d\'échec explicite (`state:"failed"`, 2xx) → error', async () => {
    const body = await statusFor({
      fetchImpl: engineFetch({ health: () => jsonResponse(200, '{"state":"failed"}') }),
    });
    expect(body.state).toBe("error");
  });

  it("conservée : le corps brut borné de /health est exposé", async () => {
    const body = await statusFor({
      fetchImpl: engineFetch({
        health: () => jsonResponse(200, '{"ready":true,"extra":"x"}'),
      }),
    });
    expect(body.payload).toContain("extra");
  });

  it("journalise UNE fois la forme de /health (clés inconnues)", async () => {
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      sink: (line) => lines.push(line),
      secretValues: [],
    });
    const diagnostics = new TtsDiagnostics(
      { enabled: () => true, engine: () => "chatterbox", baseUrl: () => TTS_BASE },
      {
        timeoutMs: 50,
        ttlMs: 0,
        fetchImpl: engineFetch({
          health: () => jsonResponse(200, '{"ready":true,"weird_key":1}'),
        }),
        logger,
      },
    );
    await diagnostics.status();
    await diagnostics.status();
    const shapes = lines
      .map((line) => JSON.parse(line) as { msg?: string; keys?: unknown })
      .filter((entry) => entry.msg === "tts.health.shape");
    expect(shapes).toHaveLength(1);
    expect(shapes[0]?.keys).toContain("weird_key");
  });

  it("le test de synthèse reste utilisable quand /health n'expose pas `ready`", async () => {
    const { baseUrl } = await startHarness({
      enabled: true,
      synth: okSynth,
      fetchImpl: engineFetch({
        health: () => jsonResponse(200, '{"statusText":"running"}'),
      }),
    });
    const status = (await (await fetch(`${baseUrl}/api/tts/status`)).json()) as {
      state: string;
    };
    expect(status.state).not.toBe("error");
    const response = await fetch(`${baseUrl}/api/tts/test`, {
      method: "POST",
      headers: WRITE,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/wav");
  });
});

describe("GET /api/tts/models", () => {
  it("liste les modèles et signale la présence du moteur", async () => {
    const { baseUrl } = await startHarness({
      enabled: true,
      fetchImpl: engineFetch({
        models: () =>
          jsonResponse(
            200,
            '{"data":[{"id":"chatterbox","task":"tts"},{"id":"whisper","task":"asr"}]}',
          ),
      }),
    });
    const body = (await (await fetch(`${baseUrl}/api/tts/models`)).json()) as {
      reachable: boolean;
      count: number;
      enginePresent: boolean;
      models: Array<{ id: string; task: string }>;
    };
    expect(body.reachable).toBe(true);
    expect(body.count).toBe(2);
    expect(body.enginePresent).toBe(true);
    expect(body.models.map((m) => m.id)).toEqual(["chatterbox", "whisper"]);
  });

  it("signale l'ABSENCE du moteur dans la liste", async () => {
    const { baseUrl } = await startHarness({
      enabled: true,
      fetchImpl: engineFetch({
        models: () => jsonResponse(200, '{"data":[{"id":"kokoro","task":"tts"}]}'),
      }),
    });
    const body = (await (await fetch(`${baseUrl}/api/tts/models`)).json()) as {
      enginePresent: boolean;
      engine: string;
    };
    expect(body.engine).toBe("chatterbox");
    expect(body.enginePresent).toBe(false);
  });

  it("moteur absent : 200 avec erreur lisible", async () => {
    const { baseUrl } = await startHarness({ enabled: true, fetchImpl: failingFetch });
    const response = await fetch(`${baseUrl}/api/tts/models`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      reachable: boolean;
      count: unknown;
      error: string;
    };
    expect(body.reachable).toBe(false);
    expect(body.count).toBeNull();
    expect(body.error).toContain("ECONNREFUSED");
  });

  it("moteur en erreur : remonte le code HTTP", async () => {
    const { baseUrl } = await startHarness({
      enabled: true,
      fetchImpl: engineFetch({
        models: () => jsonResponse(500, "boom"),
      }),
    });
    const body = (await (await fetch(`${baseUrl}/api/tts/models`)).json()) as {
      reachable: boolean;
      error: string;
    };
    expect(body.reachable).toBe(true);
    expect(body.error).toContain("500");
  });
});

describe("POST /api/tts/test", () => {
  it("exige les garde-fous d'écriture", async () => {
    const { baseUrl } = await startHarness({ enabled: true, synth: okSynth });
    const noHeader = await fetch(`${baseUrl}/api/tts/test`, {
      method: "POST",
      body: JSON.stringify({ text: "Bonjour." }),
    });
    expect(noHeader.status).toBe(403);

    const badOrigin = await fetch(`${baseUrl}/api/tts/test`, {
      method: "POST",
      headers: { ...WRITE, origin: "http://evil.example" },
      body: JSON.stringify({ text: "Bonjour." }),
    });
    expect(badOrigin.status).toBe(403);
  });

  it("503 tts_unavailable sans fournisseur", async () => {
    const { baseUrl } = await startHarness({ enabled: true });
    const response = await fetch(`${baseUrl}/api/tts/test`, {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify({ text: "Bonjour." }),
    });
    expect(response.status).toBe(503);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "tts_unavailable",
    });
  });

  it("503 tts_disabled quand tts.enabled = off", async () => {
    const { baseUrl } = await startHarness({ enabled: false, synth: okSynth });
    const response = await fetch(`${baseUrl}/api/tts/test`, {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify({ text: "Bonjour." }),
    });
    expect(response.status).toBe(503);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "tts_disabled",
    });
  });

  it("renvoie un WAV pour un texte libre", async () => {
    const calls: Array<{ text: string; voice: Voice | null }> = [];
    const synth: TtsSynthesizer = {
      synthesize: async (input) => {
        calls.push(input);
        return { contentType: "audio/wav", bytes: makeWav() };
      },
    };
    const { baseUrl } = await startHarness({ enabled: true, synth });
    const response = await fetch(`${baseUrl}/api/tts/test`, {
      method: "POST",
      headers: WRITE,
      body: JSON.stringify({ text: "Le français est-il clair ?" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/wav");
    expect(response.headers.get("x-yuki-tts-voice")).toBe("default");
    expect(response.headers.get("x-yuki-tts-engine")).toBe("chatterbox");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe("Le français est-il clair ?");
  });

  it("utilise la phrase par défaut si le texte est absent", async () => {
    const calls: string[] = [];
    const synth: TtsSynthesizer = {
      synthesize: async (input) => {
        calls.push(input.text);
        return { contentType: "audio/wav", bytes: makeWav() };
      },
    };
    const { baseUrl } = await startHarness({ enabled: true, synth });
    const response = await fetch(`${baseUrl}/api/tts/test`, {
      method: "POST",
      headers: WRITE,
    });
    expect(response.status).toBe(200);
    expect(calls[0]).toBe(DEFAULT_TTS_TEST_TEXT);
  });

  it("résout la voix active par le même chemin que le pipeline", async () => {
    const seen: Array<Voice | null> = [];
    const synth: TtsSynthesizer = {
      synthesize: async (input) => {
        seen.push(input.voice);
        return { contentType: "audio/wav", bytes: makeWav() };
      },
    };
    const voices: TtsVoiceResolver = {
      get: (id) => (id === "camille" ? voiceFixture : null),
    };
    const { baseUrl } = await startHarness({
      enabled: true,
      synth,
      voices,
      selectedVoice: "camille",
    });
    await fetch(`${baseUrl}/api/tts/test`, { method: "POST", headers: WRITE });
    expect(seen[0]?.id).toBe("camille");
  });

  it("expose la voix utilisée dans un en-tête de diagnostic", async () => {
    const voices: TtsVoiceResolver = {
      get: (id) => (id === "camille" ? voiceFixture : null),
    };
    const { baseUrl } = await startHarness({
      enabled: true,
      synth: okSynth,
      voices,
      selectedVoice: "camille",
    });
    const response = await fetch(`${baseUrl}/api/tts/test`, {
      method: "POST",
      headers: WRITE,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-yuki-tts-voice")).toBe("camille");
  });

  it("voix inconnue ⇒ null (voix par défaut du service)", async () => {
    const seen: Array<Voice | null> = [];
    const synth: TtsSynthesizer = {
      synthesize: async (input) => {
        seen.push(input.voice);
        return { contentType: "audio/wav", bytes: makeWav() };
      },
    };
    const { baseUrl } = await startHarness({
      enabled: true,
      synth,
      selectedVoice: "inconnue",
    });
    await fetch(`${baseUrl}/api/tts/test`, { method: "POST", headers: WRITE });
    expect(seen[0]).toBeNull();
  });

  it("borne la taille du texte (400) et valide le type", async () => {
    const { baseUrl } = await startHarness({ enabled: true, synth: okSynth });
    const tooLong = await fetch(`${baseUrl}/api/tts/test`, {
      method: "POST",
      headers: { ...WRITE, "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(501) }),
    });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()) as { code: string }).toMatchObject({
      code: "text_too_long",
    });

    const badType = await fetch(`${baseUrl}/api/tts/test`, {
      method: "POST",
      headers: { ...WRITE, "content-type": "application/json" },
      body: JSON.stringify({ text: 123 }),
    });
    expect(badType.status).toBe(400);
    expect((await badType.json()) as { code: string }).toMatchObject({
      code: "invalid_text",
    });
  });

  it("503 server_busy expose le corps d'erreur du moteur (sans mentir)", async () => {
    const synth: TtsSynthesizer = {
      synthesize: async () => {
        throw new AudioCppBusyError(
          undefined,
          '{"error":"Insufficient Memory","free_mb":64}',
        );
      },
    };
    const { baseUrl } = await startHarness({ enabled: true, synth });
    const response = await fetch(`${baseUrl}/api/tts/test`, {
      method: "POST",
      headers: WRITE,
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      code: string;
      engineStatus: number;
      engineBody: string;
    };
    expect(body.code).toBe("server_busy");
    expect(body.engineStatus).toBe(503);
    expect(body.engineBody).toContain("Insufficient Memory");
  });

  it("504 sur timeout, 502 sur erreur HTTP", async () => {
    const timeoutSynth: TtsSynthesizer = {
      synthesize: async () => {
        throw new AudioCppError("timeout", "Délai dépassé.", undefined);
      },
    };
    const { baseUrl: timeoutUrl } = await startHarness({
      enabled: true,
      synth: timeoutSynth,
    });
    const timeoutResponse = await fetch(`${timeoutUrl}/api/tts/test`, {
      method: "POST",
      headers: WRITE,
    });
    expect(timeoutResponse.status).toBe(504);

    const httpSynth: TtsSynthesizer = {
      synthesize: async () => {
        throw new AudioCppError("http_error", "Répondu 500.", 500, "boom");
      },
    };
    const { baseUrl: httpUrl } = await startHarness({ enabled: true, synth: httpSynth });
    const httpResponse = await fetch(`${httpUrl}/api/tts/test`, {
      method: "POST",
      headers: WRITE,
    });
    expect(httpResponse.status).toBe(502);
    const body = (await httpResponse.json()) as { engineStatus: number; engineBody: string };
    expect(body.engineStatus).toBe(500);
    expect(body.engineBody).toBe("boom");
  });
});

describe("performance de /health avec le TTS", () => {
  it("cachedStatus() est synchrone même avec une sonde qui traîne", async () => {
    let nowValue = 0;
    const diagnostics = new TtsDiagnostics(
      {
        enabled: () => true,
        engine: () => "chatterbox",
        baseUrl: () => TTS_BASE,
      },
      {
        timeoutMs: 20,
        ttlMs: 5_000,
        fetchImpl: hangingFetch,
        now: () => nowValue++,
      },
    );
    const t0 = performance.now();
    const report = diagnostics.cachedStatus();
    const elapsed = performance.now() - t0;
    expect(elapsed).toBeLessThan(50);
    expect(report.reachable).toBe(false);
    // Laisse la sonde de fond s'annuler (pas de fuite).
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  it("/health reste rapide même moteur injoignable", async () => {
    const { baseUrl } = await startHarness({
      enabled: true,
      fetchImpl: hangingFetch,
      timeoutMs: 1_500,
      withSubsystems: true,
    });
    const t0 = performance.now();
    const response = await fetch(`${baseUrl}/health`);
    const elapsed = performance.now() - t0;
    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(500);
    const body = (await response.json()) as {
      subsystems: SubsystemsSnapshot;
    };
    expect(body.subsystems.tts.status).toBe("unreachable");
    // /health/ready reste 200 (le TTS n'est jamais bloquant).
    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
  });
});

describe("inspectModelsDir", () => {
  it("répertoire absent = état normal", () => {
    const report = inspectModelsDir(join(tempDir("yuki-models-"), "absent"));
    expect(report.present).toBe(false);
    expect(report.readable).toBe(false);
    expect(report.fileCount).toBe(0);
    expect(report.error).toBeNull();
  });

  it("répertoire vide = état normal", () => {
    const dir = tempDir("yuki-models-");
    const report = inspectModelsDir(dir);
    expect(report.present).toBe(true);
    expect(report.readable).toBe(true);
    expect(report.fileCount).toBe(0);
    expect(report.files).toEqual([]);
  });

  it("chemin qui est un fichier = traité comme absent (ENOTDIR)", () => {
    const dir = tempDir("yuki-models-");
    const file = join(dir, "pas-un-dossier");
    writeFileSync(file, "x");
    const report = inspectModelsDir(file);
    expect(report.present).toBe(false);
    expect(report.error).toBeNull();
  });

  it("liste bornée avec `truncated`", () => {
    const dir = tempDir("yuki-models-");
    for (let i = 0; i < TTS_MODELS_MAX_FILES + 5; i += 1) {
      writeFileSync(join(dir, `model-${String(i).padStart(3, "0")}.gguf`), "x");
    }
    const report = inspectModelsDir(dir);
    expect(report.present).toBe(true);
    expect(report.fileCount).toBe(TTS_MODELS_MAX_FILES + 5);
    expect(report.files).toHaveLength(TTS_MODELS_MAX_FILES);
    expect(report.truncated).toBe(true);
  });
});
