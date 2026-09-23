/**
 * Route d'administration `POST /api/admin/restart` — garde-fous identiques aux
 * écritures de configuration, réponse `200` PUIS demande d'arrêt gracieux
 * (injectée : les tests ne tuent pas le processus).
 */

import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { Env } from "../../src/config/env.js";
import type { AppContext } from "../../src/gateway/app.js";
import { createApp } from "../../src/gateway/app.js";
import {
  handleAdminRequest,
  RESTART_DELAY_MS,
  type AdminApiDeps,
} from "../../src/gateway/routes/admin.js";
import { createLogger } from "../../src/observability/logger.js";
import type { GpuReport } from "../../src/types/gpu.js";

const servers: Array<ReturnType<typeof createHttpServer>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }
});

interface Spy {
  deps: AdminApiDeps;
  lines: string[];
  shutdowns: string[];
  scheduled: Array<() => void>;
}

function makeSpy(): Spy {
  const lines: string[] = [];
  const shutdowns: string[] = [];
  const scheduled: Array<() => void> = [];
  const deps: AdminApiDeps = {
    logger: createLogger({ level: "info", sink: (line) => lines.push(line), secretValues: [] }),
    requestShutdown: () => shutdowns.push("shutdown"),
    schedule: (callback, delayMs) => {
      // On enregistre le callback ET le délai : la route ne doit pas arrêter le
      // processus de test.
      expect(delayMs).toBe(RESTART_DELAY_MS);
      scheduled.push(callback);
    },
    now: () => Date.parse("2026-01-01T00:00:00Z"),
  };
  return { deps, lines, shutdowns, scheduled };
}

describe("handleAdminRequest — POST /api/admin/restart", () => {
  it("répond 200 et DEMANDE l'arrêt (après planification), en journalisant", () => {
    const spy = makeSpy();
    const response = handleAdminRequest({
      method: "POST",
      path: "/api/admin/restart",
      headers: { "x-yuki-config": "1" },
      deps: spy.deps,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, restarting: true });
    // La réponse part AVANT : l'arrêt est seulement planifié.
    expect(spy.shutdowns).toHaveLength(0);
    expect(spy.scheduled).toHaveLength(1);

    spy.scheduled[0]?.();
    expect(spy.shutdowns).toEqual(["shutdown"]);
    expect(spy.lines.join("\n")).toContain("admin.restart_requested");
  });

  it("refuse sans l'en-tête personnalisé (403) — aucune demande d'arrêt", () => {
    const spy = makeSpy();
    const response = handleAdminRequest({
      method: "POST",
      path: "/api/admin/restart",
      headers: {},
      deps: spy.deps,
    });
    expect(response.status).toBe(403);
    expect((response.body as { code: string }).code).toBe("missing_config_header");
    expect(spy.scheduled).toHaveLength(0);
  });

  it("refuse une origine étrangère (403) même avec l'en-tête", () => {
    const spy = makeSpy();
    const response = handleAdminRequest({
      method: "POST",
      path: "/api/admin/restart",
      headers: { host: "yuki.lan:8083", origin: "http://evil.example", "x-yuki-config": "1" },
      deps: spy.deps,
    });
    expect(response.status).toBe(403);
    expect((response.body as { code: string }).code).toBe("bad_origin");
    expect(spy.scheduled).toHaveLength(0);
  });

  it("accepte un accès par IP LAN (Origin = Host) — casse insensible", () => {
    const spy = makeSpy();
    const response = handleAdminRequest({
      method: "POST",
      path: "/api/admin/restart",
      headers: { Host: "10.10.0.5:8083", Origin: "http://10.10.0.5:8083", "X-Yuki-Config": "1" },
      deps: spy.deps,
    });
    expect(response.status).toBe(200);
    expect(spy.scheduled).toHaveLength(1);
  });

  it("refuse une méthode non POST (405) et un autre chemin (404)", () => {
    const spy = makeSpy();
    const get = handleAdminRequest({
      method: "GET",
      path: "/api/admin/restart",
      headers: { "x-yuki-config": "1" },
      deps: spy.deps,
    });
    expect(get.status).toBe(405);
    const other = handleAdminRequest({
      method: "POST",
      path: "/api/admin/other",
      headers: { "x-yuki-config": "1" },
      deps: spy.deps,
    });
    expect(other.status).toBe(404);
    expect(spy.scheduled).toHaveLength(0);
  });
});

describe("handleAdminRequest — redémarrage et téléchargement de modèle", () => {
  it("REFUSE (409) tant qu'un téléchargement est actif — aucune demande d'arrêt", () => {
    const spy = makeSpy();
    const deps: AdminApiDeps = {
      ...spy.deps,
      downloads: { hasActive: () => true, activeId: () => "chatterbox" },
    };
    const response = handleAdminRequest({
      method: "POST",
      path: "/api/admin/restart",
      headers: { "x-yuki-config": "1" },
      deps,
    });
    expect(response.status).toBe(409);
    expect((response.body as { code: string }).code).toBe("download_in_progress");
    expect((response.body as { activeDownload?: string }).activeDownload).toBe("chatterbox");
    expect(spy.scheduled).toHaveLength(0);
    expect(spy.lines.join("\n")).toContain("admin.restart_refused");
  });

  it("redémarre normalement (200) quand aucun téléchargement n'est actif", () => {
    const spy = makeSpy();
    const deps: AdminApiDeps = {
      ...spy.deps,
      downloads: { hasActive: () => false, activeId: () => null },
    };
    const response = handleAdminRequest({
      method: "POST",
      path: "/api/admin/restart",
      headers: { "x-yuki-config": "1" },
      deps,
    });
    expect(response.status).toBe(200);
    expect(spy.scheduled).toHaveLength(1);
  });
});

describe("gateway HTTP — POST /api/admin/restart (bout en bout)", () => {
  it("répond 200 et déclenche l'arrêt injecté (le serveur de test survit)", async () => {
    const spy = makeSpy();
    const context: AppContext = {
      env: { version: "test" } as unknown as Env,
      report: {} as unknown as GpuReport,
      gatePassed: true,
      startedAt: Date.now(),
      volumes: [],
      publicDir: "public/ui",
      admin: { ...spy.deps, schedule: (callback) => callback() },
    };
    const server = createHttpServer(createApp(context));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/api/admin/restart`, {
      method: "POST",
      headers: { "x-yuki-config": "1" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, restarting: true });
    // `schedule` immédiat dans ce test : l'arrêt a été demandé.
    expect(spy.shutdowns).toEqual(["shutdown"]);

    // Garde-fou : sans l'en-tête, la route refuse toujours (bout en bout).
    const denied = await fetch(`http://127.0.0.1:${port}/api/admin/restart`, { method: "POST" });
    expect(denied.status).toBe(403);
  });
});
