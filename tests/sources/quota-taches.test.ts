/**
 * QUOTA DES TÂCHES PONCTUELLES — la place se libère VRAIMENT (2026-11-22).
 *
 * ⚠️ LE MENSONGE CORRIGÉ (audit du 2026-11-22) : le refus de la 21ᵉ tâche ponctuelle
 * disait « Attends qu'une tâche s'exécute (elle s'éteint toute seule) », donc qu'une
 * place se libère. C'était FAUX : `tachesPonctuelles` compte TOUS les enregistrements
 * ponctuels, terminés compris, et aucune purge n'existait — seule une suppression
 * MANUELLE libérait une place.
 *
 * ⚠️ LA VOIE CHOISIE : rendre le COMPORTEMENT vrai (purge automatique après
 * `RETENTION_TACHES_TERMINEES_JOURS` = 7 jours, la rétention déjà utilisée par les
 * envois terminés et les déclencheurs temporaires éteints) **ET** un message exact. Un
 * quota qui se libère tout seul est ce que le message promettait ; le corriger dans
 * l'autre sens (message « supprimez à la main ») aurait laissé une limite vécue comme
 * un bug, et une tâche terminée n'a plus rien à dire.
 *
 * ⚠️ CE QUE LA PURGE NE TOUCHE JAMAIS : une tâche ARMÉE (elle doit encore tirer), une
 * ÉTAPE de chaîne (une chaîne se supprime en entier), et une tâche terminée depuis moins
 * de 7 jours (l'historique reste lisible).
 *
 * ⚠️ Ces tests ÉCHOUENT sur l'origine : `purgerTachesTerminees` n'existe pas et le
 * message promet une libération automatique qui n'a jamais eu lieu.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SourcesInbox } from "../../src/sources/inbox.js";
import { DeclencheurJournal, type DeclencheurJournalRecord } from "../../src/sources/journal.js";
import { DeclencheurBalayeur } from "../../src/sources/scheduler.js";
import {
  ORIGINE_HORLOGE,
  SourcesService,
  type SourcesWaker,
} from "../../src/sources/service.js";
import { SourcesStore, TachesPonctuellesFullError } from "../../src/sources/store.js";
import {
  MAX_TACHES_PONCTUELLES,
  RETENTION_TACHES_TERMINEES_JOURS,
} from "../../src/sources/types.js";

const JOUR = 86_400_000;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-quota-"));
  dirs.push(dir);
  return dir;
}

/** 4 novembre 2026, 17 h 00 à Paris (= 16 h UTC). */
const T0 = Date.parse("2026-11-04T16:00:00Z");
let maintenant = T0;

afterEach(() => {
  maintenant = T0;
});

class WakerVide implements SourcesWaker {
  currentSessionId(): string | undefined {
    return undefined;
  }
  send(): { runId: string; sessionId: string } {
    throw new Error("aucun envoi attendu dans ces tests");
  }
  subscribeAll(): () => void {
    return () => undefined;
  }
  async newSession(): Promise<{ sessionId: string }> {
    return { sessionId: "session-creee" };
  }
  async listSessions(): Promise<Array<{ sessionId: string; title: string }>> {
    return [];
  }
  async resume(file: string): Promise<{ sessionId: string }> {
    return { sessionId: file };
  }
  async sessionFileFor(): Promise<undefined> {
    return undefined;
  }
}

interface Pile {
  dir: string;
  store: SourcesStore;
  journal: DeclencheurJournal;
  service: SourcesService;
  balayeur: DeclencheurBalayeur;
  avancer: (ms: number) => void;
  evenements: () => DeclencheurJournalRecord[];
}

function pile(nom: string): Pile {
  const dir = tmpDir();
  const store = new SourcesStore({ path: join(dir, `${nom}-sources.json`), now: () => maintenant });
  const journal = DeclencheurJournal.open({ path: join(dir, `${nom}-journal.jsonl`) });
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  const service = new SourcesService({
    store,
    inbox: new SourcesInbox({ path: join(dir, `${nom}-inbox.json`) }),
    journal,
    logger,
    waker: new WakerVide(),
    promptTotalChars: () => 4_000,
    now: () => maintenant,
  });
  const balayeur = new DeclencheurBalayeur({
    store,
    journal,
    logger,
    now: () => maintenant,
    run: (cle, opts) =>
      service.declencher(cle, {
        origine: ORIGINE_HORLOGE,
        plafondMs: opts.plafondMs,
        signal: opts.signal,
      }),
  });
  return {
    dir,
    store,
    journal,
    service,
    balayeur,
    avancer: (ms) => {
      maintenant += ms;
    },
    evenements: () => journal.recent(200),
  };
}

/** Remplit le quota de tâches ponctuelles (20) et rend leurs noms. */
function remplir(p: { service: SourcesService }): string[] {
  const noms: string[] = [];
  for (let index = 0; index < MAX_TACHES_PONCTUELLES; index += 1) {
    const issue = p.service.planifierTache({
      quand: "dans 5 min",
      instruction: `tâche ${index}`,
      nom: `Tâche ${index}`,
      conversation: {},
    });
    if (!issue.ok) throw new Error(issue.raison);
    noms.push(issue.nom);
  }
  return noms;
}

describe("quota des tâches ponctuelles — le message ne ment plus", () => {
  it("⚠️ le refus ne promet plus une place libre « parce qu'elle s'éteint toute seule »", () => {
    const erreur = new TachesPonctuellesFullError(MAX_TACHES_PONCTUELLES, ["tache-3"], 7);
    expect(erreur.message).toContain(String(MAX_TACHES_PONCTUELLES));
    // ⚠️ La promesse EXACTE : la place se libère après 7 jours, ou tout de suite si on
    // supprime — et le refus NOMME les tâches terminées (celles qu'on peut supprimer).
    expect(erreur.message).toContain("7 jours");
    expect(erreur.message).toContain("Configuration → Déclencheurs");
    expect(erreur.message).toContain("« tache-3 »");
    expect(erreur.message).not.toContain("Attends qu'une tâche s'exécute");
  });

  it("⚠️ le refus RÉEL nomme les tâches TERMINÉES (pas les tâches armées)", () => {
    const p = pile("yuki");
    const noms = remplir(p);
    // Une seule tâche est terminée : c'est elle, et elle seule, qui est nommable.
    p.store.setActif(noms[0] as string, false, "terminée");
    // `planifierTache` rend un refus NOMMÉ (il ne lève pas) : c'est lui qu'on lit.
    const issue = p.service.planifierTache({
      quand: "dans 5 min",
      instruction: "une de trop",
      conversation: {},
    });
    expect(issue.ok).toBe(false);
    if (issue.ok) return;
    expect(issue.raison).toContain(String(MAX_TACHES_PONCTUELLES));
    expect(issue.raison).toContain(noms[0] as string);
    expect(issue.raison).toContain("7 jours");
    // Les 19 autres ne sont pas nommées : elles ne peuvent pas être supprimées sans
    // perdre un passage à venir.
    expect(issue.raison).not.toContain(noms[1] as string);
  });
});

describe("purge automatique des tâches TERMINÉES (7 jours) — le quota se libère VRAIMENT", () => {
  it("⚠️ TEST CENTRAL : 20 tâches terminées anciennes ⇒ après purge, une création PASSE", async () => {
    const p = pile("yuki");
    const noms = remplir(p);
    for (const nom of noms) p.store.setActif(nom, false, "terminée");
    expect(p.store.tachesPonctuelles).toBe(MAX_TACHES_PONCTUELLES);
    // Encore bloqué tant que la rétention n'est pas écoulée.
    await p.balayeur.tick();
    expect(p.store.tachesPonctuelles).toBe(MAX_TACHES_PONCTUELLES);

    // 8 jours plus tard (> 7 jours de rétention) : la purge du BALAYEUR les retire.
    p.avancer(8 * JOUR);
    await p.balayeur.tick();
    expect(p.store.tachesPonctuelles).toBe(0);

    const issue = p.service.planifierTache({
      quand: "dans 5 min",
      instruction: "une nouvelle",
      conversation: {},
    });
    expect(issue.ok).toBe(true);
    expect(p.store.tachesPonctuelles).toBe(1);
  });

  it("⚠️ une tâche ARMÉE (à venir) n'est JAMAIS purgée, même très ancienne", async () => {
    const p = pile("yuki");
    const noms = remplir(p);
    // 19 terminées + 1 ARMÉE (elle doit encore tirer).
    for (const nom of noms.slice(0, MAX_TACHES_PONCTUELLES - 1)) {
      p.store.setActif(nom, false, "terminée");
    }
    const armee = noms[MAX_TACHES_PONCTUELLES - 1] as string;
    expect(p.store.get(armee)?.actif).not.toBe(false);
    p.avancer(365 * JOUR);
    await p.balayeur.tick();
    expect(p.store.get(armee)).toBeDefined();
    expect(p.store.tachesPonctuelles).toBe(1);
  });

  it("⚠️ une ÉTAPE de CHAÎNE n'est jamais purgée (une chaîne se supprime en entier)", async () => {
    const p = pile("yuki");
    const [etape] = p.store.createChaine({
      id: "chaine-1",
      etapes: [
        {
          libelle: "Veille",
          consigne: "surveille",
          declencheur: { type: "planning", expression: "0 8 * * *", fuseau: "Europe/Paris" },
        },
        {
          libelle: "Rapport",
          consigne: "rapporte",
          declencheur: { type: "planning", expression: "0 9 * * *", fuseau: "Europe/Paris" },
        },
      ],
    });
    p.store.setActif(etape?.nom as string, false, "terminée");
    p.avancer(365 * JOUR);
    await p.balayeur.tick();
    // ⚠️ Une étape est un `planning` : la purge des PONCTUELLES ne la regarde pas.
    expect(p.store.list().map((record) => record.nom)).toContain(etape?.nom as string);
  });

  it("⚠️ la purge est PAR BOT : les tâches terminées d'un autre bot restent intactes", async () => {
    const botA = pile("yuki");
    const botB = pile("grolaf");
    for (const nom of remplir(botA)) botA.store.setActif(nom, false, "terminée");
    for (const nom of remplir(botB)) botB.store.setActif(nom, false, "terminée");
    botA.avancer(8 * JOUR);
    // Seul le balayeur de A tourne (chacun a SON `sources.json` et SON balayeur).
    await botA.balayeur.tick();
    expect(botA.store.tachesPonctuelles).toBe(0);
    expect(botB.store.tachesPonctuelles).toBe(MAX_TACHES_PONCTUELLES);
  });

  it("⚠️ la purge est JOURNALISÉE (événement `purge`), une ligne par tâche retirée", async () => {
    const p = pile("yuki");
    const noms = remplir(p);
    for (const nom of noms) p.store.setActif(nom, false, "terminée");
    p.avancer(8 * JOUR);
    await p.balayeur.tick();
    const purges = p.evenements().filter((evenement) => evenement.event === "purge");
    expect(purges).toHaveLength(MAX_TACHES_PONCTUELLES);
    expect(purges.map((evenement) => evenement.source).sort()).toEqual([...noms].sort());
    // ⚠️ La ligne DIT pourquoi la place est libre (rétention appliquée).
    expect(purges[0]?.raison).toContain(String(RETENTION_TACHES_TERMINEES_JOURS));
  });

  it("une tâche terminée depuis MOINS de 7 jours reste visible (l'historique est gardé)", async () => {
    const p = pile("yuki");
    const noms = remplir(p);
    for (const nom of noms) p.store.setActif(nom, false, "terminée");
    p.avancer((RETENTION_TACHES_TERMINEES_JOURS - 1) * JOUR);
    await p.balayeur.tick();
    expect(p.store.tachesPonctuelles).toBe(MAX_TACHES_PONCTUELLES);
  });
});
