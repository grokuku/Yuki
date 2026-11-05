/**
 * LOTS 32 et 33 — la page de gestion et les règles d'affichage.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine :
 *  - aucune fonction `texteOccurrences` / `grouperParChaine` / `etatEtape` n'existe ;
 *  - le formulaire n'a NI « jusqu'au » NI « N occurrences » (`source-jusqu-au`,
 *    `source-occurrences-max`) ;
 *  - la page ne rend aucune carte de chaîne et n'affiche donc jamais le nom de ses étapes.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  etatEtape,
  grouperParChaine,
  texteOccurrences,
  texteQuand,
  texteResultatEtape,
} from "../../public/ui/declencheurs-vue.js";

const UI = join(process.cwd(), "public", "ui");
const lire = (nom: string): string => readFileSync(join(UI, nom), "utf8");

const PANNEAU = lire("sources-panel.js");

/** Fiche minimale d'un déclencheur planifié. */
function planning(extra: Record<string, unknown> = {}) {
  return {
    nom: "veille",
    declencheur: { type: "planning", expression: "0 9 * * *", fuseau: "Europe/Paris" },
    visibilite: "silencieux",
    actif: true,
    ...extra,
  };
}

/** Fiche d'étape de chaîne. */
function etape(rang: number, extra: Record<string, unknown> = {}) {
  return {
    nom: `etape-${rang}`,
    libelle: `Étape ${rang}`,
    declencheur: { type: "planning", expression: `0 ${8 + rang} * * *`, fuseau: "Europe/Paris" },
    visibilite: "silencieux",
    actif: true,
    chaine: { id: "chaine-1", etape: rang, ...(rang > 1 ? { apres: `etape-${rang - 1}` } : {}) },
    ...extra,
  };
}

describe("LOT 32 — « reste 6/14 » et la fin de récurrence", () => {
  it("affiche le RESTE de la borne par nombre de passages", () => {
    expect(texteOccurrences(planning({ occurrencesMax: 14, occurrencesFaites: 8 }))).toBe(
      "reste 6/14",
    );
    // Un compteur absent vaut 0 (aucun passage encore tiré) — jamais un reste inventé.
    expect(texteOccurrences(planning({ occurrencesMax: 3 }))).toBe("reste 3/3");
  });

  it("dit « terminée » quand la borne est atteinte, sans afficher « reste 0 »", () => {
    const texte = texteOccurrences(planning({ occurrencesMax: 14, occurrencesFaites: 14 }));
    expect(texte).toContain("terminée");
    expect(texte).toContain("14/14");
    expect(texte).not.toContain("reste 0");
  });

  it("affiche la date de fin prévue quand la borne est une DATE", () => {
    const texte = texteOccurrences(planning({ jusquAu: "2026-11-19T23:00:00.000Z" }));
    expect(texte).toContain("fin prévue le");
    expect(texte).toContain("2026");
  });

  it("n'affiche rien quand aucune fin n'est prévue (aucune case « 0/0 »)", () => {
    expect(texteOccurrences(planning())).toBe("");
    // Et la colonne « Quand » n'ajoute alors aucun séparateur orphelin.
    expect(texteQuand(planning())).not.toMatch(/·\s*$/);
  });

  it("la colonne « Quand » porte le reste à côté de l'expression", () => {
    const quand = texteQuand(planning({ occurrencesMax: 14, occurrencesFaites: 8 }));
    expect(quand).toContain("0 9 * * *");
    expect(quand).toContain("reste 6/14");
  });

  it("le formulaire expose les DEUX champs (date et nombre) et les envoie", () => {
    expect(PANNEAU).toContain('id: "source-jusqu-au"');
    expect(PANNEAU).toContain('id: "source-occurrences-max"');
    expect(PANNEAU).toContain("Fin de récurrence par DATE");
    expect(PANNEAU).toContain("Fin de récurrence par NOMBRE");
    // ⚠️ `null` = RETIRER la borne : un champ vidé ne laisse pas la valeur précédente.
    expect(PANNEAU).toContain("occurrencesMax: values.occurrencesMax");
    expect(PANNEAU).toContain("jusquAu: values.jusquAu");
    // La valeur relue est réaffichée dans le formulaire d'édition.
    expect(PANNEAU).toContain("occurrencesMax: source.occurrencesMax");
    expect(PANNEAU).toContain("jusquAu: source.jusquAu");
  });

  it("le formulaire DIT qu'un saut ne compte pas", () => {
    expect(PANNEAU).toContain("RÉELLEMENT TIRÉS");
    expect(PANNEAU).toContain("ne compte pas");
  });
});

describe("LOT 33 — une CARTE par chaîne, étapes dans l'ordre", () => {
  it("regroupe par chaîne et trie les étapes par rang", () => {
    const { chaines, isolees } = grouperParChaine([
      etape(3),
      planning({ nom: "isolee" }),
      etape(1),
      etape(2),
    ]);
    expect(isolees.map((source: { nom: string }) => source.nom)).toEqual(["isolee"]);
    expect(chaines).toHaveLength(1);
    expect(chaines[0].id).toBe("chaine-1");
    expect(chaines[0].etapes.map((source: { nom: string }) => source.nom)).toEqual([
      "etape-1",
      "etape-2",
      "etape-3",
    ]);
    // Le titre vient de la PREMIÈRE étape (ce que la personne a nommé).
    expect(chaines[0].titre).toBe("Étape 1");
  });

  it("deux chaînes distinctes ne sont jamais mélangées", () => {
    const { chaines } = grouperParChaine([
      etape(1),
      etape(2),
      { ...etape(1, { nom: "b-1", libelle: "B1" }), chaine: { id: "chaine-2", etape: 1 } },
      { ...etape(2, { nom: "b-2", libelle: "B2" }), chaine: { id: "chaine-2", etape: 2, apres: "b-1" } },
    ]);
    expect(chaines.map((chaine: { id: string }) => chaine.id).sort()).toEqual([
      "chaine-1",
      "chaine-2",
    ]);
    for (const chaine of chaines) expect(chaine.etapes).toHaveLength(2);
  });

  it("l'état de chaque étape est DIT : faite, en attente, annulée", () => {
    expect(etatEtape(etape(1))).toBe("en attente");
    expect(
      etatEtape(etape(1, { resultatEtape: { jobId: "job-1", texte: "ok", fichiers: [], at: "2026-06-01T06:00:00.000Z" } })),
    ).toContain("faite le");
    expect(etatEtape(etape(2, { actif: false, raisonInactive: "annulée : l'étape « Étape 1 » a échoué" }))).toBe(
      "annulée : l'étape « Étape 1 » a échoué",
    );
    // Hors chaîne : on ne prétend pas qu'elle est en attente de relais.
    expect(etatEtape(planning())).toBe("hors chaîne");
  });

  it("le panneau rend une CARTE par chaîne et affiche le NOM des étapes", () => {
    expect(PANNEAU).toContain("grouperParChaine(state.sources)");
    expect(PANNEAU).toContain("etatEtape(etape)");
    // ⚠️ Le NOM est affiché : c'est lui qui porte les pré-autorisations.
    expect(PANNEAU).toContain("text: etape.nom");
    expect(PANNEAU).toContain("declencheurs-chaine__nom");
    // Les trois sections historiques ne décrivent plus que les déclencheurs isolés.
    expect(PANNEAU).toContain("grouperParSection(isolees)");
  });

  it("la colonne « Quand » d'une étape dit son rang et son identifiant de chaîne", () => {
    const quand = texteQuand(etape(2));
    expect(quand).toContain("chaine-1");
    expect(quand).toContain("étape 2");
  });

  it("le résultat d'une étape est résumé et BORNÉ", () => {
    const texte = texteResultatEtape(
      etape(1, {
        resultatEtape: {
          jobId: "job-1",
          texte: "y".repeat(400),
          fichiers: ["a", "b"],
          at: "2026-06-01T06:00:00.000Z",
        },
      }),
    );
    expect(texte.length).toBeLessThan(400);
    expect(texte).toContain("…");
    expect(texte).toContain("2 fichier(s)");
    expect(texteResultatEtape(etape(1))).toBe("");
  });
});
