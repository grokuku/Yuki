/**
 * Runtime de configuration — précédence, verrou d'env, secrets, pont process.env,
 * import unique de models.json.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { llmRouting } from "../../src/llm/routing.js";
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

/** Fournisseur et modèle du catalogue, base de presque tous les cas ci-dessous. */
const FOURNISSEUR_LOCAL = {
  id: "local",
  nom: "Local",
  baseUrl: "https://local.example/v1",
  api: "openai-completions",
};
const MODELE_ALPHA = {
  id: "alpha",
  nom: "chat",
  fournisseurId: "local",
  contexte: 131072,
  vision: true,
  thinking: "off",
};

/** Catalogue minimal (un fournisseur, un modèle) déjà enregistré. */
function avecCatalogue(runtime: ConfigRuntime): void {
  runtime.update({
    "llm.fournisseurs": JSON.stringify([FOURNISSEUR_LOCAL]),
    "llm.modeles": JSON.stringify([MODELE_ALPHA]),
  });
}

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
    // ⚠️ GARDE RÉVISÉE (lot B) : la clé témoin n'est plus `llm.light.model`
    // (retirée au profit du catalogue) mais `llm.missingKeyMode`, qui reste un
    // réglage d'INSTANCE verrouillable par l'environnement.
    expect(runtime.get("llm.missingKeyMode")).toBe("degrade");
    expect(runtime.get("gpu.compatMode")).toBe("strict");
    expect(runtime.get("prompts.light")).toBe("prompt léger");
    expect(runtime.originOf("llm.missingKeyMode")).toBe("default");
    // Les sélections de rôle démarrent VIDES : aucun défaut décidé à la place de
    // l'utilisateur (le bot doit choisir).
    expect(runtime.get("llm.defaut.light")).toBe("");
    expect(runtime.originOf("llm.defaut.light")).toBe("default");
  });

  it("le store surcharge le défaut", () => {
    const { runtime } = makeRuntime();
    runtime.update({ "llm.missingKeyMode": "refuse" });
    expect(runtime.getString("llm.missingKeyMode")).toBe("refuse");
    expect(runtime.originOf("llm.missingKeyMode")).toBe("store");
  });

  it("l'environnement surcharge le store ET verrouille le champ", () => {
    const { runtime } = makeRuntime({ YUKI_LLM_MISSING_KEY_MODE: "refuse" });
    expect(runtime.getString("llm.missingKeyMode")).toBe("refuse");
    expect(runtime.originOf("llm.missingKeyMode")).toBe("env");
    expect(runtime.isLockedByEnv("llm.missingKeyMode")).toBe(true);
    // Le store ne peut pas prendre le pas : un PUT visant le champ est refusé.
    expect(() => runtime.update({ "llm.missingKeyMode": "degrade" })).toThrowError(
      LockedByEnvError,
    );
  });

  it("un env vide n'est PAS une surcharge", () => {
    const { runtime } = makeRuntime({ YUKI_LLM_MISSING_KEY_MODE: "   " });
    expect(runtime.originOf("llm.missingKeyMode")).toBe("default");
    expect(runtime.isLockedByEnv("llm.missingKeyMode")).toBe(false);
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
    // ⚠️ GARDE RÉVISÉE (lot B) : la clé d'un fournisseur est un chemin SECRET
    // dynamique (`llm.fournisseur.<id>.apiKey`), plus `llm.light.apiKey`.
    avecCatalogue(runtime);
    expect(() => runtime.update({ "llm.fournisseur.local.apiKey": "   " })).toThrowError(
      ConfigValidationError,
    );
    try {
      runtime.update({ "llm.fournisseur.local.apiKey": "  " });
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
    avecCatalogue(runtime);
    const result = runtime.update({
      "llm.fournisseur.local.apiKey": "fake-key-123456",
      "llm.defaut.light": "alpha",
    });
    expect(result.applied.hot).toContain("llm.fournisseur.local.apiKey");
    // Le modèle est rechargé À CHAUD (re-résolu au prochain run, sans redémarrage).
    expect(result.applied.hot).toContain("llm.defaut.light");
  });

  it("un changement de FOURNISSEUR (baseUrl/api) est appliqué À CHAUD", () => {
    const { runtime } = makeRuntime();
    const result = runtime.update({
      "llm.fournisseurs": JSON.stringify([
        { ...FOURNISSEUR_LOCAL, baseUrl: "https://passerelle.example/v1" },
      ]),
    });
    // Le catalogue n'exige aucun redémarrage : la bascule se fait entre deux runs
    // via le runtime de modèles PARTAGÉ rafraîchi EN PLACE.
    expect(result.applied.hot).toContain("llm.fournisseurs");
    expect(result.applied.restart).not.toContain("llm.fournisseurs");
  });
});

describe("secrets", () => {
  it("l'instantané ne contient JAMAIS la valeur en clair", () => {
    const { runtime } = makeRuntime();
    avecCatalogue(runtime);
    runtime.update({ "llm.fournisseur.local.apiKey": "sk-super-secret-1234" });
    const snapshot = runtime.snapshot();
    const leaf = snapshot.fields["llm.fournisseur.local.apiKey"] as {
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
    avecCatalogue(runtime);
    // ⚠️ Le nom reflète le FOURNISSEUR du catalogue : c'est CETTE variable que
    // `models.json` référence (`apiKey: "$…_API_KEY"`).
    expect(processEnv["YUKI_LLM_FOURNISSEUR_LOCAL_API_KEY"]).toBeUndefined();
    runtime.update({ "llm.fournisseur.local.apiKey": "store-key-000000" });
    expect(processEnv["YUKI_LLM_FOURNISSEUR_LOCAL_API_KEY"]).toBe("store-key-000000");
    // Effacer la clé la retire de process.env.
    runtime.update({ "llm.fournisseur.local.apiKey": null });
    expect(processEnv["YUKI_LLM_FOURNISSEUR_LOCAL_API_KEY"]).toBeUndefined();
  });

  it("une clé de fournisseur qui n'existe plus est REFUSÉE (et purgée du store)", () => {
    const { runtime } = makeRuntime();
    avecCatalogue(runtime);
    runtime.update({ "llm.fournisseur.local.apiKey": "store-key-000000" });
    // Retirer le fournisseur (après ses modèles) doit retirer sa clé : elle ne
    // peut pas rester « configurée » pour un fournisseur absent.
    runtime.update({ "llm.modeles": JSON.stringify([]), "llm.fournisseurs": JSON.stringify([]) });
    expect(runtime.snapshot().fields["llm.fournisseur.local.apiKey"]).toBeUndefined();
    // Une VALEUR pour un fournisseur inconnu est un refus explicite.
    expect(() => runtime.update({ "llm.fournisseur.inconnu.apiKey": "x-123456" })).toThrowError(
      ConfigValidationError,
    );
  });

  it("secretValues fournit les clés non vides pour la redaction du logger", () => {
    const { runtime } = makeRuntime();
    avecCatalogue(runtime);
    runtime.update({ "llm.fournisseur.local.apiKey": "heavy-secret-9999" });
    expect(runtime.secretValues()).toContain("heavy-secret-9999");
  });
});

describe("import unique de models.json", () => {
  it("importe le CATALOGUE (fournisseurs, modèles, défauts) quand le store est vide", () => {
    const { runtime, store } = makeRuntime();
    // ⚠️ GARDE RÉVISÉE (lot B) : l'import ne remplit plus des réglages de rôle
    // (retirés du schéma) mais le CATALOGUE — sans quoi un premier démarrage sur
    // un `models.json` existant repartirait sur les défauts du code.
    const imported = runtime.importLegacyModels({
      providers: {
        "llm-light": {
          baseUrl: "https://light.example/v1",
          api: "openai-completions",
          models: [{ id: "small", input: ["text", "image"], contextWindow: 4096 }],
        },
        "llm-heavy": {
          baseUrl: "https://heavy.example/v1",
          models: [{ id: "big", contextWindow: 8192 }],
        },
      },
    });
    expect(imported).toContain("llm.fournisseurs");
    expect(imported).toContain("llm.modeles");
    expect(imported).toContain("llm.defaut.light");
    expect(imported).toContain("llm.defaut.heavy");
    expect(runtime.fournisseurs().map((fournisseur) => fournisseur.baseUrl)).toEqual([
      "https://light.example/v1",
      "https://heavy.example/v1",
    ]);
    expect(runtime.modeles().map((modele) => modele.nom)).toEqual(["small", "big"]);
    expect(runtime.modeles()[0]).toMatchObject({ vision: true, contexte: 4096 });
    // Les défauts désignent les modèles repris, rôle par rôle.
    expect(runtime.getString("llm.defaut.light")).toBe(runtime.modeles()[0]?.id);
    expect(runtime.getString("llm.defaut.heavy")).toBe(runtime.modeles()[1]?.id);
    // Persisté.
    expect(store.load().values["llm.modeles"]).toContain("small");
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

describe("catalogue LLM partagé et sélections par bot", () => {
  /**
   * ⚠️ GARDE RÉVISÉE (lot B) : le catalogue JSON du commit externe
   * (`llm.catalog` + `llm.selection.*`) est RETIRÉ au profit de
   * `llm.fournisseurs` / `llm.modeles` / `llm.defaut.*` / `llm.bot.*`. Ce que ce
   * cas vérifie est inchangé : DEUX bots peuvent viser DEUX modèles différents
   * avec UN SEUL `models.json`, les clés restent masquées, et une sélection
   * inconnue est refusée.
   */
  it("deux bots, deux modèles : un seul models.json, clés masquées, sélection inconnue refusée", () => {
    const { runtime, processEnv } = makeRuntime();
    runtime.update({
      "llm.fournisseurs": JSON.stringify([FOURNISSEUR_LOCAL]),
      "llm.modeles": JSON.stringify([
        MODELE_ALPHA,
        { ...MODELE_ALPHA, id: "beta", nom: "code", thinking: "high", vision: false },
      ]),
      "llm.fournisseur.local.apiKey": "secret-local-token",
      "llm.defaut.light": "alpha",
      "llm.defaut.heavy": "beta",
    });
    // Surcharge du SECOND bot : il inverse les deux rôles.
    runtime.updatePour(
      "autre",
      { "llm.bot.light": "beta", "llm.bot.heavy": "alpha" },
      { portee: "bot" },
    );
    const primary = llmRouting(runtime);
    const second = llmRouting(runtime, "autre");
    expect(primary.models.light.reference).toBe("local/chat");
    expect(primary.models.heavy.reference).toBe("local/code");
    expect(second.models.light.reference).toBe("local/code");
    expect(second.models.heavy.reference).toBe("local/chat");
    // ⚠️ La VISION et la RÉFLEXION suivent le MODÈLE, pas le rôle : le bot qui a
    // « code » en discussion perd la vision, sans que le défaut soit écrasé.
    expect(second.effective.light.vision).toBe(false);
    expect(second.effective.light.thinking).toBe("high");
    expect(primary.effective.light.vision).toBe(true);
    expect(runtime.getString("llm.defaut.light")).toBe("alpha");
    // UN SEUL fichier, partagé : tous les modèles du catalogue y sont écrits.
    expect(second.file).toEqual(primary.file);
    expect(primary.file.providers["local"]?.models.map((modele) => modele.id)).toEqual([
      "chat",
      "code",
    ]);
    // La clé du fournisseur n'est JAMAIS écrite : `models.json` ne référence
    // qu'une variable d'environnement, que le pont alimente.
    expect(primary.file.providers["local"]?.apiKey).toBe("$YUKI_LLM_FOURNISSEUR_LOCAL_API_KEY");
    expect(JSON.stringify(primary.file)).not.toContain("secret-local-token");
    expect(processEnv.YUKI_LLM_FOURNISSEUR_LOCAL_API_KEY).toBe("secret-local-token");
    // « clé présente » se déduit du fournisseur RÉSOLU de chaque rôle.
    expect(runtime.snapshotPour("autre").status.heavyKey).toBe(true);
    // Un `modeleId` inconnu est refusé à l'écriture (jamais enregistré).
    expect(() =>
      runtime.updatePour("autre", { "llm.bot.heavy": "inconnu" }, { portee: "bot" }),
    ).toThrow(ConfigValidationError);
    // La valeur du bot « autre » est restée celle qui avait été acceptée (le
    // refus n'a rien écrit) — lue AVEC SON overlay, pas celui du bot actif.
    expect(runtime.valeurPour("autre", "llm.bot.heavy")).toBe("alpha");
  });
});
