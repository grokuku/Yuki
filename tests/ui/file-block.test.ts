/**
 * Cartes de FICHIERS — logique PURE (marqueurs) et garde-fous STATIQUES de la
 * source (rendu DOM, aucun `innerHTML`, aucun `style=`, chemin image sûr).
 *
 * Le comportement DOM/interactif (bouton, glisser-déposer, téléphone, aperçu
 * `<img>` sous la CSP réelle) est vérifié en E2E (Chromium headless + CDP).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  fileMeta,
  formatFileMarker,
  parseFileMarker,
  parseMessageFiles,
} from "../../public/ui/file-block.js";

const ID = "0123456789abcdef0123456789abcdef";

describe("marqueurs de fichiers d'un message", () => {
  it("relit un marqueur bien formé", () => {
    expect(parseFileMarker(`[fichier] ${ID} rapport final.pdf (1234 octets)`)).toEqual({
      id: ID,
      name: "rapport final.pdf",
      bytes: 1234,
    });
  });

  it("ignore tout ce qui n'est pas un marqueur (aucune fausse carte)", () => {
    expect(parseFileMarker("[fichier] pas-un-id x.txt (1 octets)")).toBeNull();
    expect(parseFileMarker(`[fichier] ${ID} x.txt`)).toBeNull();
    expect(parseFileMarker("un texte normal")).toBeNull();
    expect(parseFileMarker("")).toBeNull();
  });

  it("sépare le texte du message de ses fichiers, dans l'ORDRE", () => {
    const text = [
      "Voici deux pièces",
      "",
      `[fichier] ${ID} a.txt (10 octets)`,
      "",
      `[fichier] ${"f".repeat(32)} b.png (20 octets)`,
    ].join("\n");
    const parsed = parseMessageFiles(text);
    expect(parsed.text).toBe("Voici deux pièces");
    expect(parsed.files.map((file) => file.name)).toEqual(["a.txt", "b.png"]);
  });

  it("ne touche PAS un message sans fichier", () => {
    const text = "Un message qui parle de [fichier] sans en être un.";
    expect(parseMessageFiles(text)).toEqual({ text, files: [] });
  });

  it("le marqueur produit est identique à celui du serveur", () => {
    expect(formatFileMarker({ id: ID, name: "a.txt", bytes: 7 })).toBe(
      `[fichier] ${ID} a.txt (7 octets)`,
    );
  });

  it("badge lisible : genre + taille", () => {
    expect(fileMeta({ kind: "image", bytes: 2048 })).toBe("image · ~2 Ko");
    expect(fileMeta({ kind: "unknown", bytes: 10 })).toBe("format inconnu · 10 octets");
  });
});

describe("garde-fous statiques de file-block.js (CSP)", () => {
  const source = readFileSync(join(process.cwd(), "public", "ui", "file-block.js"), "utf8");

  it("construit le DOM sans injection HTML ni style en ligne", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("style=");
    expect(source).toContain("createElement");
  });

  it("réutilise le chemin image SÛR (aucun élargissement de CSP)", () => {
    expect(source).toContain("isSafeImageSrc");
    expect(source).toContain("md-image");
    // La carte ne télécharge QUE depuis le service same-origin.
    expect(source).toContain("href: url");
  });
});
