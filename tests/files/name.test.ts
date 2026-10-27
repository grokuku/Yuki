/**
 * PIÈGE ⑤ — SÉCURITÉ DES NOMS DE FICHIERS.
 *
 * Un nom fourni par un client n'est jamais un chemin : il est réduit à son
 * dernier segment, purgé des caractères de contrôle et des inversions
 * bidirectionnelles, borné en longueur, et son extension est ramenée à une
 * allowlist de forme. Aucun test ne dépend du système de fichiers : tout est pur.
 */

import { describe, expect, it } from "vitest";

import {
  contentDispositionName,
  extensionOf,
  FALLBACK_EXT,
  FALLBACK_FILE_NAME,
  sanitizeFileName,
} from "../../src/files/name.js";

describe("assainissement d'un nom de fichier", () => {
  it("neutralise une traversée de chemin (`../`, absolu, Windows)", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("/etc/shadow")).toBe("shadow");
    expect(sanitizeFileName("..\\..\\windows\\system32\\cmd.exe")).toBe("cmd.exe");
    expect(sanitizeFileName("a/b/c/rapport.pdf")).toBe("rapport.pdf");
    // Un nom qui n'est QUE des séparateurs n'a aucun segment exploitable.
    expect(sanitizeFileName("../")).toBe(FALLBACK_FILE_NAME);
    expect(sanitizeFileName("..")).toBe(FALLBACK_FILE_NAME);
    expect(sanitizeFileName(".")).toBe(FALLBACK_FILE_NAME);
    expect(sanitizeFileName("")).toBe(FALLBACK_FILE_NAME);
  });

  it("retire les caractères de contrôle et les inversions bidirectionnelles", () => {
    // `\u202e` (RIGHT-TO-LEFT OVERRIDE) réécrit visuellement l'extension.
    expect(sanitizeFileName("facture\u202efdp.exe")).toBe("facturefdp.exe");
    expect(sanitizeFileName("nom\u0000\u0007.txt")).toBe("nom.txt");
    expect(sanitizeFileName("  espaces   multiples .txt  ")).toBe("espaces multiples .txt");
    // Points et espaces de tête/queue : Windows les retire silencieusement.
    expect(sanitizeFileName("...cache.txt...")).toBe("cache.txt");
  });

  it("borne la longueur en préservant l'extension", () => {
    const long = `${"a".repeat(400)}.pdf`;
    const safe = sanitizeFileName(long);
    expect(safe.length).toBeLessThanOrEqual(120);
    expect(safe.endsWith(".pdf")).toBe(true);
  });

  it("normalise l'extension (allowlist de forme, jamais un chemin)", () => {
    expect(extensionOf("rapport.PDF")).toBe("pdf");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
    expect(extensionOf("sans-extension")).toBe(FALLBACK_EXT);
    expect(extensionOf("point.")).toBe(FALLBACK_EXT);
    expect(extensionOf("…/x.weird-ext!")).toBe(FALLBACK_EXT);
    expect(extensionOf(".bashrc")).toBe(FALLBACK_EXT);
  });

  it("produit un Content-Disposition sûr (repli ASCII + encodage)", () => {
    const { ascii, encoded } = contentDispositionName("fac\"ture\u202e.pdf");
    // Le guillemet est un caractère LÉGITIME d'un nom ; il ne peut pas casser
    // l'en-tête : le repli ASCII le remplace, la forme `filename*` l'encode.
    expect(ascii).not.toContain('"');
    expect(ascii).not.toContain("\\");
    expect(encoded).not.toContain('"');
    expect(encoded).toBe(encodeURIComponent("fac\"ture.pdf"));
    // L'inversion bidirectionnelle, elle, a bel et bien disparu.
    expect(encoded).not.toContain("%E2%80%AE");
  });
});
