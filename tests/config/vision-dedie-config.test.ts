/**
 * MODÈLE DE VISION DÉDIÉ — côté CONFIGURATION (`llm.vision.*`).
 *
 * ⚠️ POURQUOI CE FICHIER : le premier jet offrait un sélecteur parmi les deux
 * modèles existants (`vision.fallback.model`). Insuffisant (demande utilisateur
 * du 2026-11-16) : si ni le léger ni le lourd ne voit les images, ce sélecteur
 * ne sert à rien. Le réglage devient un TROISIÈME emplacement de modèle
 * (`baseUrl` + `model` + `thinking` + `apiKey`), calqué sur `llm.heavy.*`.
 *
 * Ce que ce fichier prouve :
 *  ① tout vide (défaut) ⇒ AUCUN provider `llm-vision` : pas de repli, pas de
 *    comportement changé ;
 *  ② la clé se règle comme les deux autres rôles : champ secret (store 0600)
 *    OU variable `YUKI_LLM_VISION_API_KEY`, reflétée dans `process.env` pour que
 *    `models.json` la référence (`$…_API_KEY`) ;
 *  ③ `models.json` porte le provider `llm-vision` dès que l'adresse ET le modèle
 *    sont renseignés ;
 *  ④ ⚠️ `vision.fallback.model` résiduelle dans un `config.json` ⇒ IGNORÉE avec
 *    un AVERTISSEMENT au démarrage, jamais un échec ;
 *  ⑤ À CHAUD : changer le modèle de vision dans le store prend effet à l'usage
 *    suivant (abonnement notifié + `models.json` recalculé), sans redémarrage.
 *
 * ⚠️ Échoue sur l'arbre d'origine : les clés `llm.vision.*` n'existent pas et
 * `vision.fallback.model` y est encore une clé VALIDE (donc aucun avertissement
 * de « réglage supprimé »).
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";
import { CLES_CONFIG_RETIREES, CONFIG_SCHEMA } from "../../src/config/schema.js";
import { handleConfigRequest } from "../../src/gateway/routes/config.js";
import {
  buildModelsConfigFrom,
  visionConfigured,
  type EffectiveLlmConfig,
  type ThinkingLevelName,
} from "../../src/llm/models.js";
import { createLogger } from "../../src/observability/logger.js";
import { resolvePiPaths, seedSettingsFile, writeModelsFile } from "../../src/pi/config.js";
import { getSharedModelRuntime, providerHasAuth } from "../../src/pi/sdk/model-runtime.js";

const logger = createLogger({ level: "error", sink: () => {}, secretValues: [] });

/** En-tête exigé par les routes d'écriture (même valeur que l'interface). */
const WRITE_HEADERS = { "x-yuki-config": "1", "content-type": "application/json" };

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  // ⚠️ Les clés sont reflétées dans `process.env` (pont du SDK) : on rend
  // l'environnement du processus tel qu'on l'a trouvé.
  delete process.env.YUKI_LLM_VISION_API_KEY;
  delete process.env.YUKI_LLM_LIGHT_API_KEY;
  delete process.env.YUKI_LLM_HEAVY_API_KEY;
});

/** Runtime réel sur un store jetable (aucun accès réseau). */
function runtimeAvec(
  valeurs: Record<string, unknown> = {},
  processEnv: NodeJS.ProcessEnv = {},
) {
  const root = mkdtempSync(join(tmpdir(), "yuki-vision-config-"));
  tempDirs.push(root);
  const storePath = join(root, "state", "config.json");
  if (Object.keys(valeurs).length > 0) new ConfigStore(storePath).write(valeurs);
  const env = loadEnv({
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: storePath,
    YUKI_PI_SYSTEM_PROMPT: join(root, "light.md"),
    YUKI_PI_HEAVY_SYSTEM_PROMPT: join(root, "heavy.md"),
  });
  const config = createConfigRuntime({
    env,
    processEnv,
    promptDefaults: { light: "prompt léger", heavy: "prompt lourd" },
  });
  return { config, processEnv, storePath };
}

/** Config effective LLM, exactement comme `src/index.ts` (`effectiveLlmConfig`). */
function effectiveLlmConfig(
  config: ReturnType<typeof createConfigRuntime>,
): EffectiveLlmConfig {
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
    vision: {
      baseUrl: config.getString("llm.vision.baseUrl"),
      model: config.getString("llm.vision.model"),
      thinking: config.getString("llm.vision.thinking") as ThinkingLevelName,
    },
  };
}

describe("① défaut : tout vide ⇒ aucun repli (comportement inchangé)", () => {
  it("baseUrl et modèle vides, thinking `off`, et AUCUN provider `llm-vision`", () => {
    const { config } = runtimeAvec();
    expect(config.getString("llm.vision.baseUrl")).toBe("");
    expect(config.getString("llm.vision.model")).toBe("");
    expect(config.getString("llm.vision.thinking")).toBe("off");
    // Origine = le DÉFAUT du schéma : un store existant n'a pas à porter ces clés.
    expect(config.originOf("llm.vision.model")).toBe("default");

    const effective = effectiveLlmConfig(config);
    expect(visionConfigured(effective.vision)).toBe(false);
    // ⚠️ Le fichier par DÉFAUT ne contient pas de provider de vision : rien à
    // appeler, donc l'absence de repli est structurelle (pas une garde d'exécution).
    expect(buildModelsConfigFrom(effective).providers["llm-vision"]).toBeUndefined();
  });
});

describe("② la clé est réglable comme les deux autres rôles", () => {
  it("variable `YUKI_LLM_VISION_API_KEY` : verrouille le champ et alimente process.env", () => {
    const { config, processEnv } = runtimeAvec(
      {},
      { YUKI_LLM_VISION_API_KEY: "cle-vision-secrete" },
    );
    expect(CONFIG_SCHEMA["llm.vision.apiKey"]?.env).toBe("YUKI_LLM_VISION_API_KEY");
    expect(config.isLockedByEnv("llm.vision.apiKey")).toBe(true);
    // ⚠️ `models.json` référence `$YUKI_LLM_VISION_API_KEY` : le pont doit avoir
    // eu lieu, sinon le SDK résoudrait une variable vide.
    config.bridgeSecrets();
    expect(processEnv.YUKI_LLM_VISION_API_KEY).toBe("cle-vision-secrete");
  });

  it("le champ secret du store est reflété dans process.env par `bridgeSecrets`", () => {
    const { config, processEnv } = runtimeAvec({
      "llm.vision.apiKey": "cle-saisie-dans-config",
    });
    config.bridgeSecrets();
    expect(processEnv.YUKI_LLM_VISION_API_KEY).toBe("cle-saisie-dans-config");
    // La valeur n'est jamais exposée par l'instantané (secret masqué).
    const champs = config.snapshot().fields["llm.vision.apiKey"];
    expect(JSON.stringify(champs)).not.toContain("cle-saisie-dans-config");
  });
});

describe("③ `models.json` : provider `llm-vision` dès que adresse + modèle existent", () => {
  it("les valeurs du store produisent l'URL, le modèle et la référence de clé", () => {
    const { config } = runtimeAvec({
      "llm.vision.baseUrl": "https://vision.exemple/v1",
      "llm.vision.model": "qwen2.5-vl-7b",
    });
    const provider = buildModelsConfigFrom(effectiveLlmConfig(config)).providers[
      "llm-vision"
    ];
    expect(provider).toBeDefined();
    expect(provider?.baseUrl).toBe("https://vision.exemple/v1");
    expect(provider?.models[0]?.id).toBe("qwen2.5-vl-7b");
    expect(provider?.apiKey).toBe("$YUKI_LLM_VISION_API_KEY");
  });
});

describe("④ ⚠️ `vision.fallback.model` résiduelle : ignorée + AVERTIE, jamais un échec", () => {
  it("démarre normalement, l'annonce au démarrage, et n'obéit pas à l'ancienne clé", () => {
    const { config } = runtimeAvec({
      "vision.fallback.model": "llm-heavy/deepseek-v4.1-flash",
    });
    const avertissements = config.warnings.join("\n");
    // ⚠️ Dit, et avec le REMPLACEMENT (un réglage qui n'agit plus en silence est
    // le pire des deux mondes).
    expect(avertissements).toContain("vision.fallback.model");
    expect(avertissements).toContain("SUPPRIMÉ");
    expect(avertissements).toContain("Vision de repli");
    // Jamais un échec : le runtime existe, les autres réglages sont lus.
    expect(config.getString("llm.light.model").length).toBeGreaterThan(0);
    // Et l'ancienne clé ne produit AUCUN repli : le modèle de vision reste vide.
    const effective = effectiveLlmConfig(config);
    expect(visionConfigured(effective.vision)).toBe(false);
    expect(buildModelsConfigFrom(effective).providers["llm-vision"]).toBeUndefined();
    // La table des clés retirées porte bien ce remplacement.
    expect(CLES_CONFIG_RETIREES["vision.fallback.model"]).toContain("llm.vision");
  });
});

describe("⑤ À CHAUD : changer le modèle de vision, sans redémarrage", () => {
  it("l'abonnement est notifié et `models.json` suit immédiatement", () => {
    const { config } = runtimeAvec({
      "llm.vision.baseUrl": "https://vision.exemple/v1",
      "llm.vision.model": "qwen2.5-vl-7b",
    });
    const avant = buildModelsConfigFrom(effectiveLlmConfig(config));
    expect(avant.providers["llm-vision"]?.models[0]?.id).toBe("qwen2.5-vl-7b");

    let notifie = 0;
    const stop = config.subscribe(() => {
      notifie += 1;
    });
    config.update({ "llm.vision.model": "llava-1.6-34b" }, { portee: "instance", refuser: "bot" });
    stop();

    expect(notifie).toBeGreaterThan(0);
    const apres = buildModelsConfigFrom(effectiveLlmConfig(config));
    expect(apres.providers["llm-vision"]?.models[0]?.id).toBe("llava-1.6-34b");
    // ⚠️ Les deux modèles de conversation n'ont PAS bougé : le modèle de vision
    // vit dans son propre provider, il ne remplace personne.
    expect(apres.providers["llm-light"]?.models[0]?.id).toBe(
      avant.providers["llm-light"]?.models[0]?.id,
    );
    expect(apres.providers["llm-heavy"]?.models[0]?.id).toBe(
      avant.providers["llm-heavy"]?.models[0]?.id,
    );
  });

  it("vider le modèle de vision RETIRE le provider (plus de repli)", () => {
    const { config } = runtimeAvec({
      "llm.vision.baseUrl": "https://vision.exemple/v1",
      "llm.vision.model": "qwen2.5-vl-7b",
    });
    config.update({ "llm.vision.model": "" }, { portee: "instance", refuser: "bot" });
    const effective = effectiveLlmConfig(config);
    expect(visionConfigured(effective.vision)).toBe(false);
    expect(buildModelsConfigFrom(effective).providers["llm-vision"]).toBeUndefined();
  });
});

describe("⑥ ⚠️ la clé de vision s'ENTRE DANS L'INTERFACE (même chemin que les deux autres)", () => {
  /** Enregistre une clé par la ROUTE de l'interface (`PUT /api/config`). */
  async function poserCle(
    config: ReturnType<typeof createConfigRuntime>,
    path: string,
    valeur: string,
  ) {
    return handleConfigRequest({
      method: "PUT",
      path: "/api/config",
      headers: WRITE_HEADERS,
      body: JSON.stringify({ [path]: valeur }),
      deps: { runtime: config, logger },
    });
  }

  it("enregistre, masque, et ne renvoie JAMAIS la valeur en clair", async () => {
    const { config, storePath } = runtimeAvec({
      "llm.vision.baseUrl": "https://vision.exemple/v1",
      "llm.vision.model": "qwen2.5-vl-7b",
    });
    const secret = "cle-vision-000000000001";
    const reponse = await poserCle(config, "llm.vision.apiKey", secret);
    expect(reponse.status).toBe(200);
    // ⚠️ Le corps brut ne contient jamais la valeur (même garantie que pour les
    // deux autres rôles).
    expect(JSON.stringify(reponse.body)).not.toContain(secret);
    const champs = (reponse.body as { fields: Record<string, { configured?: boolean; masked?: string }> })
      .fields;
    expect(champs["llm.vision.apiKey"]).toMatchObject({ configured: true, masked: "••••0001" });
    // Appliquée à chaud, comme les deux autres.
    expect((reponse.body as { applied: { hot: string[] } }).applied.hot).toContain(
      "llm.vision.apiKey",
    );

    // La clé est bien persistée (store 0600) et masquée à la relecture.
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    const relu = await handleConfigRequest({
      method: "GET",
      path: "/api/config",
      headers: {},
      body: "",
      deps: { runtime: config, logger },
    });
    expect(JSON.stringify(relu.body)).not.toContain(secret);
    expect(
      (relu.body as { fields: Record<string, { configured?: boolean }> }).fields[
        "llm.vision.apiKey"
      ]?.configured,
    ).toBe(true);
  });

  it("⚠️ le modèle de vision UTILISE cette clé (pont process.env → models.json → SDK)", async () => {
    const { config, processEnv } = runtimeAvec({
      "llm.vision.baseUrl": "https://vision.exemple/v1",
      "llm.vision.model": "qwen2.5-vl-7b",
    });
    const secret = "cle-vision-000000000009";
    expect((await poserCle(config, "llm.vision.apiKey", secret)).status).toBe(200);

    // ⚠️ MÊME pont que pour les deux autres rôles : le store est reflété dans
    // `process.env` (référence `$YUKI_LLM_VISION_API_KEY` de `models.json`).
    config.bridgeSecrets();
    expect(processEnv.YUKI_LLM_VISION_API_KEY).toBe(secret);

    // `models.json` réel écrit depuis la configuration, puis résolution par le
    // VRAI runtime de modèles du SDK (hors ligne).
    const root = mkdtempSync(join(tmpdir(), "yuki-vision-auth-"));
    tempDirs.push(root);
    const paths = resolvePiPaths({
      agentDir: join(root, "agent"),
      cwd: join(root, "workspace"),
      home: join(root, "home"),
      sessionsDir: join(root, "agent", "sessions"),
      settingsSeedPath: "config/pi/settings.json",
    });
    seedSettingsFile(paths, logger);
    writeModelsFile(paths, buildModelsConfigFrom(effectiveLlmConfig(config)), logger);

    // ⚠️ CONTRÔLE NÉGATIF d'abord : sans la variable, le provider n'a AUCUNE
    // authentification — sans quoi le test suivant ne prouverait rien.
    delete process.env.YUKI_LLM_VISION_API_KEY;
    const runtimeSansCle = await getSharedModelRuntime({
      authPath: join(paths.agentDir, "auth.json"),
      modelsPath: paths.modelsPath,
    });
    expect(providerHasAuth(runtimeSansCle, "llm-vision")).toBe(false);

    process.env.YUKI_LLM_VISION_API_KEY = processEnv.YUKI_LLM_VISION_API_KEY;
    const runtime = await getSharedModelRuntime({
      authPath: join(paths.agentDir, "auth.json"),
      modelsPath: paths.modelsPath,
    });
    // ⚠️ Avec la clé saisie dans l'interface, le modèle de vision est
    // authentifié : c'est bien elle qui l'alimente (pas l'environnement du
    // déploiement, pas `auth.json`).
    expect(providerHasAuth(runtime, "llm-vision")).toBe(true);
  });

  it("⚠️ aucune régression : les clés du léger et du lourd suivent le même chemin", async () => {
    const { config, processEnv } = runtimeAvec();
    expect((await poserCle(config, "llm.light.apiKey", "cle-legere-000000000002")).status).toBe(200);
    expect((await poserCle(config, "llm.heavy.apiKey", "cle-lourde-000000000003")).status).toBe(200);
    config.bridgeSecrets();
    expect(processEnv.YUKI_LLM_LIGHT_API_KEY).toBe("cle-legere-000000000002");
    expect(processEnv.YUKI_LLM_HEAVY_API_KEY).toBe("cle-lourde-000000000003");
    expect(config.getString("llm.vision.apiKey")).toBe("");
  });
});
