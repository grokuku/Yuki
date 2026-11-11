/**
 * LOT 36 (L3-b) — LA MÉMOIRE, L'ARCHIVE, L'AVATAR, LA PERSONNALITÉ ET LES PINS
 * PAR BOT.
 *
 * Ce que ce fichier verrouille :
 *  ① GARDE DE NON-RÉGRESSION FORTE : avec UN bot (mode mono historique ET mode
 *    multi à un seul bot actif), les SEPT chemins du principal sont EXACTEMENT
 *    ceux que `main()` utilisait avant ce morceau, et les objets déjà construits
 *    par `main()` sont RÉUTILISÉS tels quels (`===`) ;
 *  ② deux bots ⇒ deux `MemoryStore`, deux `avatarDir`, deux `personalityPath` ;
 *  ③ ISOLATION DE CONSTRUCTION : un souvenir écrit pour un bot n'entre ni dans
 *    le store, ni dans le fichier, ni dans l'index d'un autre ;
 *  ④ `envPourBot` n'est appliqué qu'UNE fois par bot (aucun `<bot>/<bot>`) ;
 *  ⑤ la Map contient les bots à DÉMARRER plus le bot de pile, jamais les refusés.
 *
 * ⚠️ Échoue sur le code d'origine : `src/bots/outils.ts` n'existe pas (ni
 * `creerOutilsBot`, ni `creerOutilsBots`, ni `FabriqueMemoireBots.adopter`) —
 * `main()` construit UN jeu d'objets, aux seuls chemins de la pile.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { preparerMultiBot } from "../../src/bots/index.js";
import {
  OutilsBotError,
  cheminsOutils,
  creerOutilsBot,
  creerOutilsBots,
} from "../../src/bots/outils.js";
import {
  cheminRegistreBots,
  ecrireRegistreBots,
  type BotRecord,
  type RegistreBots,
} from "../../src/bots/registry.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import {
  FabriqueMemoireBots,
  envPourBot,
  ouvrirStoresMemoireBot,
  type StoresMemoireBot,
} from "../../src/memory/index.js";
import { PersonalityStore } from "../../src/personality/index.js";
import { SessionPinStore } from "../../src/pi/session-pins.js";
import { RulesStore } from "../../src/rules/index.js";

const racines: string[] = [];
const ouverts: StoresMemoireBot[] = [];

afterEach(() => {
  for (const stores of ouverts.splice(0)) {
    try {
      stores.fermer();
    } catch {
      /* fermeture best-effort : le test ne doit pas échouer ici */
    }
  }
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

const journal = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Banc {
  racine: string;
  state: string;
  env: Env;
}

/** Volumes vides (état + montage Pi) : `Env` d'INSTANCE. */
function banc(options: { processEnv?: NodeJS.ProcessEnv } = {}): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-outils-bots-"));
  racines.push(racine);
  const state = join(racine, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(racine, "pi", "agent", "sessions"), { recursive: true });
  const env = loadEnv({
    YUKI_MOUNT_STATE: state,
    YUKI_MOUNT_PI_AGENT: join(racine, "pi"),
    YUKI_CONFIG_STORE_PATH: join(state, "config.json"),
    YUKI_LOG_LEVEL: "error",
  });
  return { racine, state, env };
}

function bot(id: string, ordre: number, actif: boolean): BotRecord {
  return {
    id,
    nom: id,
    capacites: [],
    actif,
    ordre,
    creeLe: "2026-01-01T00:00:00.000Z",
    plateformes: {},
  };
}

function registre(bots: BotRecord[]): RegistreBots {
  return { schemaVersion: 1, bots, echanges: {} };
}

/** Banc avec `bots.json` écrit à la main (comme `tests/bots/actifs.test.ts`). */
function avecRegistre(bots: BotRecord[]): Banc {
  const b = banc();
  ecrireRegistreBots(cheminRegistreBots(b.state), registre(bots));
  return b;
}

/** Ouvre les stores d'un bot par le chemin unique du produit (comme `main()`). */
function ouvrir(b: Banc, botId: string, mode: "mono" | "multi"): StoresMemoireBot {
  const stores = ouvrirStoresMemoireBot({
    env: envPourBot({ envInstance: b.env, botId, mode, processEnv: {} }),
    botId,
    logger: journal,
  });
  ouverts.push(stores);
  return stores;
}

function fabrique(b: Banc, mode: "mono" | "multi"): FabriqueMemoireBots {
  return new FabriqueMemoireBots({ envInstance: b.env, mode, logger: journal });
}

describe("① garde de non-régression : 1 bot ⇒ les SEPT chemins IDENTIQUES", () => {
  it("mode MONO historique : le principal garde les chemins d'aujourd'hui", () => {
    const b = banc();
    const preparation = preparerMultiBot(b.env, { processEnv: {} });
    expect(preparation.mode).toBe("mono");
    expect(preparation.aDemarrer).toEqual([]);

    const outils = creerOutilsBots({
      envInstance: preparation.envInstance,
      mode: preparation.mode,
      bots: preparation.aDemarrer.map((entree) => entree.id),
      pile: "yuki",
      fabrique: fabrique(b, preparation.mode),
      logger: journal,
    });

    // La Map ne contient QUE le bot de la pile (aucun bot à démarrer).
    expect([...outils.keys()]).toEqual(["yuki"]);

    // ⚠️ Valeurs HISTORIQUES de `main()` : `loadEnv` les pose sous `<state>/`.
    expect(outils.get("yuki")?.chemins).toEqual({
      memoryStorePath: join(b.state, "memory.jsonl"),
      conversationsArchiveDir: join(b.state, "conversations-archive"),
      avatarDir: join(b.state, "avatar"),
      personalityPath: join(b.state, "personality.md"),
      rulesPath: join(b.state, "rules.md"),
      sessionPinsPath: join(b.state, "session-pins.json"),
      reactionsPath: join(b.state, "reactions.jsonl"),
    });
    // Aucun dossier de bot n'a été inventé en mono-bot.
    expect(existsSync(join(b.state, "bots"))).toBe(false);
  });

  it("mode MULTI à 1 bot actif : mêmes chemins que l'`Env` résolu de `main()`", () => {
    const b = avecRegistre([bot("yuki", 0, true)]);
    const preparation = preparerMultiBot(b.env, { processEnv: {} });
    expect(preparation.mode).toBe("multi");
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki"]);

    const outils = creerOutilsBots({
      envInstance: preparation.envInstance,
      mode: preparation.mode,
      bots: preparation.aDemarrer.map((entree) => entree.id),
      pile: "yuki",
      fabrique: fabrique(b, preparation.mode),
      logger: journal,
    });

    // ⚠️ `preparation.env` est EXACTEMENT l'`Env` que `main()` passe aujourd'hui
    // aux constructeurs : c'est la référence de non-régression.
    expect(outils.get("yuki")?.chemins).toEqual(cheminsOutils(preparation.env));
    const racineBot = join(b.state, "bots", "yuki");
    expect(outils.get("yuki")?.chemins).toEqual({
      memoryStorePath: join(racineBot, "memory.jsonl"),
      conversationsArchiveDir: join(racineBot, "conversations-archive"),
      avatarDir: join(racineBot, "avatar"),
      personalityPath: join(racineBot, "personality.md"),
      rulesPath: join(racineBot, "rules.md"),
      sessionPinsPath: join(racineBot, "session-pins.json"),
      reactionsPath: join(racineBot, "reactions.jsonl"),
    });
  });

  it("les objets déjà construits par `main()` sont RÉUTILISÉS (`===`), pas reconstruits", () => {
    const b = avecRegistre([bot("yuki", 0, true)]);
    const preparation = preparerMultiBot(b.env, { processEnv: {} });

    // Ce que `main()` construit aujourd'hui, au mot près.
    const memoire = ouvrir(b, "yuki", preparation.mode);
    const personnalite = new PersonalityStore({ path: preparation.env.personalityPath, logger: journal });
    const regles = new RulesStore({ path: preparation.env.rulesPath, logger: journal });
    const pins = SessionPinStore.open({ path: preparation.env.sessionPinsPath, logger: journal });

    const fab = fabrique(b, preparation.mode);
    const outils = creerOutilsBots({
      envInstance: preparation.envInstance,
      mode: preparation.mode,
      bots: ["yuki"],
      pile: "yuki",
      fabrique: fab,
      existantsPile: { memoire, personnalite, regles, pins },
      logger: journal,
    });

    const pile = outils.get("yuki");
    expect(pile?.memoire).toBe(memoire);
    expect(pile?.personnalite).toBe(personnalite);
    expect(pile?.regles).toBe(regles);
    expect(pile?.pins).toBe(pins);
    // ⚠️ La fabrique ADOPTE les stores de la pile : une passe de consolidation
    // (`storesDe`) rend le MÊME objet — jamais un second `MemoryStore`.
    expect(fab.storesDe("yuki")).toBe(memoire);
    expect(fab.botsOuverts).toEqual(["yuki"]);
  });
});

describe("② deux bots ⇒ deux jeux d'objets, deux chemins", () => {
  it("deux `MemoryStore`, deux `avatarDir`, deux `personalityPath`", () => {
    const b = avecRegistre([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const preparation = preparerMultiBot(b.env, { processEnv: {} });
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki", "kohai"]);

    const fab = fabrique(b, preparation.mode);
    const outils = creerOutilsBots({
      envInstance: preparation.envInstance,
      mode: preparation.mode,
      bots: preparation.aDemarrer.map((entree) => entree.id),
      pile: "yuki",
      fabrique: fab,
      logger: journal,
    });

    const yuki = outils.get("yuki");
    const kohai = outils.get("kohai");
    expect(yuki).toBeDefined();
    expect(kohai).toBeDefined();

    expect(yuki?.memoire.store).not.toBe(kohai?.memoire.store);
    expect(yuki?.memoire.index).not.toBe(kohai?.memoire.index);
    expect(yuki?.memoire.fichier).toBe(join(b.state, "bots", "yuki", "memory.jsonl"));
    expect(kohai?.memoire.fichier).toBe(join(b.state, "bots", "kohai", "memory.jsonl"));

    expect(yuki?.chemins.avatarDir).not.toBe(kohai?.chemins.avatarDir);
    expect(yuki?.chemins.personalityPath).not.toBe(kohai?.chemins.personalityPath);
    expect(kohai?.chemins.personalityPath).toBe(
      join(b.state, "bots", "kohai", "personality.md"),
    );
    expect(yuki?.avatar).not.toBe(kohai?.avatar);
    expect(yuki?.personnalite).not.toBe(kohai?.personnalite);
    expect(yuki?.regles).not.toBe(kohai?.regles);
    expect(yuki?.pins).not.toBe(kohai?.pins);
    expect(yuki?.reactions).not.toBe(kohai?.reactions);
    // Chaque bot a bien SES sept chemins, tous sous SA racine.
    for (const chemin of Object.values(kohai?.chemins ?? {})) {
      expect(chemin.startsWith(join(b.state, "bots", "kohai"))).toBe(true);
    }
    // Les stores de la fabrique sont ceux de la Map (un seul par bot).
    expect(fab.storesDe("kohai")).toBe(kohai?.memoire);
  });
});

describe("③ isolation de CONSTRUCTION (le filtrage est couvert par 35i)", () => {
  it("un souvenir écrit pour `yuki` n'apparaît ni chez `kohai` ni sur son disque", () => {
    const b = avecRegistre([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const preparation = preparerMultiBot(b.env, { processEnv: {} });
    const outils = creerOutilsBots({
      envInstance: preparation.envInstance,
      mode: preparation.mode,
      bots: ["yuki", "kohai"],
      pile: "yuki",
      fabrique: fabrique(b, preparation.mode),
      logger: journal,
    });
    const yuki = outils.get("yuki");
    const kohai = outils.get("kohai");
    if (!yuki || !kohai) throw new Error("Map incomplète");

    const ajout = yuki.memoire.store.add({
      text: "L'utilisateur préfère les réponses courtes et le fuseau Europe/Paris.",
      source: "conversation:test",
      cat: "preference",
    });
    expect(ajout.created).toBe(true);
    expect(yuki.memoire.store.size).toBe(1);

    expect(kohai.memoire.store.size).toBe(0);
    expect(kohai.memoire.index.search("Europe/Paris", 5)).toEqual([]);
    expect(readFileSync(kohai.memoire.fichier, "utf8")).not.toContain("Europe/Paris");
  });
});

describe("④ `envPourBot` n'est appliqué qu'UNE fois par bot", () => {
  it("aucun chemin ne contient `<bot>/<bot>` et la résolution a lieu 1 fois par bot", () => {
    const b = avecRegistre([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const preparation = preparerMultiBot(b.env, { processEnv: {} });

    const appels: string[] = [];
    const outils = creerOutilsBots({
      envInstance: preparation.envInstance,
      mode: preparation.mode,
      bots: ["yuki", "kohai"],
      pile: "yuki",
      fabrique: fabrique(b, preparation.mode),
      logger: journal,
      resoudreEnvBot: (botId) => {
        appels.push(botId);
        return envPourBot({
          envInstance: preparation.envInstance,
          botId,
          mode: preparation.mode,
          processEnv: {},
        });
      },
    });

    expect(appels).toEqual(["yuki", "kohai"]);
    for (const [botId, jeu] of outils) {
      const double = join(botId, botId);
      expect(jeu.env.piSessionsDir).not.toContain(double);
      for (const chemin of Object.values(jeu.chemins)) expect(chemin).not.toContain(double);
      expect(jeu.env.piSessionsDir).toBe(
        join(preparation.envInstance.piSessionsDir, botId),
      );
    }
  });

  it("un `Env` déjà dérivé DEUX fois est REFUSÉ (garde du double `envPourBot`)", () => {
    const b = avecRegistre([bot("yuki", 0, true)]);
    const preparation = preparerMultiBot(b.env, { processEnv: {} });
    const uneFois = envPourBot({
      envInstance: preparation.envInstance,
      botId: "yuki",
      mode: "multi",
      processEnv: {},
    });
    // Le symptôme exact du piège : appliquer `envPourBot` à un Env déjà dérivé.
    const deuxFois: Env = {
      ...uneFois,
      piSessionsDir: join(uneFois.piSessionsDir, "yuki"),
    };

    expect(() =>
      creerOutilsBot({
        botId: "yuki",
        envBot: deuxFois,
        envInstance: preparation.envInstance,
        mode: "multi",
        logger: journal,
      }),
    ).toThrowError(OutilsBotError);
    try {
      creerOutilsBot({
        botId: "yuki",
        envBot: deuxFois,
        envInstance: preparation.envInstance,
        mode: "multi",
        logger: journal,
      });
    } catch (error) {
      expect((error as OutilsBotError).code).toBe("env_double_resolution");
    }
  });

  it("un identifiant invalide est REFUSÉ (il devient un nom de dossier)", () => {
    const b = banc();
    for (const invalide of ["", "../evade", "Yuki", "yuki/../autre"]) {
      expect(() =>
        creerOutilsBot({
          botId: invalide,
          envBot: b.env,
          envInstance: b.env,
          mode: "mono",
          logger: journal,
        }),
      ).toThrowError(OutilsBotError);
    }
  });
});

describe("⑤ la Map = bots à DÉMARRER + bot de pile, jamais les refusés", () => {
  it("le plafond refuse un bot : il n'a pas de jeu d'outils", () => {
    const b = avecRegistre([
      bot("yuki", 0, true),
      bot("kohai", 1, true),
      bot("senpai", 2, true),
      bot("sensei", 3, true),
    ]);
    const preparation = preparerMultiBot(b.env, { processEnv: {} });
    // Plafond par défaut : 3 bots qui tournent.
    expect(preparation.plafondActifs).toBe(3);
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki", "kohai", "senpai"]);
    expect(preparation.refusesActifs.map((entree) => entree.id)).toEqual(["sensei"]);

    const outils = creerOutilsBots({
      envInstance: preparation.envInstance,
      mode: preparation.mode,
      bots: preparation.aDemarrer.map((entree) => entree.id),
      pile: "yuki",
      fabrique: fabrique(b, preparation.mode),
      logger: journal,
    });

    expect([...outils.keys()]).toEqual(["yuki", "kohai", "senpai"]);
    expect(outils.has("sensei")).toBe(false);
    expect(existsSync(join(b.state, "bots", "sensei", "memory.jsonl"))).toBe(false);
  });

  it("le bot de pile est TOUJOURS présent, même absent de la liste à démarrer", () => {
    const b = avecRegistre([bot("yuki", 0, false), bot("kohai", 1, true)]);
    const preparation = preparerMultiBot(b.env, { processEnv: {} });

    const outils = creerOutilsBots({
      envInstance: preparation.envInstance,
      mode: preparation.mode,
      bots: ["yuki"],
      pile: "kohai",
      fabrique: fabrique(b, preparation.mode),
      logger: journal,
    });

    expect([...outils.keys()]).toEqual(["yuki", "kohai"]);
    expect(outils.get("kohai")?.chemins.personalityPath).toBe(
      join(b.state, "bots", "kohai", "personality.md"),
    );
  });

  it("un identifiant répété n'est construit qu'UNE fois", () => {
    const b = avecRegistre([bot("yuki", 0, true)]);
    const preparation = preparerMultiBot(b.env, { processEnv: {} });
    const outils = creerOutilsBots({
      envInstance: preparation.envInstance,
      mode: preparation.mode,
      bots: ["yuki", "yuki"],
      pile: "yuki",
      fabrique: fabrique(b, preparation.mode),
      logger: journal,
    });
    expect([...outils.keys()]).toEqual(["yuki"]);
  });
});
