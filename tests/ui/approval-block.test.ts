/**
 * Bloc de validation humaine (D118) — logique PURE + garde-fous STATIQUES de la
 * source (rendu DOM, aucune `innerHTML`, aucun `style=`, CSP).
 *
 * Le comportement DOM/interactif (apparition, compte à rebours, décision,
 * disparition) est vérifié en E2E (Chromium headless + CDP), pas ici.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatRemaining,
  isExpired,
  machineLabel,
  remainingMs,
} from "../../public/ui/approval-block.js";

describe("expiration — jamais de clic dans le vide", () => {
  it("détecte l'échéance (date illisible ⇒ expirée)", () => {
    const now = 1_000_000;
    expect(isExpired(new Date(now + 1000).toISOString(), now)).toBe(false);
    expect(isExpired(new Date(now - 1).toISOString(), now)).toBe(true);
    expect(isExpired("pas une date", now)).toBe(true);
    expect(isExpired(undefined, now)).toBe(true);
  });

  it("borne le temps restant à ≥ 0", () => {
    const now = 1_000_000;
    expect(remainingMs(new Date(now + 5000).toISOString(), now)).toBe(5000);
    expect(remainingMs(new Date(now - 5000).toISOString(), now)).toBe(0);
    expect(remainingMs("pas une date", now)).toBe(0);
  });

  it("formate le compte à rebours en français", () => {
    expect(formatRemaining(42_000)).toBe("42 s");
    expect(formatRemaining(0)).toBe("0 s");
    expect(formatRemaining(4 * 60_000 + 32_000)).toBe("4 min 32 s");
    expect(formatRemaining(60_000)).toBe("1 min 00 s");
  });
});

describe("identité machine — nom + identifiant", () => {
  it("privilégie le nom lisible, replie sur l'identifiant", () => {
    expect(machineLabel({ agentId: "a1", agentName: "nuc00" })).toBe("nuc00");
    expect(machineLabel({ agentId: "a1", agentName: "  " })).toBe("a1");
    expect(machineLabel({ agentId: "a1" })).toBe("a1");
  });
});

describe("garde-fous statiques de approval-block.js (CSP)", () => {
  const source = readFileSync(join(process.cwd(), "public", "ui", "approval-block.js"), "utf8");

  it("construit le DOM sans injection HTML directe ni style en ligne", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("style=");
    expect(source).toContain("createElement");
  });

  it("propose Valider et Refuser et mentionne l'expiration", () => {
    expect(source).toContain("Valider");
    expect(source).toContain("Refuser");
    expect(source).toContain("expiresAt");
    expect(source).toContain("passé ce délai");
  });

  it("rappelle que le bloc/résultat n'entre pas dans l'historique", () => {
    expect(source).toContain("pas conservé dans l'historique");
  });
});
