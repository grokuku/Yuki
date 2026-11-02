/**
 * API `/api/chat/status` (lot 18, lot 1).
 *
 * Ce que ce fichier prouve :
 *  - la LECTURE est GARDÉE (en-tête `X-Yuki-Config: 1`), comme `/api/config` et
 *    `/api/sources` : sans lui, 403 ;
 *  - le mode vient de la CONFIGURATION (`chat.mode`), pas d'une constante :
 *    changer le réglage change la réponse (`apply: hot`) ;
 *  - la réponse ne porte NI secret NI URL avec jeton ;
 *  - en mode distant, la création est refusée AVEC son motif (le même que
 *    celui opposé par le transport).
 *
 * ⚠️ Échoue sur le code d'origine : la route n'existe pas (`404`).
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ChatService } from "../../src/chat/index.js";
import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import { handleChatRequest } from "../../src/gateway/routes/chat.js";

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

interface Harness {
  baseUrl: string;
  runtime: ReturnType<typeof createConfigRuntime>;
}

/** Démarre un gateway minimal avec la seule API de discussion + la config. */
async function startHarness(processEnv: Record<string, string> = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "yuki-chat-"));
  tempDirs.push(root);
  const env = loadEnv({
    YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: join(root, "state", "config.json"),
  });
  const runtime = createConfigRuntime({
    env,
    store: new ConfigStore(env.configStorePath),
    processEnv: { ...processEnv },
    promptDefaults: { light: "P", heavy: "H" },
  });
  const service = new ChatService({
    mode: () => runtime.getString("chat.mode"),
    remoteAgents: () => runtime.getString("chat.remoteAgents"),
  });
  const server = createServer({
    env,
    report: {
      engine: "fixture",
      gpus: [],
      selected: null,
      profiles: [],
      compatibility: { mode: "strict", degraded: false, reasons: [] },
      warnings: [],
    } as never,
    gatePassed: true,
    startedAt: Date.now(),
    volumes: [],
    chat: { service },
  });
  servers.push(server);
  const address = await startServer(server, "127.0.0.1", 0);
  return { baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`, runtime };
}

const READ_HEADERS = { "x-yuki-config": "1", accept: "application/json" };

describe("GET /api/chat/status", () => {
  it("est GARDÉE par l'en-tête de configuration (403 sans lui)", async () => {
    const { baseUrl } = await startHarness();
    const denied = await fetch(`${baseUrl}/api/chat/status`);
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as { code?: string };
    expect(body.code).toBe("missing_config_header");

    const allowed = await fetch(`${baseUrl}/api/chat/status`, { headers: READ_HEADERS });
    expect(allowed.status).toBe(200);
  });

  it("défaut `local` : plateforme `on`, création autorisée", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/chat/status`, { headers: READ_HEADERS });
    const body = (await response.json()) as {
      mode: string;
      plateforme: { etat: string; raison?: string };
      creation: { autorisee: boolean; raison?: string };
      distant: { agents: string };
    };
    expect(body.mode).toBe("local");
    expect(body.plateforme.etat).toBe("on");
    expect(body.creation).toEqual({ autorisee: true });
    expect(body.distant).toEqual({ agents: "desactive" });
  });

  it("est CÂBLÉE sur `chat.mode` : un changement du réglage change la réponse", async () => {
    const { baseUrl, runtime } = await startHarness();
    runtime.update({ "chat.mode": "mattermost" });
    const response = await fetch(`${baseUrl}/api/chat/status`, { headers: READ_HEADERS });
    const body = (await response.json()) as {
      mode: string;
      plateforme: { etat: string; raison?: string };
      creation: { autorisee: boolean; raison?: string };
    };
    expect(body.mode).toBe("mattermost");
    expect(body.plateforme.etat).toBe("off");
    expect(body.creation.autorisee).toBe(false);
    expect(body.creation.raison).toContain("désactivée");
  });

  it("ne porte JAMAIS de secret ni d'URL avec jeton", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/chat/status`, { headers: READ_HEADERS });
    const raw = await response.text();
    expect(raw).not.toMatch(/https?:\/\//);
    expect(raw).not.toMatch(/token|jeton|secret|password|Bearer|apiKey/i);
  });

  it("refuse une méthode d'écriture et laisse 404 aux chemins inconnus", async () => {
    const { baseUrl } = await startHarness();
    const post = await fetch(`${baseUrl}/api/chat/status`, {
      method: "POST",
      headers: { ...READ_HEADERS, "content-type": "application/json" },
      body: "{}",
    });
    expect(post.status).toBe(405);
    const unknown = await fetch(`${baseUrl}/api/chat/inconnu`, { headers: READ_HEADERS });
    expect(unknown.status).toBe(404);
  });
});

describe("garde-fou directement sur le handler", () => {
  it("sans en-tête : 403, quel que soit le chemin", async () => {
    const service = new ChatService({ mode: () => "local" });
    const response = await handleChatRequest({
      method: "GET",
      path: "/api/chat/status",
      headers: {},
      deps: { service },
    });
    expect(response.status).toBe(403);
  });
});
