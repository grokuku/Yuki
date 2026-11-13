/**
 * LOT 36 (L3-a) — LA CONFIGURATION PAR BOT.
 *
 * Ce que ce fichier verrouille :
 *  - `creerConfigBot(botId)` rend un runtime LIÉ à ce bot : deux bots ⇒ deux
 *    runtimes, deux overlays, deux ensembles de valeurs ;
 *  - `creerConfigsBots` construit la Map des bots À DÉMARRER (L1) plus le bot de
 *    la PILE, et **pas** ceux que le plafond a refusés ;
 *  - ⚠️ GARDE DE NON-RÉGRESSION : avec UN bot actif, la Map rend EXACTEMENT la
 *    configuration que `main()` construisait avant ce morceau (instantané
 *    complet : 90 clés, origines, défauts, portées, verrou d'environnement) ;
 *  - écrire l'overlay d'un bot ne change NI la valeur du principal, NI le store
 *    commun, NI l'overlay du principal ;
 *  - un identifiant invalide est REFUSÉ (il devient un nom de dossier).
 *
 * ⚠️ Échoue sur le code d'origine : `src/config/bots.ts` n'existe pas (ni
 * `creerConfigBot`, ni `creerConfigsBots`) — `main()` y construit un seul
 * runtime et la configuration des autres bots n'existe pas.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cheminRegistreBots,
  ecrireRegistreBots,
  preparerMultiBot,
  resoudreDemarrageBots,
  type BotRecord,
  type RegistreBots,
} from "../../src/bots/index.js";
import { BotIdInvalideError, creerConfigBot, creerConfigsBots } from "../../src/config/bots.js";
import { ConfigOverlayStore } from "../../src/config/overlay.js";
import { createConfigRuntime } from "../../src/config/runtime.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import { ConfigStore } from "../../src/config/store.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

/** Défauts de prompts « livrés » (mêmes pour TOUS les bots : fichiers globaux). */
const PROMPTS = { light: "prompt livré léger", heavy: "prompt livré lourd" };

interface Banc {
  racine: string;
  state: string;
  env: Env;
  /** Environnement de surcharge (vide = aucune surcharge). */
  processEnv: NodeJS.ProcessEnv;
}

function banc(processEnv: NodeJS.ProcessEnv = {}): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-config-bots-"));
  racines.push(racine);
  const state = join(racine, "state");
  mkdirSync(state, { recursive: true });
  const env = loadEnv({
    YUKI_MOUNT_STATE: state,
    YUKI_CONFIG_STORE_PATH: join(state, "config.json"),
    YUKI_PI_SYSTEM_PROMPT: join(racine, "light.md"),
    YUKI_PI_HEAVY_SYSTEM_PROMPT: join(racine, "heavy.md"),
    YUKI_LOG_LEVEL: "error",
  });
  return { racine, state, env, processEnv };
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

/** Volumes vides + `bots.json` écrit à la main (comme `tests/bots/actifs.test.ts`). */
function fixture(bots: BotRecord[], options: { store?: Record<string, unknown> } = {}): Banc {
  const b = banc({});
  mkdirSync(join(b.racine, "pi", "agent", "sessions"), { recursive: true });
  b.env = loadEnv({
    YUKI_MOUNT_STATE: b.state,
    YUKI_MOUNT_PI_AGENT: join(b.racine, "pi"),
    YUKI_CONFIG_STORE_PATH: join(b.state, "config.json"),
    YUKI_PI_SYSTEM_PROMPT: join(b.racine, "light.md"),
    YUKI_PI_HEAVY_SYSTEM_PROMPT: join(b.racine, "heavy.md"),
    YUKI_LOG_LEVEL: "error",
  });
  ecrireRegistreBots(cheminRegistreBots(b.state), registre(bots));
  if (options.store) new ConfigStore(b.env.configStorePath).write(options.store);
  return b;
}

describe("① `creerConfigBot` : un runtime PAR BOT", () => {
  it("deux bots ⇒ deux runtimes distincts, deux overlays distincts", () => {
    const b = banc();
    const yuki = creerConfigBot("yuki", { env: b.env, promptDefaults: PROMPTS, processEnv: {} });
    const kohai = creerConfigBot("kohai", { env: b.env, promptDefaults: PROMPTS, processEnv: {} });

    expect(yuki).not.toBe(kohai);
    expect(yuki.botId).toBe("yuki");
    expect(kohai.botId).toBe("kohai");
    expect(yuki.overlayPath).toBe(join(b.state, "bots", "yuki", "config.overlay.json"));
    expect(kohai.overlayPath).toBe(join(b.state, "bots", "kohai", "config.overlay.json"));
    expect(yuki.overlayPath).not.toBe(kohai.overlayPath);
    // Aucun overlay n'existe encore : la simple construction n'écrit RIEN.
    expect(new ConfigOverlayStore(yuki.overlayPath).exists()).toBe(false);
    expect(new ConfigOverlayStore(kohai.overlayPath).exists()).toBe(false);
  });

  it("deux overlays, deux VALEURS : la même clé `bot` diverge d'un bot à l'autre", () => {
    const b = banc();
    const yuki = creerConfigBot("yuki", { env: b.env, promptDefaults: PROMPTS, processEnv: {} });
    const kohai = creerConfigBot("kohai", { env: b.env, promptDefaults: PROMPTS, processEnv: {} });

    // Au départ, même store commun, aucun overlay ⇒ valeurs identiques.
    expect(yuki.getString("chat.mode")).toBe("local");
    expect(kohai.getString("chat.mode")).toBe("local");

    kohai.update({ "chat.mode": "mattermost", "tts.voice": "voix-kohai" });

    expect(kohai.getString("chat.mode")).toBe("mattermost");
    expect(kohai.getString("tts.voice")).toBe("voix-kohai");
    expect(yuki.getString("chat.mode")).toBe("local");
    expect(yuki.getString("tts.voice")).toBe("");

    // Chaque runtime écrit dans SON fichier, et la valeur est bien persistée.
    expect(new ConfigOverlayStore(kohai.overlayPath).load().values).toEqual({
      "chat.mode": "mattermost",
      "tts.voice": "voix-kohai",
    });
    expect(new ConfigOverlayStore(yuki.overlayPath).exists()).toBe(false);
    // Le store COMMUN (instance) n'a reçu AUCUNE clé de bot.
    expect(new ConfigStore(b.env.configStorePath).load().values).toEqual({});
  });

  it("un identifiant invalide est REFUSÉ (l'identifiant devient un nom de dossier)", () => {
    const b = banc();
    expect(() => creerConfigBot("", { env: b.env })).toThrow(BotIdInvalideError);
    expect(() => creerConfigBot("../evade", { env: b.env })).toThrow(BotIdInvalideError);
    expect(() => creerConfigBot("Yuki", { env: b.env })).toThrow(BotIdInvalideError);
    expect(() => creerConfigBot("yuki/../autre", { env: b.env })).toThrow(BotIdInvalideError);
  });
});

/** Clés REPRÉSENTATIVES : `instance` (+ `env`), `bot`, `mixte` (`et` et `surcharge`). */
const CLES_REPRESENTATIVES = [
  "llm.light.model", // instance, verrouillable par l'environnement
  "transport.replayBuffer", // instance
  "chat.mode", // bot
  "tts.voice", // bot
  "memory.recall.topK", // bot
  "memory.enabled", // bot
  "prompts.light", // mixte + surcharge
  "tts.enabled", // mixte + et
  "push.enabled", // mixte + et
] as const;

describe("② GARDE DE NON-RÉGRESSION : 1 bot actif ⇒ valeurs IDENTIQUES", () => {
  it("la Map rend EXACTEMENT la configuration construite par `main()` avant L3-a", () => {
    const b = fixture([bot("yuki", 0, true)], {
      store: {
        "chat.mode": "mattermost",
        "tts.voice": "voix-store",
        "memory.recall.topK": 9,
        "prompts.light": "prompt du store",
        "tts.enabled": "off",
        "push.enabled": "on",
        "transport.replayBuffer": 250,
      },
    });
    // Overlay du bot `yuki` (état hérité d'un réglage précédent).
    new ConfigOverlayStore(join(b.state, "bots", "yuki", "config.overlay.json")).write({
      "chat.mode": "discord",
      "tts.enabled": "on",
    });
    // Le principal est verrouillé par l'environnement sur une clé d'instance.
    const processEnv: NodeJS.ProcessEnv = { YUKI_LLM_LIGHT_MODEL: "modele-verrouille" };

    const preparation = preparerMultiBot(b.env, { processEnv });
    expect(preparation.bot?.id).toBe("yuki");
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki"]);

    // Ce que `main()` fait MAINTENANT (L3-a).
    const configs = creerConfigsBots({
      env: preparation.env,
      bots: preparation.aDemarrer.map((entree) => entree.id),
      pile: preparation.bot?.id ?? "",
      promptDefaults: PROMPTS,
      processEnv,
    });
    const principal = configs.get("yuki");
    expect(principal).toBeDefined();

    // Ce que `main()` faisait AVANT (code d'origine, à l'identique).
    const avant = createConfigRuntime({
      env: preparation.env,
      botId: preparation.bot?.id ?? "",
      promptDefaults: PROMPTS,
      processEnv,
    });

    expect(principal?.botId).toBe(avant.botId);
    expect(principal?.overlayPath).toBe(avant.overlayPath);
    expect(principal?.warnings).toEqual(avant.warnings);
    for (const cle of CLES_REPRESENTATIVES) {
      expect(principal?.get(cle), cle).toBe(avant.get(cle));
      expect(principal?.originOf(cle), cle).toBe(avant.originOf(cle));
    }
    // Les clés réellement renseignées sont bien celles attendues (sinon la garde
    // ne prouverait rien : deux défauts identiques se comparent toujours bien).
    expect(principal?.getString("chat.mode")).toBe("discord"); // overlay du bot
    expect(principal?.getString("tts.voice")).toBe("voix-store"); // repli store
    expect(principal?.getNumber("memory.recall.topK")).toBe(9);
    expect(principal?.getNumber("transport.replayBuffer")).toBe(250);
    expect(principal?.getString("tts.enabled")).toBe("off"); // conjonction : instance `off`
    expect(principal?.getString("push.enabled")).toBe("on");
    expect(principal?.getString("llm.light.model")).toBe("modele-verrouille");
    expect(principal?.originOf("llm.light.model")).toBe("env");
    expect(principal?.isLockedByEnv("llm.light.model")).toBe(true);
    expect(principal?.getString("prompts.light")).toBe("prompt du store");
    // ⚠️ L'instantané COMPLET (91 clés : valeurs, origines, défauts, portées,
    // verrous) doit être rigoureusement le même.
    expect(principal?.snapshot()).toEqual(avant.snapshot());
  });
});

describe("③ la Map couvre TOUS les bots À DÉMARRER (plus de plafond)", () => {
  it("⚠️ 4 bots actifs ⇒ 4 runtimes (aucun bot écarté)", () => {
    // ⚠️ RÉÉCRIT (n'était « plafond 3 avec 4 bots actifs ⇒ 3 runtimes, le refusé
    // ABSENT ») : le plafond est supprimé, les quatre bots ont leur configuration.
    const b = banc();
    const resolution = resoudreDemarrageBots(
      registre([
        bot("yuki", 0, true),
        bot("b2", 1, true),
        bot("b3", 2, true),
        bot("b4", 3, true),
      ]),
    );
    expect(resolution.aDemarrer.map((entree) => entree.id)).toEqual([
      "yuki",
      "b2",
      "b3",
      "b4",
    ]);

    const configs = creerConfigsBots({
      env: b.env,
      bots: resolution.aDemarrer.map((entree) => entree.id),
      pile: resolution.principal?.id ?? "",
      promptDefaults: PROMPTS,
      processEnv: {},
    });

    expect([...configs.keys()]).toEqual(["yuki", "b2", "b3", "b4"]);
    expect(configs.size).toBe(4);
    for (const entree of resolution.aDemarrer) {
      expect(configs.get(entree.id)?.botId).toBe(entree.id);
    }
  });

  it("le bot de la PILE est TOUJOURS présent (mode mono : aucun bot à démarrer)", () => {
    const b = banc();
    const configs = creerConfigsBots({
      env: b.env,
      bots: [],
      pile: "yuki",
      promptDefaults: PROMPTS,
      processEnv: {},
    });
    expect([...configs.keys()]).toEqual(["yuki"]);
    expect(configs.get("yuki")?.botId).toBe("yuki");
  });

  it("un identifiant répété n'est construit qu'UNE fois (un seul runtime par bot)", () => {
    const b = banc();
    const configs = creerConfigsBots({
      env: b.env,
      bots: ["yuki", "kohai", "yuki"],
      pile: "yuki",
      promptDefaults: PROMPTS,
      processEnv: {},
    });
    expect([...configs.keys()]).toEqual(["yuki", "kohai"]);
    expect(configs.size).toBe(2);
  });
});

describe("④ écrire l'overlay d'un bot ne touche PAS le principal", () => {
  it("valeur, store commun et fichier du principal restent intacts", () => {
    const b = banc();
    const configs = creerConfigsBots({
      env: b.env,
      bots: ["yuki", "kohai"],
      pile: "yuki",
      promptDefaults: PROMPTS,
      processEnv: {},
    });
    const principal = configs.get("yuki");
    const second = configs.get("kohai");
    expect(principal).toBeDefined();
    expect(second).toBeDefined();
    if (!principal || !second) return;

    // Valeur de référence du principal sur les trois portées.
    const avant = {
      chat: principal.getString("chat.mode"),
      tts: principal.getString("tts.enabled"),
      push: principal.getString("push.enabled"),
    };

    const resultat = second.update({
      "chat.mode": "discord",
      "tts.voice": "voix-kohai",
      "tts.enabled": "on",
    });
    expect(resultat.changes.map((change) => change.path).sort()).toEqual([
      "chat.mode",
      "tts.enabled",
      "tts.voice",
    ]);

    // Le principal n'a pas bougé…
    expect(principal.getString("chat.mode")).toBe(avant.chat);
    expect(principal.getString("tts.enabled")).toBe(avant.tts);
    expect(principal.getString("push.enabled")).toBe(avant.push);
    // …ni son overlay (aucun fichier), ni le store commun.
    expect(new ConfigOverlayStore(principal.overlayPath).exists()).toBe(false);
    expect(new ConfigStore(b.env.configStorePath).load().values).toEqual({});

    // Relu depuis le DISQUE par un runtime neuf : chacun garde sa valeur.
    const reluPrincipal = creerConfigBot("yuki", {
      env: b.env,
      promptDefaults: PROMPTS,
      processEnv: {},
    });
    const reluSecond = creerConfigBot("kohai", {
      env: b.env,
      promptDefaults: PROMPTS,
      processEnv: {},
    });
    expect(reluPrincipal.getString("chat.mode")).toBe(avant.chat);
    expect(reluSecond.getString("chat.mode")).toBe("discord");
    expect(reluSecond.getString("tts.enabled")).toBe("on");
    // La conjonction `et` reste une restriction : le côté instance est ABSENT,
    // donc neutre — le bot peut l'activer.
    expect(reluPrincipal.getString("tts.enabled")).toBe(avant.tts);
  });
});
