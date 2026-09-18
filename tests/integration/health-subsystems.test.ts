import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { inspectMountPoints, mountPoints } from "../../src/config/paths.js";
import type { SubsystemsSnapshot } from "../../src/gateway/routes/health.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
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
const gate = runGate({ env, profiles, manifest, detection }, logger);

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
});

async function start(subsystems: SubsystemsSnapshot): Promise<string> {
  const server = createServer({
    env,
    report: gate.report,
    gatePassed: gate.passed,
    startedAt: Date.now(),
    volumes: inspectMountPoints(mountPoints(env)),
    getSubsystems: () => subsystems,
  });
  servers.push(server);
  const address = await startServer(server, "127.0.0.1", 0);
  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

function snapshot(status: "ready" | "starting" | "error"): SubsystemsSnapshot {
  return {
    pi: {
      status,
      cwd: "/workspace",
      agentDir: "/data/pi/agent",
      sessionsDir: "/data/pi/agent/sessions",
      sessionsCount: 2,
      activeRuns: 0,
    },
    transport: { ws: { clients: 1, replayBufferSize: 1000 }, sse: false },
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
  };
}

describe("sous-systèmes exposés par /health", () => {
  it("expose le bloc subsystems et rend ready 200", async () => {
    const baseUrl = await start(snapshot("ready"));
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as {
      subsystems: SubsystemsSnapshot;
    };
    expect(health.subsystems.pi.status).toBe("ready");
    expect(health.subsystems.pi.cwd).toBe("/workspace");
    expect(health.subsystems.pi.sessionsCount).toBe(2);
    expect(health.subsystems.transport.ws.replayBufferSize).toBe(1000);
    expect(health.subsystems.transport.sse).toBe(false);

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
  });

  it("rend /health/ready 503 tant que le PiHost n'est pas prêt", async () => {
    const baseUrl = await start(snapshot("starting"));
    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as { status: string; pi: string };
    expect(body.status).toBe("not-ready");
    expect(body.pi).toBe("starting");
  });

  it("expose subsystems.llm et subsystems.jobs", async () => {
    const baseUrl = await start(snapshot("ready"));
    const health = (await (await fetch(`${baseUrl}/health`)).json()) as {
      subsystems: SubsystemsSnapshot;
    };
    expect(health.subsystems.llm.light).toMatchObject({
      provider: "llm-light",
      model: "gemma4:31b",
      status: "ready",
      keyPresent: true,
    });
    expect(health.subsystems.jobs.maxConcurrent).toBe(3);
  });

  it("rend /health/ready 503 si le LLM léger est indisponible (clé absente)", async () => {
    const withUnavailableLight = snapshot("ready");
    withUnavailableLight.llm.light.status = "unavailable";
    withUnavailableLight.llm.light.keyPresent = false;
    const baseUrl = await start(withUnavailableLight);
    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(503);
    const body = (await ready.json()) as {
      status: string;
      llm: { status: string };
    };
    expect(body.status).toBe("not-ready");
    expect(body.llm.status).toBe("unavailable");
  });
});
