/**
 * Bloc d'IMAGE GÉNÉRÉE — logique PURE + garde-fous STATIQUES de la source.
 *
 * ⚠️ Ce que ce fichier prouve, sans navigateur :
 *  - la source de l'image est un chemin SAME-ORIGIN (`/images/<id>.<ext>`), donc
 *    la CSP reste `img-src 'self'` : AUCUN élargissement (PIÈGE ⑥) ;
 *  - le rendu n'utilise ni `innerHTML` ni attribut de style en ligne ;
 *  - le bloc est CONSERVÉ (même rétention que les pièces jointes) : il revient
 *    après rechargement via la trame `image` restaurée, et il est retiré quand le
 *    fil est reconstruit AVANT que le serveur ne le ré-émette ;
 *  - la FICHE (prompt final) est TOUJOURS sous l'image, y compris quand elle
 *    arrive APRÈS (insertion `after(img)`, l'image n'est jamais déplacée).
 *
 * Le comportement DOM/interactif (affichage réel sous la CSP, disparition au
 * snapshot) est vérifié en E2E (Chromium headless + CDP).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FINAL_PROMPT_COPY_LABEL, generatedImageMeta } from "../../public/ui/image-block.js";
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

  it("expose `reset()` pour la reconstruction du fil, SANS perdre l'image du serveur", () => {
    expect(SOURCE).toContain("function reset()");
    expect(SOURCE).toContain(".generated-image");
    // ⚠️ L'image est CONSERVÉE côté serveur : le bloc ne prétend plus être
    // éphémère, il dit la vérité sur sa durée de conservation.
    expect(SOURCE).toContain("GENERATED_IMAGE_KEPT_NOTE");
    expect(SOURCE).not.toMatch(/pas conservée dans l'historique/);
  });

  it("la FICHE arrive APRÈS l'image : elle est insérée SOUS l'image, qui ne bouge pas", () => {
    // ⚠️ PIÈGE ⑤ : jamais `prepend`, jamais `before(image)`, jamais reconstruire
    // l'image pour ajouter la fiche.
    expect(SOURCE).toContain("function setFinalPrompt(");
    expect(SOURCE).toContain("image.after(fiche)");
    expect(SOURCE).toContain("previous.replaceWith(fiche)");
    expect(SOURCE).not.toMatch(/image\.before\(/);
    expect(SOURCE).not.toMatch(/prepend\(/);
    // L'ordre du DOM (image → fiche → note) est celui de `build()`.
    const build = SOURCE.slice(SOURCE.indexOf("function build(image)"));
    expect(build.indexOf("buildImage(image)")).toBeLessThan(
      build.indexOf("buildFinalPrompt(image?.finalPrompt)"),
    );
    expect(build.indexOf("buildFinalPrompt(image?.finalPrompt)")).toBeLessThan(
      build.indexOf("generated-image__note"),
    );
  });

  it("retrouve l'image à compléter par son identifiant (jamais par sa position)", () => {
    expect(SOURCE).toContain("data-image-id");
    expect(SOURCE).toContain("new Map()");
  });

  it("affiche le PROMPT FINAL replié, en LECTURE, avec le bouton copier du markdown", () => {
    // ⚠️ Un seul mécanisme de copie : celui des blocs de code (« RÉUTILISE
    // l'esprit, n'en fais pas un 2ᵉ système »).
    expect(SOURCE).toContain("createCopyButton");
    expect(SOURCE).toContain("details");
    expect(SOURCE).toContain("summary");
    expect(SOURCE).toContain("generated-image__prompt");
    // Le libellé du bouton dit EXACTEMENT ce qu'il copie.
    expect(FINAL_PROMPT_COPY_LABEL).toContain("prompt final");
  });

  it("insère le prompt final comme NŒUD TEXTE (aucune injection possible)", () => {
    // ⚠️ Le prompt final est du texte GÉNÉRÉ : il passe par `textContent`, jamais
    // par une insertion de balisage (PIÈGE ⑥).
    expect(SOURCE).toContain("el.textContent = value");
    expect(SOURCE).not.toContain("innerHTML");
    expect(SOURCE).not.toContain("insertAdjacentHTML");
    expect(SOURCE).not.toContain("outerHTML");
  });

  it("l'image est une VIGNETTE CLIQUABLE (bornée par le CSS, ouverte au clic)", () => {
    // ⚠️ Sans cette décoration, une image de ~2500×2500 écrase le fil : c'est le
    // défaut que la vignette corrige. Le bouton vient de `lightbox.js` (une seule
    // visionneuse pour les images générées ET les captures).
    expect(SOURCE).toContain('from "./lightbox.js"');
    expect(SOURCE).toContain("zoom.decorate(img)");
    expect(SOURCE).toContain("ZOOM_WRAPPER_CLASS");
  });

  it("la FICHE atterrit SOUS la vignette (le bouton enveloppe l'image, la fiche reste après lui)", () => {
    // La fiche est insérée APRÈS l'élément qui PORTE l'image — le bouton de
    // vignette quand la visionneuse est branchée, l'`<img>` sinon.
    expect(SOURCE).toContain(":scope > .${ZOOM_WRAPPER_CLASS}, :scope > .generated-image__image");
    expect(SOURCE).toContain("image.after(fiche)");
  });
});
