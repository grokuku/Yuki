/**
 * RÉSOLUTION MULTI-BOT AU DÉMARRAGE — « QUI DOIT TOURNER ».
 *
 * Ce que ce fichier verrouille :
 *  - la LISTE des bots qui doivent tourner (`actif: true`), triée par `ordre` puis
 *    par identifiant (ordre déterministe, pas l'ordre du fichier) ;
 *  - ⚠️ LOT 45 : PLUS DE « PRINCIPAL ». `botActif` ne privilégie AUCUN
 *    identifiant (il rend le premier par `ordre`), et `botCourant` est le premier
 *    bot à démarrer. `yuki` n'a donc aucun statut particulier ;
 *  - ⚠️ AUCUN PLAFOND (décision utilisateur du 2026-11-13 : « retire le plafond.
 *    Chacun fait comme il a envie en fonction de ses ressources, limiter c'est
 *    mal à mon sens ») : `bots.maxActifs` n'existe PLUS, `resoudreDemarrageBots`
 *    ne tronque RIEN et aucun bot `actif` n'est écarté — 4 bots actifs ⇒ 4
 *    démarrages ;
 *  - la GARDE DE NON-RÉGRESSION : un seul bot actif (`yuki`) ⇒ le bot effectif,
 *    son `Env` et ses chemins sont EXACTEMENT ceux d'avant.
 *
 * ⚠️ RÉÉCRITURES NOMMÉES (le plafond a été retiré, pas les tests) :
 *  - « le plafond se règle à l'appel » → « 4 bots actifs ⇒ 4 démarrages » ;
 *  - « le plafond se règle par l'environnement » → « YUKI_BOTS_MAX_ACTIFS n'agit
 *    plus : les 4 bots démarrent quand même » ;
 *  - « le plafond écarte les bots en trop » → « plus aucun bot n'est écarté ».
 *
 * ⚠️ Échoue sur le code d'origine : `src/bots/actifs.ts` n'existe pas, et
 * `preparerMultiBot` ne rend aucune liste.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DemarrageRefuseError,
  botActif,
  botsAActiver,
  cheminsBot,
  cheminRegistreBots,
  creerRegistreInitial,
  ecrireRegistreBots,
  preparerMultiBot,
  resoudreDemarrageBots,
  type BotRecord,
  type RegistreBots,
} from "../../src/bots/index.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import { CONFIG_SCHEMA } from "../../src/config/schema.js";
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

describe("① le plafond a DISPARU (décision utilisateur)", () => {
  it("⚠️ `bots.maxActifs` n'est PLUS une clé de configuration", () => {
    // ⚠️ La clé du lot 36 (L1) est SUPPRIMÉE : plus de réglage, plus de variable.
    expect(CONFIG_SCHEMA["bots.maxActifs"]).toBeUndefined();
  });

  it("⚠️ 4 bots actifs ⇒ 4 DÉMARRAGES (le cas de l'utilisateur, sans exception)", () => {
    const r = registre([
      bot("yuki", 0, true),
      bot("b2", 1, true),
      bot("b3", 2, true),
      bot("b4", 3, true),
    ]);
    const resolution = resoudreDemarrageBots(r);
    expect(resolution.aDemarrer.map((entree) => entree.id)).toEqual([
      "yuki",
      "b2",
      "b3",
      "b4",
    ]);
    // ⚠️ Plus de champ `refuses`/`plafond` du tout : la notion n'existe plus.
    expect("refuses" in resolution).toBe(false);
    expect("plafond" in resolution).toBe(false);
  });

  it("⚠️ six bots actifs (le MAXIMUM CRÉABLE) ⇒ six démarrages", () => {
    // ⚠️ `MAX_BOTS = 6` reste la borne de CRÉATION (`registry.ts`) : elle ne dit
    // rien du nombre de bots qui TOURNENT. Six créés et actifs ⇒ six démarrages.
    const tous = ["yuki", "b2", "b3", "b4", "b5", "b6"].map((id, index) =>
      bot(id, index, true),
    );
    expect(resoudreDemarrageBots(registre(tous)).aDemarrer.length).toBe(6);
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

  it("⚠️ RÉÉCRIT : le bot du RUN est le premier à DÉMARRER (`yuki` éteinte)", () => {
    // ⚠️ RÉÉCRIT (n'était « PRINCIPAL ≠ DOIT TOURNER : `yuki` reste principal
    // même ÉTEINT ») : le privilège d'identité de `yuki` est SUPPRIMÉ. Le bot du
    // run ne peut plus différer de la liste : c'est son premier élément.
    const r = registre([bot("yuki", 0, false), bot("kohai", 1, true)]);
    const resolution = resoudreDemarrageBots(r);
    expect(resolution.botCourant?.id).toBe("kohai");
    expect(resolution.aDemarrer.map((entree) => entree.id)).toEqual(["kohai"]);
    // `yuki` éteinte n'est PAS rendue : plus d'identité élue à côté du run.
    expect("principal" in resolution).toBe(false);
    // `botActif` applique la même règle (premier par `ordre`), sans privilège.
    expect(botActif(r)?.id).toBe("yuki");
  });

  it("tous les bots éteints ⇒ liste VIDE et AUCUN bot du run", () => {
    const resolution = resoudreDemarrageBots(registre([bot("yuki", 0, false)]));
    expect(resolution.aDemarrer).toEqual([]);
    // Plus d'identité à côté du run : rien ne tourne, donc aucun bot courant.
    expect(resolution.botCourant).toBeNull();
  });
});

describe("③ `preparerMultiBot` : liste et bot du run, sans plafond", () => {
  it("⚠️ GARDE DE NON-RÉGRESSION : 1 bot actif ⇒ comportement IDENTIQUE", () => {
    const f = fixture([creerRegistreInitial().bots[0] as BotRecord]);
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    expect(preparation.mode).toBe("multi");
    expect(preparation.bot.id).toBe("yuki");
    // ⚠️ LOT 45 : plus de « principal » — le bot du run EST le premier à démarrer.
    expect("principal" in preparation).toBe(false);
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki"]);
    expect(preparation.avertissements).toEqual([]);
    // Les chemins restent EXACTEMENT ceux du bot `yuki`.
    const chemins = cheminsBot(f.env, "yuki");
    expect(preparation.env.memoryStorePath).toBe(chemins.fichiers.memoryStorePath);
    expect(preparation.env.piSessionsDir).toBe(chemins.sessions);
    expect(preparation.chemins?.racine).toBe(chemins.racine);
  });

  it("deux bots actifs ⇒ liste de DEUX, bot du run = le premier par `ordre`", () => {
    const f = fixture([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki", "kohai"]);
    expect(preparation.bot.id).toBe("yuki");
  });

  it("⚠️ RÉÉCRIT : `yuki` ÉTEINTE ⇒ bot du run = premier ACTIF, et RIEN à signaler", () => {
    // ⚠️ RÉÉCRIT (n'était « principal ÉTEINT ⇒ … et c'est DIT ») : il n'y a plus
    // deux listes (identité élue vs bots à démarrer), donc plus d'avertissement à
    // donner. Le premier bot actif EST le bot du run, sans commentaire spécial.
    const f = fixture([bot("yuki", 0, false), bot("kohai", 1, true)]);
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    expect(preparation.bot.id).toBe("kohai");
    // Les chemins suivent le bot qui tourne.
    expect(preparation.env.memoryStorePath).toBe(
      cheminsBot(f.env, "kohai").fichiers.memoryStorePath,
    );
    expect(preparation.avertissements).toEqual([]);
  });

  it("⚠️ 4 bots actifs ⇒ les QUATRE démarrent, aucun avertissement de limite", () => {
    // ⚠️ RÉÉCRIT (n'était « plafond dépassé ⇒ les bots en trop ne démarrent
    // pas ») : il n'y a plus de limite, donc plus aucun bot écarté ni nommé.
    const f = fixture([
      bot("yuki", 0, true),
      bot("b2", 1, true),
      bot("b3", 2, true),
      bot("b4", 3, true),
    ]);
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual([
      "yuki",
      "b2",
      "b3",
      "b4",
    ]);
    expect(preparation.avertissements.join("\n")).not.toContain("limite");
  });

  it("⚠️ `YUKI_BOTS_MAX_ACTIFS` n'agit PLUS : les trois bots démarrent quand même", () => {
    // ⚠️ RÉÉCRIT (n'était « le plafond se règle par l'environnement ») : la
    // variable est annoncée comme SANS EFFET, elle n'écarte plus personne.
    const f = fixture([
      bot("yuki", 0, true),
      bot("b2", 1, true),
      bot("b3", 2, true),
    ]);
    const preparation = preparerMultiBot(f.env, {
      processEnv: { YUKI_BOTS_MAX_ACTIFS: "2" },
    });
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki", "b2", "b3"]);
  });

  it("⚠️ une `config.json` qui contient encore `bots.maxActifs` DÉMARRE quand même", () => {
    // ⚠️ Compatibilité assumée : la clé est ignorée (avertissement du store), le
    // démarrage n'échoue pas.
    const f = fixture([bot("yuki", 0, true), bot("b2", 1, true), bot("b3", 2, true)], {
      store: { "bots.maxActifs": 1 },
    });
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki", "b2", "b3"]);
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
