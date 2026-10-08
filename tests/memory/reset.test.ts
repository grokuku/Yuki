/**
 * Réinitialisation de la mémoire durable — « mettre de côté, pas effacer ».
 *
 * Couvre : archivage EFFECTIF récupérable (le fichier d'origine repart propre,
 * l'archive contient les entrées), l'index DÉRIVÉ qui repart vide puis se
 * reconstruit, le service qui ne sert PLUS les anciens souvenirs (piège du cache
 * en RAM), la non-régression (de nouvelles entrées fonctionnent après reset), la
 * mémoire VIDE (message honnête, aucune archive vide), et l'INTACTUDE de la
 * personnalité et de l'archive « vie antérieure ».
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MEMORY_ARCHIVE_DIR_NAME,
  MemoryIndex,
  MemoryService,
  MemoryStore,
  type MemoryBounds,
} from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-memory-reset-"));
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

const BOUNDS: MemoryBounds = { topK: 5, budgetChars: 8000, timeoutMs: 500 };

function makeService(store: MemoryStore, index: MemoryIndex): MemoryService {
  return new MemoryService({
    store,
    index,
    logger: logger(),
    enabled: () => true,
    bounds: () => BOUNDS,
  });
}

describe("MemoryStore — archivage récupérable (jamais une destruction)", () => {
  it("renomme le journal dans memory-archive/ et recrée un fichier propre", () => {
    const dir = tempDir();
    const path = join(dir, "memory.jsonl");
    const store = MemoryStore.open({ path, logger: logger() });
    store.add({ text: "L'utilisateur aime les crêpes bretonnes", source: "a", cat: "preference" });
    store.add({ text: "L'utilisateur habite à Rennes", source: "b", cat: "fait" });

    const result = store.archiveAndReset();

    expect(result.archived).toBe(true);
    expect(result.entries).toBe(2);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.archivePath).not.toBeNull();
    // L'archive existe ET contient bien les entrées archivées.
    expect(existsSync(result.archivePath as string)).toBe(true);
    const archived = readFileSync(result.archivePath as string, "utf8");
    expect(archived).toContain("crêpes bretonnes");
    expect(archived).toContain("Rennes");
    // Le fichier d'origine existe toujours : c'est un NOUVEAU fichier propre.
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("mémoire durable");
    expect(store.size).toBe(0);
    expect(store.entries).toEqual([]);
  });

  it("archive sous le dossier voisin memory-archive (suffixe horodaté)", () => {
    const dir = tempDir();
    const path = join(dir, "memory.jsonl");
    const store = MemoryStore.open({ path, logger: logger() });
    store.add({ text: "Un souvenir", source: "a", cat: "fait" });
    const result = store.archiveAndReset();
    expect(result.archivePath).not.toBeNull();
    const archiveDir = join(dir, MEMORY_ARCHIVE_DIR_NAME);
    expect(existsSync(archiveDir)).toBe(true);
    expect((result.archivePath as string).startsWith(archiveDir)).toBe(true);
    expect(result.archivePath as string).toMatch(/memory-\d{4}-\d{2}-\d{2}T.*\.jsonl$/);
  });

  it("diffuse un changement « reset » (l'index dérivé repart de zéro)", () => {
    const dir = tempDir();
    const store = MemoryStore.open({ path: join(dir, "memory.jsonl"), logger: logger() });
    const types: string[] = [];
    store.subscribe((change) => types.push(change.type));
    store.add({ text: "Un souvenir", source: "a", cat: "fait" });
    store.archiveAndReset();
    expect(types).toContain("reset");
  });

  it("mémoire VIDE ⇒ aucune archive vide créée (message honnête)", () => {
    const dir = tempDir();
    const path = join(dir, "memory.jsonl");
    const store = MemoryStore.open({ path, logger: logger() });
    const result = store.archiveAndReset();
    expect(result.archived).toBe(false);
    expect(result.entries).toBe(0);
    expect(result.archivePath).toBeNull();
    expect(existsSync(join(dir, MEMORY_ARCHIVE_DIR_NAME))).toBe(false);
    // Le fichier de mémoire (avec en-tête) est toujours là pour la lisibilité.
    expect(existsSync(path)).toBe(true);
  });
});

describe("MemoryService — reset invalide le cache en RAM ET l'index dérivé", () => {
  it("ne sert PLUS les anciens souvenirs, l'index repart vide puis se reconstruit", async () => {
    const dir = tempDir();
    const storePath = join(dir, "memory.jsonl");
    const indexPath = join(dir, "memory-index.sqlite");
    const store = MemoryStore.open({ path: storePath, logger: logger() });
    const index = new MemoryIndex({ path: indexPath, logger: logger() });
    const service = makeService(store, index);
    service.start();

    store.add({ text: "L'utilisateur adore les crêpes bretonnes", source: "a", cat: "preference" });
    store.add({ text: "L'utilisateur habite à Rennes", source: "b", cat: "fait" });

    // AVANT reset : la mémoire fonctionne (on n'a rien cassé).
    const before = await service.recall("crêpes");
    expect(before.block).not.toBeNull();
    expect(before.block).toContain("crêpes bretonnes");

    const result = service.resetMemory();
    expect(result.archived).toBe(true);
    expect(result.entries).toBe(2);

    // La projection RAM est vide ET l'index est vide : plus AUCUN ancien souvenir.
    expect(store.size).toBe(0);
    expect(index.count()).toBe(0);
    const after = await service.recall("crêpes");
    expect(after.block).toBeNull();
    expect(after.entries).toBe(0);

    // Non-régression : une NOUVELLE entrée est bien indexée et rappelée.
    store.add({ text: "Nouveau souvenir : les crêpes au sucre", source: "n", cat: "fait" });
    const after2 = await service.recall("crêpes");
    expect(after2.block).not.toBeNull();
    expect(after2.block).toContain("Nouveau souvenir");
    expect(index.count()).toBe(1);
    service.close();

    // L'index est DÉRIVÉ : supprimé, il se RECONSTRUIT depuis le JSONL au démarrage.
    rmSync(indexPath, { force: true });
    const store2 = MemoryStore.open({ path: storePath, logger: logger() });
    const index2 = new MemoryIndex({ path: indexPath, logger: logger() });
    const service2 = makeService(store2, index2);
    service2.start();
    const rebuilt = await service2.recall("crêpes");
    expect(rebuilt.block).toContain("Nouveau souvenir");
    service2.close();
  });

  it("info() expose le nombre d'entrées et le dossier d'archive", () => {
    const dir = tempDir();
    const store = MemoryStore.open({ path: join(dir, "memory.jsonl"), logger: logger() });
    const index = new MemoryIndex({ path: join(dir, "memory-index.sqlite"), logger: logger() });
    const service = makeService(store, index);
    store.add({ text: "Un souvenir", source: "a", cat: "fait" });
    expect(service.info()).toEqual({
      entries: 1,
      archiveDir: join(dir, MEMORY_ARCHIVE_DIR_NAME),
    });
    service.close();
  });
});

describe("Reset — la personnalité et l'archive « vie antérieure » sont INTOUCHÉES", () => {
  it("ne touche ni personality.md ni memory-heritage/", () => {
    const dir = tempDir();
    const personalityPath = join(dir, "personality.md");
    const heritageDir = join(dir, "memory-heritage");
    writeFileSync(personalityPath, "# Yuki\n\nJe suis Yuki.\n", "utf8");
    mkdirSync(heritageDir, { recursive: true });
    writeFileSync(join(heritageDir, "vie.md"), "Archive vie antérieure\n", "utf8");

    const store = MemoryStore.open({ path: join(dir, "memory.jsonl"), logger: logger() });
    store.add({ text: "Un souvenir ordinaire", source: "a", cat: "fait" });
    const result = store.archiveAndReset();
    expect(result.archived).toBe(true);

    // Personnalité : fichier INTACT.
    expect(readFileSync(personalityPath, "utf8")).toBe("# Yuki\n\nJe suis Yuki.\n");
    // Archive « vie antérieure » : fichier INTACT.
    expect(readFileSync(join(heritageDir, "vie.md"), "utf8")).toBe("Archive vie antérieure\n");
    // Le dossier d'archive mémoire ne contient AUCUN de ces deux fichiers.
    const archived = readFileSync(result.archivePath as string, "utf8");
    expect(archived).not.toContain("Je suis Yuki");
    expect(archived).not.toContain("vie antérieure");
  });
});
