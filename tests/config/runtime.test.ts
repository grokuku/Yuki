/**
 * Runtime de configuration — précédence, verrou d'env, secrets, pont process.env,
 * import unique de models.json.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import {
  ConfigRuntime,
  ConfigValidationError,
  LockedByEnvError,
  createConfigRuntime,
  maskSecret,
} from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRuntime(processEnv: NodeJS.ProcessEnv = {}): {
  runtime: ConfigRuntime;
  store: ConfigStore;
  processEnv: NodeJS.ProcessEnv;
} {
  const root = mkdtempSync(join(tmpdir(), "yuki-runtime-"));
  tempDirs.push(root);
  const storePath = join(root, "state", "config.json");
  const env = loadEnv({
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: storePath,
    YUKI_PI_SYSTEM_PROMPT: join(root, "light.md"),
    YUKI_PI_HEAVY_SYSTEM_PROMPT: join(root, "heavy.md"),
  });
  const store = new ConfigStore(storePath);
  const envCopy: NodeJS.ProcessEnv = { ...processEnv };
  const runtime = createConfigRuntime({
    env,
    store,
    processEnv: envCopy,
    promptDefaults: { light: "prompt léger", heavy: "prompt lourd" },
  });
  return { runtime, store, processEnv: envCopy };
}

describe("précédence défauts < store < env", () => {
  it("sans store ni env : valeurs par défaut", () => {
    const { runtime } = makeRuntime();
    expect(runtime.get("llm.light.model")).toBe("gemma4:31b");
    expect(runtime.get("gpu.compatMode")).toBe("strict");
    expect(runtime.get("prompts.light")).toBe("prompt léger");
    expect(runtime.originOf("llm.light.model")).toBe("default");
  });

  it("le store surcharge le défaut", () => {
    const { runtime } = makeRuntime();
    runtime.update({ "llm.light.model": "from-store" });
    expect(runtime.getString("llm.light.model")).toBe("from-store");
    expect(runtime.originOf("llm.light.model")).toBe("store");
  });

  it("l'environnement surcharge le store ET verrouille le champ", () => {
    const { runtime } = makeRuntime({ YUKI_LLM_LIGHT_MODEL: "from-env" });
    expect(runtime.getString("llm.light.model")).toBe("from-env");
    expect(runtime.originOf("llm.light.model")).toBe("env");
    expect(runtime.isLockedByEnv("llm.light.model")).toBe(true);
    // Le store ne peut pas prendre le pas : un PUT visant le champ est refusé.
    expect(() => runtime.update({ "llm.light.model": "from-store" })).toThrowError(
      LockedByEnvError,
    );
  });

  it("un env vide n'est PAS une surcharge", () => {
    const { runtime } = makeRuntime({ YUKI_LLM_LIGHT_MODEL: "   " });
    expect(runtime.originOf("llm.light.model")).toBe("default");
    expect(runtime.isLockedByEnv("llm.light.model")).toBe(false);
  });

  it("env invalide → EnvError au chargement", () => {
    expect(() => makeRuntime({ YUKI_MIN_DRIVER: "abc" })).toThrowError(
      /YUKI_MIN_DRIVER invalide/,
    );
  });
});

describe("update — patch fusionnant", () => {
  it("champ omis = conserver, string = remplacer, null = effacer", () => {
    const { runtime } = makeRuntime();
    runtime.update({ "gpu.profile": "compact", "delegation.maxQueue": 4 });
    expect(runtime.getString("gpu.profile")).toBe("compact");

    runtime.update({ "gpu.profile": "repli" });
    expect(runtime.getString("gpu.profile")).toBe("repli");
    // maxQueue non mentionné : conservé.
    expect(runtime.getNumber("delegation.maxQueue")).toBe(4);

    runtime.update({ "gpu.profile": null });
    expect(runtime.getString("gpu.profile")).toBe("");
    expect(runtime.originOf("gpu.profile")).toBe("default");
  });

  it("clé vide/espaces → empty_api_key", () => {
    const { runtime } = makeRuntime();
    expect(() => runtime.update({ "llm.light.apiKey": "   " })).toThrowError(
      ConfigValidationError,
    );
    try {
      runtime.update({ "llm.light.apiKey": "  " });
    } catch (error) {
      const fields = (error as ConfigValidationError).fields;
      expect(fields[0]?.code).toBe("empty_api_key");
    }
  });

  it("bornes et énumérations sont validées", () => {
    const { runtime } = makeRuntime();
    try {
      runtime.update({ "delegation.defaultDeadlineMs": 10 });
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).fields[0]?.code).toBe("below_min");
    }
    expect(() => runtime.update({ "gpu.compatMode": "maybe" })).toThrowError(
      ConfigValidationError,
    );
    expect(() => runtime.update({ "nope.nope": 1 })).toThrowError(
      ConfigValidationError,
    );
  });

  it("champ verrouillé → LockedByEnvError avec le nom de la variable", () => {
    const { runtime } = makeRuntime({ YUKI_GPU_COMPAT: "", YUKI_COMPAT_MODE: "auto-degrade" });
    try {
      runtime.update({ "gpu.compatMode": "strict" });
      throw new Error("aurait dû échouer");
    } catch (error) {
      expect(error).toBeInstanceOf(LockedByEnvError);
      const locked = (error as LockedByEnvError).locked;
      expect(locked[0]).toEqual({ path: "gpu.compatMode", variable: "YUKI_COMPAT_MODE" });
    }
  });

  it("applied.hot / applied.restart suivent le schéma", () => {
    const { runtime } = makeRuntime();
    const result = runtime.update({
      "llm.light.apiKey": "fake-key-123456",
      "llm.light.model": "small-model",
    });
    expect(result.applied.hot).toContain("llm.light.apiKey");
    expect(result.applied.restart).toContain("llm.light.model");
  });
});

describe("secrets", () => {
  it("l'instantané ne contient JAMAIS la valeur en clair", () => {
    const { runtime } = makeRuntime();
    runtime.update({ "llm.light.apiKey": "sk-super-secret-1234" });
    const snapshot = runtime.snapshot();
    const leaf = snapshot.fields["llm.light.apiKey"] as {
      configured: boolean;
      masked: string | null;
      source: string;
    };
    expect(leaf.configured).toBe(true);
    expect(leaf.source).toBe("store");
    expect(leaf.masked).toBe("••••1234");
    expect(JSON.stringify(snapshot)).not.toContain("sk-super-secret-1234");
  });

  it("le masque ne laisse que 4 caractères", () => {
    expect(maskSecret("abcdefgh")).toBe("••••efgh");
    expect(maskSecret("ab")).toBe("••••");
  });

  it("bridgeSecrets reflète les clés du store dans process.env", () => {
    const { runtime, processEnv } = makeRuntime();
    expect(processEnv["YUKI_LLM_LIGHT_API_KEY"]).toBeUndefined();
    runtime.update({ "llm.light.apiKey": "store-key-000000" });
    expect(processEnv["YUKI_LLM_LIGHT_API_KEY"]).toBe("store-key-000000");
    // Effacer la clé la retire de process.env.
    runtime.update({ "llm.light.apiKey": null });
    expect(processEnv["YUKI_LLM_LIGHT_API_KEY"]).toBeUndefined();
  });

  it("le bridge ne remplace PAS une clé fournie par l'environnement", () => {
    const { runtime, processEnv } = makeRuntime({
      YUKI_LLM_LIGHT_API_KEY: "env-key-111111",
    });
    processEnv["YUKI_LLM_LIGHT_API_KEY"] = "env-key-111111";
    // Le store ne peut pas écraser un champ verrouillé, mais le bridge
    // conserve la valeur d'env telle quelle.
    expect(() => runtime.update({ "llm.light.apiKey": "other" })).toThrowError(
      LockedByEnvError,
    );
    runtime.bridgeSecrets();
    expect(processEnv["YUKI_LLM_LIGHT_API_KEY"]).toBe("env-key-111111");
  });

  it("secretValues fournit les clés non vides pour la redaction du logger", () => {
    const { runtime } = makeRuntime();
    runtime.update({ "llm.heavy.apiKey": "heavy-secret-9999" });
    expect(runtime.secretValues()).toContain("heavy-secret-9999");
  });
});

describe("import unique de models.json", () => {
  it("importe baseUrl/api/modèle par provider quand le store est vide", () => {
    const { runtime, store } = makeRuntime();
    const imported = runtime.importLegacyModels({
      providers: {
        "llm-light": {
          baseUrl: "https://light.example/v1",
          api: "openai-completions",
          models: [{ id: "small" }],
        },
        "llm-heavy": {
          baseUrl: "https://heavy.example/v1",
          models: [{ id: "big" }],
        },
      },
    });
    expect(imported).toContain("llm.light.baseUrl");
    expect(imported).toContain("llm.light.model");
    expect(imported).toContain("llm.heavy.model");
    expect(runtime.getString("llm.light.baseUrl")).toBe("https://light.example/v1");
    expect(runtime.getString("llm.heavy.model")).toBe("big");
    // Persisté.
    expect(store.load().values["llm.light.model"]).toBe("small");
  });

  it("ne fait rien si le store n'est pas vide", () => {
    const { runtime } = makeRuntime();
    runtime.update({ "gpu.profile": "compact" });
    const imported = runtime.importLegacyModels({
      providers: { "llm-light": { baseUrl: "https://x/v1" } },
    });
    expect(imported).toEqual([]);
  });
});

describe("subscribe", () => {
  it("notifie les abonnés après une modification effective", () => {
    const { runtime } = makeRuntime();
    let count = 0;
    runtime.subscribe(() => {
      count += 1;
    });
    runtime.update({ "gpu.profile": "compact" });
    expect(count).toBe(1);
    // Un patch vide n'émet rien.
    runtime.update({});
    expect(count).toBe(1);
  });
});
