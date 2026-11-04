/**
 * ÉVALUATEUR CRON (lot 26, moteur horloge) — maison, 5 champs, zéro dépendance.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/sources/cron.ts` n'existait
 * pas (aucun déclencheur `planning`). Preuve : `git show HEAD:src/sources/types.ts`
 * ne connaît que `declencheur: { type: "webhook" }`.
 *
 * Ce qui est verrouillé ici :
 *  - les formes supportées (`*`, `a`, `a-b`, `a-b/n`, `*`/`n`, listes) ;
 *  - les REFUS explicites (`L`, `#`, `?`, `@reboot`, noms de mois…) ;
 *  - ⚠️ le piège CLASSIQUE : jour-du-mois ET jour-de-semaine ensemble ⇒ **OR** ;
 *  - ⚠️ le FUSEAU PAR DÉCLENCHEUR : `0 9 * * *` en `Europe/Paris` ne tire pas à
 *    9 h UTC (le process, lui, est en UTC dans un conteneur) ;
 *  - ⚠️ le CHANGEMENT D'HEURE : ni saut ni doublon ;
 *  - ⚠️ l'échec EXPLICITE quand aucune occurrence n'existe (`0 0 31 2 *`).
 */

import { describe, expect, it } from "vitest";

import {
  CRON_MAX_LOOKAHEAD_YEARS,
  CronError,
  apercuCron,
  correspond,
  isCronExpression,
  jourLocal,
  parseCron,
  partiesLocales,
  prochainPassage,
  validateFuseau,
} from "../../src/sources/cron.js";

const PARIS = "Europe/Paris";
const iso = (ms: number): string => new Date(ms).toISOString();

/** N instants successifs d'une expression (ISO), pour lire une série. */
function serie(expression: string, depuis: string, combien: number, fuseau = PARIS): string[] {
  const expr = parseCron(expression);
  const out: string[] = [];
  let curseur = Date.parse(depuis);
  for (let index = 0; index < combien; index += 1) {
    const suivant = prochainPassage(expr, curseur, fuseau);
    out.push(iso(suivant));
    curseur = suivant;
  }
  return out;
}

describe("évaluateur cron — formes supportées", () => {
  it("`*` toutes les minutes", () => {
    expect(serie("* * * * *", "2026-06-01T10:00:30Z", 3)).toEqual([
      "2026-06-01T10:01:00.000Z",
      "2026-06-01T10:02:00.000Z",
      "2026-06-01T10:03:00.000Z",
    ]);
  });

  it("`*/5` : minutes multiples de 5", () => {
    expect(serie("*/5 * * * *", "2026-06-01T10:03:00Z", 2)).toEqual([
      "2026-06-01T10:05:00.000Z",
      "2026-06-01T10:10:00.000Z",
    ]);
  });

  it("`0 9 * * 1-5` : 9 h du lundi au vendredi (aucun samedi ni dimanche)", () => {
    // 2026-06-05 est un vendredi ; le suivant est le LUNDI 8 juin.
    const passages = serie("0 9 * * 1-5", "2026-06-05T18:00:00Z", 3).map(
      (instant) => partiesLocales(Date.parse(instant), PARIS),
    );
    expect(passages.map((p) => `${p.jour}/${p.mois} ${p.heure}h`)).toEqual([
      "8/6 9h",
      "9/6 9h",
      "10/6 9h",
    ]);
  });

  it("listes `0,30 9-11 * * *` et pas `a-b/n`", () => {
    expect(serie("0,30 9-11 * * *", "2026-06-01T06:50:00Z", 3)).toEqual([
      // 08:00 UTC = 10:00 à Paris (CEST) — la liste démarre à 9 h locale.
      "2026-06-01T07:00:00.000Z",
      "2026-06-01T07:30:00.000Z",
      "2026-06-01T08:00:00.000Z",
    ]);
    expect(serie("10-40/10 * * * *", "2026-06-01T10:00:00Z", 2)).toEqual([
      "2026-06-01T10:10:00.000Z",
      "2026-06-01T10:20:00.000Z",
    ]);
  });

  it("`correspond` est exact et rejette une seconde non nulle", () => {
    const expr = parseCron("*/5 * * * *");
    expect(correspond(expr, Date.parse("2026-06-01T10:05:00Z"), PARIS)).toBe(true);
    expect(correspond(expr, Date.parse("2026-06-01T10:06:00Z"), PARIS)).toBe(false);
    expect(correspond(expr, Date.parse("2026-06-01T10:05:30Z"), PARIS)).toBe(false);
  });
});

describe("évaluateur cron — refus EXPLICITES (message qui dit ce qui est supporté)", () => {
  const refuses: Array<[string, RegExp]> = [
    ["0 0 L * *", /« L » \(dernier jour du mois\) n'est pas supporté/],
    ["0 0 * * 5#3", /« # » .* n'est pas supporté/],
    ["0 0 ? * *", /« \? » .* n'est pas supporté/],
    ["@reboot", /raccourcis « @… »/],
    ["0 9 * JAN *", /noms de mois ou de jours/],
    ["0 9 * *", /4 champ\(s\) au lieu de 5/],
    ["60 * * * *", /hors bornes \(0-59\)/],
    ["0 24 * * *", /hors bornes \(0-23\)/],
    ["0 0 0 * *", /hors bornes \(1-31\)/],
    ["0 0 * 13 *", /hors bornes \(1-12\)/],
    ["0 0 * * 8", /hors bornes \(0-7\)/],
    ["10-5 * * * *", /plage inversée/],
    ["5/10 * * * *", /n'a pas de plage/],
    ["1,,2 * * * *", /élément vide/],
    ["", /Expression cron vide/],
  ];

  for (const [expression, motif] of refuses) {
    it(`refuse « ${expression} »`, () => {
      expect(() => parseCron(expression)).toThrow(CronError);
      expect(() => parseCron(expression)).toThrow(motif);
      expect(isCronExpression(expression)).toBe(false);
    });
  }

  it("le message de refus rappelle TOUJOURS la syntaxe supportée", () => {
    try {
      parseCron("0 0 L * *");
      throw new Error("aurait dû lever");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("minute heure jour-du-mois mois jour-de-semaine");
      expect(message).toContain("a-b/n");
      expect(message).toContain("0 et 7 = dimanche");
    }
  });

  it("le dimanche s'écrit 0 ou 7 (une seule valeur canonique)", () => {
    // 2026-06-07 est un dimanche.
    expect(serie("0 9 * * 0", "2026-06-06T00:00:00Z", 1)).toEqual(
      serie("0 9 * * 7", "2026-06-06T00:00:00Z", 1),
    );
  });
});

describe("évaluateur cron — ⚠️ jour-du-mois ET jour-de-semaine ⇒ OR", () => {
  it("`0 0 1 * 1` tire le 1er du mois ET chaque lundi (jamais l'un exclusivement)", () => {
    // Depuis le 2026-06-01 : lundis 1, 8, 15, 22, 29 juin ; le 1er juillet est un
    // mercredi (jour-du-mois), donc il DOIT apparaître — c'est le OU.
    const jours = serie("0 0 1 * 1", "2026-06-01T12:00:00Z", 6).map((instant) => {
      const p = partiesLocales(Date.parse(instant), PARIS);
      // ⚠️ Le jour de semaine se lit sur la date LOCALE, jamais sur l'instant UTC
      // (minuit local = la veille en UTC).
      const dow = new Date(Date.UTC(p.annee, p.mois - 1, p.jour)).getUTCDay();
      return `${p.jour}/${p.mois} dow=${dow}`;
    });
    expect(jours).toEqual([
      "8/6 dow=1",
      "15/6 dow=1",
      "22/6 dow=1",
      "29/6 dow=1",
      "1/7 dow=3",
      "6/7 dow=1",
    ]);
  });

  it("un seul champ restreint ⇒ ET (le joker ne restreint rien)", () => {
    // `0 0 * * 1` : que les lundis. Un 1er du mois non-lundi ne tire PAS.
    const instants = serie("0 0 * * 1", "2026-06-01T12:00:00Z", 3).map((instant) =>
      partiesLocales(Date.parse(instant), PARIS),
    );
    expect(instants.map((p) => `${p.jour}/${p.mois}`)).toEqual(["8/6", "15/6", "22/6"]);
  });
});

describe("évaluateur cron — ⚠️ fuseau PAR DÉCLENCHEUR (jamais celui du process)", () => {
  it("`0 9 * * *` en Europe/Paris ne tire PAS à 9 h UTC", () => {
    const passage = prochainPassage(
      parseCron("0 9 * * *"),
      Date.parse("2026-06-01T00:00:00Z"),
      PARIS,
    );
    // 9 h à Paris en été (CEST = UTC+2) ⇒ 07:00 UTC, surtout pas 09:00 UTC.
    expect(iso(passage)).toBe("2026-06-01T07:00:00.000Z");
    expect(partiesLocales(passage, PARIS).heure).toBe(9);
  });

  it("le MÊME instant est 9 h à Paris et 7 h UTC", () => {
    const passage = prochainPassage(
      parseCron("0 9 * * *"),
      Date.parse("2026-06-01T00:00:00Z"),
      PARIS,
    );
    expect(partiesLocales(passage, PARIS).heure).toBe(9);
    expect(partiesLocales(passage, "UTC").heure).toBe(7);
  });

  it("un fuseau inconnu est REFUSÉ (aucun repli sur le fuseau du process)", () => {
    expect(() => validateFuseau("Mars/Olympus")).toThrow(/Fuseau horaire inconnu/);
    expect(validateFuseau("")).toBe(PARIS);
    const apercu = apercuCron("0 9 * * *", "Mars/Olympus", Date.now(), 1);
    expect(apercu.code).toBe("fuseau_inconnu");
    expect(apercu.raison).toContain("Europe/Paris");
  });

  it("`jourLocal` bascule à minuit LOCAL (garde-fou quotidien)", () => {
    // 2026-06-01T22:30Z = 00:30 à Paris le 2 juin.
    expect(jourLocal(Date.parse("2026-06-01T22:30:00Z"), PARIS)).toBe("2026-06-02");
    expect(jourLocal(Date.parse("2026-06-01T21:30:00Z"), PARIS)).toBe("2026-06-01");
  });
});

describe("évaluateur cron — ⚠️ changement d'heure : ni saut ni doublon", () => {
  it("passage à l'heure d'été (29/03/2026) : un seul tir par jour, à 9 h locale", () => {
    const passages = serie("0 9 * * *", "2026-03-28T12:00:00Z", 4);
    // 28/03 : 08:00 UTC (CET), puis 07:00 UTC (CEST) : l'heure UTC change, le
    // déclenchement LOCAL reste 9 h — et il n'y a ni saut ni doublon.
    expect(passages).toEqual([
      "2026-03-29T07:00:00.000Z",
      "2026-03-30T07:00:00.000Z",
      "2026-03-31T07:00:00.000Z",
      "2026-04-01T07:00:00.000Z",
    ]);
    for (const passage of passages) {
      expect(partiesLocales(Date.parse(passage), PARIS).heure).toBe(9);
    }
  });

  it("retour à l'heure d'hiver (25/10/2026) : `0 2 * * *` tire UNE fois, pas deux", () => {
    const passages = serie("0 2 * * *", "2026-10-24T12:00:00Z", 3);
    // 02:00 locale du 25/10 existe DEUX fois (00:00Z puis 01:00Z) : une seule doit
    // sortir. Le 26/10 bascule à 01:00Z (CET).
    expect(passages).toEqual([
      "2026-10-25T00:00:00.000Z",
      "2026-10-26T01:00:00.000Z",
      "2026-10-27T01:00:00.000Z",
    ]);
    const jours = new Set(passages.map((p) => jourLocal(Date.parse(p), PARIS)));
    expect(jours.size).toBe(3);
  });

  it("une heure locale SUPPRIMÉE ce jour-là est sautée (aucun instant n'existe)", () => {
    // Le 29/03/2026 à Paris, 02:30 n'existe pas : le prochain tir est le 30.
    const passages = serie("30 2 * * *", "2026-03-28T12:00:00Z", 2);
    expect(passages.map((p) => jourLocal(Date.parse(p), PARIS))).toEqual([
      "2026-03-30",
      "2026-03-31",
    ]);
  });
});

describe("évaluateur cron — prochain passage BORNÉ puis échec explicite", () => {
  it("`0 0 31 2 *` n'existe jamais : échec explicite, jamais une boucle muette", () => {
    expect(() =>
      prochainPassage(parseCron("0 0 31 2 *"), Date.now(), PARIS),
    ).toThrow(/Aucune occurrence dans les \d+ prochaines années/);
    const apercu = apercuCron("0 0 31 2 *", PARIS, Date.parse("2026-06-01T00:00:00Z"), 1);
    expect(apercu.code).toBe("aucune_occurrence");
    expect(apercu.passages).toEqual([]);
    expect(CRON_MAX_LOOKAHEAD_YEARS).toBe(5);
  });

  it("l'aperçu rend plusieurs passages lisibles (l'UI les affiche)", () => {
    const apercu = apercuCron("0 9 * * 1-5", PARIS, Date.parse("2026-06-05T18:00:00Z"), 3);
    expect(apercu.fuseau).toBe(PARIS);
    expect(apercu.expression).toBe("0 9 * * 1-5");
    expect(apercu.passages).toHaveLength(3);
    expect(apercu.raison).toBeUndefined();
  });

  it("une expression invalide est refusée à l'APERÇU aussi (même raison)", () => {
    const apercu = apercuCron("0 0 L * *", PARIS, Date.now(), 1);
    expect(apercu.code).toBe("syntaxe_non_supportee");
    expect(apercu.raison).toContain("« L » (dernier jour du mois) n'est pas supporté");
  });
});
