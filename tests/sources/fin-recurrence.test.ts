/**
 * LOT 32 — FIN DE RÉCURRENCE (`occurrencesMax`, `jusquAu`).
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `occurrencesMax` et `jusquAu` y sont
 * déclarés, validés et relus, mais AUCUNE extinction n'est branchée — le balayeur ne lit
 * jamais ces champs et `incrementerOccurrence` n'est appelé nulle part.
 *
 * Ce qui est verrouillé ici :
 *  - `occurrencesMax` atteint ⇒ déclencheur ÉTEINT avec la raison « terminée : 2/2
 *    passages » (même canal que `DÉSACTIVER`, journal `desactive`) ;
 *  - `jusquAu` dépassé ⇒ idem, avec la date en français ;
 *  - le COMPTEUR est PERSISTÉ (un `SourcesStore` relu le retrouve) ;
 *  - ⚠️ un SAUT (rattrapage refusé) n'incrémente PAS le compteur ;
 *  - `update` INVALIDE le compteur quand le déclencheur change.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DeclencheurBalayeur, raisonFinDate } from "../../src/sources/scheduler.js";
import { SourcesStore } from "../../src/sources/store.js";
import type { SourceRecord } from "../../src/sources/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harnais {
  store: SourcesStore;
  balayeur: DeclencheurBalayeur;
  avancer: (ms: number) => void;
  maintenant: () => number;
  lances: string[];
  path: string;
}

/**
 * Harnais MINIMAL : le port `run` ne fait que rendre « started » — ce fichier teste la
 * DÉCISION du balayeur (compter, éteindre), pas l'exécution d'un tour.
 */
function harnais(options: { maintenant?: number } = {}): Harnais {
  const dir = mkdtempSync(join(tmpdir(), "yuki-fin-recurrence-"));
  dirs.push(dir);
  const path = join(dir, "sources.json");
  let maintenant = options.maintenant ?? Date.parse("2026-06-01T06:00:00Z");
  const store = new SourcesStore({ path, now: () => maintenant });
  const lances: string[] = [];
  const balayeur = new DeclencheurBalayeur({
    store,
    logger: { info: () => {}, warn: () => {} },
    now: () => maintenant,
    run: async (nom) => {
      lances.push(nom);
      return {
        outcome: "started",
        runId: `job-${lances.length}`,
        fin: Promise.resolve({ reason: "done", texte: "" }),
      };
    },
  });
  return {
    store,
    balayeur,
    lances,
    path,
    avancer: (ms) => {
      maintenant += ms;
    },
    maintenant: () => maintenant,
  };
}

/** Déclare un planning arme son PROCHAIN passage à `dans` ms (déterministe). */
function declare(h: Harnais, nom: string, settings: Record<string, unknown> = {}, dans = 0): void {
  h.store.create(nom, {
    visibilite: "silencieux",
    declencheur: { type: "planning", expression: "0 9 * * *", fuseau: "Europe/Paris" },
    ...settings,
  } as never);
  h.store.markPlanification(nom, {
    prochainPassage: new Date(h.maintenant() + dans).toISOString(),
  });
}

function fiche(h: Harnais, nom: string): SourceRecord {
  const record = h.store.get(nom);
  if (!record) throw new Error(`fiche absente : ${nom}`);
  return record;
}

const JOUR = 86_400_000;

describe("fin de récurrence — NOMBRE de passages (`occurrencesMax`)", () => {
  it("éteint le déclencheur au maximum ATTEINT, avec la raison lisible", async () => {
    const h = harnais();
    declare(h, "veille", { occurrencesMax: 2 });

    // Deux passages réellement tirés (le réarmement vise le lendemain 9 h de Paris).
    await h.balayeur.tick();
    expect(fiche(h, "veille").occurrencesFaites).toBe(1);
    h.avancer(3_600_000);
    await h.balayeur.tick();
    expect(fiche(h, "veille").occurrencesFaites).toBe(2);
    // Toujours actif après le 2ᵉ passage : l'échéance est constatée au réarmement SUIVANT.
    expect(fiche(h, "veille").actif).not.toBe(false);

    h.avancer(JOUR);
    await h.balayeur.tick();
    const apres = fiche(h, "veille");
    expect(apres.actif).toBe(false);
    expect(apres.raisonInactive).toBe("terminée : 2/2 passages");
    // Aucun troisième passage n'a été lancé.
    expect(h.lances).toEqual(["veille", "veille"]);
  });

  it("compte les passages RÉELLEMENT TIRÉS, pas les ticks", async () => {
    const h = harnais();
    declare(h, "veille", { occurrencesMax: 10 });
    // 1ᵉʳ passage : tout de suite. Les suivants : à l'instant réarmé (9 h de Paris).
    await h.balayeur.tick();
    h.avancer(3_600_000);
    await h.balayeur.tick();
    h.avancer(JOUR);
    await h.balayeur.tick();
    expect(fiche(h, "veille").occurrencesFaites).toBe(3);
    expect(h.lances).toHaveLength(3);
  });

  it("⚠️ un SAUT (rattrapage refusé) n'incrémente PAS le compteur", async () => {
    const h = harnais();
    // Passage en retard de 2 h, rattrapage désactivé ⇒ sauté.
    declare(h, "veille", { occurrencesMax: 5, rattrapage: "sauter" }, -2 * 3_600_000);
    await h.balayeur.tick();
    expect(fiche(h, "veille").occurrencesFaites ?? 0).toBe(0);
    expect(h.lances).toEqual([]);
  });

  it("⚠️ un SAUT de retard (> 1 h) n'incrémente pas non plus le compteur", async () => {
    const h = harnais();
    // `rattrapage: "rattraper"` mais 2 h de retard ⇒ trop tard, sauté.
    declare(h, "veille", { occurrencesMax: 5 }, -2 * 3_600_000);
    await h.balayeur.tick();
    expect(fiche(h, "veille").occurrencesFaites ?? 0).toBe(0);
    expect(h.lances).toEqual([]);
  });

  it("le COMPTEUR est PERSISTÉ : un redémarrage le retrouve et l'échéance tient", async () => {
    const h = harnais();
    declare(h, "veille", { occurrencesMax: 3 });
    await h.balayeur.tick();
    expect(fiche(h, "veille").occurrencesFaites).toBe(1);

    // Redémarrage : un NOUVEAU store relit le même fichier.
    const relu = new SourcesStore({ path: h.path, now: h.maintenant });
    expect(relu.get("veille")?.occurrencesFaites).toBe(1);
  });
});

describe("fin de récurrence — DATE (`jusquAu`)", () => {
  it("éteint le déclencheur passé la date, avec la date en français", async () => {
    const h = harnais();
    const limite = h.maintenant() + 10 * JOUR;
    declare(h, "veille", { jusquAu: new Date(limite).toISOString() });

    // Avant la limite : le passage part.
    await h.balayeur.tick();
    expect(h.lances).toEqual(["veille"]);

    // Après la limite : plus rien, et la raison dit la date.
    h.avancer(11 * JOUR);
    await h.balayeur.tick();
    const record = fiche(h, "veille");
    expect(record.actif).toBe(false);
    expect(record.raisonInactive).toBe(raisonFinDate(limite, "Europe/Paris"));
    expect(record.raisonInactive).toContain("terminée : fin prévue le");
    expect(record.raisonInactive).toContain("2026");
    expect(h.lances).toEqual(["veille"]);
  });

  it("la raison nomme la date dans le fuseau du DÉCLENCHEUR (pas celui du processus)", () => {
    // 19 novembre 2026 à 23 h UTC = 20 novembre 00 h à Paris.
    const instant = Date.parse("2026-11-19T23:00:00Z");
    const paris = raisonFinDate(instant, "Europe/Paris");
    const utc = raisonFinDate(instant, "UTC");
    expect(paris).not.toBe(utc);
    expect(utc).toContain("novembre");
    expect(paris).toContain("novembre");
  });
});

describe("fin de récurrence — le compteur et le déclencheur", () => {
  it("`update` INVALIDE le compteur quand le déclencheur change", () => {
    const h = harnais();
    declare(h, "veille", { occurrencesMax: 10 });
    h.store.incrementerOccurrence("veille");
    h.store.incrementerOccurrence("veille");
    expect(fiche(h, "veille").occurrencesFaites).toBe(2);

    // Même expression : le compteur reste (rien n'a changé).
    h.store.update("veille", {
      declencheur: { type: "planning", expression: "0 9 * * *", fuseau: "Europe/Paris" },
    });
    expect(fiche(h, "veille").occurrencesFaites).toBe(2);

    // Expression DIFFÉRENTE : « 2/10 » décrirait l'ancien programme.
    h.store.update("veille", {
      declencheur: { type: "planning", expression: "0 8 * * *", fuseau: "Europe/Paris" },
    });
    expect(fiche(h, "veille").occurrencesFaites).toBeUndefined();
  });

  it("`null` RETIRE la fin de récurrence (l'API traduit une chaîne vide en `null`)", () => {
    const h = harnais();
    declare(h, "veille", { occurrencesMax: 4, jusquAu: "2027-01-01T00:00:00.000Z" });
    expect(fiche(h, "veille").occurrencesMax).toBe(4);
    h.store.update("veille", { occurrencesMax: null, jusquAu: null });
    expect(fiche(h, "veille").occurrencesMax).toBeUndefined();
    expect(fiche(h, "veille").jusquAu).toBeUndefined();
  });

  it("une valeur hors bornes est REFUSÉE (1 à 10 000)", () => {
    const h = harnais();
    declare(h, "veille");
    expect(() => h.store.update("veille", { occurrencesMax: 0 })).toThrow(/Fin de récurrence invalide/);
    expect(() => h.store.update("veille", { occurrencesMax: 10_001 })).toThrow(
      /Fin de récurrence invalide/,
    );
    expect(() => h.store.update("veille", { jusquAu: "pas-une-date" })).toThrow(
      /Date de fin de récurrence illisible/,
    );
  });
});
