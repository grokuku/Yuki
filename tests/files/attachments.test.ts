/**
 * Liste des PIÈCES JOINTES pour un prompt — métadonnées seules, bornée, explicite.
 *
 * ⚠️ Ce que ce fichier verrouille : l'IDENTIFIANT figure dans la ligne (c'est ce
 * qu'exige `deposer_fichier`), aucun contenu n'est transmis, et un dépassement
 * du plafond est DIT (jamais une troncature muette).
 */

import { describe, expect, it } from "vitest";

import {
  ATTACHMENTS_HEADER,
  ATTACHMENTS_USAGE_NOTE,
  MAX_LISTED_ATTACHMENTS,
  formatAttachmentLine,
  formatAttachmentsForPrompt,
} from "../../src/files/attachments.js";
import type { WireFile } from "../../src/files/types.js";

const ID_A = "0123456789abcdef0123456789abcdef";
const ID_B = "fedcba9876543210fedcba9876543210";

function file(overrides: Partial<WireFile> = {}): WireFile {
  return {
    id: ID_A,
    name: "photo.png",
    mimeType: "image/png",
    bytes: 2048,
    kind: "image",
    readable: false,
    reason: "contenu binaire",
    url: `/fichiers/${ID_A}.png`,
    createdAt: "2026-11-01T14:02:00.000Z",
    expiresAt: "2026-12-01T14:02:00.000Z",
    ...overrides,
  };
}

describe("formatage d'une pièce jointe", () => {
  it("met l'IDENTIFIANT en tête, avec nom, genre, taille et date", () => {
    const line = formatAttachmentLine(file());
    expect(line).toContain(ID_A);
    expect(line).toContain("photo.png");
    expect(line).toContain("image");
    expect(line).toContain("2 Ko");
    expect(line).toContain("2026-11-01");
    expect(line).toContain("non lisible");
  });
});

describe("bloc « pièces jointes » d'un prompt", () => {
  it("aucun fichier ⇒ bloc VIDE (aucun bruit dans le prompt)", () => {
    const block = formatAttachmentsForPrompt([]);
    expect(block.text).toBe("");
    expect(block).toMatchObject({ total: 0, shown: 0, omitted: 0 });
  });

  it("liste les identifiants et ne transmet AUCUN contenu", () => {
    const block = formatAttachmentsForPrompt([
      file(),
      file({ id: ID_B, name: "notes.txt", kind: "text", readable: true, bytes: 12 }),
    ]);
    expect(block.text).toContain(ATTACHMENTS_HEADER);
    expect(block.text).toContain(ID_A);
    expect(block.text).toContain(ID_B);
    expect(block.text).toContain(ATTACHMENTS_USAGE_NOTE);
    expect(block).toMatchObject({ total: 2, shown: 2, omitted: 0 });
  });

  it("au-delà du plafond : liste bornée + COMBIEN de fichiers en plus (jamais muet)", () => {
    const files = Array.from({ length: MAX_LISTED_ATTACHMENTS + 3 }, (_value, index) =>
      file({ id: index.toString(16).padStart(32, "0"), name: `f${index}.png` }),
    );
    const block = formatAttachmentsForPrompt(files);
    expect(block).toMatchObject({
      total: MAX_LISTED_ATTACHMENTS + 3,
      shown: MAX_LISTED_ATTACHMENTS,
      omitted: 3,
    });
    expect(block.text).toContain("3 autre(s) pièce(s) jointe(s) non listée(s)");
    // Le renvoi vers l'outil de listage est explicite.
    expect(block.text).toContain("lister_fichiers");
    // Ni le 31e ni le 33e fichier ne sont listés.
    expect(block.text).not.toContain(`f${MAX_LISTED_ATTACHMENTS}.png`);
  });

  it("un plafond nul le dit au lieu de rendre une liste vide en silence", () => {
    const block = formatAttachmentsForPrompt([file()], { max: 0 });
    expect(block).toMatchObject({ total: 1, shown: 0, omitted: 1 });
    expect(block.text).toContain("1 autre(s) pièce(s) jointe(s) non listée(s)");
  });
});
