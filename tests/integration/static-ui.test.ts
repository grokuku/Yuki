import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { inspectMountPoints, mountPoints } from "../../src/config/paths.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
import { createLogger } from "../../src/observability/logger.js";

const profiles = loadProfiles();
const manifest = loadCompatManifest();
const env = loadEnv({ YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt", YUKI_LOG_LEVEL: "error" });
const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const detection = detectGpus({
  command: env.gpuCmd,
  fixture: env.gpuFixture,
  commandFromEnv: env.gpuCmdFromEnv,
  cwd: process.cwd(),
});
const gate = runGate({ env, profiles, manifest, detection }, logger);

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
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
});

describe("UI statique servie par le gateway", () => {
  it("GET / sert index.html avec des en-têtes sûrs", async () => {
    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    const body = await response.text();
    expect(body).toContain("<title>Yuki</title>");
    expect(body).toContain("/ui/app.js");
  });

  it("GET /ui/app.js et /ui/styles.css servent les assets", async () => {
    const app = await fetch(`${baseUrl}/ui/app.js`);
    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toContain("javascript");

    const css = await fetch(`${baseUrl}/ui/styles.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
  });

  it("HEAD / répond sans corps", async () => {
    const response = await fetch(`${baseUrl}/`, { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("refuse la traversée de répertoire", async () => {
    // `%2e%2e` n'est pas normalisé par URL : la route doit refuser.
    const response = await fetch(`${baseUrl}/ui/%2e%2e/%2e%2e/package.json`);
    expect(response.status).toBe(404);
  });

  it("rejette les méthodes non GET/HEAD", async () => {
    const response = await fetch(`${baseUrl}/`, { method: "POST" });
    expect(response.status).toBe(405);
  });
});
