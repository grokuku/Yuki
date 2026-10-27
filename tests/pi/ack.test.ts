/**
 * ACCUSÉ DE RÉCEPTION — règle de déclenchement (module pur).
 *
 * ⚠️ Ce que ce fichier verrouille :
 *  - les TROIS déclencheurs (délégation, génération d'image, commande envoyée à un
 *    agent) et EUX SEULS ;
 *  - AUCUN accusé quand le run a déjà dit quelque chose (pas de doublon), ni quand
 *    un accusé est déjà parti (deux outils longs dans le même tour) ;
 *  - le libellé est COURT, en FRANÇAIS, et ne PROMET AUCUN résultat.
 *
 * La décision est un test booléen : aucune entrée « durée », « tokens » ou
 * « longueur » n'existe dans la signature — c'est ce qui garantit qu'aucune
 * prédiction ne peut s'y glisser (et donc aucun coût au TTFT).
 */

import { describe, expect, it } from "vitest";

import {
  ACK_TOOLS,
  ackTextForTool,
  shouldAcknowledge,
} from "../../src/pi/ack.js";

describe("déclencheurs de l'accusé de réception", () => {
  it("reconnaît EXACTEMENT les trois actions longues", () => {
    expect([...ACK_TOOLS].sort()).toEqual(["delegate", "generer_image", "run_command"]);
    for (const tool of ACK_TOOLS) {
      expect(ackTextForTool(tool)).toBeTypeOf("string");
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
      expect(ackTextForTool(tool)).toBeUndefined();
      expect(shouldAcknowledge({ tool, alreadySaid: false, alreadyAcked: false })).toBe(false);
    }
  });

  it("accuse quand une action démarre et que rien n'a été dit", () => {
    expect(shouldAcknowledge({ tool: "delegate", alreadySaid: false, alreadyAcked: false })).toBe(
      true,
    );
    expect(
      shouldAcknowledge({ tool: "generer_image", alreadySaid: false, alreadyAcked: false }),
    ).toBe(true);
    expect(
      shouldAcknowledge({ tool: "run_command", alreadySaid: false, alreadyAcked: false }),
    ).toBe(true);
  });

  it("PAS de doublon : ni si elle a déjà parlé, ni si un accusé est déjà parti", () => {
    expect(shouldAcknowledge({ tool: "delegate", alreadySaid: true, alreadyAcked: false })).toBe(
      false,
    );
    expect(shouldAcknowledge({ tool: "delegate", alreadySaid: false, alreadyAcked: true })).toBe(
      false,
    );
  });

  it("le libellé est court, humain, en français et ne PROMET aucun résultat", () => {
    for (const tool of ACK_TOOLS) {
      const text = ackTextForTool(tool) ?? "";
      // Court : une ligne, quelques mots.
      expect(text.length).toBeLessThanOrEqual(24);
      expect(text).not.toContain("\n");
      // Humain (pas une phrase de robot, pas de jargon technique).
      expect(text).toMatch(/^(Je m'en occupe\.|C'est parti\.)$/);
      // ⚠️ Aucune promesse de RÉSULTAT (le badge anti-mensonge existe déjà).
      expect(text).not.toMatch(/résultat|terminé|réussi|fait|prêt|voilà/i);
    }
  });
});
