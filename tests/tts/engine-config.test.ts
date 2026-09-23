/**
 * Tests unitaires — configuration STRUCTURÉE du moteur `audio.cpp` (Lot 9).
 *
 * Vérifie les invariants de sûreté : aller-retour **fidèle** (clés inconnues
 * préservées), listes fermées (`clon` accepté / `clone` refusé, mode imposé à
 * `chatterbox`/`cosyvoice3`), écriture **atomique**, sauvegarde unique et
 * restauration, refus des chemins non sûrs, et comportement si le fichier est
 * absent / illisible / JSON invalide.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EngineConfigError,
  EngineConfigStore,
  ENGINE_FAMILIES,
  ENGINE_TASK_TOKENS,
  validateEngineConfig,
} from "../../src/tts/engine-config.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  configDir: string;
  modelsDir: string;
  modelsWriteDir: string;
  store: EngineConfigStore;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "yuki-engine-config-"));
  tempDirs.push(root);
  const configDir = join(root, "tts-config");
  const modelsDir = join(root, "models");
  // Le chemin d'écriture est un SOUS-DOSSIER du montage des modèles (dérivé par
  // le store, jamais configurable) : ici il n'est PAS créé (sous-dossier absent).
  const modelsWriteDir = join(modelsDir, "downloads");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });
  const store = new EngineConfigStore({
    configDir,
    engineConfigDir: "/config",
    modelsDir,
    engineModelsDir: "/models",
  });
  return { root, configDir, modelsDir, modelsWriteDir, store };
}

function writeConfig(fx: Fixture, doc: unknown): void {
  writeFileSync(join(fx.configDir, "server.json"), JSON.stringify(doc, null, 2), "utf8");
}

function validModel(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "chatterbox",
    family: "chatterbox",
    task: "clon",
    mode: "offline",
    path: "/models/chatterbox.gguf",
    ...overrides,
  };
}

describe("listes fermées", () => {
  it("contient le jeton canonique `clon` et jamais `clone`", () => {
    expect(ENGINE_TASK_TOKENS).toContain("clon");
    expect(ENGINE_TASK_TOKENS).not.toContain("clone");
  });

  it("familles : liste fermée non vide", () => {
    expect(ENGINE_FAMILIES.length).toBeGreaterThan(0);
    expect(ENGINE_FAMILIES).toContain("chatterbox");
    expect(ENGINE_FAMILIES).toContain("cosyvoice3");
  });

  it("accepte `clon`, refuse `clone` avec un message explicite", () => {
    const ok = validateEngineConfig({ models: [validModel()] });
    expect(ok).toEqual([]);

    const bad = validateEngineConfig({ models: [validModel({ task: "clone" })] });
    expect(bad).toHaveLength(1);
    expect(bad[0]?.path).toBe("models[0].task");
    expect(bad[0]?.code).toBe("invalid_task");
    expect(bad[0]?.message).toContain("clon");
  });

  it("refuse un mode inconnu et impose `offline` à chatterbox / cosyvoice3", () => {
    const invalid = validateEngineConfig({ models: [validModel({ mode: "batch" })] });
    expect(invalid[0]?.code).toBe("invalid_mode");

    for (const family of ["chatterbox", "cosyvoice3"]) {
      const forced = validateEngineConfig({
        models: [validModel({ family, mode: "streaming" })],
      });
      expect(forced.some((e) => e.code === "mode_not_supported"), family).toBe(true);
    }
  });

  it("refuse une famille hors liste", () => {
    const errors = validateEngineConfig({ models: [validModel({ family: "inconnue" })] });
    expect(errors[0]?.code).toBe("invalid_family");
  });

  it("refuse des identifiants dupliqués", () => {
    const errors = validateEngineConfig({
      models: [validModel(), validModel({ path: "/models/autre.gguf" })],
    });
    expect(errors.some((e) => e.code === "duplicate_id")).toBe(true);
  });
});

describe("lecture", () => {
  it("fichier absent : exists=false sans exception", () => {
    const fx = fixture();
    const read = fx.store.readRaw();
    expect(read.exists).toBe(false);
    expect(read.raw).toBeNull();
    expect(read.backupExists).toBe(false);
  });

  it("JSON invalide : rapport d'erreur lisible, aucune exception", () => {
    const fx = fixture();
    writeFileSync(join(fx.configDir, "server.json"), "{ pas du json", "utf8");
    const read = fx.store.readRaw();
    expect(read.exists).toBe(true);
    expect(read.valid).toBe(false);
    expect(read.parseError).toContain("JSON invalide");
    expect(fx.store.report().valid).toBe(false);
  });

  it("fichier illisible (chemin = dossier) : message clair", () => {
    const fx = fixture();
    mkdirSync(join(fx.configDir, "server.json"));
    const read = fx.store.readRaw();
    expect(read.valid).toBe(false);
    expect(read.parseError).toContain("illisible");
  });
});

describe("patch structuré — aller-retour fidèle", () => {
  it("préserve les clés inconnues de premier niveau et d'entrée", () => {
    const fx = fixture();
    writeConfig(fx, {
      host: "0.0.0.0",
      port: 8081,
      cors_origins: "https://exemple",
      live_ingest: { max_ms: 5000 },
      models: [
        {
          id: "chatterbox",
          family: "chatterbox",
          path: "/models/chatterbox.gguf",
          task: "clon",
          mode: "offline",
          load_options: { keep_alive: true },
        },
      ],
    });

    const report = fx.store.applyPatch({ globals: { port: 9000 } });
    const written = JSON.parse(readFileSync(join(fx.configDir, "server.json"), "utf8"));
    expect(written.port).toBe(9000);
    expect(written.cors_origins).toBe("https://exemple");
    expect(written.live_ingest).toEqual({ max_ms: 5000 });
    expect(written.models[0].load_options).toEqual({ keep_alive: true });
    expect(report.globals.port).toBe(9000);
    expect(report.unknownTopLevelKeys).toContain("cors_origins");
    expect(report.unknownTopLevelKeys).toContain("live_ingest");
  });

  it("conserve les clés inconnues d'une entrée réécrite (même id)", () => {
    const fx = fixture();
    writeConfig(fx, {
      models: [
        {
          id: "chatterbox",
          family: "chatterbox",
          path: "/models/old.gguf",
          task: "clon",
          mode: "offline",
          session_options: { mem_saver: true },
        },
      ],
    });
    fx.store.applyPatch({
      models: [
        {
          id: "chatterbox",
          family: "chatterbox",
          path: "/models/new.gguf",
          task: "clon",
          mode: "offline",
        },
      ],
    });
    const written = JSON.parse(readFileSync(join(fx.configDir, "server.json"), "utf8"));
    expect(written.models[0].path).toBe("/models/new.gguf");
    expect(written.models[0].session_options).toEqual({ mem_saver: true });
  });

  it("convertit un chemin GATEWAY (/models) vers le point de vue MOTEUR", () => {
    const fx = fixture();
    const report = fx.store.applyPatch({
      models: [validModel({ path: join(fx.modelsDir, "chatterbox.gguf") })],
    });
    expect(report.models[0]?.path).toBe("/models/chatterbox.gguf");
    const written = JSON.parse(readFileSync(join(fx.configDir, "server.json"), "utf8"));
    expect(written.models[0].path).toBe("/models/chatterbox.gguf");
  });

  it("traduit le sous-dossier d'écriture (/models/downloads → vue moteur)", () => {
    const fx = fixture();
    const report = fx.store.applyPatch({
      models: [validModel({ path: join(fx.modelsWriteDir, "x.gguf") })],
    });
    expect(report.models[0]?.path).toBe("/models/downloads/x.gguf");
  });

  it("refuse un chemin non sûr (composante `..`)", () => {
    const fx = fixture();
    expect(() =>
      fx.store.applyPatch({ models: [validModel({ path: "/models/../secret.gguf" })] }),
    ).toThrowError(EngineConfigError);
    try {
      fx.store.applyPatch({ models: [validModel({ path: "/models/../secret.gguf" })] });
    } catch (error) {
      expect((error as EngineConfigError).fields[0]?.code).toBe("unsafe_path");
    }
  });

  it("refuse un chemin hors des montages connus", () => {
    const fx = fixture();
    try {
      fx.store.applyPatch({ models: [validModel({ path: "/ailleurs/x.gguf" })] });
      throw new Error("aurait dû lever");
    } catch (error) {
      expect(error).toBeInstanceOf(EngineConfigError);
      expect((error as EngineConfigError).fields[0]?.code).toBe("path_outside_mounts");
    }
  });

  it("refuse un champ de patch inconnu", () => {
    const fx = fixture();
    try {
      fx.store.applyPatch({ raw: {} });
      throw new Error("aurait dû lever");
    } catch (error) {
      expect((error as EngineConfigError).code).toBe("unknown_patch_field");
    }
  });

  it("écrit de façon ATOMIQUE : aucun fichier temporaire résiduel", () => {
    const fx = fixture();
    fx.store.applyPatch({ models: [validModel()] });
    fx.store.applyPatch({ globals: { port: 9001 } });
    const leftovers = readdirSync(fx.configDir).filter((name) => name.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });
});

describe("sauvegarde et restauration", () => {
  it("conserve UNE sauvegarde = version précédente, et la restaure", () => {
    const fx = fixture();
    writeConfig(fx, { models: [validModel({ path: "/models/v1.gguf" })] });
    fx.store.applyPatch({ globals: { port: 9100 } });
    // Le .bak contient la version AVANT l'écriture (sans port).
    const backup = JSON.parse(readFileSync(join(fx.configDir, "server.json.bak"), "utf8"));
    expect(backup.port).toBeUndefined();
    expect(backup.models[0].path).toBe("/models/v1.gguf");

    // Deuxième écriture : le .bak devient la version précédente (avec port).
    fx.store.applyPatch({ globals: { port: 9200 } });
    const backup2 = JSON.parse(readFileSync(join(fx.configDir, "server.json.bak"), "utf8"));
    expect(backup2.port).toBe(9100);

    const restored = fx.store.revert();
    expect(restored.globals.port).toBe(9100);
    const written = JSON.parse(readFileSync(join(fx.configDir, "server.json"), "utf8"));
    expect(written.port).toBe(9100);
  });

  it("revert sans sauvegarde : erreur 404 explicite", () => {
    const fx = fixture();
    try {
      fx.store.revert();
      throw new Error("aurait dû lever");
    } catch (error) {
      expect(error).toBeInstanceOf(EngineConfigError);
      expect((error as EngineConfigError).status).toBe(404);
      expect((error as EngineConfigError).code).toBe("no_backup");
    }
  });

  it("revert refuse une sauvegarde JSON invalide", () => {
    const fx = fixture();
    writeFileSync(join(fx.configDir, "server.json"), JSON.stringify({ models: [] }), "utf8");
    writeFileSync(join(fx.configDir, "server.json.bak"), "{ cassé", "utf8");
    expect(() => fx.store.revert()).toThrowError(EngineConfigError);
  });
});

describe("état des montages et scan disque", () => {
  it("signale le dossier config monté/inscriptible, et l'absence du sous-dossier de téléchargement", () => {
    const fx = fixture();
    const mounts = fx.store.mountState();
    expect(mounts.config.exists).toBe(true);
    expect(mounts.config.writable).toBe(true);
    // Inscriptible → aucune cause d'échec exposée (ni code ni hint).
    expect(mounts.config.code).toBeNull();
    expect(fx.store.report().writeCode).toBeNull();
    expect(fx.store.report().writeHint).toBeNull();
    expect(mounts.modelsWrite.exists).toBe(false);
  });

  it("dérive le chemin d'écriture en SOUS-DOSSIER du montage modèles (convention)", () => {
    const fx = fixture();
    // Non configurable : toujours `<models>/downloads` (convention d'organisation).
    expect(fx.store.modelsWriteDir).toBe(join(fx.modelsDir, "downloads"));
    expect(fx.store.mountState().modelsWrite.dir).toBe(join(fx.modelsDir, "downloads"));
    // Le sous-dossier est traduit vers la vue moteur (même préfixe `/models`).
    expect(fx.store.toEnginePath(join(fx.modelsDir, "downloads", "id", "model.gguf"))).toBe(
      "/models/downloads/id/model.gguf",
    );
    // Hors du montage modèles : jamais traduisible.
    expect(fx.store.toEnginePath("/ailleurs/x.gguf")).toBeNull();
  });

  it("ne liste pas deux fois les .gguf sous le sous-dossier d'écriture", () => {
    const fx = fixture();
    mkdirSync(join(fx.modelsDir, "downloads", "id"), { recursive: true });
    writeFileSync(join(fx.modelsDir, "downloads", "id", "model.gguf"), "gguf");
    writeFileSync(join(fx.modelsDir, "installe.gguf"), "gguf");
    const paths = fx.store.report().diskModels.map((m) => m.enginePath);
    expect(paths).toEqual([...new Set(paths)]);
    expect(paths).toContain("/models/downloads/id/model.gguf");
    expect(paths).toContain("/models/installe.gguf");
  });

  it("refuse l'écriture quand le dossier de config n'est pas monté", () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-engine-config-"));
    tempDirs.push(root);
    const store = new EngineConfigStore({
      configDir: join(root, "absent"),
      engineConfigDir: "/config",
      modelsDir: join(root, "models"),
      engineModelsDir: "/models",
    });
    try {
      store.applyPatch({ models: [validModel()] });
      throw new Error("aurait dû lever");
    } catch (error) {
      expect((error as EngineConfigError).code).toBe("config_dir_not_mounted");
      expect((error as EngineConfigError).status).toBe(503);
    }
  });

  it("liste les .gguf présents et vérifie l'existence des chemins déclarés", () => {
    const fx = fixture();
    mkdirSync(join(fx.modelsDir, "Chatterbox-GGUF"), { recursive: true });
    writeFileSync(join(fx.modelsDir, "Chatterbox-GGUF", "chatterbox.gguf"), "gguf");
    writeConfig(fx, {
      models: [
        validModel({ path: "/models/Chatterbox-GGUF/chatterbox.gguf" }),
        validModel({
          id: "absent",
          family: "kokoro_tts",
          mode: "streaming",
          path: "/models/manquant.gguf",
        }),
        validModel({
          id: "hors-montage",
          family: "kokoro_tts",
          mode: "streaming",
          path: "/autre/modele.gguf",
        }),
      ],
    });
    const report = fx.store.report();
    expect(report.diskModels.map((m) => m.enginePath)).toContain(
      "/models/Chatterbox-GGUF/chatterbox.gguf",
    );
    const byId = Object.fromEntries(report.models.map((m) => [m.id, m]));
    expect(byId.chatterbox?.pathStatus).toBe("exists");
    expect(byId.absent?.pathStatus).toBe("missing");
    expect(byId["hors-montage"]?.pathStatus).toBe("unverifiable");
  });

  it("ne crée jamais le dossier de config lors d'une lecture", () => {
    const root = mkdtempSync(join(tmpdir(), "yuki-engine-config-"));
    tempDirs.push(root);
    const absent = join(root, "absent");
    const store = new EngineConfigStore({
      configDir: absent,
      engineConfigDir: "/config",
      modelsDir: join(root, "models"),
      engineModelsDir: "/models",
    });
    store.report();
    expect(existsSync(absent)).toBe(false);
  });
});
