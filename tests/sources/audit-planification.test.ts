/**
 * AUDIT 2026-11-20 — TROUS DE COUVERTURE DE LA PLANIFICATION (① ② ③ ④).
 *
 * ⚠️ CE QUE CES TESTS FERMENT (et ce qu'ils ne testent pas) :
 *
 *  ① les bornes de `planifier_tache` (30 s, 4 000 caractères) — ⚠️ l'HORIZON de
 *    30 jours a été RETIRÉ le 2026-11-22 (« retirer la limite : oui ») : les tests de
 *    refus à 31 jours sont devenus des tests d'ACCEPTATION à 31 jours, 1 an et 5 ans —
 *    ⚠️ elles passent DÉJÀ sur l'origine : le code des bornes était juste, seul le
 *    TEST manquait. Elles verrouillent donc un comportement existant (dont les
 *    limites inclusives/exclusives, désormais DOCUMENTÉES ici) ;
 *  ② une ponctuelle manquée de plus d'une heure est PUBLIÉE — ⚠️ ÉCHOUE sur l'origine :
 *    le balayeur se contentait de journaliser le saut et d'éteindre la tâche, la
 *    personne n'apprenait jamais que son rappel n'avait pas eu lieu ;
 *  ③ un redémarrage pendant l'exécution laisse une trace — ⚠️ ÉCHOUE sur l'origine :
 *    `signalerTachesInterrompues` n'existait pas et l'état restait « en cours
 *    d'exécution » à vie ;
 *  ④ un bot dont le host n'a pas démarré ne se rabat JAMAIS sur le host de l'instance
 *    — ⚠️ ÉCHOUE sur l'origine (repli `?? hoteSources`) : le `sessionId` de la tâche
 *    était EFFACÉ et un fil était créé chez l'autre bot. Le test de contrôle (④-b)
 *    reproduit ce défaut pour prouver que l'assertion mord.
 *
 * ⚠️ Aucun E2E, aucun `main()` : tout passe par les services et le balayeur, avec le
 * temps INJECTÉ (rien n'attend 30 s ni une heure).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DELAI_MIN_MS } from "../../src/chat/envois/types.js";
import { hoteSansHost } from "../../src/sources/ports-bot.js";
import { SourcesInbox } from "../../src/sources/inbox.js";
import { DeclencheurJournal, type DeclencheurJournalRecord } from "../../src/sources/journal.js";
import { DeclencheurBalayeur } from "../../src/sources/scheduler.js";
import {
  ORIGINE_HORLOGE,
  SourcesService,
  type SourcesHostEvent,
  type SourcesWaker,
} from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";
import { validerPlanificationTache } from "../../src/sources/taches.js";
import {
  MAX_INSTRUCTION_TACHE_CHARS,
  RAISON_TACHE_EN_COURS,
  RAISON_TACHE_INTERROMPUE,
  type SourceRecord,
} from "../../src/sources/types.js";

/** 4 novembre 2026, 17 h 00 à Paris (= 16 h UTC). */
const T0 = Date.parse("2026-11-04T16:00:00Z");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-audit-planif-"));
  dirs.push(dir);
  return dir;
}

// ── Doubles ────────────────────────────────────────────────────────────────

/** Host factice : `sessions` est ce qu'il CONNAÎT (comme un host qui a ses JSONL). */
class FakeWaker implements SourcesWaker {
  readonly sends: Array<{ sessionId: string; text: string }> = [];
  readonly knownSessions: Set<string>;
  newSessions = 0;
  private readonly listeners = new Set<(event: SourcesHostEvent) => void>();
  private sessionId: string | undefined;

  constructor(sessions: string[] = []) {
    this.knownSessions = new Set(sessions);
    this.sessionId = sessions[0];
  }

  currentSessionId(): string | undefined {
    return this.sessionId;
  }

  send(sessionId: string, text: string): { runId: string; sessionId: string } {
    this.sends.push({ sessionId, text });
    return { runId: `run-${this.sends.length}`, sessionId };
  }

  subscribeAll(listener: (event: SourcesHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async newSession(): Promise<{ sessionId: string }> {
    this.newSessions += 1;
    const id = `session-creee-${this.newSessions}`;
    this.sessionId = id;
    this.knownSessions.add(id);
    return { sessionId: id };
  }

  async listSessions(): Promise<Array<{ sessionId: string; title: string }>> {
    return [...this.knownSessions].map((sessionId) => ({ sessionId, title: sessionId }));
  }

  async resume(file: string): Promise<{ sessionId: string }> {
    this.knownSessions.add(file);
    this.sessionId = file;
    return { sessionId: file };
  }

  async sessionFileFor(id: string): Promise<string | undefined> {
    return this.knownSessions.has(id) ? id : undefined;
  }
}

class FakeJobs {
  readonly demandes: Array<{ task: string; lightSessionId: string }> = [];

  async delegate(request: { task: string; lightSessionId: string }): Promise<{
    status: string;
    job_id?: string;
  }> {
    this.demandes.push({ task: request.task, lightSessionId: request.lightSessionId });
    return { status: "dispatched", job_id: `job-${this.demandes.length}` };
  }

  cancelJob(): unknown {
    return { status: "cancelled" };
  }
}

class FakePublication {
  readonly publies: Array<{ sessionId: string; texte: string }> = [];

  async publier(sessionId: string, texte: string): Promise<void> {
    this.publies.push({ sessionId, texte });
  }
}

interface Harnais {
  service: SourcesService;
  store: SourcesStore;
  journal: DeclencheurJournal;
  jobs: FakeJobs;
  publication: FakePublication;
  /** Host de l'INSTANCE (celui du bot du run) : il ne connaît que ses sessions. */
  instance: FakeWaker;
  balayeur: DeclencheurBalayeur;
  avancer: (ms: number) => void;
  evenements: () => DeclencheurJournalRecord[];
}

function harnais(): Harnais {
  const dir = tmpDir();
  const store = new SourcesStore({ path: join(dir, "sources.json") });
  const inbox = new SourcesInbox({ path: join(dir, "sources-inbox.json") });
  const journal = DeclencheurJournal.open({ path: join(dir, "declencheurs-journal.jsonl") });
  const instance = new FakeWaker(["session-instance"]);
  const jobs = new FakeJobs();
  const publication = new FakePublication();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  let maintenant = T0;
  const service = new SourcesService({
    store,
    inbox,
    journal,
    logger,
    waker: instance,
    jobs,
    publication,
    fichier: () => null,
    promptTotalChars: () => 4_000,
    now: () => maintenant,
    botId: "kohai",
  });
  service.attach();
  const balayeur = new DeclencheurBalayeur({
    store,
    journal,
    logger,
    now: () => maintenant,
    run: (nom, opts) =>
      service.declencher(nom, {
        origine: ORIGINE_HORLOGE,
        ...(opts.planifie !== undefined ? { planifie: opts.planifie } : {}),
        plafondMs: opts.plafondMs,
        signal: opts.signal,
        ...(opts.desarmementPrealable === true ? { desarmementPrealable: true } : {}),
      }),
    // ⚠️ MÊME câblage que la production (`src/sources/par-bot.ts`).
    annoncerManquee: async (nom, raison) => {
      await service.annoncerTacheManquee(nom, raison);
    },
  });
  return {
    service,
    store,
    journal,
    jobs,
    publication,
    instance,
    balayeur,
    avancer: (ms) => {
      maintenant += ms;
    },
    evenements: () => journal.recent(100),
  };
}

/** Programme une ponctuelle et rend son nom (échoue si le port refuse). */
function planifier(
  h: Harnais,
  options: { quand: string; instruction: string; nom: string; session: string },
): string {
  const issue = h.service.planifierTache({
    quand: options.quand,
    instruction: options.instruction,
    nom: options.nom,
    conversation: { session: options.session },
  });
  if (!issue.ok) throw new Error(issue.raison);
  return issue.nom;
}

// ── ① BORNES de `planifier_tache` ───────────────────────────────────────────

describe("① bornes de `planifier_tache` — refus LISIBLES et limites documentées", () => {
  function valider(quand: string, instruction = "résume le journal") {
    return validerPlanificationTache(
      { quand, instruction, conversation: { session: "session-instance" } },
      T0,
    );
  }

  it("délai < 30 s REFUSÉ, avec un message lisible (jamais un code)", () => {
    const refus = valider("dans 29 s");
    expect(refus.ok).toBe(false);
    if (refus.ok) return;
    expect(refus.raison).toContain("30 secondes");
    expect(refus.raison).toContain("29 s");
    // ⚠️ Pas un code brut : la phrase est en français et dit quoi faire.
    expect(refus.raison).not.toMatch(/^[a-z_]+$/u);
    expect(refus.raison.startsWith("Rien n'a été programmé")).toBe(true);
  });

  it("LIMITE INCLUSIVE : exactement 30 s est ACCEPTÉ (le refus est strictement < 30 s)", () => {
    const ok = valider("dans 30 s");
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect((ok.at as number) - T0).toBe(DELAI_MIN_MS);
  });

  // ⚠️ RÉÉCRITURE (2026-11-22) : ces deux tests vérifiaient le REFUS au-delà de 30 jours.
  // La limite a été retirée à la demande de l'utilisateur : ils vérifient désormais
  // l'ACCEPTATION, en nommant 31 jours, 1 an et 5 ans.
  it("31 jours, 1 an et 5 ans sont ACCEPTÉS (plus aucun horizon)", () => {
    for (const [quand, jours] of [
      ["dans 31 jours", 31],
      ["dans 365 jours", 365],
      ["dans 1825 jours", 1825],
    ] as const) {
      const ok = valider(quand);
      expect(ok.ok).toBe(true);
      if (!ok.ok) return;
      expect((ok.at as number) - T0).toBe(jours * 86_400_000);
      // Aucun refus ne parle plus d'horizon : la notion n'existe plus.
      expect(ok.quandLisible).not.toContain("horizon");
    }
  });

  it("⚠️ 30 s reste la SEULE borne de temps (non-régression : 29 s est toujours refusé)", () => {
    const refus = valider("dans 29 s");
    expect(refus.ok).toBe(false);
    if (refus.ok) return;
    expect(refus.raison).toContain("30 secondes");
    const loin = valider("dans 1825 jours");
    expect(loin.ok).toBe(true);
  });

  it("instruction > 4 000 caractères REFUSÉE, en nommant la longueur ET le maximum", () => {
    const refus = valider("dans 5 min", "a".repeat(MAX_INSTRUCTION_TACHE_CHARS + 1));
    expect(refus.ok).toBe(false);
    if (refus.ok) return;
    expect(refus.raison).toContain(String(MAX_INSTRUCTION_TACHE_CHARS + 1));
    expect(refus.raison).toContain(String(MAX_INSTRUCTION_TACHE_CHARS));
  });

  it("LIMITE INCLUSIVE : 4 000 caractères PILE sont ACCEPTÉS (aucune troncature)", () => {
    const instruction = "a".repeat(MAX_INSTRUCTION_TACHE_CHARS);
    const ok = valider("dans 5 min", instruction);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.instruction).toHaveLength(MAX_INSTRUCTION_TACHE_CHARS);
  });

  it("⚠️ les bornes passent par le PORT (aucune tâche n'est écrite si refusée)", () => {
    const h = harnais();
    for (const [quand, instruction] of [
      ["dans 29 s", "résume"],
      ["dans 5 min", "a".repeat(MAX_INSTRUCTION_TACHE_CHARS + 1)],
    ] as const) {
      const issue = h.service.planifierTache({
        quand,
        instruction,
        conversation: { session: "session-instance" },
      });
      expect(issue.ok).toBe(false);
    }
    expect(h.store.tachesPonctuelles).toBe(0);
    // ⚠️ Et une date TRÈS lointaine, elle, est écrite (plus d'horizon).
    const loin = h.service.planifierTache({
      quand: "dans 365 jours",
      instruction: "résume",
      conversation: { session: "session-instance" },
    });
    expect(loin.ok).toBe(true);
    expect(h.store.tachesPonctuelles).toBe(1);
  });
});

// ── ② PONCTUELLE MANQUÉE > 1 h ──────────────────────────────────────────────

describe("② ponctuelle manquée de plus d'une heure — elle est DITE, jamais muette", () => {
  it("⚠️ publie un message d'excuse daté, et n'exécute PAS la tâche en retard", async () => {
    const h = harnais();
    const nom = planifier(h, {
      quand: "dans 1 min",
      instruction: "résume le journal de 7 h",
      nom: "Résumé du journal",
      session: "session-instance",
    });
    // Machine arrêtée trois heures : l'échéance est dépassée de plus d'une heure.
    h.avancer(3 * 60 * 60_000);
    await h.balayeur.tick();

    // ① rien n'a été exécuté (une tâche dit quelque chose de DATÉ : pas de tir tardif)
    expect(h.jobs.demandes).toEqual([]);
    // ② un message est publié, DANS la conversation demandeuse
    expect(h.publication.publies).toHaveLength(1);
    const publie = h.publication.publies[0];
    expect(publie?.sessionId).toBe("session-instance");
    expect(publie?.texte).toContain("Rappel non exécuté");
    expect(publie?.texte).toContain("Résumé du journal");
    expect(publie?.texte).toContain("non exécutée");
    // ③ l'état persiste la raison (lisible dans /config) et le journal la porte
    const record = h.store.get(nom) as SourceRecord;
    expect(record.actif).toBe(false);
    expect(record.raisonInactive).toContain("non exécutée");
    expect(h.evenements().some((event) => event.event === "saut")).toBe(true);
  });

  it("dans la FENÊTRE d'une heure, elle est exécutée normalement (aucune annonce)", async () => {
    const h = harnais();
    planifier(h, {
      quand: "dans 1 min",
      instruction: "résume le journal",
      nom: "Résumé",
      session: "session-instance",
    });
    h.avancer(2 * 60_000);
    await h.balayeur.tick();
    expect(h.jobs.demandes).toHaveLength(1);
    expect(h.publication.publies).toEqual([]);
  });
});

// ── ③ REDÉMARRAGE PENDANT L'EXÉCUTION ──────────────────────────────────────

describe("③ redémarrage pendant l'exécution — la perte n'est jamais invisible", () => {
  it("une tâche laissée « en cours » par un processus mort est NOMMÉE au démarrage", () => {
    const h = harnais();
    const nom = planifier(h, {
      quand: "dans 1 min",
      instruction: "vérifie le disque",
      nom: "Vérif disque",
      session: "session-instance",
    });
    // Simule l'état laissé par un processus tué PENDANT le job : désarmée, motif « en cours ».
    h.store.setActif(nom, false, RAISON_TACHE_EN_COURS);
    expect(h.store.get(nom)?.raisonInactive).toBe(RAISON_TACHE_EN_COURS);

    const interrompues = h.service.signalerTachesInterrompues();

    expect(interrompues.map((record) => record.nom)).toEqual([nom]);
    expect(h.store.get(nom)?.raisonInactive).toBe(RAISON_TACHE_INTERROMPUE);
    // ⚠️ Au moins un ÉVÉNEMENT DE JOURNAL : sans lui, la perte serait invisible.
    const evenements = h.evenements().filter((event) => event.event === "echec");
    expect(evenements).toHaveLength(1);
    expect(evenements[0]?.source).toBe(nom);
    expect(evenements[0]?.raison).toContain("interrompue");
    // Idempotent : un second branchement ne redit rien.
    expect(h.service.signalerTachesInterrompues()).toEqual([]);
  });

  it("rien n'est REJOUÉ au balayage suivant (aucune action deux fois)", async () => {
    const h = harnais();
    const nom = planifier(h, {
      quand: "dans 1 min",
      instruction: "supprime les fichiers temporaires",
      nom: "Nettoyage",
      session: "session-instance",
    });
    h.store.setActif(nom, false, RAISON_TACHE_EN_COURS);
    h.service.signalerTachesInterrompues();
    h.avancer(60_000);
    await h.balayeur.tick();
    expect(h.jobs.demandes).toEqual([]);
  });
});

// ── ④ REPLI DE HOST : le test CENTRAL ──────────────────────────────────────

describe("④ bot sans host démarré — AUCUN repli sur le host de l'instance", () => {
  it("⚠️ ne touche NI au sessionId, NI à un autre bot : refus nommé `bot_sans_host`", async () => {
    const h = harnais();
    const nom = planifier(h, {
      quand: "dans 2 min",
      instruction: "résume le journal",
      nom: "Rappel",
      // La conversation appartient au bot `kohai` (son host, ses JSONL).
      session: "session-kohai",
    });
    // Le host de `kohai` n'a pas démarré : c'est le waker de REFUS qui est branché.
    h.service.setWaker(hoteSansHost("kohai"));

    h.avancer(2 * 60_000);
    await h.balayeur.tick();

    // ① rien n'est exécuté, rien n'est publié, aucun fil n'est créé ailleurs
    expect(h.jobs.demandes).toEqual([]);
    expect(h.publication.publies).toEqual([]);
    expect(h.instance.newSessions).toBe(0);
    expect(h.instance.sends).toEqual([]);
    // ② le `sessionId` n'est PAS effacé (sessionAlive ne peut pas conclure)
    expect(h.store.get(nom)?.sessionId).toBe("session-kohai");
    // ③ la tâche reste ARMÉE (refus, pas échec) et le motif est NOMMÉ
    const record = h.store.get(nom) as SourceRecord;
    expect(record.actif).toBe(true);
    const refus = h.evenements().filter((event) => event.event === "refus");
    expect(refus).toHaveLength(1);
    expect(refus[0]?.raison).toContain("bot_sans_host");
  });

  it("une fois le host démarré, la tâche part dans SA conversation (report, pas perte)", async () => {
    const h = harnais();
    const nom = planifier(h, {
      quand: "dans 2 min",
      instruction: "résume le journal",
      nom: "Rappel",
      session: "session-kohai",
    });
    h.service.setWaker(hoteSansHost("kohai"));
    h.avancer(2 * 60_000);
    await h.balayeur.tick();
    expect(h.jobs.demandes).toEqual([]);

    // Le host de `kohai` démarre (il connaît SA session) : le tick suivant la tire.
    const hostDuBot = new FakeWaker(["session-kohai"]);
    h.service.setWaker(hostDuBot);
    await h.balayeur.tick();

    expect(h.jobs.demandes).toHaveLength(1);
    expect(h.jobs.demandes[0]?.lightSessionId).toBe("session-kohai");
    expect(h.store.get(nom)?.sessionId).toBe("session-kohai");
  });

  it("④-b CONTRÔLE — le repli d'origine (host de l'instance) EFFAÇAIT le sessionId", async () => {
    const h = harnais();
    const nom = planifier(h, {
      quand: "dans 2 min",
      instruction: "résume le journal",
      nom: "Rappel",
      session: "session-kohai",
    });
    // ⚠️ Comportement d'AVANT le correctif : `?? hoteSources`. Le host de l'instance ne
    // connaît pas `session-kohai` ⇒ `sessionAlive` répond `false` ⇒ conversation dite
    // « disparue », `sessionId` effacé, fil « Déclencheurs » créé CHEZ L'INSTANCE.
    h.service.setWaker(h.instance);
    h.avancer(2 * 60_000);
    await h.balayeur.tick();

    expect(h.store.get(nom)?.sessionId).toBeUndefined(); // ← le défaut, reproduit
    expect(h.instance.newSessions).toBe(1); // ← un fil créé chez l'autre bot
    expect(h.jobs.demandes[0]?.lightSessionId).toBe("session-creee-1");
  });
});
