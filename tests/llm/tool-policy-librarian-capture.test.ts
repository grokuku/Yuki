/**
 * Politique d'outils — `capture_libraire` (page web via Libry).
 *
 * L'outil de capture n'est exposé que si le libraire est configuré ET que le
 * réglage de capture est actif, et JAMAIS au rôle lourd.
 */

import { describe, expect, it } from "vitest";

import { LIBRARIAN_CAPTURE_TOOLS, toolAllowlist } from "../../src/llm/tool-policy.js";
import { LIGHT_MODEL } from "../../src/llm/models.js";

describe("politique d'outils — capture_libraire", () => {
  it("le modèle léger déclare l'ENTRÉE image (sinon le SDK n'attache pas la capture)", () => {
    expect(LIGHT_MODEL.input).toContain("image");
  });

  it("déclare l'outil de capture séparément des quatre outils documentaires", () => {
    expect(LIBRARIAN_CAPTURE_TOOLS).toEqual(["capture_libraire"]);
  });

  it("n'expose la capture que si le libraire ET la capture sont activés", () => {
    expect(toolAllowlist("light", { librarianEnabled: true })).not.toContain("capture_libraire");
    expect(
      toolAllowlist("light", { librarianCaptureEnabled: true }),
    ).not.toContain("capture_libraire");
    expect(
      toolAllowlist("light", { librarianEnabled: true, librarianCaptureEnabled: true }),
    ).toContain("capture_libraire");
  });

  it("le rôle lourd n'a JAMAIS la capture", () => {
    const heavy = toolAllowlist("heavy", {
      librarianEnabled: true,
      librarianCaptureEnabled: true,
    });
    expect(heavy).not.toContain("capture_libraire");
  });
});
