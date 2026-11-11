/**
 * LOT 35a — MULTI-BOT : STRUCTURE + MIGRATION.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/bots/**` n'existait pas
 * (import introuvable). Ils ne testent AUCUNE fonction visible : le produit rend
 * les mêmes fichiers au même endroit, seule la DISPOSITION change.
 *
 * Ce qui est verrouillé :
 *  - les 22 chemins d'`Env` propres à un bot + les 4 chemins DÉRIVÉS
 *    (historiques/journaux de `personality.md` et `rules.md`) + les SESSIONS Pi
 *    (autre volume) sont déplacés, contenus IDENTIQUES octet pour octet ;
 *  - `bots.json` n'est écrit qu'à la FIN (jamais si les sessions n'ont pas pu
 *    être déplacées : Yuki perdrait son historique) ;
 *  - la migration est IDEMPOTENTE et REPRENABLE après coupure (journal réécrit
 *    après chaque `rename`) ;
 *  - `MIGRATION_PARTIELLE` : `bots.json` + un chemin d'origine encore là ⇒
 *    démarrage REFUSÉ avec la liste exacte des chemins ;
 *  - une surcharge d'environnement hors du volume `state` est SAUTÉE et
 *    signalée (aucun déplacement sauvage) ;
 *  - une mémoire écrite avant la migration est lue après (aucun comportement
 *    changé).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv, type Env } from "../../src/config/env.js";
import {
  DemarrageRefuseError,
  cheminsOrigineEncorePresents,
  cheminJournalMigration,
  cheminRegistreBots,
  creerRegistreInitial,
  ecrireRegistreBots,
  lireJournalMigration,
  lireRegistreBots,
  migrerVersMultiBot,
  preparerMultiBot,
} from "../../src/bots/index.js";
import { CAPACITES_BOT } from "../../src/bots/registry.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

/**
 * Table ATTENDUE, écrite À LA MAIN (indépendante du code) : `origine` est
 * relative au volume `state`, `cible` aussi. `sessions` est traitée à part
 * (volume `pi`).
 */
const ATTENDUS: readonly {
  cle: string;
  origine: string;
  cible: string;
  genre: "fichier" | "repertoire";
}[] = [
  { cle: "memoryStorePath", origine: "memory.jsonl", cible: "bots/yuki/memory.jsonl", genre: "fichier" },
  { cle: "memoryIndexPath", origine: "memory-index.sqlite", cible: "bots/yuki/memory-index.sqlite", genre: "fichier" },
  { cle: "memoryConsolidationDir", origine: "memory-archive/consolidation", cible: "bots/yuki/memory-archive/consolidation", genre: "repertoire" },
  { cle: "memoryConsolidationStatePath", origine: "memory-consolidation.json", cible: "bots/yuki/memory-consolidation.json", genre: "fichier" },
  { cle: "heritageDir", origine: "memory-heritage", cible: "bots/yuki/memory-heritage", genre: "repertoire" },
  { cle: "conversationArchiveDir", origine: "conversations-archive", cible: "bots/yuki/conversations-archive", genre: "repertoire" },
  { cle: "conversationArchiveIndexPath", origine: "conversations-archive-index.sqlite", cible: "bots/yuki/conversations-archive-index.sqlite", genre: "fichier" },
  { cle: "personalityPath", origine: "personality.md", cible: "bots/yuki/personality.md", genre: "fichier" },
  { cle: "rulesPath", origine: "rules.md", cible: "bots/yuki/rules.md", genre: "fichier" },
  { cle: "sessionPinsPath", origine: "session-pins.json", cible: "bots/yuki/session-pins.json", genre: "fichier" },
  { cle: "reactionsStorePath", origine: "reactions.jsonl", cible: "bots/yuki/reactions.jsonl", genre: "fichier" },
  { cle: "jobsStorePath", origine: "jobs.jsonl", cible: "bots/yuki/jobs.jsonl", genre: "fichier" },
  { cle: "librarianJobsPath", origine: "librarian-jobs.jsonl", cible: "bots/yuki/librarian-jobs.jsonl", genre: "fichier" },
  { cle: "librarianShotsDir", origine: "librarian-shots", cible: "bots/yuki/librarian-shots", genre: "repertoire" },
  { cle: "sourcesStorePath", origine: "sources.json", cible: "bots/yuki/sources.json", genre: "fichier" },
  { cle: "sourcesInboxPath", origine: "sources-inbox.json", cible: "bots/yuki/sources-inbox.json", genre: "fichier" },
  { cle: "declencheursJournalPath", origine: "declencheurs-journal.jsonl", cible: "bots/yuki/declencheurs-journal.jsonl", genre: "fichier" },
  { cle: "preAutorisationsPath", origine: "preautorisations.json", cible: "bots/yuki/preautorisations.json", genre: "fichier" },
  { cle: "envoisProgrammesPath", origine: "envois-programmes.json", cible: "bots/yuki/envois-programmes.json", genre: "fichier" },
  { cle: "avatarDir", origine: "avatar", cible: "bots/yuki/avatar", genre: "repertoire" },
  { cle: "chatMirrorPath", origine: "chat-mirror.json", cible: "bots/yuki/chat-mirror.json", genre: "fichier" },
  { cle: "chatMirrorDir", origine: "chat-mirror", cible: "bots/yuki/chat-mirror", genre: "repertoire" },
  // Chemins DÉRIVÉS des documents éditables (src/state/text-document-store.ts:192-194).
  { cle: "personalityHistoryDir", origine: "personality-history", cible: "bots/yuki/personality-history", genre: "repertoire" },
  { cle: "personalityJournalPath", origine: "personality-journal.jsonl", cible: "bots/yuki/personality-journal.jsonl", genre: "fichier" },
  { cle: "rulesHistoryDir", origine: "rules-history", cible: "bots/yuki/rules-history", genre: "repertoire" },
  { cle: "rulesJournalPath", origine: "rules-journal.jsonl", cible: "bots/yuki/rules-journal.jsonl", genre: "fichier" },
];

const SESSION_FICHIER = "2026-01-01T10-00-00-000Z_abc.jsonl";
const SESSION_CONTENU = '{"type":"message","role":"user","texte":"bonjour"}\n';

interface Fixture {
  racine: string;
  env: Env;
  state: string;
  sessions: string;
}

/** Crée une disposition MONO-BOT complète (fichiers + dossiers + sessions). */
function creerFixture(
  options: { sans?: readonly string[]; envSupplementaire?: Record<string, string> } = {},
): Fixture {
  const racine = mkdtempSync(join(tmpdir(), "yuki-bots-"));
  racines.push(racine);
  const state = join(racine, "state");
  const sessions = join(racine, "pi", "agent", "sessions");
  mkdirSync(state, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const sans = new Set(options.sans ?? []);
  for (const attendu of ATTENDUS) {
    if (sans.has(attendu.cle)) continue;
    const chemin = join(state, attendu.origine);
    if (attendu.genre === "repertoire") {
      mkdirSync(chemin, { recursive: true });
      writeFileSync(join(chemin, "contenu.txt"), `contenu de ${attendu.cle}\n`);
      continue;
    }
    mkdirSync(dirname(chemin), { recursive: true });
    writeFileSync(chemin, `contenu de ${attendu.cle}\n`);
  }
  // Un dossier de sessions imbriqué, comme le SDK Pi (projet → fichier).
  mkdirSync(join(sessions, "projet"), { recursive: true });
  writeFileSync(join(sessions, "projet", SESSION_FICHIER), SESSION_CONTENU);
  const env = loadEnv({
    YUKI_MOUNT_STATE: state,
    YUKI_MOUNT_PI_AGENT: join(racine, "pi"),
    YUKI_LOG_LEVEL: "error",
    ...(options.envSupplementaire ?? {}),
  });
  return { racine, env, state, sessions };
}

describe("Migration mono-bot → multi-bot (lot 35a)", () => {
  it("déplace les 22 chemins d'état, les 4 dérivés et les sessions — contenus IDENTIQUES", () => {
    const fixture = creerFixture();
    // Octets AVANT, pour comparaison stricte après déplacement.
    const avant = new Map<string, Buffer>();
    for (const attendu of ATTENDUS) {
      const chemin = join(fixture.state, attendu.origine);
      avant.set(
        attendu.cle,
        attendu.genre === "fichier"
          ? readFileSync(chemin)
          : readFileSync(join(chemin, "contenu.txt")),
      );
    }

    const resultat = migrerVersMultiBot(fixture.env, { processEnv: {} });
    expect(resultat.etat).toBe("migre");

    for (const attendu of ATTENDUS) {
      const cible = join(fixture.state, attendu.cible);
      expect(existsSync(cible), `cible absente : ${attendu.cible}`).toBe(true);
      expect(existsSync(join(fixture.state, attendu.origine)), `origine encore là : ${attendu.origine}`).toBe(false);
      const apres =
        attendu.genre === "fichier"
          ? readFileSync(cible)
          : readFileSync(join(cible, "contenu.txt"));
      // ⚠️ Octet pour OCTET : la migration est un `rename`, pas une copie.
      expect(apres.equals(avant.get(attendu.cle) as Buffer)).toBe(true);
    }

    // Sessions Pi : AUTRE volume, déplacées SOUS le dossier du bot.
    expect(existsSync(join(fixture.sessions, "yuki", "projet", SESSION_FICHIER))).toBe(true);
    expect(readFileSync(join(fixture.sessions, "yuki", "projet", SESSION_FICHIER), "utf8")).toBe(
      SESSION_CONTENU,
    );
    expect(existsSync(join(fixture.sessions, "projet"))).toBe(false);
  });

  it("écrit `bots.json` à la FIN : un seul bot `yuki`, aucun échange, aucun frein", () => {
    const fixture = creerFixture();
    expect(existsSync(cheminRegistreBots(fixture.state))).toBe(false);

    expect(migrerVersMultiBot(fixture.env, { processEnv: {} }).etat).toBe("migre");

    const registre = lireRegistreBots(cheminRegistreBots(fixture.state));
    expect(registre).not.toBeNull();
    expect(registre?.schemaVersion).toBe(1);
    expect(registre?.bots).toHaveLength(1);
    expect(registre?.bots[0]?.id).toBe("yuki");
    expect(registre?.bots[0]?.nom).toBe("Yuki");
    // ⚠️ Le bot historique reçoit TOUTES les capacités (lot 35h) : sans cela, Yuki
    // perdrait `run_command`, la délégation et la mémoire au premier démarrage.
    expect(registre?.bots[0]?.capacites).toEqual([...CAPACITES_BOT]);
    expect(registre?.bots[0]?.actif).toBe(true);
    expect(registre?.bots[0]?.ordre).toBe(0);
    expect(registre?.bots[0]?.plateformes).toEqual({});
    // ⚠️ Aucune paire d'échanges (donc AUCUN plafond, aucun frein) à ce stade.
    expect(registre?.echanges).toEqual({});
    // Journal refermé.
    expect(lireJournalMigration(cheminJournalMigration(fixture.state))?.etat).toBe("termine");
  });

  it("est IDEMPOTENTE : une seconde exécution ne déplace plus rien", () => {
    const fixture = creerFixture();
    expect(migrerVersMultiBot(fixture.env, { processEnv: {} }).etat).toBe("migre");
    const second = migrerVersMultiBot(fixture.env, { processEnv: {} });
    expect(second.etat).toBe("deja_migre");
    // Rien n'a été perdu.
    for (const attendu of ATTENDUS) {
      expect(existsSync(join(fixture.state, attendu.cible))).toBe(true);
    }
    expect(existsSync(join(fixture.sessions, "yuki", "projet", SESSION_FICHIER))).toBe(true);
  });

  it("REPREND après une coupure au milieu (journal réécrit après chaque `rename`)", () => {
    const fixture = creerFixture();
    const coupure = new Error("coupure simulée du processus");
    let vues = 0;
    expect(() =>
      migrerVersMultiBot(fixture.env, {
        processEnv: {},
        apresEntree: () => {
          vues += 1;
          if (vues === 6) throw coupure;
        },
      }),
    ).toThrow(coupure);
    expect(vues).toBe(6);

    const journal = lireJournalMigration(cheminJournalMigration(fixture.state));
    expect(journal?.etat).toBe("en_cours");
    const faites = journal?.entrees.filter((entree) => entree.statut === "faite") ?? [];
    const aFaire = journal?.entrees.filter((entree) => entree.statut === "a_faire") ?? [];
    expect(faites).toHaveLength(6);
    expect(aFaire.length).toBeGreaterThan(0);
    // ⚠️ `bots.json` n'est PAS écrit tant que tout n'est pas déplacé.
    expect(existsSync(cheminRegistreBots(fixture.state))).toBe(false);

    // Relance : seules les entrées `a_faire` sont rejouées.
    const reprise = migrerVersMultiBot(fixture.env, { processEnv: {} });
    expect(reprise.etat).toBe("migre");
    expect(reprise.etat === "migre" ? reprise.deplacees : -1).toBe(aFaire.length);
    for (const attendu of ATTENDUS) {
      expect(existsSync(join(fixture.state, attendu.cible))).toBe(true);
      expect(existsSync(join(fixture.state, attendu.origine))).toBe(false);
    }
    expect(existsSync(join(fixture.sessions, "yuki", "projet", SESSION_FICHIER))).toBe(true);
    expect(existsSync(cheminRegistreBots(fixture.state))).toBe(true);
  });

  it("ne déplace JAMAIS une entrée qu'une surcharge de déploiement apparue entre-temps interdit", () => {
    const fixture = creerFixture();
    // Coupure après 10 entrées : `sourcesStorePath` reste `a_faire` au journal.
    expect(() =>
      migrerVersMultiBot(fixture.env, {
        processEnv: {},
        apresEntree: (_entree, index) => {
          if (index === 9) throw new Error("coupure simulée");
        },
      }),
    ).toThrow("coupure simulée");
    expect(
      lireJournalMigration(cheminJournalMigration(fixture.state))?.entrees.find(
        (entree) => entree.cle === "sourcesStorePath",
      )?.statut,
    ).toBe("a_faire");

    // Une surcharge HORS volume apparaît ; `env` ET `processEnv` la portent.
    const horsVolume = join(fixture.racine, "ailleurs", "sources.json");
    mkdirSync(dirname(horsVolume), { recursive: true });
    writeFileSync(horsVolume, '{"schemaVersion":2,"sources":[]}\n');
    const processEnv = { YUKI_SOURCES_STORE_PATH: horsVolume };
    const env2 = loadEnv({
      YUKI_MOUNT_STATE: fixture.state,
      YUKI_MOUNT_PI_AGENT: join(fixture.racine, "pi"),
      YUKI_LOG_LEVEL: "error",
      ...processEnv,
    });

    const reprise = migrerVersMultiBot(env2, { processEnv });
    expect(reprise.etat).toBe("migre");
    // ⚠️ Aucun déplacement sauvage : l'origine par défaut est restée en place.
    expect(existsSync(join(fixture.state, "sources.json"))).toBe(true);
    expect(existsSync(join(fixture.state, "bots/yuki/sources.json"))).toBe(false);
    // L'entrée a quitté la liste des travaux à faire : plus de `a_faire` en attente.
    expect(
      lireJournalMigration(cheminJournalMigration(fixture.state))?.entrees.some(
        (entree) => entree.statut === "a_faire",
      ),
    ).toBe(false);
    // Et le démarrage n'est PAS refusé pour autant (cette origine n'est plus surveillée).
    expect(cheminsOrigineEncorePresents(env2, "yuki", processEnv)).toEqual([]);
  });

  it("n'écrit PAS `bots.json` si le déplacement des SESSIONS Pi échoue (Yuki garde son historique)", () => {
    const fixture = creerFixture();
    const echec = migrerVersMultiBot(fixture.env, {
      processEnv: {},
      deplacer: (origine, cible) => {
        if (origine.startsWith(join(fixture.racine, "pi")) || cible.startsWith(join(fixture.racine, "pi"))) {
          throw new Error("panne simulée du volume pi");
        }
        renameSync(origine, cible);
      },
    });
    expect(echec.etat).toBe("echec");
    if (echec.etat === "echec") {
      expect(echec.code).toBe("MIGRATION_ECHOUEE");
      expect(echec.entrees.join(" ")).toContain("piSessionsDir");
    }
    // ⚠️ C'est LA garantie : pas de bascule sans les sessions.
    expect(existsSync(cheminRegistreBots(fixture.state))).toBe(false);
    expect(lireJournalMigration(cheminJournalMigration(fixture.state))?.etat).toBe("en_cours");
    // Les sessions sont TOUJOURS à leur place historique (aucune perte).
    expect(existsSync(join(fixture.sessions, "projet", SESSION_FICHIER))).toBe(true);

    // Après réparation, la reprise termine le travail et bascule le système.
    const reprise = migrerVersMultiBot(fixture.env, { processEnv: {} });
    expect(reprise.etat).toBe("migre");
    expect(existsSync(cheminRegistreBots(fixture.state))).toBe(true);
    expect(existsSync(join(fixture.sessions, "yuki", "projet", SESSION_FICHIER))).toBe(true);
  });

  it("REFUSE le démarrage si `bots.json` existe et qu'un chemin d'origine est encore là (MIGRATION_PARTIELLE)", () => {
    const fixture = creerFixture();
    // `bots.json` posé à la main + un fichier d'origine qui traîne.
    ecrireRegistreBots(cheminRegistreBots(fixture.state), creerRegistreInitial());
    expect(cheminsOrigineEncorePresents(fixture.env, "yuki", {})).toContain(
      join(fixture.state, "memory.jsonl"),
    );

    let refus: unknown;
    try {
      preparerMultiBot(fixture.env, { processEnv: {} });
    } catch (error) {
      refus = error;
    }
    expect(refus).toBeInstanceOf(DemarrageRefuseError);
    expect((refus as DemarrageRefuseError).code).toBe("MIGRATION_PARTIELLE");
    const details = (refus as DemarrageRefuseError).details.join("\n");
    // La liste EXACTE des chemins en double, pas un message vague.
    expect(details).toContain(join(fixture.state, "memory.jsonl"));
    expect(details).toContain(join(fixture.state, "personality.md"));
    expect((refus as DemarrageRefuseError).message).toContain("Chemins en double");
  });

  it("ne change AUCUN comportement : une mémoire écrite AVANT la migration est lue APRÈS", () => {
    const fixture = creerFixture();
    const memoire = '{"id":"m1","texte":"souvenir d\'avant migration"}\n';
    writeFileSync(join(fixture.state, "memory.jsonl"), memoire);

    expect(migrerVersMultiBot(fixture.env, { processEnv: {} }).etat).toBe("migre");

    const preparation = preparerMultiBot(fixture.env, { processEnv: {} });
    expect(preparation.mode).toBe("multi");
    expect(preparation.bot?.id).toBe("yuki");
    // Le produit lit les MÊMES fichiers, au nouvel endroit.
    expect(preparation.env.memoryStorePath).toBe(join(fixture.state, "bots/yuki/memory.jsonl"));
    expect(readFileSync(preparation.env.memoryStorePath, "utf8")).toBe(memoire);
    expect(preparation.env.piSessionsDir).toBe(join(fixture.sessions, "yuki"));
    expect(existsSync(join(preparation.env.piSessionsDir, "projet", SESSION_FICHIER))).toBe(true);
    // ⚠️ Les chemins GLOBAUX de l'instance ne bougent pas.
    expect(preparation.env.configStorePath).toBe(fixture.env.configStorePath);
    expect(preparation.env.secretsVaultPath).toBe(fixture.env.secretsVaultPath);
    expect(preparation.env.filesDir).toBe(fixture.env.filesDir);
    expect(preparation.env.auditLogPath).toBe(fixture.env.auditLogPath);
  });

  it("SAUTE une surcharge d'environnement hors du volume `state` (et le dit)", () => {
    const racine = mkdtempSync(join(tmpdir(), "yuki-bots-"));
    racines.push(racine);
    const horsVolume = join(racine, "ailleurs", "sources.json");
    mkdirSync(dirname(horsVolume), { recursive: true });
    writeFileSync(horsVolume, '{"schemaVersion":2,"sources":[]}\n');
    // ⚠️ `env` ET `processEnv` portent la MÊME surcharge : c'est ce que fait la
    // production (`loadEnv()` lit `process.env`).
    const processEnv = { YUKI_SOURCES_STORE_PATH: horsVolume };
    const fixture = creerFixture({
      sans: ["sourcesStorePath"],
      envSupplementaire: processEnv,
    });

    const resultat = migrerVersMultiBot(fixture.env, { processEnv });
    expect(resultat.etat).toBe("migre");
    if (resultat.etat === "migre") {
      expect(resultat.ignorees.map((entree) => entree.cle)).toEqual(["sourcesStorePath"]);
      expect(resultat.ignorees[0]?.variable).toBe("YUKI_SOURCES_STORE_PATH");
    }
    // ⚠️ Aucun déplacement sauvage : ni la cible, ni l'origine par défaut.
    expect(existsSync(join(fixture.state, "bots/yuki/sources.json"))).toBe(false);
    expect(existsSync(join(fixture.state, "sources.json"))).toBe(false);
    expect(readFileSync(horsVolume, "utf8")).toBe('{"schemaVersion":2,"sources":[]}\n');

    const preparation = preparerMultiBot(fixture.env, { processEnv });
    expect(preparation.mode).toBe("multi");
    // La surcharge de déploiement est CONSERVÉE telle quelle…
    expect(preparation.env.sourcesStorePath).toBe(horsVolume);
    // … et signalée au démarrage.
    expect(preparation.avertissements.join("\n")).toContain("YUKI_SOURCES_STORE_PATH");
    expect(preparation.avertissements.join("\n")).toContain("hors du volume");
  });

  it("sans `bots.json` et sans migration autorisée : mode MONO-BOT historique intact", () => {
    const fixture = creerFixture();
    const preparation = preparerMultiBot(fixture.env, {
      processEnv: {},
      migrationAutomatique: false,
    });
    expect(preparation.mode).toBe("mono");
    expect(preparation.env).toBe(fixture.env);
    // Rien n'a été créé : le produit marche exactement comme avant.
    expect(existsSync(cheminRegistreBots(fixture.state))).toBe(false);
    expect(existsSync(join(fixture.state, "bots"))).toBe(false);
    expect(existsSync(join(fixture.state, "memory.jsonl"))).toBe(true);
  });
});
