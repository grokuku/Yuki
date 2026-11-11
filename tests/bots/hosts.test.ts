/**
 * LOT 36 (L3-d) — LE `PiHost` PAR BOT.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/bots/hosts.ts` n'existe
 * pas (`HostsBots`, `portsHostBot`, `optionsHostBot`), `PiHostOptions` n'a pas de
 * `botId`, et `main()` ne construit qu'UN host — celui de la pile.
 *
 * Ce qui est VERROUILLÉ ici :
 *  ① GARDE DE NON-RÉGRESSION FORTE : avec UN bot actif, le host du PRINCIPAL est
 *    construit avec les options d'AVANT (`sessionsDir`, `systemPrompt`, les ports
 *    du principal) — MÊMES OBJETS (`===`), et l'objet d'options lui-même est
 *    passé tel quel ;
 *  ② deux bots à démarrer ⇒ deux hosts, `sessionsDir` DISTINCTS et `systemPrompt`
 *    du BON `configBot` (les ports de la pile et des outils de chaque bot) ;
 *  ③ un bot REFUSÉ par le plafond n'a PAS de host, et rien n'est construit pour
 *    lui (son contexte n'est même pas demandé) ;
 *  ④ la mémoire (service, pas store) n'est JAMAIS empruntée au principal : elle
 *    est RETIRÉE du host d'un bot secondaire ;
 *  ⑤ deux hosts ne peuvent pas partager un `sessionsDir` (garde de corruption) ;
 *  ⑥ `getSubsystems` et le transport gardent le host du PRINCIPAL (garde
 *    statique sur `src/index.ts` : `main()` n'est jamais exécuté par les tests).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { preparerMultiBot } from "../../src/bots/index.js";
import {
  HostsBots,
  optionsHostBot,
  portsHostBot,
  type ContexteHostBot,
  type HostsBotLogger,
  type PortsHostBot,
} from "../../src/bots/hosts.js";
import {
  CAPACITES_BOT,
  cheminRegistreBots,
  ecrireRegistreBots,
  type BotRecord,
  type RegistreBots,
} from "../../src/bots/registry.js";
import { creerConfigsBots } from "../../src/config/bots.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import type { ConfigRuntime } from "../../src/config/runtime.js";
import { appendVoiceInstruction } from "../../src/llm/prompts.js";
import { HeritageStore } from "../../src/memory/heritage-store.js";
import { envPourBot } from "../../src/memory/stores-bot.js";
import type { OutilsBot } from "../../src/bots/outils.js";
import type { PileSourcesBot } from "../../src/sources/par-bot.js";
import type { PiHostOptions } from "../../src/pi/types.js";
import { isTtsEnabled } from "../../src/tts/options.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

interface LigneJournal {
  niveau: "debug" | "info" | "warn" | "error";
  message: string;
  champs: Record<string, unknown>;
}

function journalFactice(): HostsBotLogger & { lignes: LigneJournal[] } {
  const lignes: LigneJournal[] = [];
  const pousser =
    (niveau: LigneJournal["niveau"]) =>
    (message: string, champs: Record<string, unknown> = {}): void => {
      lignes.push({ niveau, message, champs });
    };
  return {
    lignes,
    debug: pousser("debug"),
    info: pousser("info"),
    warn: pousser("warn"),
    error: pousser("error"),
  };
}

/** Prompts livrés (mêmes défauts pour tous les bots : fichiers globaux). */
const PROMPTS = { light: "prompt livré léger", heavy: "prompt livré lourd" };

interface Banc {
  state: string;
  env: Env;
  processEnv: NodeJS.ProcessEnv;
}

function banc(): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-hosts-bots-"));
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

function bot(id: string, ordre: number, actif: boolean): BotRecord {
  return {
    id,
    nom: id,
    capacites: [...CAPACITES_BOT],
    actif,
    ordre,
    creeLe: "2026-01-01T00:00:00.000Z",
    plateformes: {},
  };
}

function registre(bots: BotRecord[]): RegistreBots {
  return { schemaVersion: 1, bots, echanges: {} };
}

function avecRegistre(bots: BotRecord[]): Banc {
  const b = banc();
  ecrireRegistreBots(cheminRegistreBots(b.state), registre(bots));
  return b;
}

/** Host FACTICE : n'exécute rien, retient ses options et ses appels. */
class FauxHost {
  readonly options: PiHostOptions;
  demarrages = 0;
  arrets = 0;
  constructor(options: PiHostOptions) {
    this.options = options;
  }
  async start(): Promise<void> {
    if (this.options.botId === "senpai") throw new Error("modèle indisponible");
    this.demarrages += 1;
  }
  async stop(): Promise<void> {
    this.arrets += 1;
  }
}

/**
 * Options du host du PRINCIPAL, calquées sur celles de `main()` (objet d'options
 * NOMMÉ : c'est son identité que la garde ① vérifie).
 */
function optionsPileDe(b: Banc, config: ConfigRuntime): PiHostOptions {
  const portMemoire = {
    recall: async () => ({ entries: [], truncated: false, bytes: 0 }),
    onTurnEnd: () => undefined,
    onBeforeCompact: () => undefined,
  } as unknown as NonNullable<PiHostOptions["memory"]>;
  return {
    // ⚠️ Le principal AUSSI porte son `botId` (journal `pi.ready`).
    botId: "yuki",
    agentDir: join(b.env.piAgentDir, "agent"),
    cwd: b.env.piCwd,
    home: b.env.piHome,
    sessionsDir: b.env.piSessionsDir,
    systemPrompt: appendVoiceInstruction(
      config.getString("prompts.light"),
      isTtsEnabled(config),
    ),
    model: "llm-light/gemma4:31b",
    tools: ["lire_fichier"],
    sources: { takePending: () => undefined },
    memory: portMemoire,
    personality: {
      get: () => "",
    } as unknown as NonNullable<PiHostOptions["personality"]>,
    rules: { get: () => "" } as unknown as NonNullable<PiHostOptions["rules"]>,
    reactions: {
      recent: () => [],
    } as unknown as NonNullable<PiHostOptions["reactions"]>,
    conversationArchive: {
      search: async () => [],
    } as unknown as NonNullable<PiHostOptions["conversationArchive"]>,
    heritage: new HeritageStore({ dir: b.env.heritageDir }),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
}

/** Pile sources FACTICE (L3-c est verrouillée par `tests/sources/piles-par-bot`). */
interface PileFactice {
  pile: PileSourcesBot;
  planifiees: unknown[];
  programmes: unknown[];
}

function pileFactice(envBot: Env, botId: string): PileFactice {
  const planifiees: unknown[] = [];
  const programmes: unknown[] = [];
  const pile = {
    botId,
    env: envBot,
    service: {
      takePending: () => undefined,
      planifierTache: (input: unknown) => {
        planifiees.push(input);
        return { status: "planifie", nom: "t", quand: "2026-01-01T00:00:00.000Z" };
      },
    },
    envois: {
      programmer: (input: unknown) => {
        programmes.push(input);
        return { ok: true, enAttente: 1 };
      },
    },
  } as unknown as PileSourcesBot;
  return { pile, planifiees, programmes };
}

/** Outils FACTICES (L3-b est verrouillée par `tests/bots/outils.test.ts`). */
function outilsFactices(envBot: Env, botId: string): OutilsBot {
  return {
    botId,
    env: envBot,
    personnalite: { get: () => `personnalité de ${botId}` },
    regles: { get: () => `règles de ${botId}` },
    reactions: { recent: () => [] },
    archive: { search: async () => [] },
  } as unknown as OutilsBot;
}

/** Contexte d'un bot secondaire (son `Env` résolu, sa config, ses outils, sa pile). */
function contexteDe(
  b: Banc,
  botId: string,
  configs: Map<string, ConfigRuntime>,
  fakes: {
    pile?: PileFactice;
    outils?: OutilsBot;
    memoire?: NonNullable<PiHostOptions["memory"]>;
    delegation?: PiHostOptions["delegation"];
    eventSource?: PiHostOptions["eventSource"];
  } = {},
): ContexteHostBot {
  const env = envPourBot({
    envInstance: b.env,
    botId,
    mode: "multi",
    processEnv: b.processEnv,
  });
  const config = configs.get(botId);
  return {
    botId,
    env,
    ...(config !== undefined ? { config } : {}),
    outils: fakes.outils ?? outilsFactices(env, botId),
    pile: fakes.pile?.pile ?? pileFactice(env, botId).pile,
    ...(fakes.memoire !== undefined ? { memoire: fakes.memoire } : {}),
    ...(fakes.delegation !== undefined ? { delegation: fakes.delegation } : {}),
    ...(fakes.eventSource !== undefined ? { eventSource: fakes.eventSource } : {}),
  };
}

function configsDeTest(b: Banc, bots: string[], pile: string): Map<string, ConfigRuntime> {
  return creerConfigsBots({
    env: b.env,
    bots,
    pile,
    promptDefaults: PROMPTS,
    processEnv: b.processEnv,
  });
}

// ── ① Garde de non-régression : 1 bot ⇒ le host d'AVANT ────────────────────

describe("host du PRINCIPAL (lot 36, L3-d)", () => {
  it("mode MONO historique : options IDENTIQUES (ports et sessionsDir par identité)", () => {
    const b = banc();
    const preparation = preparerMultiBot(b.env, {
      processEnv: b.processEnv,
      migrationAutomatique: false,
    });
    expect(preparation.mode).toBe("mono");
    expect(preparation.aDemarrer).toEqual([]);

    const configs = configsDeTest(b, [], "yuki");
    const config = configs.get("yuki");
    expect(config).toBeDefined();
    const optionsPile = optionsPileDe(b, config as ConfigRuntime);

    const journal = journalFactice();
    const construits: FauxHost[] = [];
    const hosts = new HostsBots<FauxHost>({
      pile: "yuki",
      bots: preparation.aDemarrer.map((entree) => entree.id),
      optionsPile,
      creer: (options) => {
        const host = new FauxHost(options);
        construits.push(host);
        return host;
      },
      // ⚠️ Un bot de pile n'a JAMAIS de contexte : il n'est pas dérivé.
      contexte: () => {
        throw new Error("le host du principal ne doit pas être dérivé");
      },
      logger: journal,
    });

    // ⚠️⚠️ IDENTITÉ : l'objet d'options passé à `createPiHost` EST celui de
    // `main()` — pas une copie, pas une reconstruction.
    expect(construits).toHaveLength(1);
    expect(construits[0]?.options).toBe(optionsPile);
    expect(hosts.principal).toBe(construits[0]);
    expect(hosts.ids()).toEqual(["yuki"]);
    expect(hosts.taille).toBe(1);
    expect(hosts.pour("yuki")).toBe(hosts.principal);

    // Les valeurs restent celles d'aujourd'hui, à l'identique.
    expect(construits[0]?.options.sessionsDir).toBe(b.env.piSessionsDir);
    // Chaque host SAIT à quel bot il appartient (seul champ ajouté par L3-d).
    expect(construits[0]?.options.botId).toBe("yuki");
    expect(construits[0]?.options.systemPrompt).toBe(
      appendVoiceInstruction(config?.getString("prompts.light") ?? "", isTtsEnabled(config as ConfigRuntime)),
    );
    expect(construits[0]?.options.sources).toBe(optionsPile.sources);
    expect(construits[0]?.options.memory).toBe(optionsPile.memory);
    expect(construits[0]?.options.personality).toBe(optionsPile.personality);
    expect(construits[0]?.options.rules).toBe(optionsPile.rules);
    expect(construits[0]?.options.reactions).toBe(optionsPile.reactions);
    expect(construits[0]?.options.conversationArchive).toBe(optionsPile.conversationArchive);
    expect(construits[0]?.options.heritage).toBe(optionsPile.heritage);

    // Aucun host secondaire, donc aucun démarrage secondaire.
    expect(journal.lignes.find((ligne) => ligne.message === "bots.hosts")?.champs).toMatchObject({
      pile: "yuki",
      nombre: 1,
      ids: "yuki",
      secondaires: 0,
    });
  });

  it("mode MULTI à 1 bot actif : `sessionsDir` est celui de l'`Env` du démarrage", () => {
    const b = avecRegistre([bot("yuki", 0, true)]);
    const preparation = preparerMultiBot(b.env, { processEnv: b.processEnv });
    expect(preparation.mode).toBe("multi");
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki"]);

    const configs = configsDeTest(b, ["yuki"], "yuki");
    const config = configs.get("yuki") as ConfigRuntime;
    // `preparation.env` EST l'`Env` que `main()` passe aujourd'hui au host.
    const optionsPile = optionsPileDe({ ...b, env: preparation.env }, config);

    const hosts = new HostsBots<FauxHost>({
      pile: "yuki",
      bots: preparation.aDemarrer.map((entree) => entree.id),
      optionsPile,
      creer: (options) => new FauxHost(options),
      contexte: () => {
        throw new Error("le host du principal ne doit pas être dérivé");
      },
      logger: journalFactice(),
    });

    expect(hosts.ids()).toEqual(["yuki"]);
    expect(hosts.principal.options.sessionsDir).toBe(preparation.env.piSessionsDir);
    // En mode multi, le principal vit déjà sous `<pi>/agent/sessions/<bot>`.
    expect(preparation.env.piSessionsDir).toBe(
      envPourBot({ envInstance: b.env, botId: "yuki", mode: "multi", processEnv: b.processEnv })
        .piSessionsDir,
    );
    expect(preparation.env.piSessionsDir).not.toBe(b.env.piSessionsDir);
  });
});

// ── ② Deux bots ⇒ deux hosts DISTINCTS ─────────────────────────────────────

describe("deux bots à démarrer (lot 36, L3-d)", () => {
  it("deux hosts, `sessionsDir` distincts et `systemPrompt` du BON `configBot`", async () => {
    const b = avecRegistre([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const preparation = preparerMultiBot(b.env, { processEnv: b.processEnv });
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki", "kohai"]);

    const configs = configsDeTest(b, ["yuki", "kohai"], "yuki");
    const configYuki = configs.get("yuki") as ConfigRuntime;
    const configKohai = configs.get("kohai") as ConfigRuntime;
    // Prompt PROPRE à kohai (overlay `scope: "mixte"`) : c'est lui qui doit
    // arriver dans SON host, jamais celui du principal.
    configKohai.update({ "prompts.light": "Tu es Kohai, pas Yuki." }, { portee: "bot" });
    expect(configKohai.getString("prompts.light")).toBe("Tu es Kohai, pas Yuki.");

    // ⚠️ Ici l'`Env` du principal est celui du démarrage (multi) : la référence.
    const optionsPile: PiHostOptions = {
      ...optionsPileDe(b, configYuki),
      sessionsDir: preparation.env.piSessionsDir,
      systemPrompt: appendVoiceInstruction(
        configYuki.getString("prompts.light"),
        isTtsEnabled(configYuki),
      ),
    };

    const piles = new Map<string, PileFactice>();
    const outils = new Map<string, OutilsBot>();
    const hosts = new HostsBots<FauxHost>({
      pile: "yuki",
      bots: preparation.aDemarrer.map((entree) => entree.id),
      optionsPile,
      creer: (options) => new FauxHost(options),
      contexte: (botId) => {
        const pile = pileFactice(
          envPourBot({ envInstance: b.env, botId, mode: "multi", processEnv: b.processEnv }),
          botId,
        );
        const outilsBot = outilsFactices(pile.pile.env, botId);
        piles.set(botId, pile);
        outils.set(botId, outilsBot);
        return {
          botId,
          env: pile.pile.env,
          config: configs.get(botId) as ConfigRuntime,
          outils: outilsBot,
          pile: pile.pile,
        };
      },
      logger: journalFactice(),
    });

    expect(hosts.ids()).toEqual(["yuki", "kohai"]);
    expect(hosts.taille).toBe(2);
    const hostKohai = hosts.pour("kohai") as FauxHost;
    expect(hostKohai).toBeDefined();
    expect(hostKohai).not.toBe(hosts.principal);

    // ⚠️ Deux répertoires de sessions, jamais le même (isolation des JSONL).
    expect(hostKohai.options.sessionsDir).not.toBe(hosts.principal.options.sessionsDir);
    expect(hostKohai.options.sessionsDir).toBe(
      envPourBot({ envInstance: b.env, botId: "kohai", mode: "multi", processEnv: b.processEnv })
        .piSessionsDir,
    );
    expect(hostKohai.options.sessionsDir).toContain("kohai");

    // ⚠️ Le prompt de SON overlay, pas celui du principal.
    expect(hostKohai.options.systemPrompt).toBe("Tu es Kohai, pas Yuki.");
    expect(hostKohai.options.systemPrompt).not.toBe(hosts.principal.options.systemPrompt);
    expect(hosts.principal.options.systemPrompt).not.toContain("Kohai");

    // ⚠️ Et son `botId` : chaque host SAIT à quel bot il appartient.
    expect(hostKohai.options.botId).toBe("kohai");

    // Les ports de SA pile et de SES outils (par identité).
    expect(hostKohai.options.sources).toBe(piles.get("kohai")?.pile.service);
    expect(hostKohai.options.planifierTache).toBeDefined();
    expect(hostKohai.options.envoisProgrammes).toBeDefined();
    expect(hostKohai.options.personality).toBe(outils.get("kohai")?.personnalite);
    expect(hostKohai.options.rules).toBe(outils.get("kohai")?.regles);
    expect(hostKohai.options.reactions).toBe(outils.get("kohai")?.reactions);
    expect(hostKohai.options.conversationArchive).toBe(outils.get("kohai")?.archive);
    expect(hostKohai.options.sources).not.toBe(optionsPile.sources);

    // ⚠️ Le heritage du bot est le SIEN (lecture seule, aucune écriture ici).
    expect(hostKohai.options.heritage).not.toBe(optionsPile.heritage);
    expect((hostKohai.options.heritage as HeritageStore).dirPath).toBe(
      piles.get("kohai")?.pile.env.heritageDir,
    );

    // Les ports de la pile DÉLÈGUENT bien au bot concerné (jamais au principal).
    const pileKohai = piles.get("kohai") as PileFactice;
    await hostKohai.options.envoisProgrammes?.programmer({
      texte: "bonjour",
      dans: "1h",
    } as never);
    await hostKohai.options.planifierTache?.planifier({ tache: "résume" } as never);
    expect(pileKohai.programmes).toHaveLength(1);
    expect(pileKohai.planifiees).toHaveLength(1);
    expect(piles.get("yuki")).toBeUndefined();

    // Le host du principal reste celui d'avant (aucune option dérivée).
    expect(hosts.principal.options).toBe(optionsPile);
  });

  it("les hosts secondaires DÉMARRENT et S'ARRÊTENT (le principal est géré par `main()`)", async () => {
    const b = avecRegistre([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const preparation = preparerMultiBot(b.env, { processEnv: b.processEnv });
    const configs = configsDeTest(b, ["yuki", "kohai"], "yuki");
    const optionsPile = optionsPileDe(b, configs.get("yuki") as ConfigRuntime);

    const construits = new Map<string, FauxHost>();
    const hosts = new HostsBots<FauxHost>({
      pile: "yuki",
      bots: preparation.aDemarrer.map((entree) => entree.id),
      optionsPile,
      creer: (options) => {
        const host = new FauxHost(options);
        construits.set(options.botId ?? "?", host);
        return host;
      },
      contexte: (botId) => contexteDe(b, botId, configs),
      logger: journalFactice(),
    });

    // Avant `demarrerAutres`, un host secondaire n'est PAS utilisable comme réveil.
    expect(hosts.pour("kohai")).toBeDefined();
    expect(hosts.pourDemarre("kohai")).toBeUndefined();
    expect(hosts.principal.demarrages).toBe(0);

    const bilan = await hosts.demarrerAutres();
    expect(bilan.demarres).toEqual(["kohai"]);
    expect(bilan.echecs).toEqual([]);
    expect(hosts.pourDemarre("kohai")).toBe(construits.get("kohai"));
    expect(hosts.estDemarre("kohai")).toBe(true);
    // ⚠️ Le principal n'est PAS démarré par la fabrique (main() le fait).
    expect(hosts.principal.demarrages).toBe(0);

    await hosts.arreter();
    expect(construits.get("kohai")?.arrets).toBe(1);
    expect(hosts.principal.arrets).toBe(0);
    expect(hosts.pourDemarre("kohai")).toBeUndefined();
  });

  it("un host secondaire qui refuse de démarrer n'empêche PAS les autres", async () => {
    const b = avecRegistre([bot("yuki", 0, true), bot("kohai", 1, true), bot("senpai", 2, true)]);
    const preparation = preparerMultiBot(b.env, { processEnv: b.processEnv });
    const configs = configsDeTest(b, ["yuki", "kohai", "senpai"], "yuki");
    const journal = journalFactice();
    const hosts = new HostsBots<FauxHost>({
      pile: "yuki",
      bots: preparation.aDemarrer.map((entree) => entree.id),
      optionsPile: optionsPileDe(b, configs.get("yuki") as ConfigRuntime),
      creer: (options) => new FauxHost(options),
      contexte: (botId) => contexteDe(b, botId, configs),
      logger: journal,
    });

    const bilan = await hosts.demarrerAutres();
    expect(bilan.demarres).toEqual(["kohai"]);
    expect(bilan.echecs).toEqual(["senpai"]);
    expect(hosts.pourDemarre("kohai")).toBeDefined();
    expect(hosts.pourDemarre("senpai")).toBeUndefined();
    expect(hosts.estDemarre("senpai")).toBe(false);
    expect(
      journal.lignes.some(
        (ligne) => ligne.message === "bots.host.start.failed" && ligne.champs.bot === "senpai",
      ),
    ).toBe(true);
  });
});

// ── ③ Un bot REFUSÉ par le plafond n'a PAS de host ─────────────────────────

describe("bots refusés par le plafond (lot 36, L1 + L3-d)", () => {
  it("aucun host pour le bot refusé, et son contexte n'est même pas demandé", () => {
    const b = avecRegistre([
      bot("yuki", 0, true),
      bot("kohai", 1, true),
      bot("senpai", 2, true),
      bot("sensei", 3, true),
    ]);
    const preparation = preparerMultiBot(b.env, { processEnv: b.processEnv, maxActifs: 2 });
    expect(preparation.aDemarrer.map((entree) => entree.id)).toEqual(["yuki", "kohai"]);
    expect(preparation.refusesActifs.map((entree) => entree.id)).toEqual(["senpai", "sensei"]);

    const configs = configsDeTest(
      b,
      preparation.aDemarrer.map((entree) => entree.id),
      "yuki",
    );
    const demandes: string[] = [];
    const hosts = new HostsBots<FauxHost>({
      pile: "yuki",
      bots: preparation.aDemarrer.map((entree) => entree.id),
      optionsPile: optionsPileDe(b, configs.get("yuki") as ConfigRuntime),
      creer: (options) => new FauxHost(options),
      contexte: (botId) => {
        demandes.push(botId);
        return contexteDe(b, botId, configs);
      },
      logger: journalFactice(),
    });

    expect(hosts.ids()).toEqual(["yuki", "kohai"]);
    expect(hosts.pour("senpai")).toBeUndefined();
    expect(hosts.pour("sensei")).toBeUndefined();
    // ⚠️ Le refusé ne reçoit RIEN : même pas une demande de contexte (donc
    // aucun `Env`, aucun store, aucun fichier ouvert en son nom).
    expect(demandes).toEqual(["kohai"]);
  });
});

// ── ④ La mémoire n'est jamais empruntée au principal ───────────────────────

describe("ports d'un bot secondaire (lot 36, L3-d)", () => {
  it("sans SERVICE de mémoire pour ce bot, le port `memory` est RETIRÉ (jamais emprunté)", () => {
    const b = avecRegistre([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const configs = configsDeTest(b, ["yuki", "kohai"], "yuki");
    const optionsPile = optionsPileDe(b, configs.get("yuki") as ConfigRuntime);
    const journal = journalFactice();

    const contexte = contexteDe(b, "kohai", configs);
    const ports = portsHostBot(contexte, journal) as PortsHostBot;
    const options = optionsHostBot("kohai", optionsPile, ports);

    // ⚠️ La mémoire du principal ne se PARTAGE pas : elle est retirée.
    expect(optionsPile.memory).toBeDefined();
    expect(options.memory).toBeUndefined();
    // L'absence est DITE (jamais un silence).
    expect(
      journal.lignes.some(
        (ligne) => ligne.message === "bots.host.port_absent" && ligne.champs.bot === "kohai",
      ),
    ).toBe(true);

    // Ce qui est partagé (instance) reste le MÊME objet.
    expect(options.logger).toBe(optionsPile.logger);
    expect(options.tools).toBe(optionsPile.tools);
    expect(options.model).toBe(optionsPile.model);
    // Ce qui est propre au bot est remplacé.
    expect(options.sources).toBe(contexte.pile?.service);
    expect(options.personality).toBe(contexte.outils?.personnalite);
    expect(options.botId).toBe("kohai");
  });

  it("avec SON service de mémoire (L11), le host du bot lit SA mémoire — jamais celle du principal", () => {
    const b = avecRegistre([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const configs = configsDeTest(b, ["yuki", "kohai"], "yuki");
    const optionsPile = optionsPileDe(b, configs.get("yuki") as ConfigRuntime);
    const journal = journalFactice();

    // Le service « de kohai » : un objet distinct de celui du principal.
    const memoireKohai = {
      recall: async () => ({ entries: [], truncated: false, bytes: 0 }),
      onTurnEnd: () => undefined,
      onBeforeCompact: () => undefined,
    } as unknown as NonNullable<PiHostOptions["memory"]>;

    const contexte = contexteDe(b, "kohai", configs, { memoire: memoireKohai });
    const ports = portsHostBot(contexte, journal) as PortsHostBot;
    const options = optionsHostBot("kohai", optionsPile, ports);

    // ⚠️ C'est CE service-là, par identité — jamais celui du principal.
    expect(options.memory).toBe(memoireKohai);
    expect(options.memory).not.toBe(optionsPile.memory);
    // Et l'absence n'est plus annoncée : le port existe.
    expect(
      journal.lignes.some(
        (ligne) =>
          ligne.message === "bots.host.port_absent" &&
          ligne.champs.bot === "kohai" &&
          String(ligne.champs.ports).split(",").includes("memory"),
      ),
    ).toBe(false);
  });

  it("la DÉLÉGATION et ses ÉVÉNEMENTS sont ceux du bot (L11), jamais ceux du principal", () => {
    const b = avecRegistre([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const configs = configsDeTest(b, ["yuki", "kohai"], "yuki");
    const optionsPile = optionsPileDe(b, configs.get("yuki") as ConfigRuntime);
    // Le principal porte un port de délégation (comme `main()`).
    const portPile = { delegate: async () => ({ status: "dispatched" }) } as unknown as NonNullable<
      PiHostOptions["delegation"]
    >;
    const sourcePile = { subscribe: () => () => undefined } as unknown as NonNullable<
      PiHostOptions["eventSource"]
    >;
    optionsPile.delegation = portPile;
    optionsPile.eventSource = sourcePile;

    const portKohai = { delegate: async () => ({ status: "dispatched" }) } as unknown as NonNullable<
      PiHostOptions["delegation"]
    >;
    const sourceKohai = { subscribe: () => () => undefined } as unknown as NonNullable<
      PiHostOptions["eventSource"]
    >;
    const contexte = contexteDe(b, "kohai", configs, {
      delegation: portKohai,
      eventSource: sourceKohai,
    });
    const ports = portsHostBot(contexte) as PortsHostBot;
    const options = optionsHostBot("kohai", optionsPile, ports);

    // ⚠️ Un host secondaire ne reçoit JAMAIS le port du principal : il créerait
    // des jobs sans `botId`, donc attribués au mauvais bot.
    expect(options.delegation).toBe(portKohai);
    expect(options.delegation).not.toBe(portPile);
    expect(options.eventSource).toBe(sourceKohai);
    expect(options.eventSource).not.toBe(sourcePile);

    // Sans contexte, les deux ports sont RETIRÉS (aucun outil `delegate`).
    const sans = optionsHostBot(
      "kohai",
      optionsPile,
      portsHostBot(contexteDe(b, "kohai", configs)) as PortsHostBot,
    );
    expect(sans.delegation).toBeUndefined();
    expect(sans.eventSource).toBeUndefined();
  });

  it("un bot sans configuration n'a pas de host (jamais le prompt d'un autre)", () => {
    const b = avecRegistre([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const configs = configsDeTest(b, ["yuki", "kohai"], "yuki");
    const journal = journalFactice();

    const hosts = new HostsBots<FauxHost>({
      pile: "yuki",
      bots: ["yuki", "kohai"],
      optionsPile: optionsPileDe(b, configs.get("yuki") as ConfigRuntime),
      creer: (options) => new FauxHost(options),
      // Contexte SANS configuration : le prompt système serait celui du principal.
      contexte: (botId) => {
        const complet = contexteDe(b, botId, configs);
        const { config: _ignoree, ...sansConfig } = complet;
        return sansConfig;
      },
      logger: journal,
    });

    expect(hosts.ids()).toEqual(["yuki"]);
    expect(
      journal.lignes.some(
        (ligne) => ligne.message === "bots.host.config_absente" && ligne.champs.bot === "kohai",
      ),
    ).toBe(true);
  });

  it("deux hosts ne partagent JAMAIS un `sessionsDir` (garde de corruption)", () => {
    const b = avecRegistre([bot("yuki", 0, true), bot("kohai", 1, true)]);
    const configs = configsDeTest(b, ["yuki", "kohai"], "yuki");
    const journal = journalFactice();

    const hosts = new HostsBots<FauxHost>({
      pile: "yuki",
      bots: ["yuki", "kohai"],
      optionsPile: optionsPileDe(b, configs.get("yuki") as ConfigRuntime),
      creer: (options) => new FauxHost(options),
      // `Env` du principal rendu pour kohai : le symptôme d'une résolution ratée.
      contexte: (botId) => ({
        ...contexteDe(b, botId, configs),
        env: b.env,
      }),
      logger: journal,
    });

    expect(hosts.ids()).toEqual(["yuki"]);
    expect(
      journal.lignes.some(
        (ligne) =>
          ligne.message === "bots.host.sessions_dir_partage" && ligne.champs.bot === "kohai",
      ),
    ).toBe(true);
  });
});

// ── ⑤ `getSubsystems` et le transport gardent le host du PRINCIPAL ─────────

describe("routes d'instance (garde statique sur `src/index.ts`)", () => {
  const source = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");

  it("`host` EST le host du principal", () => {
    // ⚠️ `main()` n'est jamais exécuté par les tests : la seule garde possible est
    // la FORME du câblage. Elle échoue sur l'origine (`hostsBots` inexistant).
    expect(source).toContain("host = hostsBots.principal;");
    expect(source).toContain("optionsPile: optionsHostPile,");
    expect(source).toContain("await hostsBots.demarrerAutres();");
    expect(source).toContain("await hostsBots?.arreter();");
  });

  it("`getSubsystems` garde le principal ; le transport reçoit `host` ET les hosts par bot (L4)", () => {
    const debut = source.indexOf("const getSubsystems = (): SubsystemsSnapshot => {");
    expect(debut).toBeGreaterThan(0);
    const fin = source.indexOf("\n  };", debut);
    expect(fin).toBeGreaterThan(debut);
    const corps = source.slice(debut, fin);
    expect(corps).not.toContain("hostsBots");
    expect(corps).not.toContain("hosts.pour(");
    // Les valeurs affichées restent celles d'aujourd'hui.
    expect(corps).toContain("sessionsDir: env.piSessionsDir");
    // Le transport WS reçoit toujours `host` (le principal).
    expect(source).toContain("transport = createWsTransport({\n      host,");
    // ⚠️ L4 : il reçoit EN PLUS les hosts par bot (`hosts: hostsBots`). `host`
    // restant le principal, une trame SANS `botId` est servie exactement comme
    // avant L4 ; c'est cette ligne qui rend un second bot joignable.
    expect(source).toContain("...(hostsBots ? { hosts: hostsBots } : {}),");
  });
});
