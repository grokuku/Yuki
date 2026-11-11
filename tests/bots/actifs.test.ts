/**
 * LOT 36 (L1) — RÉSOLUTION MULTI-BOT AU DÉMARRAGE.
 *
 * Ce que ce fichier verrouille :
 *  - la LISTE des bots qui doivent tourner (`actif: true`), triée par `ordre` puis
 *    par identifiant (ordre déterministe, pas l'ordre du fichier) ;
 *  - « PRINCIPAL » ≠ « DOIT TOURNER » : `botActif` privilégie TOUJOURS `yuki`,
 *    même éteint, alors que la liste ne contient que les bots actifs ;
 *  - le PLAFOND `bots.maxActifs` (défaut 3) : les bots actifs au-delà ne
 *    démarrent pas et sont NOMMÉS un par un (jamais écartés en silence) ;
 *  - la GARDE DE NON-RÉGRESSION : un seul bot actif (`yuki`) ⇒ le bot effectif,
 *    son `Env` et ses chemins sont EXACTEMENT ceux d'avant.
 *
 * ⚠️ Échoue sur le code d'origine : `src/bots/actifs.ts` n'existe pas, la clé
 * `bots.maxActifs` non plus, et `preparerMultiBot` ne rend aucune liste.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DemarrageRefuseError,
  MAX_ACTIFS_DEFAUT,
  botActif,
  botsAActiver,
  cheminsBot,
  cheminRegistreBots,
  creerRegistreInitial,
  ecrireRegistreBots,
  lirePlafondActifs,
  normaliserPlafond,
  preparerMultiBot,
  resoudreDemarrageBots,
  type BotRecord,
  type RegistreBots,
} from "../../src/bots/index.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import { ConfigStore } from "../../src/config/store.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

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

interface Fixture {
  racine: string;
  state: string;
  env: Env;
}

/** Volumes vides (aucun chemin d'origine) + `bots.json` écrit à la main. */
function fixture(bots: BotRecord[], options: { store?: Record<string, unknown> } = {}): Fixture {
  const racine = mkdtempSync(join(tmpdir(), "yuki-actifs-"));
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
  ecrireRegistreBots(cheminRegistreBots(state), registre(bots));
  if (options.store) new ConfigStore(env.configStorePath).write(options.store);
  return { racine, state, env };
}

describe("① le plafond `bots.maxActifs`", () => {
  it("normalise : défaut 3, borné à [1, 6], jamais NaN", () => {
    expect(MAX_ACTIFS_DEFAUT).toBe(3);
    expect(normaliserPlafond(undefined)).toBe(3);
    expect(normaliserPlafond("")).toBe(3);
    expect(normaliserPlafond("abc")).toBe(3);
    expect(normaliserPlafond(Number.NaN)).toBe(3);
    expect(normaliserPlafond(1.5)).toBe(3);
    expect(normaliserPlafond(0)).toBe(1);
    expect(normaliserPlafond(-4)).toBe(1);
    expect(normaliserPlafond(9)).toBe(6);
    expect(normaliserPlafond("4")).toBe(4);
  });

  it("lit le STORE, puis l'ENVIRONNEMENT qui l'emporte, sinon le défaut", () => {
    const f = fixture([bot("yuki", 0, true)]);
    expect(lirePlafondActifs(f.env, {})).toBe(3);
    new ConfigStore(f.env.configStorePath).write({ "bots.maxActifs": 5 });
    expect(lirePlafondActifs(f.env, {})).toBe(5);
    expect(lirePlafondActifs(f.env, { YUKI_BOTS_MAX_ACTIFS: "2" })).toBe(2);
    // Une surcharge VIDE n'est pas une surcharge (même règle que le runtime).
    expect(lirePlafondActifs(f.env, { YUKI_BOTS_MAX_ACTIFS: "  " })).toBe(5);
  });
});

describe("② la LISTE des bots à démarrer", () => {
  it("ne garde que `actif: true`, triés par `ordre` puis par identifiant", () => {
    const r = registre([
      bot("zeta", 2, true),
      bot("yuki", 0, false),
      bot("alpha", 2, true),
      bot("beta", 1, true),
    ]);
    expect(botsAActiver(r).map((entree) => entree.id)).toEqual(["beta", "alpha", "zeta"]);
  });

  it("⚠️ PRINCIPAL ≠ DOIT TOURNER : `yuki` reste principal même ÉTEINT", () => {
    const r = registre([bot("yuki", 0, false), bot("kohai", 1, true)]);
    const resolution = resoudreDemarrageBots(r);
    expect(resolution.principal?.id).toBe("yuki");
    expect(resolution.aDemarrer.map((entree) => entree.id)).toEqual(["kohai"]);
    // Le principal n'est PAS dans la liste : les deux notions sont distinctes.
    expect(resolution.aDemarrer.some((entree) => entree.id === "yuki")).toBe(false);
    expect(botActif(r)?.id).toBe("yuki");
  });

  it("⚠️ le PLAFOND écarte les bots en trop et les NOMME (aucun silence)", () => {
    const r = registre([
      bot("yuki", 0, true),
      bot("b2", 1, true),
      bot("b3", 2, true),
      bot("b4", 3, true),
    ]);
    const resolution = resoudreDemarrageBots(r);
    expect(resolution.plafond).toBe(3);
    expect(resolution.aDemarrer.map((entree) => entree.id)).toEqual(["yuki", "b2", "b3"]);
    expect(resolution.refuses.map((entree) => entree.id)).toEqual(["b4"]);
    // Le plafond est un paramètre, pas une constante en dur.
    expect(resoudreDemarrageBots(r, { maxActifs: 2 }).refuses.map((e) => e.id)).toEqual([
      "b3",
      "b4",
    ]);
    expect(resoudreDemarrageBots(r, { maxActifs: 6 }).refuses).toEqual([]);
  });

  it("tous les bots éteints ⇒ liste VIDE (l'appelant refuse le démarrage)", () => {
    const resolution = resoudreDemarrageBots(registre([bot("yuki", 0, false)]));
    expect(resolution.aDemarrer).toEqual([]);
    expect(resolution.refuses).toEqual([]);
    // Le principal existe quand même : c'est une IDENTITÉ, pas un état d'exécution.
    expect(resolution.principal?.id).toBe("yuki");
  });
});

describe("③ `preparerMultiBot` : liste, principal et plafond", () => {
  it("⚠️ GARDE DE NON-RÉGRESSION : 1 bot actif ⇒ comportement IDENTIQUE", () => {
    const f = fixture([creerRegistreInitial().bots[0] as BotRecord]);
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    expect(preparation.mode).toBe("multi");
    expect(preparation.bot?.id).toBe("yuki");
    expect(preparation.principal?.id).toBe("yuki");
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki"]);
    expect(preparation.refusesActifs).toEqual([]);
    expect(preparation.plafondActifs).toBe(3);
    expect(preparation.avertissements).toEqual([]);
    // Les chemins restent EXACTEMENT ceux du bot `yuki`.
    const chemins = cheminsBot(f.env, "yuki");
    expect(preparation.env.memoryStorePath).toBe(chemins.fichiers.memoryStorePath);
    expect(preparation.env.piSessionsDir).toBe(chemins.sessions);
    expect(preparation.chemins?.racine).toBe(chemins.racine);
  });

  it("deux bots actifs ⇒ liste de DEUX, une seule pile (le principal)", () => {
    const f = fixture([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki", "kohai"]);
    // L1 ne construit qu'UNE pile : c'est le principal.
    expect(preparation.bot?.id).toBe("yuki");
    expect(preparation.refusesActifs).toEqual([]);
  });

  it("principal ÉTEINT ⇒ la pile construite est celle du premier bot actif, et c'est DIT", () => {
    const f = fixture([bot("yuki", 0, false), bot("kohai", 1, true)]);
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    expect(preparation.principal?.id).toBe("yuki");
    expect(preparation.bot?.id).toBe("kohai");
    // Les chemins suivent le bot qui tourne, pas le principal.
    expect(preparation.env.memoryStorePath).toBe(
      cheminsBot(f.env, "kohai").fichiers.memoryStorePath,
    );
    expect(preparation.avertissements.join(" ")).toContain("PRINCIPAL");
  });

  it("⚠️ plafond dépassé ⇒ les bots en trop ne démarrent pas et sont nommés", () => {
    const f = fixture([
      bot("yuki", 0, true),
      bot("b2", 1, true),
      bot("b3", 2, true),
      bot("b4", 3, true),
    ]);
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki", "b2", "b3"]);
    expect(preparation.refusesActifs.map((entree) => entree.id)).toEqual(["b4"]);
    const avertissements = preparation.avertissements.join("\n");
    expect(avertissements).toContain("« b4 »");
    // ⚠️ LOT 38 : l'avertissement est en français lisible (« limite »), plus
    // « marqué ACTIF / plafond ». Le réglage reste nommé (il est actionnable).
    expect(avertissements).toContain("la limite de 3 bot(s) en marche");
    expect(avertissements).toContain("bots.maxActifs");
  });

  it("le plafond se règle par l'environnement (YUKI_BOTS_MAX_ACTIFS)", () => {
    const f = fixture([
      bot("yuki", 0, true),
      bot("b2", 1, true),
      bot("b3", 2, true),
    ]);
    const preparation = preparerMultiBot(f.env, {
      processEnv: { YUKI_BOTS_MAX_ACTIFS: "2" },
    });
    expect(preparation.plafondActifs).toBe(2);
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki", "b2"]);
    expect(preparation.refusesActifs.map((entree) => entree.id)).toEqual(["b3"]);
  });

  it("⚠️ tous les bots éteints ⇒ démarrage REFUSÉ (`AUCUN_BOT_ACTIF`)", () => {
    const f = fixture([bot("yuki", 0, false), bot("kohai", 1, false)]);
    let refus: unknown;
    try {
      preparerMultiBot(f.env, { processEnv: {} });
    } catch (error) {
      refus = error;
    }
    expect(refus).toBeInstanceOf(DemarrageRefuseError);
    expect((refus as DemarrageRefuseError).code).toBe("AUCUN_BOT_ACTIF");
    expect((refus as DemarrageRefuseError).message).toContain("doit tourner");
  });
});
