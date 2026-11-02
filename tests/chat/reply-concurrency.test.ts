/**
 * CONCURRENCE d'un canal distant — deux runs simultanés, le troisième en attente.
 *
 * ⚠️ CE QUE CE FICHIER VERROUILLE (et ce qu'il REFUSE de verrouiller) : la borne
 * existante (`ReplyLimiter`, `src/chat/reply/limiter.ts:36-40`) autorise **DEUX**
 * rédactions simultanées par plateforme et met la troisième **en attente** — elle ne
 * la refuse pas. C'est la sémantique retenue : une personne qui écrit pendant qu'une
 * image se génère ne doit ni attendre la fin, ni se voir refuser sa réponse.
 *
 * ⚠️ Il n'y a **AUCUNE porte de sérialisation par canal** : deux runs d'un même canal
 * peuvent tourner ensemble. Ce fichier le vérifie explicitement, pour qu'un futur
 * « garde-fou » ne réintroduise pas silencieusement un verrou global.
 *
 * ⚠️ Et l'accusé ne peut pas être DOUBLÉ : chaque run a son propre verrou 1/run, et un
 * run qui accuse deux fois n'existe pas (`tests/chat/reply-progress.test.ts`).
 *
 * ⚠️ Échoue sur le code d'origine : `ReplyProgress` n'existe pas (aucun accusé publié
 * du tout) et `enAttente` n'était pas observable.
 */

import { describe, expect, it } from "vitest";

import { REPLY_MAX_CONCURRENT, ReplyLimiter, ReplyProgress } from "../../src/chat/index.js";

/** Attend un tour de boucle : laisse les tâches lancées progresser. */
const tourner = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("trois messages, deux runs, le troisième en attente", () => {
  it("ne refuse PAS le troisième message : il attend une place", async () => {
    const limiter = new ReplyLimiter({ plateforme: "mattermost" });
    const lances: string[] = [];
    const liberations: Array<() => void> = [];

    const tache = (nom: string) => async (): Promise<void> => {
      lances.push(nom);
      await new Promise<void>((resolve) => liberations.push(resolve));
    };

    const premier = limiter.run(tache("m1"));
    const second = limiter.run(tache("m2"));
    await tourner();

    // ① DEUX runs tournent ensemble (pas de verrou par canal).
    expect(lances).toEqual(["m1", "m2"]);
    expect(limiter.enCours).toBe(REPLY_MAX_CONCURRENT);

    // ② Le troisième ATTEND — il n'est ni lancé, ni refusé.
    const troisieme = limiter.run(tache("m3"));
    await tourner();
    expect(lances).toEqual(["m1", "m2"]);
    expect(limiter.enAttente).toBe(1);
    expect(limiter.refuseesCount).toBe(0);

    // ③ Une place se libère : le troisième démarre, sans avoir été perdu.
    liberations.shift()?.();
    await tourner();
    expect(lances).toEqual(["m1", "m2", "m3"]);

    liberations.shift()?.();
    liberations.shift()?.();
    await Promise.all([premier, second, troisieme]);
    expect(limiter.enCours).toBe(0);
    expect(limiter.enAttente).toBe(0);
  });
});

describe("accusé — aucun doublon entre deux runs du même canal", () => {
  it("deux runs simultanés publient chacun UN accusé, jamais deux", async () => {
    const publications: string[] = [];
    const publier = async (message: { text: string }): Promise<void> => {
      publications.push(message.text);
    };

    const runA = new ReplyProgress({ publier, outils: ["generer_image"] });
    const runB = new ReplyProgress({ publier, outils: ["generer_image"] });

    runA.demarrerOutil({ tool: "generer_image", ackCandidat: "Deux secondes." });
    runB.demarrerOutil({ tool: "generer_image", ackCandidat: "Je m'en occupe." });
    // Un second outil d'action longue dans le MÊME run ne réaccuse pas.
    runA.demarrerOutil({ tool: "generer_image", ackCandidat: "Encore." });
    await Promise.all([runA.attendre(), runB.attendre()]);

    expect(publications).toEqual(["Deux secondes.", "Je m'en occupe."]);
    expect(new Set(publications).size).toBe(2);
  });
});
