/**
 * TÂCHES PLANIFIÉES (lot 31) — `planifier_tache` : Yuki fait AGIR un LLM à une heure dite.
 *
 * ⚠️ CE QUE CE LOT CORRIGE, ET QUI ÉTAIT FAUX EN PRODUCTION :
 *
 *  ① `analyserQuand("00:00")` à 17 h rendait AUJOURD'HUI minuit ⇒ « déjà passé » ⇒ refus.
 *    Une heure seule est pourtant la forme NATURELLE d'une demande récurrente
 *    (« tous les jours à 8 h ») : elle doit désigner la PROCHAINE occurrence, donc demain.
 *  ② « demain à 8 h » — l'exemple le plus courant — n'était pas compris du tout.
 *  ③ un échec de tâche n'était que JOURNALISÉ : la personne voyait une tâche ne rien
 *    faire, sans jamais savoir pourquoi. Il est désormais PUBLIÉ, et CONSOLIDÉ (une ligne
 *    par série d'échecs identiques, plus une clôture « retour à la normale »).
 *  ④ les FICHIERS du résultat étaient perdus : une image produite restait invisible.
 *    Ils voyagent maintenant en marqueurs `[fichier] …` dans le texte publié.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : `declencheur.type: "ponctuel"`,
 * `SourcesService.planifierTache`, `MAX_TACHES_PONCTUELLES` et l'outil `planifier_tache`
 * n'existent pas.
 *
 * ⚠️ Le temps est INJECTÉ partout (`now`) : rien n'attend 30 secondes ni une heure.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { analyserQuand, formaterInstantEnvoi } from "../../src/chat/envois/index.js";
import { EnvoisProgrammesService, EnvoisProgrammesStore } from "../../src/chat/envois/index.js";
import { TOOL_POLICY, toolAllowlist } from "../../src/llm/tool-policy.js";
import { createPlanifierTacheTools, type PlanifierTachePort } from "../../src/pi/sdk/planifier-tache-tool.js";
import { SourcesInbox } from "../../src/sources/inbox.js";
import { DeclencheurJournal, type DeclencheurJournalRecord } from "../../src/sources/journal.js";
import { DeclencheurBalayeur } from "../../src/sources/scheduler.js";
import {
  ORIGINE_HORLOGE,
  SourcesService,
  type SourcesHostEvent,
  type SourcesWaker,
} from "../../src/sources/service.js";
import { SourcesFullError, SourcesStore } from "../../src/sources/store.js";
import {
  MAX_SOURCES,
  MAX_TACHES_PONCTUELLES,
  type SourceRecord,
} from "../../src/sources/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-taches-"));
  dirs.push(dir);
  return dir;
}

/** 4 novembre 2026, 17 h 00 à Paris (= 16 h UTC). */
const T0 = Date.parse("2026-11-04T16:00:00Z");

// ── Doubles ────────────────────────────────────────────────────────────────

class FakeWaker implements SourcesWaker {
  readonly sends: Array<{ sessionId: string; text: string; origin?: string }> = [];
  readonly renamed: Array<{ sessionId: string; titre: string }> = [];
  readonly deleted: string[] = [];
  readonly knownSessions = new Set<string>(["session-ouverte"]);
  newSessions = 0;
  private readonly listeners = new Set<(event: SourcesHostEvent) => void>();
  private sessionId: string | undefined = "session-ouverte";

  currentSessionId(): string | undefined {
    return this.sessionId;
  }

  send(sessionId: string, text: string, opts?: { origin?: string }): { runId: string; sessionId: string } {
    this.sends.push({ sessionId, text, ...(opts?.origin ? { origin: opts.origin } : {}) });
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

  async renameSession(id: string, title: string): Promise<void> {
    this.renamed.push({ sessionId: id, titre: title });
  }

  async resume(file: string): Promise<{ sessionId: string }> {
    this.knownSessions.add(file);
    this.sessionId = file;
    return { sessionId: file };
  }

  async sessionFileFor(id: string): Promise<string | undefined> {
    return id;
  }

  async deleteSession(id: string): Promise<void> {
    this.deleted.push(id);
    this.knownSessions.delete(id);
  }
}

class FakeJobs {
  readonly demandes: Array<Record<string, unknown>> = [];
  readonly annules: string[] = [];
  private compteur = 0;

  async delegate(request: {
    task: string;
    context?: string;
    background?: boolean;
    lightSessionId: string;
    origin?: string;
  }): Promise<{ status: string; job_id?: string }> {
    this.demandes.push({ ...request });
    this.compteur += 1;
    return { status: "dispatched", job_id: `job-${this.compteur}` };
  }

  cancelJob(jobId: string): unknown {
    this.annules.push(jobId);
    return { status: "cancelled", job_id: jobId };
  }
}

class FakePublication {
  readonly publies: Array<{
    sessionId: string;
    texte: string;
    fichiers?: ReadonlyArray<{ id: string; nom: string; octets: number }>;
  }> = [];
  echec: string | undefined;

  async publier(
    sessionId: string,
    texte: string,
    fichiers?: ReadonlyArray<{ id: string; nom: string; octets: number }>,
  ): Promise<void> {
    if (this.echec !== undefined) throw new Error(this.echec);
    this.publies.push({ sessionId, texte, ...(fichiers !== undefined ? { fichiers } : {}) });
  }
}

interface Harnais {
  service: SourcesService;
  waker: FakeWaker;
  jobs: FakeJobs;
  publication: FakePublication;
  store: SourcesStore;
  journal: DeclencheurJournal;
  balayeur: DeclencheurBalayeur;
  avancer: (ms: number) => void;
  maintenant: () => number;
  evenements: () => DeclencheurJournalRecord[];
}

function harnais(options: { maintenant?: number; fichiers?: Record<string, { name: string; bytes: number }> } = {}): Harnais {
  const dir = tmpDir();
  const store = new SourcesStore({ path: join(dir, "sources.json") });
  const inbox = new SourcesInbox({ path: join(dir, "sources-inbox.json") });
  const journal = DeclencheurJournal.open({ path: join(dir, "declencheurs-journal.jsonl") });
  const waker = new FakeWaker();
  const jobs = new FakeJobs();
  const publication = new FakePublication();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  let maintenant = options.maintenant ?? T0;
  const service = new SourcesService({
    store,
    inbox,
    journal,
    logger,
    waker,
    jobs,
    publication,
    fichier: (id) => options.fichiers?.[id] ?? null,
    promptTotalChars: () => 4_000,
    now: () => maintenant,
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
  });
  return {
    service,
    waker,
    jobs,
    publication,
    store,
    journal,
    balayeur,
    avancer: (ms) => {
      maintenant += ms;
    },
    maintenant: () => maintenant,
    evenements: () => journal.recent(100),
  };
}

/** Laisse tourner les microtâches (résolution de `fin`, `.then` du balayeur). */
async function souffler(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ── ① L'HEURE SEULE (le blocage du plan) ────────────────────────────────────

describe("heure seule et jours relatifs — interprétation de `quand` (lot 31)", () => {
  it("⚠️ une HEURE SEULE déjà passée désigne DEMAIN, jamais un refus", () => {
    // 17 h à Paris : « 00:00 » est passé aujourd'hui ⇒ demain minuit.
    const minuit = analyserQuand("00:00", T0);
    expect(minuit.ok).toBe(true);
    if (minuit.ok) {
      expect(new Date(minuit.at).toISOString()).toBe("2026-11-04T23:00:00.000Z"); // 5/11 00:00 Paris
      expect(minuit.reporte).toBe(true);
    }
    // « 16:10 » demandé à 17 h ⇒ DEMAIN 16:10 (le report est signalé).
    const passe = analyserQuand("16:10", T0);
    expect(passe.ok).toBe(true);
    if (passe.ok) {
      expect(new Date(passe.at).toISOString()).toBe("2026-11-05T15:10:00.000Z");
      expect(passe.reporte).toBe(true);
    }
    // Une heure encore À VENIR reste aujourd'hui (aucun décalage silencieux).
    const future = analyserQuand("18:30", T0);
    expect(future.ok).toBe(true);
    if (future.ok) {
      expect(new Date(future.at).toISOString()).toBe("2026-11-04T17:30:00.000Z");
      expect(future.reporte).toBeUndefined();
    }
  });

  it("comprend `demain à 8 h` et `après-demain 18:30` (formes demandées par l'utilisateur)", () => {
    const demain = analyserQuand("demain à 8 h", T0);
    expect(demain.ok).toBe(true);
    if (demain.ok) {
      expect(new Date(demain.at).toISOString()).toBe("2026-11-05T07:00:00.000Z");
      expect(demain.jourRelatif).toBe("demain");
      // ⚠️ `demain` décale MÊME si l'heure n'est pas encore passée : c'est demandé.
      expect(demain.reporte).toBeUndefined();
    }
    const apres = analyserQuand("après-demain 18:30", T0);
    expect(apres.ok).toBe(true);
    if (apres.ok) {
      expect(new Date(apres.at).toISOString()).toBe("2026-11-06T17:30:00.000Z");
      expect(apres.jourRelatif).toBe("apres-demain");
    }
    // « demain » tout seul ne devine pas l'heure : il la réclame.
    const seul = analyserQuand("demain", T0);
    expect(seul.ok).toBe(false);
    if (!seul.ok) expect(seul.raison).toContain("Précise l'HEURE");
  });

  it("⚠️ une ISO DATÉE déjà passée reste REFUSÉE (elle nomme un jour précis)", () => {
    const passe = analyserQuand("2026-11-03T10:00:00+01:00", T0);
    expect(passe.ok).toBe(true); // la forme est lisible…
    if (passe.ok) expect(passe.at).toBeLessThan(T0); // … mais l'instant est passé
    // … et c'est le PORT qui refuse, avec une raison actionnable.
    const h = harnais();
    const refus = h.service.planifierTache({
      quand: "2026-11-03T10:00:00+01:00",
      instruction: "résume le journal",
      conversation: { session: "session-ouverte" },
    });
    expect(refus.ok).toBe(false);
    if (!refus.ok) expect(refus.raison).toContain("déjà passée");
    expect(h.store.tachesPonctuelles).toBe(0);
  });

  it("⚠️ la confirmation porte la DATE COMPLÈTE (on doit voir le report)", () => {
    const h = harnais();
    const issue = h.service.planifierTache({
      quand: "16:10",
      instruction: "génère une image de chat",
      conversation: { session: "session-ouverte" },
    });
    expect(issue.ok).toBe(true);
    if (issue.ok) {
      // 5 novembre 2026 (et pas « aujourd'hui ») : le report est VISIBLE.
      expect(issue.quandLisible).toContain("5 novembre 2026");
      expect(issue.quandLisible).toContain("16:10");
      expect(issue.libelle).toBe("génère une image de chat");
      expect(issue.nom).toBe("genere-une-image-de-chat");
    }
  });

  it("⚠️ IMPACT `programmer_envoi` : « 16:10 » à 17 h part DEMAIN, et la confirmation le dit", () => {
    const dir = tmpDir();
    const store = EnvoisProgrammesStore.open({
      path: join(dir, "envois.json"),
      now: () => T0,
    });
    const service = new EnvoisProgrammesService({
      store,
      canaux: () => [],
      publier: async () => undefined,
      logger: { info: () => {}, warn: () => {} },
      now: () => T0,
    });
    const issue = service.programmer({
      quand: "16:10",
      texte: "Coucou",
      conversation: { session: "session-ouverte" },
    });
    expect(issue.ok).toBe(true);
    if (issue.ok) {
      expect(issue.envoi.quand).toBe("2026-11-05T15:10:00.000Z");
      // Sans la date complète, la personne croirait que c'est parti aujourd'hui.
      expect(issue.quandLisible).toContain("5 novembre 2026");
      expect(issue.quandLisible).toBe(formaterInstantEnvoi(Date.parse("2026-11-05T15:10:00Z")));
    }
  });
});

// ── ② Création, exécution UNIQUE, extinction ────────────────────────────────

describe("planifier_tache — une tâche, un tir, puis extinction", () => {
  it("crée une tâche PONCTUELLE persistée, exécutée UNE SEULE fois, puis éteinte", async () => {
    const h = harnais();
    const issue = h.service.planifierTache({
      quand: "dans 2 min",
      instruction: "résume les messages non lus",
      nom: "Résumé du journal",
      conversation: { session: "session-ouverte" },
    });
    expect(issue.ok).toBe(true);

    const record = h.store.get(issue.ok ? issue.nom : "") as SourceRecord;
    expect(record.declencheur.type).toBe("ponctuel");
    expect(record.libelle).toBe("Résumé du journal");
    expect(record.perso).toBe(true);
    expect(record.sessionId).toBe("session-ouverte");
    expect(record.actif).toBe(true);

    // Pas encore l'heure : rien ne part.
    await h.balayeur.tick();
    expect(h.jobs.demandes).toEqual([]);

    // À l'heure dite : le worker lourd est réveillé avec l'INSTRUCTION.
    h.avancer(2 * 60_000);
    await h.balayeur.tick();
    expect(h.jobs.demandes).toHaveLength(1);
    const demande = h.jobs.demandes[0] as { task: string; context: string; lightSessionId: string };
    expect(demande.task).toContain("résume les messages non lus");
    expect(demande.task).toContain("AUCUNE pré-autorisation");
    expect(demande.context).toContain("Tâche planifiée");
    // ⚠️ La cible est la CONVERSATION DEMANDEUSE, pas le fil « Déclencheurs ».
    expect(demande.lightSessionId).toBe("session-ouverte");

    // ⚠️ DÉSARMÉE AVANT le lancement : même si le processus mourait maintenant, le
    // redémarrage ne la rejouerait pas.
    expect(h.store.get(record.nom)?.actif).toBe(false);

    // Le résultat revient DANS la conversation demandeuse, sans renommage.
    await h.service.recevoirResultat({
      id: "job-1",
      status: "completed",
      result: { text: "Trois messages, dont un urgent." },
    });
    await souffler();
    expect(h.publication.publies).toEqual([
      { sessionId: "session-ouverte", texte: "Trois messages, dont un urgent." },
    ]);
    expect(h.waker.renamed).toEqual([]);

    // Le motif final est celui de `DÉSACTIVER` : lisible dans `/config`.
    const apres = h.store.get(record.nom) as SourceRecord;
    expect(apres.raisonInactive).toContain("terminée :");
    expect(h.evenements().some((event) => event.event === "desactive")).toBe(true);

    // ⚠️ UN SECOND TICK NE REJOUE RIEN (aucun second tir, même une heure plus tard).
    h.avancer(60 * 60_000);
    await h.balayeur.tick();
    expect(h.jobs.demandes).toHaveLength(1);
  });

  it("un échec de la tâche est ÉTEINT avec sa raison, et n'est pas rejoué", async () => {
    const h = harnais();
    const issue = h.service.planifierTache({
      quand: "dans 1 min",
      instruction: "vérifie le disque",
      conversation: { session: "session-ouverte" },
    });
    expect(issue.ok).toBe(true);
    h.avancer(60_000);
    await h.balayeur.tick();
    await h.service.recevoirResultat({
      id: "job-1",
      status: "failed",
      error: { message: "agent hors ligne" },
    });
    await souffler();
    const record = h.store.get(issue.ok ? issue.nom : "") as SourceRecord;
    expect(record.actif).toBe(false);
    expect(record.raisonInactive).toContain("échouée :");
    expect(h.publication.publies[0]?.texte).toContain("agent hors ligne");
  });

  it("une échéance manquée de plus d'une heure n'est PAS exécutée (et le dit)", async () => {
    const h = harnais();
    const issue = h.service.planifierTache({
      quand: "dans 1 min",
      instruction: "résume le journal de 7 h",
      conversation: { session: "session-ouverte" },
    });
    expect(issue.ok).toBe(true);
    // Machine arrêtée deux heures.
    h.avancer(3 * 60 * 60_000);
    await h.balayeur.tick();
    expect(h.jobs.demandes).toEqual([]);
    const record = h.store.get(issue.ok ? issue.nom : "") as SourceRecord;
    expect(record.raisonInactive).toContain("non exécutée");
  });

  it("⚠️ deux tâches demandées avec le MÊME libellé coexistent (nom dédupliqué)", () => {
    const h = harnais();
    const premiere = h.service.planifierTache({
      quand: "dans 5 min",
      instruction: "résume le journal",
      nom: "Résumé",
      conversation: { session: "session-ouverte" },
    });
    const seconde = h.service.planifierTache({
      quand: "dans 10 min",
      instruction: "résume les mails",
      nom: "Résumé",
      conversation: { session: "session-ouverte" },
    });
    expect(premiere.ok && seconde.ok).toBe(true);
    if (premiere.ok && seconde.ok) {
      expect(premiere.nom).toBe("resume");
      expect(seconde.nom).toBe("resume-2");
    }
  });

  it("⚠️ `MAX_SOURCES` ne compte QUE les déclencheurs durables", () => {
    const h = harnais();
    for (let index = 0; index < MAX_SOURCES; index += 1) {
      h.store.create(`durable-${index}`, {});
    }
    expect(h.store.sourcesDurables).toBe(MAX_SOURCES);
    // Le quota durable est plein…
    expect(() => h.store.create("durable-de-trop", {})).toThrow(SourcesFullError);
    // … et une tâche ponctuelle passe QUAND MÊME (borne séparée).
    const issue = h.service.planifierTache({
      quand: "dans 5 min",
      instruction: "résume le journal",
      conversation: { session: "session-ouverte" },
    });
    expect(issue.ok).toBe(true);
    expect(h.store.sourcesDurables).toBe(MAX_SOURCES);
    expect(h.store.tachesPonctuelles).toBe(1);
    // … jusqu'à SA borne.
    for (let index = 1; index < MAX_TACHES_PONCTUELLES; index += 1) {
      const suivante = h.service.planifierTache({
        quand: "dans 5 min",
        instruction: `tâche ${index}`,
        conversation: { session: "session-ouverte" },
      });
      expect(suivante.ok).toBe(true);
    }
    const refus = h.service.planifierTache({
      quand: "dans 5 min",
      instruction: "une de trop",
      conversation: { session: "session-ouverte" },
    });
    expect(refus.ok).toBe(false);
    if (!refus.ok) expect(refus.raison).toContain(String(MAX_TACHES_PONCTUELLES));
  });
});

// ── ③ Publication : échecs consolidés, retour à la normale, fichiers ────────

describe("publication du résultat — échecs consolidés (B), retour à la normale, fichiers", () => {
  async function lancer(h: Harnais, instruction = "vérifie le disque"): Promise<string> {
    const issue = h.service.planifierTache({
      quand: "dans 1 min",
      instruction,
      nom: "Vérif disque",
      conversation: { session: "session-ouverte" },
    });
    if (!issue.ok) throw new Error(issue.raison);
    h.avancer(60_000);
    await h.balayeur.tick();
    return issue.nom;
  }

  /**
   * Un passage de plus d'un déclencheur RÉCURRENT.
   *
   * ⚠️ La consolidation se juge sur une SURVEILLANCE (un même déclencheur qui retombe en
   * échec), pas sur une tâche ponctuelle qui ne tire qu'une fois : c'est le cas réel
   * (« la veille échoue toutes les 5 min depuis 14:32 »).
   */
  async function passageSuivant(h: Harnais, nom: string): Promise<string> {
    // ⚠️ Le tour précédent doit avoir RENDU sa place (`fin` résolue, libération
    // asynchrone de `enVol`) : sinon le chevauchement « sauter » saute le passage et le
    // test mesurerait la mécanique du balayeur, pas la consolidation.
    await souffler();
    h.store.markPlanification(nom, {
      prochainPassage: new Date(h.maintenant()).toISOString(),
    });
    await h.balayeur.tick();
    return `job-${h.jobs.demandes.length}`;
  }

  function veille(h: Harnais, nom = "veille"): void {
    h.service.create(nom, {
      visibilite: "silencieux",
      declencheur: { type: "planning", expression: "* * * * *", fuseau: "Europe/Paris" },
      consigne: "surveille le disque",
    });
  }

  it("⚠️ le MÊME échec en SÉRIE ne publie qu'UNE ligne ; le changement de raison en publie une autre", async () => {
    const h = harnais();
    veille(h);
    const premier = await passageSuivant(h, "veille");
    await h.service.recevoirResultat({ id: premier, status: "failed", error: { message: "réseau" } });
    await souffler();
    expect(h.publication.publies).toHaveLength(1);
    expect(h.publication.publies[0]?.texte).toContain("réseau");
    // Le même échec, deux fois de plus ⇒ AUCUNE ligne de plus (jamais de rafale).
    const second = await passageSuivant(h, "veille");
    await h.service.recevoirResultat({ id: second, status: "failed", error: { message: "réseau" } });
    await souffler();
    expect(h.publication.publies).toHaveLength(1);
    expect(h.store.get("veille")?.serieEchecs?.tentatives).toBe(2);
    // Un échec DISTINCT ouvre une nouvelle série ⇒ il est publié, lui.
    const troisieme = await passageSuivant(h, "veille");
    await h.service.recevoirResultat({
      id: troisieme,
      status: "failed",
      error: { message: "disque plein" },
    });
    await souffler();
    expect(h.publication.publies).toHaveLength(2);
    expect(h.publication.publies[1]?.texte).toContain("disque plein");
  });

  it("⚠️ le RETOUR À LA NORMALE est publié, avec le compte des tentatives", async () => {
    const h = harnais();
    veille(h);
    const premier = await passageSuivant(h, "veille");
    await h.service.recevoirResultat({ id: premier, status: "failed", error: { message: "réseau" } });
    const second = await passageSuivant(h, "veille");
    await h.service.recevoirResultat({ id: second, status: "failed", error: { message: "réseau" } });
    await souffler();
    const troisieme = await passageSuivant(h, "veille");
    await h.service.recevoirResultat({
      id: troisieme,
      status: "completed",
      result: { text: "Tout va bien." },
    });
    await souffler();
    const textes = h.publication.publies.map((entree) => entree.texte);
    expect(textes).toHaveLength(3);
    expect(textes[0]).toContain("réseau");
    expect(textes[1]).toContain("retour à la normale");
    expect(textes[1]).toContain("2 tentative(s)");
    expect(textes[2]).toBe("Tout va bien.");
    // La série est refermée : plus d'échec en cours.
    expect(h.store.get("veille")?.serieEchecs).toBeUndefined();
  });

  it("⚠️ les FICHIERS du résultat sont joints en marqueurs `[fichier]` (carte cliquable)", async () => {
    const h = harnais({ fichiers: { "f-1": { name: "chat.png", bytes: 1_234 } } });
    await lancer(h, "génère une image de chat");
    await h.service.recevoirResultat({
      id: "job-1",
      status: "completed",
      result: { text: "Voici l'image.", fichiers: ["f-1"] },
    });
    await souffler();
    const publie = h.publication.publies[0];
    expect(publie?.texte).toContain("Voici l'image.");
    expect(publie?.texte).toContain("[fichier] f-1 chat.png (1234 octets)");
    // Le port reçoit AUSSI la forme structurée (rendu natif futur).
    expect(publie?.fichiers).toEqual([{ id: "f-1", nom: "chat.png", octets: 1_234 }]);
  });

  it("un fichier INTROUVABLE est COMPTÉ et DIT (jamais un marqueur inventé)", async () => {
    const h = harnais();
    await lancer(h, "génère une image de chat");
    await h.service.recevoirResultat({
      id: "job-1",
      status: "completed",
      result: { text: "Voici l'image.", fichiers: ["inconnu"] },
    });
    await souffler();
    const texte = h.publication.publies[0]?.texte ?? "";
    expect(texte).not.toContain("[fichier]");
    expect(texte).toContain("n'ont pas pu être joint(s)");
  });

  it("une tâche PONCTUELLE ne se tait JAMAIS sur `RIEN` (elle a été demandée)", async () => {
    const h = harnais();
    await lancer(h);
    await h.service.recevoirResultat({ id: "job-1", status: "completed", result: { text: "RIEN" } });
    await souffler();
    expect(h.publication.publies).toHaveLength(1);
    expect(h.publication.publies[0]?.texte).toBe("RIEN");
  });
});

// ── ④ L'outil : description, garde de rôle ─────────────────────────────────

describe("outil `planifier_tache` — ce que le modèle lit, et qui y a droit", () => {
  it("écrit DANS LE RÉSULTAT le nom, l'instant (date complète) et la cible", async () => {
    const h = harnais();
    const port: PlanifierTachePort = {
      planifier: async (request) => h.service.planifierTache(request),
    };
    const [tool] = createPlanifierTacheTools(port, {
      conversation: () => ({ session: "session-ouverte" }),
    }) as unknown as Array<{
      description: string;
      execute: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    }>;
    if (!tool) throw new Error("aucun outil `planifier_tache` construit");

    // ⚠️ La description doit DISTINGUER les deux capacités, sinon le modèle choisit au
    // hasard et un texte figé part par un tour de modèle.
    expect(tool.description).toContain("programmer_envoi");
    expect(tool.description).toContain("UN SEUL APPEL");
    expect(tool.description).toContain("AUCUNE pré-autorisation");

    const resultat = await tool.execute("call-1", {
      quand: "demain à 8 h",
      instruction: "résume le journal",
      nom: "Résumé du journal",
    });
    const texte = resultat.content.map((part) => part.text ?? "").join("\n");
    expect(texte).toContain("Résumé du journal");
    expect(texte).toContain("5 novembre 2026");
    expect(texte).toContain("8:00");
    expect(texte).toContain("cette conversation");
    expect(texte).toContain("UNE seule fois");
  });

  it("⚠️ le WORKER LOURD n'a pas l'outil (invariant « un seul rédacteur »)", () => {
    expect(TOOL_POLICY.heavy.planifierTaches).toEqual([]);
    expect(TOOL_POLICY.light.planifierTaches).toEqual(["planifier_tache"]);
    // Même avec l'option activée, l'allowlist du lourd ne le contient pas.
    expect(toolAllowlist("heavy", { planifierTacheEnabled: true })).not.toContain(
      "planifier_tache",
    );
    expect(toolAllowlist("light", { planifierTacheEnabled: true })).toContain("planifier_tache");
    // ⚠️ Groupe `toujours` : aucun réglage d'accès distant ne doit le masquer.
    const nomsHeavy = [
      ...TOOL_POLICY.heavy.builtins,
      ...TOOL_POLICY.heavy.custom,
      ...TOOL_POLICY.heavy.execution,
      ...TOOL_POLICY.heavy.planifierTaches,
    ];
    expect(nomsHeavy).not.toContain("planifier_tache");
  });
});
