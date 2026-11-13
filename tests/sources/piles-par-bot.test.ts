/**
 * LOT 36 (L3-c) — PILES SOURCES / ENVOIS / PRÉ-AUTORISATIONS **PAR BOT**.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/sources/pile-bot.ts`
 * n'existe pas (ni `FabriquePilesSources`, ni `creerResolveurEnvBot`), la pile
 * d'un bot ne portait ni `config` (L3-a) ni `outils` (L3-b), et le balayeur
 * itérait sur TOUS les bots `actif: true` du registre au lieu de la décision de
 * démarrage.
 *
 * Ce qui est VERROUILLÉ ici :
 *  ① GARDE DE NON-RÉGRESSION FORTE : avec UN bot, la pile du principal est
 *    EXACTEMENT celle d'avant — mêmes objets (`===`), même `Env`, mêmes chemins,
 *    et la fabrique ne RECONSTRUIT rien ;
 *  ② deux bots à démarrer ⇒ deux piles DISTINCTES (son `Env`, sa configuration,
 *    ses stores, ses envois), et les fichiers de l'un ne reçoivent rien de l'autre ;
 *  ③ `envPourBot` n'est appliqué qu'UNE fois par bot, et les deux fabriques
 *    (piles L3-c, outils L3-b) reçoivent le MÊME objet `Env` ;
 *  ④ le balayeur voit UNE cible par bot à DÉMARRER (décision L1), jamais une par
 *    bot du registre ;
 *  ⑤ un bot ÉTEINT n'a PAS de pile (et ses déclencheurs ne tirent pas) ; un bot
 *    ABSENT du registre est refusé (`bot_inconnu`), jamais ouvert. ⚠️ Plus aucun
 *    « bot refusé par le plafond » : le plafond n'existe plus (2026-11-13).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PreAutorisationStore } from "../../src/agents/preautorisations.js";
import { agentAutorisePourBot } from "../../src/agents/types.js";
import { creerOutilsBots } from "../../src/bots/outils.js";
import { cheminsBot, pathsForBot } from "../../src/bots/paths.js";
import { CAPACITES_BOT, type BotRecord, type RegistreBots } from "../../src/bots/registry.js";
import { creerConfigsBots } from "../../src/config/bots.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import type { ConfigRuntime } from "../../src/config/runtime.js";
import { EnvoisProgrammesService } from "../../src/chat/envois/index.js";
import { EnvoisProgrammesStore } from "../../src/chat/envois/store.js";
import { FabriqueMemoireBots } from "../../src/memory/stores-bot.js";
import { SourcesInbox } from "../../src/sources/inbox.js";
import { DeclencheurJournal } from "../../src/sources/journal.js";
import { SourcesParBot, filtreAgentVisible, nomsSecretsSource } from "../../src/sources/par-bot.js";
import {
  FabriquePilesSources,
  creerResolveurEnvBot,
  type ObjetsPileSources,
} from "../../src/sources/pile-bot.js";
import { SourcesService, type SourcesTokenVault } from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

const journal = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Prompts livrés (mêmes défauts pour tous les bots : fichiers globaux). */
const PROMPTS = { light: "prompt livré léger", heavy: "prompt livré lourd" };

interface Banc {
  state: string;
  /** `Env` d'INSTANCE (jamais dérivé par bot). */
  env: Env;
  processEnv: NodeJS.ProcessEnv;
}

function banc(): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-piles-bot-"));
  racines.push(racine);
  const state = join(racine, "state");
  mkdirSync(state, { recursive: true });
  mkdirSync(join(racine, "pi", "agent", "sessions"), { recursive: true });
  const processEnv: NodeJS.ProcessEnv = {};
  const env = loadEnv({
    YUKI_MOUNT_STATE: state,
    YUKI_MOUNT_PI_AGENT: join(racine, "pi"),
    YUKI_CONFIG_STORE_PATH: join(state, "config.json"),
    YUKI_LOG_LEVEL: "error",
  });
  return { state, env, processEnv };
}

function bot(id: string, ordre: number, actif: boolean, capacites = CAPACITES_BOT): BotRecord {
  return {
    id,
    nom: id,
    capacites: [...capacites],
    actif,
    ordre,
    creeLe: "2026-01-01T00:00:00.000Z",
    plateformes: {},
  };
}

/** Coffre de jetons en mémoire (aucun disque, aucun secret réel). */
class FakeVault implements SourcesTokenVault {
  readonly entrees = new Map<string, string>();
  isConfigured(): boolean {
    return true;
  }
  lookup(nom: string): string | undefined {
    return this.entrees.get(nom);
  }
  has(nom: string): boolean {
    return this.entrees.has(nom);
  }
  set(nom: string, valeur: string): unknown {
    this.entrees.set(nom, valeur);
    return { nom };
  }
  delete(nom: string): boolean {
    return this.entrees.delete(nom);
  }
}

/**
 * Ouvre les objets d'un bot SUR SON `Env` — exactement ce que `main()` fait pour
 * un bot autre que la pile (mêmes constructeurs, chemins pris dans l'`Env`).
 */
function objetsBot(envBot: Env, botId: string, vault?: SourcesTokenVault): ObjetsPileSources {
  const store = new SourcesStore({ path: envBot.sourcesStorePath, logger: journal });
  const inbox = new SourcesInbox({ path: envBot.sourcesInboxPath, logger: journal });
  const jrn = DeclencheurJournal.open({ path: envBot.declencheursJournalPath, logger: journal });
  const preAutorisations = new PreAutorisationStore({
    path: envBot.preAutorisationsPath,
    logger: journal,
    journal: jrn,
    botId,
    agentAutorise: filtreAgentVisible(undefined, botId, agentAutorisePourBot),
  });
  const service = new SourcesService({
    store,
    inbox,
    journal: jrn,
    logger: journal,
    ...(vault ? { tokens: vault } : {}),
    secretNames: (nom) => nomsSecretsSource(botId, nom),
    promptTotalChars: () => 4_000,
  });
  const envois = new EnvoisProgrammesService({
    store: EnvoisProgrammesStore.open({ path: envBot.envoisProgrammesPath, logger: journal }),
    journal: jrn,
    canaux: () => [],
    fichier: () => null,
    maxFichierBytes: () => 1_000_000,
    publier: async () => undefined,
    logger: journal,
  });
  return { store, inbox, journal: jrn, preAutorisations, service, envois };
}

/** Outils factices : seule l'IDENTITÉ compte ici (`pile.outils`). */
type OutilsFactices = { chemins: { memoryStorePath: string } };

interface OptionsFabriqueTest {
  construire?: (input: { botId: string; envBot: Env; config?: ConfigRuntime }) => ObjetsPileSources;
  resoudre?: (input: { envInstance: Env; botId: string }) => Env;
}

/** Fabrique du démarrage : pile `yuki`, deux configurations, relais d'outils. */
function fabriqueDeTest(b: Banc, options: OptionsFabriqueTest = {}) {
  const configs = creerConfigsBots({
    env: b.env,
    bots: ["second"],
    pile: "yuki",
    promptDefaults: PROMPTS,
    processEnv: b.processEnv,
  });
  const envs = creerResolveurEnvBot({
    envInstance: b.env,
    mode: "multi",
    pile: "yuki",
    envPile: b.env,
    processEnv: b.processEnv,
    ...(options.resoudre ? { resoudre: options.resoudre } : {}),
  });
  const existants = objetsBot(b.env, "yuki");
  const outils = new Map<string, OutilsFactices>();
  const fabrique = new FabriquePilesSources({
    pile: "yuki",
    envPile: b.env,
    envs,
    configPour: (botId) => configs.get(botId),
    outilsPour: (botId) => outils.get(botId) as never,
    existantsPile: existants,
    construire:
      options.construire ??
      (({ botId, envBot }) => {
        outils.set(botId, { chemins: { memoryStorePath: envBot.memoryStorePath } });
        return objetsBot(envBot, botId);
      }),
    logger: journal,
  });
  return { fabrique, existants, configs, envs, outils };
}

// ── ① Garde de non-régression : 1 bot ⇒ la pile d'AVANT ────────────────────

describe("pile du PRINCIPAL (lot 36, L3-c)", () => {
  it("rend EXACTEMENT les objets déjà construits, sans rien reconstruire", () => {
    const b = banc();
    const { fabrique, existants } = fabriqueDeTest(b, {
      construire: () => {
        throw new Error("la pile du principal ne doit JAMAIS être reconstruite");
      },
    });

    const pile = fabrique.ouvrir("yuki");

    // ⚠️ IDENTITÉ : ce sont les objets de `main()`, pas des copies.
    expect(pile.store).toBe(existants.store);
    expect(pile.inbox).toBe(existants.inbox);
    expect(pile.journal).toBe(existants.journal);
    expect(pile.preAutorisations).toBe(existants.preAutorisations);
    expect(pile.service).toBe(existants.service);
    expect(pile.envois).toBe(existants.envois);
    // ⚠️ L'`Env` est celui du démarrage (`preparerMultiBot`), pas un recalcul.
    expect(pile.env).toBe(b.env);
    // Et les CHEMINS sont ceux d'aujourd'hui (mode mono / multi à un bot).
    expect(pile.env.sourcesStorePath).toBe(join(b.state, "sources.json"));
    expect(pile.env.sourcesInboxPath).toBe(join(b.state, "sources-inbox.json"));
    expect(pile.env.preAutorisationsPath).toBe(join(b.state, "preautorisations.json"));
    expect(pile.env.envoisProgrammesPath).toBe(join(b.state, "envois-programmes.json"));
    expect(fabrique.ouvrir("yuki")).toBe(pile);
  });

  it("porte SA configuration (L3-a) et SES outils (L3-b), par identité", () => {
    const b = banc();
    const { fabrique, configs, outils } = fabriqueDeTest(b);
    const pile = fabrique.ouvrir("yuki");

    // `config` EST l'entrée de la Map du bot de la pile : jamais un 2e runtime.
    expect(pile.config).toBe(configs.get("yuki"));
    expect(pile.config?.botId).toBe("yuki");
    // Les outils sont lus PARESSEUSEMENT (la Map L3-b naît APRÈS la pile)…
    expect(pile.outils).toBeUndefined();
    const outilsPile: OutilsFactices = { chemins: { memoryStorePath: b.env.memoryStorePath } };
    outils.set("yuki", outilsPile);
    // … et l'identité suit la Map, sans réouvrir la pile.
    expect(pile.outils).toBe(outilsPile as never);
  });
});

// ── ② Deux bots ⇒ deux piles DISTINCTES ────────────────────────────────────

describe("deux bots à démarrer (lot 36, L3-c)", () => {
  it("chacun a SON Env, SON store, SON journal, SES pré-autorisations, SES envois", () => {
    const b = banc();
    const { fabrique, existants, outils } = fabriqueDeTest(b);

    const yuki = fabrique.ouvrir("yuki");
    const second = fabrique.ouvrir("second");

    expect(second).not.toBe(yuki);
    expect(second.env).not.toBe(yuki.env);
    // Les chemins suivent `pathsForBot` : `<state>/bots/second/…`.
    const racineSecond = cheminsBot(b.env, "second").racine;
    expect(second.env.sourcesStorePath).toBe(join(racineSecond, "sources.json"));
    expect(second.env.preAutorisationsPath).toBe(join(racineSecond, "preautorisations.json"));
    expect(second.env.envoisProgrammesPath).toBe(join(racineSecond, "envois-programmes.json"));

    // Aucun objet partagé avec la pile.
    expect(second.store).not.toBe(existants.store);
    expect(second.inbox).not.toBe(existants.inbox);
    expect(second.journal).not.toBe(existants.journal);
    expect(second.preAutorisations).not.toBe(existants.preAutorisations);
    expect(second.service).not.toBe(existants.service);
    expect(second.envois).not.toBe(existants.envois);

    // Chaque pile a SA configuration (deux overlays, deux jeux de valeurs)…
    expect(second.config).not.toBe(yuki.config);
    expect(second.config?.botId).toBe("second");
    expect(yuki.config?.botId).toBe("yuki");
    // … et SES outils (la Map L3-b), jamais ceux du principal.
    expect(second.outils).toBe(outils.get("second") as never);
    expect(second.outils).not.toBe(outils.get("yuki") as never);
    expect(fabrique.ouvrir("second")).toBe(second);
  });

  it("écrire une source chez un bot ne touche PAS le fichier de l'autre", () => {
    const b = banc();
    const { fabrique } = fabriqueDeTest(b);
    (fabrique.ouvrir("second").store as SourcesStore).create("news", { tour: "stocker" } as never);
    (fabrique.ouvrir("yuki").store as SourcesStore).create("veille", { tour: "stocker" } as never);

    const jsonSecond = readFileSync(
      join(cheminsBot(b.env, "second").racine, "sources.json"),
      "utf8",
    );
    const jsonYuki = readFileSync(join(b.state, "sources.json"), "utf8");
    expect(jsonSecond).toContain("news");
    expect(jsonSecond).not.toContain("veille");
    expect(jsonYuki).toContain("veille");
    expect(jsonYuki).not.toContain("news");
  });
});

// ── ③ `envPourBot` : une seule fois par bot ────────────────────────────────

describe("résolution de l'Env par bot (lot 36, L3-c)", () => {
  it("applique `envPourBot` UNE fois par bot, et jamais pour la pile", () => {
    const b = banc();
    const appels: string[] = [];
    const { fabrique } = fabriqueDeTest(b, {
      resoudre: ({ envInstance, botId }) => {
        appels.push(botId);
        return pathsForBot(envInstance, botId, { processEnv: {} }).env;
      },
    });

    const second = fabrique.ouvrir("second");
    expect(fabrique.ouvrir("second")).toBe(second);
    expect(fabrique.ouvrir("yuki").env).toBe(b.env);

    expect(appels).toEqual(["second"]);
    const attendu = pathsForBot(b.env, "second", { processEnv: {} }).env;
    expect(second.env.piSessionsDir).toBe(attendu.piSessionsDir);
    // ⚠️ Aucun `<bot>/<bot>` : la base est l'`Env` d'INSTANCE.
    expect(second.env.piSessionsDir.endsWith(join("second", "second"))).toBe(false);
    expect(second.env.piSessionsDir.endsWith("second")).toBe(true);
  });

  it("les OUTILS (L3-b) reçoivent le MÊME `Env` que la pile (aucune 2e résolution)", () => {
    const b = banc();
    const appels: string[] = [];
    const envs = creerResolveurEnvBot({
      envInstance: b.env,
      mode: "multi",
      pile: "yuki",
      envPile: b.env,
      processEnv: b.processEnv,
      resoudre: ({ envInstance, botId }) => {
        appels.push(botId);
        return pathsForBot(envInstance, botId, { processEnv: {} }).env;
      },
    });
    const memoire = new FabriqueMemoireBots({
      envInstance: b.env,
      mode: "multi",
      logger: journal,
    });
    try {
      const outils = creerOutilsBots({
        envInstance: b.env,
        mode: "multi",
        bots: ["second"],
        pile: "yuki",
        fabrique: memoire,
        resoudreEnvBot: (botId) => envs.pour(botId),
        processEnv: b.processEnv,
        logger: journal,
      });

      const fabrique = new FabriquePilesSources({
        pile: "yuki",
        envPile: b.env,
        envs,
        construire: ({ botId, envBot }) => objetsBot(envBot, botId),
        existantsPile: objetsBot(b.env, "yuki"),
        logger: journal,
      });
      const pileSecond = fabrique.ouvrir("second");

      // ⚠️ LE MÊME objet `Env` des deux côtés, et une seule résolution.
      expect(pileSecond.env).toBe(outils.get("second")?.env);
      expect(appels).toEqual(["second"]);
    } finally {
      memoire.fermerTout();
    }
  });
});

// ── ④ / ⑤ Balayeur : une cible par bot À DÉMARRER ──────────────────────────

interface HarnaisBalayeur {
  envInstance: Env;
  parBot: SourcesParBot;
  fabrique: FabriquePilesSources;
}

function harnaisBalayeur(options: {
  bots: BotRecord[];
  aDemarrer: string[];
}): HarnaisBalayeur {
  const b = banc();
  const registre: RegistreBots = {
    schemaVersion: 1,
    majLe: "2026-11-10T00:00:00.000Z",
    botActif: options.bots.find((entree) => entree.actif)?.id ?? "yuki",
    bots: options.bots,
    echanges: {},
  } as RegistreBots;
  const vault = new FakeVault();
  const parBot = new SourcesParBot({
    envInstance: b.env,
    mode: "multi",
    registre: () => registre,
    coffre: vault,
    demarrage: () => ({ aDemarrer: options.aDemarrer }),
    logger: journal,
  });
  const fabrique = new FabriquePilesSources({
    pile: "yuki",
    envPile: b.env,
    envs: creerResolveurEnvBot({
      envInstance: b.env,
      mode: "multi",
      pile: "yuki",
      envPile: b.env,
      processEnv: b.processEnv,
    }),
    construire: ({ botId, envBot }) => objetsBot(envBot, botId, vault),
    existantsPile: objetsBot(b.env, "yuki", vault),
    logger: journal,
  });
  parBot.setPileActive(fabrique.ouvrir("yuki"));
  parBot.setOuvrir((input) => fabrique.ouvrir(input.botId));
  return { envInstance: b.env, parBot, fabrique };
}

describe("balayeur : ce que le démarrage a retenu (lot 36, L3-c)", () => {
  it("UNE cible par bot à DÉMARRER, jamais une par bot du registre", () => {
    const h = harnaisBalayeur({
      bots: [bot("yuki", 0, true), bot("second", 1, true), bot("troisieme", 2, true)],
      aDemarrer: ["yuki", "second"],
    });

    const cibles = h.parBot.ciblesBalayage();
    expect(cibles.map((cible) => cible.botId)).toEqual(["yuki", "second"]);
    // Chaque cible balaie SES sources (le store de sa pile, pas celui d'un autre).
    expect(cibles[1]?.store).toBe(h.fabrique.ouvrir("second").store);
  });

  it("un bot à démarrer mais ÉTEINT depuis (L2) n'est plus balayé", () => {
    const h = harnaisBalayeur({
      bots: [bot("yuki", 0, true), bot("second", 1, false)],
      aDemarrer: ["yuki", "second"],
    });
    expect(h.parBot.ciblesBalayage().map((cible) => cible.botId)).toEqual(["yuki"]);
  });

  it("un bot SANS capacité pertinente n'est pas balayé (règle du lot 35j)", () => {
    const h = harnaisBalayeur({
      bots: [
        bot("yuki", 0, true),
        bot("second", 1, true, ["accueil"] as unknown as BotRecord["capacites"]),
      ],
      aDemarrer: ["yuki", "second"],
    });
    expect(h.parBot.ciblesBalayage().map((cible) => cible.botId)).toEqual(["yuki"]);
  });

  it("⚠️ un bot ABSENT du registre n'a ni pile ni cible, ni fichier ouvert", () => {
    // ⚠️ RÉÉCRIT (n'était « un bot REFUSÉ par le plafond… ») : le plafond et son
    // refus `bot_refuse` ont été SUPPRIMÉS (décision utilisateur du 2026-11-13).
    // La garde qui reste est celle de LECTURE : on n'ouvre jamais le dossier d'un
    // bot qui n'existe pas (`bot_inconnu`).
    const h = harnaisBalayeur({
      bots: [bot("yuki", 0, true), bot("second", 1, true)],
      aDemarrer: ["yuki", "second"],
    });

    expect(() => h.parBot.pourBot("fantome")).toThrow(/Bot inconnu/);
    expect(() => h.parBot.depsPourBot("fantome")).toThrow(/Bot inconnu/);
    expect(h.fabrique.ouvertes().map((pile) => pile.botId)).toEqual(["yuki"]);
    // Sa racine n'a AUCUN fichier de sources ouvert par cette instance.
    const racine = cheminsBot(h.envInstance, "fantome").racine;
    expect(existsSync(join(racine, "sources.json"))).toBe(false);
    expect(existsSync(join(racine, "sources-inbox.json"))).toBe(false);
  });

  it("MODE MONO-BOT (aucun registre) : le bot synthétique reste balayé malgré `aDemarrer` vide", () => {
    const b = banc();
    const parBot = new SourcesParBot({
      envInstance: b.env,
      mode: "mono",
      // Aucun `state/bots.json` : le registre est absent (mono-bot historique).
      registre: () => null,
      // Ce que `preparerMultiBot` rend en mono : AUCUN bot à démarrer.
      demarrage: () => ({ aDemarrer: [] }),
      logger: journal,
    });
    const fabrique = new FabriquePilesSources({
      pile: "yuki",
      envPile: b.env,
      envs: creerResolveurEnvBot({
        envInstance: b.env,
        mode: "mono",
        pile: "yuki",
        envPile: b.env,
        processEnv: b.processEnv,
      }),
      construire: ({ botId, envBot }) => objetsBot(envBot, botId),
      existantsPile: objetsBot(b.env, "yuki"),
      logger: journal,
    });
    parBot.setPileActive(fabrique.ouvrir("yuki"));
    parBot.setOuvrir((input) => fabrique.ouvrir(input.botId));

    // ⚠️ Sans ce garde, un `aDemarrer` vide éteindrait le balayeur d'une
    // installation mono-bot : `yuki` doit rester balayé, comme avant L3-c.
    expect(parBot.ciblesBalayage().map((cible) => cible.botId)).toEqual(["yuki"]);
  });

  it("sans décision de démarrage (mode mono / tests), la règle du lot 35j s'applique", () => {
    const b = banc();
    const registre: RegistreBots = {
      schemaVersion: 1,
      majLe: "2026-11-10T00:00:00.000Z",
      botActif: "yuki",
      bots: [bot("yuki", 0, true), bot("second", 1, false)],
      echanges: {},
    } as RegistreBots;
    const parBot = new SourcesParBot({
      envInstance: b.env,
      mode: "multi",
      registre: () => registre,
      logger: journal,
    });
    const fabrique = new FabriquePilesSources({
      pile: "yuki",
      envPile: b.env,
      envs: creerResolveurEnvBot({
        envInstance: b.env,
        mode: "multi",
        pile: "yuki",
        envPile: b.env,
        processEnv: b.processEnv,
      }),
      construire: ({ botId, envBot }) => objetsBot(envBot, botId),
      existantsPile: objetsBot(b.env, "yuki"),
      logger: journal,
    });
    parBot.setPileActive(fabrique.ouvrir("yuki"));
    parBot.setOuvrir((input) => fabrique.ouvrir(input.botId));

    expect(parBot.ciblesBalayage().map((cible) => cible.botId)).toEqual(["yuki"]);
  });
});
