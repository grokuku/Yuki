/**
 * ADMINISTRATION DES BOTS (lot 35e) : CRÉATION, CLONE, SUPPRESSION, RÉTENTION.
 *
 * Ce que ce fichier verrouille :
 *  - `creerBot` crée le DOSSIER, l'entrée du registre et l'overlay ; refuse un
 *    slug invalide, un slug en double, un nom hors bornes et un 7ᵉ bot
 *    (`max_bots`) ;
 *  - un CLONE copie l'identité et les capacités PAR DÉFAUT, ne copie NI la
 *    mémoire NI les déclencheurs par défaut, et ne copie JAMAIS ce qui
 *    n'appartient qu'à un bot (garde `JAMAIS_COPIES`) ;
 *  - `supprimerBot` DÉPLACE le dossier dans `bots-supprimes/` (fichiers
 *    intacts), refuse le dernier bot (`dernier_bot`) et promeut le bot suivant
 *    quand le bot actif disparaît ;
 *  - la RÉTENTION purge à plus de 90 jours et conserve 89 jours ;
 *  - les compteurs de la confirmation (conversations, souvenirs, déclencheurs,
 *    taille) sont RÉELS.
 *
 * ⚠️ Échoue sur le code d'origine : `src/bots/admin.ts` n'existe pas.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ELEMENTS_CLONE,
  JAMAIS_COPIES,
  MAX_BOTS,
  MS_PAR_JOUR,
  SOUS_DOSSIER_SUPPRIMES,
  AdminBotError,
  compterDonneesBot,
  creerBot,
  dateArchive,
  elementsDemandes,
  estJamaisCopie,
  horodatageArchive,
  purgerArchivesBots,
  supprimerBot,
} from "../../src/bots/admin.js";
import type { BotRecord, RegistreBots } from "../../src/bots/registry.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

function bot(id: string, ordre: number, actif = false): BotRecord {
  return {
    id,
    nom: id === "yuki" ? "Yuki" : id,
    profil: "complet",
    actif,
    ordre,
    creeLe: "2026-01-01T00:00:00.000Z",
    plateformes: {},
  };
}

function registreDe(bots: BotRecord[]): RegistreBots {
  return { schemaVersion: 1, bots, echanges: {} };
}

function banc(): { stateDir: string; registre: RegistreBots } {
  const racine = mkdtempSync(join(tmpdir(), "yuki-bots-admin-"));
  racines.push(racine);
  const stateDir = join(racine, "state");
  mkdirSync(join(stateDir, "bots"), { recursive: true });
  return { stateDir, registre: registreDe([bot("yuki", 0, true)]) };
}

/** Dossier d'un bot dans le banc. */
const dossier = (stateDir: string, id: string) => join(stateDir, "bots", id);

/** Dépose un fichier (et ses dossiers) dans un dossier de bot. */
function deposer(stateDir: string, id: string, relatif: string, contenu = "x"): void {
  const chemin = join(dossier(stateDir, id), relatif);
  mkdirSync(join(chemin, ".."), { recursive: true });
  writeFileSync(chemin, contenu);
}

/**
 * Bot source COMPLET : tout ce qui peut (ou ne doit pas) être cloné.
 */
function botSourceComplet(stateDir: string, id = "yuki"): void {
  deposer(stateDir, id, "personality.md", "# Yuki\n");
  deposer(stateDir, id, "rules.md", "- règle\n");
  deposer(stateDir, id, "avatar/avatar.png", "png");
  deposer(stateDir, id, "config.overlay.json", '{ "tts.voice": "flocon" }\n');
  deposer(stateDir, id, "memory.jsonl", '{"texte":"souvenir"}\n{"texte":"autre"}\n');
  deposer(stateDir, id, "memory-archive/consolidation/2026-01-01_0300.json", "{}");
  deposer(stateDir, id, "memory-heritage/heritage.json", "{}");
  deposer(stateDir, id, "memory-consolidation.json", "{}");
  deposer(stateDir, id, "memory-index.sqlite", "sqlite");
  deposer(stateDir, id, "sources.json", '{ "schemaVersion": 2, "sources": [{}, {}] }\n');
  deposer(stateDir, id, "sources-inbox.json", "{}");
  deposer(stateDir, id, "declencheurs-journal.jsonl", '{"type":"tir"}\n');
  // ⚠️ Ce qui ne doit JAMAIS être copié.
  deposer(stateDir, id, "chat-mirror.json", "{}");
  deposer(stateDir, id, "chat-mirror/canal/conversation.json", "{}");
  deposer(stateDir, id, "conversations-archive/conv-1.json", "{}");
  deposer(stateDir, id, "conversations-archive-index.sqlite", "sqlite");
  deposer(stateDir, id, "jobs.jsonl", '{"id":"j1"}\n');
  deposer(stateDir, id, "preautorisations.json", "{}");
  deposer(stateDir, id, "envois-programmes.json", "{}");
  deposer(stateDir, id, "session-pins.json", "{}");
}

describe("① création — dossier, registre, overlay", () => {
  it("crée `<state>/bots/<slug>/`, l'entrée du registre et un overlay vide", () => {
    const { stateDir, registre } = banc();
    const resultat = creerBot({
      stateDir,
      registre,
      nom: "  Kohai  ",
      slug: "kohai",
      profil: "lecture",
      maintenant: Date.parse("2026-11-09T10:00:00.000Z"),
    });
    // Dossier.
    expect(existsSync(dossier(stateDir, "kohai"))).toBe(true);
    // Overlay VIDE mais EXPLICITE (fichier plat, aucune surcharge).
    const overlay = JSON.parse(
      readFileSync(join(dossier(stateDir, "kohai"), "config.overlay.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(overlay).toEqual({});
    // Entrée du registre : nom nettoyé, profil choisi, ordre suivant, NON actif.
    expect(resultat.bot).toEqual({
      id: "kohai",
      nom: "Kohai",
      profil: "lecture",
      actif: false,
      ordre: 1,
      creeLe: "2026-11-09T10:00:00.000Z",
      plateformes: {},
    });
    // Le registre rendu est celui qui a été ÉCRIT (pas une copie en mémoire).
    expect(resultat.registre.bots.map((entree) => entree.id)).toEqual(["yuki", "kohai"]);
    const ecrit = JSON.parse(
      readFileSync(join(stateDir, "bots.json"), "utf8"),
    ) as RegistreBots;
    expect(ecrit.bots.map((entree) => entree.id)).toEqual(["yuki", "kohai"]);
    expect(resultat.copies).toEqual([]);
  });

  it("refuse un SLUG invalide (motif strict, dossier jamais créé)", () => {
    const { stateDir, registre } = banc();
    for (const slug of ["Kohai", "k", "-kohai", "kohai_2", "a".repeat(32)]) {
      expect(() => creerBot({ stateDir, registre, nom: "K", slug }), slug).toThrowError(
        AdminBotError,
      );
      expect(existsSync(dossier(stateDir, slug))).toBe(false);
    }
  });

  it("refuse un slug DÉJÀ PRIS (registre ou dossier existant)", () => {
    const { stateDir, registre } = banc();
    expect(() => creerBot({ stateDir, registre, nom: "Yuki bis", slug: "yuki" })).toThrowError(
      /déjà utilisé/,
    );
    mkdirSync(dossier(stateDir, "orphelin"), { recursive: true });
    expect(() => creerBot({ stateDir, registre, nom: "Orphelin", slug: "orphelin" })).toThrowError(
      /dossier existe déjà/,
    );
  });

  it("refuse un NOM hors bornes et un PROFIL inconnu", () => {
    const { stateDir, registre } = banc();
    expect(() => creerBot({ stateDir, registre, nom: "   ", slug: "vide" })).toThrowError(
      /obligatoire/,
    );
    expect(() =>
      creerBot({ stateDir, registre, nom: "n".repeat(41), slug: "long" }),
    ).toThrowError(/trop long/);
    expect(() =>
      creerBot({ stateDir, registre, nom: "K", slug: "kohai", profil: "inconnu" }),
    ).toThrowError(/Profil inconnu/);
  });

  it(`refuse le ${MAX_BOTS + 1}ᵉ bot (409 max_bots, en nommant la limite)`, () => {
    const bots = Array.from({ length: MAX_BOTS }, (_, index) => bot(`bot${index}`, index));
    const { stateDir } = banc();
    const registre = registreDe(bots);
    let erreur: unknown;
    try {
      creerBot({ stateDir, registre, nom: "Trop", slug: "trop" });
    } catch (error) {
      erreur = error;
    }
    expect(erreur).toBeInstanceOf(AdminBotError);
    const refus = erreur as AdminBotError;
    expect(refus.code).toBe("max_bots");
    expect(refus.status).toBe(409);
    expect(refus.message).toContain(String(MAX_BOTS));
    expect(existsSync(dossier(stateDir, "trop"))).toBe(false);
  });
});

describe("② clone — les BONNES cases, les bons fichiers", () => {
  it("copie l'IDENTITÉ et les CAPACITÉS par défaut, PAS la mémoire ni les déclencheurs", () => {
    const { stateDir, registre } = banc();
    botSourceComplet(stateDir);
    const resultat = creerBot({ stateDir, registre, nom: "Clone", slug: "clone", cloneDe: "yuki" });
    expect(resultat.copies.sort()).toEqual(["capacites", "identite"]);

    const clone = dossier(stateDir, "clone");
    // Identité + capacités : copiées.
    expect(readFileSync(join(clone, "personality.md"), "utf8")).toBe("# Yuki\n");
    expect(readFileSync(join(clone, "rules.md"), "utf8")).toBe("- règle\n");
    expect(readFileSync(join(clone, "avatar/avatar.png"), "utf8")).toBe("png");
    expect(JSON.parse(readFileSync(join(clone, "config.overlay.json"), "utf8"))).toEqual({
      "tts.voice": "flocon",
    });
    // Mémoire + déclencheurs : DÉCOCHÉS par défaut.
    for (const relatif of [
      "memory.jsonl",
      "memory-archive",
      "memory-heritage",
      "memory-consolidation.json",
      "sources.json",
      "sources-inbox.json",
      "declencheurs-journal.jsonl",
    ]) {
      expect(existsSync(join(clone, relatif)), relatif).toBe(false);
    }
  });

  it("cases TOUT cochées ⇒ mémoire et déclencheurs copiés ; JAMAIS le reste", () => {
    const { stateDir, registre } = banc();
    botSourceComplet(stateDir);
    const elements = Object.fromEntries(ELEMENTS_CLONE.map((element) => [element.id, true]));
    const resultat = creerBot({
      stateDir,
      registre,
      nom: "Clone",
      slug: "clone",
      cloneDe: "yuki",
      elements,
    });
    expect(resultat.copies.sort()).toEqual(["capacites", "declencheurs", "identite", "memoire"]);
    const clone = dossier(stateDir, "clone");
    expect(readFileSync(join(clone, "memory.jsonl"), "utf8")).toContain("souvenir");
    expect(existsSync(join(clone, "memory-archive/consolidation/2026-01-01_0300.json"))).toBe(true);
    expect(existsSync(join(clone, "sources.json"))).toBe(true);
    expect(existsSync(join(clone, "declencheurs-journal.jsonl"))).toBe(true);

    // ⚠️ GARDE : rien de ce qui n'appartient qu'à un bot n'a été copié.
    for (const interdit of JAMAIS_COPIES) {
      expect(existsSync(join(clone, interdit)), interdit).toBe(false);
    }
  });

  it("cases DÉCOCHÉES ⇒ rien n'est copié (l'overlay vide est seul écrit)", () => {
    const { stateDir, registre } = banc();
    botSourceComplet(stateDir);
    const elements = Object.fromEntries(ELEMENTS_CLONE.map((element) => [element.id, false]));
    const resultat = creerBot({
      stateDir,
      registre,
      nom: "Vierge",
      slug: "vierge",
      cloneDe: "yuki",
      elements,
    });
    expect(resultat.copies).toEqual([]);
    expect(readdirSync(dossier(stateDir, "vierge"))).toEqual(["config.overlay.json"]);
  });

  it("« agents » ne copie RIEN (le champ des listes d'agents n'existe pas encore)", () => {
    const { stateDir, registre } = banc();
    botSourceComplet(stateDir);
    const resultat = creerBot({
      stateDir,
      registre,
      nom: "Clone",
      slug: "clone",
      cloneDe: "yuki",
      elements: { identite: false, capacites: false, memoire: false, declencheurs: false, agents: true },
    });
    expect(resultat.copies).toEqual([]);
  });

  it("refuse un élément de clone INCONNU et un bot source inexistant", () => {
    const { stateDir, registre } = banc();
    botSourceComplet(stateDir);
    expect(() =>
      creerBot({
        stateDir,
        registre,
        nom: "Clone",
        slug: "clone",
        cloneDe: "yuki",
        elements: { tout: true },
      }),
    ).toThrowError(/Élément de clone inconnu/);
    expect(() =>
      creerBot({ stateDir, registre, nom: "Clone", slug: "clone", cloneDe: "fantome" }),
    ).toThrowError(/n'existe pas/);
  });

  it("aucun chemin d'élément ne viole JAMAIS_COPIES (garde de la table)", () => {
    for (const element of ELEMENTS_CLONE) {
      for (const relatif of element.chemins) {
        expect(estJamaisCopie(relatif), `${element.id}:${relatif}`).toBe(false);
      }
    }
    for (const interdit of JAMAIS_COPIES) {
      expect(estJamaisCopie(interdit), interdit).toBe(true);
      expect(estJamaisCopie(`${interdit}/sous-fichier`), interdit).toBe(true);
    }
    // Un élément qui oserait un chemin interdit est REFUSÉ, pas ignoré.
    expect(() =>
      elementsDemandes({ capacites: true }, true),
    ).not.toThrow();
  });
});

describe("③ suppression — ARCHIVAGE, jamais d'effacement", () => {
  it("déplace le dossier dans bots-supprimes/<slug>-<date>/ et garde les fichiers INTACTS", () => {
    const { stateDir } = banc();
    botSourceComplet(stateDir);
    botSourceComplet(stateDir, "kohai");
    const registre = registreDe([bot("yuki", 0, true), bot("kohai", 1)]);
    const maintenant = Date.parse("2026-11-09T22:29:00.000Z");
    const resultat = supprimerBot({ stateDir, registre, botId: "kohai", maintenant });

    expect(resultat.archive).toBe(
      join(stateDir, SOUS_DOSSIER_SUPPRIMES, "kohai-20261109-2229"),
    );
    // Dossier d'origine : parti. Archive : présente, fichiers identiques.
    expect(existsSync(dossier(stateDir, "kohai"))).toBe(false);
    expect(readFileSync(join(resultat.archive as string, "memory.jsonl"), "utf8")).toContain(
      "souvenir",
    );
    // Registre : le bot n'y est plus, `yuki` reste actif.
    expect(resultat.registre.bots.map((entree) => entree.id)).toEqual(["yuki"]);
    expect(resultat.botActifSuivant).toBe(null);
    expect(resultat.rechargementRequis).toBe(false);
    const ecrit = JSON.parse(readFileSync(join(stateDir, "bots.json"), "utf8")) as RegistreBots;
    expect(ecrit.bots.map((entree) => entree.id)).toEqual(["yuki"]);
  });

  it("refuse le DERNIER bot (`dernier_bot`, 409) et ne touche à rien", () => {
    const { stateDir, registre } = banc();
    botSourceComplet(stateDir);
    expect(() => supprimerBot({ stateDir, registre, botId: "yuki" })).toThrowError(
      /DERNIER bot/,
    );
    expect(existsSync(dossier(stateDir, "yuki"))).toBe(true);
  });

  it("bot ACTIF supprimé ⇒ le premier bot restant devient actif (redémarrage requis)", () => {
    const { stateDir } = banc();
    botSourceComplet(stateDir);
    const registre = registreDe([bot("yuki", 0, true), bot("kohai", 1), bot("nova", 2)]);
    const resultat = supprimerBot({
      stateDir,
      registre,
      botId: "yuki",
      maintenant: Date.parse("2026-11-09T22:29:00.000Z"),
    });
    expect(resultat.botActifSuivant).toBe("kohai");
    expect(resultat.rechargementRequis).toBe(true);
    expect(resultat.registre.bots.map((entree) => [entree.id, entree.actif])).toEqual([
      ["kohai", true],
      ["nova", false],
    ]);
  });

  it("deux suppressions dans la même minute ⇒ deux archives distinctes", () => {
    const { stateDir } = banc();
    botSourceComplet(stateDir);
    botSourceComplet(stateDir, "a1");
    botSourceComplet(stateDir, "b2");
    supprimerBot({
      stateDir,
      registre: registreDe([bot("yuki", 0, true), bot("a1", 1)]),
      botId: "a1",
      maintenant: 1_800_000_000_000,
    });
    // Le même bot re-déclaré (dossier recréé) supprimé dans la MÊME minute.
    botSourceComplet(stateDir, "a1");
    const registre = registreDe([bot("b2", 0), bot("a1", 1)]);
    const second = supprimerBot({ stateDir, registre, botId: "a1", maintenant: 1_800_000_000_000 });
    expect(second.archive).toContain("a1-20270115-0800-2");
  });

  it("le point d'extension « agents autorisés » est APPELÉ (sans inventer de champ)", () => {
    const { stateDir, registre } = banc();
    botSourceComplet(stateDir);
    const vus: string[] = [];
    supprimerBot({
      stateDir,
      registre: registreDe([...registre.bots, bot("kohai", 1)]),
      botId: "kohai",
      retirerDesListesDAgents: (botId) => vus.push(botId),
    });
    expect(vus).toEqual(["kohai"]);
  });
});

describe("④ rétention — 90 jours", () => {
  it("purge une archive de plus de 90 jours et CONSERVE celle de 89 jours", () => {
    const { stateDir } = banc();
    const archives = join(stateDir, SOUS_DOSSIER_SUPPRIMES);
    mkdirSync(join(archives, "vieux-20260101-0300"), { recursive: true });
    writeFileSync(join(archives, "vieux-20260101-0300", "memory.jsonl"), "x");
    mkdirSync(join(archives, "recent-20260104-0300"), { recursive: true });
    // Un nom NON datable n'est jamais supprimé (on ne devine pas un âge).
    mkdirSync(join(archives, "sans-date"), { recursive: true });

    // 91 jours après le 1er janvier, 88 après le 4 : seul le premier est purgé.
    const maintenant = Date.parse("2026-04-02T03:00:00.000Z");
    const journaux: Array<{ message: string; champs?: Record<string, unknown> }> = [];
    const resultat = purgerArchivesBots({
      stateDir,
      maintenant,
      logger: { info: (message, champs) => journaux.push({ message, champs }) },
    });
    expect(resultat.purges).toEqual(["vieux-20260101-0300"]);
    expect(existsSync(join(archives, "vieux-20260101-0300"))).toBe(false);
    expect(existsSync(join(archives, "sans-date"))).toBe(true);
    // 90 jours + 1 min après le 1er janvier : l'archive de 89 jours survit.
    expect(resultat.conservees).toContain("recent-20260104-0300");
    expect(existsSync(join(archives, "recent-20260104-0300"))).toBe(true);
    // Purge JOURNALISÉE (`bot.archive.purged`).
    expect(journaux[0]?.message).toBe("bot.archive.purged");
    expect(journaux[0]?.champs?.archive).toBe("vieux-20260101-0300");
  });

  it("89 jours survit, 91 jours est purgé (bornes explicites)", () => {
    const { stateDir } = banc();
    const archives = join(stateDir, SOUS_DOSSIER_SUPPRIMES);
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    mkdirSync(join(archives, `a-${horodatageArchive(base)}`), { recursive: true });
    mkdirSync(join(archives, `b-${horodatageArchive(base)}`), { recursive: true });

    const a89 = base + 89 * MS_PAR_JOUR;
    const r89 = purgerArchivesBots({ stateDir, maintenant: a89 });
    expect(r89.purges).toEqual([]);
    expect(r89.conservees.length).toBe(2);

    const a91 = base + 91 * MS_PAR_JOUR;
    const r91 = purgerArchivesBots({ stateDir, maintenant: a91 });
    expect(r91.purges.length).toBe(2);
  });

  it("absent ou vide ⇒ aucune erreur (rétention sans archive)", () => {
    const { stateDir } = banc();
    expect(purgerArchivesBots({ stateDir, maintenant: Date.now() })).toEqual({
      purges: [],
      conservees: [],
    });
  });

  it("`dateArchive` relit l'horodatage des dossiers d'archive", () => {
    expect(dateArchive("kohai-20261109-2229")).toBe(
      Date.parse("2026-11-09T22:29:00.000Z"),
    );
    expect(dateArchive("kohai-20261109-2229-2")).toBe(
      Date.parse("2026-11-09T22:29:00.000Z"),
    );
    expect(dateArchive("kohai")).toBe(null);
  });
});

describe("⑤ compteurs de la confirmation de suppression", () => {
  it("compte les conversations, les souvenirs, les déclencheurs et la taille", () => {
    const { stateDir } = banc();
    botSourceComplet(stateDir);
    const compteurs = compterDonneesBot(stateDir, "yuki");
    expect(compteurs.conversations).toBe(1);
    expect(compteurs.souvenirs).toBe(2);
    expect(compteurs.declencheurs).toBe(2);
    expect(compteurs.octets).toBeGreaterThan(0);
  });

  it("bot sans données ⇒ zéros (jamais une erreur)", () => {
    const { stateDir } = banc();
    expect(compterDonneesBot(stateDir, "inconnu")).toEqual({
      conversations: 0,
      souvenirs: 0,
      declencheurs: 0,
      octets: 0,
    });
  });
});

describe("⑥ horodatage d'archive", () => {
  it("écrit AAAAMMJJ-HHMM en UTC", () => {
    expect(horodatageArchive(Date.parse("2026-11-09T22:29:00.000Z"))).toBe("20261109-2229");
    expect(horodatageArchive(Date.parse("2026-01-02T03:04:00.000Z"))).toBe("20260102-0304");
  });

  it("un dossier ancien modifié à la main garde son âge (mtime inutilisé)", () => {
    const { stateDir } = banc();
    const archives = join(stateDir, SOUS_DOSSIER_SUPPRIMES);
    const nom = "vieux-20260101-0300";
    mkdirSync(join(archives, nom), { recursive: true });
    // Le mtime est RÉCENT, le NOM est ancien : c'est le nom qui décide.
    utimesSync(join(archives, nom), new Date(), new Date());
    const resultat = purgerArchivesBots({
      stateDir,
      maintenant: Date.parse("2026-06-01T00:00:00.000Z"),
    });
    expect(resultat.purges).toEqual([nom]);
  });
});
