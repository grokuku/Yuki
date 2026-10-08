/**
 * `HeritageStore` (Lot 13) — lecture filesystem TOLÉRANTE.
 *
 * Prouve : mise en place (notice + manifeste sans écraser), lecture d'entrées
 * JSON/Markdown, résolution par id/titre, et surtout le comportement PROPRE
 * quand l'archive est ABSENTE ou CORROMPUE (aucune exception, message honnête).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HeritageStore, HERITAGE_LABEL } from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-heritage-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function logger() {
  return createLogger({ level: "error", sink: () => undefined, secretValues: [] });
}

describe("HeritageStore — mise en place", () => {
  it("crée la structure (notice + manifeste) sans écraser l'existant", () => {
    const dir = join(tempDir(), "memory-heritage");
    const store = new HeritageStore({ dir, logger: logger() });
    store.ensureLayout();

    const manifestPath = join(dir, "manifest.json");
    const readmePath = join(dir, "README.md");
    store.ensureLayout(); // deuxième appel : ne doit RIEN écraser.

    const firstManifest = readFileSync(manifestPath, "utf8");
    writeFileSync(readmePath, "notice personnalisée", "utf8");
    store.ensureLayout();
    expect(readFileSync(readmePath, "utf8")).toBe("notice personnalisée");
    expect(firstManifest).toContain(HERITAGE_LABEL);
  });
});

describe("HeritageStore — lecture à la demande", () => {
  it("lit des entrées JSON/Markdown, applique l'étiquette, résout par id/titre", () => {
    const dir = tempDir();
    const entriesDir = join(dir, "entries");
    mkdirSync(entriesDir, { recursive: true });
    writeFileSync(
      join(entriesDir, "identite.json"),
      JSON.stringify({ titre: "Identité", categorie: "identite", texte: "SOUL." }),
      "utf8",
    );
    writeFileSync(join(dir, "reves.md"), "# Rêves\n\nVoyager.", "utf8");

    const store = new HeritageStore({ dir, logger: logger() });
    store.refresh();
    expect(store.info().entries).toBe(2);
    expect(store.info().present).toBe(true);

    const entries = store.list();
    expect(entries.every((entry) => entry.label === HERITAGE_LABEL)).toBe(true);

    const byTitle = store.read("Identité");
    expect(byTitle?.texte).toBe("SOUL.");
    const byId = store.read("heritage-reves");
    expect(byId?.texte).toContain("Voyager.");
    expect(store.read("inexistant")).toBeUndefined();
  });

  it("archive ABSENTE : aucune entrée, aucune exception, message honnête", () => {
    const store = new HeritageStore({ dir: join(tempDir(), "jamais-creee"), logger: logger() });
    store.refresh();
    expect(store.info()).toMatchObject({ present: false, entries: 0 });
    expect(store.list()).toEqual([]);
    expect(store.read("x")).toBeUndefined();
  });

  it("archive CORROMPUE : entrée illisible ignorée, erreur CONSERVÉE (pas de crash)", () => {
    const dir = tempDir();
    const entriesDir = join(dir, "entries");
    mkdirSync(entriesDir, { recursive: true });
    // Fichier illisible (répertoire au nom d'un fichier attendu).
    mkdirSync(join(entriesDir, "casse.json"), { recursive: true });
    writeFileSync(join(entriesDir, "ok.md"), "Texte lisible", "utf8");

    const store = new HeritageStore({ dir, logger: logger() });
    store.refresh();
    const entries = store.list();
    // Le fichier illisible est écarté ; l'autre reste lisible.
    expect(entries.map((entry) => entry.fichier)).toContain("ok.md");
    expect(entries.some((entry) => entry.fichier === "casse.json")).toBe(false);
    expect(store.errors().length).toBeGreaterThan(0);
  });
});
