/**
 * API de configuration — mode dégradé, secrets jamais en clair, PUT (garde-fous,
 * validation, verrou d'env), test LLM hors SDK.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { inspectMountPoints, mountPoints } from "../../src/config/paths.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import { emptySubsystems, type SubsystemsSnapshot } from "../../src/gateway/routes/health.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
import { createLogger } from "../../src/observability/logger.js";
import { VOICE_SPEECH_INSTRUCTION } from "../../src/llm/prompts.js";
import { resolveAvailability } from "../../src/llm/availability.js";
import { cheminCleFournisseur, migrerCatalogue } from "../../src/llm/catalogue.js";
import { llmRouting } from "../../src/llm/routing.js";
import { MUTE_BLOCK_LABEL } from "../../src/tts/mute.js";

// Le patch est produit par la VRAIE fonction de l'UI (`buildConfigPatch`),
// pas reconstruit à la main : on reproduit exactement ce qu'envoie le bouton
// « Enregistrer » de `/config`.
import { buildConfigPatch } from "../../public/ui/config-patch.js";

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
  /** Environnement effectif du runtime (pont des clés, disponibilité des rôles). */
  processEnv: NodeJS.ProcessEnv;
  env: ReturnType<typeof loadEnv>;
  report: ReturnType<typeof runGate>["report"];
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
  const processEnv: NodeJS.ProcessEnv = { ...envOverrides };
  const runtime = createConfigRuntime({
    env,
    store: new ConfigStore(env.configStorePath),
    processEnv,
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
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    runtime,
    lines,
    processEnv,
    env,
    report: gate.report,
  };
}

const WRITE_HEADERS = { "x-yuki-config": "1", "content-type": "application/json" };

/** Requête `PUT` brute (permet de forger `Host`/`Origin`, interdits par `fetch`). */
function rawPut(
  baseUrl: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname, port: url.port, method: "PUT", path: "/api/config", headers },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Garde-fous d'écriture directement (en-têtes forgés, casse d'en-tête comprise). */
async function putWithHeaders(
  runtime: ReturnType<typeof createConfigRuntime>,
  headers: Record<string, string>,
): Promise<number> {
  const { handleConfigRequest } = await import("../../src/gateway/routes/config.js");
  const response = await handleConfigRequest({
    method: "PUT",
    path: "/api/config",
    headers,
    body: "{}",
    deps: { runtime, logger: createLogger({ level: "error", sink: () => {}, secretValues: [] }) },
  });
  return response.status;
}

describe("GET /api/config en mode dégradé", () => {
  it("répond 200 SANS aucune clé et n'expose jamais de valeur", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/config`);
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw) as {
      fields: Record<string, { value?: unknown; configured?: boolean }>;
      status: { lightKey: boolean; heavyKey: boolean; ready: boolean };
      voiceInstruction: string;
    };
    expect(body.status.lightKey).toBe(false);
    expect(body.status.heavyKey).toBe(false);
    expect(body.status.ready).toBe(false);
    // L'instruction vocale est exposée en lecture seule (texte réellement
    // injecté quand la voix est active), et référence la convention unique.
    expect(body.voiceInstruction).toBe(VOICE_SPEECH_INSTRUCTION);
    expect(body.voiceInstruction).toContain(MUTE_BLOCK_LABEL);
    // ⚠️ GARDE RÉVISÉE (2026-11-19, LOT B) : les réglages par rôle sont RETIRÉS
    // au profit du catalogue. Ce qui est vérifié est inchangé sur le fond — un
    // champ de sélection est servi avec sa valeur, son origine, sa portée et son
    // application, et aucune clé n'est « configurée » par défaut.
    expect(body.fields["llm.defaut.light"]).toMatchObject({
      value: "",
      origin: "default",
      apply: "hot",
      scope: "instance",
    });
    expect(body.fields["llm.fournisseurs"]).toMatchObject({ value: "", origin: "default" });
    expect(body.fields["llm.light.apiKey"]).toBeUndefined();
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
    // ⚠️ GARDE RÉVISÉE (lot B) : les clés sont celles des FOURNISSEURS du
    // catalogue (`llm.fournisseur.<id>.apiKey`) et « clé présente » se déduit du
    // modèle RÉSOLU de chaque rôle — il faut donc un catalogue et deux défauts.
    const catalogue = {
      "llm.fournisseurs": JSON.stringify([
        { id: "local", nom: "Local", baseUrl: "https://local.example/v1", api: "openai-completions" },
      ]),
      "llm.modeles": JSON.stringify([
        { id: "chat", nom: "chat", fournisseurId: "local", contexte: 4096, vision: true, thinking: "off" },
      ]),
      "llm.defaut.light": "chat",
      "llm.defaut.heavy": "chat",
      "llm.fournisseur.local.apiKey": secret,
    };
    const response = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify(catalogue),
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
    expect(body.applied.hot).toContain("llm.fournisseur.local.apiKey");
    expect(body.fields["llm.fournisseur.local.apiKey"]?.masked).toBe("••••0000");

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
      body: JSON.stringify({ "llm.defaut.light": "inconnu" }),
    });
    expect(empty.status).toBe(400);
    const emptyBody = (await empty.json()) as {
      fields: Array<{ path: string; code: string; message: string }>;
    };
    // ⚠️ Refus NOMMÉ d'une sélection : un `modeleId` absent du catalogue n'est
    // jamais enregistré (et l'ancienne clé de rôle n'existe plus).
    expect(emptyBody.fields[0]?.path).toBe("llm.defaut.light");
    expect(emptyBody.fields[0]?.code).toBe("modele_inconnu");

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

  it("efface une clé de fournisseur avec null", async () => {
    const { baseUrl } = await startHarness();
    // ⚠️ GARDE RÉVISÉE (lot B) : la clé effaçable est celle d'un FOURNISSEUR du
    // catalogue. `status.lightKey` retombe à `false` parce que le rôle résolu
    // n'a plus de clé — la même preuve qu'avant, sur le nouveau chemin.
    await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify({
        "llm.fournisseurs": JSON.stringify([
          { id: "local", nom: "Local", baseUrl: "https://local.example/v1", api: "openai-completions" },
        ]),
        "llm.modeles": JSON.stringify([
          { id: "chat", nom: "chat", fournisseurId: "local", contexte: 4096, vision: true, thinking: "off" },
        ]),
        "llm.defaut.light": "chat",
        "llm.fournisseur.local.apiKey": "key-abcdefgh",
      }),
    });
    const cleared = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ "llm.fournisseur.local.apiKey": null }),
    });
    const body = (await cleared.json()) as {
      status: { lightKey: boolean };
      fields: Record<string, { configured: boolean }>;
    };
    expect(body.status.lightKey).toBe(false);
    expect(body.fields["llm.fournisseur.local.apiKey"]?.configured).toBe(false);
  });

  it("store NON inscriptible → 500 EXPLOITABLE (cause journalisée, jamais un 500 muet)", async () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-api-ro-"));
    tempDirs.push(root);
    // Un FICHIER là où le store attend un répertoire : l'écriture échoue pour
    // TOUT utilisateur (y compris root), donc reproductible en CI.
    const blocker = join(root, "state");
    writeFileSync(blocker, "not-a-directory");
    const storePath = join(blocker, "config.json");
    const { baseUrl, lines } = await startHarness({
      YUKI_MOUNT_STATE: blocker,
      YUKI_CONFIG_STORE_PATH: storePath,
    });

    const response = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ "gpu.profile": "compact" }),
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as {
      error: string;
      code: string;
      path: string;
      message: string;
    };
    expect(body.error).toBe("config_store_unwritable");
    expect(body.code).toBe("config_store_unwritable");
    expect(body.path).toBe(storePath);
    // Message utile (chemin + piste), PAS le 500 muet `internal_error`.
    expect(body.error).not.toBe("internal_error");
    expect(body.message).toContain("Impossible d'écrire la configuration");
    expect(body.message).toContain(storePath);
    // La cause système est journalisée (exploitable dans `docker logs`).
    expect(lines.join("\n")).toContain("config.store.write_failed");
  });
});

describe("PUT /api/config — contrôle Origin/Host (accès réseau local)", () => {
  it("accepte un accès par IP LAN (Host/Origin = 10.10.0.5:8083), bout en bout", async () => {
    const { baseUrl } = await startHarness();
    const response = await rawPut(
      baseUrl,
      {
        host: "10.10.0.5:8083",
        origin: "http://10.10.0.5:8083",
        "x-yuki-config": "1",
        "content-type": "application/json",
      },
      JSON.stringify({ "delegation.defaultDeadlineMs": 2000 }),
    );
    expect(response.status).toBe(200);
  });

  it("refuse toujours une origine étrangère", async () => {
    const { baseUrl } = await startHarness();
    const response = await rawPut(
      baseUrl,
      {
        host: "10.10.0.5:8083",
        origin: "http://evil.example:8083",
        "x-yuki-config": "1",
        "content-type": "application/json",
      },
      "{}",
    );
    expect(response.status).toBe(403);
    expect(response.body).toContain("bad_origin");
  });

  it("refuse un port différent sur le même hôte", async () => {
    const { runtime } = await startHarness();
    const status = await putWithHeaders(runtime, {
      host: "10.10.0.5:8083",
      origin: "http://10.10.0.5:9090",
      "x-yuki-config": "1",
    });
    expect(status).toBe(403);
  });

  it("accepte un nom d'hôte, casse insensible et en-tête personnalisé mixte", async () => {
    const { runtime } = await startHarness();
    const status = await putWithHeaders(runtime, {
      Host: "Yuki.Lan:8083",
      Origin: "http://yuki.lan:8083",
      "X-Yuki-Config": "1",
    });
    expect(status).toBe(200);
  });

  it("accepte un port par défaut omis d'un côté (reverse-proxy)", async () => {
    const { runtime } = await startHarness();
    const status = await putWithHeaders(runtime, {
      host: "yuki.lan",
      origin: "http://yuki.lan:80",
      "x-yuki-config": "1",
    });
    expect(status).toBe(200);
  });

  it("accepte une terminaison TLS en amont (Origin https, Host http)", async () => {
    const { runtime } = await startHarness();
    const status = await putWithHeaders(runtime, {
      host: "yuki.lan:8083",
      origin: "https://yuki.lan:8083",
      "x-yuki-config": "1",
    });
    expect(status).toBe(200);
  });

  it("sans Origin (ex. curl) reste autorisé avec l'en-tête personnalisé", async () => {
    const { runtime } = await startHarness();
    const status = await putWithHeaders(runtime, {
      host: "10.10.0.5:8083",
      "x-yuki-config": "1",
    });
    expect(status).toBe(200);
  });
});

describe("POST /api/config/llm/test", () => {
  it("teste via fetch hors SDK et renvoie les modèles", async () => {
    const { runtime } = await startHarness();
    // ⚠️ GARDE RÉVISÉE (lot B) : le test d'un RÔLE passe par le fournisseur du
    // modèle RÉSOLU (`llm.defaut.light` → son fournisseur → sa clé secrète).
    runtime.update({
      "llm.fournisseurs": JSON.stringify([
        { id: "local", nom: "Local", baseUrl: "https://local.example/v1", api: "openai-completions" },
      ]),
      "llm.modeles": JSON.stringify([
        { id: "chat", nom: "chat", fournisseurId: "local", contexte: 4096, vision: true, thinking: "off" },
      ]),
      "llm.defaut.light": "chat",
      "llm.fournisseur.local.apiKey": "key-test-000000",
    });
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

/**
 * ⚠️ `tts.speed` est un réglage PROPRE AU BOT (`scope: "bot"`) : depuis le
 * découpage Instance/Bot (lot 35b, sous-lot 1b-3), il s'écrit sur
 * `PUT /api/bots/yuki/config`. `PUT /api/config` le REFUSE désormais
 * (`bot_scoped_field`) — c'est le refus croisé, vérifié plus bas.
 */
describe("PUT /api/bots/yuki/config — patch produit par l'UI (`buildConfigPatch`)", () => {
  it("un débit modifié (n° correctement typé) → 200 et persisté", async () => {
    const { baseUrl } = await startHarness();
    const patch = buildConfigPatch({
      allFields: [{ path: "tts.speed", kind: "number" }],
      state: {
        fields: {},
        secretState: new Map(),
        pendingResets: new Set(),
        inputs: new Map([["tts.speed", { value: "150" }]]),
        initial: new Map([["tts.speed", 100]]),
      },
    });
    expect(patch).toEqual({ "tts.speed": 150 });
    const response = await fetch(`${baseUrl}/api/bots/yuki/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify(patch),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      fields: Record<string, { value: unknown; origin: string }>;
      applied: { hot: string[] };
    };
    expect(body.fields["tts.speed"]).toMatchObject({ value: 150, origin: "store" });
    expect(body.applied.hot).toContain("tts.speed");
  });

  it("un débit envoyé en CHAÎNE est aussi accepté (coercition serveur) → 200", async () => {
    // Établit que le soupçon « le patch en chaîne fait échouer l'enregistrement »
    // est FAUX : le schéma coerce les chaînes numériques (`validateDescriptor`).
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/bots/yuki/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ "tts.speed": "150" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      fields: Record<string, { value: unknown; origin: string }>;
    };
    expect(body.fields["tts.speed"]).toMatchObject({ value: 150, origin: "store" });
  });

  it("un débit hors bornes fait échouer tout le patch (400 invalid_config, champ cité)", async () => {
    const { baseUrl } = await startHarness();
    const patch = buildConfigPatch({
      allFields: [{ path: "tts.speed", kind: "number" }],
      state: {
        fields: {},
        secretState: new Map(),
        pendingResets: new Set(),
        inputs: new Map([["tts.speed", { value: "250" }]]),
        initial: new Map([["tts.speed", 100]]),
      },
    });
    const response = await fetch(`${baseUrl}/api/bots/yuki/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify(patch),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: string;
      fields: Array<{ path: string; code: string; message: string }>;
    };
    expect(body.error).toBe("invalid_config");
    expect(body.fields[0]?.path).toBe("tts.speed");
    expect(body.fields[0]?.code).toBe("above_max");
    expect(body.fields[0]?.message).toContain("maximum 200");
  });
});

/**
 * CE QUE `scripts/ci-smoke.sh` DOIT PROUVER — vérifié ici, en unitaire.
 *
 * ⚠️ Le script tourne dans un runner Docker : il ne peut pas être lancé depuis ce
 * dépôt. Ses assertions sont donc reproduites sur la VRAIE API.
 *
 * Séquence (modèle du lot B) :
 *  ① installation NEUVE : la reprise du démarrage pose le catalogue
 *    (`llm.fournisseurs` / `llm.modeles` / `llm.defaut.*`) et AUCUNE clé ;
 *  ② `status.lightKey` est `false`, la clé du FOURNISSEUR du rôle
 *    (`llm.fournisseur.<id>.apiKey`) est `configured: false` ;
 *  ③ la même clé fictive posée au chemin du fournisseur RÉSOLU (lu dans la
 *    réponse — aucun identifiant en dur, un renommage ne casse rien) ⇒ 200,
 *    `configured: true`, masquée ;
 *  ④ conséquence RÉELLE : le rôle léger a une clé, donc il est « ready » et
 *    `/health/ready` passe de 503 à 200. Si ④ échouait alors que ③ réussit, ce
 *    serait un DÉFAUT DE DISPONIBILITÉ, pas un problème de script.
 */
interface ConfigBody {
  fields: Record<
    string,
    { value?: unknown; configured?: boolean; masked?: string | null }
  >;
  status: { lightKey: boolean; heavyKey: boolean; ready: boolean };
}

/** Fournisseur RÉSOLU d'un rôle, exactement comme le fait le script (jq). */
function fournisseurDuRole(
  body: ConfigBody,
  role: "light" | "heavy",
): string {
  const fournisseurs = JSON.parse(
    String(body.fields["llm.fournisseurs"]?.value ?? "[]"),
  ) as Array<{ id: string }>;
  const modeles = JSON.parse(String(body.fields["llm.modeles"]?.value ?? "[]")) as Array<{
    id: string;
    fournisseurId: string;
  }>;
  const modeleId = String(body.fields[`llm.defaut.${role}`]?.value ?? "");
  const fournisseurId =
    modeles.find((modele) => modele.id === modeleId)?.fournisseurId ?? "";
  return (
    fournisseurs.find((fournisseur) => fournisseur.id === fournisseurId)?.id ??
    fournisseurs[0]?.id ??
    ""
  );
}

describe("ci-smoke — clé du fournisseur du catalogue (lot B)", () => {
  it("PUT au chemin secret du fournisseur ⇒ 200, clé masquée, rôle disponible, /health/ready 200", async () => {
    const { baseUrl, runtime, processEnv, env, report } = await startHarness();
    // ① reprise du démarrage, comme `src/index.ts` (le banc ne démarre pas le gateway).
    migrerCatalogue(runtime, () => {});

    // Serveur SUPPLÉMENTAIRE branché sur la disponibilité RÉELLE des rôles : c'est
    // elle que `/health/ready` consulte (voir `getSubsystems` dans `src/index.ts`).
    const subsystems = (): SubsystemsSnapshot => {
      const dispo = resolveAvailability(processEnv, llmRouting(runtime));
      const base = emptySubsystems();
      return {
        ...base,
        pi: { ...base.pi, status: "ready" },
        llm: {
          light: {
            provider: dispo.light.provider,
            model: dispo.light.model,
            status: dispo.light.status,
            keyPresent: dispo.light.keyPresent,
          },
          heavy: {
            provider: dispo.heavy.provider,
            model: dispo.heavy.model,
            status: dispo.heavy.status,
            keyPresent: dispo.heavy.keyPresent,
          },
        },
      };
    };
    const server = createServer({
      env,
      report,
      gatePassed: true,
      startedAt: Date.now(),
      volumes: inspectMountPoints(mountPoints(env)),
      getSubsystems: subsystems,
    });
    servers.push(server);
    const readyAddress = await startServer(server, "127.0.0.1", 0);
    const readyUrl = `http://127.0.0.1:${(readyAddress as AddressInfo).port}/health/ready`;

    // ①+② aucun fournisseur n'a de clé ⇒ pas prêt, et la réponse le DIT.
    expect((await fetch(readyUrl)).status).toBe(503);

    const avant = (await (await fetch(`${baseUrl}/api/config`)).json()) as ConfigBody;
    expect(avant.status.lightKey).toBe(false);
    expect(avant.status.heavyKey).toBe(false);
    const fournisseurId = fournisseurDuRole(avant, "light");
    // La reprise a posé un fournisseur : sans lui, il n'y aurait RIEN à configurer.
    expect(fournisseurId).not.toBe("");
    const chemin = cheminCleFournisseur(fournisseurId);
    expect(avant.fields[chemin]).toMatchObject({ configured: false, masked: null });

    // ③ la clé se pose au chemin SECRET du fournisseur du rôle.
    const secret = "fake-provider-key-222222222222";
    const reponse = await fetch(`${baseUrl}/api/config`, {
      method: "PUT",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ [chemin]: secret }),
    });
    const brut = await reponse.text();
    expect(reponse.status, brut).toBe(200);
    // Jamais de valeur en clair, ni dans la réponse, ni dans l'audit.
    expect(brut).not.toContain(secret);
    const apres = JSON.parse(brut) as ConfigBody;
    expect(apres.fields[chemin]).toMatchObject({ configured: true, masked: "••••2222" });
    expect(apres.status.lightKey).toBe(true);

    // ④ disponibilité du rôle, puis `/health/ready` (aucun appel réseau : seule la
    // présence de la clé compte).
    expect(resolveAvailability(processEnv, llmRouting(runtime)).light.status).toBe("ready");
    const pret = await fetch(readyUrl);
    expect(pret.status, JSON.stringify(await pret.clone().json())).toBe(200);
  });
});
