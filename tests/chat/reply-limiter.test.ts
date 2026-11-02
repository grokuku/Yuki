/**
 * BORNE DURE des réponses simultanées (D1).
 *
 * Ce que ce fichier verrouille :
 *  - au-delà de `maxConcurrent`, une tâche ATTEND (elle n'est pas lancée en parallèle) ;
 *  - la file est FIFO : l'ordre des messages est celui des réponses ;
 *  - au-delà de la file, le refus est EXPLICITE, COMPTÉ et JOURNALISÉ (jamais un silence) ;
 *  - une tâche qui échoue rend sa place et n'interrompt pas la file.
 *
 * ⚠️ Avant ce correctif, `reponsesEnCours` n'était qu'un COMPTEUR : rien ne bornait quoi
 * que ce soit, et un canal actif lançait un run par message.
 */

import { describe, expect, it } from "vitest";

import {
  REPLY_MAX_CONCURRENT,
  REPLY_MAX_QUEUE,
  ReplyLimiter,
  type ReplyLimiterLogger,
} from "../../src/chat/index.js";

/** Journal de test : on veut VOIR les refus, pas seulement les compter. */
function journal(): ReplyLimiterLogger & { lignes: Array<{ message: string; fields?: Record<string, unknown> }> } {
  const lignes: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  return {
    lignes,
    info: (message, fields) => lignes.push({ message, ...(fields ? { fields } : {}) }),
    warn: (message, fields) => lignes.push({ message, ...(fields ? { fields } : {}) }),
  };
}

/** Tâche pilotée : elle ne rend la main que quand on la libère. */
function tâchePilotée(resultats: string[], nom: string) {
  let liberer: (() => void) | undefined;
  const porte = new Promise<void>((resolve) => {
    liberer = resolve;
  });
  return {
    tache: async () => {
      resultats.push(`${nom}:debut`);
      await porte;
      resultats.push(`${nom}:fin`);
    },
    liberer: () => liberer?.(),
  };
}

describe("ReplyLimiter — plafond, file bornée, refus explicite", () => {
  it("ne lance JAMAIS plus de `maxConcurrent` tâches à la fois, et fait attendre les autres", async () => {
    const limiter = new ReplyLimiter({ plateforme: "test", maxConcurrent: 2, maxQueue: 10 });
    const vus: string[] = [];
    const a = tâchePilotée(vus, "a");
    const b = tâchePilotée(vus, "b");
    const c = tâchePilotée(vus, "c");

    const runs = [limiter.run(a.tache), limiter.run(b.tache), limiter.run(c.tache)];
    // Laisse partir ce qui peut partir.
    await Promise.resolve();
    await Promise.resolve();
    expect(limiter.enCours).toBe(2);
    expect(limiter.enAttente).toBe(1);
    // ⚠️ La troisième n'a PAS démarré : c'est exactement ce que le compteur ne faisait pas.
    expect(vus).toEqual(["a:debut", "b:debut"]);

    a.liberer();
    await runs[0];
    // La place libérée est transmise à la suivante (file FIFO) : `c` démarre AVANT que `b`
    // ait fini, mais `b` reste la seule autre en cours.
    expect(vus).toEqual(["a:debut", "b:debut", "a:fin", "c:debut"]);
    expect(limiter.enCours).toBe(2);
    b.liberer();
    await runs[1];
    c.liberer();
    await runs[2];
    expect(limiter.enCours).toBe(0);
    expect(limiter.refuseesCount).toBe(0);
  });

  it("au-delà de la file, le REFUS est explicite, compté et journalisé", async () => {
    const log = journal();
    const limiter = new ReplyLimiter({
      plateforme: "test",
      maxConcurrent: 1,
      maxQueue: 1,
      logger: log,
    });
    const vus: string[] = [];
    const a = tâchePilotée(vus, "a");
    const b = tâchePilotée(vus, "b");
    const refusée = { appels: 0 };

    const runs = [limiter.run(a.tache), limiter.run(b.tache)];
    const trois = limiter.run(async () => {
      refusée.appels += 1;
    });
    // La troisième est refusée : elle n'entre ni en cours, ni en attente.
    await trois;
    expect(refusée.appels).toBe(0);
    expect(limiter.refuseesCount).toBe(1);
    expect(limiter.enCours).toBe(1);
    expect(limiter.enAttente).toBe(1);
    const refus = log.lignes.find((ligne) => ligne.message === "chat.reply.refused");
    expect(refus?.fields?.raison).toBe("file_pleine");

    a.liberer();
    await runs[0];
    b.liberer();
    await runs[1];
  });

  it("une tâche qui ÉCHOUE rend sa place et n'interrompt pas la file", async () => {
    const log = journal();
    const limiter = new ReplyLimiter({ plateforme: "test", maxConcurrent: 1, maxQueue: 2, logger: log });
    const ordre: string[] = [];
    await limiter.run(async () => {
      ordre.push("échec");
      throw new Error("générateur indisponible");
    });
    await limiter.run(async () => {
      ordre.push("suivante");
    });
    expect(ordre).toEqual(["échec", "suivante"]);
    expect(limiter.enCours).toBe(0);
    expect(log.lignes.some((ligne) => ligne.message === "chat.reply.task_failed")).toBe(true);
  });

  it("les valeurs par défaut bornent réellement (2 en cours, 20 en attente)", () => {
    const limiter = new ReplyLimiter({ plateforme: "test" });
    expect(REPLY_MAX_CONCURRENT).toBe(2);
    expect(REPLY_MAX_QUEUE).toBe(20);
    expect(limiter.enCours).toBe(0);
    expect(limiter.enAttente).toBe(0);
  });
});
