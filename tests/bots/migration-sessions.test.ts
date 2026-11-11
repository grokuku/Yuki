/**
 * GARDE `MIGRATION_PARTIELLE` — LE CAS DES SESSIONS PI (`/data/pi/agent/sessions`).
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine :
 *  - le dossier de sessions d'origine ne peut PAS disparaître (c'est le PARENT
 *    de `<botId>`) ; l'ancienne garde le comptait comme « chemin en double » dès
 *    qu'il contenait autre chose que le dossier du bot EN COURS — donc dès qu'un
 *    SECOND bot existait (faux positif permanent, crash loop) ;
 *  - des sessions restées À PLAT étaient refusées sous le nom trompeur
 *    « chemins en double », sans aucune reprise.
 *
 * Règle verrouillée ici :
 *  - un dossier de sessions de bot CONNU à la racine ⇒ normal (jamais doublon) ;
 *  - des entrées qui ne sont pas des dossiers de bots connus ⇒ sessions NON
 *    MIGRÉES : reprise automatique (aucun contenu transformé), ou refus explicite
 *    `SESSIONS_NON_MIGREES` si la reprise est impossible ;
 *  - un VRAI fichier d'origine en double reste refusé (`MIGRATION_PARTIELLE`).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadEnv, type Env } from "../../src/config/env.js";
import {
  DemarrageRefuseError,
  cheminRegistreBots,
  creerRegistreInitial,
  ecrireRegistreBots,
  migrerVersMultiBot,
  preparerMultiBot,
  type RegistreBots,
} from "../../src/bots/index.js";
import { BOT_YUKI } from "../../src/bots/registry.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

const SESSION_FICHIER = "2026-01-01T10-00-00-000Z_abc.jsonl";
const SESSION_CONTENU = '{"type":"message","role":"user","texte":"bonjour"}\n';

interface Fixture {
  racine: string;
  state: string;
  /** Racine HISTORIQUE des sessions (`/data/pi/agent/sessions`). */
  sessions: string;
  env: Env;
}

function creerFixture(): Fixture {
  const racine = mkdtempSync(join(tmpdir(), "yuki-sessions-"));
  racines.push(racine);
  const state = join(racine, "state");
  const sessions = join(racine, "pi", "agent", "sessions");
  mkdirSync(state, { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const env = loadEnv({
    YUKI_MOUNT_STATE: state,
    YUKI_MOUNT_PI_AGENT: join(racine, "pi"),
    YUKI_LOG_LEVEL: "error",
  });
  return { racine, state, sessions, env };
}

/** `bots.json` avec `yuki` (et éventuellement d'autres bots). */
function poserRegistre(fixture: Fixture, ids: readonly string[] = [BOT_YUKI]): void {
  const initial = creerRegistreInitial();
  const modele = initial.bots[0] as RegistreBots["bots"][number];
  const bots = ids.map((id, index) =>
    id === BOT_YUKI
      ? modele
      : { ...modele, id, nom: id, ordre: index + 1, capacites: [] },
  );
  ecrireRegistreBots(cheminRegistreBots(fixture.state), { ...initial, bots });
}

/** Sessions DU BOT, à leur place après migration (`sessions/yuki/projet/…`). */
function poserSessionsMigrees(fixture: Fixture, botId: string = BOT_YUKI): void {
  const projet = join(fixture.sessions, botId, "projet");
  mkdirSync(projet, { recursive: true });
  writeFileSync(join(projet, SESSION_FICHIER), SESSION_CONTENU);
}

/** Sessions À PLAT (disposition mono-bot historique), directement à la racine. */
function poserSessionsAPlat(fixture: Fixture): void {
  const projet = join(fixture.sessions, "projet");
  mkdirSync(projet, { recursive: true });
  writeFileSync(join(projet, SESSION_FICHIER), SESSION_CONTENU);
}

describe("garde de démarrage — sessions Pi (MIGRATION_PARTIELLE)", () => {
  it("CAS 1 : `bots.json` + `sessions/<botId>/` ⇒ DÉMARRE (un parent n'est pas un doublon)", () => {
    const fixture = creerFixture();
    poserRegistre(fixture);
    poserSessionsMigrees(fixture);

    const preparation = preparerMultiBot(fixture.env, { processEnv: {} });

    expect(preparation.mode).toBe("multi");
    expect(preparation.bot?.id).toBe(BOT_YUKI);
    // Le bot lit bien SES sessions (sous-dossier), pas la racine.
    expect(preparation.env.piSessionsDir).toBe(join(fixture.sessions, BOT_YUKI));
  });

  it("CAS 1bis : `bots.json` + dossiers de PLUSIEURS bots connus ⇒ DÉMARRE", () => {
    const fixture = creerFixture();
    poserRegistre(fixture, [BOT_YUKI, "natsumi"]);
    poserSessionsMigrees(fixture, BOT_YUKI);
    poserSessionsMigrees(fixture, "natsumi");

    const preparation = preparerMultiBot(fixture.env, { processEnv: {} });

    expect(preparation.mode).toBe("multi");
    expect(preparation.bot?.id).toBe(BOT_YUKI);
    // ⚠️ Aucun déplacement : le dossier de l'autre bot reste à sa place.
    expect(existsSync(join(fixture.sessions, "natsumi", "projet", SESSION_FICHIER))).toBe(true);
    expect(existsSync(join(fixture.sessions, BOT_YUKI, "natsumi"))).toBe(false);
  });

  it("CAS 2 : `bots.json` + sessions À PLAT ⇒ REPRISE automatique (démarre, aucune perte)", () => {
    const fixture = creerFixture();
    poserRegistre(fixture);
    poserSessionsAPlat(fixture);

    const preparation = preparerMultiBot(fixture.env, { processEnv: {} });

    expect(preparation.mode).toBe("multi");
    expect(preparation.migration).toBe("sessions_reprises");
    // Les sessions sont rangées SOUS le dossier du bot, contenu INCHANGÉ.
    const rangee = join(fixture.sessions, BOT_YUKI, "projet", SESSION_FICHIER);
    expect(existsSync(rangee)).toBe(true);
    expect(readFileSync(rangee, "utf8")).toBe(SESSION_CONTENU);
    expect(existsSync(join(fixture.sessions, "projet"))).toBe(false);
    // Et le démarrage le DIT (pas de réparation silencieuse).
    expect(preparation.avertissements.join("\n")).toMatch(/Sessions Pi NON migrées/);
  });

  it("CAS 2bis : sessions À PLAT + reprise désactivée ⇒ refus « sessions non migrées »", () => {
    const fixture = creerFixture();
    poserRegistre(fixture);
    poserSessionsAPlat(fixture);

    let refus: unknown;
    try {
      preparerMultiBot(fixture.env, { processEnv: {}, reparationSessions: false });
    } catch (error) {
      refus = error;
    }

    expect(refus).toBeInstanceOf(DemarrageRefuseError);
    expect((refus as DemarrageRefuseError).code).toBe("SESSIONS_NON_MIGREES");
    const message = (refus as DemarrageRefuseError).message;
    expect(message).toMatch(/sessions non migrées/i);
    // ⚠️ La cause n'est PAS « chemins en double » : message et code distincts.
    expect(message).not.toContain("Chemins en double");
    expect((refus as DemarrageRefuseError).details).toContain(
      join(fixture.sessions, "projet"),
    );
    // Aucun déplacement n'a eu lieu (refus sans effet de bord).
    expect(existsSync(join(fixture.sessions, "projet", SESSION_FICHIER))).toBe(true);
  });

  it("CAS 2ter : sessions À PLAT + conflit de nom ⇒ refus, RIEN n'est écrasé", () => {
    const fixture = creerFixture();
    poserRegistre(fixture);
    poserSessionsMigrees(fixture);
    // Le même dossier de projet existe AUSSI à plat, avec un AUTRE contenu.
    const aPlat = join(fixture.sessions, "projet");
    mkdirSync(aPlat, { recursive: true });
    const contenuAPlat = '{"type":"message","role":"user","texte":"à plat"}\n';
    writeFileSync(join(aPlat, SESSION_FICHIER), contenuAPlat);

    let refus: unknown;
    try {
      preparerMultiBot(fixture.env, { processEnv: {} });
    } catch (error) {
      refus = error;
    }

    expect(refus).toBeInstanceOf(DemarrageRefuseError);
    expect((refus as DemarrageRefuseError).code).toBe("SESSIONS_NON_MIGREES");
    expect((refus as DemarrageRefuseError).message).toMatch(/projet/);
    // ⚠️ Aucune perte : les DEUX contenus sont intacts.
    expect(readFileSync(join(aPlat, SESSION_FICHIER), "utf8")).toBe(contenuAPlat);
    expect(
      readFileSync(join(fixture.sessions, BOT_YUKI, "projet", SESSION_FICHIER), "utf8"),
    ).toBe(SESSION_CONTENU);
  });

  it("CAS 3 : un VRAI fichier d'origine en double ⇒ `MIGRATION_PARTIELLE` conservé", () => {
    const fixture = creerFixture();
    poserRegistre(fixture);
    poserSessionsMigrees(fixture);
    // ⚠️ Sessions correctement rangées : seul `state/memory.jsonl` est en double.
    writeFileSync(join(fixture.state, "memory.jsonl"), '{"id":"m1"}\n');

    let refus: unknown;
    try {
      preparerMultiBot(fixture.env, { processEnv: {} });
    } catch (error) {
      refus = error;
    }

    expect(refus).toBeInstanceOf(DemarrageRefuseError);
    expect((refus as DemarrageRefuseError).code).toBe("MIGRATION_PARTIELLE");
    const details = (refus as DemarrageRefuseError).details;
    expect(details).toContain(join(fixture.state, "memory.jsonl"));
    // ⚠️ Les sessions ne sont PLUS accusées à tort.
    expect(details).not.toContain(fixture.sessions);
  });

  it("ne touche PAS une entrée étrangère quand le journal atteste les sessions rangées", () => {
    const fixture = creerFixture();
    poserSessionsAPlat(fixture);
    // VRAIE migration : journal `piSessionsDir: faite` + `bots.json`.
    expect(migrerVersMultiBot(fixture.env, { processEnv: {} }).etat).toBe("migre");
    // Résidu inconnu du registre à la racine : laissé EN PLACE, et DIT.
    const residu = join(fixture.sessions, "vieux-projet");
    mkdirSync(residu, { recursive: true });
    writeFileSync(join(residu, SESSION_FICHIER), SESSION_CONTENU);

    const preparation = preparerMultiBot(fixture.env, { processEnv: {} });

    expect(preparation.mode).toBe("multi");
    expect(existsSync(join(residu, SESSION_FICHIER))).toBe(true);
    expect(existsSync(join(fixture.sessions, BOT_YUKI, "vieux-projet"))).toBe(false);
    expect(preparation.avertissements.join("\n")).toContain("vieux-projet");
  });

  it("est IDEMPOTENT : une reprise déjà faite ne redéplace rien au démarrage suivant", () => {
    const fixture = creerFixture();
    poserRegistre(fixture);
    poserSessionsAPlat(fixture);

    expect(preparerMultiBot(fixture.env, { processEnv: {} }).migration).toBe(
      "sessions_reprises",
    );
    const second = preparerMultiBot(fixture.env, { processEnv: {} });
    expect(second.migration).toBe("aucune");
    expect(second.mode).toBe("multi");
    expect(
      readFileSync(join(fixture.sessions, BOT_YUKI, "projet", SESSION_FICHIER), "utf8"),
    ).toBe(SESSION_CONTENU);
  });

  it("reprise par DÉPLACEMENT (jamais une copie) : les octets sont identiques", () => {
    const fixture = creerFixture();
    poserRegistre(fixture);
    poserSessionsAPlat(fixture);
    const avant = readFileSync(join(fixture.sessions, "projet", SESSION_FICHIER));

    expect(preparerMultiBot(fixture.env, { processEnv: {} }).mode).toBe("multi");

    const apres = readFileSync(join(fixture.sessions, BOT_YUKI, "projet", SESSION_FICHIER));
    // ⚠️ Octet pour OCTET : c'est un `rename`, pas une copie.
    expect(apres.equals(avant)).toBe(true);
    // Une seule copie sur le disque : l'origine a bien disparu.
    expect(existsSync(join(fixture.sessions, "projet"))).toBe(false);
  });
});
