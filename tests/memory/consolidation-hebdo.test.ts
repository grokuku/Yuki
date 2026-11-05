/**
 * CONSOLIDATION HEBDOMADAIRE — orchestration, VERSIONNING et garde-fous (lot 29).
 *
 * ⚠️ Ces tests ÉCHOUENT sur le code d'origine : ni `ConsolidationHebdo`, ni
 * `ConsolidationArchiveStore`, ni le port `passeHebdo` du balayeur n'existent
 * (`git show HEAD:src/memory/index.ts`, `git show HEAD:src/sources/scheduler.ts`).
 *
 * Ce qui est prouvé :
 *  ① mesure : tout tient ⇒ UN SEUL lot ; budget dépassé ⇒ lots conformes ;
 *  ② contexte du modèle LU (changer le contexte change le nombre de lots) ;
 *  ③ VERSIONNING : 2 passes ⇒ 2 versions listables/téléchargeables/restaurables,
 *    restauration À L'OCTET + index FTS5 reconstruit ;
 *  ④ rétention : au-delà de N, purge de la plus ancienne ET journalisée ;
 *  ⑤ refus TOTAL (aucune modification), traversée de chemin refusée ;
 *  ⑥ fuseau `Europe/Paris` LU (changer le fuseau change le prochain passage) ;
 *  ⑦ rattrapage une fois si ≤ 24 h, au-delà sauté ; verrou `enCours` ⇒ saut ;
 *  ⑧ port `passeHebdo` appelé par le balayeur UNIQUE (aucun second minuteur).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ConsolidationArchiveStore,
  ConsolidationHebdo,
  type ConsolidationVersion,
  type RapportConsolidation,
} from "../../src/memory/index.js";
import { MemoryIndex } from "../../src/memory/index-db.js";
import { MEMORY_FILE_HEADER, MemoryStore } from "../../src/memory/store.js";
import { DeclencheurBalayeur } from "../../src/sources/scheduler.js";

const dirs: string[] = [];
const ouverts: Array<{ store: MemoryStore; index: MemoryIndex }> = [];

afterEach(() => {
  for (const { index } of ouverts.splice(0)) index.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Journal {
  infos: Array<{ message: string; fields?: Record<string, unknown> }>;
  warns: Array<{ message: string; fields?: Record<string, unknown> }>;
}

function journal(): Journal & {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
} {
  const infos: Journal["infos"] = [];
  const warns: Journal["warns"] = [];
  return {
    infos,
    warns,
    info: (message, fields) => {
      infos.push({ message, ...(fields ? { fields } : {}) });
    },
    warn: (message, fields) => {
      warns.push({ message, ...(fields ? { fields } : {}) });
    },
    error: () => undefined,
    debug: () => undefined,
  };
}

function dossier(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-consolidation-"));
  dirs.push(dir);
  return dir;
}

/** Écrit un journal de mémoire minimal (en-tête + lignes `add`). */
function ecrireMemoire(
  chemin: string,
  entrees: Array<{ id: string; text: string; at?: string }>,
): void {
  const lignes = [MEMORY_FILE_HEADER];
  for (const [index, entree] of entrees.entries()) {
    lignes.push(
      JSON.stringify({
        v: 1,
        t: "add",
        id: entree.id,
        at: entree.at ?? new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
        text: entree.text,
        source: "test",
        cat: "fait",
      }),
    );
  }
  writeFileSync(chemin, `${lignes.join("\n")}\n`, "utf8");
}

/** Lit les identifiants du lot et son numéro dans un prompt réel. */
function lotDuPrompt(prompt: string): { lot: number; ids: string[] } {
  const lot = Number(/"lot":(\d+)/.exec(prompt)?.[1] ?? 1);
  const ids = [...prompt.matchAll(/^- (mem-[a-z0-9-]+)/gm)].map((match) => String(match[1]));
  return { lot, ids };
}

function extracteurPlanifie(
  plan: (ids: string[], lot: number) => unknown[],
): {
  extractor: (prompt: string) => Promise<string>;
  appels: Array<{ lot: number; ids: string[] }>;
} {
  const appels: Array<{ lot: number; ids: string[] }> = [];
  const extractor = async (prompt: string): Promise<string> => {
    const { lot, ids } = lotDuPrompt(prompt);
    appels.push({ lot, ids });
    return JSON.stringify({ version: 1, lot, operations: plan(ids, lot) });
  };
  return { extractor, appels };
}

interface Banc {
  dir: string;
  cheminMemoire: string;
  store: MemoryStore;
  index: MemoryIndex;
  archive: ConsolidationArchiveStore;
  journal: ReturnType<typeof journal>;
}

function banc(entrees: Array<{ id: string; text: string; at?: string }>): Banc {
  const dir = dossier();
  const cheminMemoire = join(dir, "memory.jsonl");
  ecrireMemoire(cheminMemoire, entrees);
  const logger = journal();
  const store = MemoryStore.open({ path: cheminMemoire, logger });
  const index = new MemoryIndex({ path: join(dir, "memory-index.sqlite"), logger });
  expect(index.open()).toBe(true);
  index.rebuild(store.entries);
  ouverts.push({ store, index });
  return {
    dir,
    cheminMemoire,
    store,
    index,
    archive: new ConsolidationArchiveStore({
      dir: join(dir, "memory-archive", "consolidation"),
      logger,
    }),
    journal: logger,
  };
}

function service(
  b: Banc,
  options: {
    extractor?: (prompt: string) => Promise<string>;
    now?: () => number;
    reglages?: Partial<{
      enabled: boolean;
      cron: string;
      fuseau: string;
      budgetTokens: number;
      retention: number;
    }>;
    contexteModele?: () => number;
  } = {},
): ConsolidationHebdo {
  const reglages = {
    enabled: true,
    cron: "0 3 * * 0",
    fuseau: "Europe/Paris",
    budgetTokens: 200_000,
    retention: 12,
    ...options.reglages,
  };
  return new ConsolidationHebdo({
    store: b.store,
    index: b.index,
    logger: b.journal,
    archive: b.archive,
    statePath: join(b.dir, "memory-consolidation.json"),
    settings: () => reglages,
    extractor: () => options.extractor,
    contexteModele: options.contexteModele ?? (() => 131_072),
    ...(options.now ? { now: options.now } : {}),
  });
}

/** 12 entrées « raisonnables » : le plafond de 10 % autorise UNE suppression. */
function douzeEntrees(): Array<{ id: string; text: string }> {
  return Array.from({ length: 12 }, (_valeur, index) => ({
    id: `mem-${String(index).padStart(2, "0")}`,
    text: `Souvenir numéro ${index} — fait durable numunique${index}.`,
  }));
}

describe("mesure et découpage d'une passe réelle", () => {
  it("tout tient ⇒ UN SEUL lot, et la consolidation est appliquée", async () => {
    const b = banc(douzeEntrees());
    const { extractor, appels } = extracteurPlanifie((ids) =>
      ids.map((id) =>
        id === "mem-03"
          ? {
              op: "corriger",
              id,
              text: "Souvenir numéro 3 — corrigé et durable.",
              cat: "fait",
              why: "correction demandée",
              raison: "précision",
            }
          : { op: "garder", id },
      ),
    );
    const hebdo = service(b, { extractor });
    const rapport = await hebdo.executerPasse();

    expect(appels).toHaveLength(1);
    expect(rapport.lots).toBe(1);
    expect(rapport.mesure.lots).toBe(1);
    expect(rapport.applique).toBe(true);
    expect(rapport.entreesAvant).toBe(12);
    expect(rapport.entreesApres).toBe(12);
    expect(rapport.parOperation.corriger).toBe(1);
    expect(b.store.get("mem-03")?.text).toContain("corrigé");
    // L'index est cohérent avec l'état appliqué.
    expect(b.index.search("corrigé", 5)).toContain("mem-03");
    // Le rapport porte TOUS les champs de mesure de l'amendement ①.
    expect(rapport.tokensEstimes).toBeGreaterThan(0);
    expect(rapport.caracteres).toBeGreaterThan(0);
    expect(rapport.contexteModele).toBe(131_072);
    expect(rapport.budgetTokens).toBe(131_072 - rapport.mesure.margeSortie - rapport.mesure.promptFixe);
    expect(rapport.pourcentContexte).toBeGreaterThan(0);
    expect(rapport.mesure.hypothese).toContain("3.5");
    expect(rapport.version).toBeDefined();
  });

  it("budget dépassé ⇒ plusieurs lots, chacun dans le budget", async () => {
    const entrees = Array.from({ length: 40 }, (_valeur, index) => ({
      id: `mem-${String(index).padStart(2, "0")}`,
      text: `Souvenir ${index} ${"x".repeat(80)}`,
    }));
    const b = banc(entrees);
    const { extractor, appels } = extracteurPlanifie((ids) =>
      ids.map((id) => ({ op: "garder", id })),
    );
    const hebdo = service(b, { extractor, reglages: { budgetTokens: 200 } });
    const rapport = await hebdo.executerPasse();
    expect(rapport.lots).toBeGreaterThan(1);
    expect(appels.length).toBe(rapport.lots);
    const budgetCaracteres = rapport.mesure.budgetCaracteres;
    for (const appel of appels) {
      const chars = appel.ids.reduce(
        (sum, id) => sum + (b.store.get(id)?.text.length ?? 0),
        0,
      );
      expect(chars).toBeLessThanOrEqual(budgetCaracteres);
    }
    // Aucune entrée perdue par le découpage.
    const tous = appels.flatMap((appel) => appel.ids);
    expect(new Set(tous).size).toBe(40);
  });

  it("le contexte du modèle est LU : changer le contexte change le nombre de lots", async () => {
    const entrees = Array.from({ length: 40 }, (_valeur, index) => ({
      id: `mem-${String(index).padStart(2, "0")}`,
      text: `Souvenir ${index} ${"y".repeat(80)}`,
    }));
    const b1 = banc(entrees);
    const grand = await service(b1, {
      extractor: extracteurPlanifie((ids) => ids.map((id) => ({ op: "garder", id }))).extractor,
      contexteModele: () => 1_000_000,
    }).executerPasse();
    expect(grand.contexteModele).toBe(1_000_000);
    expect(grand.lots).toBe(1);

    const b2 = banc(entrees);
    const petit = await service(b2, {
      extractor: extracteurPlanifie((ids) => ids.map((id) => ({ op: "garder", id }))).extractor,
      contexteModele: () => 10_000,
    }).executerPasse();
    expect(petit.contexteModele).toBe(10_000);
    expect(petit.lots).toBeGreaterThan(1);
  });
});

describe("versionning des archives (amendement ②)", () => {
  it("2 passes ⇒ 2 versions distinctes, listables, téléchargeables et restaurables", async () => {
    const b = banc(douzeEntrees());
    let horloge = Date.parse("2026-11-08T02:00:00.000Z");
    const avant1 = readFileSync(b.cheminMemoire, "utf8");

    // Passe 1 : supprime mem-11 (motif unique « numunique11 »).
    const un = service(b, {
      now: () => horloge,
      extractor: extracteurPlanifie((ids) =>
        ids.map((id) =>
          id === "mem-11" ? { op: "supprimer", id, raison: "transitoire" } : { op: "garder", id },
        ),
      ).extractor,
    });
    const r1 = await un.executerPasse();
    expect(r1.applique).toBe(true);
    expect(b.store.has("mem-11")).toBe(false);
    expect(b.index.search("numunique11", 5)).toHaveLength(0);

    // Passe 2 (une minute plus tard) : corrige mem-02.
    horloge += 60_000;
    const deux = service(b, {
      now: () => horloge,
      extractor: extracteurPlanifie((ids) =>
        ids.map((id) =>
          id === "mem-02"
            ? { op: "corriger", id, text: "Souvenir 2 corrigé.", cat: "fait", why: "précision", raison: "mieux dit" }
            : { op: "garder", id },
        ),
      ).extractor,
    });
    const r2 = await deux.executerPasse();
    expect(r2.applique).toBe(true);

    const versions: ConsolidationVersion[] = deux.listerVersions();
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((version) => version.nom)).size).toBe(2);
    expect(versions[0]?.nom).not.toBe(versions[1]?.nom);

    // Téléchargement de la PLUS ANCIENNE : c'est l'état d'avant la passe 1, à l'octet.
    const ancienne = versions[1] as ConsolidationVersion;
    const telechargement = deux.telechargerVersion(ancienne.nom);
    expect(telechargement?.contenu).toBe(avant1);
    expect(deux.operationsDeVersion(ancienne.nom)).toContain("supprimer");
    expect(deux.rapportDeVersion(ancienne.nom)).toContain("tokensEstimes");

    // Restauration de la plus ancienne : store À L'OCTET + index reconstruit.
    const restauration = deux.restaurerVersion(ancienne.nom);
    expect(restauration?.entrees).toBe(12);
    expect(readFileSync(b.cheminMemoire, "utf8")).toBe(avant1);
    expect(b.store.has("mem-11")).toBe(true);
    expect(b.index.search("numunique11", 5)).toContain("mem-11");
    // …et la plus récente reste, elle aussi, restaurable indépendamment.
    const recente = versions[0] as ConsolidationVersion;
    expect(deux.telechargerVersion(recente.nom)?.contenu).not.toBe(avant1);
  });

  it("rétention : au-delà de N versions, la plus ancienne est purgée et journalisée", async () => {
    const b = banc(douzeEntrees());
    let horloge = Date.parse("2026-11-01T02:00:00.000Z");
    const noms: string[] = [];
    for (let passe = 0; passe < 3; passe += 1) {
      const hebdo = service(b, {
        now: () => horloge,
        reglages: { retention: 2 },
        extractor: extracteurPlanifie((ids) => ids.map((id) => ({ op: "garder", id }))).extractor,
      });
      noms.push(String((await hebdo.executerPasse()).version));
      horloge += 7 * 24 * 3_600_000;
    }
    const restaure = service(b, { now: () => horloge });
    const versions = restaure.listerVersions();
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.nom)).not.toContain(noms[0]);
    const purge = b.journal.infos.find(
      (entree) =>
        entree.message === "memory.consolidation.version.purged" &&
        entree.fields?.version === noms[0],
    );
    expect(purge, "purge journalisée").toBeDefined();
  });

  it("refuse une traversée de chemin et une version inexistante", async () => {
    const b = banc(douzeEntrees());
    const hebdo = service(b);
    expect(hebdo.telechargerVersion("../secret")).toBeNull();
    expect(hebdo.telechargerVersion("../../etc/passwd")).toBeNull();
    expect(hebdo.restaurerVersion("../secret")).toBeNull();
    expect(hebdo.telechargerVersion("2026-01-01_0000")).toBeNull();
    // Le dossier d'archives lui-même refuse un nom hors format.
    expect(b.archive.cheminDe("2026-13-99_9999")).toBeNull();
    expect(b.archive.cheminDe("2026-02-31_0000")).not.toBeNull(); // 31 février : forme admise
    expect(b.archive.cheminDe("2026-01-01_2400")).toBeNull();
    expect(b.archive.cheminDe("2026-01-01_0000")).toBe(b.archive.cheminDe("2026-01-01_0000"));
  });

  it("une réponse invalide ⇒ REFUS TOTAL : le fichier de mémoire reste à l'octet", async () => {
    const b = banc(douzeEntrees());
    const avant = readFileSync(b.cheminMemoire, "utf8");
    const hebdo = service(b, { extractor: async () => "je ne peux pas répondre" });
    const rapport = await hebdo.executerPasse();
    expect(rapport.refus).toBeDefined();
    expect(rapport.applique).toBe(false);
    expect(readFileSync(b.cheminMemoire, "utf8")).toBe(avant);
    // La tentative est ARCHIVÉE (traçabilité), avec `applique: false`.
    const versions = hebdo.listerVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.applique).toBe(false);
  });

  it("refuse la passe si le modèle LOURD est indisponible (aucun repli)", async () => {
    const b = banc(douzeEntrees());
    const avant = readFileSync(b.cheminMemoire, "utf8");
    const hebdo = service(b, { extractor: undefined });
    const rapport = await hebdo.executerPasse();
    expect(rapport.refus).toContain("lourd");
    expect(readFileSync(b.cheminMemoire, "utf8")).toBe(avant);
  });
});

describe("planification, fuseau, verrou et rattrapage", () => {
  it("arme le prochain passage avec le FUSEAU LU (Europe/Paris ≠ UTC)", async () => {
    const b = banc(douzeEntrees());
    const jeudi = Date.parse("2026-11-05T12:00:00.000Z");
    const paris = service(b, { now: () => jeudi, extractor: async () => "" });
    await paris.executerSiDu(jeudi);
    await paris.drain();
    const etat = paris.etat();
    // Dimanche 08/11/2026 03:00 à Paris = 02:00 UTC.
    expect(etat.prochainPassage).toBe("2026-11-08T02:00:00.000Z");
    expect(etat.fuseau).toBe("Europe/Paris");

    const b2 = banc(douzeEntrees());
    const utc = service(b2, {
      now: () => jeudi,
      reglages: { fuseau: "UTC" },
      extractor: async () => "",
    });
    await utc.executerSiDu(jeudi);
    await utc.drain();
    // Même cron, fuseau différent ⇒ 03:00 UTC : le réglage est bien LU.
    expect(utc.etat().prochainPassage).toBe("2026-11-08T03:00:00.000Z");
  });

  it("rattrape UNE fois si le retard ≤ 24 h, saute au-delà", async () => {
    const b = banc(douzeEntrees());
    const maintenant = Date.parse("2026-11-10T12:00:00.000Z");
    writeFileSync(
      join(b.dir, "memory-consolidation.json"),
      JSON.stringify({
        version: 1,
        prochainPassage: new Date(maintenant - 2 * 3_600_000).toISOString(),
      }),
      "utf8",
    );
    const { extractor, appels } = extracteurPlanifie((ids) =>
      ids.map((id) => ({ op: "garder", id })),
    );
    const hebdo = service(b, { now: () => maintenant, extractor });
    await hebdo.executerSiDu(maintenant);
    await hebdo.drain();
    expect(appels.length).toBeGreaterThan(0);

    const b2 = banc(douzeEntrees());
    writeFileSync(
      join(b2.dir, "memory-consolidation.json"),
      JSON.stringify({
        version: 1,
        prochainPassage: new Date(maintenant - 30 * 3_600_000).toISOString(),
      }),
      "utf8",
    );
    const retarde = extracteurPlanifie((ids) => ids.map((id) => ({ op: "garder", id })));
    const hebdo2 = service(b2, { now: () => maintenant, extractor: retarde.extractor });
    await hebdo2.executerSiDu(maintenant);
    await hebdo2.drain();
    expect(retarde.appels).toHaveLength(0);
    expect(
      b2.journal.infos.some((entree) => entree.message === "memory.consolidation.saut"),
    ).toBe(true);
  });

  it("verrou `enCours` ⇒ passage SAUTÉ et journalisé", async () => {
    const b = banc(douzeEntrees());
    const maintenant = Date.parse("2026-11-10T12:00:00.000Z");
    writeFileSync(
      join(b.dir, "memory-consolidation.json"),
      JSON.stringify({
        version: 1,
        prochainPassage: new Date(maintenant - 60_000).toISOString(),
        enCours: true,
        enCoursDepuis: new Date(maintenant - 60_000).toISOString(),
      }),
      "utf8",
    );
    const { extractor, appels } = extracteurPlanifie((ids) =>
      ids.map((id) => ({ op: "garder", id })),
    );
    const hebdo = service(b, { now: () => maintenant, extractor });
    await hebdo.executerSiDu(maintenant);
    await hebdo.drain();
    expect(appels).toHaveLength(0);
    const saut = b.journal.infos.find(
      (entree) => entree.message === "memory.consolidation.saut",
    );
    expect(String(saut?.fields?.raison)).toContain("en cours");
  });

  it("désactivée ⇒ aucune passe, aucun appel au modèle", async () => {
    const b = banc(douzeEntrees());
    const { extractor, appels } = extracteurPlanifie((ids) =>
      ids.map((id) => ({ op: "garder", id })),
    );
    const hebdo = service(b, {
      extractor,
      reglages: { enabled: false },
      now: () => Date.parse("2026-11-10T12:00:00.000Z"),
    });
    await hebdo.executerSiDu(Date.parse("2026-11-10T12:00:00.000Z"));
    await hebdo.drain();
    expect(appels).toHaveLength(0);
  });
});

describe("port `passeHebdo` du balayeur (un seul minuteur)", () => {
  it("le balayeur appelle le port à CHAQUE tick et n'ouvre aucun second intervalle", async () => {
    let appels = 0;
    const intervalles: number[] = [];
    const balayeur = new DeclencheurBalayeur({
      store: {
        list: () => [],
        get: () => undefined,
        markPlanification: () => undefined,
        setActif: () => undefined,
        incrementerTour: () => 0,
        // Le port du balayeur compte aussi les passages tirés (lot 32) : ce double ne
        // s'en sert pas, mais il doit satisfaire le contrat.
        incrementerOccurrence: () => 0,
      },
      run: async () => ({
        outcome: "failed" as const,
        raison: "aucun déclencheur",
        fin: Promise.resolve({ reason: "refuse" as const, texte: "" }),
      }),
      logger: { info: () => undefined, warn: () => undefined },
      passeHebdo: {
        executerSiDu: async () => {
          appels += 1;
        },
      },
      setInterval: (_callback, delayMs) => {
        intervalles.push(delayMs);
        return { unref: () => undefined };
      },
      clearInterval: () => undefined,
      now: () => 0,
      intervalMs: 30_000,
    });
    balayeur.start();
    await balayeur.tick();
    await balayeur.tick();
    balayeur.stop();
    expect(appels).toBeGreaterThanOrEqual(2);
    // ⚠️ UN SEUL `setInterval` : la consolidation n'en ajoute aucun.
    expect(intervalles).toHaveLength(1);
    expect(intervalles[0]).toBe(30_000);
  });

  it("un échec du port ne casse pas le balayage", async () => {
    const warns: string[] = [];
    const balayeur = new DeclencheurBalayeur({
      store: {
        list: () => [],
        get: () => undefined,
        markPlanification: () => undefined,
        setActif: () => undefined,
        incrementerTour: () => 0,
        // Le port du balayeur compte aussi les passages tirés (lot 32) : ce double ne
        // s'en sert pas, mais il doit satisfaire le contrat.
        incrementerOccurrence: () => 0,
      },
      run: async () => ({
        outcome: "failed" as const,
        raison: "aucun déclencheur",
        fin: Promise.resolve({ reason: "refuse" as const, texte: "" }),
      }),
      logger: {
        info: () => undefined,
        warn: (message) => {
          warns.push(message);
        },
      },
      passeHebdo: {
        executerSiDu: async () => {
          throw new Error("panne simulée");
        },
      },
      setInterval: () => ({ unref: () => undefined }),
      clearInterval: () => undefined,
      now: () => 0,
    });
    balayeur.start();
    await balayeur.tick();
    // Laisse la microtâche de rejet s'exécuter avant de conclure.
    await new Promise((resolve) => setImmediate(resolve));
    balayeur.stop();
    expect(warns).toContain("sources.balayeur.passe_hebdo_failed");
  });
});

/** Un rapport refusé ne doit jamais prétendre avoir appliqué quoi que ce soit. */
function invariantRapport(rapport: RapportConsolidation): void {
  if (rapport.refus) expect(rapport.applique).toBe(false);
}
describe("invariant de rapport", () => {
  it("un refus n'est jamais un succès", () => {
    const b = banc(douzeEntrees());
    return service(b, { extractor: async () => "nope" })
      .executerPasse()
      .then(invariantRapport);
  });
});
