/**
 * LOT 35j — UN SEUL BALAYEUR POUR TOUS LES BOTS (`BalayeurBots`).
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `BalayeurBots`, `CibleBalayage`
 * et `BalayeurBotsPort` n'existent pas (`src/sources/scheduler.ts` ne connaît que
 * `DeclencheurBalayeur`, lié à UN `store` et à UN `run`).
 *
 * Ce qui est VERROUILLÉ ici :
 *  ① UN SEUL `setInterval` dans tout le processus, quel que soit le nombre de
 *    bots (pas N minuteurs : un par bot) ;
 *  ② chaque bot a son `DeclencheurBalayeur` INTERNE, dont `start()` n'est JAMAIS
 *    appelé — seul `tick()` l'est, par l'horloge unique ;
 *  ③ un bot en erreur ne prive pas les autres de leur tick ;
 *  ④ un bot RETIRÉ (désactivé, supprimé, sans capacité) perd son balayeur interne
 *    et n'est plus balayé ;
 *  ⑤ les rendez-vous d'INSTANCE (consolidation hebdomadaire, rétention des
 *    archives) tournent UNE fois par tick, jamais une fois par bot.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BalayeurBots,
  type BalayeurStore,
  type CibleBalayage,
} from "../../src/sources/scheduler.js";
import { SourcesStore } from "../../src/sources/store.js";
import type { DeclenchementResult } from "../../src/sources/service.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const MAINTENANT = Date.parse("2026-06-01T06:10:00Z");

/** Un bot balayable : SON store, SON `run` (qui note les tirs), et c'est tout. */
interface BotBalayable {
  botId: string;
  store: SourcesStore;
  tirs: string[];
  cible: CibleBalayage;
}

function botBalayable(botId: string): BotBalayable {
  const dir = mkdtempSync(join(tmpdir(), `yuki-balayeur-${botId}-`));
  dirs.push(dir);
  const store = new SourcesStore({ path: join(dir, "sources.json") });
  store.create("tache", {
    visibilite: "silencieux",
    declencheur: { type: "planning", expression: "0 8 * * *", fuseau: "Europe/Paris" },
  } as never);
  // Passage DÉJÀ dépassé : le premier tick doit le traiter (règle de rattrapage).
  store.markPlanification("tache", { prochainPassage: "2026-06-01T06:00:00.000Z" });
  const tirs: string[] = [];
  return {
    botId,
    store,
    tirs,
    cible: {
      botId,
      store: store as unknown as BalayeurStore,
      run: async (nom: string): Promise<DeclenchementResult> => {
        tirs.push(`${botId}:${nom}`);
        return {
          outcome: "started",
          runId: `job-${botId}`,
          fin: Promise.resolve({ outcome: "ok" } as never),
        };
      },
    },
  };
}

/** Compteur de minuteurs : `setInterval`/`clearInterval` INJECTÉS (aucun réel). */
function horlogeFactice() {
  const intervalles: Array<() => void> = [];
  const delais: number[] = [];
  let effaces = 0;
  return {
    intervalles,
    delais,
    get effaces() {
      return effaces;
    },
    setInterval: (callback: () => void, delayMs: number) => {
      intervalles.push(callback);
      delais.push(delayMs);
      return { id: intervalles.length };
    },
    clearInterval: () => {
      effaces += 1;
    },
  };
}

function balayeur(
  cibles: () => readonly CibleBalayage[],
  options: {
    horloge?: ReturnType<typeof horlogeFactice>;
    passeHebdo?: { executerSiDu: (maintenant: number) => Promise<void> };
    archivesBots?: { purger: (maintenant: number) => number | Promise<number> };
  } = {},
): { balayeur: BalayeurBots; horloge: ReturnType<typeof horlogeFactice> } {
  const horloge = options.horloge ?? horlogeFactice();
  const instance = new BalayeurBots({
    bots: { cibles },
    logger,
    now: () => MAINTENANT,
    setInterval: horloge.setInterval,
    clearInterval: horloge.clearInterval,
    ...(options.passeHebdo ? { passeHebdo: options.passeHebdo } : {}),
    ...(options.archivesBots ? { archivesBots: options.archivesBots } : {}),
  });
  return { balayeur: instance, horloge };
}

// ── ① UN SEUL `setInterval` ────────────────────────────────────────────────

describe("un SEUL minuteur pour N bots (lot 35j)", () => {
  it("`start()` pose UN intervalle, même avec cinq bots", () => {
    const bots = ["yuki", "a", "b", "c", "d"].map(botBalayable);
    const { balayeur: instance, horloge } = balayeur(() => bots.map((bot) => bot.cible));

    instance.start();

    // ⚠️ LE point du lot : pas N minuteurs, UN seul.
    expect(horloge.intervalles).toHaveLength(1);
    expect(horloge.delais).toEqual([30_000]);
  });

  it("`start()` est idempotent : un second appel ne pose PAS un second intervalle", () => {
    const bot = botBalayable("yuki");
    const { balayeur: instance, horloge } = balayeur(() => [bot.cible]);

    instance.start();
    instance.start();
    instance.start();

    expect(horloge.intervalles).toHaveLength(1);
  });

  it("UN tick balaye CHAQUE bot, une seule fois (le minuteur unique suffit)", async () => {
    const yuki = botBalayable("yuki");
    const second = botBalayable("second");
    const { balayeur: instance } = balayeur(() => [yuki.cible, second.cible]);

    await instance.tick();

    expect(yuki.tirs).toEqual(["yuki:tache"]);
    expect(second.tirs).toEqual(["second:tache"]);
    // Deux ticks ne doublent pas les passages (réarmement persisté).
    await instance.tick();
    expect(yuki.tirs).toEqual(["yuki:tache"]);
    expect(instance.ciblesConnues).toBe(2);
  });

  it("`stop()` rend l'intervalle et arrête les balayeurs internes", async () => {
    const bot = botBalayable("yuki");
    const { balayeur: instance, horloge } = balayeur(() => [bot.cible]);
    instance.start();
    await instance.tick();
    expect(instance.ciblesConnues).toBe(1);

    instance.stop();

    expect(horloge.effaces).toBe(1);
    expect(instance.ciblesConnues).toBe(0);
    // Après l'arrêt, un tick ne fait plus rien (l'intervalle a été effacé).
    await instance.tick();
    expect(bot.tirs).toEqual(["yuki:tache"]);
  });

  it("le balayeur interne d'un bot n'est JAMAIS démarré (aucun minuteur par bot)", async () => {
    const espion = vi.spyOn(globalThis, "setInterval");
    try {
      const bots = [botBalayable("yuki"), botBalayable("second")];
      // ⚠️ Aucun `setInterval` n'est injecté ici : c'est le VRAI qui serait posé.
      const instance = new BalayeurBots({
        bots: { cibles: () => bots.map((bot) => bot.cible) },
        logger,
        now: () => MAINTENANT,
      });
      instance.start();
      await instance.tick();
      // 1 seul appel pour l'horloge du balayeur, 0 pour un hypothétique minuteur
      // par bot (deux bots balayés ⇒ toujours 1).
      expect(espion).toHaveBeenCalledTimes(1);
      instance.stop();
    } finally {
      espion.mockRestore();
    }
  });
});

// ── ② ④ Périmètre des bots balayés ─────────────────────────────────────────

describe("périmètre des bots balayés (lot 35j)", () => {
  it("un bot qui N'EST PLUS dans les cibles n'est plus balayé (ni gardé en mémoire)", async () => {
    const yuki = botBalayable("yuki");
    const second = botBalayable("second");
    let liste: CibleBalayage[] = [yuki.cible, second.cible];
    const { balayeur: instance } = balayeur(() => liste);

    await instance.tick();
    expect(second.tirs).toEqual(["second:tache"]);
    expect(instance.ciblesConnues).toBe(2);

    // Le bot est désactivé (ou supprimé, ou sans capacité) : il sort des cibles.
    liste = [yuki.cible];
    // On réarme pour prouver que l'absence de tir vient bien du périmètre.
    second.store.markPlanification("tache", { prochainPassage: "2026-06-01T06:00:00.000Z" });
    await instance.tick();

    expect(second.tirs).toEqual(["second:tache"]);
    expect(instance.ciblesConnues).toBe(1);
  });

  it("un bot en ERREUR ne prive pas les autres de leur tick", async () => {
    const yuki = botBalayable("yuki");
    const casse = botBalayable("casse");
    const cibleCasse: CibleBalayage = {
      ...casse.cible,
      store: {
        list: () => {
          throw new Error("store illisible");
        },
        get: () => undefined,
        markPlanification: () => undefined,
        update: () => undefined,
      } as unknown as BalayeurStore,
    };
    const { balayeur: instance } = balayeur(() => [cibleCasse, yuki.cible]);

    await instance.tick();

    expect(yuki.tirs).toEqual(["yuki:tache"]);
  });

  it("un port de cibles en ERREUR rend un tick vide, sans lever", async () => {
    const { balayeur: instance } = balayeur(() => {
      throw new Error("registre illisible");
    });
    await expect(instance.tick()).resolves.toBeUndefined();
  });
});

// ── ⑤ Les rendez-vous d'INSTANCE : une fois par tick, pas par bot ─────────

describe("rendez-vous d'instance (lot 35j)", () => {
  it("la consolidation hebdomadaire et la purge des archives tournent UNE fois par tick", async () => {
    const bots = [botBalayable("yuki"), botBalayable("second"), botBalayable("troisieme")];
    const passe = { appels: [] as number[], executerSiDu: async (maintenant: number) => {
      passe.appels.push(maintenant);
    } };
    const archives = { appels: [] as number[], purger: (maintenant: number) => {
      archives.appels.push(maintenant);
      return 0;
    } };
    const { balayeur: instance } = balayeur(() => bots.map((bot) => bot.cible), {
      passeHebdo: passe,
      archivesBots: archives,
    });

    await instance.tick();

    // ⚠️ 3 bots, mais UNE seule passe et UNE seule purge : ce ne sont pas des
    // rendez-vous « par bot ».
    expect(passe.appels).toEqual([MAINTENANT]);
    expect(archives.appels).toEqual([MAINTENANT]);
    expect(bots.flatMap((bot) => bot.tirs)).toHaveLength(3);
  });

  it("une purge d'archives en échec n'empêche ni la passe hebdo ni les bots", async () => {
    const bot = botBalayable("yuki");
    const passe = { appels: 0, executerSiDu: async () => {
      passe.appels += 1;
    } };
    const { balayeur: instance } = balayeur(() => [bot.cible], {
      passeHebdo: passe,
      archivesBots: {
        purger: () => {
          throw new Error("dossier illisible");
        },
      },
    });

    await instance.tick();

    expect(passe.appels).toBe(1);
    expect(bot.tirs).toEqual(["yuki:tache"]);
  });
});
