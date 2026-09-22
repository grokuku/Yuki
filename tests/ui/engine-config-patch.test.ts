/**
 * Tests unitaires — logique PURE de la configuration du moteur (Lot 9),
 * `public/ui/engine-config-patch.js`.
 *
 * Vérifie : les listes fermées (l'éditeur EMPÊCHE `clone`, mode invalide et
 * `offline` imposé), la construction du patch structuré, les messages d'erreur
 * et l'état « redémarrage nécessaire ». Aucun DOM, aucun réseau.
 */

import { describe, expect, it } from "vitest";

import {
  applicationState,
  buildEnginePatch,
  describeCapabilities,
  describeEngineConfig,
  describeEngineConfigError,
  hasEngineChanges,
  restartProcedure,
  validateModelDraft,
} from "../../public/ui/engine-config-patch.js";

describe("validateModelDraft — l'éditeur empêche les erreurs connues", () => {
  it("refuse `clone`, accepte `clon`", () => {
    const bad = validateModelDraft({
      id: "chatterbox",
      family: "chatterbox",
      task: "clone",
      mode: "offline",
      path: "/models/x.gguf",
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.task).toContain("clon");

    const good = validateModelDraft({
      id: "chatterbox",
      family: "chatterbox",
      task: "clon",
      mode: "offline",
      path: "/models/x.gguf",
    });
    expect(good.ok).toBe(true);
  });

  it("refuse un mode invalide", () => {
    const result = validateModelDraft({
      id: "chatterbox",
      family: "chatterbox",
      task: "clon",
      mode: "batch",
      path: "/models/x.gguf",
    });
    expect(result.errors.mode).toBeTruthy();
  });

  it("impose `offline` à chatterbox et cosyvoice3", () => {
    for (const family of ["chatterbox", "cosyvoice3"]) {
      const result = validateModelDraft({
        id: family,
        family,
        task: "clon",
        mode: "streaming",
        path: "/models/x.gguf",
      });
      expect(result.errors.mode, family).toMatch(/offline/);
    }
  });

  it("refuse une famille inconnue, un chemin non gguf et un id vide", () => {
    expect(
      validateModelDraft({ id: "x", family: "zorg", task: "clon", mode: "offline", path: "/models/x.gguf" })
        .errors.family,
    ).toBeTruthy();
    expect(
      validateModelDraft({ id: "x", family: "kokoro", task: "clon", mode: "offline", path: "/models/x.bin" })
        .errors.path,
    ).toBeTruthy();
    expect(
      validateModelDraft({ id: "", family: "kokoro", task: "clon", mode: "offline", path: "/models/x.gguf" })
        .errors.id,
    ).toBeTruthy();
  });
});

describe("buildEnginePatch — patch structuré, jamais le JSON complet", () => {
  it("normalise les modèles en chaînes et n'ajoute que les globales modifiées", () => {
    const patch = buildEnginePatch({
      models: [
        { id: " chatterbox ", family: "chatterbox", task: "clon", mode: "offline", path: "/models/x.gguf" },
      ],
      globals: { port: "9000", host: "0.0.0.0", lazy_load: true },
      originalGlobals: { host: "0.0.0.0", port: 8081, lazy_load: false },
    });
    expect(patch.models[0].id).toBe("chatterbox");
    expect(patch.globals).toEqual({ port: 9000, lazy_load: true });
  });

  it("une globale vidée devient null (retirer la clé)", () => {
    const patch = buildEnginePatch({
      globals: { max_loaded_models: "" },
      originalGlobals: { max_loaded_models: 2 },
    });
    expect(patch.globals).toEqual({ max_loaded_models: null });
  });

  it("patch vide quand rien n'a changé", () => {
    const patch = buildEnginePatch({
      globals: { host: "0.0.0.0" },
      originalGlobals: { host: "0.0.0.0" },
    });
    expect(patch).toEqual({});
    expect(hasEngineChanges({ globals: { host: "0.0.0.0" }, originalGlobals: { host: "0.0.0.0" } })).toBe(
      false,
    );
  });
});

describe("applicationState / restartProcedure — honnêteté du redémarrage", () => {
  it("id déjà déclaré → activable sans redémarrer", () => {
    const state = applicationState(["chatterbox", "cosyvoice3"], "cosyvoice3");
    expect(state.declared).toBe(true);
    expect(state.restartNeeded).toBe(false);
    expect(state.label).toMatch(/sans redémarrage/);
  });

  it("id non déclaré → redémarrage requis, avec la procédure exacte", () => {
    const state = applicationState(["chatterbox"], "cosyvoice3");
    expect(state.declared).toBe(false);
    expect(state.restartNeeded).toBe(true);
    expect(state.label).toMatch(/redémarrage/i);
    expect(restartProcedure("yuki-tts")).toMatch(/UI Docker/);
    expect(restartProcedure("yuki-tts")).toMatch(/yuki-tts/);
    expect(restartProcedure()).toMatch(/docker compose restart tts/);
  });
});

describe("describeEngineConfig — état de montage honnête", () => {
  it("non monté → message + montage désactivé, jamais « prêt »", () => {
    const view = describeEngineConfig({ mounted: false, configDir: "/data/tts-config" });
    expect(view.kind).toBe("not-mounted");
    expect(view.message).toContain("/data/tts-config");
    expect(view.message).toMatch(/monté/);
  });

  it("monté mais non inscriptible → read-only", () => {
    const view = describeEngineConfig({ mounted: true, writable: false });
    expect(view.kind).toBe("read-only");
    expect(view.message).toMatch(/inscriptible/);
  });

  it("monté, inscriptible, sans fichier → no-file (création à l'enregistrement)", () => {
    const view = describeEngineConfig({ mounted: true, writable: true, fileExists: false });
    expect(view.kind).toBe("no-file");
  });

  it("fichier invalide → invalid avec la cause", () => {
    const view = describeEngineConfig({
      mounted: true,
      writable: true,
      fileExists: true,
      valid: false,
      parseError: "JSON invalide : Unexpected token",
    });
    expect(view.kind).toBe("invalid");
    expect(view.message).toContain("Unexpected token");
  });

  it("prêt → kind ready, conserve modèles/globales/clés inconnues", () => {
    const view = describeEngineConfig({
      mounted: true,
      writable: true,
      fileExists: true,
      valid: true,
      backupExists: true,
      globals: { port: 8081 },
      models: [{ id: "chatterbox" }],
      unknownTopLevelKeys: ["cors_origins"],
    });
    expect(view.kind).toBe("ready");
    expect(view.globals.port).toBe(8081);
    expect(view.backupExists).toBe(true);
    expect(view.unknownTopLevelKeys).toContain("cors_origins");
  });
});

describe("describeEngineConfigError — cause réelle, jamais générique", () => {
  it("invalid_engine_config : expose le détail champ par champ", () => {
    const described = describeEngineConfigError({
      status: 400,
      data: {
        code: "invalid_engine_config",
        message: "Configuration refusée.",
        fields: [{ path: "models[0].task", code: "invalid_task", message: "Jeton « clone » refusé." }],
      },
    });
    expect(described.message).toBe("Configuration refusée.");
    expect(described.fields[0]?.path).toBe("models[0].task");
  });

  it("config_dir_not_mounted : reprend le message du serveur", () => {
    const described = describeEngineConfigError({
      status: 503,
      data: { code: "config_dir_not_mounted", message: "Dossier non monté." },
    });
    expect(described.message).toContain("non monté");
  });

  it("no_backup et 403 (garde-fous) sont nommés", () => {
    expect(describeEngineConfigError({ status: 404, data: { code: "no_backup" } }).message).toMatch(
      /sauvegarde/i,
    );
    expect(
      describeEngineConfigError({ status: 403, data: { code: "missing_config_header", message: "refusé" } })
        .message,
    ).toMatch(/refusé/i);
  });

  it("erreur réseau : ne prétend pas connaître une cause serveur", () => {
    const described = describeEngineConfigError({ status: 0 });
    expect(described.message).toMatch(/injoignable/i);
  });
});

describe("describeCapabilities — la fonction n'apparaît que si CONFIRMÉE", () => {
  it("absente (404 → unloadModels:false) → masquée", () => {
    expect(describeCapabilities({ unloadModels: false, probeStatus: 404 }).show).toBe(false);
  });
  it("indéterminée (null) → masquée", () => {
    expect(describeCapabilities({ unloadModels: null, reachable: false }).show).toBe(false);
    expect(describeCapabilities(null).show).toBe(false);
  });
  it("confirmée → affichée", () => {
    expect(describeCapabilities({ unloadModels: true, probeStatus: 200 }).show).toBe(true);
  });
});
