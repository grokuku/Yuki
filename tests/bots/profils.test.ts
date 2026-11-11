/**
 * LA GARDE STRUCTURELLE DU WORKER LOURD (lot 35h, ex-`profils.test.ts`).
 *
 * ⚠️ Ce que ce fichier prouve : sans capacité `execution` NI `delegation`, la
 * FABRIQUE du worker lourd n'est JAMAIS appelée (espion). Un bot neuf
 * (`capacites: []`) n'a donc aucun `run_command`, même par un job importé ou une
 * tâche planifiée : le worker qui l'exécuterait n'existe pas.
 *
 * ⚠️ La garde est isolée dans `src/bots/profils.ts` parce que `src/index.ts`
 * (point de composition) exécute `main()` au chargement et ne peut pas être
 * importé par un test. Le câblage réel est verrouillé par le test de SOURCE en
 * fin de fichier : le seul appel de `createSdkHeavyWorker` y est l'argument de
 * `construireWorkerLourdSiAutorise`.
 *
 * ⚠️ RÉÉCRITURE (pas suppression) : le fichier du lot 35f testait
 * `profil !== "complet"` ; le concept de profil a disparu (décision utilisateur
 * du 2026-11-10), les gardes portent maintenant sur les CAPACITÉS.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CAPACITES_WORKER_LOURD,
  construireWorkerLourdSiAutorise,
  workerLourdAutorise,
} from "../../src/bots/profils.js";
import { CAPACITES_BOT, type CapaciteBot } from "../../src/bots/registry.js";

describe("35h ③ — sans `execution` ni `delegation`, le worker lourd n'est PAS instancié", () => {
  it("`workerLourdAutorise` : seules `execution` et `delegation` ouvrent le worker", () => {
    expect(workerLourdAutorise(["execution"])).toBe(true);
    expect(workerLourdAutorise(["delegation"])).toBe(true);
    expect(workerLourdAutorise(["execution", "delegation"])).toBe(true);
    // ⚠️ LE cas du lot : un bot neuf n'a AUCUNE capacité.
    expect(workerLourdAutorise([])).toBe(false);
    // Mono-bot historique (aucun bot en jeu) : comportement d'avant.
    expect(workerLourdAutorise(undefined)).toBe(true);
    // Toutes les capacités (bot hérité) : le worker existe.
    expect(workerLourdAutorise([...CAPACITES_BOT])).toBe(true);
  });

  it("EXACTEMENT deux capacités ouvrent le worker (table exhaustive)", () => {
    const ouvertes = CAPACITES_BOT.filter((capacite) => workerLourdAutorise([capacite]));
    expect(ouvertes).toEqual(["execution", "delegation"]);
    expect([...CAPACITES_WORKER_LOURD]).toEqual(["execution", "delegation"]);
  });

  it("toute autre capacité seule ne construit RIEN", () => {
    const autres = CAPACITES_BOT.filter(
      (capacite) => !(CAPACITES_WORKER_LOURD as readonly string[]).includes(capacite),
    );
    for (const capacite of autres) {
      expect(workerLourdAutorise([capacite]), capacite).toBe(false);
    }
  });

  describe("espion sur la fabrique", () => {
    // ⚠️ Typé `() => …` : `construireWorkerLourdSiAutorise` attend une FABRIQUE
    // (aucun argument), pas un mock générique.
    let fabrique: ReturnType<typeof vi.fn<() => { worker: boolean }>>;

    beforeEach(() => {
      fabrique = vi.fn<() => { worker: boolean }>(() => ({ worker: true }));
    });

    it("`capacites: []` (bot neuf) : la fabrique n'est JAMAIS appelée", () => {
      const worker = construireWorkerLourdSiAutorise([], fabrique);
      expect(worker).toBeUndefined();
      expect(fabrique).not.toHaveBeenCalled();
    });

    it("`agents` seul : la fabrique n'est JAMAIS appelée", () => {
      const worker = construireWorkerLourdSiAutorise(["agents"], fabrique);
      expect(worker).toBeUndefined();
      expect(fabrique).not.toHaveBeenCalled();
    });

    it("`execution` : la fabrique est appelée UNE fois, et son résultat est rendu", () => {
      const worker = construireWorkerLourdSiAutorise(["execution"], fabrique);
      expect(fabrique).toHaveBeenCalledTimes(1);
      expect(worker).toEqual({ worker: true });
    });

    it("`delegation` : la fabrique est appelée UNE fois", () => {
      const worker = construireWorkerLourdSiAutorise(["delegation"], fabrique);
      expect(fabrique).toHaveBeenCalledTimes(1);
      expect(worker).toEqual({ worker: true });
    });

    it("capacités absentes (mono-bot historique) : la fabrique est appelée", () => {
      const worker = construireWorkerLourdSiAutorise(undefined, fabrique);
      expect(fabrique).toHaveBeenCalledTimes(1);
      expect(worker).toEqual({ worker: true });
    });

    it("une valeur inconnue ne construit RIEN (fail-closed)", () => {
      const worker = construireWorkerLourdSiAutorise(
        ["administrateur"] as unknown as CapaciteBot[],
        fabrique,
      );
      expect(worker).toBeUndefined();
      expect(fabrique).not.toHaveBeenCalled();
    });
  });
});

describe("35h ③ — le câblage réel passe bien par la garde (test de source)", () => {
  const source = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");
  /** Source sans la ligne d'import (qui nomme la fabrique sans l'appeler). */
  const corps = source
    .split("\n")
    .filter((ligne) => !ligne.trimStart().startsWith("import "))
    .join("\n");

  it("`createSdkHeavyWorker` n'est appelé qu'UNE fois, dans `construireWorkerLourdSiAutorise`", () => {
    const occurrences = corps.match(/createSdkHeavyWorker\(/g) ?? [];
    expect(occurrences).toHaveLength(1);
    // ⚠️ L'appel est l'ARGUMENT de la garde : si quelqu'un l'extrayait (ou le
    // déplaçait avant la garde), cette assertion tombe.
    expect(corps).toMatch(
      /construireWorkerLourdSiAutorise\(capacitesBot, \(\) =>\s*\n\s*createSdkHeavyWorker\(/,
    );
  });

  it("les capacités viennent du BOT du registre, jamais d'une requête", () => {
    // ⚠️ Une seule dérivation, à partir du registre lu au démarrage.
    expect(corps).toMatch(
      /const capacitesBot: readonly CapaciteBot\[\] = bots\.bot\?\.capacites \?\? CAPACITES_BOT/,
    );
    // ⚠️ Aucune lecture de capacités depuis un corps/une requête/un message.
    expect(corps).not.toMatch(/capacites\s*[:=]\s*(?:corps|body|query|req)\b/);
    expect(corps).not.toMatch(/(?:corps|body|query|req)\.[A-Za-z]*capacites/);
  });

  it("la délégation n'est construite que si le worker existe", () => {
    expect(corps).toMatch(
      /if \(heavyWorker !== undefined\) \{\s*\n\s*delegation = createDelegationService\(/,
    );
  });
});
