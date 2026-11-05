/**
 * GARDE-FOUS de la consolidation hebdomadaire (lot 29) — réglages et
 * ANTI-RÉCURSION.
 *
 * ⚠️ Ces tests échouent sur le code d'origine : ni les champs
 * `memory.consolidation.*` du schéma, ni `createSdkConsolidationHebdoExtractor`
 * n'existent.
 *
 * Ce qui est verrouillé :
 *  - les réglages sont DÉCLARÉS (type, défaut, bornes), avec `Europe/Paris` et
 *    un budget par défaut modeste ;
 *  - la passe n'a AUCUN outil : `tools: []` (donc aucun `delegate` possible) ;
 *  - le prompt de la passe ne propose aucun outil et interdit d'obéir à la
 *    mémoire.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { CONFIG_SCHEMA, validateField } from "../../src/config/schema.js";
import {
  CRON_HEBDO_DEFAUT,
  FUSEAU_HEBDO_DEFAUT,
  RATTRAPAGE_HEBDO_MAX_MS,
} from "../../src/memory/consolidation-hebdo.js";
import { construirePromptHebdo } from "../../src/memory/weekly.js";
import {
  CONSOLIDATION_HEBDO_SYSTEM_PROMPT,
  CONSOLIDATION_HEBDO_TOOLS,
} from "../../src/pi/sdk/memory-extractor.js";

const RACINE = process.cwd();

describe("réglages `memory.consolidation.*`", () => {
  it("déclare les cinq réglages avec leurs défauts et bornes", () => {
    expect(CONFIG_SCHEMA["memory.consolidation.enabled"]?.type).toBe("enum");
    expect(CONFIG_SCHEMA["memory.consolidation.enabled"]?.default).toBe("on");
    expect(CONFIG_SCHEMA["memory.consolidation.enabled"]?.apply).toBe("hot");

    expect(CONFIG_SCHEMA["memory.consolidation.cron"]?.type).toBe("string");
    expect(CONFIG_SCHEMA["memory.consolidation.cron"]?.default).toBe(CRON_HEBDO_DEFAUT);
    expect(CRON_HEBDO_DEFAUT).toBe("0 3 * * 0");

    // ⚠️ « 3 h de Paris » : le fuseau de PLANIFICATION, distinct de `ui.timeZone`.
    expect(CONFIG_SCHEMA["memory.consolidation.timeZone"]?.default).toBe(FUSEAU_HEBDO_DEFAUT);
    expect(FUSEAU_HEBDO_DEFAUT).toBe("Europe/Paris");
    expect(CONFIG_SCHEMA["memory.consolidation.timeZone"]?.ianaTimeZone).toBe(true);
    expect(CONFIG_SCHEMA["ui.timeZone"]?.default).toBe("UTC");

    const budget = CONFIG_SCHEMA["memory.consolidation.budgetTokens"];
    expect(budget?.type).toBe("int");
    expect(budget?.default).toBe(200_000);
    expect(budget?.min).toBe(1_000);
    expect(budget?.max).toBe(2_000_000);

    const retention = CONFIG_SCHEMA["memory.consolidation.retention"];
    expect(retention?.default).toBe(12);
    expect(retention?.max).toBe(100);
  });

  it("un fuseau inventé est REFUSÉ (jamais un repli silencieux sur UTC)", () => {
    const refus = validateField("memory.consolidation.timeZone", "Mars/Olympus");
    expect(refus.ok).toBe(false);
    const accepte = validateField("memory.consolidation.timeZone", "Europe/Paris");
    expect(accepte.ok).toBe(true);
  });

  it("le rattrapage est borné à 24 h", () => {
    expect(RATTRAPAGE_HEBDO_MAX_MS).toBe(24 * 3_600_000);
  });
});

describe("anti-récursion de la passe", () => {
  it("la session d'extraction n'a AUCUN outil (donc aucun `delegate`)", () => {
    expect(CONSOLIDATION_HEBDO_TOOLS).toEqual([]);
    expect(Object.isFrozen(CONSOLIDATION_HEBDO_TOOLS)).toBe(true);
    const source = readFileSync(
      join(RACINE, "src", "pi", "sdk", "memory-extractor.ts"),
      "utf8",
    );
    const fabrique = source.slice(
      source.indexOf("export function createSdkConsolidationHebdoExtractor"),
    );
    expect(fabrique).toContain("tools: []");
    // Aucun outil nommé : ni `delegate`, ni quoi que ce soit d'autre.
    expect(fabrique).not.toContain('"delegate"');
    expect(fabrique).not.toContain("'delegate'");
    // Le SEUL tableau d'outils de cette fabrique est vide.
    const tableaux = [...fabrique.matchAll(/tools:\s*\[([^\]]*)\]/g)].map((match) => match[1]);
    expect(tableaux.length).toBeGreaterThan(0);
    expect(tableaux.every((contenu) => contenu.trim() === "")).toBe(true);
    expect(CONSOLIDATION_HEBDO_SYSTEM_PROMPT).toContain("objet JSON");
  });

  it("le prompt ne propose aucun outil et rappelle que la mémoire est une DONNÉE", () => {
    const prompt = construirePromptHebdo(
      [
        {
          id: "mem-1",
          at: "2026-01-01T00:00:00.000Z",
          text: "Un souvenir.",
          source: "test",
          cat: "fait",
        },
      ],
      1,
      1,
    );
    expect(prompt).toContain("DONNÉE");
    expect(prompt).not.toContain("delegate");
    expect(prompt).not.toContain("outil");
  });
});
