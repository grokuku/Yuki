/**
 * DIAGNOSTIC DES OUTILS D'UNE TÂCHE DIFFÉRÉE (2026-11-16) — un échec NOMME la
 * cause au lieu de la faire deviner.
 *
 * ⚠️ LE DÉFAUT VERROUILLÉ (signalé par le bot lui-même) : une tâche planifiée
 * s'est réveillée SANS les outils du libraire, n'a rien pu vérifier, et a rendu
 * un rapport d'échec — le modèle a dû DEVINER pourquoi (« le site est
 * inaccessible »). Désormais : le contexte du job nomme les outils absents, le
 * journal les nomme, et le rapport publié les CITE.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine :
 *  - le module `src/sources/outils-differes.ts` n'existe pas ;
 *  - `SourcesService` n'accepte ni `botId` ni `outilsDifferes` : aucun échec n'y
 *    nomme l'outil manquant, et le contexte du job ne dit rien.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SourcesInbox } from "../../src/sources/inbox.js";
import { DeclencheurJournal } from "../../src/sources/journal.js";
import {
  blocOutilsManquants,
  diagnostiquerOutilsDifferes,
  OUTILS_DE_VERIFICATION,
  suffixeOutilsManquants,
} from "../../src/sources/outils-differes.js";
import { DeclencheurBalayeur } from "../../src/sources/scheduler.js";
import { ORIGINE_HORLOGE, SourcesService } from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-outils-differes-"));
  dirs.push(dir);
  return dir;
}

/** 4 novembre 2026, 17 h 00 à Paris (= 16 h UTC). */
const T0 = Date.parse("2026-11-04T16:00:00Z");

// ── ② LE DIAGNOSTIC : l'échec NOMME l'outil manquant ────────────────────────

describe("diagnostic — un échec différé NOMME la cause", () => {
  it("tous les outils présents ⇒ AUCUNE phrase (pas de bruit dans une tâche normale)", () => {
    const diagnostic = diagnostiquerOutilsDifferes(["read", ...OUTILS_DE_VERIFICATION], "yuki");
    expect(diagnostic.manquants).toEqual([]);
    expect(diagnostic.phrase).toBeUndefined();
    expect(blocOutilsManquants(diagnostic)).toBeUndefined();
    expect(suffixeOutilsManquants(diagnostic)).toBe("");
  });

  it("⚠️ outils absents ⇒ la phrase CITE les outils ET nomme le bot et la capacité", () => {
    const diagnostic = diagnostiquerOutilsDifferes(["read", "run_command"], "yuki");
    expect(diagnostic.manquants).toEqual(OUTILS_DE_VERIFICATION);
    expect(diagnostic.capacites).toEqual(["libraire", "web"]);
    const phrase = diagnostic.phrase ?? "";
    expect(phrase).toContain("recherche_libraire");
    expect(phrase).toContain("lire_page_web");
    expect(phrase).toContain("« yuki »");
    expect(phrase).toContain("capacité");
    // ⚠️ Et la phrase ne fait pas croire à une panne du site consulté.
    expect(phrase).toContain("PAS une panne");
  });

  it("une seule capacité manquante est nommée (pas « libraire et web » à tort)", () => {
    const diagnostic = diagnostiquerOutilsDifferes(
      ["recherche_libraire", "liste_libraire", "lire_libraire", "archive_libraire"],
      "grolaf",
    );
    expect(diagnostic.manquants).toEqual(["lire_page_web"]);
    expect(diagnostic.capacites).toEqual(["web"]);
    expect(diagnostic.phrase).toContain("« web »");
  });

  it("le bloc de contexte INTERDIT d'inventer une valeur", () => {
    const bloc = blocOutilsManquants(diagnostiquerOutilsDifferes([], "yuki")) ?? "";
    expect(bloc).toContain("OUTILS ABSENTS");
    expect(bloc).toContain("recherche_libraire");
    expect(bloc).toContain("n'invente AUCUNE valeur");
  });
});

// ── ③ LE SERVICE : contexte du job + rapport d'échec ────────────────────────

class FakeJobs {
  readonly demandes: Array<Record<string, unknown>> = [];

  async delegate(request: {
    task: string;
    context?: string;
    background?: boolean;
    lightSessionId: string;
    origin?: string;
  }): Promise<{ status: string; job_id?: string }> {
    this.demandes.push({ ...request });
    return { status: "dispatched", job_id: `job-${this.demandes.length}` };
  }

  cancelJob(jobId: string): unknown {
    return { status: "cancelled", job_id: jobId };
  }
}

class FakePublication {
  readonly publies: Array<{ sessionId: string; texte: string }> = [];

  async publier(sessionId: string, texte: string): Promise<void> {
    this.publies.push({ sessionId, texte });
  }
}

class FakeWaker {
  readonly knownSessions = new Set<string>(["session-ouverte"]);

  currentSessionId(): string | undefined {
    return "session-ouverte";
  }

  send(): { runId: string; sessionId: string } {
    return { runId: "run", sessionId: "session-ouverte" };
  }

  subscribeAll(): () => void {
    return () => undefined;
  }

  async newSession(): Promise<{ sessionId: string }> {
    this.knownSessions.add("session-creee");
    return { sessionId: "session-creee" };
  }

  async listSessions(): Promise<Array<{ sessionId: string; title: string }>> {
    return [...this.knownSessions].map((sessionId) => ({ sessionId, title: sessionId }));
  }

  async renameSession(): Promise<void> {
    return undefined;
  }

  async resume(): Promise<{ sessionId: string }> {
    return { sessionId: "session-ouverte" };
  }

  async sessionFileFor(): Promise<string | undefined> {
    return "session-ouverte";
  }

  async deleteSession(): Promise<void> {
    return undefined;
  }
}

interface Harnais {
  service: SourcesService;
  jobs: FakeJobs;
  publication: FakePublication;
  store: SourcesStore;
  journal: DeclencheurJournal;
  balayeur: DeclencheurBalayeur;
  avancer: (ms: number) => void;
}

function harnais(outilsDifferes?: () => readonly string[]): Harnais {
  const dir = tmpDir();
  const store = new SourcesStore({ path: join(dir, "sources.json") });
  const inbox = new SourcesInbox({ path: join(dir, "sources-inbox.json") });
  const journal = DeclencheurJournal.open({ path: join(dir, "journal.jsonl") });
  const jobs = new FakeJobs();
  const publication = new FakePublication();
  let maintenant = T0;
  const service = new SourcesService({
    store,
    inbox,
    journal,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    waker: new FakeWaker() as never,
    jobs,
    publication,
    promptTotalChars: () => 4_000,
    now: () => maintenant,
    botId: "yuki",
    ...(outilsDifferes !== undefined ? { outilsDifferes } : {}),
  });
  service.attach();
  const balayeur = new DeclencheurBalayeur({
    store,
    journal,
    logger: { info: () => {}, warn: () => {} },
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
    jobs,
    publication,
    store,
    journal,
    balayeur,
    avancer: (ms) => {
      maintenant += ms;
    },
  };
}

/** Laisse tourner les microtâches (résolution de `fin`, `.then` du balayeur). */
async function souffler(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Programme une tâche « dans 1 min » et la fait tirer ; rend l'identifiant du job. */
async function tacheTiree(h: Harnais): Promise<string> {
  const issue = h.service.planifierTache({
    quand: "dans 1 min",
    instruction: "relève les prix sur ces trois pages",
    conversation: { session: "session-ouverte" },
  });
  expect(issue.ok).toBe(true);
  // ⚠️ Le temps est INJECTÉ : rien n'attend une minute réelle.
  h.avancer(60_000);
  await h.balayeur.tick();
  await souffler();
  expect(h.jobs.demandes).toHaveLength(1);
  return `job-${h.jobs.demandes.length}`;
}

describe("SourcesService — la tâche différée SAIT ce qui lui manque", () => {
  it("outils présents ⇒ le contexte du job ne parle PAS d'outils manquants", async () => {
    const h = harnais(() => ["read", "run_command", ...OUTILS_DE_VERIFICATION]);
    await tacheTiree(h);
    const contexte = String(h.jobs.demandes[0]?.context ?? "");
    expect(contexte).not.toContain("OUTILS ABSENTS");
    expect(h.publication.publies).toEqual([]);
  });

  it("⚠️ outils absents ⇒ le CONTEXTE du job les nomme (le worker ne devine pas)", async () => {
    const h = harnais(() => ["read", "run_command"]);
    await tacheTiree(h);
    const contexte = String(h.jobs.demandes[0]?.context ?? "");
    expect(contexte).toContain("OUTILS ABSENTS");
    expect(contexte).toContain("recherche_libraire");
    expect(contexte).toContain("lire_page_web");
    // Le journal garde la trace de la cause, en clair.
    expect(h.journal.recent(20).some((e) => (e.raison ?? "").includes("recherche_libraire"))).toBe(
      true,
    );
  });

  it("⚠️ échec ⇒ le rapport publié CITE l'outil manquant (pas « la tâche a échoué »)", async () => {
    const h = harnais(() => ["read"]);
    const jobId = await tacheTiree(h);
    await h.service.recevoirResultat({
      id: jobId,
      status: "failed",
      error: { message: "aucune source vérifiable" },
    });
    await souffler();
    const texte = h.publication.publies[0]?.texte ?? "";
    expect(texte).toContain("aucune source vérifiable");
    expect(texte).toContain("Outils manquants");
    expect(texte).toContain("recherche_libraire");
    expect(texte).toContain("« yuki »");
  });

  it("⚠️ tâche CONCLUE malgré l'absence ⇒ la cause est ajoutée au rapport publié", async () => {
    const h = harnais(() => ["read"]);
    const jobId = await tacheTiree(h);
    await h.service.recevoirResultat({
      id: jobId,
      status: "completed",
      result: { text: "Le prix n'est pas affiché sur la page." },
    });
    await souffler();
    const texte = h.publication.publies[0]?.texte ?? "";
    expect(texte).toContain("Le prix n'est pas affiché sur la page.");
    expect(texte).toContain("Outils manquants");
    expect(texte).toContain("lire_page_web");
  });

  it("aucune allowlist fournie ⇒ aucun message d'outil manquant inventé", async () => {
    const h = harnais();
    const jobId = await tacheTiree(h);
    expect(String(h.jobs.demandes[0]?.context ?? "")).not.toContain("OUTILS ABSENTS");
    await h.service.recevoirResultat({
      id: jobId,
      status: "completed",
      result: { text: "Trois pages relevées." },
    });
    await souffler();
    expect(h.publication.publies[0]?.texte).toBe("Trois pages relevées.");
  });
});
