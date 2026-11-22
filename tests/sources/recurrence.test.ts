/**
 * RÉCURRENCES du MODÈLE — traduction en DÉCLENCHEUR DURABLE (`planning` + cron).
 *
 * ⚠️ CE QUE CES TESTS VERROUILLENT (2026-11-22) : « ajoute des tâches récurrentes ».
 * Le modèle n'écrit PAS de cron (`*\/7 * * * *` serait faux sans qu'il le sache) : il
 * choisit une des QUATRE formes, et la traduction est tenue ici.
 *
 * ⚠️ Ils ÉCHOUENT sur l'origine : `src/sources/recurrence.ts` n'existe pas, et
 * `planifier_tache` ne savait créer qu'une tâche PONCTUELLE.
 */

import { describe, expect, it } from "vitest";

import { parseCron, prochainPassage } from "../../src/sources/cron.js";
import {
  MAX_HEURES_RECURRENCE,
  MIN_HEURES_RECURRENCE,
  validerRecurrence,
} from "../../src/sources/recurrence.js";

/** 4 novembre 2026, 17 h 00 à Paris (= 16 h UTC). */
const T0 = Date.parse("2026-11-04T16:00:00Z");

function expression(recurrence: unknown): string {
  const issue = validerRecurrence(recurrence);
  if (!issue.ok) throw new Error(`récurrence refusée : ${issue.raison}`);
  return issue.expression;
}

describe("récurrence — les QUATRE formes demandées, et leur cron", () => {
  it("tous_les_jours ⇒ « minute heure * * * », évalué dans le fuseau de Yuki", () => {
    expect(expression({ type: "tous_les_jours", heure: "08:00" })).toBe("0 8 * * *");
    // Formes réelles écrites par un modèle / une personne.
    expect(expression({ type: "tous_les_jours", heure: "8h" })).toBe("0 8 * * *");
    expect(expression({ type: "tous_les_jours", heure: "8 h 30" })).toBe("30 8 * * *");
    const issue = validerRecurrence({ type: "tous_les_jours", heure: "08:00" });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    expect(issue.fuseau).toBe("Europe/Paris");
    expect(issue.lisible).toBe("tous les jours à 08:00");
    // Le cron produit est ACCEPTÉ par le moteur horloge (aucune expression inventée).
    expect(() => parseCron(issue.expression)).not.toThrow();
  });

  it("chaque_semaine ⇒ le jour de la semaine en chiffre cron (0 = dimanche)", () => {
    expect(expression({ type: "chaque_semaine", jour: "lundi", heure: "09:00" })).toBe(
      "0 9 * * 1",
    );
    expect(expression({ type: "chaque_semaine", jour: "dimanche", heure: "09:00" })).toBe(
      "0 9 * * 0",
    );
    // Accents et casse tolérés (« Mercredi » saisi à la main).
    expect(expression({ type: "chaque_semaine", jour: "Mercredi", heure: "18:15" })).toBe(
      "15 18 * * 3",
    );
    const issue = validerRecurrence({ type: "chaque_semaine", jour: "lundi", heure: "09:00" });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    expect(issue.lisible).toBe("chaque lundi à 09:00");
  });

  it("toutes_les_heures ⇒ série calée sur MINUIT local, bornes 1–24", () => {
    expect(expression({ type: "toutes_les_heures", heures: 1 })).toBe("0 * * * *");
    expect(expression({ type: "toutes_les_heures", heures: 6 })).toBe("0 0,6,12,18 * * *");
    // 5 ne divise pas 24 : la série s'arrête avant minuit (le 23 h n'est PAS tiré).
    expect(expression({ type: "toutes_les_heures", heures: 5 })).toBe("0 0,5,10,15,20 * * *");
    // 24 = une fois par jour, à minuit (dit tel quel dans la formulation).
    expect(expression({ type: "toutes_les_heures", heures: 24 })).toBe("0 0 * * *");
    for (const heures of [MIN_HEURES_RECURRENCE, MAX_HEURES_RECURRENCE]) {
      expect(validerRecurrence({ type: "toutes_les_heures", heures }).ok).toBe(true);
    }
  });

  it("tous_les_mois ⇒ jour du mois (1–31), et les mois courts sont DITS", () => {
    expect(expression({ type: "tous_les_mois", jourDuMois: 1, heure: "10:00" })).toBe(
      "0 10 1 * *",
    );
    const fin = validerRecurrence({ type: "tous_les_mois", jourDuMois: 31, heure: "10:00" });
    expect(fin.ok).toBe(true);
    if (!fin.ok) return;
    expect(fin.expression).toBe("0 10 31 * *");
    expect(fin.lisible).toContain("sautés");
    // ⚠️ Le 31 ne tombe pas tous les mois : le prochain passage SAUTE les mois courts
    // au lieu de tirer le 30 (le cron standard ne « décale » jamais).
    const suivant = prochainPassage(parseCron("0 10 31 * *"), Date.parse("2026-11-30T00:00:00Z"), "Europe/Paris");
    expect(new Date(suivant).toISOString()).toBe("2026-12-31T09:00:00.000Z");
  });
});

describe("récurrence — refus NOMMÉS (aucune expression inventée)", () => {
  const cas: Array<[string, unknown, string]> = [
    ["type inconnu", { type: "toutes_les_minutes" }, "type de récurrence inconnu"],
    ["heure illisible", { type: "tous_les_jours", heure: "8 heures" }, "heure lisible"],
    ["heure hors bornes", { type: "tous_les_jours", heure: "25:00" }, "heure lisible"],
    ["jour inconnu", { type: "chaque_semaine", jour: "lunedi", heure: "8:00" }, "jour lisible"],
    [
      "écart d'heures à 0",
      { type: "toutes_les_heures", heures: 0 },
      `${MIN_HEURES_RECURRENCE} à ${MAX_HEURES_RECURRENCE}`,
    ],
    [
      "écart d'heures à 25",
      { type: "toutes_les_heures", heures: 25 },
      `${MIN_HEURES_RECURRENCE} à ${MAX_HEURES_RECURRENCE}`,
    ],
    ["jour du mois à 0", { type: "tous_les_mois", jourDuMois: 0, heure: "10:00" }, "1 à 31"],
    ["jour du mois à 32", { type: "tous_les_mois", jourDuMois: 32, heure: "10:00" }, "1 à 31"],
    ["objet vide", {}, "type de récurrence inconnu"],
    ["valeur non objet", "tous les jours", "récurrence est illisible"],
  ];

  for (const [nom, recurrence, attendu] of cas) {
    it(`refuse : ${nom}`, () => {
      const refus = validerRecurrence(recurrence);
      expect(refus.ok).toBe(false);
      if (refus.ok) return;
      expect(refus.raison).toContain(attendu);
      // ⚠️ Un refus dit toujours ce qu'il fallait écrire.
      expect(refus.raison).toContain("Formes acceptées");
      expect(refus.raison.startsWith("Rien n'a été programmé")).toBe(true);
    });
  }

  it("un fuseau inconnu est refusé (jamais un fuseau du processus)", () => {
    const refus = validerRecurrence(
      { type: "tous_les_jours", heure: "08:00" },
      "Mars/Olympus",
    );
    expect(refus.ok).toBe(false);
    if (!refus.ok) expect(refus.raison).toContain("Fuseau horaire inconnu");
  });

  it("les heures de la série sont triées et uniques (aucun doublon dans le cron)", () => {
    const issue = validerRecurrence({ type: "toutes_les_heures", heures: 12 });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    expect(issue.expression).toBe("0 0,12 * * *");
    // Le prochain passage existe bel et bien (0 h puis 12 h, fuseau de Paris).
    const suivant = prochainPassage(parseCron(issue.expression), T0, issue.fuseau);
    expect(new Date(suivant).toISOString()).toBe("2026-11-04T23:00:00.000Z");
  });
});
