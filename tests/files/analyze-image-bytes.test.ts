/**
 * IMAGE RECONNUE PAR SES OCTETS — cas qui cassait en silence.
 *
 * ⚠️ Un fichier RÉCUPÉRÉ d'une machine arrive avec le nom distant (souvent SANS
 * extension) et un type déclaré `application/octet-stream`
 * (`src/agents/transfer.ts`). Classée par extension seule, une PNG était
 * `unknown` : ni affichée dans le fil, ni transmise au modèle — un silence total.
 *
 * Ces tests ÉCHOUENT sur le code d'origine : `imageMimeFromBytes` n'existe pas,
 * `classifyFile` rend `unknown`, et la fiche stockée garde
 * `application/octet-stream`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyFile,
  imageMimeFromBytes,
  modelImageMimeType,
} from "../../src/files/analyze.js";
import { FilesStore } from "../../src/files/store.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** PNG 1×1 (signature + IHDR) — suffisant pour la détection. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF/9G0AAAAASUVORK5CYII=",
  "base64",
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
const GIF = Buffer.concat([
  Buffer.from("GIF89a", "latin1"),
  Buffer.from([0x01, 0x00, 0x01, 0x00]),
  Buffer.alloc(8),
]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF", "latin1"),
  Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8X", "latin1"),
  Buffer.alloc(18),
]);

describe("signature d'image dans les octets", () => {
  it("reconnaît PNG, JPEG, GIF et WebP (et rien d'autre)", () => {
    expect(imageMimeFromBytes(PNG)).toBe("image/png");
    expect(imageMimeFromBytes(JPEG)).toBe("image/jpeg");
    expect(imageMimeFromBytes(GIF)).toBe("image/gif");
    expect(imageMimeFromBytes(WEBP)).toBe("image/webp");
    // Un texte, un binaire quelconque, un tampon vide : aucune signature.
    expect(imageMimeFromBytes(Buffer.from("bonjour", "utf8"))).toBeUndefined();
    expect(imageMimeFromBytes(Buffer.from([0x00, 0x01, 0x02]))).toBeUndefined();
    expect(imageMimeFromBytes(Buffer.alloc(0))).toBeUndefined();
  });
});

describe("classement d'un fichier sans extension aux octets d'image", () => {
  it("classe `image` (type générique + aucune extension)", () => {
    expect(
      classifyFile({ ext: "bin", mimeType: "application/octet-stream", head: PNG }),
    ).toBe("image");
    expect(
      classifyFile({ ext: "bin", mimeType: "application/octet-stream", head: GIF }),
    ).toBe("image");
  });

  it("ne retourne PAS la classification existante (texte, binaire, PDF)", () => {
    // Un `.txt` reste du texte, même si ses octets commencent par une signature.
    expect(
      classifyFile({ ext: "txt", mimeType: "application/octet-stream", head: PNG }),
    ).toBe("text");
    // Un binaire sans signature reste `unknown`.
    expect(
      classifyFile({ ext: "bin", mimeType: "application/octet-stream", head: Buffer.from([0, 1]) }),
    ).toBe("unknown");
    // Un type DÉCLARÉ non générique n'est jamais écrasé par la signature.
    expect(
      classifyFile({ ext: "zip", mimeType: "application/zip", head: PNG }),
    ).toBe("unknown");
    expect(classifyFile({ ext: "pdf", mimeType: "application/pdf", head: PNG })).toBe("pdf");
  });
});

describe("fiche stockée d'un fichier récupéré sans extension", () => {
  it("corrige le type MIME générique et garde la taille et les octets d'origine", () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-files-sniff-"));
    dirs.push(dir);
    const store = new FilesStore({ dir });
    store.ensureLayout();

    const result = store.saveBytes(PNG, {
      name: "dump",
      // Ce que déclare le transfert depuis une machine (`transfer.ts`).
      mimeType: "application/octet-stream",
      origin: "externe",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Le type suit la SIGNATURE : sans cela, l'image était servie en
    // `application/octet-stream` (donc téléchargée) et jamais montrée au modèle.
    expect(result.record.mimeType).toBe("image/png");
    expect(result.record.analysis.kind).toBe("image");
    // Format de VISION reconnu pour le modèle (politique de `src/files/vision.ts`).
    expect(modelImageMimeType(result.record.ext, result.record.mimeType)).toBe("image/png");
    // L'original n'est pas transformé.
    expect(store.readBytes(result.record.id)?.equals(PNG)).toBe(true);
  });

  it("laisse un fichier TEXTE sans extension au type générique et au genre texte", () => {
    const dir = mkdtempSync(join(tmpdir(), "yuki-files-sniff-text-"));
    dirs.push(dir);
    const store = new FilesStore({ dir });
    store.ensureLayout();

    const result = store.saveBytes(Buffer.from("bonjour, du texte\n", "utf8"), {
      name: "dump",
      mimeType: "application/octet-stream",
      origin: "externe",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.mimeType).toBe("application/octet-stream");
    expect(result.record.analysis.kind).toBe("text");
    expect(result.record.analysis.readable).toBe(true);
  });
});
