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
  applyCatalogPrefill,
  applicationState,
  buildEnginePatch,
  describeCapabilities,
  describeEngineConfig,
  describeEngineConfigError,
  findCatalogFamilyIncoherence,
  hasEngineChanges,
  restartProcedure,
  setModelField,
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
      validateModelDraft({ id: "x", family: "kokoro_tts", task: "clon", mode: "offline", path: "/models/x.bin" })
        .errors.path,
    ).toBeTruthy();
    expect(
      validateModelDraft({ id: "", family: "kokoro_tts", task: "clon", mode: "offline", path: "/models/x.gguf" })
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

/* — Brouillon par ENTRÉE : aucune propagation d'une ligne à l'autre — */

describe("setModelField — édition d'UNE entrée, jamais des autres", () => {
  const draft = () => [
    { id: "chatterbox", family: "chatterbox", task: "clon", mode: "offline", path: "/models/a.gguf" },
    { id: "cosyvoice3", family: "cosyvoice3", task: "clon", mode: "offline", path: "/models/b.gguf" },
  ];

  it("modifie uniquement l'entrée ciblée et renvoie un NOUVEAU tableau", () => {
    const base = draft();
    const next = setModelField(base, 1, "family", "sanotts");
    expect(next).not.toBe(base);
    expect(next[1].family).toBe("sanotts");
    // L'autre entrée est INCHANGÉE (contenu ET référence non partagée).
    expect(next[0]).not.toBe(base[0]);
    expect(next[0]).toEqual(base[0]);
    // Le brouillon d'origine n'est jamais muté.
    expect(base[1].family).toBe("cosyvoice3");
  });

  it("index invalide → copie inchangée (jamais d'écriture ailleurs)", () => {
    const base = draft();
    expect(setModelField(base, 9, "family", "sanotts")[0].family).toBe("chatterbox");
    expect(setModelField(base, -1, "family", "sanotts")[1].family).toBe("cosyvoice3");
    expect(setModelField(base, 1.5, "family", "sanotts")[0].family).toBe("chatterbox");
  });
});

describe("applyCatalogPrefill — cible par `id`, pas par index", () => {
  const draft = () => [
    { id: "chatterbox", family: "chatterbox", task: "clon", mode: "offline", path: "/models/a.gguf" },
    { id: "cosyvoice3", family: "cosyvoice3", task: "clon", mode: "offline", path: "/models/b.gguf" },
  ];
  const qwen = {
    id: "qwen3-tts",
    family: "qwen3_tts",
    task: "tts",
    mode: "offline",
    path: "/models/downloads/qwen3-tts/model.gguf",
  };

  it("régression : déclarer Qwen n'altère PAS chatterbox/cosyvoice3", () => {
    const base = draft();
    const next = applyCatalogPrefill(base, qwen);
    expect(next).toHaveLength(3);
    expect(next[0]).toEqual(base[0]);
    expect(next[1]).toEqual(base[1]);
    expect(next[2]).toEqual(qwen);
    // Aucune entrée existante ne porte la famille du nouveau modèle.
    expect(next.filter((m) => m.family === "qwen3_tts")).toHaveLength(1);
  });

  it("cible l'entrée de MÊME id, même si elle n'est pas en tête", () => {
    const base = [
      { id: "chatterbox", family: "chatterbox", task: "clon", mode: "offline", path: "/models/a.gguf" },
      { id: "qwen3-tts", family: "chatterbox", task: "clon", mode: "offline", path: "/models/stale.gguf" },
    ];
    const next = applyCatalogPrefill(base, qwen);
    expect(next).toHaveLength(2);
    // Seule l'entrée `qwen3-tts` est corrigée.
    expect(next[1]).toEqual(qwen);
    expect(next[0]).toEqual(base[0]);
  });

  it("préserve les clés inconnues de l'entrée ciblée", () => {
    const base = [
      { id: "qwen3-tts", family: "chatterbox", task: "clon", mode: "offline", path: "/x.gguf", options: { a: 1 } },
    ];
    const next = applyCatalogPrefill(base, qwen);
    expect(next[0].family).toBe("qwen3_tts");
    expect((next[0] as Record<string, unknown>).options).toEqual({ a: 1 });
  });

  it("prefill sans `id` exploitable → brouillon inchangé", () => {
    const base = draft();
    expect(applyCatalogPrefill(base, { family: "qwen3_tts" })).toEqual(base);
    expect(applyCatalogPrefill(base, null)).toEqual(base);
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

  it("read-only EROFS → reprend le hint serveur (lecture seule), jamais « chown »", () => {
    const view = describeEngineConfig({
      mounted: true,
      writable: false,
      writeCode: "EROFS",
      writeHint:
        "Le volume « tts-config » (chemin « /data/tts-config ») est monté en " +
        "LECTURE SEULE. Retirez « :ro » du volume correspondant dans le service « gateway ».",
    });
    expect(view.kind).toBe("read-only");
    expect(view.message).toContain("EROFS");
    expect(view.message).toMatch(/LECTURE SEULE/);
    expect(view.message).not.toContain("chown");
  });

  it("read-only EACCES → reprend le hint serveur (permissions), chown attendu", () => {
    const view = describeEngineConfig({
      mounted: true,
      writable: false,
      writeCode: "EACCES",
      writeHint:
        "Permissions insuffisantes sur le volume « tts-config » (chemin « /data/tts-config ») : " +
        "sur un bind mount, donnez-le à l'uid/gid du conteneur (« chown 1000:1000 »).",
    });
    expect(view.message).toContain("EACCES");
    expect(view.message).toContain("chown 1000:1000");
    expect(view.message).not.toMatch(/LECTURE SEULE/);
  });

  it("read-only sans hint serveur → message honnête, aucune cause inventée", () => {
    const view = describeEngineConfig({ mounted: true, writable: false });
    expect(view.kind).toBe("read-only");
    expect(view.message).toMatch(/cause exacte/);
    expect(view.message).not.toContain("chown");
    expect(view.message).not.toMatch(/LECTURE SEULE/);
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

  it("prêt → conserve le signalement de cohérence par entrée (affiché par l'éditeur)", () => {
    const view = describeEngineConfig({
      mounted: true,
      writable: true,
      fileExists: true,
      valid: true,
      models: [
        {
          id: "chatterbox",
          family: "qwen3_tts",
          path: "/models/chatterbox-q8_0.gguf",
          coherenceIssues: [{ path: "models[0].family", code: "catalog_family_mismatch", message: "…" }],
        },
      ],
    });
    expect(view.kind).toBe("ready");
    expect(view.models[0].coherenceIssues).toHaveLength(1);
  });
});

describe("findCatalogFamilyIncoherence — refus côté client AVANT l'aller-retour", () => {
  const CATALOG = [
    {
      id: "chatterbox",
      family: "chatterbox",
      task: "clon",
      mode: "offline",
      enginePath: "/models/downloads/chatterbox/model.gguf",
      expectedFile: "chatterbox-q8_0.gguf",
      dir: "Chatterbox-GGUF",
    },
    {
      id: "qwen3-tts",
      family: "qwen3_tts",
      task: "tts",
      mode: "offline",
      enginePath: "/models/downloads/qwen3-tts/model.gguf",
      expectedFile: "qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf",
      dir: "Qwen3-TTS-12Hz-1.7B-Base-GGUF",
    },
  ];

  it("signale une famille incohérente sur un chemin manuel reconnu par le basename", () => {
    const issues = findCatalogFamilyIncoherence(
      [
        {
          id: "chatterbox",
          family: "qwen3_tts",
          task: "clon",
          mode: "offline",
          path: "/models/chatterbox-q8_0.gguf",
        },
      ],
      CATALOG,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("models[0].family");
    expect(issues[0]?.code).toBe("catalog_family_mismatch");
    expect(issues[0]?.message).toContain("chatterbox-q8_0.gguf");
    expect(issues[0]?.message).toContain("chatterbox");
    expect(issues[0]?.message).toContain("qwen3_tts");
  });

  it("reconnaît le basename SANS tenir compte de la casse", () => {
    const issues = findCatalogFamilyIncoherence(
      [{ id: "x", family: "chatterbox", path: "/models/Chatterbox-Q8_0.GGUF" }],
      CATALOG,
    );
    expect(issues).toHaveLength(0);
  });

  it("reconnaît le DOSSIER de téléchargement du catalogue", () => {
    const issues = findCatalogFamilyIncoherence(
      [{ id: "chatterbox", family: "qwen3_tts", path: "/models/downloads/chatterbox" }],
      CATALOG,
    );
    expect(issues).toHaveLength(1);
  });

  it("reconnaît le nom de dossier amont (dir)", () => {
    const issues = findCatalogFamilyIncoherence(
      [{ id: "x", family: "qwen3_tts", path: "/models/Chatterbox-GGUF" }],
      CATALOG,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain("chatterbox");
  });

  it("N'APPLIQUE PAS le refus à un chemin INCONNU (GGUF personnel)", () => {
    const issues = findCatalogFamilyIncoherence(
      [{ id: "perso", family: "kokoro_tts", path: "/models/mon-perso.gguf" }],
      CATALOG,
    );
    expect(issues).toHaveLength(0);
  });

  it("ne signale RIEN quand la famille correspond au catalogue", () => {
    const issues = findCatalogFamilyIncoherence(
      [{ id: "chatterbox", family: "chatterbox", path: "/models/chatterbox-q8_0.gguf" }],
      CATALOG,
    );
    expect(issues).toHaveLength(0);
  });

  it("sans catalogue chargé (liste vide) : aucun refus (le serveur garde la main)", () => {
    const issues = findCatalogFamilyIncoherence(
      [{ id: "chatterbox", family: "qwen3_tts", path: "/models/chatterbox-q8_0.gguf" }],
      [],
    );
    expect(issues).toHaveLength(0);
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
