/**
 * MOTEUR HORLOGE (lot 26, lot 2/4) — évaluateur appliqué, BALAYEUR, rattrapage,
 * chevauchement, plafond, garde-fou quotidien, `DÉSACTIVER`, et la voie
 * « le déclencheur crée un JOB LOURD ».
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : ni `src/sources/cron.ts`, ni
 * `src/sources/scheduler.ts`, ni `SourcesService.declencher` n'existent
 * (`git show HEAD:src/sources/types.ts` ne connaît que
 * `declencheur: { type: "webhook" }`).
 *
 * ⚠️ ARCHITECTURE VÉRIFIÉE ICI (décision 2026-11-04) :
 *
 *     déclencheur → JOB LOURD → résultat publié dans le fil « Déclencheurs »
 *
 * Aucun tour de conversation, aucune délégation depuis le rôle léger.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { TOOL_POLICY } from "../../src/llm/tool-policy.js";
import { SourcesInbox } from "../../src/sources/inbox.js";
import { DeclencheurJournal, type DeclencheurJournalRecord } from "../../src/sources/journal.js";
import { DeclencheurBalayeur, raisonGardeFouQuotidien } from "../../src/sources/scheduler.js";
import {
  ORIGINE_HORLOGE,
  RAISON_DESACTIVATION,
  SourcesService,
  tacheDeDeclencheur,
  type SourcesHostEvent,
  type SourcesWaker,
} from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";
import {
  DEFAULT_PLAFOND_MS,
  DECLENCHEURS_SESSION_TITLE,
  type SourceRecord,
} from "../../src/sources/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── Doubles ────────────────────────────────────────────────────────────────

/** Host Pi minimal : le chemin « job » ne doit PAS lui envoyer de tour. */
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

  send(
    sessionId: string,
    text: string,
    opts?: { origin?: string },
  ): { runId: string; sessionId: string } {
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

/** Port des tâches de fond : enregistre les délégations, rend un `job_id`. */
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

/** Port de publication : retient les textes écrits dans le fil. */
class FakePublication {
  readonly publies: Array<{ sessionId: string; texte: string }> = [];
  echec: string | undefined;

  async publier(sessionId: string, texte: string): Promise<void> {
    if (this.echec !== undefined) throw new Error(this.echec);
    this.publies.push({ sessionId, texte });
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
  evenements: () => DeclencheurJournalRecord[];
}

function harnais(options: { maintenant?: number } = {}): Harnais {
  const dir = mkdtempSync(join(tmpdir(), "yuki-horloge-"));
  dirs.push(dir);
  const store = new SourcesStore({ path: join(dir, "sources.json") });
  const inbox = new SourcesInbox({ path: join(dir, "sources-inbox.json") });
  const journal = DeclencheurJournal.open({ path: join(dir, "declencheurs-journal.jsonl") });
  const waker = new FakeWaker();
  const jobs = new FakeJobs();
  const publication = new FakePublication();
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  let maintenant = options.maintenant ?? Date.parse("2026-06-01T06:00:00Z");
  const service = new SourcesService({
    store,
    inbox,
    journal,
    logger,
    waker,
    jobs,
    publication,
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
    evenements: () => journal.recent(100),
  };
}

/** Déclare un déclencheur PLANIFIÉ (expression en Europe/Paris). */
function declarePlanning(
  h: Harnais,
  nom: string,
  expression: string,
  settings: Record<string, unknown> = {},
): void {
  h.service.create(nom, {
    visibilite: "silencieux",
    declencheur: { type: "planning", expression, fuseau: "Europe/Paris" },
    ...settings,
  } as never);
}

// ── ① Le déclencheur crée un JOB LOURD (pas un tour de conversation) ────────

describe("moteur horloge — le déclencheur crée un JOB LOURD", () => {
  it("un passage planifié délègue au worker lourd, sans AUCUN tour de conversation", async () => {
    const h = harnais();
    declarePlanning(h, "veille", "*/5 * * * *", { consigne: "si rien d'anormal, ne dis rien" });

    const resultat = await h.service.declencher("veille", {
      origine: ORIGINE_HORLOGE,
      planifie: Date.parse("2026-06-01T06:00:00Z"),
    });

    expect(resultat.outcome).toBe("started");
    expect(resultat.runId).toBe("job-1");
    // ⚠️ AUCUN `send` : ce n'est pas un tour de conversation.
    expect(h.waker.sends).toEqual([]);
    // Le job porte l'ORIGINE, la tâche de fond, et le fil « Déclencheurs ».
    expect(h.jobs.demandes).toHaveLength(1);
    const demande = h.jobs.demandes[0] as {
      task: string;
      context: string;
      background: boolean;
      lightSessionId: string;
      origin: string;
    };
    expect(demande.background).toBe(true);
    // ⚠️ LOT 4/4 : l'origine PORTE le NOM du déclencheur — c'est par elle que le
    // garde-fou retrouve la pré-autorisation qui s'applique.
    expect(demande.origin).toBe("declencheur:veille");
    expect(demande.lightSessionId).toBe("session-creee-1");
    // ⚠️ Le job reçoit la CONSIGNE, le contenu ENCADRÉ, la règle RIEN et DÉSACTIVER.
    expect(demande.task).toContain("si rien d'anormal, ne dis rien");
    expect(demande.task).toContain("réponds exactement RIEN");
    expect(demande.task).toContain("DÉSACTIVER");
    expect(demande.task).toContain("APPROBATION humaine");
    expect(demande.context).toContain("<sources>");
    expect(demande.context).toContain("Réveil planifié");
  });

  it("le worker lourd a DÉJÀ les outils d'action et AUCUN outil de déclenchement", () => {
    // ⚠️ Anti-enchaînement STRUCTUREL : le lourd ne peut pas créer de déclencheur
    // (pas d'outil pour cela) et ne redélègue pas non plus.
    expect(TOOL_POLICY.heavy.canDelegate).toBe(false);
    expect(TOOL_POLICY.heavy.custom).toEqual([]);
    expect(TOOL_POLICY.heavy.execution.length).toBeGreaterThan(0);
    const noms = [
      ...TOOL_POLICY.heavy.builtins,
      ...TOOL_POLICY.heavy.custom,
      ...TOOL_POLICY.heavy.execution,
    ];
    expect(noms).not.toContain("delegate");
    expect(noms.some((nom) => nom.includes("source") || nom.includes("declencheur"))).toBe(false);
  });

  it("⚠️ un déclencheur ne peut PAS en déclencher un autre (origine refusée)", async () => {
    const h = harnais();
    declarePlanning(h, "veille", "*/5 * * * *");
    const refus = await h.service.declencher("veille", { origine: "declencheur" });
    expect(refus.outcome).toBe("refuse");
    expect(refus.raison).toContain("ne peut pas en déclencher un autre");
    expect(h.jobs.demandes).toEqual([]);
    expect(h.evenements().some((event) => event.event === "refus")).toBe(true);
  });

  it("un déclencheur en veille ne lance rien (raison visible)", async () => {
    const h = harnais();
    declarePlanning(h, "veille", "*/5 * * * *", { actif: false });
    const refus = await h.service.declencher("veille");
    expect(refus.outcome).toBe("refuse");
    expect(refus.raison).toContain("en veille");
    expect(h.jobs.demandes).toEqual([]);
  });
});

// ── ② Le résultat du job : RIEN / publié / DÉSACTIVER ──────────────────────

describe("moteur horloge — résultat du job", () => {
  async function lancer(h: Harnais): Promise<string> {
    declarePlanning(h, "veille", "*/5 * * * *");
    const resultat = await h.service.declencher("veille", { origine: ORIGINE_HORLOGE });
    expect(resultat.outcome).toBe("started");
    return resultat.runId as string;
  }

  it("un texte est publié dans le fil « Déclencheurs » (et le fil est nommé)", async () => {
    const h = harnais();
    const jobId = await lancer(h);

    await h.service.recevoirResultat({
      id: jobId,
      status: "completed",
      result: { text: "Le disque est plein à 96 %." },
    });

    expect(h.publication.publies).toEqual([
      { sessionId: "session-creee-1", texte: "Le disque est plein à 96 %." },
    ]);
    expect(h.store.getDeclencheursSession()).toBe("session-creee-1");
    expect(h.waker.renamed).toEqual([
      { sessionId: "session-creee-1", titre: DECLENCHEURS_SESSION_TITLE },
    ]);
    const publie = h.evenements().find((event) => event.event === "publie");
    expect(publie?.texte).toContain("disque est plein");
    expect(publie?.sessionId).toBe("session-creee-1");
    // Aucun tour de conversation n'a été lancé.
    expect(h.waker.sends).toEqual([]);
  });

  it("`RIEN` ⇒ RIEN n'est publié, journal `silence`, fil candidat supprimé", async () => {
    const h = harnais();
    const jobId = await lancer(h);
    await h.service.recevoirResultat({
      id: jobId,
      status: "completed",
      result: { text: "`Rien.`" },
    });
    expect(h.publication.publies).toEqual([]);
    expect(h.store.getDeclencheursSession()).toBeUndefined();
    expect(h.waker.deleted).toEqual(["session-creee-1"]);
    expect(h.evenements().some((event) => event.event === "silence")).toBe(true);
  });

  it("`DÉSACTIVER` ⇒ marqueur RETIRÉ du texte publié, `actif = false`, raison persistée", async () => {
    const h = harnais();
    const jobId = await lancer(h);
    await h.service.recevoirResultat({
      id: jobId,
      status: "completed",
      result: { text: "Plus rien à surveiller.\n\n**DÉSACTIVER**" },
    });

    // Le texte publié ne CONTIENT PLUS le marqueur.
    expect(h.publication.publies).toEqual([
      { sessionId: "session-creee-1", texte: "Plus rien à surveiller." },
    ]);
    const publie = h.evenements().find((event) => event.event === "publie");
    expect(publie?.texte).toBe("Plus rien à surveiller.");
    expect(publie?.texte).not.toContain("DÉSACTIVER");

    const record = h.store.get("veille") as SourceRecord;
    expect(record.actif).toBe(false);
    expect(record.etat).toBe("suspendu");
    expect(record.raisonInactive).toBe(RAISON_DESACTIVATION);
    expect(h.evenements().some((event) => event.event === "desactive")).toBe(true);
  });

  it("`DÉSACTIVER` seul ⇒ aucun texte publié, mais le déclencheur est éteint", async () => {
    const h = harnais();
    const jobId = await lancer(h);
    await h.service.recevoirResultat({ id: jobId, status: "completed", result: { text: "DÉSACTIVER" } });
    expect(h.publication.publies).toEqual([]);
    expect((h.store.get("veille") as SourceRecord).actif).toBe(false);
  });

  it("un job en échec n'est jamais publié : journal `echec` avec la raison", async () => {
    const h = harnais();
    const jobId = await lancer(h);
    await h.service.recevoirResultat({
      id: jobId,
      status: "failed",
      error: { message: "agent hors ligne" },
    });
    expect(h.publication.publies).toEqual([]);
    const echec = h.evenements().find((event) => event.event === "echec");
    expect(echec?.raison).toContain("agent hors ligne");
  });

  it("un résultat de job INCONNU est ignoré (aucune publication surprise)", async () => {
    const h = harnais();
    await h.service.recevoirResultat({
      id: "job-inconnu",
      status: "completed",
      result: { text: "x" },
    });
    expect(h.publication.publies).toEqual([]);
  });
});

// ── ③ Balayeur : armement, rattrapage, reprise ─────────────────────────────

describe("balayeur — armement et reprise après redémarrage", () => {
  it("crée un déclencheur armé IMMÉDIATEMENT (prochain passage calculé et PERSISTÉ)", () => {
    const h = harnais();
    declarePlanning(h, "matin", "0 9 * * *");
    const record = h.store.get("matin") as SourceRecord;
    // 9 h à Paris = 07:00Z (CEST), surtout pas 09:00Z : le fuseau du déclencheur.
    expect(record.prochainPassage).toBe("2026-06-01T07:00:00.000Z");
  });

  it("un passage manqué de 10 min est RATTRAPÉ (une seule fois)", async () => {
    const h = harnais({ maintenant: Date.parse("2026-06-01T06:10:00Z") });
    declarePlanning(h, "veille", "*/5 * * * *");
    // On force un passage dépassé de 10 min (comme après un redémarrage).
    h.store.markPlanification("veille", { prochainPassage: "2026-06-01T06:00:00.000Z" });

    await h.balayeur.tick();

    expect(h.jobs.demandes).toHaveLength(1);
    const record = h.store.get("veille") as SourceRecord;
    expect(record.dernierPassage).toBe("2026-06-01T06:00:00.000Z");
    // Réarmé APRÈS maintenant : un second tick ne rejoue PAS le même passage.
    expect(Date.parse(record.prochainPassage as string)).toBeGreaterThan(
      Date.parse("2026-06-01T06:10:00Z"),
    );
    await h.balayeur.tick();
    expect(h.jobs.demandes).toHaveLength(1);
  });

  it("un passage manqué de plus d'1 h est SAUTÉ et JOURNALISÉ", async () => {
    const h = harnais({ maintenant: Date.parse("2026-06-01T08:30:00Z") });
    declarePlanning(h, "veille", "*/5 * * * *");
    h.store.markPlanification("veille", { prochainPassage: "2026-06-01T06:00:00.000Z" });

    await h.balayeur.tick();

    expect(h.jobs.demandes).toEqual([]);
    const saut = h.evenements().find((event) => event.event === "saut");
    expect(saut?.raison).toContain("Passage manqué de 150 min");
  });

  it("`rattrapage: sauter` ne rattrape JAMAIS un passage manqué", async () => {
    const h = harnais({ maintenant: Date.parse("2026-06-01T06:03:00Z") });
    declarePlanning(h, "veille", "*/5 * * * *", { rattrapage: "sauter" });
    h.store.markPlanification("veille", { prochainPassage: "2026-06-01T06:00:00.000Z" });
    await h.balayeur.tick();
    expect(h.jobs.demandes).toEqual([]);
    expect(h.evenements().some((event) => event.event === "saut")).toBe(true);
  });

  it("`start()` traite TOUT DE SUITE un passage dépassé (reprise après redémarrage)", async () => {
    const h = harnais({ maintenant: Date.parse("2026-06-01T06:10:00Z") });
    declarePlanning(h, "veille", "*/5 * * * *");
    // État RELU du disque : le passage était prévu avant l'arrêt.
    h.store.markPlanification("veille", { prochainPassage: "2026-06-01T06:05:00.000Z" });
    h.balayeur.start();
    // `start()` déclenche un tick immédiat (asynchrone) : on le laisse s'exécuter.
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.balayeur.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.jobs.demandes).toHaveLength(1);
  });

  it("un déclencheur EN VEILLE n'est jamais balayé", async () => {
    const h = harnais({ maintenant: Date.parse("2026-06-01T06:10:00Z") });
    declarePlanning(h, "veille", "*/5 * * * *", { actif: false });
    h.store.markPlanification("veille", { prochainPassage: "2026-06-01T06:00:00.000Z" });
    await h.balayeur.tick();
    expect(h.jobs.demandes).toEqual([]);
  });
});

// ── ④ Chevauchement ────────────────────────────────────────────────────────

describe("balayeur — chevauchement", () => {
  async function premierPassageEnVol(h: Harnais): Promise<void> {
    h.store.markPlanification("veille", { prochainPassage: "2026-06-01T06:00:00.000Z" });
    await h.balayeur.tick();
    expect(h.jobs.demandes).toHaveLength(1);
    expect(h.balayeur.enCours("veille")).toBe(true);
  }

  it("défaut (`sauter`) : un second passage est SAUTÉ tant que le job tourne", async () => {
    const h = harnais({ maintenant: Date.parse("2026-06-01T06:00:00Z") });
    declarePlanning(h, "veille", "* * * * *");
    await premierPassageEnVol(h);

    h.avancer(60_000);
    await h.balayeur.tick();

    expect(h.jobs.demandes).toHaveLength(1);
    expect(h.jobs.annules).toEqual([]);
    const saut = h.evenements().filter((event) => event.event === "saut");
    expect(saut.some((event) => (event.raison ?? "").includes("encore en cours"))).toBe(true);
  });

  it("`remplacer` : l'ancien job est ANNULÉ au profit du nouveau", async () => {
    const h = harnais({ maintenant: Date.parse("2026-06-01T06:00:00Z") });
    declarePlanning(h, "veille", "* * * * *", { chevauchement: "remplacer" });
    await premierPassageEnVol(h);

    h.avancer(60_000);
    await h.balayeur.tick();

    expect(h.jobs.annules).toEqual(["job-1"]);
    expect(h.jobs.demandes).toHaveLength(2);
    const saut = h.evenements().filter((event) => event.event === "saut");
    expect(saut.some((event) => (event.raison ?? "").includes("remplacer"))).toBe(true);
  });

  it("la place est LIBÉRÉE à la fin réelle du job", async () => {
    const h = harnais({ maintenant: Date.parse("2026-06-01T06:00:00Z") });
    declarePlanning(h, "veille", "* * * * *");
    await premierPassageEnVol(h);
    await h.service.recevoirResultat({ id: "job-1", status: "completed", result: { text: "RIEN" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.balayeur.enCours("veille")).toBe(false);
  });
});

// ── ⑤ Plafond d'exécution ──────────────────────────────────────────────────

describe("balayeur — plafond d'exécution", () => {
  it("plafond par défaut : 10 min (borné 60 s – 2 h)", () => {
    const h = harnais();
    declarePlanning(h, "veille", "*/5 * * * *");
    expect((h.store.get("veille") as SourceRecord).plafondMs).toBe(DEFAULT_PLAFOND_MS);
    expect(() => h.store.update("veille", { plafondMs: 1_000 })).toThrow(/hors bornes/);
    expect(() => h.store.update("veille", { plafondMs: 3 * 60 * 60 * 1000 })).toThrow(
      /hors bornes/,
    );
  });

  it("un job de 20 min avec un plafond de 10 min est ANNULÉ et journalisé", async () => {
    const h = harnais({ maintenant: Date.parse("2026-06-01T06:00:00Z") });
    declarePlanning(h, "veille", "* * * * *", { plafondMs: 10 * 60 * 1000 });
    h.store.markPlanification("veille", { prochainPassage: "2026-06-01T06:00:00.000Z" });
    await h.balayeur.tick();
    expect(h.jobs.demandes).toHaveLength(1);

    // Le temps passe jusqu'au plafond : le minuteur injecté n'existe pas ici, on
    // déclenche donc l'abandon comme le ferait le `setTimeout` du balayeur.
    const signal = h.balayeur["enVol"].get("veille")?.controller as AbortController;
    expect(signal).toBeDefined();
    signal.abort("plafond");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.jobs.annules).toEqual(["job-1"]);
    const plafond = h.evenements().find((event) => event.event === "plafond");
    expect(plafond?.raison).toContain("Plafond d'exécution atteint");
    expect(h.balayeur.enCours("veille")).toBe(false);
    expect(h.publication.publies).toEqual([]);
  });
});

// ── ⑥ Garde-fou quotidien ──────────────────────────────────────────────────

describe("balayeur — garde-fou quotidien (maxToursParJour)", () => {
  it("au-delà du plafond : `actif = false`, raison VISIBLE et journal `desactive`", async () => {
    const h = harnais({ maintenant: Date.parse("2026-06-01T06:00:00Z") });
    declarePlanning(h, "veille", "* * * * *", { maxToursParJour: 1 });
    h.store.markPlanification("veille", { prochainPassage: "2026-06-01T06:00:00.000Z" });
    await h.balayeur.tick();
    // Fin du premier tour : la place est libérée.
    await h.service.recevoirResultat({ id: "job-1", status: "completed", result: { text: "RIEN" } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    h.avancer(60_000);
    await h.balayeur.tick();

    const record = h.store.get("veille") as SourceRecord;
    expect(record.actif).toBe(false);
    expect(record.raisonInactive).toBe(raisonGardeFouQuotidien(1, "2026-06-01"));
    expect(h.evenements().some((event) => event.event === "desactive")).toBe(true);
    expect(h.jobs.demandes).toHaveLength(1);
  });

  it("le compteur est PAR JOUR LOCAL (le fuseau du déclencheur décide)", () => {
    const h = harnais();
    declarePlanning(h, "veille", "*/5 * * * *");
    expect(h.store.incrementerTour("veille", "2026-06-01")).toBe(1);
    expect(h.store.incrementerTour("veille", "2026-06-01")).toBe(2);
    expect(h.store.incrementerTour("veille", "2026-06-02")).toBe(1);
    expect((h.store.get("veille") as SourceRecord).toursDuJour).toEqual({
      jour: "2026-06-02",
      compte: 1,
    });
  });
});

// ── ⑦ La tâche transmise au worker lourd ───────────────────────────────────

describe("tâche du déclelencheur — règles écrites une seule fois", () => {
  it("porte la consigne, RIEN, DÉSACTIVER et la limite des approbations", () => {
    const tache = tacheDeDeclencheur({
      nom: "veille",
      expression: "0 3 * * *",
      fuseau: "Europe/Paris",
      consigne: "surveille le disque",
      quand: "2026-06-01T01:00:00.000Z",
    });
    expect(tache).toContain("« veille »");
    expect(tache).toContain("surveille le disque");
    expect(tache).toContain("réponds exactement RIEN");
    expect(tache).toContain("DÉSACTIVER");
    // ⚠️ Sans pré-autorisation (lot 4), une action à approbation ÉCHOUE : la tâche
    // doit le dire pour que le modèle ne reste pas bloqué.
    expect(tache).toContain("APPROBATION humaine");
    expect(tache).toContain("ne reste pas bloquée");
  });
});

// ── ⑧ Approbations : établir le comportement réel ──────────────────────────

describe("approbations — une tâche de fond ne peut pas en obtenir", () => {
  it("`run_command` rend `awaiting_validation` IMMÉDIATEMENT (aucune attente infinie)", async () => {
    // ⚠️ PREUVE : `src/agents/execution.ts:672-687` renvoie `awaiting_validation`
    // SANS attendre — la commande n'est PAS exécutée et la demande expire après
    // `APPROVAL_TTL_MS` (5 min, `src/agents/approvals.ts:86`). Le comportement est
    // déjà verrouillé par `tests/agents/execution.test.ts:205-214` (niveau 2 :
    // `awaiting_validation`, puis exécution APRÈS approbation humaine).
    //
    // Ici on prouve le maillon qui compte pour un JOB : l'outil relaie l'issue
    // telle quelle, sans réessayer ni attendre (donc pas de blocage du worker).
    const { createExecutionTools } = await import("../../src/pi/sdk/execution-tools.js");
    const execute = vi.fn(async () => ({
      status: "awaiting_validation" as const,
      agentId: "nuc00",
      agentName: "nuc00",
      command: "systemctl poweroff",
      destructive: true,
      destructiveIds: [],
      exitCode: null,
      approvalId: "apr-1",
      message:
        "Validation humaine requise : la commande n'a PAS été exécutée. " +
        "Une demande d'approbation s'affiche dans la conversation : un humain doit " +
        "valider ou refuser.",
    }));
    const tools = createExecutionTools({ execute } as never);
    const outil = tools.find((tool) => tool.name === "run_command");
    expect(outil).toBeDefined();

    const debut = Date.now();
    const resultat = (await outil?.execute(
      "call-1",
      { agent_id: "nuc00", command: "systemctl poweroff" },
      undefined as never,
      undefined as never,
      { sessionManager: { getSessionId: () => "session-job" } } as never,
    )) as { content: Array<{ type: string; text: string }> };
    const duree = Date.now() - debut;

    // ⚠️ Aucune attente : la tâche de fond n'est jamais suspendue à une approbation.
    expect(duree).toBeLessThan(1_000);
    const texte = resultat.content[0]?.text ?? "";
    expect(texte).toContain("awaiting_validation");
    expect(texte).toContain("n'a PAS été exécutée");
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
