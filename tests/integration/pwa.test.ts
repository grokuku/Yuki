/**
 * PWA + Web Push — preuves de SERVICE par le gateway :
 *  - manifeste et service worker servis, mêmes origine et types MIME corrects ;
 *  - le service worker est bien du JAVASCRIPT (jamais une page HTML, ce que
 *    renverrait un forward-auth qui intercepterait le chemin) ;
 *  - la CSP n'est élargie QUE de `manifest-src 'self'` (nécessaire au manifeste),
 *    sans `unsafe-inline`, `unsafe-eval` ni joker.
 */

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
const gate = runGate(
  { config: { compatMode: "strict" as const, profile: null, minDriver: 580 }, profiles, manifest, detection },
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
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
});

describe("Manifeste PWA", () => {
  it("GET /manifest.webmanifest : 200, type `application/manifest+json`, JSON valide", async () => {
    const response = await fetch(`${baseUrl}/manifest.webmanifest`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/manifest+json");
    const body = (await response.json()) as {
      name: string;
      short_name: string;
      display: string;
      start_url: string;
      scope: string;
      theme_color: string;
      background_color: string;
      icons: Array<{ src: string; sizes: string; purpose?: string }>;
    };
    expect(body.name).toBe("Yuki");
    expect(body.short_name).toBe("Yuki");
    expect(body.display).toBe("standalone");
    expect(body.start_url).toBe("/");
    expect(body.scope).toBe("/");
    expect(body.theme_color).toMatch(/^#/);
    expect(body.background_color).toMatch(/^#/);
    // Installabilité : 192 + 512 (+ maskable).
    const sizes = body.icons.map((icon) => icon.sizes);
    expect(sizes).toContain("192x192");
    expect(sizes).toContain("512x512");
    expect(body.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
  });

  it("sert les icônes déclarées (image/png, 200)", async () => {
    for (const path of [
      "/ui/icons/icon-192.png",
      "/ui/icons/icon-512.png",
      "/ui/icons/icon-maskable-512.png",
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type"), path).toBe("image/png");
    }
  });
});

describe("Service worker", () => {
  it("GET /sw.js : 200, JAVASCRIPT (jamais du HTML), portée racine", async () => {
    const response = await fetch(`${baseUrl}/sw.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    const body = await response.text();
    // ⚠️ Preuve « non intercepté par un forward-auth » : le corps est du code JS,
    // pas la page HTML de connexion d'authentik.
    expect(body.trimStart().startsWith("<")).toBe(false);
    expect(body).not.toContain("<!doctype");
    expect(body).toContain('addEventListener("push"');
    expect(body).toContain('addEventListener("notificationclick"');
    expect(body).toContain("showNotification");
  });

  it("l'index déclare le manifeste, la couleur de thème et le bouton de notifications", async () => {
    const html = await (await fetch(`${baseUrl}/`)).text();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('name="theme-color"');
    expect(html).toContain('id="notif-toggle"');
    // CSP : toujours aucun style inline, aucun SVG inline dans le markup.
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toContain("<svg");
  });

  it("app.js enregistre le service worker, suit la présence et gère le clic de notification", async () => {
    const js = await (await fetch(`${baseUrl}/ui/app.js`)).text();
    expect(js).toContain('from "./push.js"');
    expect(js).toContain("registerServiceWorker");
    expect(js).toContain("initPresenceTracking");
    expect(js).toContain("createNotificationsControl");
    expect(js).toContain("deepLinkSession");
  });

  it("push.js enregistre /sw.js (même origine) et ne manipule jamais la clé privée", async () => {
    const js = await (await fetch(`${baseUrl}/ui/push.js`)).text();
    expect(js).toContain('navigator.serviceWorker.register("/sw.js"');
    expect(js).toContain("/api/push/subscribe");
    expect(js).toContain("/api/push/unsubscribe");
    expect(js).toContain("/api/push/status");
    expect(js).toContain("requestPermission");
    // Aucune trace de clé privée côté client.
    expect(js).not.toContain("privateKey");
    expect(js).not.toContain("innerHTML");
  });
});

describe("CSP — élargissement minimal et prouvé", () => {
  it("ajoute UNIQUEMENT `manifest-src 'self'` (nécessaire au manifeste)", async () => {
    for (const path of ["/", "/config", "/manifest.webmanifest", "/sw.js"]) {
      const csp = (await fetch(`${baseUrl}${path}`)).headers.get("content-security-policy") ?? "";
      expect(csp, path).toContain("default-src 'none'");
      expect(csp, path).toContain("manifest-src 'self'");
      expect(csp, path).toContain("script-src 'self'");
      // Aucune ouverture de confort : ni wildcard, ni inline/eval.
      expect(csp, path).not.toContain("unsafe-inline");
      expect(csp, path).not.toContain("unsafe-eval");
      expect(csp, path).not.toContain("*");
    }
  });

  it("le service worker est couvert par script-src (aucun `worker-src` requis)", async () => {
    const csp = (await fetch(`${baseUrl}/sw.js`)).headers.get("content-security-policy") ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("worker-src");
  });
});

describe("Réglage des notifications dans /config", () => {
  it("expose push.enabled (enum off|on) et push.contact dans l'onglet Système", async () => {
    const js = await (await fetch(`${baseUrl}/ui/config.js`)).text();
    expect(js).toContain('path: "push.enabled"');
    expect(js).toContain('path: "push.contact"');
    expect(js).toContain('"notifications"');
    expect(js).toContain('"push.enabled": "on"');
    expect(js).not.toContain("innerHTML");
  });
});
