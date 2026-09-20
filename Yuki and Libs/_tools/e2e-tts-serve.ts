/**
 * Harnais E2E JETABLE (hors dépôts) — gateway RÉEL de Yuki avec :
 *   - un registre de voix (`VoiceStore`) contenant un preset de test ;
 *   - un store de config avec `tts.enabled = on` et `tts.volume = 80` ;
 *   - les routes réelles `/api/config` et `/api/voices`.
 *
 * Usage :  cd Yuki && npx tsx "../Yuki and Libs/_tools/e2e-tts-serve.ts"
 * Sortie : « READY http://127.0.0.1:<port> » puis reste vivant.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadEnv } from "../../src/config/env.js";
import { inspectMountPoints, mountPoints } from "../../src/config/paths.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { createServer, startServer } from "../../src/gateway/server.js";
import type { VoiceApiDeps } from "../../src/gateway/routes/voices.js";
import { detectGpus } from "../../src/gpu/detect.js";
import { runGate } from "../../src/gpu/gate.js";
import { loadCompatManifest, loadProfiles } from "../../src/gpu/profiles.js";
import { createLogger } from "../../src/observability/logger.js";
import { VoiceStore } from "../../src/tts/voices-store.js";

/** WAV PCM16 mono (silence) minimal et valide. */
function makeWav(sampleRate = 16000, seconds = 0.2): Buffer {
  const frames = Math.round(sampleRate * seconds);
  const dataSize = frames * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

const root = mkdtempSync(join(tmpdir(), "yuki-e2e-tts-"));
const voicesDir = join(root, "voices");
const stateDir = join(root, "state");
mkdirSync(join(voicesDir, "presets"), { recursive: true });
mkdirSync(stateDir, { recursive: true });

writeFileSync(join(voicesDir, "presets", "camille.wav"), makeWav());
writeFileSync(
  join(voicesDir, "voices.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      voices: [
        {
          id: "camille",
          label: "Camille (FR)",
          kind: "preset",
          lang: "fr",
          refAudio: "presets/camille.wav",
          refText: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          createdBy: "factory",
        },
      ],
    },
    null,
    2,
  )}\n`,
);

const configStorePath = join(stateDir, "config.json");
writeFileSync(
  configStorePath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      values: { "tts.enabled": "on", "tts.volume": 80 },
    },
    null,
    2,
  )}\n`,
);

const env = loadEnv({
  ...process.env,
  YUKI_GPU_FIXTURE: "tests/fixtures/gpu/rtx4070-12g.txt",
  YUKI_LOG_LEVEL: "error",
  YUKI_CONFIG_STORE_PATH: configStorePath,
  YUKI_VOICES_DIR: voicesDir,
  YUKI_MOUNT_VOICES: voicesDir,
  YUKI_MOUNT_STATE: stateDir,
});

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });
const config = createConfigRuntime({
  env,
  promptDefaults: { light: "systeme leger", heavy: "systeme lourd" },
});
const voiceStore = new VoiceStore({ dir: voicesDir });

const voices: VoiceApiDeps = {
  store: voiceStore,
  logger,
  config: {
    getString: (path) => config.getString(path),
    update: (patch) => config.update(patch),
  },
  tts: {
    synthesizePreview: async () => ({
      contentType: "audio/wav",
      bytes: makeWav(16000, 0.3),
    }),
  },
};

const profiles = loadProfiles();
const manifest = loadCompatManifest();
const detection = detectGpus({
  command: env.gpuCmd,
  fixture: env.gpuFixture,
  commandFromEnv: env.gpuCmdFromEnv,
  cwd: process.cwd(),
});
const gate = runGate(
  {
    config: { compatMode: "strict" as const, profile: null, minDriver: 580 },
    profiles,
    manifest,
    detection,
  },
  logger,
);

const server = createServer({
  env,
  report: gate.report,
  gatePassed: gate.passed,
  startedAt: Date.now(),
  volumes: inspectMountPoints(mountPoints(env)),
  config: { runtime: config, logger },
  voices,
});

const address = await startServer(server, "127.0.0.1", 4174);
console.log(
  `READY http://127.0.0.1:${(address as import("node:net").AddressInfo).port}`,
);
setInterval(() => {}, 1 << 30);
