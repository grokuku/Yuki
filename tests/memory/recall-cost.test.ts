/**
 * Coût du RAPPEL mémoire (`MemoryPort.recall`) — MESURÉ, pas supposé.
 *
 * Le rappel est dans le chemin BLOQUANT du run : `before_agent_start` l'attend
 * (`src/pi/sdk/memory-extension.ts`) et il est COMPTÉ dans le TTFT. Ce test
 * peuple un store réaliste, laisse l'index se construire, puis mesure le coût
 * du rappel en RÉGIME ÉTABLI (index ouvert, comme dans une conversation qui
 * dure).
 *
 * ⚠️ CE TEST MESURE DEUX CHOSES DIFFÉRENTES, ET LES MESURE DIFFÉREMMENT.
 *
 *  ① COÛT STRUCTUREL — INVARIANT, insensible à la charge de la machine :
 *    combien de requêtes FTS par rappel, combien d'entrées sont lues dans le
 *    store, si le store est parcouru en entier, combien d'entrées / de
 *    caractères sortent du rappel. Ces compteurs sont des ENTIERS EXACTS :
 *    une régression (scan complet au lieu de l'index, top-k ignoré, budget
 *    ignoré, N+1 requêtes) les fait varier, quelle que soit la machine.
 *
 *  ② COÛT TEMPOREL — DÉPEND DE LA MACHINE, donc jugé ROBUSTEMENT :
 *    on mesure `recall.durationMs` (déjà mesuré par le service) sur des
 *    recherches répétées en régime établi. Le coût INTRINSÈQUE est jugé sur la
 *    MÉDIANE (< 150 ms), pas sur le maximum : le maximum d'un intervalle de
 *    temps est un estimateur de la CHARGE, pas du rappel (mesuré sur cette
 *    machine avec 3 `npm test` en parallèle : rappel ≈ 1 ms, mais un
 *    échantillon isolé retardé de plusieurs dizaines de ms par l'ordonnanceur).
 *    Le PLAFOND CONFIGURÉ (400 ms) reste ASSERTÉ, sur p90 ET sur le maximum :
 *    marge mesurée sous charge (5 suites en parallèle + 24 occupations CPU,
 *    load average 86) ⇒ médiane 0–8 ms, p90 1–50 ms, max 71 ms.
 *
 * ⚠️ DÉMARRAGE À FROID, mesuré À PART (jamais mélangé au régime établi) :
 * `MemoryService.start()` construit l'index en tâche de fond (ouverture du
 * fichier SQLite + reconstruction transactionnelle des 500 entrées ⇒ I/O
 * disque). Ce travail est NON BLOQUANT et arrive, par construction, dans la
 * fenêtre mesurée du PREMIER rappel (le service mesure à partir de l'entrée de
 * `recall`, avant d'attendre l'index). Sa durée dépend du disque : il n'est donc
 * borné que par une marge GÉNÉREUSE, et ne sert jamais de mesure du TTFT.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MemoryIndex,
  MemoryService,
  MemoryStore,
  type MemoryBounds,
} from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

/** Plafond configuré du rappel (`memory.recall.timeoutMs`, défaut projet). */
const RECALL_TIMEOUT_MS = 400;
/** « Très en deçà du plafond » : borne du coût INTRINSÈQUE (médiane). */
const STEADY_STATE_CEILING_MS = 150;
/** Bornes réelles du rappel (inchangées). */
const TOP_K = 5;
const BUDGET_CHARS = 8000;
/** Taille du store de référence (plusieurs centaines de souvenirs). */
const SEEDED_ENTRIES = 500;
/** Nombre de rappels mesurés. */
const SAMPLES = 20;
/** Budget GÉNÉREUX du démarrage à froid — hors chemin du TTFT (I/O disque). */
const COLD_START_BUDGET_MS = 30_000;
/** Requête de référence : deux sujets présents dans le store. */
const QUERY = "crêpes bretonnes Rennes";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function logger() {
  return createLogger({ level: "error", sink: () => undefined, secretValues: [] });
}

/**
 * Index COMPTEUR : étend l'index réel (aucun code de production modifié) pour
 * compter les requêtes FTS réellement exécutées et les identifiants rendus.
 */
class CountingIndex extends MemoryIndex {
  searches = 0;
  rows = 0;

  override search(query: string, topK: number): string[] {
    this.searches += 1;
    const ids = super.search(query, topK);
    this.rows += ids.length;
    return ids;
  }

  resetCounters(): void {
    this.searches = 0;
    this.rows = 0;
  }
}

/** Statistiques d'un échantillon : moyenne, médiane, p90, maximum (ms). */
function stats(samples: readonly number[]): {
  avg: number;
  median: number;
  p90: number;
  max: number;
} {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return {
    avg: samples.reduce((a, b) => a + b, 0) / samples.length,
    median: at(0.5),
    p90: at(0.9),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

/**
 * Attend que l'index soit OUVERT et COMPLET (même signal que `ensureIndex` :
 * autant de documents indexés que d'entrées dans le store). Sondage : il n'y a
 * pas d'API publique de disponibilité, et le rappel lui-même est borné par
 * `timeoutMs` (il rend une réponse sans mémoire tant que l'index n'est pas prêt).
 */
async function waitIndexReady(
  index: MemoryIndex,
  expected: number,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (index.isAvailable() && index.count() === expected) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return index.isAvailable() && index.count() === expected;
}

describe("coût du rappel mémoire (chemin bloquant du TTFT)", () => {
  it("reste très en deçà du plafond de 400 ms sur un store peuplé", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-memory-recall-"));
    tempDirs.push(dir);
    const store = MemoryStore.open({ path: join(dir, "memory.jsonl"), logger: logger() });
    const index = new CountingIndex({
      path: join(dir, "memory-index.sqlite"),
      logger: logger(),
    });
    // Compteurs STRUCTURELS côté store : lectures par identifiant (`get`) et
    // parcours complet (`entries`, qui recopie toute la projection en mémoire).
    const getSpy = vi.spyOn(store, "get");
    const entriesSpy = vi.spyOn(store, "entries", "get");

    // Store réaliste : plusieurs centaines de souvenirs, sujets variés.
    const subjects = [
      "crêpes bretonnes",
      "Rennes",
      "clavier mécanique",
      "vacances en Bretagne",
      "TypeScript",
      "café le matin",
      "vélo électrique",
      "jardinage",
    ];
    for (let i = 0; i < SEEDED_ENTRIES; i += 1) {
      store.add({
        text: `L'utilisateur parle de ${subjects[i % subjects.length]} (n°${i})`,
        cat: "autre",
        source: `seed-${i}`,
      });
    }

    const bounds: MemoryBounds = {
      topK: TOP_K,
      budgetChars: BUDGET_CHARS,
      timeoutMs: RECALL_TIMEOUT_MS,
    };
    const service = new MemoryService({
      store,
      index,
      logger: logger(),
      enabled: () => true,
      bounds: () => bounds,
    });

    const coldStart = performance.now();
    service.start();
    try {
      // --- Démarrage à froid : mesuré À PART, borne GÉNÉREUSE (I/O disque). ----
      const ready = await waitIndexReady(index, store.size, COLD_START_BUDGET_MS);
      const coldMs = performance.now() - coldStart;
      expect(ready, "l'index doit finir ouvert ET complet").toBe(true);
      expect(index.count()).toBe(SEEDED_ENTRIES);

      // Rappel « à blanc », HORS mesure : garantit que la promesse de départ est
      // résolue (aucune mesure suivante n'inclut la construction de l'index).
      const warmup = await service.recall(QUERY);
      expect(warmup.enabled).toBe(true);
      expect(warmup.block).not.toBeNull();

      // --- Régime établi : on repart de compteurs à zéro. --------------------
      index.resetCounters();
      getSpy.mockClear();
      entriesSpy.mockClear();

      const samples: number[] = [];
      // Même mesure, mais à l'horloge fine (`Date.now` est en ms entières) :
      // sert à RAPPORTER le coût intrinsèque réel (sous la milliseconde).
      const elapsed: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const tick = performance.now();
        const result = await service.recall(QUERY);
        elapsed.push(performance.now() - tick);
        samples.push(result.durationMs);
        expect(result.enabled).toBe(true);
        // Un rappel « bon marché » qui ne trouve plus rien ne prouve RIEN : le
        // résultat doit rester PERTINENT et BORNÉ.
        expect(result.entries).toBe(TOP_K);
        expect(result.chars).toBeLessThanOrEqual(BUDGET_CHARS);
        expect(result.block).toContain("crêpes bretonnes");
      }

      // --- ① Coût STRUCTUREL : invariants EXACTS, insensibles à la charge. ---
      const steadySearches = index.searches;
      const steadyRows = index.rows;
      const steadyLookups = getSpy.mock.calls.length;
      const steadyScans = entriesSpy.mock.calls.length;
      // Une seule requête FTS par rappel (jamais de N+1, jamais de scan).
      expect(steadySearches).toBe(SAMPLES);
      // Au plus `topK` identifiants par requête : c'est la borne dure du rappel.
      expect(steadyRows).toBeLessThanOrEqual(SAMPLES * TOP_K);
      // Au plus `topK` lectures dans le store par rappel (lecture par id).
      expect(steadyLookups).toBeLessThanOrEqual(SAMPLES * TOP_K);
      // AUCUN parcours complet du store : le rappel ne scanne jamais la mémoire.
      expect(steadyScans).toBe(0);

      // Chemin « aucun résultat » : un aller-retour FTS, ZÉRO lecture du store.
      index.resetCounters();
      getSpy.mockClear();
      entriesSpy.mockClear();
      const miss = await service.recall("zorglub introuvable");
      expect(miss.block).toBeNull();
      expect(miss.entries).toBe(0);
      expect(index.searches).toBe(1);
      expect(getSpy.mock.calls.length).toBe(0);
      expect(entriesSpy.mock.calls.length).toBe(0);

      // --- ② Coût TEMPOREL : statistique ROBUSTE + plafond configuré. --------
      const measured = stats(samples);
      const fine = stats(elapsed);
      console.log(
        `[recall] régime établi n=${SAMPLES} médiane=${measured.median}ms ` +
          `p90=${measured.p90}ms max=${measured.max}ms avg=${measured.avg.toFixed(1)}ms ` +
          `| horloge fine : médiane=${fine.median.toFixed(2)}ms avg=${fine.avg.toFixed(2)}ms ` +
          `(plafond configuré ${RECALL_TIMEOUT_MS}ms) | démarrage à froid=${coldMs.toFixed(0)}ms ` +
          `| structure : ${steadySearches} requête(s) FTS, ${steadyLookups} lecture(s) store ` +
          `(≤ ${SAMPLES * TOP_K}), ${steadyScans} parcours complet`,
      );

      // Le coût INTRINSÈQUE du rappel (médiane) doit rester très en deçà du
      // plafond : c'est la part que le rappel ajoute au TTFT en régime établi.
      // Une VRAIE régression (index abandonné, budget ignoré) déplace TOUTES les
      // mesures, donc la médiane aussi ; un aléa d'ordonnanceur, non.
      expect(measured.median).toBeLessThan(STEADY_STATE_CEILING_MS);
      // Et le plafond configuré reste une borne dure de ce qui est observé.
      expect(measured.p90).toBeLessThan(RECALL_TIMEOUT_MS);
      expect(measured.max).toBeLessThan(RECALL_TIMEOUT_MS);
    } finally {
      service.close();
    }
  });
});
