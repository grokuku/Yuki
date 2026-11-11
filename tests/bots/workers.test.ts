/**
 * LOT 36 (L7) — UN WORKER LOURD PAR BOT, CRÉÉ PARESSEUSEMENT.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `src/bots/workers.ts` n'existe
 * pas, et `main()` construit UN worker (celui de la pile) au démarrage — il n'y
 * a aucun registre par bot, donc aucune création paresseuse à prouver.
 *
 * Ce qui est verrouillé ici :
 *  ① PARESSEUX : le constructeur ne construit RIEN (le principal semé est
 *    réutilisé par identité) ;
 *  ② pas de worker sans capacité (`execution`/`delegation`) — et la fabrique
 *    n'est MÊME PAS appelée ;
 *  ③ un bot muet ne coûte rien au démarrage (aucun appel de fabrique) ;
 *  ④ PLAFOND : au-delà, refus explicite nommant le plafond et les bots ;
 *  ⑤ mémoire : RSS relevé et journalisé à chaque construction et à la demande ;
 *  ⑥ `oublier` (arrêt ciblé) + un refus n'est dit qu'UNE fois.
 */

import { describe, expect, it, vi } from "vitest";

import type { CapaciteBot } from "../../src/bots/registry.js";
import {
  MAX_WORKERS_LOURDS_DEFAUT,
  WorkersLourdsBots,
  normaliserPlafondWorkers,
  type WorkersLourdsLogger,
} from "../../src/bots/workers.js";

/** Journal de test : retient `message:champs`. */
function journalEspion(): WorkersLourdsLogger & { lignes: string[] } {
  const lignes: string[] = [];
  const noter = (message: string, fields?: Record<string, unknown>): void => {
    lignes.push(`${message}:${JSON.stringify(fields ?? {})}`);
  };
  return { lignes, info: noter, warn: noter };
}

const TOUTES: readonly CapaciteBot[] = ["fichiers", "execution", "delegation"];
const MUET: readonly CapaciteBot[] = ["fichiers"];

interface WorkerFactice {
  botId: string;
}

function banc(options: {
  capacites?: (botId: string) => readonly CapaciteBot[] | undefined;
  existants?: Map<string, WorkerFactice>;
  plafond?: number;
  rss?: () => number;
} = {}) {
  const log = journalEspion();
  const creer = vi.fn((botId: string): WorkerFactice => ({ botId }));
  const workers = new WorkersLourdsBots<WorkerFactice>({
    botDePile: "yuki",
    capacites: options.capacites ?? (() => TOUTES),
    creer,
    ...(options.existants !== undefined ? { existants: options.existants } : {}),
    ...(options.plafond !== undefined ? { plafond: options.plafond } : {}),
    ...(options.rss !== undefined ? { rss: options.rss } : {}),
    logger: log,
  });
  return { workers, creer, log };
}

describe("WorkersLourdsBots — paresseux", () => {
  it("le constructeur ne construit RIEN (aucun worker au démarrage)", () => {
    const { workers, creer } = banc();
    expect(creer).not.toHaveBeenCalled();
    expect(workers.taille).toBe(0);
    expect(workers.construits()).toEqual([]);
  });

  it("le worker du principal est réutilisé par IDENTITÉ (non-régression)", () => {
    const principal: WorkerFactice = { botId: "yuki" };
    const { workers, creer } = banc({ existants: new Map([["yuki", principal]]) });

    expect(workers.pour("yuki")).toBe(principal);
    expect(creer).not.toHaveBeenCalled();
  });

  it("la fabrique n'est appelée qu'à la PREMIÈRE demande, et une seule fois", () => {
    const { workers, creer } = banc();
    expect(creer).not.toHaveBeenCalled();
    const premier = workers.pour("kohai");
    const second = workers.pour("kohai");
    expect(premier).toBe(second);
    expect(creer).toHaveBeenCalledTimes(1);
    expect(creer).toHaveBeenCalledWith("kohai");
  });

  it("un bot muet ne construit rien, et la fabrique n'est jamais appelée", () => {
    const { workers, creer, log } = banc({ capacites: () => MUET });
    expect(workers.pour("kohai")).toBeUndefined();
    expect(creer).not.toHaveBeenCalled();
    expect(workers.refus("kohai")).toBe("capacites");
    expect(log.lignes.some((ligne) => ligne.startsWith("bots.worker.refuse"))).toBe(true);
  });

  it("un bot SANS capacité explicite (mono-bot) est autorisé, comme avant", () => {
    const { workers, creer } = banc({ capacites: () => undefined });
    workers.pour("kohai");
    expect(creer).toHaveBeenCalledTimes(1);
  });

  it("un refus n'est dit qu'UNE fois (pas de spam au journal)", () => {
    const { workers, log } = banc({ capacites: () => MUET });
    workers.pour("kohai");
    workers.pour("kohai");
    workers.pour("kohai");
    expect(log.lignes.filter((ligne) => ligne.startsWith("bots.worker.refuse"))).toHaveLength(1);
  });
});

describe("WorkersLourdsBots — plafond", () => {
  it("au-delà du plafond, le refus NOMME le plafond et les workers existants", () => {
    const { workers, log } = banc({ plafond: 1 });
    expect(workers.pour("yuki")).toBeDefined();
    expect(workers.pour("kohai")).toBeUndefined();
    expect(workers.refus("kohai")).toBe("plafond");
    const ligne = log.lignes.find((entree) => entree.startsWith("bots.worker.plafond")) ?? "";
    expect(ligne).toContain("plafond de 1 worker");
    expect(ligne).toContain("yuki");
  });

  it("normaliserPlafondWorkers borne et a un défaut", () => {
    expect(normaliserPlafondWorkers(undefined)).toBe(MAX_WORKERS_LOURDS_DEFAUT);
    expect(normaliserPlafondWorkers("2")).toBe(2);
    expect(normaliserPlafondWorkers(0)).toBe(1);
    expect(normaliserPlafondWorkers(-4)).toBe(1);
    expect(normaliserPlafondWorkers(Number.NaN)).toBe(MAX_WORKERS_LOURDS_DEFAUT);
    expect(normaliserPlafondWorkers(2.9)).toBe(2);
  });
});

describe("WorkersLourdsBots — mémoire", () => {
  it("le RSS est mesuré à chaque construction et journalisé", () => {
    const { workers, log } = banc({ rss: () => 128 * 1024 * 1024, plafond: 3 });
    workers.pour("kohai");

    const ligne = log.lignes.find((entree) => entree.startsWith("bots.worker.construit")) ?? "";
    expect(ligne).toContain('"rss_mb":128');
    expect(ligne).toContain('"workers":1');
  });

  it("journaliserRss dit le nombre de workers, le plafond et les bots", () => {
    const { workers, log } = banc({ rss: () => 64 * 1024 * 1024 });
    workers.pour("yuki");
    workers.pour("kohai");

    const releve = workers.journaliserRss();

    expect(releve).toEqual({
      workers: 2,
      plafond: MAX_WORKERS_LOURDS_DEFAUT,
      rssMb: 64,
      bots: ["yuki", "kohai"],
    });
    expect(log.lignes.some((ligne) => ligne.startsWith("bots.workers.rss"))).toBe(true);
  });
});

describe("WorkersLourdsBots — arrêt ciblé", () => {
  it("oublier retire le worker du bot (le suivant sera reconstruit)", () => {
    const { workers, creer } = banc();
    workers.pour("kohai");
    expect(workers.a("kohai")).toBe(true);
    expect(workers.oublier("kohai")).toBe(true);
    expect(workers.oublier("kohai")).toBe(false);
    workers.pour("kohai");
    expect(creer).toHaveBeenCalledTimes(2);
  });
});
