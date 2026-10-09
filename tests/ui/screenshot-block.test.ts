/**
 * Bloc de capture d'écran — logique PURE + garde-fous STATIQUES de la source
 * (rendu DOM, aucune `innerHTML`, aucun `style=`, réutilisation du chemin image
 * sûr de `markdown.js`).
 *
 * Le comportement DOM/interactif (affichage de l'`<img data:>` sous la CSP
 * réelle, disparition au snapshot) est vérifié en E2E (Chromium headless + CDP).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { formatBytes, screenshotMeta } from "../../public/ui/screenshot-block.js";

describe("capture d'écran — formatage des métadonnées", () => {
  it("taille lisible en français", () => {
    expect(formatBytes(0)).toBe("0 octets");
    expect(formatBytes(512)).toBe("512 octets");
    expect(formatBytes(140 * 1024)).toBe("~140 Ko");
    expect(formatBytes(undefined)).toBe("taille inconnue");
    expect(formatBytes(-5)).toBe("taille inconnue");
  });

  it("badge de métadonnées : dimensions × taille", () => {
    expect(screenshotMeta({ width: 1280, height: 720, bytes: 140 * 1024 })).toBe(
      "1280×720 · ~140 Ko",
    );
    expect(screenshotMeta({ width: 0, height: 0, bytes: 10 })).toBe(
      "dimensions inconnues · 10 octets",
    );
  });
});

describe("garde-fous statiques de screenshot-block.js (CSP)", () => {
  const source = readFileSync(join(process.cwd(), "public", "ui", "screenshot-block.js"), "utf8");

  it("construit le DOM sans injection HTML directe ni style en ligne", () => {
    expect(source).not.toContain("innerHTML");
    expect(source).not.toContain("style=");
    expect(source).toContain("createElement");
  });

  it("réutilise le chemin image SÛR du markdown (aucun élargissement CSP)", () => {
    expect(source).toContain("isSafeImageSrc");
    expect(source).toContain(".md-image");
  });
});
