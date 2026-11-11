/**
 * LOT 35i — LE TROU DES SESSIONS Pi D'UN BOT SUPPRIMÉ.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `supprimerBot` ne touchait pas
 * `<pi>/agent/sessions/<id>` (autre VOLUME que `state`), donc les conversations
 * d'un bot supprimé survivaient indéfiniment, sans archive et sans purge —
 * exactement ce qu'il ne fallait pas : une perte (ou une survie) silencieuse.
 *
 * Ce qui est prouvé :
 *  ① `supprimerBot` COPIE les sessions dans `<archive>/sessions-pi/` puis les
 *    retire de leur volume (autre volume ⇒ jamais `rename`) ;
 *  ② un échec de copie ne perd RIEN : l'origine reste, l'échec est journalisé
 *    (`bot.sessions.echec`), remonté (`sessionsPi.etat = "echec"`), et un
 *    marqueur nomme les sessions restées en place ;
 *  ③ la PURGE des 90 jours efface `sessions-pi/` avec l'archive, et efface
 *    AUSSI les sessions restées en place (marqueur), à la même échéance ;
 *  ④ un marqueur INCOHÉRENT ne fait jamais supprimer un dossier arbitraire ;
 *  ⑤ le compteur de la confirmation compte les fichiers de session du bot.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MARQUEUR_SESSIONS_RESTANTES,
  MS_PAR_JOUR,
  SOUS_DOSSIER_SESSIONS_PI,
  SOUS_DOSSIER_SUPPRIMES,
  compterSessionsPi,
  purgerArchivesBots,
  supprimerBot,
} from "../../src/bots/admin.js";
import {
  CAPACITES_BOT,
  type BotRecord,
  type RegistreBots,
} from "../../src/bots/registry.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

const MAINTENANT = Date.parse("2026-11-09T22:29:00.000Z");
const NOM_ARCHIVE = "kohai-20261109-2229";

interface Banc {
  racine: string;
  stateDir: string;
  piSessionsDir: string;
  registre: RegistreBots;
  journal: { infos: Array<Record<string, unknown>>; warns: Array<Record<string, unknown>>; logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  } };
}

function bot(id: string, ordre: number, actif = false): BotRecord {
  return {
    id,
    nom: id === "yuki" ? "Yuki" : id,
    capacites: [...CAPACITES_BOT],
    actif,
    ordre,
    creeLe: "2026-01-01T00:00:00.000Z",
    plateformes: {},
  };
}

function banc(): Banc {
  const racine = mkdtempSync(join(tmpdir(), "yuki-sessions-pi-"));
  racines.push(racine);
  const stateDir = join(racine, "state");
  const piSessionsDir = join(racine, "pi", "agent", "sessions");
  mkdirSync(join(stateDir, "bots"), { recursive: true });
  mkdirSync(piSessionsDir, { recursive: true });
  const infos: Array<Record<string, unknown>> = [];
  const warns: Array<Record<string, unknown>> = [];
  return {
    racine,
    stateDir,
    piSessionsDir,
    registre: { schemaVersion: 1, bots: [bot("yuki", 0, true), bot("kohai", 1)], echanges: {} },
    journal: {
      infos,
      warns,
      logger: {
        info: (message, fields) => {
          infos.push({ message, ...(fields ?? {}) });
        },
        warn: (message, fields) => {
          warns.push({ message, ...(fields ?? {}) });
        },
      },
    },
  };
}

/** Dépose un dossier de bot dans `state` (pour que la suppression ait à déplacer). */
function dossierBot(b: Banc, id: string): void {
  mkdirSync(join(b.stateDir, "bots", id), { recursive: true });
  writeFileSync(join(b.stateDir, "bots", id, "memory.jsonl"), '{"v":1}\n');
}

/** Dépose deux fichiers de session pour un bot (projet → fichier, comme le SDK). */
function sessionsBot(b: Banc, id: string): string {
  const dir = join(b.piSessionsDir, id, "projet");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "2026-01-01T10-00-00-000Z_aaa.jsonl"), '{"role":"user"}\n');
  writeFileSync(join(dir, "2026-01-02T10-00-00-000Z_bbb.jsonl"), '{"role":"assistant"}\n');
  return join(b.piSessionsDir, id);
}

describe("① suppression — les sessions Pi sont ARCHIVÉES", () => {
  it("copie `<pi>/agent/sessions/<id>` dans `<archive>/sessions-pi/` puis la retire", () => {
    const b = banc();
    dossierBot(b, "kohai");
    const origine = sessionsBot(b, "kohai");
    const resultat = supprimerBot({
      stateDir: b.stateDir,
      registre: b.registre,
      botId: "kohai",
      maintenant: MAINTENANT,
      piSessionsDir: b.piSessionsDir,
      logger: b.journal.logger,
    });

    expect(resultat.sessionsPi.etat).toBe("deplace");
    const archive = join(b.stateDir, SOUS_DOSSIER_SUPPRIMES, NOM_ARCHIVE);
    expect(resultat.archive).toBe(archive);
    expect(resultat.sessionsPi.archive).toBe(join(archive, SOUS_DOSSIER_SESSIONS_PI));
    // Contenu CONSERVÉ, octet pour octet.
    expect(
      readFileSync(
        join(archive, SOUS_DOSSIER_SESSIONS_PI, "projet", "2026-01-01T10-00-00-000Z_aaa.jsonl"),
        "utf8",
      ),
    ).toBe('{"role":"user"}\n');
    // Origine RETIRÉE (copie vérifiée avant), et le journal le dit.
    expect(existsSync(origine)).toBe(false);
    expect(
      b.journal.infos.some((entree) => entree.message === "bot.sessions.deplacees"),
    ).toBe(true);
  });

  it("bot sans session ⇒ `absent` (aucun dossier créé sur le volume `pi`)", () => {
    const b = banc();
    dossierBot(b, "kohai");
    const resultat = supprimerBot({
      stateDir: b.stateDir,
      registre: b.registre,
      botId: "kohai",
      maintenant: MAINTENANT,
      piSessionsDir: b.piSessionsDir,
    });
    expect(resultat.sessionsPi.etat).toBe("absent");
    expect(existsSync(join(b.piSessionsDir, "kohai"))).toBe(false);
  });

  it("volume `pi` NON fourni ⇒ `inconnu` (on ne prétend pas avoir archivé)", () => {
    const b = banc();
    dossierBot(b, "kohai");
    const origine = sessionsBot(b, "kohai");
    const resultat = supprimerBot({
      stateDir: b.stateDir,
      registre: b.registre,
      botId: "kohai",
      maintenant: MAINTENANT,
    });
    expect(resultat.sessionsPi.etat).toBe("inconnu");
    expect(resultat.sessionsPi.origine).toBe(null);
    // Les sessions sont INTACTES : on n'a rien touché faute de savoir où.
    expect(existsSync(origine)).toBe(true);
  });
});

describe("② échec de copie — rien n'est perdu, et c'est DIT", () => {
  it("l'origine reste, l'échec est journalisé, remonté et MARQUÉ dans l'archive", () => {
    const b = banc();
    dossierBot(b, "kohai");
    const origine = sessionsBot(b, "kohai");

    const resultat = supprimerBot({
      stateDir: b.stateDir,
      registre: b.registre,
      botId: "kohai",
      maintenant: MAINTENANT,
      piSessionsDir: b.piSessionsDir,
      logger: b.journal.logger,
      // Couture : la copie échoue (volume plein, E/S…). `chmod` ne retiendrait
      // pas `root`, donc on force l'erreur au point exact du produit.
      copierSessions: () => {
        throw new Error("EIO : volume `pi` illisible");
      },
    });

    // ① L'échec est REMONTÉ (l'interface le dit) et JOURNALISÉ.
    expect(resultat.sessionsPi.etat).toBe("echec");
    expect(resultat.sessionsPi.erreur).toContain("EIO");
    expect(b.journal.warns.some((entree) => entree.message === "bot.sessions.echec")).toBe(true);

    // ② ⚠️ AUCUNE PERTE : l'origine est intacte et complète.
    expect(existsSync(origine)).toBe(true);
    expect(
      readFileSync(join(origine, "projet", "2026-01-02T10-00-00-000Z_bbb.jsonl"), "utf8"),
    ).toBe('{"role":"assistant"}\n');

    // ③ Un marqueur nomme le dossier resté en place (pour la purge à l'échéance),
    // et aucun demi-archivage ne reste dans l'archive.
    const archive = resultat.archive as string;
    expect(existsSync(join(archive, SOUS_DOSSIER_SESSIONS_PI))).toBe(false);
    const marqueur = join(archive, MARQUEUR_SESSIONS_RESTANTES);
    expect(existsSync(marqueur)).toBe(true);
    expect(JSON.parse(readFileSync(marqueur, "utf8"))).toMatchObject({ origine });
  });
});

describe("③ purge des 90 jours — les sessions partent avec l'archive", () => {
  it("`sessions-pi/` est effacé avec l'archive expirée", () => {
    const b = banc();
    dossierBot(b, "kohai");
    sessionsBot(b, "kohai");
    const resultat = supprimerBot({
      stateDir: b.stateDir,
      registre: b.registre,
      botId: "kohai",
      maintenant: MAINTENANT,
      piSessionsDir: b.piSessionsDir,
    });
    const archive = resultat.archive as string;
    const sessionsArchivees = join(archive, SOUS_DOSSIER_SESSIONS_PI);
    expect(existsSync(sessionsArchivees)).toBe(true);

    // 89 jours : conservé.
    const conserve = purgerArchivesBots({
      stateDir: b.stateDir,
      maintenant: MAINTENANT + 89 * MS_PAR_JOUR,
      piSessionsDir: b.piSessionsDir,
      logger: b.journal.logger,
    });
    expect(conserve.purges).toEqual([]);
    expect(existsSync(sessionsArchivees)).toBe(true);

    // 91 jours : effacé, sessions comprises.
    const purge = purgerArchivesBots({
      stateDir: b.stateDir,
      maintenant: MAINTENANT + 91 * MS_PAR_JOUR,
      piSessionsDir: b.piSessionsDir,
      logger: b.journal.logger,
    });
    expect(purge.purges).toEqual([NOM_ARCHIVE]);
    expect(existsSync(archive)).toBe(false);
    expect(existsSync(sessionsArchivees)).toBe(false);
  });

  it("les sessions RESTÉES en place (marqueur) sont effacées à la même échéance", () => {
    const b = banc();
    const origine = sessionsBot(b, "kohai");
    const archive = join(b.stateDir, SOUS_DOSSIER_SUPPRIMES, NOM_ARCHIVE);
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      join(archive, MARQUEUR_SESSIONS_RESTANTES),
      `${JSON.stringify({ origine, erreur: "copie impossible" })}\n`,
    );
    // 91 jours après l'horodatage du nom d'archive.
    const resultat = purgerArchivesBots({
      stateDir: b.stateDir,
      maintenant: MAINTENANT + 91 * MS_PAR_JOUR,
      piSessionsDir: b.piSessionsDir,
      logger: b.journal.logger,
    });
    expect(resultat.purges).toEqual([NOM_ARCHIVE]);
    expect(resultat.sessionsPurgees).toEqual(["kohai"]);
    expect(existsSync(origine)).toBe(false);
  });

  it("un marqueur INCOHÉRENT ne fait JAMAIS supprimer un dossier arbitraire", () => {
    const b = banc();
    // Un dossier qui n'appartient PAS au volume `pi`.
    const ailleurs = join(b.racine, "ailleurs");
    mkdirSync(ailleurs, { recursive: true });
    writeFileSync(join(ailleurs, "temoins.txt"), "à conserver");
    const archive = join(b.stateDir, SOUS_DOSSIER_SUPPRIMES, NOM_ARCHIVE);
    mkdirSync(archive, { recursive: true });
    writeFileSync(
      join(archive, MARQUEUR_SESSIONS_RESTANTES),
      `${JSON.stringify({ origine: ailleurs })}\n`,
    );
    const resultat = purgerArchivesBots({
      stateDir: b.stateDir,
      maintenant: MAINTENANT + 91 * MS_PAR_JOUR,
      piSessionsDir: b.piSessionsDir,
      logger: b.journal.logger,
    });
    expect(resultat.sessionsPurgees).toEqual([]);
    expect(existsSync(join(ailleurs, "temoins.txt"))).toBe(true);
    expect(
      b.journal.warns.some((entree) => entree.message === "bot.sessions.marqueur_incoherent"),
    ).toBe(true);
  });
});

describe("④ compteur de la confirmation", () => {
  it("compte les FICHIERS de session du bot (récursif), zéro ailleurs", () => {
    const b = banc();
    sessionsBot(b, "kohai");
    sessionsBot(b, "yuki");
    expect(compterSessionsPi(b.piSessionsDir, "kohai")).toBe(2);
    expect(compterSessionsPi(b.piSessionsDir, "inconnu")).toBe(0);
    expect(compterSessionsPi(undefined, "kohai")).toBe(0);
  });

  it("un identifiant invalide est REFUSÉ (jamais un dossier hors du volume `pi`)", () => {
    const b = banc();
    expect(() => compterSessionsPi(b.piSessionsDir, "../state")).toThrowError(/invalide/);
  });
});

describe("⑤ horodatage de l'archive (référence des tests ci-dessus)", () => {
  it("le nom d'archive porte la date UTC de la suppression", () => {
    const b = banc();
    dossierBot(b, "kohai");
    const resultat = supprimerBot({
      stateDir: b.stateDir,
      registre: b.registre,
      botId: "kohai",
      maintenant: MAINTENANT,
    });
    expect(resultat.archive?.endsWith(`/${NOM_ARCHIVE}`)).toBe(true);
    // (mtime non utilisé : un dossier vieilli à la main garde son âge)
    utimesSync(resultat.archive as string, new Date(), new Date());
  });
});
