/**
 * Service de mémoire (Lot 12) — écriture automatique (extraction ⇒ entrée,
 * idempotence), rappel BORNÉ, dégradation gracieuse, consolidation, budget.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryIndex,
  MemoryService,
  MemoryStore,
  formatMemoryBlock,
  type MemoryBounds,
  type MemoryEntry,
} from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-memory-svc-"));
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
  index: MemoryIndex;
  prompts: string[];
  setEnabled: (value: boolean) => void;
  setBounds: (bounds: MemoryBounds) => void;
  close: () => void;
}

function harness(options: {
  extractor?: (prompt: string) => Promise<string>;
  maxItems?: number;
  bounds?: Partial<MemoryBounds>;
  indexPath?: string;
  storePath?: string;
} = {}): Harness {
  const dir = tempDir();
  const store = MemoryStore.open({
    path: options.storePath ?? join(dir, "memory.jsonl"),
    logger: logger(),
  });
  const index = new MemoryIndex({
    path: options.indexPath ?? join(dir, "memory-index.sqlite"),
    logger: logger(),
  });
  const prompts: string[] = [];
  let enabled = true;
  let bounds: MemoryBounds = {
    topK: 5,
    budgetChars: 8000,
    timeoutMs: 400,
    ...options.bounds,
  };
  const extractor = options.extractor
    ? async (prompt: string) => {
        prompts.push(prompt);
        return options.extractor!(prompt);
      }
    : undefined;
  const service = new MemoryService({
    store,
    index,
    logger: logger(),
    enabled: () => enabled,
    bounds: () => bounds,
    ...(extractor ? { extractor } : {}),
    maxItemsPerPass: () => options.maxItems ?? 3,
  });
  return {
    service,
    store,
    index,
    prompts,
    setEnabled: (value) => {
      enabled = value;
    },
    setBounds: (value) => {
      bounds = value;
    },
    close: () => service.close(),
  };
}

describe("MemoryService — écriture automatique (fin de tour)", () => {
  it("extrait 0–N souvenirs et les écrit avec la source du message d'origine", async () => {
    const h = harness({
      extractor: async () =>
        JSON.stringify([
          { text: "L'utilisateur préfère le thé au café", cat: "preference" },
        ]),
    });
    h.service.start();
    h.service.onTurnEnd({
      userText: "Je préfère le thé au café désormais",
      assistantText: "C'est noté, je m'en souviendrai.",
      source: "entry-99",
    });
    await h.service.drain();

    expect(h.store.size).toBe(1);
    expect(h.store.entries[0]).toMatchObject({
      text: "L'utilisateur préfère le thé au café",
      cat: "preference",
      source: "entry-99",
    });
    // Le prompt envoyé au modèle contient bien l'échange à analyser.
    expect(h.prompts[0]).toContain("Je préfère le thé au café désormais");
    h.close();
  });

  it("est IDEMPOTENT : rejouer la même extraction ne duplique pas (dédup)", async () => {
    const h = harness({
      extractor: async () => JSON.stringify([{ text: "Yuki aime les crêpes", cat: "fait" }]),
    });
    h.service.start();
    const input = {
      userText: "Je parle d'un sujet assez long",
      assistantText: "Voici une réponse assez longue",
      source: "e1",
    };
    h.service.onTurnEnd({ ...input, source: "e1" });
    await h.service.drain();
    h.service.onTurnEnd({ ...input, source: "e2" });
    await h.service.drain();
    expect(h.store.size).toBe(1);
    h.close();
  });

  it("ne fait RIEN si la mémoire est désactivée ou maxItems = 0", async () => {
    const off = harness({ extractor: async () => "[]" });
    off.setEnabled(false);
    off.service.start();
    off.service.onTurnEnd({ userText: "un long message", assistantText: "une longue réponse", source: "e" });
    await off.service.drain();
    expect(off.store.size).toBe(0);
    expect(off.prompts).toHaveLength(0);
    off.close();

    const zero = harness({ extractor: async () => "[]", maxItems: 0 });
    zero.service.start();
    zero.service.onTurnEnd({ userText: "un long message", assistantText: "une longue réponse", source: "e" });
    await zero.service.drain();
    expect(zero.store.size).toBe(0);
    zero.close();
  });

  it("UNE PANNE d'extraction n'affecte pas la conversation (aucune exception)", async () => {
    const h = harness({
      extractor: async () => {
        throw new Error("LLM indisponible");
      },
    });
    h.service.start();
    h.service.onTurnEnd({ userText: "un long message", assistantText: "une longue réponse", source: "e" });
    await expect(h.service.drain()).resolves.toBeUndefined();
    expect(h.store.size).toBe(0);
    h.close();
  });

  it("ignore un échange trop court (anti-bruit)", async () => {
    const h = harness({ extractor: async () => "[]" });
    h.service.start();
    h.service.onTurnEnd({ userText: "ok", assistantText: "ok", source: "e" });
    await h.service.drain();
    expect(h.prompts).toHaveLength(0);
    h.close();
  });
});

describe("MemoryService — rappel borné et dégradation gracieuse", () => {
  it("renvoie un bloc borné (top-k + budget) avec l'en-tête « donnée »", async () => {
    const h = harness({ bounds: { topK: 2, budgetChars: 8000, timeoutMs: 500 } });
    h.service.start();
    h.service.onTurnEnd({
      userText: "x".repeat(20),
      assistantText: "y".repeat(20),
      source: "s",
    });
    // Alimente directement le store (les écritures directes sont autorisées).
    h.store.add({ text: "L'utilisateur aime les crêpes bretonnes", source: "a", cat: "preference" });
    h.store.add({ text: "L'utilisateur habite à Rennes", source: "b", cat: "fait" });
    h.store.add({ text: "L'utilisateur adore les crêpes au sucre", source: "c", cat: "preference" });
    await h.service.drain();

    const result = await h.service.recall("crêpes");
    expect(result.block).not.toBeNull();
    expect(result.block).toContain("Mémoire durable");
    expect(result.block).toContain("DONNÉES");
    expect(result.entries).toBeLessThanOrEqual(2);
    expect(result.chars).toBeLessThanOrEqual(8000);
    h.close();
  });

  it("budget petit ⇒ bloc absent ou tronqué, jamais dépassé", async () => {
    const h = harness({ bounds: { topK: 5, budgetChars: 10, timeoutMs: 500 } });
    h.service.start();
    h.store.add({ text: "Un souvenir assez long pour dépasser le budget", source: "s", cat: "fait" });
    const result = await h.service.recall("souvenir");
    expect(result.block).toBeNull();
    expect(result.chars).toBe(0);
    h.close();
  });

  it("timeout nul ⇒ réponse SANS mémoire (dégradation gracieuse, pas d'exception)", async () => {
    const h = harness({ bounds: { topK: 5, budgetChars: 8000, timeoutMs: 0 } });
    h.service.start();
    h.store.add({ text: "Souvenir présent", source: "s", cat: "fait" });
    const result = await h.service.recall("souvenir");
    expect(result.block).toBeNull();
    h.close();
  });

  it("mémoire désactivée ⇒ aucun rappel", async () => {
    const h = harness();
    h.service.start();
    h.store.add({ text: "Souvenir présent", source: "s", cat: "fait" });
    h.setEnabled(false);
    expect((await h.service.recall("souvenir")).block).toBeNull();
    h.close();
  });

  it("index INDISPONIBLE (chemin inexploitable) ⇒ aucun rappel, aucune erreur", async () => {
    const dir = tempDir();
    const h = harness({ indexPath: dir, storePath: join(dir, "memory.jsonl") });
    h.service.start();
    h.store.add({ text: "Souvenir présent", source: "s", cat: "fait" });
    const result = await h.service.recall("souvenir");
    expect(result.block).toBeNull();
    expect(h.index.isAvailable()).toBe(false);
    h.close();
  });
});

describe("MemoryService — consolidation avant compaction", () => {
  it("applique une mise à jour d'une entrée existante", async () => {
    let targetId = "";
    const h = harness({
      extractor: async () =>
        JSON.stringify([
          { op: "update", id: targetId, text: "Fait corrigé", cat: "fait" },
        ]),
    });
    targetId = h.store.add({ text: "Fait obsolète", source: "s", cat: "fait" }).entry.id;
    h.service.start();
    h.service.onBeforeCompact({
      messages: [{ role: "user", text: "une longue phrase de contexte" }],
    });
    await h.service.drain();
    expect(h.store.entries[0]?.text).toBe("Fait corrigé");
    h.close();
  });

  it("applique une suppression d'une entrée existante", async () => {
    let targetId = "";
    const h = harness({
      extractor: async () => JSON.stringify([{ op: "delete", id: targetId }]),
    });
    targetId = h.store.add({ text: "À supprimer", source: "s", cat: "fait" }).entry.id;
    h.service.start();
    h.service.onBeforeCompact({
      messages: [{ role: "assistant", text: "une longue phrase de contexte" }],
    });
    await h.service.drain();
    expect(h.store.size).toBe(0);
    h.close();
  });

  it("un update sur un id inconnu devient un add (robustesse)", async () => {
    const h = harness({
      extractor: async () =>
        JSON.stringify([{ op: "update", id: "mem-inconnu", text: "Texte", cat: "fait" }]),
    });
    h.service.start();
    h.service.onBeforeCompact({
      messages: [{ role: "assistant", text: "un long contenu à consolider" }],
    });
    await h.service.drain();
    expect(h.store.size).toBe(1);
    expect(h.store.entries[0]?.text).toBe("Texte");
    h.close();
  });
});

describe("formatMemoryBlock", () => {
  it("borne le budget et renvoie null si rien ne tient", () => {
    const entries: MemoryEntry[] = [
      { id: "1", at: "t", text: "Premier souvenir", source: "s", cat: "fait" },
      { id: "2", at: "t", text: "Second souvenir", source: "s", cat: "fait" },
    ];
    const block = formatMemoryBlock(entries, 8000);
    expect(block).toContain("Premier souvenir");
    expect(block).toContain("Second souvenir");
    expect(formatMemoryBlock(entries, 5)).toBeNull();
    expect(formatMemoryBlock([], 8000)).toBeNull();
  });

  it("préfixe chaque souvenir de sa DATE (`at` ISO) et tolère une date illisible", () => {
    const entries: MemoryEntry[] = [
      {
        id: "1",
        at: "2026-10-05T09:12:00.000Z",
        text: "Préfère le tutoiement",
        source: "s",
        cat: "preference",
      },
      {
        // Date absente/illisible : AUCUN segment de date, jamais `[undefined]`.
        id: "2",
        at: "pas-une-date",
        text: "Souvenir ancien",
        source: "s",
        cat: "fait",
      },
    ];
    const block = formatMemoryBlock(entries, 8000);
    expect(block).toContain("- [2026-10-05] [preference] Préfère le tutoiement");
    expect(block).toContain("- [fait] Souvenir ancien");
    expect(block).not.toContain("undefined");
  });
});
