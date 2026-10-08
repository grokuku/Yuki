/**
 * `HeritageAdminService` — ÉCRITURE de l'archive « vie antérieure » (interface).
 *
 * Prouve : création, modification, mise de côté (jamais d'effacement),
 * RÉAPPLICATION de l'étiquette et de la provenance, bornage de taille, entrée
 * malformée ignorée sans crash, journal SANS contenu, et surtout l'absence
 * TOTALE d'écriture dans la mémoire courante.
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HERITAGE_LABEL,
  HeritageAdminService,
  HeritageStore,
  MemoryStore,
} from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function logger() {
  return createLogger({ level: "error", sink: () => undefined, secretValues: [] });
}

interface Harness {
  dir: string;
  store: HeritageStore;
  admin: HeritageAdminService;
}

function harness(): Harness {
  const dir = join(mkdtempSync(join(tmpdir(), "yuki-heritage-admin-")), "memory-heritage");
  tempDirs.push(join(dir, ".."));
  const store = new HeritageStore({ dir, logger: logger() });
  store.ensureLayout();
  const admin = new HeritageAdminService(store, { logger: logger(), secretValues: [] });
  return { dir, store, admin };
}

describe("HeritageAdminService — création", () => {
  it("écrit une entrée JSON étiquetée, résolue ensuite par la LECTURE SEULE", () => {
    const h = harness();
    const result = h.admin.create({
      titre: "Rêves de voyage",
      categorie: "reves",
      texte: "Voyager en Islande.",
    });
    expect(result.changed).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.entry.id).toBe("heritage-reves-de-voyage");
    expect(result.entry.cle).toBe("entries/reves-de-voyage.json");
    expect(result.entry.label).toBe(HERITAGE_LABEL);

    // Le fichier existe et l'étiquette y est ÉCRITE (jamais oubliable).
    const raw = readFileSync(join(h.dir, "entries/reves-de-voyage.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.label).toBe(HERITAGE_LABEL);
    expect(parsed.provenance).toMatchObject({ machine: "Yuki-old", ere: "OpenClaw" });

    // Le store de LECTURE SEULE (utilisé par l'outil du modèle) voit l'entrée.
    h.store.refresh();
    expect(h.store.info().entries).toBe(1);
    expect(h.store.read("Rêves de voyage")?.texte).toBe("Voyager en Islande.");
  });

  it("refuse un titre vide (erreur métier explicite)", () => {
    const h = harness();
    expect(() => h.admin.create({ titre: "   ", texte: "x" })).toThrowError(/titre/i);
  });

  it("évite la collision de noms de fichier", () => {
    const h = harness();
    const a = h.admin.create({ titre: "Identité", texte: "a" });
    const b = h.admin.create({ titre: "Identité", texte: "b" });
    expect(a.entry.cle).not.toBe(b.entry.cle);
    expect(h.admin.list()).toHaveLength(2);
  });
});

describe("HeritageAdminService — modification", () => {
  it("réapplique l'étiquette et la provenance et garde id/clé", () => {
    const h = harness();
    const created = h.admin.create({ titre: "Profil", categorie: "profil", texte: "v1" });
    const updated = h.admin.update(created.entry.cle, {
      titre: "Profil (mis à jour)",
      categorie: "profil",
      texte: "v2",
    });
    expect(updated?.entry.id).toBe(created.entry.id);
    expect(updated?.entry.cle).toBe(created.entry.cle);
    expect(updated?.entry.label).toBe(HERITAGE_LABEL);
    expect(updated?.entry.texte).toBe("v2");

    const raw = readFileSync(join(h.dir, created.entry.cle), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.label).toBe(HERITAGE_LABEL);
    expect(parsed.texte).toBe("v2");
  });

  it("clé inconnue ⇒ `undefined`", () => {
    const h = harness();
    expect(h.admin.update("entries/inexistant.json", { titre: "x", texte: "y" })).toBeUndefined();
  });
});

describe("HeritageAdminService — suppression = MISE DE CÔTÉ", () => {
  it("déplace l'entrée dans deleted/ (récupérable), jamais d'effacement", () => {
    const h = harness();
    const created = h.admin.create({ titre: "Rêves", texte: "contenu" });
    const result = h.admin.remove(created.entry.cle);
    expect(result?.moved).toBe(true);
    expect(result?.deletedPath).toBeTruthy();

    // L'entrée n'est plus dans l'archive ACTIVE…
    expect(h.admin.list()).toHaveLength(0);
    // …mais le fichier existe toujours, dans `deleted/`.
    expect(readdirSync(join(h.dir, "deleted"))).toHaveLength(1);
    expect(readFileSync(result?.deletedPath as string, "utf8")).toContain("contenu");
    // La lecture seule ne la voit plus.
    h.store.refresh();
    expect(h.store.info().entries).toBe(0);
  });

  it("clé inconnue ⇒ `undefined`", () => {
    const h = harness();
    expect(h.admin.remove("entries/inexistant.json")).toBeUndefined();
  });
});

describe("HeritageAdminService — bornage de taille", () => {
  it("tronque et SIGNALE (jamais en silence), aligné sur la borne de lecture", () => {
    const h = harness();
    const big = "a".repeat(30_000);
    const result = h.admin.create({ titre: "Long", texte: big });
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.entry.texte.length).toBe(h.admin.textMaxChars);
    // Ce qui est écrit est RELISIBLE intégralement (pas de troncature à la lecture).
    h.store.refresh();
    expect(h.store.read("heritage-long")?.texte.length).toBe(h.admin.textMaxChars);
  });
});

describe("HeritageAdminService — tolérance & journal", () => {
  it("entrée malformée ignorée (aucune exception) ; le reste reste éditable", () => {
    const h = harness();
    mkdirSync(join(h.dir, "entries", "casse.json"), { recursive: true });
    const ok = h.admin.create({ titre: "Saine", texte: "ok" });
    expect(h.admin.list().map((entry) => entry.id)).toContain(ok.entry.id);
    expect(h.admin.list().some((entry) => entry.cle.endsWith("casse.json"))).toBe(false);
  });

  it("journalise les modifications SANS le contenu ni de secret", () => {
    const h = harness();
    const secret = "CLEF_SECRETE_A_NE_JAMais_JOURNALISER";
    const admin = new HeritageAdminService(h.store, { logger: logger(), secretValues: [secret], now: () => 0 });
    const created = admin.create({ titre: "Avec secret", texte: `texte ${secret}` });
    admin.update(created.entry.cle, { titre: "Avec secret", texte: "modifié" });
    admin.remove(created.entry.cle);

    const journal = readFileSync(join(h.dir, "heritage-journal.jsonl"), "utf8");
    const lines = journal.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.map((line) => line.action)).toEqual(["create", "update", "delete"]);
    for (const line of lines) {
      expect(typeof line.at).toBe("string");
      expect(typeof line.bytes).toBe("number");
    }
    // ⚠️ Ni le contenu, ni le secret n'apparaissent dans le journal.
    expect(journal).not.toContain("modifié");
    expect(journal).not.toContain(secret);
    expect(journal).not.toContain("texte ");
  });
});

describe("HeritageAdminService — RÈGLE CARDINALE : jamais dans la mémoire courante", () => {
  it("écrire l'archive ne touche JAMAIS memory.jsonl", () => {
    const base = mkdtempSync(join(tmpdir(), "yuki-heritage-isolation-"));
    tempDirs.push(base);
    const quiet = logger();
    const memoryPath = join(base, "memory.jsonl");
    const memoryStore = MemoryStore.open({ path: memoryPath, logger: quiet });
    memoryStore.add({ text: "souvenir courant", source: "s", cat: "fait" });
    const before = readFileSync(memoryPath, "utf8");

    const heritageStore = new HeritageStore({ dir: join(base, "memory-heritage"), logger: quiet });
    heritageStore.ensureLayout();
    const admin = new HeritageAdminService(heritageStore, { logger: quiet, secretValues: [] });
    const created = admin.create({ titre: "Vie antérieure", texte: "SOUL de Yuki-old" });
    admin.update(created.entry.cle, { titre: "Vie antérieure", texte: "SOUL modifié" });
    admin.remove(created.entry.cle);

    const after = readFileSync(memoryPath, "utf8");
    // Le fichier de mémoire est BYTE POUR BYTE identique et ne contient rien de l'archive.
    expect(after).toBe(before);
    expect(after).not.toContain("SOUL");
    expect(after).not.toContain("Vie antérieure");
  });
});
