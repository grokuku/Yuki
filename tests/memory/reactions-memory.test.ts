/**
 * Mémoire durable — RÉGULARITÉ issue des RÉACTIONS.
 *
 * Ce que ce fichier prouve :
 *  - une régularité (le même jugement sur N messages DIFFÉRENTS) devient UN
 *    souvenir, avec sa justification (`why`) et sa source (`reactions`) ;
 *  - elle passe par les gardes EXISTANTS : filtre déterministe, `why`
 *    obligatoire, texte identique refusé, quasi-doublon REFUSÉ (la mémoire n'est
 *    donc pas relâchée) ;
 *  - mémoire DÉSACTIVÉE ⇒ aucune écriture ;
 *  - un échec d'écriture ne casse jamais le clic (rien n'est levé).
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryIndex, MemoryService, MemoryStore, REACTIONS_SOURCE } from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";
import { ReactionStore } from "../../src/reactions/store.js";
import { regularityMemory, type ReactionRegularity } from "../../src/reactions/types.js";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "yuki-memory-reactions-"));
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

function harness(): {
  service: MemoryService;
  store: MemoryStore;
  memoryPath: string;
  setEnabled: (value: boolean) => void;
  close: () => void;
} {
  const dir = tempDir();
  const memoryPath = join(dir, "memory.jsonl");
  const store = MemoryStore.open({ path: memoryPath, logger: logger() });
  const index = new MemoryIndex({
    path: join(dir, "memory-index.sqlite"),
    logger: logger(),
  });
  let enabled = true;
  const service = new MemoryService({
    store,
    index,
    logger: logger(),
    enabled: () => enabled,
    bounds: () => ({ topK: 5, budgetChars: 8000, timeoutMs: 400 }),
    maxItemsPerPass: () => 3,
  });
  service.start();
  return {
    service,
    store,
    memoryPath,
    setEnabled: (value) => {
      enabled = value;
    },
    close: () => service.close(),
  };
}

describe("mémoire — une RÉGULARITÉ de réactions devient un souvenir", () => {
  it("écrit le souvenir avec sa justification et sa source (`reactions`)", async () => {
    const h = harness();
    const candidate = regularityMemory({ reaction: "trop-long", group: "judgement", count: 3 })!;
    h.service.onReactionRegularity({ ...candidate, source: REACTIONS_SOURCE });
    await h.service.drain();

    expect(h.store.size).toBe(1);
    expect(h.store.entries[0]).toMatchObject({
      cat: "preference",
      source: REACTIONS_SOURCE,
      why: candidate.why,
    });
    expect(h.store.entries[0].text).toContain("Trop long");
    h.close();
  });

  it("n'écrit pas deux fois la même régularité (texte identique refusé par le store)", async () => {
    const h = harness();
    const candidate = regularityMemory({ reaction: "trop-long", group: "judgement", count: 3 })!;
    h.service.onReactionRegularity({ ...candidate, source: REACTIONS_SOURCE });
    h.service.onReactionRegularity({ ...candidate, source: REACTIONS_SOURCE });
    await h.service.drain();

    expect(h.store.size).toBe(1);
    h.close();
  });

  it("REFUSE un quasi-doublon d'un souvenir existant (déduplication existante)", async () => {
    const h = harness();
    h.store.add({
      text: "L'utilisateur juge souvent mes réponses « Trop long » (3 messages) : c'est une tendance, pas un cas isolé.",
      cat: "preference",
      why: "déjà connue",
      source: "entry-1",
    });
    const candidate = regularityMemory({
      reaction: "trop-long",
      group: "judgement",
      count: 6,
    })!;
    h.service.onReactionRegularity({ ...candidate, source: REACTIONS_SOURCE });
    await h.service.drain();

    // Le compte a changé, la phrase non : c'est un quasi-doublon ⇒ rien de neuf.
    expect(h.store.size).toBe(1);
    h.close();
  });

  it("REFUSE une candidature SANS justification (`why` obligatoire)", async () => {
    const h = harness();
    const candidate = regularityMemory({ reaction: "faux", group: "judgement", count: 3 })!;
    h.service.onReactionRegularity({ ...candidate, why: "   ", source: REACTIONS_SOURCE });
    await h.service.drain();

    expect(h.store.size).toBe(0);
    h.close();
  });

  it("applique le FILTRE déterministe (un cadrage de données n'est jamais un souvenir)", async () => {
    const h = harness();
    h.service.onReactionRegularity({
      text: "<reactions_utilisateur>\n- [jugement · 🐢 Trop long]\n</reactions_utilisateur>",
      cat: "preference",
      why: "justification",
      source: REACTIONS_SOURCE,
    });
    await h.service.drain();

    expect(h.store.size).toBe(0);
    h.close();
  });

  it("mémoire DÉSACTIVÉE ⇒ aucune écriture (et aucun fichier pollué)", async () => {
    const h = harness();
    h.setEnabled(false);
    const candidate = regularityMemory({ reaction: "rire", group: "emotion", count: 3 })!;
    h.service.onReactionRegularity({ ...candidate, source: REACTIONS_SOURCE });
    await h.service.drain();

    expect(h.store.size).toBe(0);
    // Aucune ÉCRITURE dans le journal (une réaction ne doit jamais polluer la
    // mémoire) : aucune ligne JSON n'a été ajoutée sous l'en-tête commenté.
    const written = readFileSync(h.memoryPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.startsWith("#"));
    expect(written).toEqual([]);
    h.close();
  });

  it("ne lève JAMAIS (un clic ne doit rien casser, même si le store est fermé)", async () => {
    const h = harness();
    const candidate = regularityMemory({ reaction: "fatigue", group: "mood", count: 3 })!;
    h.close();
    expect(() =>
      h.service.onReactionRegularity({ ...candidate, source: REACTIONS_SOURCE }),
    ).not.toThrow();
    await h.service.drain();
  });
});

describe("chaîne COMPLÈTE (store de réactions → mémoire) — aucune pollution", () => {
  /**
   * Reproduit le câblage de la composition root : `ReactionStore.set` renvoie la
   * régularité franchie, qui est traduite en candidat puis soumise à la mémoire
   * (filtre + `why` + déduplication).
   */
  function wire(options: { enabled?: boolean } = {}) {
    const h = harness();
    if (options.enabled === false) h.setEnabled(false);
    const dir = tempDir();
    const reactions = ReactionStore.open({ path: join(dir, "reactions.jsonl") });
    const candidates: ReactionRegularity[] = [];
    const port = {
      set: (sessionId: string, entryId: string, reaction: string): boolean => {
        const regularity = reactions.set(sessionId, entryId, reaction);
        if (regularity) {
          candidates.push(regularity);
          const candidate = regularityMemory(regularity);
          if (candidate) {
            h.service.onReactionRegularity({ ...candidate, source: REACTIONS_SOURCE });
          }
        }
        return regularity !== null;
      },
    };
    return { ...h, reactions, port, candidates };
  }

  it("UNE réaction ISOLÉE n'écrit RIEN dans memory.jsonl", async () => {
    const w = wire();
    w.port.set("s1", "e-1", "trop-long");
    await w.service.drain();

    expect(w.candidates).toEqual([]);
    expect(w.store.size).toBe(0);
    const written = readFileSync(w.memoryPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.startsWith("#"));
    expect(written).toEqual([]);
    w.close();
  });

  it("une RÉGULARITÉ (3 messages distincts) écrit UN souvenir, pas trois", async () => {
    const w = wire();
    for (const entryId of ["e-1", "e-2", "e-3"]) w.port.set("s1", entryId, "trop-long");
    await w.service.drain();

    expect(w.candidates).toHaveLength(1);
    expect(w.store.size).toBe(1);
    expect(w.store.entries[0].source).toBe(REACTIONS_SOURCE);
    expect(w.store.entries[0].text).toContain("Trop long");
    w.close();
  });

  it("changer d'avis sur le MÊME message ne crée aucune régularité", async () => {
    const w = wire();
    w.port.set("s1", "e-1", "trop-long");
    w.port.set("s1", "e-1", "faux");
    w.port.set("s1", "e-2", "faux");
    await w.service.drain();

    expect(w.candidates).toEqual([]);
    expect(w.store.size).toBe(0);
    w.close();
  });

  it("mémoire DÉSACTIVÉE : la réaction est persistée, le souvenir ne l'est pas", async () => {
    const w = wire({ enabled: false });
    for (const entryId of ["e-1", "e-2", "e-3"]) w.port.set("s1", entryId, "utile");
    await w.service.drain();

    // La régularité est bien DÉTECTÉE (le store de réactions vit sa vie)…
    expect(w.candidates).toHaveLength(1);
    // …mais la mémoire, désactivée, n'écrit rien.
    expect(w.store.size).toBe(0);
    expect(w.reactions.size).toBe(3);
    w.close();
  });
});
