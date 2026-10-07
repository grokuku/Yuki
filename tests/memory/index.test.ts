/**
 * Index de recherche FTS5 (Lot 12) — `node:sqlite`, ZÉRO dépendance npm.
 * Vérifie : recherche (accents/casse), reconstruction, suppression, reprise après
 * corruption, et le fait que l'index est un DÉRIVÉ jetable.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryIndex, type MemoryEntry } from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

function tempIndexPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-memory-index-"));
  tempDirs.push(dir);
  return join(dir, "memory-index.sqlite");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function logger() {
  return createLogger({ level: "error", sink: () => undefined, secretValues: [] });
}

function entry(id: string, text: string, cat: MemoryEntry["cat"] = "autre"): MemoryEntry {
  return { id, at: "2026-01-01T00:00:00.000Z", text, source: "e", cat };
}

describe("MemoryIndex — recherche FTS5", () => {
  it("trouve par mots, INsensible aux ACCENTS et à la casse", () => {
    const index = new MemoryIndex({ path: tempIndexPath(), logger: logger() });
    expect(index.open()).toBe(true);
    index.rebuild([
      entry("m1", "L'utilisateur aime les crêpes et le café à Paris"),
      entry("m2", "Le chien dort sur le canapé"),
    ]);
    expect(index.count()).toBe(2);

    // Sans accent, minuscules, majuscules → tous trouvent « crêpes ».
    expect(index.search("crepes", 5)).toContain("m1");
    expect(index.search("CRÊPES", 5)).toContain("m1");
    expect(index.search("cafe", 5)).toContain("m1");
    expect(index.search("Canape", 5)).toContain("m2");
    expect(index.search("paris", 5)).toEqual(["m1"]);
    index.close();
  });

  it("classe par pertinence (bm25) et borne au top-k", () => {
    const index = new MemoryIndex({ path: tempIndexPath(), logger: logger() });
    index.open();
    index.rebuild([
      entry("m1", "Le chat mange"),
      entry("m2", "Le chat dort, le chat joue, le chat mange du poisson"),
    ]);
    const ids = index.search("chat", 1);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toBe("m2"); // Le plus dense en occurrences de « chat ».
    index.close();
  });

  it("réindex la suppression et la mise à jour", () => {
    const index = new MemoryIndex({ path: tempIndexPath(), logger: logger() });
    index.open();
    index.rebuild([entry("m1", "Le café du matin")]);
    index.remove("m1");
    expect(index.search("cafe", 5)).toEqual([]);
    index.upsert(entry("m2", "Le thé du soir"));
    expect(index.search("the", 5)).toEqual(["m2"]);
    expect(index.count()).toBe(1);
    index.close();
  });

  it("recherche sans terme exploitable ⇒ aucun résultat (pas d'erreur)", () => {
    const index = new MemoryIndex({ path: tempIndexPath(), logger: logger() });
    index.open();
    index.rebuild([entry("m1", "du texte")]);
    expect(index.search("", 5)).toEqual([]);
    expect(index.search("a", 5)).toEqual([]); // terme < 2 caractères
    expect(index.search('""" [[', 5)).toEqual([]); // syntaxe invalide neutralisée
    index.close();
  });

  it("est DÉRIVÉ : un fichier corrompu est recréé, l'index repart vide puis se reconstruit", () => {
    const path = tempIndexPath();
    writeFileSync(path, "ceci n'est pas une base SQLite");
    const index = new MemoryIndex({ path, logger: logger() });
    expect(index.open()).toBe(true);
    expect(index.isAvailable()).toBe(true);
    expect(index.count()).toBe(0);
    index.rebuild([entry("m1", "reconstruit")]);
    expect(index.search("reconstruit", 5)).toEqual(["m1"]);
    index.close();
  });

  it("persiste entre deux ouvertures (index dérivé mais durable)", () => {
    const path = tempIndexPath();
    const first = new MemoryIndex({ path, logger: logger() });
    first.open();
    first.rebuild([entry("m1", "souvenir persistant")]);
    first.close();

    const second = new MemoryIndex({ path, logger: logger() });
    second.open();
    expect(second.search("persistant", 5)).toEqual(["m1"]);
    second.close();
  });
});
