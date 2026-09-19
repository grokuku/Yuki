/**
 * API de configuration — mode dégradé, secrets jamais en clair, PUT (garde-fous,
 * validation, verrou d'env), test LLM hors SDK.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { inspectMountPoints, mountPoints } from "../../src/config/paths.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
import { createLogger } from "../../src/observability/logger.js";

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

interface Harness {
  baseUrl: string;
  runtime: ReturnType<typeof createConfigRuntime>;
  lines: string[];
}

async function startHarness(
  envOverrides: Record<string, string> = {},
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "yuki-api-"));
  tempDirs.push(root);
  const env = loadEnv({
    YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: join(root, "state", "config.json"),
    ...envOverrides,
  });
  const lines: string[] = [];
  const logger = createLogger({
    level: "info",
    sink: (line) => lines.push(line),
    secretValues: [],
  });
  const runtime = createConfigRuntime({
    env,
    store: new ConfigStore(env.configStorePath),
    processEnv: { ...envOverrides },
    promptDefaults: { light: "P", heavy: "H" },
  });
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
    config: { runtime, logger, now: () => Date.parse("2026-01-01T00:00:00Z") },
  });
  servers.push(server);
  const address = await startServer(server, "127.0.0.1", 0);
  return { baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`, runtime, lines };
}

const WRITE_HEADERS = { "x-yuki-config": "1", "content-type": "application/json" };

describe("GET /api/config en mode dégradé", () => {
  it("répond 200 SANS aucune clé et n'expose jamais de valeur", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/config`);
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw) as {
      fields: Record<string, { value?: unknown; configured?: boolean }>;
      status: { lightKey: boolean; heavyKey: boolean; ready: boolean };
    };
    expect(body.status.lightKey).toBe(false);
    expect(body.status.heavyKey).toBe(false);
    expect(body.status.ready).toBe(false);
    expect(body.fields["llm.light.apiKey"]).toMatchObject({
      configured: false,
      masked: null,
      source: "default",
    });
    expect(body.fields["llm.light.model"]).toMatchObject({
      value: "gemma4:31b",
      origin: "default",
      apply: "restart",
    });
    expect(body.fields["prompts.light"]).toMatchObject({ value: "P", origin: "default" });
  });
});

describe("PUT /api/config", () => {
  it("exige l'en-tête personnalisé et le contrôle d'origine", async () => {
    const { baseUrl } = await startHarness();
    const noHeader = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(noHeader.status).toBe(403);

    const badOrigin = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: { ...WRITE_HEADERS, origin: "http://evil.example" },
      body: "{}",
    });
    expect(badOrigin.status).toBe(403);
  });

  it("pose les clés, masque, bascule lightKey, journalise l'audit sans valeur", async () => {
    const { baseUrl, lines } = await startHarness();
    const secret = "fake-light-key-000000000000";
    const response = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify({
        "llm.light.apiKey": secret,
        "llm.heavy.apiKey": "fake-heavy-key-111111",
      }),
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    // Le corps brut ne contient JAMAIS la valeur de la clé.
    expect(raw).not.toContain(secret);
    const body = JSON.parse(raw) as {
      status: { lightKey: boolean; heavyKey: boolean; ready: boolean };
      applied: { hot: string[]; restart: string[] };
      fields: Record<string, { masked?: string }>;
    };
    expect(body.status.lightKey).toBe(true);
    expect(body.status.heavyKey).toBe(true);
    expect(body.status.ready).toBe(true);
    expect(body.applied.hot).toContain("llm.light.apiKey");
    expect(body.fields["llm.light.apiKey"]?.masked).toBe("••••0000");

    // Audit : lignes config.changed, jamais la clé.
    const audit = lines.filter((line) => line.includes("config.changed"));
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.join("\n")).not.toContain(secret);
  });

  it("valide : clé vide → 400 empty_api_key, bornes → fields[]", async () => {
    const { baseUrl } = await startHarness();
    const empty = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ "llm.light.apiKey": "   " }),
    });
    expect(empty.status).toBe(400);
    const emptyBody = (await empty.json()) as { fields: Array<{ path: string; message: string }> };
    expect(emptyBody.fields[0]?.path).toBe("llm.light.apiKey");

    const bad = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ "delegation.defaultDeadlineMs": 5 }),
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { fields: Array<{ path: string }> };
    expect(badBody.fields[0]?.path).toBe("delegation.defaultDeadlineMs");
  });

  it("applied.hot / applied.restart sont cohérents avec le schéma", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify({
        "gpu.profile": "compact",
        "delegation.defaultDeadlineMs": 2000,
      }),
    });
    const body = (await response.json()) as {
      applied: { hot: string[]; restart: string[] };
    };
    expect(body.applied.hot).toEqual(["delegation.defaultDeadlineMs"]);
    expect(body.applied.restart).toEqual(["gpu.profile"]);
  });

  it("refuse un champ verrouillé par l'environnement", async () => {
    const { baseUrl } = await startHarness({ YUKI_COMPAT_MODE: "auto-degrade" });
    const response = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ "gpu.compatMode": "strict" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string; variable: string };
    expect(body.code).toBe("locked_by_env");
    expect(body.variable).toBe("YUKI_COMPAT_MODE");
  });

  it("efface une clé avec null", async () => {
    const { baseUrl } = await startHarness();
    await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ "llm.light.apiKey": "key-abcdefgh" }),
    });
    const cleared = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ "llm.light.apiKey": null }),
    });
    const body = (await cleared.json()) as {
      status: { lightKey: boolean };
      fields: Record<string, { configured: boolean }>;
    };
    expect(body.status.lightKey).toBe(false);
    expect(body.fields["llm.light.apiKey"]?.configured).toBe(false);
  });
});

describe("POST /api/config/llm/test", () => {
  it("teste via fetch hors SDK et renvoie les modèles", async () => {
    const { runtime } = await startHarness();
    runtime.update({ "llm.light.apiKey": "key-test-000000" });
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const { handleConfigRequest } = await import("../../src/gateway/routes/config.js");
    const response = await handleConfigRequest({
      method: "POST",
      path: "/api/config/llm/test",
      headers: { "x-yuki-config": "1" },
      body: JSON.stringify({ role: "light" }),
      deps: {
        runtime,
        logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }),
        fetchImpl: fakeFetch,
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, status: 200, models: ["m1", "m2"] });
    expect(calls[0]).toContain("/models");
  });

  it("sans clé → ok:false explicite", async () => {
    const { runtime } = await startHarness();
    const { handleConfigRequest } = await import("../../src/gateway/routes/config.js");
    const response = await handleConfigRequest({
      method: "POST",
      path: "/api/config/llm/test",
      headers: { "x-yuki-config": "1" },
      body: JSON.stringify({ role: "heavy" }),
      deps: {
        runtime,
        logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }),
      },
    });
    expect(response.body).toMatchObject({ ok: false });
  });
});
