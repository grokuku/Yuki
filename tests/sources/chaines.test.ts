/**
 * LOT 33 — CHAÎNES D'ÉTAPES.
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : ni `chaine`, ni `resultatEtape`, ni
 * `etapes[]` n'existent — chaque étape serait un déclencheur isolé, sans relais, et une
 * chaîne à moitié créée serait possible.
 *
 * Ce qui est verrouillé ici :
 *  - ⚠️ `etapes[]` ATOMIQUE : si la place manque (3 étapes, 1 place), **RIEN** n'est créé ;
 *  - ⚠️ RELAIS : l'étape 2 reçoit le TEXTE et les IDENTIFIANTS DE FICHIERS de l'étape 1,
 *    bornés ;
 *  - ⚠️ ÉCHEC = CASCADE + **UN SEUL** message (pas une notification par étape) ;
 *  - chaîne INTERROMPUE (étape supprimée ou éteinte) ⇒ cascade avec raison lisible ;
 *  - la pré-autorisation d'une étape est indexée par SON NOM (l'origine du job) ;
 *  - la purge n'emporte JAMAIS une étape en attente.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PreAutorisationStore } from "../../src/agents/preautorisations.js";
import { SourcesInbox } from "../../src/sources/inbox.js";
import { DeclencheurJournal } from "../../src/sources/journal.js";
import {
  ORIGINE_HORLOGE,
  SourcesService,
  type SourcesHostEvent,
  type SourcesWaker,
} from "../../src/sources/service.js";
import { SourcesStore } from "../../src/sources/store.js";
import { MAX_SOURCES, type SourceRecord } from "../../src/sources/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ── Doubles (mêmes contrats que `tests/sources/balayeur.test.ts`) ───────────

class FakeWaker implements SourcesWaker {
  readonly renamed: Array<{ sessionId: string; titre: string }> = [];
  readonly deleted: string[] = [];
  readonly knownSessions = new Set<string>(["session-ouverte"]);
  newSessions = 0;
  private readonly listeners = new Set<(event: SourcesHostEvent) => void>();
  private sessionId: string | undefined = "session-ouverte";

  currentSessionId(): string | undefined {
    return this.sessionId;
  }
  send(): { runId: string; sessionId: string } {
    return { runId: "run", sessionId: this.sessionId ?? "session-ouverte" };
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
    return { status: "cancelled", job_id: jobId };
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
  jobs: FakeJobs;
  publication: FakePublication;
  dir: string;
}

function harnais(): Harnais {
  const dir = mkdtempSync(join(tmpdir(), "yuki-chaines-"));
  dirs.push(dir);
  const store = new SourcesStore({ path: join(dir, "sources.json") });
  const inbox = new SourcesInbox({ path: join(dir, "sources-inbox.json") });
  const journal = DeclencheurJournal.open({ path: join(dir, "declencheurs-journal.jsonl") });
  const jobs = new FakeJobs();
  const publication = new FakePublication();
  const service = new SourcesService({
    store,
    inbox,
    journal,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    waker: new FakeWaker(),
    jobs,
    publication,
    promptTotalChars: () => 4_000,
    now: () => Date.parse("2026-06-01T06:00:00Z"),
  });
  service.attach();
  return { service, store, jobs, publication, dir };
}

const ETAPES = ["Collecte", "Analyse", "Envoi"];

/** Crée une chaîne de `nombre` étapes (3 par défaut) et rend ses noms. */
function creerChaine(
  h: Harnais,
  nombre = 3,
  options: { libelles?: string[] } = {},
): string[] {
  const libelles = options.libelles ?? ETAPES.slice(0, nombre);
  const issue = h.service.creerChaine({
    libelle: "Veille quotidienne",
    etapes: libelles.map((libelle) => ({
      libelle,
      consigne: `Étape ${libelle}`,
      declencheur: { type: "planning", expression: "0 9 * * *", fuseau: "Europe/Paris" },
    })),
  });
  if (!issue.ok) throw new Error(`chaîne refusée : ${issue.raison}`);
  expect(issue.etapes).toHaveLength(nombre);
  return issue.etapes.map((etape) => etape.nom);
}

function fiche(h: Harnais, nom: string): SourceRecord {
  const record = h.store.get(nom);
  if (!record) throw new Error(`fiche absente : ${nom}`);
  return record;
}

describe("chaînes — création ATOMIQUE (`etapes[]`)", () => {
  it("crée les étapes DANS L'ORDRE, avec `chaine {id, etape, apres}`", () => {
    const h = harnais();
    const noms = creerChaine(h);
    expect(noms).toEqual(["collecte", "analyse", "envoi"]);
    const [un, deux, trois] = noms.map((nom) => fiche(h, nom));
    expect(un?.chaine?.etape).toBe(1);
    expect(un?.chaine?.apres).toBeUndefined();
    expect(deux?.chaine?.etape).toBe(2);
    expect(deux?.chaine?.apres).toBe(un?.nom);
    expect(trois?.chaine?.etape).toBe(3);
    expect(trois?.chaine?.apres).toBe(deux?.nom);
    // Même identifiant pour les trois : c'est ce qui fait la chaîne.
    expect(new Set([un?.chaine?.id, deux?.chaine?.id, trois?.chaine?.id]).size).toBe(1);
    // Les étapes sont des déclencheurs DURABLES ordinaires.
    expect(h.store.sourcesDurables).toBe(3);
  });

  it("⚠️ place insuffisante ⇒ AUCUNE étape créée (tout ou rien)", () => {
    const h = harnais();
    // 18 déclencheurs durables + une chaîne de 3 = 21 > MAX_SOURCES (20).
    for (let i = 0; i < MAX_SOURCES - 2; i += 1) {
      h.store.create(`dur-${i}`, { declencheur: { type: "webhook" } });
    }
    const avant = h.store.size;
    const issue = h.service.creerChaine({
      libelle: "Trop longue",
      etapes: ETAPES.map((libelle) => ({
        libelle,
        consigne: "x",
        declencheur: { type: "planning", expression: "0 9 * * *", fuseau: "Europe/Paris" },
      })),
    });
    expect(issue.ok).toBe(false);
    if (issue.ok) throw new Error("la chaîne aurait dû être refusée");
    expect(issue.raison).toContain("Rien n'a été créé");
    // RIEN n'a bougé : ni taille, ni étape de chaîne.
    expect(h.store.size).toBe(avant);
    expect(h.store.list().some((record) => record.chaine !== undefined)).toBe(false);
  });

  it("refuse une étape sans horaire (une étape de chaîne a un HORAIRE)", () => {
    const h = harnais();
    const issue = h.service.creerChaine({
      etapes: [
        { libelle: "Un", consigne: "x", declencheur: { type: "webhook" } },
        {
          libelle: "Deux",
          consigne: "y",
          declencheur: { type: "planning", expression: "0 9 * * *", fuseau: "Europe/Paris" },
        },
      ],
    });
    expect(issue.ok).toBe(false);
    expect(h.store.size).toBe(0);
  });

  it("refuse moins de 2 étapes (une « chaîne » d'une étape n'en est pas une)", () => {
    const h = harnais();
    const issue = h.service.creerChaine({
      etapes: [
        {
          libelle: "Seule",
          consigne: "x",
          declencheur: { type: "planning", expression: "0 9 * * *", fuseau: "Europe/Paris" },
        },
      ],
    });
    expect(issue.ok).toBe(false);
    expect(h.store.size).toBe(0);
  });
});

describe("chaînes — LE RELAIS (texte + identifiants de fichiers)", () => {
  it("l'étape 2 reçoit le TEXTE et les IDs de fichiers de l'étape 1", async () => {
    const h = harnais();
    const [un, deux] = creerChaine(h, 2);

    const premier = await h.service.declencher(un as string, { origine: ORIGINE_HORLOGE });
    expect(premier.outcome).toBe("started");
    await h.service.recevoirResultat({
      id: premier.runId as string,
      status: "completed",
      result: { text: "Analyse terminée : 3 incidents.", fichiers: ["fic-1", "fic-2"] },
    });

    // Persisté APRÈS publication.
    const apres = fiche(h, un as string);
    expect(apres.resultatEtape?.texte).toBe("Analyse terminée : 3 incidents.");
    expect(apres.resultatEtape?.fichiers).toEqual(["fic-1", "fic-2"]);

    const second = await h.service.declencher(deux as string, { origine: ORIGINE_HORLOGE });
    expect(second.outcome).toBe("started");
    const demande = h.jobs.demandes[1] as { context: string; origin: string };
    expect(demande.context).toContain("Analyse terminée : 3 incidents.");
    expect(demande.context).toContain("fic-1");
    expect(demande.context).toContain("fic-2");
    expect(demande.context).toContain("lire_fichier");
    // ⚠️ L'origine porte le NOM de l'étape : c'est par elle que la pré-autorisation
    // de CETTE étape s'applique (aucune autre).
    expect(demande.origin).toBe(`declencheur:${deux}`);
  });

  it("le résultat conservé est BORNÉ (texte 2 000 c., 8 fichiers)", async () => {
    const h = harnais();
    const [un] = creerChaine(h, 2);
    const premier = await h.service.declencher(un as string, { origine: ORIGINE_HORLOGE });
    await h.service.recevoirResultat({
      id: premier.runId as string,
      status: "completed",
      result: {
        text: "x".repeat(5_000),
        fichiers: Array.from({ length: 12 }, (_, index) => `fic-${index}`),
      },
    });
    const resultat = fiche(h, un as string).resultatEtape;
    expect(resultat?.texte.length).toBe(2_000);
    expect(resultat?.fichiers).toHaveLength(8);
  });

  it("une étape SILENCIEUSE laisse quand même un résultat (vide) à la suivante", async () => {
    const h = harnais();
    const [un, deux] = creerChaine(h, 2);
    const premier = await h.service.declencher(un as string, { origine: ORIGINE_HORLOGE });
    await h.service.recevoirResultat({
      id: premier.runId as string,
      status: "completed",
      result: { text: "RIEN" },
    });
    expect(fiche(h, un as string).resultatEtape?.texte).toBe("");
    // L'étape 2 n'attend pas un relais qui n'arrivera jamais : elle part.
    const second = await h.service.declencher(deux as string, { origine: ORIGINE_HORLOGE });
    expect(second.outcome).toBe("started");
  });

  it("sans résultat de la précédente, l'étape ATTEND (elle ne casse rien)", async () => {
    const h = harnais();
    const [, deux] = creerChaine(h, 2);
    const resultat = await h.service.declencher(deux as string, { origine: ORIGINE_HORLOGE });
    expect(resultat.outcome).toBe("refuse");
    expect(resultat.raison).toContain("n'a pas encore produit de résultat");
    expect(h.jobs.demandes).toEqual([]);
    // Rien n'a été éteint : le prochain tick réessaiera.
    expect(fiche(h, deux as string).actif).not.toBe(false);
  });
});

describe("chaînes — ÉCHEC = cascade + UN SEUL message", () => {
  it("étape 1 en échec ⇒ étapes 2 et 3 annulées, une seule ligne publiée", async () => {
    const h = harnais();
    const [un, deux, trois] = creerChaine(h);
    const premier = await h.service.declencher(un as string, { origine: ORIGINE_HORLOGE });
    await h.service.recevoirResultat({
      id: premier.runId as string,
      status: "failed",
      error: { message: "plafond d'exécution atteint" },
    });

    // ⚠️ UN SEUL message, pas un par étape.
    expect(h.publication.publies).toHaveLength(1);
    const texte = h.publication.publies[0]?.texte ?? "";
    expect(texte).toContain("étape 1 échouée (plafond d'exécution atteint)");
    expect(texte).toContain("Étapes 2 et 3 annulées, rien n'a été envoyé.");

    // L'étape fautive est éteinte, les suivantes aussi — avec leur raison.
    expect(fiche(h, un as string).actif).toBe(false);
    expect(fiche(h, un as string).raisonInactive).toContain("échouée :");
    expect(fiche(h, deux as string).actif).toBe(false);
    expect(fiche(h, deux as string).raisonInactive).toContain("annulée :");
    expect(fiche(h, deux as string).raisonInactive).toContain("a échoué");
    expect(fiche(h, trois as string).actif).toBe(false);

    // Et les suivantes ne PARTENT pas, même si on les déclenche à la main.
    const deuxieme = await h.service.declencher(deux as string, { origine: ORIGINE_HORLOGE });
    expect(deuxieme.outcome).toBe("refuse");
    expect(h.jobs.demandes).toHaveLength(1);
  });

  it("une étape sans suivante le dit (aucune annulation inventée)", async () => {
    const h = harnais();
    const [un, deux] = creerChaine(h, 2);
    const premier = await h.service.declencher(un as string, { origine: ORIGINE_HORLOGE });
    await h.service.recevoirResultat({
      id: premier.runId as string,
      status: "completed",
      result: { text: "ok" },
    });
    const second = await h.service.declencher(deux as string, { origine: ORIGINE_HORLOGE });
    await h.service.recevoirResultat({
      id: second.runId as string,
      status: "failed",
      error: { message: "agent injoignable" },
    });
    const texte = h.publication.publies.at(-1)?.texte ?? "";
    expect(texte).toContain("étape 2 échouée (agent injoignable)");
    expect(texte).toContain("Aucune étape suivante");
  });
});

describe("chaînes — INTERRUPTION (étape supprimée ou éteinte)", () => {
  it("étape 1 SUPPRIMÉE ⇒ l'étape 2 refuse et annule la suite, une seule ligne", async () => {
    const h = harnais();
    const [un, deux, trois] = creerChaine(h);
    h.store.remove(un as string);

    const resultat = await h.service.declencher(deux as string, { origine: ORIGINE_HORLOGE });
    expect(resultat.outcome).toBe("refuse");
    expect(resultat.raison).toContain("n'existe plus");
    expect(h.publication.publies).toHaveLength(1);
    expect(h.publication.publies[0]?.texte).toContain("étape 2 non exécutée");
    expect(h.publication.publies[0]?.texte).toContain("Étape 3 annulée, rien n'a été envoyé.");
    expect(fiche(h, deux as string).actif).toBe(false);
    expect(fiche(h, trois as string).actif).toBe(false);
    // Jamais orpheline : la raison nomme l'étape disparue.
    expect(fiche(h, trois as string).raisonInactive).toContain("n'existe plus");
  });

  it("`DÉSACTIVER` dans une étape ARRÊTE la chaîne (jamais orpheline)", async () => {
    const h = harnais();
    const [un, deux] = creerChaine(h, 2);
    const premier = await h.service.declencher(un as string, { origine: ORIGINE_HORLOGE });
    await h.service.recevoirResultat({
      id: premier.runId as string,
      status: "completed",
      result: { text: "Plus rien à surveiller.\n\n**DÉSACTIVER**" },
    });
    expect(fiche(h, un as string).actif).toBe(false);
    const resultat = await h.service.declencher(deux as string, { origine: ORIGINE_HORLOGE });
    expect(resultat.outcome).toBe("refuse");
    expect(resultat.raison).toContain("a été éteinte");
    expect(fiche(h, deux as string).actif).toBe(false);
    expect(fiche(h, deux as string).raisonInactive).toContain("annulée :");
  });

  it("étape 1 ÉTEINTE à la main ⇒ cascade avec raison lisible", async () => {
    const h = harnais();
    const [un, deux, trois] = creerChaine(h);
    h.store.setActif(un as string, false, "mise en veille manuelle");

    const resultat = await h.service.declencher(deux as string, { origine: ORIGINE_HORLOGE });
    expect(resultat.outcome).toBe("refuse");
    expect(resultat.raison).toContain("a été éteinte");
    expect(fiche(h, deux as string).raisonInactive).toContain("annulée :");
    expect(fiche(h, trois as string).actif).toBe(false);
    expect(h.jobs.demandes).toEqual([]);
  });
});

describe("chaînes — PRÉ-AUTORISATION PAR NOM D'ÉTAPE", () => {
  it("l'autorisation est indexée par le NOM de l'étape, et l'origine du job le porte", async () => {
    const h = harnais();
    const registre = new PreAutorisationStore({
      path: join(h.dir, "preautorisations.json"),
      now: () => Date.parse("2026-06-01T06:00:00Z"),
    });
    const [un, deux] = creerChaine(h, 2);
    const pre = registre.creer({
      declencheur: deux,
      agentId: "agent-1",
      motif: "df -h",
      portee: "exacte",
    });

    // L'autorisation ne vaut QUE pour l'étape 2, jamais pour l'étape 1.
    expect(registre.activesPour(deux as string)).toHaveLength(1);
    expect(registre.activesPour(un as string)).toHaveLength(0);

    const premier = await h.service.declencher(un as string, { origine: ORIGINE_HORLOGE });
    await h.service.recevoirResultat({
      id: premier.runId as string,
      status: "completed",
      result: { text: "collecte faite" },
    });
    const second = await h.service.declencher(deux as string, { origine: ORIGINE_HORLOGE });
    expect(second.outcome).toBe("started");
    expect((h.jobs.demandes[1] as { origin: string }).origin).toBe(`declencheur:${deux}`);

    // Et le registre reconnaît cette origine comme celle de l'étape 2.
    const consommation = registre.consommer({
      declencheur: deux as string,
      agentId: "agent-1",
      commande: "df -h",
      destructif: false,
    });
    expect(consommation.kind).toBe("consommee");
    expect(registre.get(pre.id)?.consommations).toBe(1);
  });
});

describe("chaînes — PURGE : jamais une étape en attente", () => {
  it("ne purge rien tant qu'une étape reste armée, puis retire la chaîne morte", () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-purge-chaines-"));
    dirs.push(dir);
    let maintenant = Date.parse("2026-06-01T06:00:00Z");
    const store = new SourcesStore({ path: join(dir, "sources.json"), now: () => maintenant });
    const records = store.createChaine({
      id: "chaine-purge",
      etapes: [
        {
          libelle: "Un",
          consigne: "x",
          declencheur: { type: "planning", expression: "0 9 * * *", fuseau: "Europe/Paris" },
        },
        {
          libelle: "Deux",
          consigne: "y",
          declencheur: { type: "planning", expression: "0 10 * * *", fuseau: "Europe/Paris" },
        },
      ],
    });
    const [un, deux] = records.map((record) => record.nom);
    store.setActif(un as string, false, "terminée : 1/1 passages");
    maintenant += 40 * 86_400_000;

    // ⚠️ L'étape 2 est encore ARMÉE : on ne touche à rien.
    expect(store.purgerChainesTerminees(1)).toEqual([]);
    expect(store.size).toBe(2);

    store.setActif(deux as string, false, "terminée : 1/1 passages");
    maintenant += 40 * 86_400_000;
    expect(store.purgerChainesTerminees(1).sort()).toEqual([un, deux].sort());
    expect(store.size).toBe(0);
  });

  it("ne touche JAMAIS un déclencheur hors chaîne", () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-purge-isolee-"));
    dirs.push(dir);
    let maintenant = Date.parse("2026-06-01T06:00:00Z");
    const store = new SourcesStore({ path: join(dir, "sources.json"), now: () => maintenant });
    store.create("isolee", { declencheur: { type: "webhook" } });
    store.setActif("isolee", false, "désactivée");
    maintenant += 400 * 86_400_000;
    expect(store.purgerChainesTerminees(1)).toEqual([]);
    expect(store.has("isolee")).toBe(true);
  });
});
