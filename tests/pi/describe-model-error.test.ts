/**
 * Tests unitaires — traduction d'une cause d'échec de modèle (`describeModelError`).
 *
 * ⚠️ POURQUOI : un échec de génération a rendu l'UI muette (« Une erreur est
 * survenue. ») et les journaux muets (`stage=error` sans cause). On verrouille
 * ici la traduction en français ACTIONNABLE des refus du fournisseur, sans
 * jamais inventer une cause : un motif inconnu retombe sur « le modèle n'a pas
 * répondu » suivi du détail brut tronqué.
 */

import { describe, expect, it } from "vitest";

import { describeModelError } from "../../src/pi/errors.js";

describe("describeModelError — refus du fournisseur", () => {
  it("crédit/quota épuisé (402 / quota / credits)", () => {
    for (const raw of [
      "402: Payment Required",
      '400: {"error":"insufficient credits"}',
      "You exceeded your current quota",
      "credit balance is too low",
    ]) {
      expect(describeModelError(raw)).toContain("crédits ou quota épuisés");
    }
  });

  it("authentification refusée (401 / invalid api key)", () => {
    for (const raw of [
      "401: Unauthorized",
      "invalid api key provided",
      "Authentication failed for provider",
      'No API key found for provider "llm-light"',
    ]) {
      expect(describeModelError(raw)).toContain("authentification refusée");
    }
  });

  it("accès refusé (403) : formulation non trompeuse (droits/quota/clé)", () => {
    for (const raw of ["403: Forbidden", "forbidden"]) {
      const message = describeModelError(raw);
      expect(message).toContain("accès refusé");
      expect(message).toContain("droits");
    }
  });

  it("limite de débit (429 / rate limit)", () => {
    for (const raw of [
      "429: Too Many Requests",
      "rate limit exceeded",
    ]) {
      expect(describeModelError(raw)).toContain("limite de débit atteinte");
    }
  });

  it("indisponibilité du fournisseur (50x / overloaded)", () => {
    for (const raw of [
      "503: Service Unavailable",
      "502: Bad Gateway",
      "the model is overloaded",
    ]) {
      expect(describeModelError(raw)).toContain("indisponible");
    }
  });

  it("cause inconnue : dit ce que l'on sait + détail BRUT (jamais un texte générique)", () => {
    const message = describeModelError(
      "Provider finish_reason: content_filter",
    );
    expect(message).toContain("Le modèle n'a pas répondu");
    expect(message).toContain("content_filter");
    expect(message).not.toBe("Une erreur est survenue.");
  });

  it("aucun détail : message honnête, sans cause inventée", () => {
    expect(describeModelError(undefined)).toContain("aucun détail fourni");
    expect(describeModelError("   ")).toContain("aucun détail fourni");
  });

  it("tronque un détail brut très long (reste affichable)", () => {
    const message = describeModelError("x".repeat(2000));
    expect(message.length).toBeLessThan(520);
    expect(message).toContain("…");
  });
});
