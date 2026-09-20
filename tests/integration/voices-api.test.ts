/**
 * API des voix (Lot 7 §10.4) — via un VRAI serveur HTTP (patron de
 * `static-ui.test.ts`). Le service `tts` est simulé : seul le contrat HTTP Yuki
 * est vérifié ici.
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { inspectMountPoints, mountPoints } from "../../src/config/paths.js";
import { createConfigRuntime, type ConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import type { VoiceApiDeps } from "../../src/gateway/routes/voices.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
import { createLogger } from "../../src/observability/logger.js";
import { VoiceStore } from "../../src/tts/voices-store.js";
import { makeWav } from "../tts/wav-fixture.js";

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
  runtime: ConfigRuntime;
  store: VoiceStore;
  voicesDir: string;
  lines: string[];
}

async function startHarness(
  options: {
    withTts?: boolean;
    ttsEnabled?: boolean;
    seedPreset?: boolean;
    maxVoices?: number;
  } = {},
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "yuki-voices-api-"));
  tempDirs.push(root);
  const voicesDir = join(root, "voices");
  mkdirSync(voicesDir, { recursive: true });
  if (options.seedPreset) {
    mkdirSync(join(voicesDir, "presets"), { recursive: true });
    writeFileSync(join(voicesDir, "presets", "camille.wav"), makeWav());
    writeFileSync(
      join(voicesDir, "voices.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        voices: [
          {
            id: "camille",
            label: "Camille",
            kind: "preset",
            lang: "fr",
            refAudio: "presets/camille.wav",
            refText: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            createdBy: "factory",
          },
        ],
      })}\n`,
    );
  }

  const env = loadEnv({
    YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
    YUKI_LOG_LEVEL: "error",
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: join(root, "state", "config.json"),
    YUKI_MOUNT_VOICES: voicesDir,
    YUKI_VOICES_DIR: voicesDir,
  });
  const lines: string[] = [];
  const logger = createLogger({
    level: "info",
    sink: (line) => lines.push(line),
    secretValues: [],
  });
  const runtime = createConfigRuntime({
    env,
    store: new ConfigStore(env.configStorePath),
    processEnv: {},
    promptDefaults: { light: "P", heavy: "H" },
  });
  if (options.ttsEnabled) runtime.update({ "tts.enabled": "on" });

  const store = new VoiceStore({ dir: voicesDir, ...(options.maxVoices ? { maxVoices: options.maxVoices } : {}) });
  const deps: VoiceApiDeps = {
    store,
    logger,
    config: {
      getString: (path) => runtime.getString(path),
      update: (patch) => runtime.update(patch),
    },
    ...(options.withTts !== false
      ? { tts: { synthesizePreview: async () => ({ contentType: "audio/wav", bytes: makeWav() }) } }
      : {}),
  };

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
    voices: deps,
  });
  servers.push(server);
  const address = await startServer(server, "127.0.0.1", 0);
  return {
    baseUrl: `http://127.0.0.1:${(address as AddressInfo).port}`,
    runtime,
    store,
    voicesDir,
    lines,
  };
}

const WRITE = { "x-yuki-config": "1" };

describe("GET /api/voices", () => {
  it("liste vide puis renvoie la voix clonée (jamais de chemin)", async () => {
    const { baseUrl } = await startHarness();
    const empty = await fetch(`${baseUrl}/api/voices`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ voices: [] });

    const created = await fetch(`${baseUrl}/api/voices/clone`, {
      method: "POST",
      headers: { ...WRITE, "x-voice-label": "Camille", "content-type": "audio/wav" },
      body: makeWav(),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      voice: { id: string; kind: string; demoAvailable: boolean };
    };
    expect(body.voice.id).toBe("camille");
    expect(body.voice.kind).toBe("cloned");
    expect(body.voice.demoAvailable).toBe(true);
    expect(JSON.stringify(body)).not.toContain(".wav");

    const list = await fetch(`${baseUrl}/api/voices`);
    const listed = (await list.json()) as { voices: Array<{ id: string }> };
    expect(listed.voices.map((v) => v.id)).toEqual(["camille"]);
  });
});

describe("POST /api/voices/clone", () => {
  it("exige les garde-fous d'écriture", async () => {
    const { baseUrl } = await startHarness();
    const noHeader = await fetch(`${baseUrl}/api/voices/clone`, {
      method: "POST",
      headers: { "x-voice-label": "X", "content-type": "audio/wav" },
      body: makeWav(),
    });
    expect(noHeader.status).toBe(403);

    const badOrigin = await fetch(`${baseUrl}/api/voices/clone`, {
      method: "POST",
      headers: { ...WRITE, origin: "http://evil.example", "x-voice-label": "X" },
      body: makeWav(),
    });
    expect(badOrigin.status).toBe(403);
  });

  it("refuse sans libellé (400)", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/voices/clone`, {
      method: "POST",
      headers: { ...WRITE, "content-type": "audio/wav" },
      body: makeWav(),
    });
    expect(response.status).toBe(400);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "invalid_label",
    });
  });

  it("refuse un corps non WAV (422)", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/voices/clone`, {
      method: "POST",
      headers: { ...WRITE, "x-voice-label": "X", "content-type": "audio/wav" },
      body: Buffer.from("pas un wav"),
    });
    expect(response.status).toBe(422);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "not_wav" });
  });

  it("refuse un WAV de plus de 10 s (422)", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/voices/clone`, {
      method: "POST",
      headers: { ...WRITE, "x-voice-label": "X", "content-type": "audio/wav" },
      body: makeWav({ seconds: 11 }),
    });
    expect(response.status).toBe(422);
    expect((await response.json()) as { code: string }).toMatchObject({ code: "too_long" });
  });

  it("refuse un corps au-delà de MAX_VOICE_BODY_BYTES (413)", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/voices/clone`, {
      method: "POST",
      headers: { ...WRITE, "x-voice-label": "X", "content-type": "audio/wav" },
      body: Buffer.alloc(3_000_001),
    });
    expect(response.status).toBe(413);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "body_too_large",
    });
  });

  it("applique le quota de voix clonées (429)", async () => {
    const { baseUrl } = await startHarness({ maxVoices: 1 });
    const first = await fetch(`${baseUrl}/api/voices/clone`, {
      method: "POST",
      headers: { ...WRITE, "x-voice-label": "Une", "content-type": "audio/wav" },
      body: makeWav(),
    });
    expect(first.status).toBe(201);
    const second = await fetch(`${baseUrl}/api/voices/clone`, {
      method: "POST",
      headers: { ...WRITE, "x-voice-label": "Deux", "content-type": "audio/wav" },
      body: makeWav(),
    });
    expect(second.status).toBe(429);
  });
});

describe("GET /api/voices/{id}/sample", () => {
  it("sert le WAV de référence (audio/wav)", async () => {
    const { baseUrl } = await startHarness({ seedPreset: true });
    const response = await fetch(`${baseUrl}/api/voices/camille/sample`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/wav");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.subarray(8, 12).toString("ascii")).toBe("WAVE");
  });

  it("404 sur une voix sans échantillon", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/voices/inconnue/sample`);
    expect(response.status).toBe(404);
  });
});

describe("PATCH / DELETE /api/voices/{id}", () => {
  it("renomme une voix clonée", async () => {
    const { baseUrl } = await startHarness();
    await fetch(`${baseUrl}/api/voices/clone`, {
      method: "POST",
      headers: { ...WRITE, "x-voice-label": "Avant", "content-type": "audio/wav" },
      body: makeWav(),
    });
    const response = await fetch(`${baseUrl}/api/voices/avant`, {
      method: "PATCH",
      headers: { ...WRITE, "content-type": "application/json" },
      body: JSON.stringify({ label: "Après" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()) as { voice: { label: string } }).toMatchObject({
      voice: { label: "Après" },
    });
  });

  it("supprime une voix clonée et réinitialise `tts.voice` si sélectionnée", async () => {
    const { baseUrl, runtime } = await startHarness();
    await fetch(`${baseUrl}/api/voices/clone`, {
      method: "POST",
      headers: { ...WRITE, "x-voice-label": "Choisie", "content-type": "audio/wav" },
      body: makeWav(),
    });
    runtime.update({ "tts.voice": "choisie" });
    const response = await fetch(`${baseUrl}/api/voices/choisie`, {
      method: "DELETE",
      headers: WRITE,
    });
    expect(response.status).toBe(200);
    // Repli automatique sur la voix par défaut (§10.8).
    expect(runtime.getString("tts.voice")).toBe("");
  });

  it("refuse de supprimer un preset (409)", async () => {
    const { baseUrl } = await startHarness({ seedPreset: true });
    const response = await fetch(`${baseUrl}/api/voices/camille`, {
      method: "DELETE",
      headers: WRITE,
    });
    expect(response.status).toBe(409);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "not_deletable",
    });
  });

  it("404 sur une voix inconnue", async () => {
    const { baseUrl } = await startHarness();
    const response = await fetch(`${baseUrl}/api/voices/inconnue`, {
      method: "DELETE",
      headers: WRITE,
    });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/voices/{id}/preview", () => {
  it("renvoie un WAV quand le TTS est activé", async () => {
    const { baseUrl } = await startHarness({ ttsEnabled: true, seedPreset: true });
    const response = await fetch(`${baseUrl}/api/voices/camille/preview`, {
      method: "POST",
      headers: WRITE,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("audio/wav");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
  });

  it("503 quand le TTS est désactivé (défaut)", async () => {
    const { baseUrl } = await startHarness({ seedPreset: true });
    const response = await fetch(`${baseUrl}/api/voices/camille/preview`, {
      method: "POST",
      headers: WRITE,
    });
    expect(response.status).toBe(503);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "tts_disabled",
    });
  });

  it("503 quand aucun fournisseur TTS n'est câblé", async () => {
    const { baseUrl } = await startHarness({ withTts: false, seedPreset: true });
    const response = await fetch(`${baseUrl}/api/voices/camille/preview`, {
      method: "POST",
      headers: WRITE,
    });
    expect(response.status).toBe(503);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "tts_unavailable",
    });
  });

  it("404 sur une voix inconnue", async () => {
    const { baseUrl } = await startHarness({ ttsEnabled: true });
    const response = await fetch(`${baseUrl}/api/voices/inconnue/preview`, {
      method: "POST",
      headers: WRITE,
    });
    expect(response.status).toBe(404);
  });
});

describe("isolation du volume des voix", () => {
  it("la suppression retire le fichier et l'entrée du registre", async () => {
    const { baseUrl, voicesDir } = await startHarness();
    await fetch(`${baseUrl}/api/voices/clone`, {
      method: "POST",
      headers: { ...WRITE, "x-voice-label": "Jetée", "content-type": "audio/wav" },
      body: makeWav(),
    });
    expect(existsSync(join(voicesDir, "cloned", "jetee.wav"))).toBe(true);
    await fetch(`${baseUrl}/api/voices/jetee`, { method: "DELETE", headers: WRITE });
    expect(existsSync(join(voicesDir, "cloned", "jetee.wav"))).toBe(false);
  });
});
