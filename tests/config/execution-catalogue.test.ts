/**
 * EXÉCUTION DEPUIS LE CATALOGUE — LOT B (2026-11-19).
 *
 * Ce que ce fichier verrouille (⚠️ ces assertions ÉCHOUENT sur l'arbre d'origine :
 * `src/llm/execution.ts`, `llm.defaut.*` et `llm.bot.*` n'existent pas) :
 *
 *  ① `llm.defaut.light|heavy|vision` sont initialisés depuis le CATALOGUE MIGRÉ
 *    (point CRITIQUE : sans ça, tous les bots perdent leur modèle à la bascule) ;
 *  ② un bot SANS surcharge utilise le défaut d'instance (test central) ;
 *  ③ un bot AVEC surcharge utilise le sien, et le défaut n'est pas écrasé ;
 *  ④ deux bots, deux modèles ⇒ `models.json` porte les DEUX providers réels ;
 *  ⑤ un `modeleId` inconnu (ou un modèle supprimé) ⇒ DÉGRADÉ EXPLICITE, lisible et
 *    journalisable, jamais un plantage, jamais un modèle inventé ;
 *  ⑥ la RÉFLEXION vient du MODÈLE (changer `thinking` change `models.json`) ;
 *  ⑦ la clé du FOURNISSEUR est utilisée (`$YUKI_LLM_FOURNISSEUR_<ID>_API_KEY`) ;
 *  ⑧ les anciennes clés présentes ⇒ reprises + AVERTISSEMENT `llm.anciennes_cles_ignees`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv } from "../../src/config/env.js";
import { createConfigRuntime, type ConfigRuntime } from "../../src/config/runtime.js";
import { ConfigStore } from "../../src/config/store.js";
import { CONFIG_SCHEMA } from "../../src/config/schema.js";
import {
  migrerCatalogue,
  reprendreDefautsDepuisRoles,
  type FournisseurLlm,
  type ModeleLlm,
} from "../../src/llm/catalogue.js";
import { planifierExecution, rolesDegrades } from "../../src/llm/execution.js";
import { llmRouting } from "../../src/llm/routing.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeRuntime(initial?: Record<string, string>): {
  runtime: ConfigRuntime;
  storePath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "yuki-execution-"));
  tempDirs.push(root);
  const storePath = join(root, "state", "config.json");
  const store = new ConfigStore(storePath);
  if (initial !== undefined) store.write(initial);
  const env = loadEnv({
    YUKI_MOUNT_STATE: join(root, "state"),
    YUKI_CONFIG_STORE_PATH: storePath,
    YUKI_PI_SYSTEM_PROMPT: join(root, "light.md"),
    YUKI_PI_HEAVY_SYSTEM_PROMPT: join(root, "heavy.md"),
  });
  const runtime = createConfigRuntime({
    env,
    store,
    processEnv: {},
    promptDefaults: { light: "prompt léger", heavy: "prompt lourd" },
  });
  return { runtime, storePath };
}

const OLLAMA: FournisseurLlm = {
  id: "ollama-com",
  nom: "ollama.com",
  baseUrl: "https://ollama.com/v1",
  api: "openai-completions",
};
const LOCAL: FournisseurLlm = {
  id: "local",
  nom: "Local",
  baseUrl: "https://local.exemple.fr/v1",
  api: "openai-completions",
};
const CHAT: ModeleLlm = {
  id: "gemma4-31b",
  nom: "gemma4:31b",
  fournisseurId: "ollama-com",
  contexte: 131_072,
  vision: true,
  thinking: "off",
};
const CODE: ModeleLlm = {
  id: "deepseek-v4-1-flash",
  nom: "deepseek-v4.1-flash",
  fournisseurId: "ollama-com",
  contexte: 131_072,
  vision: true,
  thinking: "high",
};
const VISION: ModeleLlm = {
  id: "qwen-vl",
  nom: "qwen-vl",
  fournisseurId: "local",
  contexte: 32_768,
  vision: true,
  thinking: "off",
};
const AVEUGLE: ModeleLlm = {
  id: "code-aveugle",
  nom: "code-aveugle",
  fournisseurId: "local",
  contexte: 32_768,
  vision: false,
  thinking: "medium",
};

const HERITAGE = {
  "llm.light.baseUrl": "https://ollama.com/v1",
  "llm.light.model": "gemma4:31b",
  "llm.light.thinking": "off",
  "llm.light.vision": "oui",
  "llm.light.apiKey": "sk-light-123456789",
  "llm.heavy.baseUrl": "https://ollama.com/v1",
  "llm.heavy.model": "deepseek-v4.1-flash",
  "llm.heavy.thinking": "high",
  "llm.heavy.vision": "oui",
  "llm.heavy.apiKey": "sk-heavy-987654321",
  "llm.vision.baseUrl": "https://local.exemple.fr/v1",
  "llm.vision.model": "qwen-vl",
  "llm.vision.thinking": "off",
  "llm.vision.apiKey": "sk-vision-abcdef",
} as const;

/** Enregistre un catalogue complet (2 fournisseurs, 4 modèles). */
function installerCatalogue(
  runtime: ConfigRuntime,
  modeles: ModeleLlm[] = [CHAT, CODE, VISION, AVEUGLE],
): void {
  runtime.update({
    "llm.fournisseurs": JSON.stringify([OLLAMA, LOCAL]),
    "llm.modeles": JSON.stringify(modeles),
    "llm.fournisseur.local.apiKey": "sk-local-abcdef",
    "llm.fournisseur.ollama-com.apiKey": "sk-ollama-123456",
  });
}

describe("① les défauts de rôle sont posés par la reprise du catalogue", () => {
  it("installation existante : `llm.defaut.*` = le modèle repris de chaque rôle", () => {
    const { runtime } = makeRuntime({ ...HERITAGE });
    reprendreDefautsDepuisRoles(runtime, () => {});
    migrerCatalogue(runtime, () => {});

    const modeles = runtime.modeles();
    expect(modeles.map((modele) => modele.nom)).toEqual([
      "gemma4:31b",
      "deepseek-v4.1-flash",
      "qwen-vl",
    ]);
    // ⚠️ POINT CRITIQUE : sans ces trois défauts, TOUS les bots perdraient leur
    // modèle au premier démarrage après la bascule sur le catalogue.
    expect(runtime.getString("llm.defaut.light")).toBe(modeles[0]?.id);
    expect(runtime.getString("llm.defaut.heavy")).toBe(modeles[1]?.id);
    expect(runtime.getString("llm.defaut.vision")).toBe(modeles[2]?.id);
    // Et l'exécution les résout réellement.
    const routing = llmRouting(runtime);
    expect(routing.models.light.reference).toBe("ollama-com/gemma4:31b");
    expect(routing.models.heavy.reference).toBe("ollama-com/deepseek-v4.1-flash");
    // ⚠️ Le fournisseur du repli est nommé d'après son ADRESSE (`local.exemple.fr`),
    // pas d'après un identifiant saisi : la reprise n'invente rien.
    expect(routing.visionReference).toBe("local-exemple-fr/qwen-vl");
    expect(routing.degrade).toEqual([]);
  });

  it("catalogue DÉJÀ rempli mais défauts vides : les valeurs par rôle sont reportées", () => {
    const { runtime } = makeRuntime({
      ...HERITAGE,
      "llm.catalogueMigre": "oui",
      "llm.fournisseurs": JSON.stringify([OLLAMA, LOCAL]),
      "llm.modeles": JSON.stringify([CHAT, CODE, VISION]),
    });
    const journal: Array<{ evenement: string; donnees: Record<string, unknown> }> = [];
    reprendreDefautsDepuisRoles(runtime, (evenement, donnees) => journal.push({ evenement, donnees }));
    expect(runtime.getString("llm.defaut.light")).toBe("gemma4-31b");
    expect(runtime.getString("llm.defaut.heavy")).toBe("deepseek-v4-1-flash");
    expect(runtime.getString("llm.defaut.vision")).toBe("qwen-vl");
    // ⚠️ L'avertissement nomme les anciens réglages, une fois : ils n'agissent plus.
    const avertissement = journal.find((entree) => entree.evenement === "llm.anciennes_cles_ignorees");
    expect(avertissement).toBeDefined();
    expect(JSON.stringify(avertissement?.donnees)).toContain("llm.light.model");
  });

  it("un défaut DÉJÀ choisi par l'utilisateur n'est jamais écrasé", () => {
    const { runtime } = makeRuntime({
      ...HERITAGE,
      "llm.fournisseurs": JSON.stringify([OLLAMA, LOCAL]),
      "llm.modeles": JSON.stringify([CHAT, CODE, VISION]),
      "llm.defaut.heavy": "qwen-vl",
    });
    reprendreDefautsDepuisRoles(runtime, () => {});
    expect(runtime.getString("llm.defaut.heavy")).toBe("qwen-vl");
  });
});

describe("②③ résolution : bot → défaut d'instance → dégradé", () => {
  it("un bot SANS surcharge utilise le défaut de l'instance", () => {
    const { runtime } = makeRuntime();
    installerCatalogue(runtime);
    runtime.update({ "llm.defaut.light": "gemma4-31b", "llm.defaut.heavy": "deepseek-v4-1-flash" });
    const routing = llmRouting(runtime, "autre");
    expect(routing.models.light.reference).toBe("ollama-com/gemma4:31b");
    expect(routing.models.heavy.reference).toBe("ollama-com/deepseek-v4.1-flash");
    expect(routing.provenance.light).toBe("defaut");
  });

  it("un bot AVEC surcharge utilise la sienne, et le défaut n'est pas écrasé", () => {
    const { runtime } = makeRuntime();
    installerCatalogue(runtime);
    runtime.update({ "llm.defaut.light": "gemma4-31b", "llm.defaut.heavy": "deepseek-v4-1-flash" });
    runtime.updatePour("autre", { "llm.bot.light": "code-aveugle" }, { portee: "bot" });

    const autre = llmRouting(runtime, "autre");
    expect(autre.models.light.reference).toBe("local/code-aveugle");
    expect(autre.provenance.light).toBe("bot");
    // Le défaut d'instance est intact et continue de servir les autres bots.
    expect(runtime.getString("llm.defaut.light")).toBe("gemma4-31b");
    expect(llmRouting(runtime).models.light.reference).toBe("ollama-com/gemma4:31b");
    // ⚠️ La VISION suit le MODÈLE choisi : ce bot n'a plus la vision sur le léger.
    expect(autre.effective.light.vision).toBe(false);
  });

  it("un `modeleId` INTROUVABLE ⇒ dégradé explicite (jamais un modèle inventé)", () => {
    const { runtime } = makeRuntime();
    installerCatalogue(runtime);
    runtime.update({ "llm.defaut.light": "gemma4-31b" });
    // Surcharge écrite à la main dans l'overlay : le serveur refuse ce chemin, mais
    // un store édité hors interface ne doit jamais faire planter le démarrage.
    runtime.updatePour("autre", { "llm.bot.light": "gemma4-31b" }, { portee: "bot" });
    runtime.update({ "llm.modeles": JSON.stringify([CODE, VISION, AVEUGLE]) });
    const routing = llmRouting(runtime, "autre");
    expect(routing.degrade).toEqual([
      { role: "light", code: "modele_introuvable", modeleId: "gemma4-31b" },
      { role: "heavy", code: "aucun_modele", modeleId: "" },
    ]);
    // Aucune invention : la référence est VIDE, le contexte reste borné.
    expect(routing.models.light.reference).toBe("");
    expect(routing.models.light.id).toBe("");
    expect(routing.effective.light.model).toBe("");
    // Le rôle lourd n'avait pas de défaut dans ce cas : il reste en dégradé
    // « aucun modèle » — deux états DISTINCTS, jamais confondus.
    expect(routing.degrade[1]).toEqual({ role: "heavy", code: "aucun_modele", modeleId: "" });
  });

  it("aucun défaut et aucune surcharge ⇒ le rôle est en dégradé, la vision n'en est pas un", () => {
    const { runtime } = makeRuntime();
    installerCatalogue(runtime);
    const routing = llmRouting(runtime);
    expect(routing.degrade).toEqual([
      { role: "light", code: "aucun_modele", modeleId: "" },
      { role: "heavy", code: "aucun_modele", modeleId: "" },
    ]);
    // ⚠️ « Aucun modèle de vision » est un état NORMAL (pas de repli), pas un dégradé.
    expect(routing.visionReference).toBe("");
    expect(routing.visionConfiguree).toBe(false);
  });

  it("un modèle qui pointe un fournisseur disparu est dégradé NOMMÉ", () => {
    const plan = planifierExecution({
      fournisseurs: [OLLAMA],
      modeles: [CHAT, VISION],
      defauts: { light: "", heavy: "", vision: "qwen-vl" },
      bot: { light: "gemma4-31b", heavy: "", vision: "" },
    });
    expect(plan.roles.vision.degrade).toEqual({
      code: "fournisseur_introuvable",
      modeleId: "qwen-vl",
    });
    expect(rolesDegrades(plan)).toEqual([
      { role: "heavy", code: "aucun_modele", modeleId: "" },
      { role: "vision", code: "fournisseur_introuvable", modeleId: "qwen-vl" },
    ]);
  });
});

describe("④ deux bots, deux modèles ⇒ un seul models.json qui porte les deux", () => {
  it("les providers réels des deux modèles sont écrits, avec leur adresse", () => {
    const { runtime } = makeRuntime();
    installerCatalogue(runtime);
    runtime.update({ "llm.defaut.light": "gemma4-31b", "llm.defaut.heavy": "qwen-vl" });
    runtime.updatePour("autre", { "llm.bot.light": "code-aveugle" }, { portee: "bot" });

    const pile = llmRouting(runtime);
    const autre = llmRouting(runtime, "autre");
    // Un SEUL fichier, partagé par tous les bots.
    expect(autre.file).toEqual(pile.file);
    expect(Object.keys(pile.file.providers).sort()).toEqual(["local", "ollama-com"]);
    expect(pile.file.providers["ollama-com"]?.baseUrl).toBe("https://ollama.com/v1");
    expect(pile.file.providers["local"]?.baseUrl).toBe("https://local.exemple.fr/v1");
    // Le fichier porte TOUS les modèles du catalogue (une sélection d'un autre bot
    // doit rester résoluble).
    expect(pile.file.providers["local"]?.models.map((modele) => modele.id)).toEqual([
      "qwen-vl",
      "code-aveugle",
    ]);
    expect(pile.models.light.reference).toBe("ollama-com/gemma4:31b");
    expect(pile.models.heavy.reference).toBe("local/qwen-vl");
    expect(autre.models.light.reference).toBe("local/code-aveugle");
  });
});

describe("⑤ la réflexion et la vision viennent du MODÈLE", () => {
  it("changer le `thinking` du modèle change models.json (même sélection)", () => {
    const { runtime } = makeRuntime();
    installerCatalogue(runtime, [CHAT, CODE, VISION, AVEUGLE]);
    runtime.update({ "llm.defaut.light": "code-aveugle" });
    const avant = llmRouting(runtime);
    expect(avant.effective.light.thinking).toBe("medium");
    expect(avant.file.providers["local"]?.models.find((m) => m.id === "code-aveugle")?.reasoning).toBe(true);

    // Le MODÈLE change de réflexion : la sélection, elle, ne bouge pas.
    runtime.update({
      "llm.modeles": JSON.stringify([CHAT, CODE, VISION, { ...AVEUGLE, thinking: "off" }]),
    });
    const apres = llmRouting(runtime);
    expect(apres.effective.light.thinking).toBe("off");
    expect(apres.file.providers["local"]?.models.find((m) => m.id === "code-aveugle")?.reasoning).toBe(false);
    expect(apres.effective.light.model).toBe("code-aveugle");
  });

  it("la VISION du modèle produit `input` : déclaration du MODÈLE, pas du rôle", () => {
    const { runtime } = makeRuntime();
    installerCatalogue(runtime, [CHAT, CODE, VISION, AVEUGLE]);
    runtime.update({ "llm.defaut.light": "code-aveugle", "llm.defaut.heavy": "code-aveugle" });
    const avecAveugle = llmRouting(runtime);
    expect(avecAveugle.effective.light.vision).toBe(false);
    expect(avecAveugle.file.providers["local"]?.models.find((m) => m.id === "code-aveugle")?.input).toEqual([
      "text",
    ]);
    // Le même modèle déclaré voyant change les DEUX rôles qui l'utilisent.
    runtime.update({
      "llm.modeles": JSON.stringify([CHAT, CODE, VISION, { ...AVEUGLE, vision: true }]),
    });
    const apres = llmRouting(runtime);
    expect(apres.effective.light.vision).toBe(true);
    expect(apres.effective.heavy.vision).toBe(true);
    expect(apres.file.providers["local"]?.models.find((m) => m.id === "code-aveugle")?.input).toEqual([
      "text",
      "image",
    ]);
  });
});

describe("⑥ la clé du fournisseur est UTILISÉE (jamais écrite)", () => {
  it("models.json référence la variable du fournisseur, et le pont l'alimente", () => {
    const { runtime } = makeRuntime();
    installerCatalogue(runtime);
    runtime.update({ "llm.defaut.light": "gemma4-31b" });
    const routing = llmRouting(runtime);
    expect(routing.file.providers["ollama-com"]?.apiKey).toBe(
      "$YUKI_LLM_FOURNISSEUR_OLLAMA_COM_API_KEY",
    );
    // Aucune clé en clair dans le fichier dérivé.
    expect(JSON.stringify(routing.file)).not.toContain("sk-ollama-123456");
    // Le pont l'a reflétée dans l'environnement (c'est là que le SDK la lit).
    expect((runtime as unknown as { processEnv: NodeJS.ProcessEnv }).processEnv
      .YUKI_LLM_FOURNISSEUR_OLLAMA_COM_API_KEY).toBe("sk-ollama-123456");
  });
});

describe("⑦ hot reload : la signature suit le catalogue ET les sélections", () => {
  it("changer un modèle du catalogue, un défaut ou une surcharge change la signature", async () => {
    const { signatureRouting } = await import("../../src/llm/routing.js");
    const { runtime } = makeRuntime();
    installerCatalogue(runtime);
    runtime.update({ "llm.defaut.light": "gemma4-31b" });
    const initiale = signatureRouting(llmRouting(runtime));
    // ① un modèle du catalogue (réflexion).
    runtime.update({ "llm.modeles": JSON.stringify([{ ...CHAT, thinking: "high" }, CODE, VISION, AVEUGLE]) });
    const apresModele = signatureRouting(llmRouting(runtime));
    expect(apresModele).not.toBe(initiale);
    // ② un défaut d'instance.
    runtime.update({ "llm.defaut.heavy": "deepseek-v4-1-flash" });
    const apresDefaut = signatureRouting(llmRouting(runtime));
    expect(apresDefaut).not.toBe(apresModele);
    // ③ la surcharge d'un AUTRE bot ne change que SA signature.
    runtime.updatePour("autre", { "llm.bot.light": "code-aveugle" }, { portee: "bot" });
    expect(signatureRouting(llmRouting(runtime, "autre"))).not.toBe(apresDefaut);
    expect(signatureRouting(llmRouting(runtime))).toBe(apresDefaut);
  });
});

describe("⑧ garde de SOURCE : plus aucun réglage par rôle dans l'exécution", () => {
  it("`llm.light.thinking` (et les autres) ne sont lus QUE par la reprise", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join: joindre } = await import("node:path");
    const racine = joindre(process.cwd(), "src");
    const fichiers: string[] = [];
    const parcourir = (dossier: string): void => {
      for (const entree of readdirSync(dossier, { withFileTypes: true })) {
        const chemin = joindre(dossier, entree.name);
        if (entree.isDirectory()) parcourir(chemin);
        else if (entree.name.endsWith(".ts")) fichiers.push(chemin);
      }
    };
    parcourir(racine);
    const motif = /["'`]llm\.(light|heavy|vision)\./;
    /** Retire les commentaires : ils NOMMENT les anciennes clés sans les lire. */
    const sansCommentaires = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
    const fautifs = fichiers.filter((fichier) => {
      // ⚠️ DEUX fichiers ont le droit de nommer les chemins historiques :
      //  - `src/llm/catalogue.ts` : le module de REPRISE (lire l'ancien monde une
      //    fois, pour le traduire) ;
      //  - `src/config/schema.ts` : la table des clés RETIRÉES (le message qui dit
      //    à l'utilisateur ce qui les remplace).
      if (fichier.endsWith(joindre("llm", "catalogue.ts"))) return false;
      if (fichier.endsWith(joindre("config", "schema.ts"))) return false;
      return motif.test(sansCommentaires(readFileSync(fichier, "utf8")));
    });
    expect(fautifs).toEqual([]);
    // Et ces clés n'existent plus dans le schéma.
    for (const chemin of [
      "llm.light.thinking",
      "llm.heavy.thinking",
      "llm.vision.thinking",
      "llm.light.model",
      "llm.heavy.model",
    ]) {
      expect(CONFIG_SCHEMA[chemin], chemin).toBeUndefined();
    }
  });
});
