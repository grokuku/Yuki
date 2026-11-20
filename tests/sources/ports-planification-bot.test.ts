/**
 * AUDIT 2026-11-20 (défaut ①) — PORTS DE PLANIFICATION **PAR BOT**.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/sources/ports-bot.ts` n'existe
 * pas, et le câblage d'un run distant donnait les ports de la PILE
 * (`portEnvoisProgrammes` / `portPlanificationTache`) à TOUS les canaux. Deux
 * conséquences, mesurées ici :
 *  - une tâche demandée depuis le canal de `grolaf` était écrite dans le
 *    `sources.json` du bot du run (`yuki`) : exécutée et publiée par LUI ;
 *  - `programmer_envoi` REFUSAIT le canal de `grolaf` (hors miroir de la pile).
 *
 * Ce qui est VERROUILLÉ ici :
 *  ① `planifier_tache` depuis le canal de `grolaf` ⇒ la tâche est dans
 *    `state/bots/grolaf/sources.json`, RIEN dans celui de `yuki` (test central) ;
 *  ② `programmer_envoi` depuis le canal de `grolaf` ⇒ accepté, et l'envoi est dans
 *    `state/bots/grolaf/envois-programmes.json` (le canal est dans SON miroir) ;
 *  ③ un bot NON résolu ⇒ refus NOMMÉ `bot_inconnu`, jamais un repli sur la pile ;
 *  ④ le run LOCAL (web) garde la pile du bot affiché : ses ports écrivent dans le
 *    fichier de CE bot — identique à avant.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PreAutorisationStore } from "../../src/agents/preautorisations.js";
import { agentAutorisePourBot } from "../../src/agents/types.js";
import { CAPACITES_BOT, type BotRecord, type RegistreBots } from "../../src/bots/registry.js";
import type { EnvoiProgramme } from "../../src/chat/envois/index.js";
import { EnvoisProgrammesService } from "../../src/chat/envois/index.js";
import { EnvoisProgrammesStore } from "../../src/chat/envois/store.js";
import { loadEnv, type Env } from "../../src/config/env.js";
import { DeclencheurJournal } from "../../src/sources/journal.js";
import { SourcesInbox } from "../../src/sources/inbox.js";
import { SourcesParBot, filtreAgentVisible, nomsSecretsSource } from "../../src/sources/par-bot.js";
import {
  FabriquePilesSources,
  creerResolveurEnvBot,
  type ObjetsPileSources,
} from "../../src/sources/pile-bot.js";
import { portEnvoisPourBot, portPlanificationPourBot } from "../../src/sources/ports-bot.js";
import { SourcesService } from "../../src/sources/service.js";
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

const NOW = Date.parse("2026-11-20T10:00:00Z");

/** Canal SUIVI du bot `grolaf` : il n'existe QUE dans son miroir (jamais dans celui de `yuki`). */
const CANAL_GROLAF = "mm-canal-grolaf";

interface Banc {
  racine: string;
  env: Env;
  processEnv: NodeJS.ProcessEnv;
}

function banc(): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-ports-bot-"));
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
  return { racine, env, processEnv };
}

function bot(id: string, ordre: number): BotRecord {
  return {
    id,
    nom: id,
    capacites: [...CAPACITES_BOT],
    actif: true,
    ordre,
    creeLe: "2026-01-01T00:00:00.000Z",
    plateformes: {},
  };
}

/**
 * Objets d'un bot SUR SON `Env` — mêmes constructeurs que `main()`. ⚠️ Le miroir de
 * `grolaf` contient SON canal ; celui de `yuki` est VIDE : c'est la différence qui
 * faisait refuser `programmer_envoi` avant le correctif.
 */
function objetsBot(envBot: Env, botId: string): ObjetsPileSources {
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
    botId,
    secretNames: (nom) => nomsSecretsSource(botId, nom),
    promptTotalChars: () => 4_000,
  });
  const envois = new EnvoisProgrammesService({
    store: EnvoisProgrammesStore.open({ path: envBot.envoisProgrammesPath, logger: journal }),
    journal: jrn,
    // ⚠️ SES canaux suivis : le canal de `grolaf` n'est QUE chez lui.
    canaux: () =>
      botId === "grolaf"
        ? [{ conversationId: CANAL_GROLAF, titre: "Le canal de Grolaf", plateforme: "mattermost" }]
        : [],
    fichier: () => null,
    maxFichierBytes: () => 1_000_000,
    publier: async () => undefined,
    logger: journal,
    now: () => NOW,
  });
  return { store, inbox, journal: jrn, preAutorisations, service, envois };
}

interface Harnais {
  b: Banc;
  parBot: SourcesParBot;
  /** Chemin du `sources.json` D'UN bot (résolu par SON dossier, jamais par un autre). */
  fichierSources: (botId: string) => string;
  fichierEnvois: (botId: string) => string;
}

function harnais(options: { bots?: BotRecord[] } = {}): Harnais {
  const b = banc();
  const registre: RegistreBots = {
    schemaVersion: 1,
    majLe: "2026-11-20T00:00:00.000Z",
    botActif: "yuki",
    bots: options.bots ?? [bot("yuki", 0), bot("grolaf", 1)],
    echanges: {},
  } as RegistreBots;
  const parBot = new SourcesParBot({
    envInstance: b.env,
    mode: "multi",
    registre: () => registre,
    logger: journal,
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
    logger: journal,
  });
  parBot.setPileActive(fabrique.ouvrir("yuki"));
  parBot.setOuvrir((input) => fabrique.ouvrir(input.botId));
  return {
    b,
    parBot,
    // ⚠️ Le chemin est celui de l'`Env` RÉELLEMENT utilisé par la pile du bot :
    // l'`Env` d'instance pour le bot de la PILE (comme `main()`), le sien ailleurs.
    fichierSources: (botId) => envs.pour(botId).sourcesStorePath,
    fichierEnvois: (botId) => envs.pour(botId).envoisProgrammesPath,
  };
}

/** Noms des sources persistées dans un `sources.json` (`[]` si le fichier n'existe pas). */
function nomsDansLeFichier(chemin: string): string[] {
  if (!existsSync(chemin)) return [];
  const brut = JSON.parse(readFileSync(chemin, "utf8")) as unknown;
  const records = Array.isArray(brut)
    ? brut
    : ((brut as { sources?: unknown[] }).sources ?? []);
  return records
    .map((record) => (record as { nom?: unknown }).nom)
    .filter((nom): nom is string => typeof nom === "string");
}

/** Envois persistés dans un `envois-programmes.json` (`[]` si absent). */
function envoisDansLeFichier(chemin: string): EnvoiProgramme[] {
  if (!existsSync(chemin)) return [];
  const brut = JSON.parse(readFileSync(chemin, "utf8")) as unknown;
  if (Array.isArray(brut)) return brut as EnvoiProgramme[];
  return ((brut as { envois?: EnvoiProgramme[] }).envois ?? []) as EnvoiProgramme[];
}

// ── ① `planifier_tache` : le fichier du BOT DEMANDEUR ───────────────────────

describe("planifier_tache par bot (audit 2026-11-20, ①)", () => {
  it("⚠️ depuis le canal de grolaf, la tâche va dans state/bots/grolaf/sources.json", async () => {
    const h = harnais();
    // Ce que le câblage construit pour un run né dans le canal de `grolaf`.
    const port = portPlanificationPourBot(h.parBot, "grolaf");

    const issue = await port.planifier({
      quand: "dans 2 h",
      instruction: "résume les messages non lus du canal",
      nom: "Résumé du canal",
      // Un run de CANAL n'a pas de conversation locale (aucune cible de retour).
      conversation: {},
    });

    expect(issue.ok).toBe(true);
    const nom = (issue as { ok: true; nom: string }).nom;
    // ⚠️ LE point du défaut ① : le fichier du BON bot.
    expect(nomsDansLeFichier(h.fichierSources("grolaf"))).toContain(nom);
    // …et RIEN chez le bot du run : aucune fuite croisée.
    expect(nomsDansLeFichier(h.fichierSources("yuki"))).toEqual([]);
    // La pile de `yuki` le voit aussi (deux instances du même fichier interdites) :
    expect(h.parBot.pourBot("yuki").store.get(nom)).toBeUndefined();
    expect(h.parBot.pourBot("grolaf").store.get(nom)).toBeDefined();
  });

  it("un bot NON résolu ⇒ refus NOMMÉ `bot_inconnu`, jamais un repli sur la pile", async () => {
    const h = harnais();
    const port = portPlanificationPourBot(h.parBot, "fantome");

    const issue = await port.planifier({
      quand: "dans 2 h",
      instruction: "une instruction quelconque",
      conversation: {},
    });

    expect(issue.ok).toBe(false);
    const raison = (issue as { ok: false; raison: string }).raison;
    expect(raison).toContain("bot_inconnu");
    expect(raison).toContain("fantome");
    // ⚠️ Aucun repli silencieux : RIEN n'a été créé chez le bot de la pile.
    expect(nomsDansLeFichier(h.fichierSources("yuki"))).toEqual([]);
    expect(h.parBot.pourBot("yuki").store.list()).toEqual([]);
  });
});

// ── ② `programmer_envoi` : le miroir du BOT DEMANDEUR ───────────────────────

describe("programmer_envoi par bot (audit 2026-11-20, ①)", () => {
  it("⚠️ depuis le canal de grolaf, l'envoi est ACCEPTÉ et rangé chez grolaf", async () => {
    const h = harnais();
    const port = portEnvoisPourBot(h.parBot, "grolaf");

    const issue = await port.programmer({
      quand: "dans 10 min",
      texte: "Bonjour depuis le canal de Grolaf",
      conversation: { canal: CANAL_GROLAF },
    });

    expect(issue.ok).toBe(true);
    const envoisGrolaf = envoisDansLeFichier(h.fichierEnvois("grolaf"));
    expect(envoisGrolaf).toHaveLength(1);
    expect(envoisGrolaf[0]?.cible).toMatchObject({ conversationId: CANAL_GROLAF });
    // ⚠️ Le fichier du bot du run reste VIDE.
    expect(envoisDansLeFichier(h.fichierEnvois("yuki"))).toEqual([]);
  });

  it("le canal de grolaf est REFUSÉ pour la pile (preuve du défaut corrigé)", async () => {
    const h = harnais();
    // Les ports de la PILE : c'est ce que recevait le run distant avant le correctif.
    const portPile = portEnvoisPourBot(h.parBot, "yuki");

    const issue = await portPile.programmer({
      quand: "dans 10 min",
      texte: "Bonjour depuis le canal de Grolaf",
      conversation: { canal: CANAL_GROLAF },
    });

    expect(issue.ok).toBe(false);
    expect((issue as { ok: false; raison: string }).raison).toContain("Rien n'a été programmé");
    expect(envoisDansLeFichier(h.fichierEnvois("yuki"))).toEqual([]);
  });

  it("un bot NON résolu ⇒ refus NOMMÉ `bot_inconnu` (aucun envoi créé)", async () => {
    const h = harnais();
    const port = portEnvoisPourBot(h.parBot, "fantome");

    const issue = await port.programmer({
      quand: "dans 10 min",
      texte: "Bonjour",
      conversation: { canal: CANAL_GROLAF },
    });

    expect(issue.ok).toBe(false);
    expect((issue as { ok: false; raison: string }).raison).toContain("bot_inconnu");
    expect(h.parBot.pourBot("yuki").envois?.lister() ?? []).toEqual([]);
  });
});

// ── ④ Run LOCAL (web) : la pile du bot affiché, comme avant ────────────────

describe("run local inchangé (audit 2026-11-20, ①)", () => {
  it("les ports de la PILE écrivent dans le fichier du bot affiché", async () => {
    const h = harnais();
    // Le host local du bot affiché reçoit SES ports (`optionsHostBot`,
    // `src/bots/hosts.ts`) : ce sont, pour `yuki`, ceux de la pile ci-dessous.
    const port = portPlanificationPourBot(h.parBot, "yuki");

    const issue = await port.planifier({
      quand: "dans 1 h",
      instruction: "fais le point sur les tâches de la journée",
      nom: "Point du jour",
      // Conversation LOCALE : le résultat revient dans ce fil.
      conversation: { session: "session-web-1" },
    });

    expect(issue.ok).toBe(true);
    const nom = (issue as { ok: true; nom: string }).nom;
    expect(nomsDansLeFichier(h.fichierSources("yuki"))).toContain(nom);
    expect(nomsDansLeFichier(h.fichierSources("grolaf"))).toEqual([]);
    // La cible de retour est bien la session locale du fil.
    expect(h.parBot.pourBot("yuki").store.get(nom)?.sessionId).toBe("session-web-1");
  });
});
