/**
 * API des notifications — mode dégradé (aucun PiHost) : état (clé PUBLIQUE
 * seule), abonnement/désabonnement par appareil, garde-fous d'écriture, et
 * ⚠️ NON-FUITE de la clé privée VAPID (réponses ET journaux).
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { inspectMountPoints, mountPoints } from "../../src/config/paths.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
import { createLogger } from "../../src/observability/logger.js";
import { PushSubscriptionStore } from "../../src/push/store.js";
import { loadOrCreateVapidKeys } from "../../src/push/vapid.js";

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
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const WRITE_HEADERS = { "x-yuki-config": "1", "content-type": "application/json" };

async function startHarness(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), "yuki-push-api-"));
  tempDirs.push(root);
  const env = loadEnv({
    YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_PUSH_VAPID_PATH: join(root, "state", "push-vapid.json"),
    YUKI_PUSH_SUBSCRIPTIONS_PATH: join(root, "state", "push-subs.json"),
  });
  const lines: string[] = [];
  const logger = createLogger({
    level: "info",
    sink: (line) => lines.push(line),
    secretValues: [],
  });
  const runtime = createConfigRuntime({
    env,
    processEnv: {},
    promptDefaults: { light: "P", heavy: "H" },
  });
  const { keys } = loadOrCreateVapidKeys(env.pushVapidPath, logger);
  const store = new PushSubscriptionStore({ path: env.pushSubscriptionsPath, logger });
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
    config: { runtime, logger },
    push: {
      store,
      logger,
      enabled: () => enabled,
      publicKey: keys.publicKey,
    },
  });
  servers.push(server);
  const address = await startServer(server, "127.0.0.1", 0);
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    store,
    lines,
  };
}

const validSubscription = {
  deviceId: "dev-abcdef",
  subscription: {
    endpoint: "https://push.example/ep-1",
    keys: { p256dh: "BAbcdef_-123", auth: "auth_-123456" },
  },
};

describe("GET /api/push/status", () => {
  it("renvoie la clé PUBLIQUE, l'activation et les appareils — jamais la privée", async () => {
    const h = await startHarness();
    const response = await fetch(`${h.baseUrl}/api/push/status`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.publicKey).toBe(h.publicKey);
    expect(body.enabled).toBe(true);
    expect(body.deviceCount).toBe(0);
    expect(body.devices).toEqual([]);
    // ⚠️ La clé privée n'apparaît NULLE PART (ni champ, ni valeur).
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(h.privateKey);
    expect(Object.keys(body)).not.toContain("privateKey");
  });

  it("l'état reflète la désactivation (`push.enabled = off`)", async () => {
    const h = await startHarness(false);
    const body = (await (await fetch(`${h.baseUrl}/api/push/status`)).json()) as {
      enabled: boolean;
    };
    expect(body.enabled).toBe(false);
  });
});

describe("POST /api/push/subscribe", () => {
  it("REFUSE sans en-tête X-Yuki-Config (garde-fou d'écriture)", async () => {
    const h = await startHarness();
    const response = await fetch(`${h.baseUrl}/api/push/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validSubscription),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("missing_config_header");
    expect(h.store.size).toBe(0);
  });

  it("enregistre un appareil valide", async () => {
    const h = await startHarness();
    const response = await fetch(`${h.baseUrl}/api/push/subscribe`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(validSubscription),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; deviceCount: number };
    expect(body.ok).toBe(true);
    expect(body.deviceCount).toBe(1);
    // L'état expose l'HÔTE de l'endpoint, jamais l'URL complète ni les clés.
    const status = (await (await fetch(`${h.baseUrl}/api/push/status`)).json()) as {
      devices: Array<Record<string, unknown>>;
    };
    expect(status.devices[0].host).toBe("push.example");
    expect(status.devices[0]).not.toHaveProperty("endpoint");
    expect(status.devices[0]).not.toHaveProperty("p256dh");
    expect(status.devices[0]).not.toHaveProperty("auth");
  });

  it("REFUSE un endpoint non http(s), une clé p256dh vide, un deviceId court", async () => {
    const h = await startHarness();
    const cases = [
      { ...validSubscription, subscription: { ...validSubscription.subscription, endpoint: "ftp://x" } },
      { ...validSubscription, subscription: { ...validSubscription.subscription, keys: { p256dh: "", auth: "a" } } },
      { ...validSubscription, deviceId: "court" },
    ];
    for (const body of cases) {
      const response = await fetch(`${h.baseUrl}/api/push/subscribe`, {
        method: "POST",
        headers: WRITE_HEADERS,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(h.store.size).toBe(0);
  });
});

describe("POST /api/push/unsubscribe", () => {
  it("retire l'appareil (et tolère un corps réduit `{ deviceId }`)", async () => {
    const h = await startHarness();
    await fetch(`${h.baseUrl}/api/push/subscribe`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(validSubscription),
    });
    expect(h.store.size).toBe(1);
    const response = await fetch(`${h.baseUrl}/api/push/unsubscribe`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ deviceId: "dev-abcdef" }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { removed: boolean }).removed).toBe(true);
    expect(h.store.size).toBe(0);
  });

  it("REFUSE sans en-tête d'écriture", async () => {
    const h = await startHarness();
    const response = await fetch(`${h.baseUrl}/api/push/unsubscribe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId: "dev-abcdef" }),
    });
    expect(response.status).toBe(403);
  });
});

describe("non-fuite de la clé privée VAPID", () => {
  it("n'apparaît ni dans les réponses ni dans les journaux du cycle complet", async () => {
    const h = await startHarness();
    const status = await (await fetch(`${h.baseUrl}/api/push/status`)).text();
    await fetch(`${h.baseUrl}/api/push/subscribe`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify(validSubscription),
    });
    await fetch(`${h.baseUrl}/api/push/unsubscribe`, {
      method: "POST",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ deviceId: "dev-abcdef" }),
    });
    expect(status).not.toContain(h.privateKey);
    for (const line of h.lines) {
      expect(line).not.toContain(h.privateKey);
    }
  });
});
