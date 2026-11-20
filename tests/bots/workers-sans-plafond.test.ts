/**
 * PLUS DE PLAFOND FIGÉ DE WORKERS LOURDS (audit 2026-11-20, défaut ②).
 *
 * ⚠️ DÉCISION UTILISATEUR (2026-11-13, étendue le 2026-11-20) : « chacun fait
 * comme il a envie en fonction de ses ressources, limiter c'est mal à mon sens. »
 * Le plafond figé à 3 faisait échouer d'office la tâche du 4ᵉ bot demandeur
 * (`heavy_unavailable` muet, à chaque fois) — même famille que `bots.maxActifs`,
 * déjà retiré.
 *
 * Ce fichier verrouille :
 *  ① un worker par bot, à la demande, SANS plafond par défaut : le 4ᵉ bot en
 *    reçoit un ;
 *  ② si un opérateur IMPOSE un plafond, le dépassement est DIT (journal + phrase
 *    lisible transmise au modèle), jamais muet ;
 *  ③ un bot arrêté LIBÈRE son worker (hook `liberer`), et le RSS ne monte pas à
 *    chaque cycle activation/arrêt ;
 *  ④ le relevé journalise le NOMBRE de workers et le RSS.
 *
 * ⚠️ Échoue sur le code d'origine : `MAX_WORKERS_LOURDS_DEFAUT` vaut 3, le 4ᵉ
 * `pour` rend `undefined`, il n'existe ni `liberer`, ni `refusLisible`.
 */

import { describe, expect, it, vi } from "vitest";

import type { CapaciteBot } from "../../src/bots/registry.js";
import {
  MAX_WORKERS_LOURDS_DEFAUT,
  WorkersLourdsBots,
  type WorkersLourdsLogger,
} from "../../src/bots/workers.js";

interface WorkerFactice {
  botId: string;
}

const TOUTES: readonly CapaciteBot[] = ["fichiers", "execution", "delegation"];

function journalEspion(): WorkersLourdsLogger & { lignes: string[] } {
  const lignes: string[] = [];
  const noter = (message: string, fields?: Record<string, unknown>): void => {
    lignes.push(`${message}:${JSON.stringify(fields ?? {})}`);
  };
  return { lignes, info: noter, warn: noter };
}

function banc(options: {
  plafond?: number;
  liberer?: (botId: string, worker: WorkerFactice) => void;
  rss?: () => number;
} = {}) {
  const log = journalEspion();
  const creer = vi.fn((botId: string): WorkerFactice => ({ botId }));
  const workers = new WorkersLourdsBots<WorkerFactice>({
    botDuRun: "yuki",
    capacites: () => TOUTES,
    creer,
    ...(options.plafond !== undefined ? { plafond: options.plafond } : {}),
    ...(options.liberer !== undefined ? { liberer: options.liberer } : {}),
    ...(options.rss !== undefined ? { rss: options.rss } : {}),
    logger: log,
  });
  return { workers, creer, log };
}

describe("① aucun plafond figé : un worker par bot, à la demande", () => {
  it("le DÉFAUT est « aucun plafond » (plus de 3)", () => {
    expect(Number.isFinite(MAX_WORKERS_LOURDS_DEFAUT)).toBe(false);
  });

  it("⚠️ TEST CENTRAL : le 4ᵉ bot demandeur REÇOIT son worker", () => {
    const { workers, creer, log } = banc();
    const bots = ["yuki", "b2", "b3", "b4"];
    for (const botId of bots) expect(workers.pour(botId), botId).toBeDefined();
    expect(workers.taille).toBe(4);
    expect(creer).toHaveBeenCalledTimes(4);
    expect(workers.refus("b4")).toBeUndefined();
    // Aucune ligne de plafond : la notion n'existe plus par défaut.
    expect(log.lignes.some((ligne) => ligne.startsWith("bots.worker.plafond"))).toBe(false);
  });

  it("le même bot ne construit qu'UNE fois (réutilisé par identité)", () => {
    const { workers, creer } = banc();
    const premier = workers.pour("b2");
    expect(workers.pour("b2")).toBe(premier);
    expect(creer).toHaveBeenCalledTimes(1);
  });
});

describe("② si un plafond est IMPOSÉ, son dépassement est DIT", () => {
  it("le refus nomme le plafond, les bots occupants et une phrase pour le modèle", () => {
    const { workers, log } = banc({ plafond: 2 });
    expect(workers.pour("yuki")).toBeDefined();
    expect(workers.pour("b2")).toBeDefined();
    expect(workers.pour("b3")).toBeUndefined();

    const phrase = workers.refusLisible("b3") ?? "";
    expect(phrase).toContain("plafond de 2");
    expect(phrase).toContain("tous les workers lourds sont occupés");
    expect(phrase).toContain("yuki");

    const ligne = log.lignes.find((entree) => entree.startsWith("bots.worker.plafond")) ?? "";
    expect(ligne).toContain("plafond de 2 worker(s) atteint");
    expect(ligne).toContain("message");
  });

  it("un refus de capacité est dit lui aussi (jamais un refus muet)", () => {
    const { workers } = banc();
    const capacites = () => ["fichiers"] as const;
    const muet = new WorkersLourdsBots<WorkerFactice>({
      botDuRun: "yuki",
      capacites,
      creer: () => ({ botId: "muet" }),
    });
    expect(muet.pour("b2")).toBeUndefined();
    expect(muet.refusLisible("b2")).toContain("capacités");
    expect(workers.refusLisible("inconnu")).toBeUndefined();
  });
});

describe("③ un bot arrêté LIBÈRE son worker (le RSS ne monte pas)", () => {
  it("⚠️ TEST CENTRAL : `oublier` appelle le hook, retire le worker et journalise", () => {
    const libere: string[] = [];
    const { workers, creer, log } = banc({
      liberer: (botId) => libere.push(botId),
      rss: () => 128 * 1024 * 1024,
    });
    workers.pour("b2");
    expect(workers.a("b2")).toBe(true);

    expect(workers.oublier("b2")).toBe(true);
    expect(libere).toEqual(["b2"]);
    expect(workers.a("b2")).toBe(false);
    expect(workers.taille).toBe(0);
    expect(log.lignes.some((ligne) => ligne.startsWith("bots.worker.libere"))).toBe(true);

    // Le worker suivant est RECONSTRUIT (aucune référence fantôme).
    workers.pour("b2");
    expect(creer).toHaveBeenCalledTimes(2);
  });

  it("⚠️ cinq cycles activation/arrêt : le RSS reste stable, aucun worker ne s'accumule", () => {
    // RSS SIMULÉ proportionnel aux workers vivants : sans le hook `liberer`, la
    // mémoire monterait à chaque cycle (le défaut que l'on ferme).
    const BASE_MO = 96;
    const PAR_WORKER_MO = 32;
    let vivants = 0;
    const workers = new WorkersLourdsBots<WorkerFactice>({
      botDuRun: "yuki",
      capacites: () => TOUTES,
      creer: () => {
        vivants += 1;
        return { botId: "b2" };
      },
      liberer: () => {
        vivants = Math.max(0, vivants - 1);
      },
      rss: () => (BASE_MO + vivants * PAR_WORKER_MO) * 1024 * 1024,
    });
    for (let cycle = 0; cycle < 5; cycle += 1) {
      workers.pour("b2");
      expect(workers.releve()).toMatchObject({ workers: 1, rssMb: BASE_MO + PAR_WORKER_MO });
      expect(workers.oublier("b2")).toBe(true);
      expect(workers.releve()).toMatchObject({ workers: 0, rssMb: BASE_MO });
    }
    expect(workers.construits()).toEqual([]);
  });
});

describe("④ le relevé dit le nombre de workers et le RSS", () => {
  it("journaliserRss écrit « aucun » quand il n'y a pas de plafond", () => {
    const { workers, log } = banc({ rss: () => 64 * 1024 * 1024 });
    workers.pour("yuki");
    workers.pour("b2");
    const releve = workers.journaliserRss();
    expect(releve).toMatchObject({ workers: 2, rssMb: 64, bots: ["yuki", "b2"] });
    const ligne = log.lignes.find((entree) => entree.startsWith("bots.workers.rss")) ?? "";
    expect(ligne).toContain('"workers":2');
    expect(ligne).toContain('"plafond":"aucun"');
    expect(ligne).toContain('"rss_mb":64');
  });
});
