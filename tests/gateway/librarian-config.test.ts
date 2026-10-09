/**
 * Test de connexion au libraire + masquage des secrets (page /config).
 *
 * Prouve : le bouton « Tester la connexion » renvoie un résultat HONNÊTE et
 * DISTINCT pour chaque cas (joignable, 401 clé, 403 jeton, 502 web indisponible,
 * 429, injoignable), jamais une cause inventée ; et les deux secrets du libraire
 * sont MASQUÉS (jamais en clair dans `GET /api/config`, jamais dans les logs).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime, type ConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";
import { handleConfigRequest } from "../../src/gateway/routes/config.js";
import { createLogger } from "../../src/observability/logger.js";
import { startMockLibrarian, type MockLibrarian, type MockResponse } from "../librarian/mock-librarian.js";

const tempDirs: string[] = [];
const servers: MockLibrarian[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runtimeWith(): ConfigRuntime {
  const root = mkdtempSync(join(tmpdir(), "yuki-librarian-config-"));
  tempDirs.push(root);
  const env = loadEnv({
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: join(root, "state", "config.json"),
  });
  return createConfigRuntime({
    env,
    store: new ConfigStore(env.configStorePath),
    // ⚠️ Aucune surcharge d'environnement : la config testée est celle du store.
    processEnv: {},
    promptDefaults: { light: "P", heavy: "H" },
  });
}

async function callTest(
  runtime: ConfigRuntime,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handleConfigRequest({
    method: "POST",
    path: "/api/config/librarian/test",
    headers: { "x-yuki-config": "1" },
    body: JSON.stringify(body),
    deps: { runtime, logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }) },
  });
  return { status: response.status, body: response.body as Record<string, unknown> };
}

async function harnessWithMock(configure: MockResponse | ((req: { url: string }) => MockResponse)) {
  return startMockLibrarian((req) => (typeof configure === "function" ? configure(req) : configure));
}

describe("POST /api/config/librarian/test", () => {
  it("joignable : message avec le nombre de documents (et la date)", async () => {
    const mock = await harnessWithMock({
      status: 200,
      body: { totalDocs: 42, lastUpdated: "2026-01-02" },
    });
    servers.push(mock);
    const runtime = runtimeWith();
    runtime.update({
      "librarian.baseUrl": mock.baseUrl,
      "librarian.agentToken": "jeton-x",
      "librarian.apiKey": "lib-x",
    });
    const { status, body } = await callTest(runtime, {});
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.message).toContain("joignable");
    expect(body.message).toContain("42 document(s)");
    expect(body.message).toContain("2026-01-02");
  });

  it("401 → clé libraire en cause (couche « key »)", async () => {
    const mock = await harnessWithMock({ status: 401, body: {} });
    servers.push(mock);
    const runtime = runtimeWith();
    runtime.update({
      "librarian.baseUrl": mock.baseUrl,
      "librarian.agentToken": "jeton-x",
      "librarian.apiKey": "lib-x",
    });
    const { body } = await callTest(runtime, {});
    expect(body.ok).toBe(false);
    expect(body.layer).toBe("key");
    expect(body.status).toBe(401);
    expect(body.message).toContain("X-API-Key");
  });

  it("403 → jeton agent en cause (couche « token »)", async () => {
    const mock = await harnessWithMock({ status: 403, body: {} });
    servers.push(mock);
    const runtime = runtimeWith();
    runtime.update({
      "librarian.baseUrl": mock.baseUrl,
      "librarian.agentToken": "jeton-x",
      "librarian.apiKey": "lib-x",
    });
    const { body } = await callTest(runtime, {});
    expect(body.ok).toBe(false);
    expect(body.layer).toBe("token");
    expect(body.message).toContain("Authorization");
  });

  it("502 → moteurs web indisponibles (bibliothèque locale intacte)", async () => {
    const mock = await harnessWithMock({ status: 502, body: {} });
    servers.push(mock);
    const runtime = runtimeWith();
    runtime.update({
      "librarian.baseUrl": mock.baseUrl,
      "librarian.agentToken": "j",
      "librarian.apiKey": "lib-x",
    });
    const { body } = await callTest(runtime, {});
    expect(body.ok).toBe(false);
    expect(body.message).toContain("moteurs de recherche web");
    expect(body.message).toContain("bibliothèque locale");
  });

  it("429 → trop de requêtes", async () => {
    const mock = await harnessWithMock({ status: 429, body: {} });
    servers.push(mock);
    const runtime = runtimeWith();
    runtime.update({
      "librarian.baseUrl": mock.baseUrl,
      "librarian.agentToken": "j",
      "librarian.apiKey": "lib-x",
    });
    const { body } = await callTest(runtime, {});
    expect(body.ok).toBe(false);
    expect(body.message).toContain("trop de requêtes");
  });

  it("injoignable → « Pi-Web injoignable depuis Yuki » (réseau/délai)", async () => {
    const mock = await startMockLibrarian(() => ({ status: 200, body: {} }));
    const baseUrl = mock.baseUrl;
    await mock.close();
    const runtime = runtimeWith();
    runtime.update({
      "librarian.baseUrl": baseUrl,
      "librarian.agentToken": "j",
      "librarian.apiKey": "lib-x",
    });
    const { body } = await callTest(runtime, {});
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unreachable");
    expect(body.message).toContain("INJOIGNABLE depuis Yuki");
  });

  it("non configuré → message explicite (pas une cause inventée)", async () => {
    const runtime = runtimeWith();
    const { body } = await callTest(runtime, {});
    expect(body.ok).toBe(false);
    expect(body.code).toBe("not_configured");
  });

  it("teste une URL NON ENREGISTRÉE fournie dans le corps (avant enregistrement)", async () => {
    const mock = await harnessWithMock({ status: 200, body: { totalDocs: 1 } });
    servers.push(mock);
    const runtime = runtimeWith();
    const { body } = await callTest(runtime, {
      baseUrl: mock.baseUrl,
      agentToken: "jeton-non-enregistre",
      apiKey: "lib-non-enregistree",
    });
    // Sans URL enregistrée, le corps suffit : on peut tester avant d'enregistrer.
    expect(body.ok).toBe(true);
    // ⚠️ La config n'a PAS été écrite.
    expect(runtime.getString("librarian.baseUrl")).toBe("");
  });

  it("exige l'en-tête d'écriture (garde-fou)", async () => {
    const runtime = runtimeWith();
    const response = await handleConfigRequest({
      method: "POST",
      path: "/api/config/librarian/test",
      headers: {},
      body: "{}",
      deps: { runtime, logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }) },
    });
    expect(response.status).toBe(403);
  });
});

describe("config du libraire — secrets masqués", () => {
  it("snapshot : jamais la valeur en clair, mais un masque ; secretValues les collecte", () => {
    const runtime = runtimeWith();
    runtime.update({
      "librarian.agentToken": "jeton-SECRET-abcdefgh",
      "librarian.apiKey": "lib-SECRET-987654321",
    });
    const snapshot = runtime.snapshot();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("jeton-SECRET-abcdefgh");
    expect(serialized).not.toContain("lib-SECRET-987654321");
    expect(snapshot.fields["librarian.agentToken"]).toMatchObject({
      configured: true,
      masked: "••••efgh",
    });
    expect(snapshot.fields["librarian.apiKey"]).toMatchObject({ configured: true });
    expect(runtime.secretValues()).toContain("jeton-SECRET-abcdefgh");
    expect(runtime.secretValues()).toContain("lib-SECRET-987654321");
  });

  it("le logger masque les deux secrets (aucune fuite dans les journaux)", () => {
    const runtime = runtimeWith();
    runtime.update({
      "librarian.agentToken": "jeton-SECRET-abcdefgh",
      "librarian.apiKey": "lib-SECRET-987654321",
    });
    const lines: string[] = [];
    const logger = createLogger({
      level: "debug",
      sink: (line) => lines.push(line),
      secretValues: runtime.secretValues(),
    });
    logger.warn("librarian.test", {
      token: "jeton-SECRET-abcdefgh",
      api_key: "lib-SECRET-987654321",
      authorization: "Bearer jeton-SECRET-abcdefgh",
    });
    const joined = lines.join("\n");
    expect(joined).not.toContain("jeton-SECRET-abcdefgh");
    expect(joined).not.toContain("lib-SECRET-987654321");
    expect(joined).toContain("[REDACTED]");
  });
});
