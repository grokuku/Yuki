/**
 * Coût du RAPPEL mémoire (`MemoryPort.recall`) — MESURÉ, pas supposé.
 *
 * Le rappel est dans le chemin BLOQUANT du run : `before_agent_start` l'attend
 * (`src/pi/sdk/memory-extension.ts`) et il est COMPTÉ dans le TTFT. Ce test
 * peuple un store réaliste, construit l'index, puis mesure `recall.durationMs`
 * (déjà mesuré par le service) sur des recherches répétées.
 *
 * Les bornes sont GÉNÉREUSES (anti-flaky) ; les valeurs réelles sont imprimées
 * pour le rapport. Elles doivent rester très en deçà du plafond configuré
 * (`memory.recall.timeoutMs`, défaut 400 ms) — sinon le rappel coûterait au
 * premier token.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MemoryIndex,
  MemoryService,
  MemoryStore,
  type MemoryBounds,
} from "../../src/memory/index.js";
import { createLogger } from "../../src/observability/logger.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function logger() {
  return createLogger({ level: "error", sink: () => undefined, secretValues: [] });
}

describe("coût du rappel mémoire (chemin bloquant du TTFT)", () => {
  it("reste très en deçà du plafond de 400 ms sur un store peuplé", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-memory-recall-"));
    tempDirs.push(dir);
    const store = MemoryStore.open({ path: join(dir, "memory.jsonl"), logger: logger() });
    const index = new MemoryIndex({ path: join(dir, "memory-index.sqlite"), logger: logger() });

    // Store réaliste : plusieurs centaines de souvenirs, sujets variés.
    const subjects = [
      "crêpes bretonnes",
      "Rennes",
      "clavier mécanique",
      "vacances en Bretagne",
      "TypeScript",
      "café le matin",
      "vélo électrique",
      "jardinage",
    ];
    for (let i = 0; i < 500; i += 1) {
      store.add({
        text: `L'utilisateur parle de ${subjects[i % subjects.length]} (n°${i})`,
        cat: "autre",
        source: `seed-${i}`,
      });
    }

    const bounds: MemoryBounds = { topK: 5, budgetChars: 8000, timeoutMs: 400 };
    const service = new MemoryService({
      store,
      index,
      logger: logger(),
      enabled: () => true,
      bounds: () => bounds,
    });
    service.start();

    const samples: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      const result = await service.recall("crêpes bretonnes Rennes");
      samples.push(result.durationMs);
      expect(result.enabled).toBe(true);
    }
    const max = Math.max(...samples);
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    console.log(
      `[recall] n=20 max=${max}ms avg=${avg.toFixed(1)}ms (plafond configuré 400ms)`,
    );

    // Le rappel doit rester TRÈS en deçà du plafond : c'est la part que le
    // rappel ajoute au TTFT en régime établi (index ouvert).
    expect(max).toBeLessThan(150);
    service.close();
  });
});
