/**
 * Bloc d'IMAGE GÉNÉRÉE — logique PURE + garde-fous STATIQUES de la source.
 *
 * ⚠️ Ce que ce fichier prouve, sans navigateur :
 *  - la source de l'image est un chemin SAME-ORIGIN (`/images/<id>.<ext>`), donc
 *    la CSP reste `img-src 'self'` : AUCUN élargissement (PIÈGE ⑥) ;
 *  - le rendu n'utilise ni `innerHTML` ni attribut de style en ligne ;
 *  - le bloc est ÉPHÉMÈRE (il vit dans le fil, hors historique) : il est retiré
 *    quand le fil est reconstruit.
 *
 * Le comportement DOM/interactif (affichage réel sous la CSP, disparition au
 * snapshot) est vérifié en E2E (Chromium headless + CDP).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generatedImageMeta } from "../../public/ui/image-block.js";
import { isSafeImageSrc } from "../../public/ui/markdown.js";

const SOURCE = readFileSync(join(process.cwd(), "public", "ui", "image-block.js"), "utf8");

describe("badge de métadonnées d'une image générée", () => {
  it("affiche les dimensions RÉELLES et la taille", () => {
    expect(generatedImageMeta({ width: 1024, height: 768, bytes: 512 * 1024 })).toBe(
      "1024×768 · ~512 Ko",
    );
  });

  it("n'invente JAMAIS des dimensions inconnues", () => {
    expect(generatedImageMeta({ bytes: 900 })).toBe("dimensions inconnues · 900 octets");
    expect(generatedImageMeta({ width: 0, height: 0, bytes: 0 })).toBe(
      "dimensions inconnues · 0 octets",
    );
    expect(generatedImageMeta(null)).toBe("dimensions inconnues · taille inconnue");
  });
});

describe("source same-origin (PIÈGE ⑥ : aucune CSP élargie)", () => {
  it("accepte le chemin relatif `/images/…` servi par le gateway", () => {
    expect(isSafeImageSrc("/images/0123456789abcdef0123456789abcdef.png")).toBe(true);
  });

  it("refuse toujours une origine distante (l'image ne vient jamais d'ailleurs)", () => {
    expect(isSafeImageSrc("http://127.0.0.1:8188/view?filename=x.png")).toBe(false);
    expect(isSafeImageSrc("//10.10.0.5:8188/view?filename=x.png")).toBe(false);
  });
});

describe("garde-fous statiques de image-block.js", () => {
  it("construit le DOM sans injection HTML directe ni style en ligne", () => {
    expect(SOURCE).not.toContain("innerHTML");
    expect(SOURCE).not.toContain("style=");
    expect(SOURCE).toContain("createElement");
  });

  it("réutilise le chemin image SÛR du markdown et la classe d'image commune", () => {
    expect(SOURCE).toContain("isSafeImageSrc");
    expect(SOURCE).toContain("md-image");
  });

  it("est ÉPHÉMÈRE : expose `reset()` pour la reconstruction du fil", () => {
    expect(SOURCE).toContain("function reset()");
    expect(SOURCE).toContain(".generated-image");
  });
});
