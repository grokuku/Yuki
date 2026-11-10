/**
 * PROFILS DE CAPACITÉS — LA GARDE STRUCTURELLE DU WORKER LOURD (lot 35f).
 *
 * ⚠️ Ce que ce fichier prouve : `profil !== "complet"` ⇒ la FABRIQUE du worker
 * lourd n'est JAMAIS appelée (espion). Un bot `lecture`/`accueil` n'a donc aucun
 * `run_command`, même par un job importé ou une tâche planifiée : le worker qui
 * l'exécuterait n'existe pas.
 *
 * ⚠️ La garde est isolée dans `src/bots/profils.ts` parce que `src/index.ts`
 * (point de composition) exécute `main()` au chargement et ne peut pas être
 * importé par un test. Le câblage réel est verrouillé par le test de SOURCE en
 * fin de fichier : le seul appel de `createSdkHeavyWorker` y est l'argument de
 * `construireWorkerLourdSiAutorise`.
 *
 * ⚠️ Sur l'origine, `workerLourdAutorise`/`construireWorkerLourdSiAutorise`
 * n'existent pas ⇒ ce fichier échoue (import impossible). C'est la preuve.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  construireWorkerLourdSiAutorise,
  workerLourdAutorise,
} from "../../src/bots/profils.js";
import { PROFILS_BOT } from "../../src/bots/registry.js";

describe("35f ③ — `profil !== complet` ⇒ le worker lourd n'est PAS instancié", () => {
  it("`workerLourdAutorise` : seul `complet` (et l'absence de profil) autorise", () => {
    expect(workerLourdAutorise("complet")).toBe(true);
    expect(workerLourdAutorise("lecture")).toBe(false);
    expect(workerLourdAutorise("accueil")).toBe(false);
    // Mono-bot historique (aucun registre) : comportement d'avant.
    expect(workerLourdAutorise(undefined)).toBe(true);
  });

  it("aucun autre profil n'ouvre le worker (table exhaustive des profils connus)", () => {
    const ouverts = PROFILS_BOT.filter((profil) => workerLourdAutorise(profil));
    expect(ouverts).toEqual(["complet"]);
  });

  describe("espion sur la fabrique", () => {
    // ⚠️ Typé `() => …` : `construireWorkerLourdSiAutorise` attend une FABRIQUE
    // (aucun argument), pas un mock générique.
    let fabrique: ReturnType<typeof vi.fn<() => { worker: boolean }>>;

    beforeEach(() => {
      fabrique = vi.fn<() => { worker: boolean }>(() => ({ worker: true }));
    });

    it("`lecture` : la fabrique n'est JAMAIS appelée (aucun worker construit)", () => {
      const worker = construireWorkerLourdSiAutorise("lecture", fabrique);
      expect(worker).toBeUndefined();
      expect(fabrique).not.toHaveBeenCalled();
    });

    it("`accueil` : la fabrique n'est JAMAIS appelée", () => {
      const worker = construireWorkerLourdSiAutorise("accueil", fabrique);
      expect(worker).toBeUndefined();
      expect(fabrique).not.toHaveBeenCalled();
    });

    it("`complet` : la fabrique est appelée UNE fois, et son résultat est rendu", () => {
      const worker = construireWorkerLourdSiAutorise("complet", fabrique);
      expect(fabrique).toHaveBeenCalledTimes(1);
      expect(worker).toEqual({ worker: true });
    });

    it("profil absent (mono-bot historique) : la fabrique est appelée (non-régression)", () => {
      const worker = construireWorkerLourdSiAutorise(undefined, fabrique);
      expect(fabrique).toHaveBeenCalledTimes(1);
      expect(worker).toEqual({ worker: true });
    });

    it("une valeur inconnue ne construit RIEN (fail-closed)", () => {
      const worker = construireWorkerLourdSiAutorise(
        "administrateur" as unknown as Parameters<typeof workerLourdAutorise>[0],
        fabrique,
      );
      expect(worker).toBeUndefined();
      expect(fabrique).not.toHaveBeenCalled();
    });
  });
});

describe("35f ③ — le câblage réel passe bien par la garde (test de source)", () => {
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
      /construireWorkerLourdSiAutorise\(profilBot, \(\) =>\s*\n\s*createSdkHeavyWorker\(/,
    );
  });

  it("le profil vient du BOT ACTIF du registre, jamais d'une requête", () => {
    // ⚠️ Une seule dérivation, à partir du registre lu au démarrage.
    expect(corps).toMatch(/const profilBot: ProfilBot = bots\.bot\?\.profil \?\? "complet"/);
    // ⚠️ Aucune lecture de profil depuis un corps/une requête/un message.
    expect(corps).not.toMatch(/profil\s*[:=]\s*(?:corps|body|query|req)\b/);
    expect(corps).not.toMatch(/(?:corps|body|query|req)\.[A-Za-z]*profil/);
  });

  it("la délégation n'est construite que si le worker existe", () => {
    expect(corps).toMatch(/if \(heavyWorker !== undefined\) \{\s*\n\s*delegation = createDelegationService\(/);
  });
});
