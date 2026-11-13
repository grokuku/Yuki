/**
 * API `/api/chat/status` (lot 18, lot 1).
 *
 * Ce que ce fichier prouve :
 *  - la LECTURE est GARDÉE (en-tête `X-Yuki-Config: 1`), comme `/api/config` et
 *    `/api/sources` : sans lui, 403 ;
 *  - les INTERRUPTEURS viennent de la CONFIGURATION (`chat.mattermost.enabled`,
 *    `chat.discord.enabled`), pas d'une constante : changer le réglage change la
 *    réponse (`apply: hot`), et les deux sont INDÉPENDANTS ;
 *  - la réponse ne porte NI secret NI URL avec jeton ;
 *  - le LOCAL n'est jamais coupé : la création locale reste toujours autorisée.
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
    // ⚠️ Les INTERRUPTEURS sont lus dans la configuration réelle du runtime
    // (`apply: hot`) : c'est ce qui rend ce banc capable de prouver le câblage.
    enabled: (plateforme) => runtime.getString(`chat.${plateforme}.enabled`) === "on",
    remoteAgents: () => runtime.getString("chat.remoteAgents"),
    remoteTools: () => runtime.getString("chat.remoteTools"),
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

  it("défaut : aucune plateforme activée, local seul, création autorisée", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/chat/status`, { headers: READ_HEADERS });
    const body = (await response.json()) as {
      mode: string;
      plateforme: { etat: string; raison?: string };
      creation: { autorisee: boolean; raison?: string };
      distant: { agents: string; outils: string };
    };
    expect(body.mode).toBe("local");
    expect((body as unknown as { plateformes: unknown }).plateformes).toEqual({
      mattermost: false,
      discord: false,
    });
    expect(body.plateforme.etat).toBe("on");
    expect(body.creation).toEqual({ autorisee: true });
    // ⚠️ LES DEUX valeurs sont exposées : l'interface ne peut pas deviner l'une à
    // partir de l'autre, et le défaut est bien `desactive`/`desactive`.
    expect(body.distant).toEqual({ agents: "desactive", outils: "desactive" });
  });

  it("est CÂBLÉE sur les INTERRUPTEURS : un changement change la réponse", async () => {
    const { baseUrl, runtime } = await startHarness();
    // ⚠️ Adapté le 2026-11-10 : ce n'est plus `chat.mode` (choix exclusif retiré,
    // il coupait les plateformes non choisies) mais les deux interrupteurs.
    runtime.update({ "chat.mattermost.enabled": "on" });
    const response = await fetch(`${baseUrl}/api/chat/status`, { headers: READ_HEADERS });
    const body = (await response.json()) as {
      plateformes: { mattermost: boolean; discord: boolean };
      plateforme: { etat: string; raison?: string };
      creation: { autorisee: boolean; raison?: string };
    };
    expect(body.plateformes).toEqual({ mattermost: true, discord: false });
    // Plateforme ACTIVÉE mais aucun adaptateur câblé dans ce banc : `off`, avec un
    // motif qui dit quoi faire.
    expect(body.plateforme.etat).toBe("off");
    // ⚠️ Le LOCAL reste disponible : la création n'est JAMAIS refusée.
    expect(body.creation).toEqual({ autorisee: true });
  });

  it("les deux interrupteurs sont INDÉPENDANTS (les deux `on` en même temps)", async () => {
    const { baseUrl, runtime } = await startHarness();
    runtime.update({ "chat.mattermost.enabled": "on", "chat.discord.enabled": "on" });
    const response = await fetch(`${baseUrl}/api/chat/status`, { headers: READ_HEADERS });
    const body = (await response.json()) as { plateformes: { mattermost: boolean; discord: boolean } };
    expect(body.plateformes).toEqual({ mattermost: true, discord: true });
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
