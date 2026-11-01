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
  DELEGATION_CONTEXT_HEADER,
  DelegationContextTooLongError,
  MAX_DELEGATION_CONTEXT_CHARS,
  MAX_PENDING_STEERS,
  ORCHESTRATOR_STEER_HEADER,
  assertDelegationContext,
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

describe("delegate(context) — le contexte est RÉELLEMENT transmis", () => {
  it("le contexte est présent, APRÈS la consigne et sous un cadrage explicite", () => {
    const prompt = composeFirstPrompt("Dépose l'image sur nuc00", [], {
      context: "L'image a été jointe par l'utilisateur à 14:02.",
    });
    expect(prompt).toContain("Dépose l'image sur nuc00");
    expect(prompt).toContain(DELEGATION_CONTEXT_HEADER);
    expect(prompt).toContain("ce n'est PAS la consigne");
    expect(prompt).toContain("L'image a été jointe par l'utilisateur à 14:02.");
    // « la consigne est ci-dessus » doit être VRAI : la tâche précède le contexte.
    expect(prompt.indexOf("Dépose l'image sur nuc00")).toBeLessThan(
      prompt.indexOf(DELEGATION_CONTEXT_HEADER),
    );
  });

  it("le contexte ne remplace JAMAIS la tâche (les deux sont présents, steers compris)", () => {
    const prompt = composeFirstPrompt("Analyse le dépôt", ["reste en lecture seule"], {
      context: "Le dépôt est à /workspace.",
    });
    expect(prompt).toContain(ORCHESTRATOR_STEER_HEADER);
    expect(prompt).toContain("reste en lecture seule");
    expect(prompt).toContain("Analyse le dépôt");
    expect(prompt).toContain("Le dépôt est à /workspace.");
  });

  it("un contexte vide ou absent ne produit AUCUN bloc (prompt inchangé)", () => {
    expect(composeFirstPrompt("Fais ceci", [], { context: "   " })).toBe("Fais ceci");
    expect(composeFirstPrompt("Fais ceci", [], {})).toBe("Fais ceci");
  });

  it("plafond dépassé : REFUS EXPLICITE (jamais de troncature muette)", () => {
    expect(MAX_DELEGATION_CONTEXT_CHARS).toBe(8000);
    const tooLong = "x".repeat(MAX_DELEGATION_CONTEXT_CHARS + 1);
    expect(() => assertDelegationContext(tooLong)).toThrow(DelegationContextTooLongError);
    expect(() => composeFirstPrompt("Fais ceci", [], { context: tooLong })).toThrow(
      DelegationContextTooLongError,
    );
    // Le message dit COMBIEN et QUEL plafond : il est actionnable.
    try {
      composeFirstPrompt("Fais ceci", [], { context: tooLong });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("8001");
      expect(message).toContain("8000");
    }
    // Juste à la borne : accepté tel quel (aucune coupe).
    const atLimit = "y".repeat(MAX_DELEGATION_CONTEXT_CHARS);
    expect(() => assertDelegationContext(atLimit)).not.toThrow();
    const prompt = composeFirstPrompt("Fais ceci", [], { context: atLimit });
    expect(prompt).toContain(atLimit);
  });

  it("les pièces jointes sont placées entre la consigne et le contexte", () => {
    const prompt = composeFirstPrompt("Dépose le fichier", [], {
      attachments: "PIÈCES JOINTES — identifiant abc",
      context: "note du coordinateur",
    });
    expect(prompt.indexOf("Dépose le fichier")).toBeLessThan(
      prompt.indexOf("PIÈCES JOINTES"),
    );
    expect(prompt.indexOf("PIÈCES JOINTES")).toBeLessThan(
      prompt.indexOf(DELEGATION_CONTEXT_HEADER),
    );
  });
});
