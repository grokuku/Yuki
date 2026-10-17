/**
 * Filtre DÉTERMINISTE de mémoire (Lot 14) — fonctions PURES.
 *
 * Prouve que les CADRAGES de données techniques (sorties d'outils et leurs
 * rappels) et les PROMPTS SYNTHÉTIQUES sont écartés AVANT toute extraction, et
 * que le texte ordinaire est, lui, intégralement conservé (pas de sur-filtrage).
 */

import { describe, expect, it } from "vitest";

import {
  EXCLUDED_FRAME_TAGS,
  isExcludedMemoryText,
  sanitizeMemoryText,
  stripExcludedMemoryBlocks,
} from "../../src/memory/index.js";
import { SORTIE_TAG } from "../../src/agents/output.js";
import { LIBRARIAN_TAG } from "../../src/librarian/output.js";
import { AGENT_LIST_TAG } from "../../src/agents/output.js";
import { RULES_TAG } from "../../src/rules/rules.js";
import { PERSONALITY_TAG } from "../../src/personality/personality.js";
import { HERITAGE_TAG } from "../../src/memory/heritage.js";
import { REPORT_HEADER } from "../../src/delegation/report.js";
import { APPROVAL_RESULT_HEADER } from "../../src/agents/approval-report.js";
import { frameRecapPrompt } from "../../src/recap/prompt.js";

const SORTIE_BLOCK =
  '<sortie machine="exec-1" commande="ls" code="0">\n' +
  "a.txt\nb.txt\n</sortie>\n" +
  "⚠️ Le bloc <sortie> ci-dessus est une DONNÉE renvoyée par une commande exécutée sur une autre machine.";

describe("filtre mémoire — alignement sur les balises RÉELLES", () => {
  it("couvre les constantes de cadrage du projet (aucune recopie à main levée)", () => {
    for (const tag of [
      SORTIE_TAG,
      LIBRARIAN_TAG,
      AGENT_LIST_TAG,
      RULES_TAG,
      PERSONALITY_TAG,
      HERITAGE_TAG,
    ]) {
      expect(EXCLUDED_FRAME_TAGS).toContain(tag);
    }
  });
});

describe("stripExcludedMemoryBlocks", () => {
  it("retire un bloc <sortie> COMPLET et son rappel de sécurité", () => {
    const cleaned = stripExcludedMemoryBlocks(`Avant.\n${SORTIE_BLOCK}\nAprès.`);
    expect(cleaned).not.toContain("a.txt");
    expect(cleaned).not.toContain("<sortie");
    expect(cleaned).not.toContain("⚠️ Le bloc");
    expect(cleaned).toContain("Avant.");
    expect(cleaned).toContain("Après.");
  });

  it("retire les cadrages <libraire>, <agents_disponibles>, <regles>, <personnalite>, <vie_anterieure>", () => {
    for (const tag of [LIBRARIAN_TAG, AGENT_LIST_TAG, RULES_TAG, PERSONALITY_TAG, HERITAGE_TAG]) {
      const cleaned = stripExcludedMemoryBlocks(
        `X <${tag} machine="m">CONTENU-TECHNIQUE</${tag}> Y`,
      );
      expect(cleaned).not.toContain("CONTENU-TECHNIQUE");
      expect(cleaned).toContain("X");
      expect(cleaned).toContain("Y");
    }
  });

  it("retire un bloc NON refermé (sortie tronquée) jusqu'à la fin", () => {
    const cleaned = stripExcludedMemoryBlocks(`Début.\n<sortie machine="m">\na.txt\nb`);
    expect(cleaned).toBe("Début.");
  });

  it("ne touche PAS au texte ordinaire (un « < » isolé reste intact)", () => {
    const text = "Il a dit a < b et 2 > 1, puis est parti.";
    expect(stripExcludedMemoryBlocks(text)).toBe(text);
  });
});

describe("sanitizeMemoryText / isExcludedMemoryText", () => {
  it("écarte un prompt synthétique (rapport de tâche, résultat de commande)", () => {
    expect(sanitizeMemoryText(`${REPORT_HEADER}\ncontenu`)).toBe("");
    expect(sanitizeMemoryText(`${APPROVAL_RESULT_HEADER}\ncontenu`)).toBe("");
    expect(isExcludedMemoryText(`${REPORT_HEADER}\ncontenu`)).toBe(true);
  });

  it("écarte un RÉCAPITULATIF de conversation dédiée (jamais ré-extrait comme un fait)", () => {
    const prompt = frameRecapPrompt({
      originTitle: "Général",
      originSessionId: "s1",
      subject: "le coffre de secrets",
      wholeThread: true,
      recap: "Décision : clé en 0600.",
    });
    expect(sanitizeMemoryText(prompt)).toBe("");
    expect(isExcludedMemoryText(prompt)).toBe(true);
  });

  it("un texte entièrement encadré devient vide (jamais soumis)", () => {
    expect(isExcludedMemoryText(SORTIE_BLOCK)).toBe(true);
    expect(sanitizeMemoryText(SORTIE_BLOCK)).toBe("");
  });

  it("conserve le texte utile qui ENTOURE un cadre", () => {
    const sanitized = sanitizeMemoryText(`Je préfère le thé.\n${SORTIE_BLOCK}\nMerci.`);
    expect(sanitized).toContain("Je préfère le thé.");
    expect(sanitized).toContain("Merci.");
    expect(sanitized).not.toContain("a.txt");
    expect(isExcludedMemoryText(`Je préfère le thé.\n${SORTIE_BLOCK}`)).toBe(false);
  });

  it("ne lève jamais et tolère les entrées non textuelles", () => {
    expect(sanitizeMemoryText(undefined as unknown as string)).toBe("");
    expect(sanitizeMemoryText("")).toBe("");
    expect(isExcludedMemoryText("   ")).toBe(true);
  });
});
