/**
 * VERROU DE CLASSIFICATION de la configuration (lot 35b, sous-lot 1b-2).
 *
 * Ce que ce fichier verrouille :
 *  - `CONFIG_PATHS.length === 91` (aucune clé ajoutée ni perdue par accident) ;
 *    ⚠️ 90 → 91 : `bots.maxActifs` (plafond des bots simultanés, lot 36 L1) est
 *    SUPPRIMÉE (décision utilisateur du 2026-11-13 : « retire le plafond »).
 *    ⚠️ 90 → 92 le 2026-11-10 : `chat.mattermost.enabled` et `chat.discord.enabled`
 *    (plateformes INDÉPENDANTES, `bot`). Le compteur est mis à jour EXPRÈS : c'est
 *    lui qui rend l'ajout délibéré.
 *  - `scope` PRÉSENT et VALIDE sur chaque clé, avec les comptes 70 / 19 / 5 ;
 *    ⚠️ CLASSEMENT VALIDÉ (`docs/classement-des-reglages.md`) : trois clés ont
 *    changé de portée SANS changer de nombre — `chat.remoteAgents` et
 *    `chat.remoteTools` (`bot` → `instance`) et `memory.consolidation.enabled`
 *    (`mixte` → `instance`). Comptes : 67/18/5 → 70/16/4, puis 69/18/5 après la
 *    suppression de `bots.maxActifs`.
 *  - `env` INTERDIT hors `scope: "instance"` (garde de compilation, doublée ici
 *    d'un contrôle à l'exécution : la table est une donnée, pas un type) ;
 *  - `mixte` ⇒ `mixteMerge` DÉCLARÉ, et `et` uniquement sur des enums `off|on` ;
 *  - les 18 variables d'environnement RETIRÉES sont annoncées et réellement
 *    inactives (21 → 18 : trois sont RESTAURÉES, leurs clés étant redevenues
 *    `instance`) ;
 *  - `BOT_ID_DEFAUT` reste égal à `BOT_YUKI` (le bot actif du registre).
 *
 * ⚠️ Échoue sur le code d'origine : `FieldDescriptor` n'y porte aucun `scope`,
 * et les 21 variables y sont encore actives (dont les trois reclassées).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BOT_YUKI } from "../../src/bots/registry.js";
import { readConfigEnvOverrides } from "../../src/config/env.js";
import { BOT_ID_DEFAUT } from "../../src/config/overlay.js";
import {
  CONFIG_PATHS,
  CONFIG_SCHEMA,
  CLES_CONFIG_RETIREES,
  VARIABLES_ENV_RETIREES,
  VARIABLES_ENV_SUPPRIMEES,
  envNameOf,
  type FieldDescriptor,
  type FieldScope,
} from "../../src/config/schema.js";

const PORTEES: readonly FieldScope[] = ["instance", "bot", "mixte"];

function descriptor(path: string): FieldDescriptor {
  const found = CONFIG_SCHEMA[path];
  expect(found, path).toBeDefined();
  return found as FieldDescriptor;
}

describe("① la table des clés", () => {
  /**
   * ⚠️ GARDE RÉVISÉE (« 91 → 92 clés ») : `chat.mattermost.url` est AJOUTÉE
   * (adresse du serveur Mattermost par bot, exigence utilisateur du 2026-11-13).
   * Le compte reste EXACT : aucune autre clé n'a bougé.
   */
  // ⚠️ GARDE RÉVISÉE (« 92 → 93 clés ») : `prompts.personnalite` est AJOUTÉE
  // (2026-11-13 : la personnalité devient une entrée SÉPARÉE du prompt système,
  // portée `mixte` comme `prompts.light`/`prompts.heavy`).
  // ⚠️ GARDE RÉVISÉE (« 94 → 97 clés ») : `vision.fallback.model` est RETIRÉE
  // (2026-11-16 : un sélecteur parmi les deux modèles existants ne servait à rien
  // quand aucun des deux ne voit d'image) et le modèle de vision DÉDIÉ ajoute
  // `llm.vision.baseUrl`, `llm.vision.model`, `llm.vision.thinking` et
  // `llm.vision.apiKey` (-1 +4 = 97). Portée `instance` : capacité de MODÈLE.
  it("déclare EXACTEMENT 90 clés (aucune ajoutée ni perdue en silence)", () => {
    // ⚠️ GARDE RÉVISÉE (« 103 → 90 clés ») le 2026-11-19 — LOT B du catalogue :
    //  - les SEIZE réglages par rôle (`llm.light.*` ×6, `llm.heavy.*` ×6,
    //    `llm.vision.*` ×4) sont RETIRÉS : un modèle est une entrée du catalogue,
    //    la réflexion et la vision sont des propriétés du MODÈLE ;
    //  - le catalogue JSON du commit externe `134a313` (`llm.catalog`,
    //    `llm.selection.light`, `llm.selection.heavy`) est RETIRÉ : double emploi
    //    avec `llm.fournisseurs` / `llm.modeles` ;
    //  - SIX clés de SÉLECTION sont AJOUTÉES : `llm.defaut.light|heavy|vision`
    //    (instance) et `llm.bot.light|heavy|vision` (bot).
    // 103 − 19 + 6 = 90.
    expect(CONFIG_PATHS.length).toBe(90);
    expect(CONFIG_PATHS.length).toBe(Object.keys(CONFIG_SCHEMA).length);
  });

  it("⚠️ les réglages PAR RÔLE ont DISPARU (remplacés par le CATALOGUE)", () => {
    // ⚠️ GARDE RÉVISÉE (2026-11-19, LOT B). Un `config.json` qui les contient
    // encore est REPRIS au démarrage (défauts de rôle) puis signalé
    // (`CLES_CONFIG_RETIREES` → `llm.anciennes_cles_ignorees`) — jamais un échec,
    // jamais un silence.
    for (const cle of [
      "vision.fallback.model",
      "llm.light.api",
      "llm.light.baseUrl",
      "llm.light.model",
      "llm.light.thinking",
      "llm.light.vision",
      "llm.light.apiKey",
      "llm.heavy.api",
      "llm.heavy.baseUrl",
      "llm.heavy.model",
      "llm.heavy.thinking",
      "llm.heavy.vision",
      "llm.heavy.apiKey",
      "llm.vision.baseUrl",
      "llm.vision.model",
      "llm.vision.thinking",
      "llm.vision.apiKey",
      // Catalogue JSON du commit externe `134a313` : double emploi, retiré.
      "llm.catalog",
      "llm.selection.light",
      "llm.selection.heavy",
    ]) {
      expect(CONFIG_SCHEMA[cle], cle).toBeUndefined();
      expect(CONFIG_PATHS, cle).not.toContain(cle);
      expect(CLES_CONFIG_RETIREES[cle], cle).toBeDefined();
    }
    // ⚠️ Les remplacements existent, tous en sélection de `modeleId`.
    for (const cle of [
      "llm.fournisseurs",
      "llm.modeles",
      "llm.defaut.light",
      "llm.defaut.heavy",
      "llm.defaut.vision",
      "llm.bot.light",
      "llm.bot.heavy",
      "llm.bot.vision",
    ]) {
      expect(CONFIG_PATHS, cle).toContain(cle);
    }
    // Aucun booléen `enabled` : vide = aucun défaut, c'est le bot qui choisit.
    expect(CONFIG_SCHEMA["llm.vision.enabled"]).toBeUndefined();
  });

  it("⚠️ `bots.maxActifs` a DISPARU (plus de plafond de bots en marche)", () => {
    // ⚠️ Décision utilisateur du 2026-11-13 : « retire le plafond ». La clé n'est
    // ni une clé d'instance, ni une clé retirée : elle N'EXISTE PLUS.
    expect(CONFIG_SCHEMA["bots.maxActifs"]).toBeUndefined();
    expect(CONFIG_PATHS).not.toContain("bots.maxActifs");
    expect(envNameOf("bots.maxActifs")).toBeUndefined();
  });

  it("chaque clé porte une portée VALIDE", () => {
    for (const path of CONFIG_PATHS) {
      expect(PORTEES, path).toContain(descriptor(path).scope);
    }
  });

  /**
   * ⚠️ GARDE RÉVISÉE (« bot 18 → 19 ») : + `chat.mattermost.url` (2026-11-13).
   * ⚠️ GARDE RÉVISÉE (« mixte 4 → 5 ») : `prompts.personnalite` (2026-11-13).
   * ⚠️ GARDE RÉVISÉE (« instance 69 → 70 → 73 ») : + `vision.fallback.model`
   * (2026-11-16), puis le modèle de vision DÉDIÉ `llm.vision.*` la REMPLACE
   * (-1 +4). Bot et mixte inchangés : 73 / 19 / 5 = 97.
   */
  it("répartition : 63 `instance` / 22 `bot` / 5 `mixte`", () => {
    // ⚠️ GARDE RÉVISÉE (2026-11-19, LOT B) : instance 77 − 17 (16 réglages de
    // rôle + `llm.catalog`) + 3 (`llm.defaut.*`) = 63 ; bot 21 − 2
    // (`llm.selection.*`) + 3 (`llm.bot.*`) = 22 ; mixte inchangé (5).
    const compte = { instance: 0, bot: 0, mixte: 0 };
    for (const path of CONFIG_PATHS) compte[descriptor(path).scope] += 1;
    expect(compte).toEqual({ instance: 63, bot: 22, mixte: 5 });
  });

  it("les TROIS clés reclassées sont d'INSTANCE (classement validé)", () => {
    // ⚠️ Aucune ne doit rester `bot`/`mixte` : sur l'origine, ces trois
    // assertions échouent (« bot » / « bot » / « mixte »).
    expect(descriptor("chat.remoteAgents").scope).toBe("instance");
    expect(descriptor("chat.remoteTools").scope).toBe("instance");
    expect(descriptor("memory.consolidation.enabled").scope).toBe("instance");
    // ⚠️ Plus de fusion déclarée : une clé d'instance n'a pas de côté bot.
    expect(descriptor("memory.consolidation.enabled").mixteMerge).toBeUndefined();
    // Les défauts et le caractère « à chaud » ne changent pas.
    expect(descriptor("chat.remoteAgents")).toMatchObject({
      type: "enum",
      enum: ["desactive", "actives"],
      default: "desactive",
      apply: "hot",
    });
    expect(descriptor("chat.remoteTools")).toMatchObject({
      type: "enum",
      enum: ["desactive", "actives"],
      default: "desactive",
      apply: "hot",
    });
    expect(descriptor("memory.consolidation.enabled")).toMatchObject({
      type: "enum",
      enum: ["off", "on"],
      default: "on",
      apply: "hot",
    });
    // ⚠️ `chat.mode` N'A PAS bougé : chaque bot a SON canal (`scope: "bot"`).
    expect(descriptor("chat.mode").scope).toBe("bot");
  });
});

describe("② `scope` ≠ `instance` ⇒ AUCUNE variable d'environnement", () => {
  it("aucune clé `bot`/`mixte` ne déclare `env` (contrôle à l'exécution)", () => {
    const fautives = CONFIG_PATHS.filter((path) => {
      const d = descriptor(path);
      return d.scope !== "instance" && d.env !== undefined;
    });
    expect(fautives).toEqual([]);
  });

  it("les 18 variables retirées ne surchargent PLUS rien", () => {
    expect(Object.keys(VARIABLES_ENV_RETIREES).length).toBe(18);
    const processEnv: NodeJS.ProcessEnv = {};
    for (const [variable, path] of Object.entries(VARIABLES_ENV_RETIREES)) {
      expect(descriptor(path).scope, `${variable} → ${path}`).not.toBe("instance");
      expect(descriptor(path).env, `${variable} → ${path}`).toBeUndefined();
      processEnv[variable] = "on";
    }
    const overrides = readConfigEnvOverrides(processEnv);
    for (const path of Object.values(VARIABLES_ENV_RETIREES)) {
      expect(overrides[path], path).toBeUndefined();
    }
  });

  it("⚠️ `YUKI_BOTS_MAX_ACTIFS` est ANNONCÉE comme sans effet (clé supprimée)", () => {
    // ⚠️ Une variable qui n'agit plus doit être DITE. Elle est listée à part des
    // 18 « retirées » : sa clé n'existe plus du tout (pas de `descriptor`).
    expect(VARIABLES_ENV_SUPPRIMEES["YUKI_BOTS_MAX_ACTIFS"]).toBe("bots.maxActifs");
    expect(VARIABLES_ENV_RETIREES["YUKI_BOTS_MAX_ACTIFS"]).toBeUndefined();
    expect(readConfigEnvOverrides({ YUKI_BOTS_MAX_ACTIFS: "2" })).toEqual({});
  });

  it("une clé `instance` PEUT toujours être verrouillée par l'environnement", () => {
    // ⚠️ GARDE RÉVISÉE (2026-11-19, LOT B) : les modèles par rôle n'ont plus de
    // variable (`llm.light.model` est retirée) — la preuve d'instance verrouillable
    // se prend sur `llm.missingKeyMode`, qui reste un réglage d'installation.
    expect(CONFIG_SCHEMA["llm.missingKeyMode"]?.env).toBe("YUKI_LLM_MISSING_KEY_MODE");
    expect(CONFIG_SCHEMA["llm.missingKeyMode"]?.scope).toBe("instance");
  });

  it("les TROIS variables RESTAURÉES surchargent à nouveau (clés redevenues `instance`)", () => {
    // ⚠️ Une variable retirée qui agirait (ou l'inverse) serait un mensonge : les
    // trois clés reclassées ont leur variable DÉCLARÉE et plus listée comme retirée.
    const overrides = readConfigEnvOverrides({
      YUKI_CHAT_REMOTE_AGENTS: "actives",
      YUKI_CHAT_REMOTE_TOOLS: "actives",
      YUKI_MEMORY_CONSOLIDATION_ENABLED: "off",
    });
    expect(overrides["chat.remoteAgents"]).toBe("actives");
    expect(overrides["chat.remoteTools"]).toBe("actives");
    expect(overrides["memory.consolidation.enabled"]).toBe("off");
    for (const variable of [
      "YUKI_CHAT_REMOTE_AGENTS",
      "YUKI_CHAT_REMOTE_TOOLS",
      "YUKI_MEMORY_CONSOLIDATION_ENABLED",
    ]) {
      expect(VARIABLES_ENV_RETIREES[variable], variable).toBeUndefined();
    }
  });
});

describe("③ la fusion d'une clé `mixte` est DÉCLARÉE, jamais devinée", () => {
  it("`mixte` ⇒ `mixteMerge` présent et valide", () => {
    for (const path of CONFIG_PATHS) {
      const d = descriptor(path);
      if (d.scope !== "mixte") {
        expect(d.mixteMerge, path).toBeUndefined();
        continue;
      }
      expect(["surcharge", "et"], path).toContain(d.mixteMerge);
    }
  });

  it("les 5 clés `mixte` sont celles établies (2 `et`, 3 `surcharge`)", () => {
    // ⚠️ GARDE RÉVISÉE (« 4 → 5 clés mixte ») : `prompts.personnalite` rejoint les
    // textes du prompt (2026-11-13), avec la MÊME fusion que `prompts.light`/`heavy`.
    const mixte = CONFIG_PATHS.filter((path) => descriptor(path).scope === "mixte");
    expect(mixte.sort()).toEqual(
      ["prompts.heavy", "prompts.light", "prompts.personnalite", "push.enabled", "tts.enabled"].sort(),
    );
    const parFusion = (fusion: string) =>
      mixte.filter((path) => descriptor(path).mixteMerge === fusion).sort();
    expect(parFusion("et")).toEqual(["push.enabled", "tts.enabled"]);
    expect(parFusion("surcharge")).toEqual([
      "prompts.heavy",
      "prompts.light",
      "prompts.personnalite",
    ]);
  });

  it("`et` n'est utilisé que sur un enum `off|on` (la conjonction n'a pas d'autre sens)", () => {
    for (const path of CONFIG_PATHS) {
      const d = descriptor(path);
      if (d.mixteMerge !== "et") continue;
      expect(d.type, path).toBe("enum");
      expect(d.enum, path).toEqual(["off", "on"]);
    }
  });
});

describe("④ le merge est le CHEMIN DE LECTURE UNIQUE", () => {
  /** Tous les .ts de `src/` (chemins relatifs à la racine du dépôt). */
  function fichiersSrc(prefixe = "src"): string[] {
    const out: string[] = [];
    for (const entree of readdirSync(prefixe, { withFileTypes: true })) {
      const chemin = join(prefixe, entree.name);
      if (entree.isDirectory()) out.push(...fichiersSrc(chemin));
      else if (entree.name.endsWith(".ts")) out.push(chemin);
    }
    return out;
  }

  /**
   * Source SANS commentaires : un commentaire qui CITE un symbole n'est pas un
   * usage (et c'est exactement ce qui a motivé ce garde-fou).
   */
  function sansCommentaires(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
  }

  it("`ConfigStore` n'est instancié QUE par le runtime de configuration", () => {
    // ⚠️ Un second `new ConfigStore(...)` lirait `config.json` sans l'overlay du
    // bot : la clé de bot serait ignorée en SILENCE. C'est LE défaut à éviter.
    const fautifs = fichiersSrc().filter(
      (fichier) =>
        fichier !== join("src", "config", "runtime.ts") &&
        /new ConfigStore\(/.test(sansCommentaires(readFileSync(fichier, "utf8"))),
    );
    expect(fautifs).toEqual([]);
  });

  it("le schéma (`CONFIG_SCHEMA` / `descriptorOf`) n'est manipulé que dans `src/config/`", () => {
    const fautifs = fichiersSrc().filter(
      (fichier) =>
        !fichier.startsWith(join("src", "config")) &&
        /\bCONFIG_SCHEMA\b|\bdescriptorOf\(/.test(
          sansCommentaires(readFileSync(fichier, "utf8")),
        ),
    );
    expect(fautifs).toEqual([]);
  });

  it("aucun fichier hors `src/config/` ne lit `configStorePath` (fichier du store commun)", () => {
    const fautifs = fichiersSrc().filter(
      (fichier) =>
        !fichier.startsWith(join("src", "config")) &&
        /configStorePath/.test(sansCommentaires(readFileSync(fichier, "utf8"))),
    );
    expect(fautifs).toEqual([]);
  });
});

describe("⑤ le bot actif de l'overlay", () => {
  it("`BOT_ID_DEFAUT` reste égal à `BOT_YUKI`", () => {
    expect(BOT_ID_DEFAUT).toBe(BOT_YUKI);
  });

  /**
   * ⚠️ GARDE RÉVISÉE (« 19 → 22 clés `bot` », lot B) : les trois SÉLECTIONS DE
   * MODÈLE par bot (`llm.bot.light|heavy|vision`) remplacent les deux sélections
   * du catalogue externe (`llm.selection.*`).
   */
  it("les 22 clés `bot` sont celles établies (plateformes, voix, mémoire, modèles du bot)", () => {
    const bot = CONFIG_PATHS.filter((path) => descriptor(path).scope === "bot");
    expect(bot.sort()).toEqual(
      [
        // ⚠️ DEUX interrupteurs de plateforme (2026-11-10) : la plateforme
        // distante n'est plus un choix exclusif (`chat.mode` reste, LEGACY).
        "chat.mattermost.enabled",
        // ⚠️ ADRESSE du serveur Mattermost, PAR BOT (2026-11-13) : Mattermost est
        // auto-hébergé, deux bots peuvent viser deux instances différentes.
        "chat.mattermost.url",
        "chat.discord.enabled",
        "chat.discord.guildId",
        "chat.discord.maxUploadBytes",
        "chat.mode",
        // ⚠️ LOT B (2026-11-19) : les modèles du bot sont des `modeleId` du
        // CATALOGUE (vide = défaut de l'instance) ; `llm.selection.*` disparaît.
        "llm.bot.light",
        "llm.bot.heavy",
        "llm.bot.vision",
        "memory.enabled",
        "memory.extract.maxItems",
        "memory.extract.timeoutMs",
        "memory.recall.budgetChars",
        "memory.recall.timeoutMs",
        "memory.recall.topK",
        "memory.setAside.maxChars",
        "memory.setAside.maxChunks",
        "tts.cfg",
        "tts.emotion",
        "tts.exaggeration",
        "tts.speed",
        "tts.voice",
      ].sort(),
    );
  });
});
