import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { inspectMountPoints, mountPoints } from "../../src/config/paths.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import { createLogger } from "../../src/observability/logger.js";

const profiles = loadProfiles();
const manifest = loadCompatManifest();

const env = loadEnv({
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_COMPAT_MODE: "strict",
  YUKI_LOG_LEVEL: "error",
});

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

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
});

let baseUrl = "";

beforeAll(async () => {
  const address = await startServer(server, "127.0.0.1", 0);
  baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("gateway HTTP (fixture RTX 4070)", () => {
  it("la porte est passée", () => {
    expect(gate.passed).toBe(true);
  });

  it("GET /health/live -> 200", async () => {
    const response = await fetch(`${baseUrl}/health/live`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("GET /health/ready -> 200", async () => {
    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("ready");
    expect(body.profile).toBe("confort");
  });

  it("GET /health -> 200 avec le GpuReport complet", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      version: string;
      uptime: number;
      profile: string;
      gpu: Record<string, unknown>;
      volumes: Array<{ id: string; mode: string; path: string }>;
    };

    expect(body.status).toBe("ok");
    expect(body.version).toBe("0.1.0");
    expect(typeof body.uptime).toBe("number");
    expect(body.profile).toBe("confort");

    expect(body.gpu.resolvedProfile).toBe("confort");
    expect(body.gpu.resolution).toBe("auto-highest-compatible");
    const capabilities = body.gpu.capabilities as Record<string, unknown>;
    expect(capabilities["gpu.present"]).toBe(true);
    expect(capabilities["gpu.bf16"]).toBe(true);

    expect(body.volumes).toHaveLength(4);
    expect(body.volumes.map((volume) => volume.id)).toEqual([
      "pi",
      "workspace",
      "models",
      "state",
    ]);
    const models = body.volumes.find((volume) => volume.id === "models");
    expect(models?.mode).toBe("ro");
  });

  it("GET /version -> 200 avec les versions verrouillées", async () => {
    const response = await fetch(`${baseUrl}/version`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      name: string;
      version: string;
      node: string;
      locked: Record<string, string>;
    };
    expect(body.name).toBe("yuki");
    expect(body.node).toBe(process.version);
    expect(body.locked.typescript).toBe("5.9.3");
    expect(body.locked.vitest).toBe("5.0.1");
  });

  it("route inconnue -> 404", async () => {
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
  });
});
