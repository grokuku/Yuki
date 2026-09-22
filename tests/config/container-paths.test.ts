/**
 * Garde-fou « chemins internes » (Lot 9, D61).
 *
 * Les chemins INTERNES au conteneur ont une SOURCE UNIQUE : `CONTAINER_PATHS`
 * (`src/config/container-paths.ts`). Ce fichier vérifie les DEUX sens :
 *
 *  1. **Sans** variable d'environnement, les DÉFAUTS du code valent EXACTEMENT
 *     les cibles de montage des composes (`loadEnv({})` ↔ `target:` des YAML) —
 *     impossible de désynchroniser code et compose par accident ;
 *  2. **Avec** variable définie, la SURCHARGE fonctionne toujours
 *     (rétro-compatibilité des déploiements existants) ;
 *  3. **Aucun** compose ne définit de variable d'environnement de chemin interne
 *     (elles ne sont pas un réglage du compose).
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CONTAINER_PATHS,
  MODELS_DOWNLOADS_SUBDIR,
} from "../../src/config/container-paths.js";
import { loadEnv } from "../../src/config/env.js";
import { EngineConfigStore } from "../../src/tts/engine-config.js";

const COMPOSE_ROOT = new URL("../../", import.meta.url);

function readCompose(relativePath: string): string {
  return readFileSync(new URL(relativePath, COMPOSE_ROOT), "utf8");
}

/** Tous les composes du dépôt (base, surcharges, variantes, CI). */
const ALL_COMPOSES = [
  "docker-compose.yml",
  "compose.bind.example.yml",
  "compose.build.example.yml",
  "compose.override.example.yml",
  "deploy/minimal/docker-compose.yml",
  "deploy/server/docker-compose.yml",
  ".github/ci/compose.ci.yml",
];

/**
 * Variables d'environnement qui ne servent QU'À définir un chemin INTERNE au
 * conteneur. Surchargeables (rétro-compatibilité), mais jamais un réglage du
 * compose. `YUKI_GPU_FIXTURE` est volontairement ABSENT : c'est un crochet de
 * simulation CI (fixture), pas un descripteur de montage du produit.
 */
const INTERNAL_PATH_ENV_VARS = [
  "YUKI_MOUNT_PI_AGENT",
  "YUKI_MOUNT_WORKSPACE",
  "YUKI_MOUNT_MODELS",
  "YUKI_MOUNT_STATE",
  "YUKI_MOUNT_VOICES",
  "YUKI_TTS_CONFIG_DIR",
  "YUKI_TTS_ENGINE_CONFIG_DIR",
  "YUKI_TTS_ENGINE_MODELS_DIR",
  "YUKI_PI_AGENT_DIR",
  "YUKI_PI_SESSIONS_DIR",
  "YUKI_PI_HOME",
  "YUKI_PI_CWD",
  "YUKI_PI_SYSTEM_PROMPT",
  "YUKI_PI_SETTINGS_SEED",
  "YUKI_PI_HEAVY_SYSTEM_PROMPT",
  "YUKI_CONFIG_DIR",
  "YUKI_VOICES_DIR",
  "YUKI_CONFIG_STORE_PATH",
  "YUKI_JOBS_STORE_PATH",
  "HOME",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
];

/** Retire les commentaires (`#…`) pour ne pas confondre doc et réglage. */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const hash = line.indexOf("#");
      return hash >= 0 ? line.slice(0, hash) : line;
    })
    .join("\n");
}

/**
 * Cibles de montage d'un compose : syntaxe longue (`target: /x`) ET syntaxe
 * courte des volumes (`- volume:/x[:ro|rw]`).
 */
function mountTargets(text: string): Set<string> {
  const targets = new Set<string>();
  for (const line of withoutComments(text).split("\n")) {
    const long = /^\s*target:\s*"?([^"\s]+)"?\s*$/.exec(line);
    if (long) {
      targets.add(long[1]);
      continue;
    }
    const short = /^\s*-\s+[A-Za-z0-9_.-]+:(\.?\/[^\s:]+)/.exec(line);
    if (short) targets.add(short[1]);
  }
  return targets;
}

describe("chemins internes — DÉFAUTS du code (sans variable)", () => {
  const env = loadEnv({});

  it("les points de montage valent CONTAINER_PATHS", () => {
    expect(env.mountPoints.pi).toBe(CONTAINER_PATHS.pi);
    expect(env.mountPoints.workspace).toBe(CONTAINER_PATHS.workspace);
    expect(env.mountPoints.models).toBe(CONTAINER_PATHS.models);
    expect(env.mountPoints.state).toBe(CONTAINER_PATHS.state);
    expect(env.mountPoints.voices).toBe(CONTAINER_PATHS.voices);
  });

  it("les chemins du moteur TTS valent CONTAINER_PATHS", () => {
    expect(env.ttsEngineConfigDir).toBe(CONTAINER_PATHS.ttsConfigDir);
    expect(env.ttsEngineConfigMountDir).toBe(CONTAINER_PATHS.ttsEngineConfigDir);
    expect(env.ttsEngineModelsDir).toBe(CONTAINER_PATHS.models);
  });

  it("les chemins Pi dérivent des montages canoniques", () => {
    expect(env.piAgentDir).toBe(`${CONTAINER_PATHS.pi}/agent`);
    expect(env.piSessionsDir).toBe(`${CONTAINER_PATHS.pi}/agent/sessions`);
    expect(env.piHome).toBe(`${CONTAINER_PATHS.pi}/home`);
    expect(env.piCwd).toBe(CONTAINER_PATHS.workspace);
  });

  it("le chemin d'écriture des téléchargements est DÉRIVÉ de /models", () => {
    const store = new EngineConfigStore({
      configDir: CONTAINER_PATHS.ttsConfigDir,
      engineConfigDir: CONTAINER_PATHS.ttsEngineConfigDir,
      modelsDir: CONTAINER_PATHS.models,
      engineModelsDir: CONTAINER_PATHS.models,
    });
    expect(store.modelsWriteDir).toBe(
      `${CONTAINER_PATHS.models}/${MODELS_DOWNLOADS_SUBDIR}`,
    );
    expect(store.modelsWriteDir).toBe("/models/downloads");
  });
});

describe("chemins internes — SURCHARGE par variable (rétro-compatibilité)", () => {
  const env = loadEnv({
    YUKI_MOUNT_PI_AGENT: "/custom/pi",
    YUKI_MOUNT_WORKSPACE: "/custom/workspace",
    YUKI_MOUNT_MODELS: "/custom/models",
    YUKI_MOUNT_STATE: "/custom/state",
    YUKI_MOUNT_VOICES: "/custom/voices",
    YUKI_TTS_CONFIG_DIR: "/custom/tts-config",
    YUKI_TTS_ENGINE_CONFIG_DIR: "/custom/config",
    YUKI_TTS_ENGINE_MODELS_DIR: "/custom/engine-models",
    YUKI_PI_AGENT_DIR: "/custom/pi/agent",
    YUKI_PI_SESSIONS_DIR: "/custom/pi/sessions",
    YUKI_PI_HOME: "/custom/pi/home",
    YUKI_PI_CWD: "/custom/cwd",
  });

  it("chaque chemin interne est surchargeable (les deux sens)", () => {
    expect(env.mountPoints.pi).toBe("/custom/pi");
    expect(env.mountPoints.workspace).toBe("/custom/workspace");
    expect(env.mountPoints.models).toBe("/custom/models");
    expect(env.mountPoints.state).toBe("/custom/state");
    expect(env.mountPoints.voices).toBe("/custom/voices");
    expect(env.ttsEngineConfigDir).toBe("/custom/tts-config");
    expect(env.ttsEngineConfigMountDir).toBe("/custom/config");
    expect(env.ttsEngineModelsDir).toBe("/custom/engine-models");
    expect(env.piAgentDir).toBe("/custom/pi/agent");
    expect(env.piSessionsDir).toBe("/custom/pi/sessions");
    expect(env.piHome).toBe("/custom/pi/home");
    expect(env.piCwd).toBe("/custom/cwd");
  });
});

describe("chemins internes — cohérence code ↔ compose", () => {
  it("chaque compose complet monte EXACTEMENT les chemins canoniques", () => {
    const expected = Object.values(CONTAINER_PATHS);
    for (const file of [
      "docker-compose.yml",
      "compose.bind.example.yml",
      "deploy/server/docker-compose.yml",
    ]) {
      const targets = mountTargets(readCompose(file));
      for (const path of expected) {
        expect(targets.has(path), `${file} doit monter ${path}`).toBe(true);
      }
    }
  });

  it("deploy/minimal monte les 5 volumes nommés canoniques", () => {
    const targets = mountTargets(readCompose("deploy/minimal/docker-compose.yml"));
    for (const path of [
      CONTAINER_PATHS.pi,
      CONTAINER_PATHS.workspace,
      CONTAINER_PATHS.models,
      CONTAINER_PATHS.state,
      CONTAINER_PATHS.voices,
    ]) {
      expect(targets.has(path), `deploy/minimal doit monter ${path}`).toBe(true);
    }
  });

  it("AUCUN compose ne définit de variable de chemin interne", () => {
    for (const file of ALL_COMPOSES) {
      const cleaned = withoutComments(readCompose(file));
      for (const name of INTERNAL_PATH_ENV_VARS) {
        const assignment = new RegExp(`^\\s*${name}\\s*:`, "m");
        expect(
          assignment.test(cleaned),
          `${file} ne doit PAS définir la variable ${name}`,
        ).toBe(false);
      }
    }
  });
});
