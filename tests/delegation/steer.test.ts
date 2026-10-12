/**
 * STEER — cadrage et composition du PREMIER message d'un sous-agent.
 *
 * ⚠️ POURQUOI CE TEST EXISTE : le piège n°1 est la consigne PERDUE EN SILENCE. On
 * prouve ici que les consignes tamponnées (arrivées avant le démarrage) sont
 * EFFECTIVEMENT intégrées au premier message, sous un cadrage explicite qui dit
 * au sous-agent qu'elles viennent de l'ORCHESTRATEUR (jamais de l'utilisateur).
 */

import { describe, expect, it } from "vitest";

import {
  MAX_PENDING_STEERS,
  ORCHESTRATOR_STEER_HEADER,
  composeFirstPrompt,
  orchestratorSteerBlock,
} from "../../src/delegation/steer.js";

describe("steer — composition du premier message", () => {
  it("sans consigne : la tâche est renvoyée INCHANGÉE", () => {
    expect(composeFirstPrompt("Fais ceci", [])).toBe("Fais ceci");
    expect(orchestratorSteerBlock([])).toBe("");
  });

  it("avec consigne : cadrage ORCHESTRATEUR explicite + tâche initiale", () => {
    const prompt = composeFirstPrompt("Analyse le dépôt", [
      "concentre-toi sur le module de paiement",
      "ignore les tests",
    ]);
    // Le cadrage dit clairement que ça vient de l'orchestrateur, pas de l'utilisateur.
    expect(prompt).toContain(ORCHESTRATOR_STEER_HEADER);
    expect(prompt).toContain("PAS des messages de l'utilisateur");
    // Chaque consigne est présente, une par puce.
    expect(prompt).toContain("- concentre-toi sur le module de paiement");
    expect(prompt).toContain("- ignore les tests");
    // La tâche initiale reste présente.
    expect(prompt).toContain("Analyse le dépôt");
    // Les consignes précèdent la tâche (elles la cadrent).
    expect(prompt.indexOf(ORCHESTRATOR_STEER_HEADER)).toBeLessThan(
      prompt.indexOf("Analyse le dépôt"),
    );
  });

  it("la borne du tampon est celle annoncée", () => {
    expect(MAX_PENDING_STEERS).toBe(10);
  });
});
