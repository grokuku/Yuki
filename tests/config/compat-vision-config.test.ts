/**
 * COMPATIBILITÉ ARRIÈRE — un `config.json` ANTÉRIEUR au CATALOGUE.
 *
 * ⚠️ POURQUOI CE TEST EXISTE : les réglages par rôle (`llm.light.*`,
 * `llm.heavy.*`, `llm.vision.*`) ont été RETIRÉS du schéma au lot B. Un store
 * existant ne les contient que sous leur ancienne forme : si la reprise ne les
 * lisait pas, le modèle lourd DISPARAÎTRAIT de `models.json` et la session lourde
 * échouerait EN SILENCE (le worker n'aurait plus son modèle).
 *
 * Ce test construit un store « ancien » (clés par rôle, dont un modèle lourd
 * personnalisé et une déclaration de vision), le fait lire par le VRAI runtime de
 * configuration, applique la reprise du catalogue, puis vérifie le `models.json`
 * RÉELLEMENT écrit et sa résolution par le VRAI runtime de modèles du SDK (hors
 * ligne).
 *
 * ⚠️ GARDE RÉVISÉE (2026-11-19, LOT B) : elle vérifiait le défaut du schéma
 * `llm.*.vision` ; elle vérifie désormais que la DÉCLARATION DE VISION DU MODÈLE
 * et le NOM DU MODÈLE traversent la reprise sans perte.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createConfigRuntime } from "../../src/config/runtime.js";
import { loadEnv } from "../../src/config/env.js";
import { ConfigStore } from "../../src/config/store.js";
import { migrerCatalogue, reprendreDefautsDepuisRoles } from "../../src/llm/catalogue.js";
import { llmRouting } from "../../src/llm/routing.js";
import { createLogger } from "../../src/observability/logger.js";
import { resolvePiPaths, writeModelsFile } from "../../src/pi/config.js";
import { getSharedModelRuntime, resolveSdkModel } from "../../src/pi/sdk/model-runtime.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/** Store « ancien » : clés par rôle, AUCUNE clé de catalogue. */
function makeLegacyStore(root: string): string {
  const storePath = join(root, "state", "config.json");
  const values = {
    "llm.heavy.model": "deepseek-v4.1-flash",
    "llm.heavy.thinking": "high",
    "llm.heavy.baseUrl": "https://ollama.com/v1",
    "llm.heavy.vision": "oui",
    "llm.light.model": "gemma4:31b",
    "llm.light.baseUrl": "https://ollama.com/v1",
  };
  new ConfigStore(storePath).write(values);
  const raw = JSON.parse(readFileSync(storePath, "utf8")) as {
    values: Record<string, unknown>;
  };
  // ⚠️ GARDE-FOU du test : le store ne doit contenir AUCUNE clé de CATALOGUE.
  expect(Object.keys(raw.values).some((key) => key.startsWith("llm.fournisseurs"))).toBe(false);
  expect(Object.keys(raw.values).some((key) => key.startsWith("llm.defaut."))).toBe(false);
  return storePath;
}

function runtimeDuStore(root: string) {
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
  // Les deux reprises du démarrage, dans l'ordre de `main()`.
  reprendreDefautsDepuisRoles(config, () => {});
  migrerCatalogue(config, () => {});
  return config;
}

describe("compatibilité arrière — config.json antérieur au CATALOGUE", () => {
  it("la reprise ne perd ni le modèle lourd ni sa vision, et models.json reste VALIDE", async () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-compat-catalogue-"));
    tempDirs.push(root);
    const config = runtimeDuStore(root);

    // ① Le catalogue est créé depuis les réglages par rôle.
    const lourd = config.modeles().find((modele) => modele.nom === "deepseek-v4.1-flash");
    expect(lourd).toBeDefined();
    expect(lourd?.vision).toBe(true);
    expect(lourd?.thinking).toBe("high");
    // ② Le modèle lourd est le DÉFAUT du rôle de travail (sinon il est perdu).
    expect(config.getString("llm.defaut.heavy")).toBe(lourd?.id);
    expect(config.getString("llm.defaut.light")).not.toBe("");

    // ③ `models.json` écrit depuis le catalogue : le modèle LOURD y est, `input`
    // porte bien l'image (déclaration du MODÈLE, plus du rôle).
    const routing = llmRouting(config);
    const fichier = routing.file;
    const fournisseur = fichier.providers[String(lourd?.fournisseurId)];
    expect(fournisseur).toBeDefined();
    const modele = fournisseur?.models.find((candidat) => candidat.id === "deepseek-v4.1-flash");
    expect(modele).toBeDefined();
    expect(modele?.input).toEqual(["text", "image"]);
    expect(routing.models.heavy.reference).toBe(`${lourd?.fournisseurId}/deepseek-v4.1-flash`);

    // ④ Le VRAI runtime du SDK résout ce modèle (aucun réseau).
    const paths = resolvePiPaths({
      agentDir: join(root, "agent"),
      cwd: join(root, "workspace"),
      home: join(root, "home"),
      sessionsDir: join(root, "agent", "sessions"),
      settingsSeedPath: "config/pi/settings.json",
    });
    writeModelsFile(paths, fichier, logger);
    const runtime = await getSharedModelRuntime({
      authPath: join(paths.agentDir, "auth.json"),
      modelsPath: paths.modelsPath,
    });
    const resolved = resolveSdkModel(runtime, routing.models.heavy.reference);
    expect(resolved).toBeDefined();
    expect(resolved?.id).toBe("deepseek-v4.1-flash");
    expect(resolved?.input).toEqual(["text", "image"]);
  });

  it("un store ancien SANS modèle explicite garde les modèles par défaut du code", () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-compat-catalogue-2-"));
    tempDirs.push(root);
    const storePath = join(root, "state", "config.json");
    // Store minimal : rien qui parle de modèle.
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
    reprendreDefautsDepuisRoles(config, () => {});
    migrerCatalogue(config, () => {});

    const routing = llmRouting(config);
    // Les défauts du code (`gemma4:31b` / `deepseek-v4.1-flash`) ont été repris.
    expect(routing.models.light.id).toBe("gemma4:31b");
    expect(routing.models.heavy.id).toBe("deepseek-v4.1-flash");
    expect(routing.models.heavy.input).toEqual(["text", "image"]);
    // Et le prompt système LOURD n'est pas vide (il est fichier, pas config).
    expect(config.getString("prompts.heavy").length).toBeGreaterThan(0);
  });
});
