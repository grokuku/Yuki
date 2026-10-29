/**
 * FICHIERS COLLÉS (presse-papiers) — logique PURE, sans DOM.
 *
 * Le collage d'une capture d'écran ou d'un fichier copié arrive SANS nom dans
 * `clipboardData` : sans nom PORTEUR D'EXTENSION, le serveur classerait l'image
 * en « format inconnu » (ni aperçu, ni traitement) — c'est la raison d'être de
 * `namePastedFile`.
 *
 * Les interactions réelles (Ctrl+V dans le champ, puce d'attente, carte dans le
 * fil) sont prouvées par l'E2E `_tools/e2e-files.mjs` ; ici on épingle la logique
 * avec des objets injectés (aucun navigateur).
 */

import { describe, expect, it } from "vitest";

import {
  filesFromClipboard,
  namePastedFile,
} from "../../public/ui/clipboard-files.js";

/** Instant FIGÉ : aucun test ne doit dépendre de l'horloge réelle. */
const NOW = new Date(2026, 9, 29, 15, 4, 6);

/** Faux fichier minimal (le module ne lit que `name`, `type`, `size`…). */
function fakeFile(name: string, type: string, size = 12): File {
  return new File([new Uint8Array(size)], name, { type });
}

/** Faux `DataTransfer` : seuls `items` et `files` sont lus. */
function fakeTransfer(items: any[] | undefined, files: File[] = []) {
  return { items, files };
}

describe("nom d'un fichier collé", () => {
  it("fabrique un nom DATÉ et accentué quand l'image n'a pas de nom", () => {
    // Un collage de capture d'écran : `File` au nom vide.
    expect(namePastedFile(fakeFile("", "image/png"), { now: NOW })).toBe(
      "collé-20261029-150406.png",
    );
  });

  it("déduit l'EXTENSION du type MIME (aucune invention)", () => {
    const cases = [
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/gif", "gif"],
      ["image/webp", "webp"],
      ["application/pdf", "pdf"],
      // Type muet ou exotique : repli honnête, jamais un faux « .png ».
      ["application/octet-stream", "bin"],
      ["", "bin"],
    ];
    for (const [type, ext] of cases) {
      expect(namePastedFile(fakeFile("", type), { now: NOW }), type).toBe(
        `collé-20261029-150406.${ext}`,
      );
    }
  });

  it("GARDE le nom d'origine quand il porte déjà une extension", () => {
    const file = fakeFile("photo de vacances.jpg", "image/jpeg");
    expect(namePastedFile(file, { now: NOW })).toBe("photo de vacances.jpg");
  });

  it("renomme un nom SANS extension (sinon le fichier serait « inconnu »)", () => {
    expect(namePastedFile(fakeFile("capture", "image/png"), { now: NOW })).toBe(
      "collé-20261029-150406.png",
    );
    expect(namePastedFile(fakeFile(".cache", "image/png"), { now: NOW })).toBe(
      "collé-20261029-150406.png",
    );
  });

  it("horodate en heure LOCALE sur deux chiffres (nom triable)", () => {
    const tôt = new Date(2026, 0, 2, 3, 4, 5);
    expect(namePastedFile(fakeFile("", "image/png"), { now: tôt })).toBe(
      "collé-20260102-030405.png",
    );
    // Un instant invalide ne produit pas « collé-NaN… ».
    expect(namePastedFile(fakeFile("", "image/png"), { now: Number.NaN })).toBe(
      "collé-00000000-000000.png",
    );
  });
});

describe("fichiers d'un presse-papiers", () => {
  it("garde les items `file` (image ET fichier), ignore le texte", () => {
    const image = fakeFile("", "image/png");
    const pdf = fakeFile("facture.pdf", "application/pdf");
    const found = filesFromClipboard(
      fakeTransfer([
        { kind: "file", getAsFile: () => image },
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => pdf },
      ]),
      { now: NOW },
    );
    expect(found.map((file) => file.name)).toEqual([
      "collé-20261029-150406.png",
      "facture.pdf",
    ]);
  });

  it("FILTRE les `null` (presse-papiers vidé entre-temps)", () => {
    const found = filesFromClipboard(
      fakeTransfer([
        { kind: "file", getAsFile: () => null },
        { kind: "file" },
        { kind: "file", getAsFile: () => fakeFile("a.txt", "text/plain") },
      ]),
      { now: NOW },
    );
    expect(found.map((file) => file.name)).toEqual(["a.txt"]);
  });

  it("rend une liste VIDE pour un collage de texte (aucun envoi)", () => {
    expect(
      filesFromClipboard(
        fakeTransfer([
          { kind: "string", getAsFile: () => null },
          { kind: "string", getAsFile: () => null },
        ]),
        { now: NOW },
      ),
    ).toEqual([]);
    expect(filesFromClipboard(fakeTransfer([]), { now: NOW })).toEqual([]);
    expect(filesFromClipboard(null)).toEqual([]);
    expect(filesFromClipboard(undefined)).toEqual([]);
  });

  it("se rabat sur `files` quand `items` est absent", () => {
    const file = fakeFile("notes.txt", "text/plain");
    expect(
      filesFromClipboard(fakeTransfer(undefined, [file]), { now: NOW }).map(
        (found) => found.name,
      ),
    ).toEqual(["notes.txt"]);
  });

  it("conserve le TYPE du fichier renommé (le serveur classe sur le MIME)", () => {
    const [image] = filesFromClipboard(
      fakeTransfer([{ kind: "file", getAsFile: () => fakeFile("", "image/png") }]),
      { now: NOW },
    );
    expect(image.name).toBe("collé-20261029-150406.png");
    expect(image.type).toBe("image/png");
    expect(image.size).toBe(12);
  });
});
