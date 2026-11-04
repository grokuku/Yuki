/**
 * LOT 26 / 3 — LA PAGE DE GESTION DES DÉCLENCHEURS.
 *
 * ⚠️ Ces tests portent sur les RÈGLES (`public/ui/declencheurs-vue.js`), pas sur
 * le rendu : ils ÉCHOUENT sur le code d'origine, où ni le module ni l'onglet
 * n'existent (`git show HEAD:public/ui/sources-panel.js` ne connaît que
 * « webhook », un tableau sans section et aucune colonne « dernier passage »).
 *
 * Ce qui est verrouillé ici :
 *  - les TROIS sections et leur classement (webhook → permanents, planning
 *    ponctuel → temporaires, `actif:false` → sommeil) ;
 *  - ⚠️ la colonne « DERNIER PASSAGE » — sans elle, une source muette depuis
 *    3 jours est indistinguable d'une source qui travaille (« jamais » sinon) ;
 *  - le PROCHAIN passage, cohérent avec l'expression cron (calcul serveur) ;
 *  - la colonne des pré-autorisations (présente, et « aucune » au lot 3) ;
 *  - le journal : consultable, BORNÉ, filtrable par type (et par source), avec
 *    le type « préautorisation » DÉJÀ prévu pour le lot 4 ;
 *  - ⚠️ un temporaire ÉTEINT reste visible 7 jours, puis rejoint « sommeil »
 *    (jamais de disparition silencieuse) ;
 *  - le lien de la pastille et l'ancre `#declencheurs` sont cohérents.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { apercuCron } from "../../src/sources/cron.js";
import {
  ANCRE_JOURNAL,
  EVENEMENTS_JOURNAL,
  JOURNAL_LIMITE,
  JOURNAL_LIMITE_MAX,
  JOURS_VISIBILITE_TEMPORAIRE,
  SECTIONS_DECLENCHEURS,
  classerSource,
  dateHeureFr,
  eteintRecemment,
  filtrerJournal,
  grouperParSection,
  jamaisPasse,
  libelleEvenement,
  lienJournal,
  texteDernierPassage,
  texteDernierResultat,
  texteEtat,
  texteJetons,
  texteJournalBorne,
  textePreAutorisations,
  texteProchainPassage,
  texteQuand,
  texteTours,
} from "../../public/ui/declencheurs-vue.js";

const UI = join(process.cwd(), "public", "ui");
const lire = (nom: string): string => readFileSync(join(UI, nom), "utf8");

const PANNEAU = lire("sources-panel.js");
const CONFIG_HTML = lire("config.html");
const CONFIG_JS = lire("config.js");
const CONFIG_CSS = lire("config.css");
const INDEX = lire("index.html");

/** Source de test : un `webhook` (permanent), complet par défaut. */
function webhook(extra: Record<string, unknown> = {}) {
  return {
    nom: "veille",
    declencheur: { type: "webhook" },
    visibilite: "silencieux",
    actif: true,
    dernierAppel: "2026-03-04T08:30:00.000Z",
    ...extra,
  };
}

/** Source de test : un `planning` (expression et état paramétrables). */
function planning(extra: Record<string, unknown> = {}) {
  return {
    nom: "matin",
    declencheur: { type: "planning", expression: "0 9 * * 1-5", fuseau: "Europe/Paris" },
    visibilite: "silencieux",
    actif: true,
    ...extra,
  };
}

const MAINTENANT = Date.parse("2026-03-10T12:00:00.000Z");
const JOUR = 86_400_000;

describe("déclencheurs — les TROIS sections", () => {
  it("expose exactement permanents / temporaires / sommeil", () => {
    expect(SECTIONS_DECLENCHEURS.map((section) => section.id)).toEqual([
      "permanents",
      "temporaires",
      "sommeil",
    ]);
    for (const section of SECTIONS_DECLENCHEURS) {
      expect(section.titre.length).toBeGreaterThan(0);
      expect(section.aide.length).toBeGreaterThan(0);
    }
  });

  it("classe un webhook en PERMANENTS et un planning sans fin en PERMANENTS", () => {
    expect(classerSource(webhook(), { maintenant: MAINTENANT })).toBe("permanents");
    // « 0 9 * * 1-5 » revient indéfiniment : ce n'est pas un temporaire.
    expect(classerSource(planning(), { maintenant: MAINTENANT })).toBe("permanents");
  });

  it("classe un planning PONCTUEL en TEMPORAIRES", () => {
    const ponctuel = planning({
      nom: "impots",
      declencheur: { type: "planning", expression: "0 9 3 5 *", fuseau: "Europe/Paris" },
    });
    expect(classerSource(ponctuel, { maintenant: MAINTENANT })).toBe("temporaires");
  });

  it("classe un actif:false en SOMMEIL (avec sa raison)", () => {
    const eteint = webhook({
      actif: false,
      raisonInactive: "DÉSACTIVER demandé par le modèle",
      desactiveLe: new Date(MAINTENANT - 30 * JOUR).toISOString(),
    });
    expect(classerSource(eteint, { maintenant: MAINTENANT })).toBe("sommeil");
    expect(texteEtat(eteint)).toContain("DÉSACTIVER demandé par le modèle");
    expect(texteEtat(eteint)).toContain("en sommeil");
  });

  it("classe un garde-fou quotidien ATTEINT en TEMPORAIRES", () => {
    const epuise = planning({ maxToursParJour: 3, toursDuJour: { jour: "2026-03-10", compte: 3 } });
    expect(classerSource(epuise, { maintenant: MAINTENANT })).toBe("temporaires");
    expect(texteEtat(epuise)).toContain("garde-fou quotidien atteint");
  });

  it("rend TOUJOURS les trois sections, même vides (aucune catégorie muette)", () => {
    const groupes = grouperParSection([webhook()], { maintenant: MAINTENANT });
    expect(groupes.map((groupe) => groupe.id)).toEqual(["permanents", "temporaires", "sommeil"]);
    expect(groupes[0].sources.map((source) => source.nom)).toEqual(["veille"]);
    expect(groupes[1].sources).toEqual([]);
    expect(groupes[2].sources).toEqual([]);
  });

  it("répartit un jeu réel dans les trois sections, sans perdre personne", () => {
    const sources = [
      webhook({ nom: "web" }),
      planning({ nom: "cron" }),
      planning({
        nom: "ponctuel",
        declencheur: { type: "planning", expression: "0 9 3 5 *", fuseau: "Europe/Paris" },
      }),
      webhook({
        nom: "eteint",
        actif: false,
        desactiveLe: new Date(MAINTENANT - 60 * JOUR).toISOString(),
      }),
    ];
    const groupes = grouperParSection(sources, { maintenant: MAINTENANT });
    const parId = new Map(groupes.map((groupe) => [groupe.id, groupe.sources.map((s) => s.nom)]));
    expect(parId.get("permanents")).toEqual(["cron", "web"]);
    expect(parId.get("temporaires")).toEqual(["ponctuel"]);
    expect(parId.get("sommeil")).toEqual(["eteint"]);
    // Aucun déclencheur ne disparaît : 4 entrées, 4 lignes.
    expect(groupes.reduce((total, groupe) => total + groupe.sources.length, 0)).toBe(4);
  });
});

describe("déclencheurs — ⚠️ LA colonne « dernier passage »", () => {
  it("affiche la date d'un passage planifié", () => {
    const source = planning({ dernierPassage: "2026-03-09T08:00:00.000Z" });
    const texte = texteDernierPassage(source);
    expect(texte).toContain(dateHeureFr("2026-03-09T08:00:00.000Z"));
    expect(texte).toContain("passage planifié");
    expect(jamaisPasse(source)).toBe(false);
  });

  it("affiche la date du dernier message reçu pour un webhook", () => {
    const texte = texteDernierPassage(webhook());
    expect(texte).toContain(dateHeureFr("2026-03-04T08:30:00.000Z"));
    expect(texte).toContain("message reçu");
  });

  it("dit « jamais » quand aucun passage n'a eu lieu (jamais une case vide)", () => {
    const vierge = planning({ nom: "neuf" });
    expect(texteDernierPassage(vierge)).toBe("jamais");
    expect(jamaisPasse(vierge)).toBe(true);
    // Un webhook jamais appelé non plus.
    expect(texteDernierPassage({ nom: "x", declencheur: { type: "webhook" } })).toBe("jamais");
  });

  it("est une COLONNE du tableau de la page (pas une infobulle)", () => {
    expect(PANNEAU).toContain('text: "Dernier passage"');
    expect(PANNEAU).toContain("texteDernierPassage(source)");
    expect(PANNEAU).toContain("source muette");
  });
});

describe("déclencheurs — prochain passage cohérent avec l'expression", () => {
  it("formate EXACTEMENT l'instant calculé par le moteur cron (même fuseau)", () => {
    const depuis = MAINTENANT;
    const apercu = apercuCron("0 9 * * 1-5", "Europe/Paris", depuis, 1);
    const prochain = apercu.passages[0];
    expect(typeof prochain).toBe("string");
    const source = planning({ prochainPassage: prochain });
    expect(texteProchainPassage(source)).toBe(dateHeureFr(prochain));
    // « Quand » porte l'expression ET le prochain passage (jamais l'un sans l'autre).
    const quand = texteQuand(source);
    expect(quand).toContain("0 9 * * 1-5");
    expect(quand).toContain("Europe/Paris");
    expect(quand).toContain(dateHeureFr(prochain));
  });

  it("dit « non calculé » plutôt que d'inventer un horaire", () => {
    expect(texteProchainPassage(planning())).toBe("non calculé");
    expect(texteProchainPassage(webhook())).toContain("sans objet");
    expect(texteProchainPassage(planning({ actif: false }))).toContain("déclencheur éteint");
  });
});

describe("déclencheurs — colonnes pré-autorisations, tours, jetons", () => {
  it("affiche la colonne des pré-autorisations et dit « aucune » au lot 3", () => {
    expect(textePreAutorisations(webhook({ preAutorisations: [] }))).toBe("aucune");
    expect(textePreAutorisations(webhook())).toBe("aucune");
    // Une liste garnie (lot 4) est rendue telle quelle.
    expect(textePreAutorisations(webhook({ preAutorisations: ["lire_page_web"] }))).toBe(
      "lire_page_web",
    );
    expect(PANNEAU).toContain('text: "Pré-autorisations actives"');
  });

  it("affiche « tours du jour / plafond » avec le plafond TOUJOURS visible", () => {
    expect(texteTours(planning({ toursDuJour: { jour: "2026-03-10", compte: 2 }, maxToursParJour: 5 }))).toBe(
      "2 / 5",
    );
    expect(texteTours(planning())).toBe("0 / —");
    expect(PANNEAU).toContain("Tours aujourd'hui / plafond");
  });

  it("affiche les jetons cumulés, ou « — » quand aucun tour n'a rien rapporté", () => {
    expect(texteJetons(webhook())).toBe("—");
    const avec = webhook({ jetonsCumules: { entree: 1200, sortie: 340 } });
    expect(texteJetons(avec)).toContain("entrée");
    expect(texteJetons(avec)).toContain("sortie");
    expect(PANNEAU).toContain('text: "Jetons cumulés"');
  });

  it("résume le DERNIER RÉSULTAT (événement de journal) avec un lien vers le journal", () => {
    const source = webhook({
      dernierEvenement: {
        ts: "2026-03-04T08:30:00.000Z",
        event: "publie",
        resume: "3 articles retenus",
      },
    });
    const texte = texteDernierResultat(source);
    expect(texte).toContain(libelleEvenement("publie"));
    expect(texte).toContain("3 articles retenus");
    expect(texteDernierResultat(webhook())).toContain("aucun résultat");
    expect(lienJournal("veille")).toEqual({ href: `#${ANCRE_JOURNAL}`, source: "veille" });
  });
});

describe("déclencheurs — le JOURNAL (4ᵉ volet)", () => {
  const evenements = [
    { ts: "2026-03-10T10:00:00.000Z", event: "recu", source: "veille", texte: "contenu reçu" },
    { ts: "2026-03-10T10:01:00.000Z", event: "silence", source: "veille" },
    { ts: "2026-03-10T10:02:00.000Z", event: "echec", source: "mail", raison: "modèle absent" },
    { ts: "2026-03-10T10:03:00.000Z", event: "saut", source: "veille", raison: "chevauchement" },
    { ts: "2026-03-10T10:04:00.000Z", event: "plafond", source: "matin", raison: "10 min" },
    { ts: "2026-03-10T10:05:00.000Z", event: "desactive", source: "matin" },
    {
      ts: "2026-03-10T10:06:00.000Z",
      event: "preautorisation",
      source: "mail",
      preAutorisation: "lire_page_web",
    },
  ];

  it("est CONSULTABLE depuis la page (volet replié + filtres présents)", () => {
    expect(PANNEAU).toContain("id: ANCRE_JOURNAL");
    expect(PANNEAU).toContain('id: "journal-type"');
    expect(PANNEAU).toContain('id: "journal-source"');
    expect(PANNEAU).toContain("/api/sources/journal?");
    // Replié par défaut : le volet est un `<details>` sans `open`.
    expect(PANNEAU).toContain('h("details"');
    expect(PANNEAU).not.toContain("open: true");
    expect(CONFIG_CSS).toContain(".declencheurs-journal__summary");
  });

  it("est BORNÉ : N dernières entrées, jamais tout le fichier", () => {
    expect(JOURNAL_LIMITE).toBeLessThanOrEqual(50);
    expect(JOURNAL_LIMITE_MAX).toBeLessThanOrEqual(200);
    expect(PANNEAU).toContain("Charger plus d'événements");
    expect(PANNEAU).toContain("state.journalLimite");
  });

  it("est FILTRABLE par type", () => {
    expect(filtrerJournal(evenements, { type: "echec" }).map((e) => e.event)).toEqual(["echec"]);
    expect(filtrerJournal(evenements, { type: "saut" }).map((e) => e.source)).toEqual(["veille"]);
    expect(filtrerJournal(evenements, { type: "tous" })).toHaveLength(evenements.length);
  });

  it("est FILTRABLE par déclencheur", () => {
    expect(filtrerJournal(evenements, { type: "tous", source: "mail" })).toHaveLength(2);
    expect(filtrerJournal(evenements, { type: "recu", source: "mail" })).toHaveLength(0);
  });

  it("offre DÉJÀ le filtre « pré-autorisation » du lot 4", () => {
    expect(EVENEMENTS_JOURNAL.map(([slug]) => slug)).toContain("preautorisation");
    const consommees = filtrerJournal(evenements, { type: "preautorisation" });
    expect(consommees).toHaveLength(1);
    expect(consommees[0].preAutorisation).toBe("lire_page_web");
  });

  it("borne le contenu AFFICHÉ (8 000 côté serveur, 400 à l'écran)", () => {
    const long = "a".repeat(1_000);
    const borne = texteJournalBorne(long);
    expect(borne.length).toBeLessThan(long.length);
    expect(borne).toContain("tronqué à l'affichage");
    expect(texteJournalBorne("court")).toBe("court");
  });
});

describe("déclencheurs — ⚠️ un TEMPORAIRE éteint reste visible 7 jours", () => {
  const ponctuelEteint = (depuisJours: number) =>
    planning({
      nom: "impots",
      declencheur: { type: "planning", expression: "0 9 3 5 *", fuseau: "Europe/Paris" },
      actif: false,
      raisonInactive: "DÉSACTIVER",
      desactiveLe: new Date(MAINTENANT - depuisJours * JOUR).toISOString(),
    });

  it("reste en TEMPORAIRES dans les 7 jours (on sait qu'il a existé)", () => {
    expect(JOURS_VISIBILITE_TEMPORAIRE).toBe(7);
    const recent = ponctuelEteint(2);
    expect(eteintRecemment(recent, MAINTENANT)).toBe(true);
    expect(classerSource(recent, { maintenant: MAINTENANT })).toBe("temporaires");
    expect(texteEtat(recent)).toContain("en sommeil");
    expect(texteEtat(recent)).toContain("le ");
  });

  it("rejoint « sommeil » après 7 jours — sans JAMAIS disparaître", () => {
    const ancien = ponctuelEteint(8);
    expect(eteintRecemment(ancien, MAINTENANT)).toBe(false);
    expect(classerSource(ancien, { maintenant: MAINTENANT })).toBe("sommeil");
    const groupes = grouperParSection([ancien], { maintenant: MAINTENANT });
    expect(groupes.reduce((total, groupe) => total + groupe.sources.length, 0)).toBe(1);
  });

  it("ne cache pas un déclencheur dont la date d'extinction est illisible", () => {
    const douteux: Record<string, unknown> = { ...ponctuelEteint(0) };
    douteux["desactiveLe"] = "pas-une-date";
    douteux["maj"] = "pas-une-date";
    expect(eteintRecemment(douteux, MAINTENANT)).toBe(true);
  });
});

describe("déclencheurs — l'onglet DÉDIÉ et l'ancre", () => {
  it("le panneau vit dans le panneau « Déclencheurs » de /config", () => {
    expect(CONFIG_HTML).toContain('id="tab-declencheurs"');
    expect(CONFIG_HTML).toContain('aria-controls="panel-declencheurs"');
    const panneau = CONFIG_HTML.slice(
      CONFIG_HTML.indexOf('id="panel-declencheurs"'),
      CONFIG_HTML.indexOf('id="panel-personnalite"'),
    );
    expect(panneau).toContain('id="sources-root"');
    expect(CONFIG_HTML.indexOf('id="panel-declencheurs"')).toBeGreaterThan(
      CONFIG_HTML.indexOf('id="panel-conversation"'),
    );
  });

  it("déclare l'ancre `#declencheurs` (et garde `#sources` et le journal)", () => {
    expect(CONFIG_JS).toContain('["declencheurs", "declencheurs"]');
    expect(CONFIG_JS).toContain('["sources", "declencheurs"]');
    expect(CONFIG_JS).toContain(`["${ANCRE_JOURNAL}", "declencheurs"]`);
  });

  it("⚠️ le lien de la pastille est COHÉRENT avec l'ancre", () => {
    expect(INDEX).toContain('href="/config#declencheurs"');
    expect(INDEX).not.toContain('href="/config#sources"');
    // L'ancre visée EXISTE dans le markup (sinon `revealHashTarget` échoue).
    expect(CONFIG_HTML).toContain('id="tab-declencheurs"');
  });

  it("aucun style inline, aucun innerHTML dans la page de gestion", () => {
    for (const source of [PANNEAU, lire("declencheurs-vue.js")]) {
      const sansCommentaires = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(sansCommentaires).not.toContain("innerHTML");
      expect(sansCommentaires).not.toMatch(/["']style["']\s*:/);
      expect(sansCommentaires).not.toMatch(/\sstyle=/);
    }
  });
});
