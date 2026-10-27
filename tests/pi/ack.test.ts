/**
 * ACCUSÉ DE RÉCEPTION — règle de DÉCLENCHEMENT, de FORME et de REPLI (module pur).
 *
 * ⚠️ Ce que ce fichier verrouille :
 *  - les TROIS déclencheurs (délégation, génération d'image, commande envoyée à un
 *    agent) et EUX SEULS ;
 *  - la RECONNAISSANCE du texte écrit par le modèle : une phrase courte sur UNE
 *    ligne est un accusé ; un texte long ou multiligne N'EN EST PAS (borne dure) ;
 *  - le REPLI en dur avec des VARIATIONS : rotation déterministe, jamais deux fois
 *    la même phrase de suite, et une phrase qui ne PROMET AUCUN résultat ;
 *  - la consigne de prompt (bornée, française, « intention pas promesse »).
 *
 * La décision est un test de FORME sur un texte déjà produit : aucune entrée
 * « durée », « tokens » ou « longueur estimée » n'existe — c'est ce qui garantit
 * qu'aucune prédiction ne peut s'y glisser (et donc aucun coût au TTFT).
 */

import { describe, expect, it } from "vitest";

import {
  ACK_FALLBACK_TEXTS,
  ACK_MAX_CHARS,
  ACK_RULE,
  ACK_RULE_MAX_CHARS,
  ACK_TOOLS,
  ackFallbackText,
  ackShapedText,
  ackTextForTool,
  firstAckToolCall,
  isAckTool,
} from "../../src/pi/ack.js";

describe("déclencheurs de l'accusé de réception", () => {
  it("reconnaît EXACTEMENT les trois actions longues", () => {
    expect([...ACK_TOOLS].sort()).toEqual(["delegate", "generer_image", "run_command"]);
    for (const tool of ACK_TOOLS) {
      expect(isAckTool(tool)).toBe(true);
      expect(ackTextForTool(tool)).toBeTypeOf("string");
      expect(ackFallbackText(tool, 0)).toBe(ackTextForTool(tool));
    }
  });

  it("n'accuse PAS une question simple ni un outil de lecture", () => {
    for (const tool of [
      "read",
      "grep",
      "recherche_libraire",
      "capture_libraire",
      "envoyer_fichier",
      "lister_agents",
      "job_status",
      "",
    ]) {
      expect(isAckTool(tool)).toBe(false);
      expect(ackTextForTool(tool)).toBeUndefined();
      expect(ackFallbackText(tool, 3)).toBeUndefined();
    }
  });

  it("trouve le PREMIER appel d'outil d'action longue d'un contenu de message", () => {
    expect(firstAckToolCall([{ type: "text", text: "Deux secondes." }, { type: "toolCall", name: "delegate" }])).toBe(
      "delegate",
    );
    expect(firstAckToolCall([{ type: "toolCall", name: "read" }])).toBeUndefined();
    expect(firstAckToolCall([{ type: "text", text: "Salut !" }])).toBeUndefined();
    expect(firstAckToolCall("texte brut")).toBeUndefined();
    expect(firstAckToolCall(undefined)).toBeUndefined();
  });
});

describe("forme de l'accusé (texte écrit par le modèle)", () => {
  it("accepte une phrase courte sur une ligne, en retirant les blancs de bord", () => {
    expect(ackShapedText("  Deux secondes.  ")).toBe("Deux secondes.");
    expect(ackShapedText("Je m'en occupe.")).toBe("Je m'en occupe.");
  });

  it("REFUSE le vide", () => {
    expect(ackShapedText("")).toBeUndefined();
    expect(ackShapedText("   \n\t ")).toBeUndefined();
  });

  it("REFUSE un texte plus long que la borne (PIÈGE ⑥ : un pavé n'est pas un accusé)", () => {
    const long = "Je m'en occupe. " + "a".repeat(ACK_MAX_CHARS);
    expect(long.trim().length).toBeGreaterThan(ACK_MAX_CHARS);
    expect(ackShapedText(long)).toBeUndefined();
    // Juste à la borne : accepté (marge volontaire au-dessus de la consigne).
    expect(ackShapedText("a".repeat(ACK_MAX_CHARS))).toBe("a".repeat(ACK_MAX_CHARS));
  });

  it("REFUSE un texte multiligne (une ligne de statut = une ligne)", () => {
    expect(ackShapedText("Deux secondes.\nJe lance ça.")).toBeUndefined();
    expect(ackShapedText("Deux secondes.\r\nJe lance ça.")).toBeUndefined();
  });

  it("la consigne du prompt est PLUS STRICTE que la borne de reconnaissance", () => {
    expect(ACK_RULE_MAX_CHARS).toBeLessThan(ACK_MAX_CHARS);
    expect(ACK_RULE).toContain(String(ACK_RULE_MAX_CHARS));
  });
});

describe("repli en dur — VARIATIONS", () => {
  it("propose plusieurs formulations par outil (jamais une seule)", () => {
    for (const tool of ACK_TOOLS) {
      const texts = ACK_FALLBACK_TEXTS[tool] ?? [];
      expect(texts.length).toBeGreaterThanOrEqual(3);
      // Toutes distinctes : une rotation n'a de sens que si les phrases diffèrent.
      expect(new Set(texts).size).toBe(texts.length);
    }
  });

  it("ROTATION DÉTERMINISTE : deux replis consécutifs ne disent JAMAIS la même phrase", () => {
    for (const tool of ACK_TOOLS) {
      const count = (ACK_FALLBACK_TEXTS[tool] ?? []).length;
      const seen: string[] = [];
      for (let index = 0; index < count * 3; index += 1) {
        seen.push(ackFallbackText(tool, index) ?? "");
      }
      for (let index = 1; index < seen.length; index += 1) {
        expect(seen[index]).not.toBe(seen[index - 1]);
      }
      // Elle finit par toutes les passer : aucune variante n'est morte.
      expect(new Set(seen).size).toBe(count);
    }
  });

  it("reste stable et sûr pour un index aberrant (déterministe, sans exception)", () => {
    expect(ackFallbackText("delegate", -1)).toBe(ackFallbackText("delegate", 4));
    expect(ackFallbackText("delegate", Number.NaN)).toBe(ackFallbackText("delegate", 0));
    expect(ackFallbackText("delegate", 2.7)).toBe(ackFallbackText("delegate", 2));
  });

  it("chaque variation est courte, en français et ne PROMET aucun résultat", () => {
    for (const tool of ACK_TOOLS) {
      for (const text of ACK_FALLBACK_TEXTS[tool] ?? []) {
        expect(text.length).toBeLessThanOrEqual(ACK_RULE_MAX_CHARS);
        expect(text).not.toContain("\n");
        // ⚠️ Aucune promesse de RÉSULTAT (le badge anti-mensonge existe déjà).
        expect(text).not.toMatch(/résultat|terminé|réussi|fait|prêt|voilà/i);
      }
    }
  });
});

describe("consigne injectée au prompt", () => {
  it("exige une phrase COURTE, VARIÉE, en français, et l'INTERDICTION de promettre", () => {
    expect(ACK_RULE).toContain("Une SEULE phrase");
    expect(ACK_RULE).toContain("VARIE");
    expect(ACK_RULE).toContain("INTENTION");
    expect(ACK_RULE).toContain("français");
    // Les trois outils d'action longue sont cités : la consigne est applicable.
    for (const tool of ACK_TOOLS) {
      expect(ACK_RULE).toContain(tool);
    }
  });
});
