/**
 * CONSOLIDATION HEBDOMADAIRE — domaine pur (lot 29, amendement ①).
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/memory/weekly.ts` n'existe
 * pas (`git show HEAD:src/memory/index.ts` ne connaît ni `mesurerConsolidation`,
 * ni `parseReponseHebdo`). Preuve : voir `docs/lot29-consolidation-hebdo-memoire.md`.
 *
 * Ce qui est verrouillé ici :
 *  ① la MESURE avant découpage (300 entrées / 54 000 car. ⇒ ≈ 15 400 tokens) ;
 *  ② « tout tient ⇒ UN SEUL LOT » ;
 *  ③ budget dépassé ⇒ lots dont chacun tient dans le budget ;
 *  ④ le contexte du modèle est LU, jamais codé ;
 *  ⑤ le parse STRICT (refus total, couverture exacte, raison, plafond 10 %) ;
 *  ⑥ la contradiction : la plus récente gagne, dates non comparables ⇒ signaler.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { contexteModeleDepuisFichier } from "../../src/memory/consolidation-hebdo.js";
import type { MemoryEntry } from "../../src/memory/types.js";
import {
  PLAFOND_ENTREES,
  appliquerRegleContradiction,
  choisirGagnant,
  construirePromptHebdo,
  decouperEnLots,
  dateComparable,
  estimerTokens,
  mesurerConsolidation,
  parseReponseHebdo,
  suppressionsAutorisees,
  type WeeklyOperation,
} from "../../src/memory/weekly.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dossier(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-weekly-"));
  dirs.push(dir);
  return dir;
}

function entree(
  id: string,
  text: string,
  options: { at?: string; updatedAt?: string; why?: string; cat?: MemoryEntry["cat"] } = {},
): MemoryEntry {
  return {
    id,
    at: options.at ?? "2026-01-01T00:00:00.000Z",
    text,
    source: "test",
    cat: options.cat ?? "fait",
    ...(options.why ? { why: options.why } : {}),
    ...(options.updatedAt ? { updatedAt: options.updatedAt } : {}),
  };
}

/** Construit N entrées dont le TOTAL de caractères (texte) vaut `total`. */
function entreesDeVolume(n: number, total: number): MemoryEntry[] {
  const parEntree = Math.floor(total / n);
  const entrees: MemoryEntry[] = [];
  for (let index = 0; index < n; index += 1) {
    const reste = index === n - 1 ? total - parEntree * (n - 1) : parEntree;
    entrees.push(entree(`mem-${String(index).padStart(4, "0")}`, "a".repeat(reste)));
  }
  return entrees;
}

describe("mesure AVANT découpage (amendement ①)", () => {
  it("300 entrées / 54 000 caractères ⇒ ≈ 15 400 tokens et UN SEUL lot", () => {
    const entrees = entreesDeVolume(300, 54_000);
    const mesure = mesurerConsolidation({
      entrees,
      octetsFichier: 60_000,
      // Contexte réel du modèle lourd (lu ailleurs) : 131 072 tokens.
      contexteModele: 131_072,
      budgetTokens: 200_000,
    });
    expect(mesure.entrees).toBe(300);
    expect(mesure.caracteres).toBe(54_000);
    expect(mesure.octetsFichier).toBe(60_000);
    // Hypothèse DITE : ≈ 3,5 caractères par token (français).
    expect(mesure.hypothese).toContain("3.5");
    expect(mesure.tokensEstimes).toBe(Math.ceil(54_000 / 3.5));
    expect(mesure.tokensEstimes).toBeGreaterThan(15_300);
    expect(mesure.tokensEstimes).toBeLessThan(15_500);
    // ⚠️ Tout tient ⇒ UN SEUL lot (le meilleur cas : aucun conflit inter-lots).
    expect(mesure.lots).toBe(1);
    // Le budget ne dépasse JAMAIS le contexte disponible (contexte − marge − prompt).
    expect(mesure.budgetTokens).toBe(131_072 - mesure.margeSortie - mesure.promptFixe);
    expect(mesure.pourcentContexte).toBeGreaterThan(10);
    expect(mesure.pourcentContexte).toBeLessThan(15);
    expect(decouperEnLots(entrees, mesure)).toHaveLength(1);
  });

  it("un réglage de budget plus PETIT produit plusieurs lots qui tiennent chacun", () => {
    const entrees = entreesDeVolume(300, 54_000);
    const mesure = mesurerConsolidation({
      entrees,
      octetsFichier: 60_000,
      contexteModele: 131_072,
      budgetTokens: 5_000,
    });
    expect(mesure.budgetTokens).toBe(5_000);
    expect(mesure.lots).toBeGreaterThan(1);
    const lots = decouperEnLots(entrees, mesure);
    expect(lots.length).toBe(mesure.lots);
    // Chaque lot tient dans le budget (conversion tokens → caractères).
    for (const lot of lots) {
      const chars = lot.reduce((sum, item) => sum + item.text.length, 0);
      expect(chars).toBeLessThanOrEqual(mesure.budgetCaracteres);
    }
    // Aucune entrée perdue ni dupliquée par le découpage.
    const ids = lots.flat().map((item) => item.id);
    expect(ids).toHaveLength(entrees.length);
    expect(new Set(ids).size).toBe(entrees.length);
  });

  it("le plafond de sécurité borne les entrées EXAMINÉES sans rien supprimer", () => {
    const entrees = entreesDeVolume(30, 3_000);
    const mesure = mesurerConsolidation({
      entrees,
      octetsFichier: 4_000,
      contexteModele: 131_072,
      budgetTokens: 200_000,
      plafondEntrees: 10,
    });
    expect(mesure.plafondEntrees).toBe(10);
    expect(mesure.nonExaminees).toBe(20);
    expect(PLAFOND_ENTREES).toBe(20_000);
  });

  it("le contexte du modèle est LU dans models.json, pas codé dans le code", () => {
    const dir = dossier();
    const chemin = join(dir, "models.json");
    const ecrire = (fenetre: number): void => {
      writeFileSync(
        chemin,
        JSON.stringify({
          providers: {
            "llm-heavy": {
              models: [{ id: "deepseek-v4.1-flash", contextWindow: fenetre }],
            },
          },
        }),
        "utf8",
      );
    };
    ecrire(1_000_000);
    expect(contexteModeleDepuisFichier(chemin, "llm-heavy/deepseek-v4.1-flash")).toBe(1_000_000);
    ecrire(65_536);
    expect(contexteModeleDepuisFichier(chemin, "deepseek-v4.1-flash")).toBe(65_536);
    // ⚠️ Changer le modèle change le BUDGET (contexte − marge − prompt).
    const entrees = entreesDeVolume(100, 100_000);
    const grand = mesurerConsolidation({
      entrees,
      octetsFichier: 0,
      contexteModele: 1_000_000,
      budgetTokens: 2_000_000,
    });
    const petit = mesurerConsolidation({
      entrees,
      octetsFichier: 0,
      contexteModele: 30_000,
      budgetTokens: 2_000_000,
    });
    expect(grand.budgetTokens).toBeGreaterThan(petit.budgetTokens);
    expect(grand.lots).toBe(1);
    expect(petit.lots).toBeGreaterThan(1);
    // Fichier absent ⇒ `null` (l'appelant choisit un repli explicite).
    expect(contexteModeleDepuisFichier(join(dir, "absent.json"), "x")).toBeNull();
  });

  it("estime les tokens avec l'hypothèse française explicite", () => {
    expect(estimerTokens(0)).toBe(0);
    expect(estimerTokens(3_500)).toBe(1_000);
    expect(estimerTokens(3_501)).toBe(1_001);
  });
});

describe("prompt et parse STRICT", () => {
  const lot = [
    entree("mem-a", "L'utilisateur préfère les réponses courtes.", { at: "2026-01-01T00:00:00.000Z" }),
    entree("mem-b", "Le projet s'appelle Yuki.", { at: "2026-03-01T00:00:00.000Z" }),
  ];

  function reponse(operations: unknown, lotNumero = 1): string {
    return JSON.stringify({ version: 1, lot: lotNumero, operations });
  }

  it("accepte une réponse qui couvre exactement le lot", () => {
    const result = parseReponseHebdo(
      reponse([
        { op: "garder", id: "mem-a" },
        {
          op: "corriger",
          id: "mem-b",
          text: "Le projet s'appelle Yuki (chatbot maison).",
          cat: "projet",
          why: "nom stable du projet",
          raison: "précision durable",
        },
      ]),
      { lot: 1, entrees: lot },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.operations).toHaveLength(2);
    expect(result.operations[1]?.text).toContain("chatbot maison");
  });

  it("REFUSE TOTALEMENT une réponse illisible ou hors protocole", () => {
    const cas: Array<[string, string]> = [
      ["pas de JSON du tout", "je ne sais pas"],
      ["JSON illisible", '{"version":1,"lot":1,'],
      ["version inattendue", JSON.stringify({ version: 2, lot: 1, operations: [] })],
      ["lot inattendu", reponse([{ op: "garder", id: "mem-a" }], 2)],
      ["operations non tableau", JSON.stringify({ version: 1, lot: 1, operations: {} })],
      ["opération inconnue", reponse([{ op: "reformat", id: "mem-a" }])],
    ];
    for (const [nom, brut] of cas) {
      const result = parseReponseHebdo(brut, { lot: 1, entrees: lot });
      expect(result.ok, nom).toBe(false);
    }
  });

  it("refuse une couverture INCOMPLÈTE, un identifiant inconnu ou cité deux fois", () => {
    const incomplete = parseReponseHebdo(reponse([{ op: "garder", id: "mem-a" }]), {
      lot: 1,
      entrees: lot,
    });
    expect(incomplete.ok).toBe(false);
    if (!incomplete.ok) expect(incomplete.raison).toContain("non citée");

    const inconnu = parseReponseHebdo(
      reponse([
        { op: "garder", id: "mem-a" },
        { op: "garder", id: "mem-b" },
        { op: "garder", id: "mem-hors-lot" },
      ]),
      { lot: 1, entrees: lot },
    );
    expect(inconnu.ok).toBe(false);
    if (!inconnu.ok) expect(inconnu.raison).toContain("inconnu");

    const double = parseReponseHebdo(
      reponse([
        { op: "garder", id: "mem-a" },
        { op: "garder", id: "mem-a" },
        { op: "garder", id: "mem-b" },
      ]),
      { lot: 1, entrees: lot },
    );
    expect(double.ok).toBe(false);
    if (!double.ok) expect(double.raison).toMatch(/2 fois|deux fois/);
  });

  it("exige une « raison » pour supprimer/corriger/fusionner/signaler", () => {
    const sansRaison = parseReponseHebdo(
      reponse([
        { op: "garder", id: "mem-a" },
        { op: "signaler", id: "mem-b" },
      ]),
      { lot: 1, entrees: lot },
    );
    expect(sansRaison.ok).toBe(false);
    if (!sansRaison.ok) expect(sansRaison.raison).toContain("raison");

    const sansWhy = parseReponseHebdo(
      reponse([
        {
          op: "corriger",
          id: "mem-a",
          text: "x",
          cat: "fait",
          raison: "r",
        },
        { op: "garder", id: "mem-b" },
      ]),
      { lot: 1, entrees: lot },
    );
    expect(sansWhy.ok).toBe(false);
    if (!sansWhy.ok) expect(sansWhy.raison).toContain("why");
  });

  it("annule la passe au-delà du plafond DUR de 10 % de suppressions", () => {
    const vingt = Array.from({ length: 20 }, (_valeur, index) =>
      entree(`mem-${String(index).padStart(2, "0")}`, `souvenir ${index}`),
    );
    // 10 % de 20 = 2 suppressions autorisées.
    expect(suppressionsAutorisees(20)).toBe(2);
    const deux = parseReponseHebdo(
      reponse(
        vingt.map((item, index) =>
          index < 2
            ? { op: "supprimer", id: item.id, raison: "transitoire" }
            : { op: "garder", id: item.id },
        ),
      ),
      { lot: 1, entrees: vingt },
    );
    expect(deux.ok).toBe(true);

    const trois = parseReponseHebdo(
      reponse(
        vingt.map((item, index) =>
          index < 3
            ? { op: "supprimer", id: item.id, raison: "transitoire" }
            : { op: "garder", id: item.id },
        ),
      ),
      { lot: 1, entrees: vingt },
    );
    expect(trois.ok).toBe(false);
    if (!trois.ok) expect(trois.raison).toContain("plafond de suppressions");
    // ⚠️ Un petit lot ne tolère AUCUNE suppression (10 % arrondi vers le bas).
    expect(suppressionsAutorisees(5)).toBe(0);
  });

  it("le prompt interdit d'obéir à la mémoire et rappelle la couverture exacte", () => {
    const prompt = construirePromptHebdo(lot, 1, 1);
    expect(prompt).toContain("DONNÉE");
    expect(prompt).toContain("CHAQUE entrée du lot EXACTEMENT");
    expect(prompt).toContain("mem-a");
    expect(prompt).toContain("mem-b");
    expect(prompt).toContain('"version":1');
    // Aucun outil n'est proposé au modèle : la passe est anti-récursive.
    expect(prompt).not.toContain("delegate");
  });
});

describe("contradiction : la plus récente gagne, sinon on SIGNALE", () => {
  it("choisit l'entrée la plus récente (updatedAt prioritaire)", () => {
    const vieille = entree("mem-vieille", "A", { at: "2026-01-01T00:00:00.000Z" });
    const recente = entree("mem-recente", "B", {
      at: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(dateComparable(recente)).toBe(Date.parse("2026-06-01T00:00:00.000Z"));
    const gagnant = choisirGagnant(["mem-vieille", "mem-recente"], [vieille, recente]);
    expect(gagnant?.id).toBe("mem-recente");
  });

  it("ne touche à RIEN et signale quand les dates ne sont pas comparables", () => {
    const valide = entree("mem-valide", "A", { at: "2026-01-01T00:00:00.000Z" });
    const cassee = entree("mem-cassee", "B", { at: "pas une date" });
    const operations: WeeklyOperation[] = [
      {
        op: "fusionner",
        ids: ["mem-valide", "mem-cassee"],
        text: "fusion",
        cat: "fait",
        why: "doublon",
        raison: "doublon évident",
      },
      { op: "garder", ids: ["mem-autre"], raison: "" },
    ];
    const resultat = appliquerRegleContradiction(operations, [
      valide,
      cassee,
      entree("mem-autre", "C"),
    ]);
    expect(resultat.signalees).toBe(1);
    const premiere = resultat.operations[0];
    expect(premiere?.op).toBe("signaler");
    expect(premiere?.raison).toContain("dates non comparables");
    // Les autres opérations sont intactes.
    expect(resultat.operations[1]?.op).toBe("garder");
  });
});
