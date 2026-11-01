/**
 * COMPATIBILITÉ ARRIÈRE — un `config.json` ANTÉRIEUR au réglage `vision`.
 *
 * ⚠️ POURQUOI CE TEST EXISTE : `llm.light.vision` / `llm.heavy.vision` ont été
 * ajoutés APRÈS coup (`src/config/schema.ts:116,171`) et ils produisent `input`
 * dans `models.json` (`resolveModelsFrom`, `src/llm/models.ts:187`). Un store
 * existant ne contient PAS ces clés : si le défaut du schéma ne s'appliquait pas,
 * `vision` vaudrait `false`, `input` deviendrait `["text"]`, voire le modèle
 * lourd pourrait disparaître de `models.json` — et la session lourde échouerait
 * EN SILENCE (le worker n'aurait plus son modèle).
 *
 * Ce test construit un store « ancien » (sans les clés `vision`, avec un modèle
 * lourd personnalisé), le fait lire par le VRAI runtime de configuration, puis
 * vérifie le `models.json` RÉELLEMENT écrit et sa résolution par le VRAI runtime
 * de modèles du SDK (hors ligne).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfigRuntime } from "../../src/config/runtime.js";
import { loadEnv } from "../../src/config/env.js";
import { ConfigStore } from "../../src/config/store.js";
import {
  buildModelsConfigFrom,
  type EffectiveLlmConfig,
  type ThinkingLevelName,
} from "../../src/llm/models.js";
import { createLogger } from "../../src/observability/logger.js";
import { resolvePiPaths, writeModelsFile } from "../../src/pi/config.js";
import {
  getSharedModelRuntime,
  resolveSdkModel,
} from "../../src/pi/sdk/model-runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/** Store « ancien » : modèle lourd personnalisé, AUCUNE clé `vision`. */
function makeLegacyStore(root: string): string {
  const storePath = join(root, "state", "config.json");
  const values = {
    "llm.heavy.model": "deepseek-v4.1-flash",
    "llm.heavy.thinking": "high",
    "llm.heavy.baseUrl": "https://ollama.com/v1",
    "llm.light.model": "gemma4:31b",
  };
  new ConfigStore(storePath).write(values);
  const raw = JSON.parse(readFileSync(storePath, "utf8")) as {
    values: Record<string, unknown>;
  };
  // ⚠️ GARDE-FOU du test : le store ne doit contenir AUCUNE clé `vision`.
  expect(Object.keys(raw.values).some((key) => key.includes("vision"))).toBe(false);
  return storePath;
}

/** Config effective LLM, exactement comme `src/index.ts:190-206`. */
function effectiveLlmConfig(config: ReturnType<typeof createConfigRuntime>): EffectiveLlmConfig {
  return {
    light: {
      api: config.getString("llm.light.api"),
      baseUrl: config.getString("llm.light.baseUrl"),
      model: config.getString("llm.light.model"),
      thinking: config.getString("llm.light.thinking") as ThinkingLevelName,
      vision: config.getString("llm.light.vision") === "oui",
    },
    heavy: {
      api: config.getString("llm.heavy.api"),
      baseUrl: config.getString("llm.heavy.baseUrl"),
      model: config.getString("llm.heavy.model"),
      thinking: config.getString("llm.heavy.thinking") as ThinkingLevelName,
      vision: config.getString("llm.heavy.vision") === "oui",
    },
  };
}

describe("compatibilité arrière — config.json antérieur à `llm.*.vision`", () => {
  it("le défaut du schéma s'applique (vision « oui ») et models.json reste VALIDE", async () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-compat-vision-"));
    tempDirs.push(root);
    const storePath = makeLegacyStore(root);
    const env = loadEnv({
      YUKI_MOUNT_STATE: join(root, "state"),
      YUKI_CONFIG_STORE_PATH: storePath,
      YUKI_PI_SYSTEM_PROMPT: join(root, "light.md"),
      YUKI_PI_HEAVY_SYSTEM_PROMPT: join(root, "heavy.md"),
    });
    const config = createConfigRuntime({
      env,
      processEnv: {},
      promptDefaults: { light: "prompt léger", heavy: "prompt lourd" },
    });

    // ① Le défaut du schéma s'applique à une clé ABSENTE du store.
    expect(config.originOf("llm.heavy.vision")).toBe("default");
    expect(config.getString("llm.heavy.vision")).toBe("oui");
    expect(config.originOf("llm.light.vision")).toBe("default");
    expect(config.getString("llm.light.vision")).toBe("oui");
    // Le reste du store est bien pris en compte.
    expect(config.getString("llm.heavy.model")).toBe("deepseek-v4.1-flash");

    // ② `models.json` écrit au démarrage : le modèle LOURD y est, `input` défini.
    const effective = effectiveLlmConfig(config);
    const modelsConfig = buildModelsConfigFrom(effective);
    const heavyProvider = modelsConfig.providers["llm-heavy"];
    expect(heavyProvider).toBeDefined();
    const heavyModel = heavyProvider?.models[0];
    expect(heavyModel?.id).toBe("deepseek-v4.1-flash");
    expect(Array.isArray(heavyModel?.input)).toBe(true);
    expect(heavyModel?.input).toContain("text");
    expect(heavyModel?.input).toContain("image");

    // ③ Le VRAI runtime du SDK résout ce modèle (aucun réseau).
    const paths = resolvePiPaths({
      agentDir: join(root, "agent"),
      cwd: join(root, "workspace"),
      home: join(root, "home"),
      sessionsDir: join(root, "agent", "sessions"),
      settingsSeedPath: "config/pi/settings.json",
    });
    writeModelsFile(paths, modelsConfig, logger);
    const runtime = await getSharedModelRuntime({
      authPath: join(paths.agentDir, "auth.json"),
      modelsPath: paths.modelsPath,
    });
    const resolved = resolveSdkModel(runtime, `llm-heavy/${effective.heavy.model}`);
    expect(resolved).toBeDefined();
    expect(resolved?.id).toBe("deepseek-v4.1-flash");
    expect(resolved?.input).toEqual(["text", "image"]);
  });

  it("un store ancien SANS modèle lourd explicite garde le modèle lourd par défaut", () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-compat-vision-2-"));
    tempDirs.push(root);
    const storePath = join(root, "state", "config.json");
    // Store minimal : uniquement la clé lourde historique.
    new ConfigStore(storePath).write({ "llm.heavy.apiKey": "" });
    const env = loadEnv({
      YUKI_MOUNT_STATE: join(root, "state"),
      YUKI_CONFIG_STORE_PATH: storePath,
      YUKI_PI_SYSTEM_PROMPT: join(root, "light.md"),
      YUKI_PI_HEAVY_SYSTEM_PROMPT: join(root, "heavy.md"),
    });
    const config = createConfigRuntime({
      env,
      processEnv: {},
      promptDefaults: { light: "prompt léger", heavy: "prompt lourd" },
    });
    const effective = effectiveLlmConfig(config);
    const modelsConfig = buildModelsConfigFrom(effective);
    expect(modelsConfig.providers["llm-heavy"]?.models[0]?.id).toBe("deepseek-v4.1-flash");
    expect(modelsConfig.providers["llm-heavy"]?.models[0]?.input).toEqual(["text", "image"]);
    // Et le prompt système LOURD n'est pas vide (il est fichier, pas config).
    expect(config.getString("prompts.heavy").length).toBeGreaterThan(0);
  });
});
