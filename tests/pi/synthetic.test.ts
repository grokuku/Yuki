/**
 * Prompts synthétiques du PiHost — source unique de vérité.
 *
 * Verrouille le CONTRAT : le rapport de commande validée et le report de job
 * sont tous deux synthétiques (préfixe + origine), et aucune autre origine ne
 * l'est.
 */

import { describe, expect, it } from "vitest";

import { APPROVAL_RESULT_HEADER, ORIGIN_APPROVAL_RESULT } from "../../src/agents/approval-report.js";
import { ORIGIN_SECRET_STORED, SECRET_STORED_HEADER } from "../../src/agents/secret-report.js";
import { REPORT_HEADER } from "../../src/delegation/report.js";
import { RECAP_HEADER } from "../../src/recap/prompt.js";
import {
  isSyntheticOrigin,
  ORIGIN_JOB_REPORT,
  ORIGIN_RECAP,
  SYNTHETIC_ORIGINS,
  SYNTHETIC_USER_PREFIXES,
} from "../../src/pi/synthetic.js";
import { ORIGIN_SOURCE } from "../../src/sources/frame.js";

describe("prompts synthétiques — source unique", () => {
  it("les deux en-têtes sont des préfixes reconnus", () => {
    expect(SYNTHETIC_USER_PREFIXES).toContain(REPORT_HEADER);
    expect(SYNTHETIC_USER_PREFIXES).toContain(APPROVAL_RESULT_HEADER);
    expect(SYNTHETIC_USER_PREFIXES).toContain(RECAP_HEADER);
    // Confirmation d'enregistrement d'un secret (demande DIRECTE) : synthétique.
    expect(SYNTHETIC_USER_PREFIXES).toContain(SECRET_STORED_HEADER);
  });

  it("les origines synthétiques sont reconnues, les autres non", () => {
    expect(isSyntheticOrigin(ORIGIN_JOB_REPORT)).toBe(true);
    expect(isSyntheticOrigin(ORIGIN_APPROVAL_RESULT)).toBe(true);
    expect(isSyntheticOrigin(ORIGIN_RECAP)).toBe(true);
    expect(isSyntheticOrigin(ORIGIN_SECRET_STORED)).toBe(true);
    // Message d'une SOURCE (programme extérieur branché par l'utilisateur) : il ne
    // produit aucune bulle utilisateur, il vit dans la section « Notifications ».
    expect(isSyntheticOrigin(ORIGIN_SOURCE)).toBe(true);
    expect(isSyntheticOrigin("run_command")).toBe(false);
    expect(isSyntheticOrigin("demander_secret")).toBe(false);
    expect(isSyntheticOrigin(undefined)).toBe(false);
    expect(SYNTHETIC_ORIGINS).toEqual([
      ORIGIN_JOB_REPORT,
      ORIGIN_APPROVAL_RESULT,
      ORIGIN_RECAP,
      ORIGIN_SECRET_STORED,
      ORIGIN_SOURCE,
    ]);
  });
});
