/**
 * LOT 44 — LE PLAFOND DE BOTS EN MARCHE EST SUPPRIMÉ.
 *
 * ⚠️ DÉCISION UTILISATEUR (2026-11-13 12:22) : « retire le plafond. Chacun fait
 * comme il a envie en fonction de ses ressources, limiter c'est mal à mon sens. »
 *
 * Ce que ce fichier verrouille, dans l'ordre de la décision :
 *  ① 4 bots `actif` ⇒ 4 DÉMARRAGES (le cas de l'utilisateur, sans exception) ;
 *  ② `bots.maxActifs` n'est PLUS une clé de configuration (compte ajusté) ;
 *  ③ `definirActif` n'a plus AUCUN refus de plafond (`409 plafond_actifs` mort) ;
 *  ④ une `config.json` qui contient encore la clé démarre quand même (ignorée,
 *    comme les variables d'environnement retirées) ;
 *  ⑤ le garde-fou `409 dernier_bot_actif` est CONSERVÉ (on ne peut pas éteindre
 *    le dernier bot : l'instance ne redémarrerait plus).
 *
 * ⚠️ `MAX_BOTS = 6` reste : c'est le nombre de bots CRÉABLES, pas le nombre qui
 * tournent. Ce sont deux choses différentes (③ ne touche pas à la création).
 *
 * ⚠️ Échoue sur le code d'origine : `bots.maxActifs` y existe (défaut 3), 4 bots
 * actifs n'en démarrent que 3, `definirActif` refuse le 4e en `409
 * plafond_actifs`, et `YUKI_BOTS_MAX_ACTIFS` y règle encore le plafond.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AdminBotError, definirActif } from "../../src/bots/admin.js";
import {
  MAX_BOTS,
  cheminRegistreBots,
  ecrireRegistreBots,
  preparerMultiBot,
  resoudreDemarrageBots,
  type BotRecord,
  type RegistreBots,
} from "../../src/bots/index.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import { CONFIG_PATHS, CONFIG_SCHEMA, envNameOf } from "../../src/config/schema.js";
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
  stateDir: string;
  env: Env;
}

/** Volumes vides + `bots.json` écrit à la main (+ store éventuel). */
function fixture(
  bots: BotRecord[],
  options: { store?: Record<string, unknown> } = {},
): Fixture {
  const racine = mkdtempSync(join(tmpdir(), "yuki-plafond-"));
  racines.push(racine);
  const stateDir = join(racine, "state");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(racine, "pi", "agent", "sessions"), { recursive: true });
  const env = loadEnv({
    YUKI_MOUNT_STATE: stateDir,
    YUKI_MOUNT_PI_AGENT: join(racine, "pi"),
    YUKI_CONFIG_STORE_PATH: join(stateDir, "config.json"),
    YUKI_LOG_LEVEL: "error",
  });
  ecrireRegistreBots(cheminRegistreBots(stateDir), registre(bots));
  if (options.store) new ConfigStore(env.configStorePath).write(options.store);
  return { stateDir, env };
}

describe("① 4 bots `actif` ⇒ 4 DÉMARRAGES (le cas de l'utilisateur)", () => {
  it("la résolution ne tronque RIEN et ne rend aucun refus", () => {
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
    // ⚠️ Les notions `refuses` / `plafond` n'existent plus DU TOUT.
    // ⚠️ GARDE MISE À JOUR (lot 45) : `principal` est devenu `botCourant` — la
    // liste reste la SEULE autre clé (aucun plafond, aucun refus).
    expect(Object.keys(resolution).sort()).toEqual(["aDemarrer", "botCourant"]);
  });

  it("`preparerMultiBot` démarre les QUATRE, sans aucun avertissement de limite", () => {
    const f = fixture([
      bot("yuki", 0, true),
      bot("b2", 1, true),
      bot("b3", 2, true),
      bot("b4", 3, true),
    ]);
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    expect(preparation.aDemarrer).toHaveLength(4);
    expect(preparation.avertissements.join("\n")).not.toContain("limite");
    expect(preparation.avertissements.join("\n")).not.toContain("bots.maxActifs");
  });
});

describe("② `bots.maxActifs` n'est PLUS une clé de configuration", () => {
  // ⚠️ GARDE RÉVISÉE (compte 92 → 93) : `prompts.personnalite` est ajoutée le
  // 2026-11-13 (personnalité séparée du prompt système). Ce que cette garde
  // protège reste inchangé : `bots.maxActifs` n'est PAS revenue.
  it("la clé, sa variable et sa portée ont disparu (compte : 93)", () => {
    expect(CONFIG_SCHEMA["bots.maxActifs"]).toBeUndefined();
    expect(CONFIG_PATHS).not.toContain("bots.maxActifs");
    expect(envNameOf("bots.maxActifs")).toBeUndefined();
    expect(CONFIG_PATHS.length).toBe(93);
  });

  it("⚠️ `MAX_BOTS = 6` reste : bots CRÉABLES ≠ bots qui tournent", () => {
    // ⚠️ Ne pas confondre les deux : la création reste bornée à 6 (registre),
    // le démarrage ne l'est plus du tout.
    expect(MAX_BOTS).toBe(6);
  });
});

describe("③ `definirActif` n'a plus AUCUN refus de plafond", () => {
  it("allumer un 5e bot écrit le registre (aucune exception)", () => {
    const f = fixture([
      bot("yuki", 0, true),
      bot("b2", 1, true),
      bot("b3", 2, true),
      bot("b4", 3, true),
      bot("b5", 4, false),
    ]);
    const registreCourant = registre([
      bot("yuki", 0, true),
      bot("b2", 1, true),
      bot("b3", 2, true),
      bot("b4", 3, true),
      bot("b5", 4, false),
    ]);
    const resultat = definirActif({
      stateDir: f.stateDir,
      registre: registreCourant,
      botId: "b5",
      actif: true,
    });
    expect(resultat.actif).toBe(true);
    expect(resultat.actifs).toEqual(["yuki", "b2", "b3", "b4", "b5"]);
    // Aucun champ `plafond` dans la réponse : la notion a disparu.
    expect("plafond" in resultat).toBe(false);
  });

  it("le code `plafond_actifs` n'est plus produit par AUCUN cas", () => {
    const f = fixture([bot("yuki", 0, true), bot("b2", 1, false)]);
    let refus: unknown;
    try {
      definirActif({
        stateDir: f.stateDir,
        registre: registre([bot("yuki", 0, true), bot("b2", 1, false)]),
        botId: "b2",
        actif: true,
      });
    } catch (error) {
      refus = error;
    }
    expect(refus).toBeUndefined();
  });
});

describe("④ une `config.json` qui contient encore `bots.maxActifs` démarre", () => {
  it("la clé est IGNORÉE (avertissement) : les 3 bots actifs démarrent", () => {
    const f = fixture([bot("yuki", 0, true), bot("b2", 1, true), bot("b3", 2, true)], {
      store: { "bots.maxActifs": 1 },
    });
    const preparation = preparerMultiBot(f.env, { processEnv: {} });
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki", "b2", "b3"]);
  });

  it("⚠️ `YUKI_BOTS_MAX_ACTIFS` non plus : elle n'agit plus et les 3 démarrent", () => {
    const f = fixture([bot("yuki", 0, true), bot("b2", 1, true), bot("b3", 2, true)]);
    const preparation = preparerMultiBot(f.env, {
      processEnv: { YUKI_BOTS_MAX_ACTIFS: "1" },
    });
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki", "b2", "b3"]);
  });
});

describe("⑤ le garde-fou `409 dernier_bot_actif` est CONSERVÉ", () => {
  it("éteindre le dernier bot actif est toujours refusé (409)", () => {
    const f = fixture([bot("yuki", 0, true), bot("b2", 1, false)]);
    let refus: unknown;
    try {
      definirActif({
        stateDir: f.stateDir,
        registre: registre([bot("yuki", 0, true), bot("b2", 1, false)]),
        botId: "yuki",
        actif: false,
      });
    } catch (error) {
      refus = error;
    }
    expect(refus).toBeInstanceOf(AdminBotError);
    expect((refus as AdminBotError).code).toBe("dernier_bot_actif");
    expect((refus as AdminBotError).status).toBe(409);
  });
});
