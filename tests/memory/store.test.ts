/**
 * Store de mémoire (Lot 12) — écriture étroite, source/date conservées,
 * idempotence (dédup), rejeu tolérant, format JSONL documenté.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MEMORY_FILE_HEADER,
  MemoryStore,
  parseEvent,
  type MemoryEvent,
} from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

function tempStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-memory-"));
  tempDirs.push(dir);
  return join(dir, "memory.jsonl");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function logger() {
  return createLogger({ level: "error", sink: () => undefined, secretValues: [] });
}

/** Lignes d'événements (hors en-tête commenté et lignes vides). */
function eventLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function newStore(path: string, idFactory?: () => string): MemoryStore {
  return MemoryStore.open({
    path,
    logger: logger(),
    now: () => Date.parse("2026-02-01T10:00:00.000Z"),
    ...(idFactory ? { idFactory } : {}),
  });
}

describe("MemoryStore — format, source et date", () => {
  it("crée un fichier LISIBLE avec un en-tête commenté décrivant le format", () => {
    const path = tempStorePath();
    newStore(path);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(MEMORY_FILE_HEADER);
    expect(MEMORY_FILE_HEADER).toContain('"t":"add"');
  });

  it("conserve la source (message d'origine) et la date de création", () => {
    const path = tempStorePath();
    const store = newStore(path, () => "mem-1");
    const { entry, created } = store.add({
      text: "L'utilisateur préfère le café sans sucre.",
      source: "entry-42",
      cat: "preference",
    });
    expect(created).toBe(true);
    expect(entry).toMatchObject({
      id: "mem-1",
      source: "entry-42",
      cat: "preference",
      at: "2026-02-01T10:00:00.000Z",
    });
    expect(entry.text).toBe("L'utilisateur préfère le café sans sucre.");
  });

  it("est IDEMPOTENT : rejouer la même extraction ne duplique pas", () => {
    const path = tempStorePath();
    let counter = 0;
    const store = newStore(path, () => `mem-${++counter}`);
    const first = store.add({ text: "Yuki aime les crêpes.", source: "e1", cat: "fait" });
    // Même contenu, casse/accents/espaces différents ⇒ même empreinte.
    const second = store.add({ text: "  yuki aime les  CREPES.  ", source: "e2", cat: "fait" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(store.size).toBe(1);
    expect(eventLines(path)).toHaveLength(1);
  });
});

describe("MemoryStore — éditions ÉTROITES (append-only, jamais de réécriture)", () => {
  it("ajout / mise à jour / suppression = EXACTEMENT une ligne ajoutée à chaque fois", () => {
    const path = tempStorePath();
    let counter = 0;
    const store = newStore(path, () => `mem-${++counter}`);
    store.add({ text: "Souvenir A", source: "e1", cat: "fait" });
    expect(eventLines(path)).toHaveLength(1);

    const id = store.entries[0]!.id;
    store.update(id, { text: "Souvenir A corrigé", cat: "projet" });
    expect(eventLines(path)).toHaveLength(2);
    expect(store.get(id)).toMatchObject({
      text: "Souvenir A corrigé",
      cat: "projet",
      updatedAt: "2026-02-01T10:00:00.000Z",
    });
    // La source d'origine est CONSERVÉE par une mise à jour sans source.
    expect(store.get(id)?.source).toBe("e1");

    store.remove(id);
    expect(eventLines(path)).toHaveLength(3);
    expect(store.get(id)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it("une mise à jour/suppression d'un id inconnu ne modifie pas le fichier", () => {
    const path = tempStorePath();
    const store = newStore(path);
    expect(store.update("nope", { text: "x" })).toBe(false);
    expect(store.remove("nope")).toBe(false);
    expect(eventLines(path)).toHaveLength(0);
  });

  it("une mise à jour sans changement est un no-op (aucune ligne)", () => {
    const path = tempStorePath();
    const store = newStore(path, () => "mem-1");
    store.add({ text: "Texte", source: "e1", cat: "fait" });
    expect(store.update("mem-1", { text: "Texte", cat: "fait" })).toBe(false);
    expect(eventLines(path)).toHaveLength(1);
  });
});

describe("MemoryStore — rejeu", () => {
  it("reconstruit la projection exacte en rejouant le journal", () => {
    const path = tempStorePath();
    const store = newStore(path, (() => {
      let n = 0;
      return () => `mem-${++n}`;
    })());
    store.add({ text: "Un", source: "e1", cat: "fait" });
    store.add({ text: "Deux", source: "e2", cat: "preference" });
    store.remove("mem-1");
    store.update("mem-2", { text: "Deux bis" });

    const reopened = newStore(path);
    expect(reopened.entries.map((entry) => ({ id: entry.id, text: entry.text }))).toEqual([
      { id: "mem-2", text: "Deux bis" },
    ]);
  });

  it("ignore TOLÉRAMMENT une ligne corrompue, sans bloquer", () => {
    const path = tempStorePath();
    const store = newStore(path, () => "mem-1");
    store.add({ text: "Valide", source: "e1", cat: "fait" });
    // Injection d'une ligne illisible + d'une ligne de forme inconnue.
    const content = readFileSync(path, "utf8");
    writeFileSync(path, `${content}Ceci n'est pas du JSON\n{"v":1,"t":"bogus"}\n`);

    const reopened = newStore(path);
    expect(reopened.size).toBe(1);
    expect(reopened.entries[0]?.text).toBe("Valide");
  });
});

describe("parseEvent", () => {
  it("normalise les catégories inconnues vers « autre »", () => {
    const event = parseEvent({
      v: 1,
      t: "add",
      id: "m",
      at: "2026-01-01T00:00:00.000Z",
      text: "x",
      source: "s",
      cat: "inconnue",
    });
    expect(event).toMatchObject({ t: "add", cat: "autre" });
  });

  it("rejette une version ou une forme invalide", () => {
    expect(parseEvent({ v: 2, t: "add" })).toBeNull();
    expect(parseEvent({ v: 1, t: "delete" })).toBeNull();
    expect(parseEvent("pas un objet")).toBeNull();
  });
});

describe("MemoryStore.fromEvents", () => {
  it("rejoue des événements fournis sans toucher le disque", () => {
    const events: MemoryEvent[] = [
      { v: 1, t: "add", id: "a", at: "t0", text: "Un", source: "s", cat: "fait" },
      { v: 1, t: "add", id: "b", at: "t1", text: "Deux", source: "s", cat: "fait" },
      { v: 1, t: "delete", id: "a", at: "t2" },
    ];
    const store = MemoryStore.fromEvents(events);
    expect(store.entries.map((entry) => entry.id)).toEqual(["b"]);
  });
});
