/**
 * ADMINISTRATION DES BOTS (lot 35e) : CRÉATION, CLONE, SUPPRESSION, RÉTENTION.
 *
 * Ce que ce fichier verrouille :
 *  - `creerBot` crée le DOSSIER, l'entrée du registre et l'overlay ; DÉRIVE le
 *    slug du nom (dédupliqué), part avec des CAPACITÉS VIDES, refuse un nom hors
 *    bornes et un 7ᵉ bot (`max_bots`) ;
 *  - ⚠️ LOT 35h : `validerCapacitesBot` REFUSE une capacité inconnue et
 *    `modifierBot` change le nom et/ou les capacités d'un bot existant ;
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
  modifierBot,
  purgerArchivesBots,
  slugLibrePour,
  supprimerBot,
  validerCapacitesBot,
} from "../../src/bots/admin.js";
import type { BotRecord, RegistreBots } from "../../src/bots/registry.js";
import { CAPACITES_BOT, SLUG_BOT_PATTERN } from "../../src/bots/registry.js";

const racines: string[] = [];

afterEach(() => {
  for (const racine of racines.splice(0)) rmSync(racine, { recursive: true, force: true });
});

function bot(id: string, ordre: number, actif = false): BotRecord {
  return {
    id,
    nom: id === "yuki" ? "Yuki" : id,
    // ⚠️ Un bot du registre a TOUJOURS une liste de capacités (le registre
    // normalise : champ absent ⇒ toutes). Les tests de suppression ne portent pas
    // sur les capacités : on donne la liste complète, état d'un bot hérité.
    capacites: [...CAPACITES_BOT],
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
      maintenant: Date.parse("2026-11-09T10:00:00.000Z"),
    });
    // Dossier.
    expect(existsSync(dossier(stateDir, "kohai"))).toBe(true);
    // Overlay VIDE mais EXPLICITE (fichier plat, aucune surcharge).
    const overlay = JSON.parse(
      readFileSync(join(dossier(stateDir, "kohai"), "config.overlay.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(overlay).toEqual({});
    // Entrée du registre : slug DÉRIVÉ du nom, capacités VIDES, ordre suivant,
    // NON actif. ⚠️ « de base un bot ajouté ne peut rien faire ».
    expect(resultat.bot).toEqual({
      id: "kohai",
      nom: "Kohai",
      capacites: [],
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

  it("DÉRIVE le slug du nom (accents, espaces, casse) et le rend valide", () => {
    const { stateDir, registre } = banc();
    const cas: ReadonlyArray<readonly [string, string]> = [
      ["Kohai 2", "kohai-2"],
      ["  Élodie  ", "elodie"],
      ["A", "a-bot"],
      ["!!!", "bot"],
      // ⚠️ Tronqué à 27 caractères : la place du suffixe de déduplication (`-12`) est
      // réservée, et le slug doit rester ≤ 31 caractères.
      ["Une longue phrase pour un nom de bot", "une-longue-phrase-pour-un-n"],
    ];
    let courant = registre;
    for (const [nom, slug] of cas) {
      const resultat = creerBot({ stateDir, registre: courant, nom });
      courant = resultat.registre;
      expect(resultat.bot.id, nom).toBe(slug);
      // Le slug DÉRIVÉ respecte le motif (2..31, minuscules/chiffres/`-`).
      expect(resultat.bot.id).toMatch(SLUG_BOT_PATTERN);
      expect(existsSync(dossier(stateDir, slug)), slug).toBe(true);
    }
  });

  it("le nom est OBLIGATOIRE et le dossier n'est jamais créé sur un refus", () => {
    const { stateDir, registre } = banc();
    for (const nom of ["", "   "]) {
      expect(() => creerBot({ stateDir, registre, nom })).toThrowError(AdminBotError);
    }
    expect(readdirSync(join(stateDir, "bots"))).toEqual([]);
  });

  it("DÉDUPLIQUE le slug : deux bots peuvent porter le même nom", () => {
    const { stateDir, registre } = banc();
    // « Yuki » est déjà pris par le bot historique ⇒ `yuki-2`.
    const premier = creerBot({ stateDir, registre, nom: "Yuki" });
    expect(premier.bot.id).toBe("yuki-2");
    expect(premier.bot.nom).toBe("Yuki");
    const second = creerBot({ stateDir, registre: premier.registre, nom: "Yuki" });
    expect(second.bot.id).toBe("yuki-3");
    // Un DOSSIER orphelin (création interrompue) décale aussi le slug.
    mkdirSync(dossier(stateDir, "nova"), { recursive: true });
    const troisieme = creerBot({ stateDir, registre: second.registre, nom: "Nova" });
    expect(troisieme.bot.id).toBe("nova-2");
    expect(existsSync(dossier(stateDir, "nova-2"))).toBe(true);
  });

  it("refuse un NOM hors bornes", () => {
    const { stateDir, registre } = banc();
    expect(() => creerBot({ stateDir, registre, nom: "   " })).toThrowError(/obligatoire/);
    expect(() => creerBot({ stateDir, registre, nom: "n".repeat(41) })).toThrowError(/trop long/);
    // ⚠️ Plus de PROFIL à la création (lot 35h) : une clé `profil` dans le corps
    // est simplement ignorée par `creerBot` (elle n'existe plus dans les options).
    const resultat = creerBot({
      stateDir,
      registre,
      nom: "Hérité",
      ...({ profil: "lecture" } as Record<string, unknown>),
    });
    expect(resultat.bot.id).toBe("herite");
    expect(resultat.bot).not.toHaveProperty("profil");
    expect(resultat.bot.capacites).toEqual([]);
  });

  it(`refuse le ${MAX_BOTS + 1}ᵉ bot (409 max_bots, en nommant la limite)`, () => {
    const bots = Array.from({ length: MAX_BOTS }, (_, index) => bot(`bot${index}`, index));
    const { stateDir } = banc();
    const registre = registreDe(bots);
    let erreur: unknown;
    try {
      creerBot({ stateDir, registre, nom: "Trop" });
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

describe("①bis capacités (lot 35h) — validation et modification", () => {
  it("`validerCapacitesBot` : `[]` par défaut, ordre canonique, doublons retirés", () => {
    expect(validerCapacitesBot(undefined)).toEqual([]);
    expect(validerCapacitesBot(null)).toEqual([]);
    expect(validerCapacitesBot([])).toEqual([]);
    expect(validerCapacitesBot(["envoi", "agents"])).toEqual(["envoi", "agents"]);
    // L'ordre du REGISTRE gagne (stable d'une écriture à l'autre).
    expect(validerCapacitesBot(["builtins", "envoi"])).toEqual(["envoi", "builtins"]);
    expect(validerCapacitesBot(["envoi", "envoi"])).toEqual(["envoi"]);
    expect(validerCapacitesBot([...CAPACITES_BOT])).toEqual([...CAPACITES_BOT]);
  });

  it("`validerCapacitesBot` REFUSE une capacité inconnue (jamais ignorée en silence)", () => {
    for (const inconnue of ["tout", "administrateur", "", 42, null]) {
      let erreur: unknown;
      try {
        validerCapacitesBot([inconnue]);
      } catch (error) {
        erreur = error;
      }
      expect(erreur, JSON.stringify(inconnue)).toBeInstanceOf(AdminBotError);
      expect((erreur as AdminBotError).code).toBe("capacite_inconnue");
      expect((erreur as AdminBotError).status).toBe(400);
    }
    // Un NON-tableau est refusé aussi (aucune interprétation devinée).
    expect(() => validerCapacitesBot("envoi")).toThrowError(/liste/);
  });

  it("`slugLibrePour` rend un slug libre, dédupliqué et borné", () => {
    const { stateDir, registre } = banc();
    expect(slugLibrePour(stateDir, registre, "Nova")).toBe("nova");
    // Déjà pris par le registre (`yuki`) ⇒ suffixe.
    expect(slugLibrePour(stateDir, registre, "Yuki")).toBe("yuki-2");
    // Le slug reste lisible et ≤ 31 caractères, même après suffixe.
    const long = slugLibrePour(stateDir, registre, "n".repeat(40));
    expect(long.length).toBeLessThanOrEqual(31);
    expect(long).toMatch(SLUG_BOT_PATTERN);
  });

  it("`modifierBot` change le NOM et/ou les CAPACITÉS, et écrit le registre", () => {
    const { stateDir, registre } = banc();
    const creation = creerBot({ stateDir, registre, nom: "Nova" });
    expect(creation.bot.capacites).toEqual([]);

    // Capacités seules.
    const un = modifierBot({
      stateDir,
      registre: creation.registre,
      botId: "nova",
      capacites: ["agents", "execution"],
    });
    expect(un.bot.capacites).toEqual(["agents", "execution"]);
    expect(un.bot.nom).toBe("Nova");
    // Le fichier écrit porte bien les capacités (source = disque).
    const ecrit = JSON.parse(readFileSync(join(stateDir, "bots.json"), "utf8")) as RegistreBots;
    expect(ecrit.bots.find((bot) => bot.id === "nova")?.capacites).toEqual([
      "agents",
      "execution",
    ]);
    expect(ecrit.bots.find((bot) => bot.id === "nova")).not.toHaveProperty("profil");

    // Nom seul : les capacités restent.
    const deux = modifierBot({ stateDir, registre: un.registre, botId: "nova", nom: " Nova 2 " });
    expect(deux.bot.nom).toBe("Nova 2");
    expect(deux.bot.capacites).toEqual(["agents", "execution"]);
    // ⚠️ Le SLUG ne bouge JAMAIS (il nomme un dossier).
    expect(deux.bot.id).toBe("nova");

    // Tout retirer est un acte EXPLICITE (`[]`), pas un oubli.
    const trois = modifierBot({ stateDir, registre: deux.registre, botId: "nova", capacites: [] });
    expect(trois.bot.capacites).toEqual([]);
  });

  it("`modifierBot` refuse un nom invalide, une capacité inconnue et un bot inconnu", () => {
    const { stateDir, registre } = banc();
    const creation = creerBot({ stateDir, registre, nom: "Nova" });
    expect(() =>
      modifierBot({ stateDir, registre: creation.registre, botId: "nova", nom: "  " }),
    ).toThrowError(/obligatoire/);
    expect(() =>
      modifierBot({
        stateDir,
        registre: creation.registre,
        botId: "nova",
        capacites: ["tout"],
      }),
    ).toThrowError(/Capacité inconnue/);
    let erreur: unknown;
    try {
      modifierBot({ stateDir, registre: creation.registre, botId: "fantome", nom: "X" });
    } catch (error) {
      erreur = error;
    }
    expect((erreur as AdminBotError).code).toBe("bot_inconnu");
    expect((erreur as AdminBotError).status).toBe(404);
    // Un refus n'écrit RIEN : le registre du disque est inchangé.
    const ecrit = JSON.parse(readFileSync(join(stateDir, "bots.json"), "utf8")) as RegistreBots;
    expect(ecrit).toEqual(creation.registre);
  });
});

describe("② clone — les BONNES cases, les bons fichiers", () => {
  it("copie l'IDENTITÉ et les CAPACITÉS par défaut, PAS la mémoire ni les déclencheurs", () => {
    const { stateDir, registre } = banc();
    botSourceComplet(stateDir);
    const resultat = creerBot({ stateDir, registre, nom: "Clone", cloneDe: "yuki" });
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

  it("un CLONE reprend les CAPACITÉS de son modèle si la case est cochée", () => {
    const { stateDir, registre } = banc();
    botSourceComplet(stateDir);
    // Le modèle hérité a TOUTES les capacités (registre du banc : `yuki`).
    const source = registre.bots.find((entree) => entree.id === "yuki");
    expect(source?.capacites).toEqual([...CAPACITES_BOT]);
    const avec = creerBot({ stateDir, registre, nom: "Clone", cloneDe: "yuki" });
    expect(avec.bot.capacites).toEqual([...CAPACITES_BOT]);

    // Case « Capacités et réglages » DÉCOCHÉE ⇒ le clone est un bot neuf.
    const sans = creerBot({
      stateDir,
      registre,
      nom: "Sans capacités",
      cloneDe: "yuki",
      elements: { capacites: false },
    });
    expect(sans.bot.capacites).toEqual([]);
  });

  it("cases DÉCOCHÉES ⇒ rien n'est copié (l'overlay vide est seul écrit)", () => {
    const { stateDir, registre } = banc();
    botSourceComplet(stateDir);
    const elements = Object.fromEntries(ELEMENTS_CLONE.map((element) => [element.id, false]));
    const resultat = creerBot({
      stateDir,
      registre,
      nom: "Vierge",
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
        cloneDe: "yuki",
        elements: { tout: true },
      }),
    ).toThrowError(/Élément de clone inconnu/);
    expect(() =>
      creerBot({ stateDir, registre, nom: "Clone", cloneDe: "fantome" }),
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
      // ⚠️ LOT 35i : la purge couvre AUSSI les sessions Pi restées en place.
      sessionsPurgees: [],
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
