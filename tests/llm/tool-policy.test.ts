import { describe, expect, it } from "vitest";

import {
  FORBIDDEN_TOOLS,
  HEAVY_PROVIDER,
  HEAVY_MODEL,
  LIGHT_PROVIDER,
  LIGHT_MODEL,
  PROVIDERS,
  AGENT_DIRECTORY_TOOLS,
  HERITAGE_TOOLS,
  LIBRARIAN_TOOLS,
  SECRET_DIRECTORY_TOOLS,
  SECRET_REQUEST_TOOLS,
  buildModelsConfigFrom,
  DEFAULT_EFFECTIVE_LLM_CONFIG,
  containsForbiddenTool,
  toolAllowlist,
} from "../../src/llm/index.js";
import { readFileSync } from "node:fs";

describe("llm — providers & modèles", () => {
  it("associe chaque rôle à un provider DISTINCT (nommage neutre, deux clés)", () => {
    expect(PROVIDERS.light.id).toBe("llm-light");
    expect(PROVIDERS.heavy.id).toBe("llm-heavy");
    expect(PROVIDERS.light.id).not.toBe(PROVIDERS.heavy.id);
    expect(PROVIDERS.light.keyEnv).toBe("YUKI_LLM_LIGHT_API_KEY");
    expect(PROVIDERS.heavy.keyEnv).toBe("YUKI_LLM_HEAVY_API_KEY");
    expect(PROVIDERS.light.baseUrl).toBe(PROVIDERS.heavy.baseUrl);
    expect(PROVIDERS.light.baseUrl).toBe("https://ollama.com/v1");
    expect(LIGHT_PROVIDER.maxConcurrentRequests).toBe(1);
    expect(HEAVY_PROVIDER.maxConcurrentRequests).toBe(3);
  });

  it("LIGHT_MODEL est gemma4:31b sans thinking; HEAVY_MODEL a le thinkingLevelMap validé", () => {
    expect(LIGHT_MODEL.id).toBe("gemma4:31b");
    expect(LIGHT_MODEL.reasoning).toBe(false);
    expect(LIGHT_MODEL.thinkingLevelMap).toBeUndefined();
    expect(LIGHT_MODEL.defaultThinking).toBe("off");

    expect(HEAVY_MODEL.id).toBe("deepseek-v4.1-flash");
    expect(HEAVY_MODEL.reasoning).toBe(true);
    expect(HEAVY_MODEL.thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    });
    expect(HEAVY_MODEL.defaultThinking).toBe("high");
  });

  it("buildModelsConfigFrom(défauts) correspond EXACTEMENT à config/pi/models.json", () => {
    const file = JSON.parse(
      readFileSync("config/pi/models.json", "utf8"),
    ) as unknown;
    const config = buildModelsConfigFrom(DEFAULT_EFFECTIVE_LLM_CONFIG);
    expect(file).toEqual(config);
    // Aucune clé en clair : uniquement des références d'environnement.
    for (const provider of Object.values(config.providers)) {
      expect(provider.apiKey.startsWith("$")).toBe(true);
    }
  });

  it("buildModelsConfigFrom reflète la config effective (baseUrl/api/modèle)", () => {
    const config = buildModelsConfigFrom({
      light: {
        api: "openai-completions",
        baseUrl: "https://light.example/v1",
        model: "small-model",
        thinking: "low",
      },
      heavy: {
        api: "openai-completions",
        baseUrl: "https://heavy.example/v1",
        model: "big-model",
        thinking: "high",
      },
    });
    expect(config.providers["llm-light"]?.baseUrl).toBe("https://light.example/v1");
    expect(config.providers["llm-light"]?.models[0]?.id).toBe("small-model");
    expect(config.providers["llm-heavy"]?.baseUrl).toBe("https://heavy.example/v1");
    expect(config.providers["llm-heavy"]?.models[0]?.id).toBe("big-model");
    expect(config.providers["llm-heavy"]?.models[0]?.thinkingLevelMap).toEqual(
      HEAVY_MODEL.thinkingLevelMap,
    );
    // Jamais de clé en clair : uniquement des références d'environnement.
    for (const provider of Object.values(config.providers)) {
      expect(provider.apiKey.startsWith("$")).toBe(true);
    }
  });
});

describe("llm — politique d'outils (garantie structurelle)", () => {
  it("le léger peut déléguer mais n'a JAMAIS write/bash/edit", () => {
    const tools = toolAllowlist("light");
    expect(tools).toContain("delegate");
    expect(tools).toContain("job_status");
    expect(tools).toContain("cancel_job");
    expect(tools).toEqual(
      expect.arrayContaining(["read", "ls", "grep", "find"]),
    );
    for (const forbidden of FORBIDDEN_TOOLS) {
      expect(tools).not.toContain(forbidden);
    }
    expect(containsForbiddenTool(tools)).toBe(false);
  });

  it("délégation désactivée → les outils de délégation ne sont pas exposés", () => {
    const tools = toolAllowlist("light", { delegationEnabled: false });
    expect(tools).toEqual(["read", "ls", "grep", "find"]);
  });

  it("le lourd n'a que les outils de lecture (pas de délégation)", () => {
    const tools = toolAllowlist("heavy");
    expect(tools).toEqual(["read", "ls", "grep", "find"]);
    expect(tools).not.toContain("delegate");
    expect(tools).not.toContain("job_status");
    expect(tools).not.toContain("cancel_job");
    expect(containsForbiddenTool(tools)).toBe(false);
  });

  it("détecte effectivement les outils interdits (garde-fou)", () => {
    expect(containsForbiddenTool(["read", "write"])).toBe(true);
    expect(containsForbiddenTool(["read", "bash"])).toBe(true);
  });

  it("INVERSION DES RÔLES : l'exécution n'est portée QUE par le worker LOURD", () => {
    // ⚠️ Le LÉGER n'a JAMAIS d'outil d'action, même si le câblage l'active :
    // Yuki lit et converse, elle n'agit pas.
    expect(toolAllowlist("light")).not.toContain("run_command");
    expect(toolAllowlist("light", { executionEnabled: true })).not.toContain("run_command");
    expect(toolAllowlist("light", { screenshotsEnabled: true })).not.toContain("capturer_ecran");

    // ⚠️ Le LOURD porte l'exécution, mais SEULEMENT quand elle est activée
    // (service d'exécution présent) : pas par défaut.
    expect(toolAllowlist("heavy")).not.toContain("run_command");
    const heavyExec = toolAllowlist("heavy", { executionEnabled: true });
    expect(heavyExec).toContain("run_command");
    // `run_command` n'est PAS un outil interdit : c'est le chemin sanctionné.
    expect(containsForbiddenTool(heavyExec)).toBe(false);

    // Capture d'écran : même inversion.
    expect(toolAllowlist("heavy")).not.toContain("capturer_ecran");
    const heavyShots = toolAllowlist("heavy", { screenshotsEnabled: true });
    expect(heavyShots).toContain("capturer_ecran");
    expect(containsForbiddenTool(heavyShots)).toBe(false);
  });

  it("l'annuaire des agents reste au LÉGER, indépendamment de l'exécution", () => {
    expect(AGENT_DIRECTORY_TOOLS).toEqual(["lister_agents", "etat_agent"]);
    // Par défaut : non exposés.
    expect(toolAllowlist("light")).not.toContain("lister_agents");
    expect(toolAllowlist("light")).not.toContain("etat_agent");
    // Activés seuls : consultation sans exécution (consulter n'est pas exécuter).
    const withDir = toolAllowlist("light", { directoryEnabled: true });
    expect(withDir).toContain("lister_agents");
    expect(withDir).toContain("etat_agent");
    expect(withDir).not.toContain("run_command");
    // ⚠️ Même quand le câblage « active l'exécution », le léger reste sans
    // outil d'action : l'annuaire est bien la seule chose ajoutée.
    const lightAll = toolAllowlist("light", {
      executionEnabled: true,
      directoryEnabled: true,
    });
    expect(lightAll).toContain("lister_agents");
    expect(lightAll).toContain("etat_agent");
    expect(lightAll).not.toContain("run_command");
    // Le lourd n'a JAMAIS l'annuaire (il exécute, il ne converse pas).
    const heavyBoth = toolAllowlist("heavy", {
      executionEnabled: true,
      directoryEnabled: true,
    });
    expect(heavyBoth).toContain("run_command");
    expect(heavyBoth).not.toContain("lister_agents");
    expect(heavyBoth).not.toContain("etat_agent");
  });

  it("l'outil de consultation de l'archive « vie antérieure » (Lot 13) est en LECTURE SEULE", () => {
    expect(HERITAGE_TOOLS).toEqual(["archive_vie_anterieure"]);
    // Par défaut : non exposé.
    expect(toolAllowlist("light")).not.toContain("archive_vie_anterieure");
    const withHeritage = toolAllowlist("light", { heritageEnabled: true });
    expect(withHeritage).toContain("archive_vie_anterieure");
    expect(containsForbiddenTool(withHeritage)).toBe(false);
    // Le lourd n'a JAMAIS d'outil de consultation d'archive.
    expect(toolAllowlist("heavy", { heritageEnabled: true })).not.toContain(
      "archive_vie_anterieure",
    );
  });

  it("l'archive « vie antérieure » n'a AUCUN outil d'ÉCRITURE exposé au modèle", () => {
    // Le SEUL outil lié à l'archive est la consultation (lecture). L'édition
    // (interface) passe par `/api/self/heritage`, jamais par un outil.
    expect(HERITAGE_TOOLS).toEqual(["archive_vie_anterieure"]);
    const allTools = [
      ...toolAllowlist("light", { heritageEnabled: true, executionEnabled: true, directoryEnabled: true }),
      ...toolAllowlist("heavy", { heritageEnabled: true, executionEnabled: true, directoryEnabled: true }),
    ];
    for (const forbidden of [
      "write",
      "edit",
      "bash",
      "powershell",
      "ecrire_archive",
      "modifier_archive",
      "supprimer_archive",
      "heritage_write",
      "archive_write",
    ]) {
      expect(allTools, forbidden).not.toContain(forbidden);
    }
    expect(containsForbiddenTool(allTools)).toBe(false);
  });

  it("les outils de SECRET : consultation pour les deux rôles, DEMANDE pour le léger UNIQUEMENT", () => {
    expect(SECRET_DIRECTORY_TOOLS).toEqual(["lister_secrets"]);
    expect(SECRET_REQUEST_TOOLS).toEqual(["demander_secret"]);

    // Par défaut : aucun outil de secret exposé (coffre non initialisé).
    expect(toolAllowlist("light")).not.toContain("lister_secrets");
    expect(toolAllowlist("light")).not.toContain("demander_secret");

    // `lister_secrets` : les DEUX rôles (le lourd en a besoin pour écrire `${NOM}`).
    expect(toolAllowlist("light", { secretsEnabled: true })).toContain("lister_secrets");
    expect(toolAllowlist("heavy", { secretsEnabled: true })).toContain("lister_secrets");

    // `demander_secret` : le LÉGER seulement (c'est lui qui converse avec l'utilisateur).
    const lightRequest = toolAllowlist("light", { secretRequestsEnabled: true });
    expect(lightRequest).toContain("demander_secret");
    // ⚠️ Même si le câblage l'active sur le lourd, la politique l'en empêche.
    const heavyRequest = toolAllowlist("heavy", { secretRequestsEnabled: true });
    expect(heavyRequest).not.toContain("demander_secret");
    expect(containsForbiddenTool(lightRequest)).toBe(false);
  });

  it("les outils du LIBRAIRE ne sont exposés que s'ils sont activés, et aucun ne va chercher une page web", () => {
    expect(LIBRARIAN_TOOLS).toEqual([
      "recherche_libraire",
      "liste_libraire",
      "lire_libraire",
      "archive_libraire",
    ]);
    // Par défaut : non exposés (URL de base non renseignée).
    expect(toolAllowlist("light")).not.toContain("recherche_libraire");
    const withLibrarian = toolAllowlist("light", { librarianEnabled: true });
    for (const name of LIBRARIAN_TOOLS) expect(withLibrarian).toContain(name);
    expect(containsForbiddenTool(withLibrarian)).toBe(false);

    // ⚠️ AUCUN outil de fetch/HTTP générique : tout le web passe par le libraire.
    const allTools = [
      ...toolAllowlist("light", {
        librarianEnabled: true,
        executionEnabled: true,
        directoryEnabled: true,
        heritageEnabled: true,
      }),
      ...toolAllowlist("heavy", { librarianEnabled: true }),
    ];
    for (const forbidden of [
      "fetch",
      "http_get",
      "http_fetch",
      "web_fetch",
      "curl",
      "wget",
      "naviguer_web",
      "ouvrir_page",
    ]) {
      expect(allTools, forbidden).not.toContain(forbidden);
    }

    // Le lourd n'a JAMAIS les outils du libraire.
    const heavyLibrarian = toolAllowlist("heavy", { librarianEnabled: true });
    for (const name of LIBRARIAN_TOOLS) expect(heavyLibrarian).not.toContain(name);
  });
});
