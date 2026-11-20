/**
 * AUDIT 2026-11-20 (défauts ② et ③) — LE BALAYEUR DIT LA VÉRITÉ, PAR BOT.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine :
 *  - ② `BalayeurBots` était construit SANS `journal` (`src/index.ts`) et
 *    `CibleBalayage` ne portait pas de journal : `saut`, `plafond` et `desactive`
 *    n'étaient JAMAIS écrits en production ;
 *  - ③ les cibles venaient de `aDemarrer`, FIGÉ au démarrage
 *    (`src/sources/par-bot.ts`) : un bot activé à chaud répondait en chat mais ses
 *    tâches ne tiraient jamais, jusqu'au redémarrage — en silence.
 *
 * Ce qui est VERROUILLÉ ici :
 *  ① un `saut` de `grolaf` arrive dans le journal DE `grolaf`, jamais dans celui de
 *    `yuki` (test central du ②) ;
 *  ② un bot ACTIVÉ À CHAUD (host démarré après le boot) est balayé au tick suivant
 *    (test central du ③) ;
 *  ③ un bot ARRÊTÉ n'est plus balayé (non-régression du comportement) ;
 *  ④ un bot ACTIF dont le host n'est pas démarré est DIT dans SON journal
 *    (`bot_sans_host`), jamais tu — une seule ligne par transition.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PreAutorisationStore } from "../../src/agents/preautorisations.js";
import { agentAutorisePourBot } from "../../src/agents/types.js";
import { CAPACITES_BOT, type BotRecord, type RegistreBots } from "../../src/bots/registry.js";
import { EnvoisProgrammesService } from "../../src/chat/envois/index.js";
import { EnvoisProgrammesStore } from "../../src/chat/envois/store.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import { SourcesInbox } from "../../src/sources/inbox.js";
import { DeclencheurJournal } from "../../src/sources/journal.js";
import {
  SourcesParBot,
  filtreAgentVisible,
  nomsSecretsSource,
  type PileSourcesBot,
} from "../../src/sources/par-bot.js";
import {
  FabriquePilesSources,
  creerResolveurEnvBot,
  type ObjetsPileSources,
} from "../../src/sources/pile-bot.js";
import { BalayeurBots } from "../../src/sources/scheduler.js";
import { SourcesService, type DeclenchementResult } from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

const journalLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Passage DÉJÀ dépassé : le premier tick le traite (règle de rattrapage). */
const MAINTENANT = Date.parse("2026-06-01T06:10:00Z");
const PASSAGE_DEPASSE = "2026-06-01T06:00:00.000Z";

interface Banc {
  env: Env;
  processEnv: NodeJS.ProcessEnv;
}

function banc(): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-journal-balayeur-"));
  racines.push(racine);
  const state = join(racine, "state");
  const env = loadEnv({
    YUKI_MOUNT_STATE: state,
    YUKI_MOUNT_PI_AGENT: join(racine, "pi"),
    YUKI_CONFIG_STORE_PATH: join(state, "config.json"),
    YUKI_LOG_LEVEL: "error",
  });
  return { env, processEnv: {} };
}

function bot(id: string, ordre: number, actif = true): BotRecord {
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

function objetsBot(envBot: Env, botId: string): ObjetsPileSources {
  const store = new SourcesStore({ path: envBot.sourcesStorePath, logger: journalLog });
  const inbox = new SourcesInbox({ path: envBot.sourcesInboxPath, logger: journalLog });
  const jrn = DeclencheurJournal.open({ path: envBot.declencheursJournalPath, logger: journalLog });
  const preAutorisations = new PreAutorisationStore({
    path: envBot.preAutorisationsPath,
    logger: journalLog,
    journal: jrn,
    botId,
    agentAutorise: filtreAgentVisible(undefined, botId, agentAutorisePourBot),
  });
  const service = new SourcesService({
    store,
    inbox,
    journal: jrn,
    logger: journalLog,
    botId,
    secretNames: (nom) => nomsSecretsSource(botId, nom),
    promptTotalChars: () => 4_000,
  });
  const envois = new EnvoisProgrammesService({
    store: EnvoisProgrammesStore.open({ path: envBot.envoisProgrammesPath, logger: journalLog }),
    journal: jrn,
    canaux: () => [],
    fichier: () => null,
    maxFichierBytes: () => 1_000_000,
    publier: async () => undefined,
    logger: journalLog,
  } as never);
  return { store, inbox, journal: jrn, preAutorisations, service, envois };
}

interface Harnais {
  b: Banc;
  parBot: SourcesParBot;
  /** Bots dont le host est DÉMARRÉ à cet instant (modifiable : activation à chaud). */
  demarres: Set<string>;
  /** Ce que le balayeur a RÉELLEMENT tiré (par bot). */
  tirs: Map<string, string[]>;
  balayeur: BalayeurBots;
  pile: (botId: string) => PileSourcesBot;
  /** Journal d'un bot (son fichier). */
  journalDe: (botId: string) => DeclencheurJournal;
}

function harnais(options: { bots?: BotRecord[]; demarres?: string[] } = {}): Harnais {
  const b = banc();
  const registre: RegistreBots = {
    schemaVersion: 1,
    majLe: "2026-11-20T00:00:00.000Z",
    botActif: "yuki",
    bots: options.bots ?? [bot("yuki", 0), bot("grolaf", 1)],
    echanges: {},
  } as RegistreBots;
  const demarres = new Set<string>(options.demarres ?? ["yuki"]);
  const parBot = new SourcesParBot({
    envInstance: b.env,
    mode: "multi",
    registre: () => registre,
    // ⚠️ La décision FIGÉE au boot : elle nomme les deux bots. Si le balayeur s'y
    // fiait encore, `grolaf` serait balayé même arrêté, et un bot activé à chaud
    // absent de cette liste ne le serait jamais.
    demarrage: () => ({ aDemarrer: registre.bots.map((entree) => entree.id) }),
    estDemarre: (botId) => demarres.has(botId),
    logger: journalLog,
  });
  const envs = creerResolveurEnvBot({
    envInstance: b.env,
    mode: "multi",
    pile: "yuki",
    envPile: b.env,
    processEnv: b.processEnv,
  });
  const fabrique = new FabriquePilesSources({
    pile: "yuki",
    envPile: b.env,
    envs,
    construire: ({ botId, envBot }) => objetsBot(envBot, botId),
    existantsPile: objetsBot(b.env, "yuki"),
    logger: journalLog,
  });
  parBot.setPileActive(fabrique.ouvrir("yuki"));
  parBot.setOuvrir((input) => fabrique.ouvrir(input.botId));

  const tirs = new Map<string, string[]>();
  // ⚠️ Le `run` de chaque cible est enveloppé : on veut savoir QUEL bot a tiré,
  // pas seulement qu'un tour a eu lieu.
  const balayeur = new BalayeurBots({
    bots: {
      cibles: () =>
        parBot.ciblesBalayage().map((cible) => {
          const reels = tirs.get(cible.botId) ?? [];
          tirs.set(cible.botId, reels);
          return {
            ...cible,
            run: async (nom, opts): Promise<DeclenchementResult> => {
              reels.push(nom);
              return cible.run(nom, opts);
            },
          };
        }),
    },
    logger: journalLog,
    now: () => MAINTENANT,
    // ⚠️ AUCUN `journal` ici : c'est le point du défaut ②. En production
    // `BalayeurBots` n'en reçoit pas non plus ; le journal doit venir de la CIBLE.
  });

  return {
    b,
    parBot,
    demarres,
    tirs,
    balayeur,
    pile: (botId) => parBot.pourBot(botId),
    journalDe: (botId) => parBot.pourBot(botId).journal,
  };
}

/** Déclencheur PLANIFIÉ chez un bot, avec un passage déjà dû. */
function planifierChez(h: Harnais, botId: string, nom: string): void {
  const pile = h.pile(botId);
  pile.service.create(nom, {
    declencheur: { type: "planning", expression: "0 8 * * *", fuseau: "Europe/Paris" },
  } as never);
  pile.store.markPlanification(nom, { prochainPassage: PASSAGE_DEPASSE });
}

/**
 * Tâche PONCTUELLE dont l'échéance est PLUS VIEILLE que `RATTRAPAGE_MAX_MS` : elle
 * produit un `saut` déterministe (« non exécutée »), sans lancer aucun tour.
 */
function tacheEnRetardChez(h: Harnais, botId: string, nom: string): void {
  const pile = h.pile(botId);
  pile.service.create(nom, {
    declencheur: { type: "ponctuel", a: "2026-06-01T04:00:00.000Z", fuseau: "Europe/Paris" },
    consigne: "une instruction",
    visibilite: "silencieux",
  } as never);
}

function evenements(h: Harnais, botId: string): string[] {
  return h.journalDe(botId).recent(200).map((record) => record.event);
}

function sourcesDuJournal(h: Harnais, botId: string, type: string): string[] {
  return h
    .journalDe(botId)
    .recent(200, { types: [type as never] })
    .map((record) => record.source);
}

// ── ① Journal du balayeur PAR BOT (défaut ②) ───────────────────────────────

describe("journal du balayeur par bot (audit 2026-11-20, ②)", () => {
  it("⚠️ un `saut` de grolaf arrive dans le journal de GROLAF, pas dans celui de yuki", async () => {
    const h = harnais({ demarres: ["yuki", "grolaf"] });
    // Une tâche PONCTUELLE en retard CHEZ CHAQUE BOT : le balayeur la SAUTE et le DIT.
    tacheEnRetardChez(h, "grolaf", "tache-grolaf");
    tacheEnRetardChez(h, "yuki", "tache-yuki");

    await h.balayeur.tick();

    // ⚠️ Chaque journal ne porte QUE les événements de SON bot : aucun mélange.
    expect(sourcesDuJournal(h, "grolaf", "saut")).toEqual(["tache-grolaf"]);
    expect(sourcesDuJournal(h, "yuki", "saut")).toEqual(["tache-yuki"]);
    expect(evenements(h, "grolaf")).toContain("saut");
    expect(evenements(h, "yuki")).toContain("saut");
  });

  it("chaque cible PORTE son journal (jamais celui du balayeur, jamais celui d'un autre)", () => {
    const h = harnais({ demarres: ["yuki", "grolaf"] });
    const cibles = h.parBot.ciblesBalayage();

    expect(cibles.map((cible) => cible.botId)).toEqual(["yuki", "grolaf"]);
    for (const cible of cibles) {
      // ⚠️ IDENTITÉ : le journal de la PILE de ce bot.
      expect(cible.journal).toBe(h.pile(cible.botId).journal);
    }
    expect(cibles[0]?.journal).not.toBe(cibles[1]?.journal);
  });
});

// ── ② Balayeur sur l'état RÉEL (défaut ③) ───────────────────────────────────

describe("cibles du balayeur sur l'état RÉEL (audit 2026-11-20, ③)", () => {
  it("⚠️ un bot ACTIVÉ À CHAUD est pris en compte au tick SUIVANT", async () => {
    // Au démarrage, le host de `grolaf` n'a pas démarré (échec, ou bot créé après).
    const h = harnais({ demarres: ["yuki"] });
    planifierChez(h, "grolaf", "cron-grolaf");
    planifierChez(h, "yuki", "cron-yuki");

    await h.balayeur.tick();
    expect(h.parBot.ciblesBalayage().map((cible) => cible.botId)).toEqual(["yuki"]);
    expect(h.tirs.get("grolaf") ?? []).toEqual([]);

    // ── L'interface DÉMARRE le bot (`POST /api/bots/grolaf/actif`) ──────────
    h.demarres.add("grolaf");

    // ⚠️ AUCUN redémarrage, aucun nouveau balayeur : le tick suivant suffit.
    await h.balayeur.tick();
    expect(h.parBot.ciblesBalayage().map((cible) => cible.botId)).toEqual(["yuki", "grolaf"]);
    expect(h.tirs.get("grolaf")).toEqual(["cron-grolaf"]);
  });

  it("un bot ARRÊTÉ n'est plus balayé (non-régression)", async () => {
    const h = harnais({ demarres: ["yuki", "grolaf"] });
    planifierChez(h, "grolaf", "cron-grolaf");

    await h.balayeur.tick();
    expect(h.tirs.get("grolaf")).toEqual(["cron-grolaf"]);

    // ── L'interface ARRÊTE le bot ──────────────────────────────────────────
    h.demarres.delete("grolaf");
    planifierChez(h, "grolaf", "cron-grolaf-2");

    await h.balayeur.tick();
    expect(h.parBot.ciblesBalayage().map((cible) => cible.botId)).toEqual(["yuki"]);
    // Le nouveau rendez-vous n'a PAS tiré : le bot arrêté ne balaie plus.
    expect(h.tirs.get("grolaf")).toEqual(["cron-grolaf"]);
    expect(h.balayeur.ciblesConnues).toBe(1);
  });

  it("un bot ACTIF sans host est DIT dans SON journal, une seule fois (pas un silence)", async () => {
    const h = harnais({ demarres: ["yuki"] });
    planifierChez(h, "grolaf", "cron-grolaf");

    await h.balayeur.tick();
    const lignes = h
      .journalDe("grolaf")
      .recent(50, { types: ["bot_sans_host"] })
      .filter((record) => record.source === "grolaf");
    expect(lignes).toHaveLength(1);
    expect(lignes[0]?.raison ?? "").toContain("bot « grolaf »");
    expect(lignes[0]?.raison ?? "").toContain("pas démarré");
    // ⚠️ Le journal de `yuki` ne reçoit RIEN de cette situation.
    expect(h.journalDe("yuki").recent(50, { types: ["bot_sans_host"] })).toEqual([]);

    // Un second tick ne réécrit pas la même ligne (une par TRANSITION).
    await h.balayeur.tick();
    expect(
      h.journalDe("grolaf").recent(50, { types: ["bot_sans_host"] }).filter(
        (record) => record.source === "grolaf",
      ),
    ).toHaveLength(1);
  });
});
