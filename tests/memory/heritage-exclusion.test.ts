/**
 * Archive « vie antérieure » (Lot 13) — EXCLUSION de la mémoire automatique.
 *
 * C'EST LE TEST CRITIQUE. Il distingue :
 *  - ce qui tient STRUCTURELLEMENT : l'archive est un dossier SÉPARÉ (voisin du
 *    store), jamais lu par l'extracteur ⇒ elle ne peut pas être fusionnée ;
 *  - ce qui tient par GARDE LOCALE : un contenu marqué « vie antérieure » collé
 *    dans le chat n'est pas extrait (`looksLikeHeritage`) ;
 *  - ce qui tient par CONSIGNE (faillible) : l'instruction d'extraction.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HERITAGE_LABEL,
  MemoryIndex,
  MemoryService,
  MemoryStore,
  type MemoryBounds,
} from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-heritage-excl-"));
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

interface Harness {
  service: MemoryService;
  store: MemoryStore;
  prompts: string[];
  close: () => void;
}

function harness(extractor: (prompt: string) => Promise<string>, dir = tempDir()): Harness {
  const store = MemoryStore.open({ path: join(dir, "memory.jsonl"), logger: logger() });
  const index = new MemoryIndex({ path: join(dir, "memory-index.sqlite"), logger: logger() });
  const prompts: string[] = [];
  const bounds: MemoryBounds = { topK: 5, budgetChars: 8000, timeoutMs: 400 };
  const service = new MemoryService({
    store,
    index,
    logger: logger(),
    enabled: () => true,
    bounds: () => bounds,
    extractor: async (prompt) => {
      prompts.push(prompt);
      return extractor(prompt);
    },
    maxItemsPerPass: () => 3,
  });
  service.start();
  return { service, store, prompts, close: () => service.close() };
}

const ARCHIVE_TEXT = [
  "=== VIE ANTÉRIEURE — NE PAS FUSIONNER ===",
  "Machine : Yuki-old (ère OpenClaw)",
  "L'utilisateur s'appelait… et vivait…",
].join("\n");

describe("EXCLUSION — fin de tour", () => {
  it("un contenu marqué « vie antérieure » n'est JAMAIS extrait (memory.jsonl reste vide)", async () => {
    const h = harness(async () => JSON.stringify([{ text: "Ceci ne doit pas exister", cat: "fait" }]));
    h.service.onTurnEnd({
      userText: ARCHIVE_TEXT,
      assistantText: "J'ai bien reçu cette archive, je ne la mémorise pas.",
      source: "entry-archive",
    });
    await h.service.drain();

    expect(h.prompts).toHaveLength(0);
    expect(h.store.size).toBe(0);
    const content = readFileSync(join(h.store.filePath), "utf8");
    expect(content).not.toContain("Ceci ne doit pas exister");
    h.close();
  });

  it("le marqueur peut venir de la RÉPONSE (contenu de l'archive recopié)", async () => {
    const h = harness(async () => JSON.stringify([{ text: "à ne pas mémoriser", cat: "fait" }]));
    h.service.onTurnEnd({
      userText: "Peux-tu me résumer ceci ?",
      assistantText: `Voici l'archive :\n${HERITAGE_LABEL}\n…contenu…`,
      source: "entry-2",
    });
    await h.service.drain();
    expect(h.prompts).toHaveLength(0);
    expect(h.store.size).toBe(0);
    h.close();
  });

  it("CONTRÔLE : un échange ORDINAIRE produit bien une entrée (Lot 12 intact)", async () => {
    const h = harness(async () => JSON.stringify([{ text: "L'utilisateur aime le thé", cat: "preference" }]));
    h.service.onTurnEnd({
      userText: "Je bois du thé tous les matins",
      assistantText: "Noté, je m'en souviendrai.",
      source: "entry-3",
    });
    await h.service.drain();
    expect(h.prompts).toHaveLength(1);
    expect(h.store.size).toBe(1);
    h.close();
  });

  it("le prompt d'extraction porte la consigne d'exclusion (garde faillible, explicite)", async () => {
    const h = harness(async () => "[]");
    h.service.onTurnEnd({
      userText: "Un message assez long pour déclencher l'extraction",
      assistantText: "Une réponse assez longue elle aussi",
      source: "entry-4",
    });
    await h.service.drain();
    expect(h.prompts[0]).toContain("ne mémorise RIEN");
    h.close();
  });
});

describe("EXCLUSION — consolidation avant compaction", () => {
  it("un message d'archive est ÉCARTÉ de la consolidation", async () => {
    const h = harness(async () => JSON.stringify([{ op: "add", text: "fusion interdite", cat: "fait" }]));
    h.service.onBeforeCompact({
      messages: [{ role: "user", text: ARCHIVE_TEXT }],
    });
    await h.service.drain();
    // Seul message = archive ⇒ rien à consolider ⇒ pas d'appel au modèle.
    expect(h.prompts).toHaveLength(0);
    expect(h.store.size).toBe(0);
    h.close();
  });

  it("les messages ordinaires restent consolidés à côté d'un message d'archive", async () => {
    const h = harness(async () => JSON.stringify([{ op: "add", text: "souvenir ordinaire", cat: "fait" }]));
    h.service.onBeforeCompact({
      messages: [
        { role: "user", text: ARCHIVE_TEXT },
        { role: "user", text: "Un message ordinaire suffisamment long" },
      ],
    });
    await h.service.drain();
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).not.toContain("VIE ANTÉRIEURE");
    expect(h.store.entries[0]?.text).toBe("souvenir ordinaire");
    h.close();
  });
});

describe("SÉPARATION STRUCTURELLE — l'archive n'est pas le store", () => {
  it("un dossier d'archive voisin n'apparaît JAMAIS dans memory.jsonl", () => {
    const dir = tempDir();
    // Archive déposée à côté du store (même racine).
    const archiveDir = join(dir, "memory-heritage", "entries");
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      join(archiveDir, "vie.json"),
      JSON.stringify({ titre: "Vie antérieure", texte: "SECRET d'une autre époque" }),
      "utf8",
    );

    const store = MemoryStore.open({ path: join(dir, "memory.jsonl"), logger: logger() });
    // Le store ne lit QUE son propre fichier : rien de l'archive n'y entre.
    expect(store.size).toBe(0);
    expect(readFileSync(store.filePath, "utf8")).not.toContain("SECRET d'une autre époque");
  });

  it("écrire dans le store ne recopie JAMAIS le contenu de l'archive", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "memory-heritage", "entries"), { recursive: true });
    writeFileSync(
      join(dir, "memory-heritage", "entries", "vie.json"),
      JSON.stringify({ titre: "Vie antérieure", texte: "contenu d'une vie antérieure" }),
      "utf8",
    );
    const store = MemoryStore.open({ path: join(dir, "memory.jsonl"), logger: logger() });
    store.add({ text: "Un souvenir ordinaire", source: "s", cat: "fait" });
    const content = readFileSync(store.filePath, "utf8");
    expect(content).toContain("Un souvenir ordinaire");
    expect(content).not.toContain("contenu d'une vie antérieure");
  });
});
