/**
 * VIGNETTE CLIQUABLE + VISIONNEUSE PLEIN ÉCRAN — géométrie PURE et garde-fous
 * STATIQUES de la source.
 *
 * ⚠️ Ce que ce fichier prouve, sans navigateur :
 *  - le zoom ne peut JAMAIS sortir de `[contain, plafond]` (aucun agrandissement
 *    absurde, jamais un rétrécissement sous la taille où l'image tient) ;
 *  - le clic bascule `contain` ↔ taille réelle, et reste UTILE sur une image plus
 *    petite que l'écran (sinon le clic semblerait cassé) ;
 *  - le déplacement est BORNÉ : une image plus petite que la zone reste centrée,
 *    une image plus grande ne laisse jamais de vide sur un bord ;
 *  - le zoom « sous le doigt » conserve le point pointé (molette, pincement) ;
 *  - le rendu n'utilise ni `innerHTML` ni attribut `style=` (CSP `style-src
 *    'self'`), seulement le CSSOM `transform` (zoom/déplacement).
 *
 * Le comportement RÉEL (mesures de hauteur de vignette, ouverture/fermeture,
 * `scrollTop` identique avant/après, pincement à deux doigts) est prouvé en E2E :
 * `Yuki and Libs/_tools/e2e-lightbox.mjs` (Chromium headless + CDP).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LIGHTBOX_MAX_SCALE,
  LIGHTBOX_MIN_SCALE,
  LIGHTBOX_SMALL_IMAGE_SCALE,
  clampPan,
  clampScale,
  clickZoomTarget,
  pinchZoom,
  realScale,
  zoomCeiling,
  zoomTranslate,
} from "../../public/ui/lightbox.js";

const read = (...segments: string[]): string =>
  readFileSync(join(process.cwd(), ...segments), "utf8");

const SOURCE = read("public", "ui", "lightbox.js");
/**
 * Source SANS commentaires : les garde-fous « ne contient PAS … » portent sur le
 * CODE exécuté, pas sur la prose (la documentation cite les pièges par leur nom).
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const CSS = read("public", "ui", "styles.css");

describe("realScale — taille réelle, jamais un rétrécissement", () => {
  it("une image de 2500 px affichée sur 500 px vaut 5×", () => {
    expect(realScale(2500, 500)).toBe(5);
  });

  it("une image plus petite que la zone vaut 1× (aucun agrandissement inventé)", () => {
    expect(realScale(64, 64)).toBe(1);
    expect(realScale(100, 400)).toBe(LIGHTBOX_MIN_SCALE);
  });

  it("ne divise JAMAIS par zéro (image pas encore décodée)", () => {
    expect(realScale(0, 0)).toBe(LIGHTBOX_MIN_SCALE);
    expect(realScale(undefined, 500)).toBe(LIGHTBOX_MIN_SCALE);
    expect(realScale(2500, 0)).toBe(LIGHTBOX_MIN_SCALE);
    expect(realScale(Number.NaN, 500)).toBe(LIGHTBOX_MIN_SCALE);
  });
});

describe("zoomCeiling — plafond utile du zoom", () => {
  it("vise la taille réelle pour une grande image", () => {
    expect(zoomCeiling(2500, 500)).toBe(5);
  });

  it("garde un zoom UTILE (2×) même pour une petite image : le clic fait toujours quelque chose", () => {
    expect(zoomCeiling(64, 64)).toBe(LIGHTBOX_SMALL_IMAGE_SCALE);
  });

  it("ne dépasse jamais le plafond absolu", () => {
    expect(zoomCeiling(100_000, 100)).toBe(LIGHTBOX_MAX_SCALE);
  });
});

describe("clampScale — bornes du zoom", () => {
  it("ne descend jamais sous « contain » (1) et pas au-delà du plafond", () => {
    expect(clampScale(0.2, 5)).toBe(LIGHTBOX_MIN_SCALE);
    expect(clampScale(3, 5)).toBe(3);
    expect(clampScale(50, 5)).toBe(5);
  });

  it("une valeur illisible retombe sur « contain » (jamais NaN dans le CSSOM)", () => {
    expect(clampScale(Number.NaN, 5)).toBe(LIGHTBOX_MIN_SCALE);
    expect(clampScale(undefined, 5)).toBe(LIGHTBOX_MIN_SCALE);
  });
});

describe("clickZoomTarget — le clic bascule contain ↔ taille réelle", () => {
  it("depuis « contain » ⇒ taille réelle", () => {
    expect(clickZoomTarget(1, 2500, 500)).toBe(5);
  });

  it("depuis un zoom quelconque ⇒ retour à « contain »", () => {
    expect(clickZoomTarget(3, 2500, 500)).toBe(LIGHTBOX_MIN_SCALE);
    expect(clickZoomTarget(5, 2500, 500)).toBe(LIGHTBOX_MIN_SCALE);
  });

  it("sur une image plus petite que l'écran, le clic zoome quand même (2×)", () => {
    expect(clickZoomTarget(1, 64, 64)).toBe(LIGHTBOX_SMALL_IMAGE_SCALE);
    expect(clickZoomTarget(LIGHTBOX_SMALL_IMAGE_SCALE, 64, 64)).toBe(LIGHTBOX_MIN_SCALE);
  });
});

describe("clampPan — l'image ne sort jamais de la vue", () => {
  it("image plus PETITE que la zone ⇒ centrée (déplacement ramené à 0)", () => {
    expect(clampPan(120, -80, 300, 200, 800, 600)).toEqual({ tx: 0, ty: 0 });
  });

  it("image plus GRANDE ⇒ déplacement borné symétriquement", () => {
    // 1000×800 dans 400×300 : 300 px de débord en X, 250 en Y.
    expect(clampPan(0, 0, 1000, 800, 400, 300)).toEqual({ tx: 0, ty: 0 });
    expect(clampPan(999, 999, 1000, 800, 400, 300)).toEqual({ tx: 300, ty: 250 });
    expect(clampPan(-999, -999, 1000, 800, 400, 300)).toEqual({ tx: -300, ty: -250 });
  });

  it("une valeur illisible ne produit jamais NaN", () => {
    expect(clampPan(Number.NaN, undefined, 1000, 800, 400, 300)).toEqual({ tx: 0, ty: 0 });
  });
});

describe("zoomTranslate — le point visé reste sous le curseur", () => {
  it("zoom au CENTRE (dx=dy=0) ⇒ aucun déplacement", () => {
    expect(zoomTranslate(0, 0, 1, 3, 0, 0)).toEqual({ tx: 0, ty: 0 });
  });

  it("doubler l'échelle sur un point à 100 px du centre décale de −100 px", () => {
    expect(zoomTranslate(0, 0, 1, 2, 100, -50)).toEqual({ tx: -100, ty: 50 });
  });

  it("le point visé reste FIXE : le contenu sous le curseur ne glisse pas", () => {
    // Centre de l'image (échelle 1) en (0,0) ; point visé à 100 px à droite.
    const c = { x: 0, y: 0 };
    const t0 = { tx: 0, ty: 0 };
    const s0 = 1;
    // 1) zoom 2× : le déplacement compense exactement l'éloignement du point.
    const t1 = zoomTranslate(t0.tx, t0.ty, s0, 2, 100 - (c.x + t0.tx), 0);
    expect(t1).toEqual({ tx: -100, ty: 0 });
    // Le point de l'image sous le curseur (repère image, px de base) :
    const u = (100 - (c.x + t0.tx)) / s0;
    // Sa position à l'écran APRÈS le zoom : centre déplacé + u × nouvelle échelle.
    expect(c.x + t1.tx + u * 2).toBe(100);
    // 2) retour à 1× : le même point reste sous le curseur, donc « contain ».
    const t2 = zoomTranslate(t1.tx, t1.ty, 2, 1, 100 - (c.x + t1.tx), 0);
    expect(t2).toEqual({ tx: 0, ty: 0 });
  });
});

describe("pinchZoom — deux doigts = UN SEUL geste : la mise à l'échelle", () => {
  const center = { x: 0, y: 0 };

  it("deux doigts qui GLISSENT sans changer d'écart ne déplacent RIEN (l'image ne fuit plus)", () => {
    // ⚠️ Régression mesurée en E2E : le pincement suivait AUSSI le milieu des
    // doigts, donc un simple glisser à deux doigts faisait bouger l'image.
    const moved = pinchZoom(
      { tx: 12, ty: -8 },
      { x: 300, y: 200 },
      center,
      2,
      2,
    );
    expect(moved).toEqual({ tx: 12, ty: -8 });
  });

  it("en doublant l'échelle, le point ANCRÉ (milieu initial) reste fixe", () => {
    const moved = pinchZoom({ tx: 0, ty: 0 }, { x: 100, y: 0 }, center, 1, 2);
    expect(moved).toEqual({ tx: -100, ty: 0 });
  });

  it("le déplacement ne dépend PAS du milieu courant : seule l'échelle compte", () => {
    // Même ancre, même échelle finale, même point de départ ⇒ même déplacement,
    // quel que soit le chemin des doigts (aucun report du glisser).
    const a = pinchZoom({ tx: 0, ty: 0 }, { x: 40, y: 40 }, center, 1, 1.5);
    const b = pinchZoom({ tx: 0, ty: 0 }, { x: 40, y: 40 }, center, 1, 1.5);
    expect(a).toEqual(b);
    expect(a).toEqual({ tx: -20, ty: -20 });
  });

  it("un pincement qui revient à l'échelle de départ retrouve le déplacement initial", () => {
    const there = pinchZoom({ tx: 0, ty: 0 }, { x: 50, y: 50 }, center, 1, 2.5);
    const back = pinchZoom(there, { x: 50, y: 50 }, center, 2.5, 1);
    expect(Math.round(back.tx)).toBe(0);
    expect(Math.round(back.ty)).toBe(0);
  });
});

describe("garde-fous STATIQUES de lightbox.js (CSP + réutilisation)", () => {
  it("construit le DOM sans injection HTML ni style en ligne (CSP stricte)", () => {
    expect(CODE).not.toContain("innerHTML");
    expect(CODE).not.toContain("insertAdjacentHTML");
    expect(CODE).not.toContain("outerHTML");
    expect(CODE).not.toContain("style=");
    expect(SOURCE).toContain("createElement");
    // Zoom et déplacement par CSSOM, jamais un attribut de style littéral.
    expect(CODE).toContain("imgEl.style.transform");
  });

  it("réutilise la brique d'icônes existante (aucune dépendance nouvelle, aucun SVG en dur)", () => {
    expect(SOURCE).toContain('from "./vendor/holaf/holaf-icons.js"');
    expect(SOURCE).toContain("HolafIcons.render");
  });

  it("le calque est une SURCOUCHE ajoutée au document, pas un nœud du fil (PIÈGE ①)", () => {
    expect(CODE).toContain("doc.body.append(overlay)");
    // Le fil n'est JAMAIS modifié : il sert seulement à dresser la liste.
    expect(CODE).not.toMatch(/root\.(append|appendChild|insertBefore|prepend)/);
    expect(CODE).not.toContain("scrollTop");
    expect(CODE).not.toContain("scrollIntoView");
  });

  it("le focus rendu ne fait pas défiler le fil (`preventScroll`)", () => {
    expect(SOURCE).toContain("preventScroll: true");
  });

  it("fermeture : Échap, clic à côté ET un bouton visible (il n'y a pas d'Échap sur téléphone)", () => {
    expect(SOURCE).toContain('event.key === "Escape"');
    expect(SOURCE).toContain("event.target === overlay || event.target === stage");
    expect(SOURCE).toContain("LIGHTBOX_CLOSE_LABEL");
  });

  it("navigation entre images : flèches du clavier ET boutons (zone du pouce)", () => {
    expect(SOURCE).toContain('event.key === "ArrowLeft"');
    expect(SOURCE).toContain('event.key === "ArrowRight"');
    expect(SOURCE).toContain("LIGHTBOX_PREV_LABEL");
    expect(SOURCE).toContain("LIGHTBOX_NEXT_LABEL");
  });

  it("le pincement à deux doigts est géré par les Pointer Events", () => {
    expect(SOURCE).toContain('"pointerdown"');
    expect(SOURCE).toContain("pinchZoom(");
    expect(CODE).toContain("ids.length === 2");
  });

  it("le glisser est SUSPENDU dès qu'un second pointeur est actif (jamais deux gestes concurrents)", () => {
    // ⚠️ Garde mesurée en E2E : à `pointermove`, un déplacement à UN doigt ne doit
    // pas s'appliquer quand deux pointeurs sont actifs.
    expect(CODE).toContain("pointers.size === 1");
  });

  it("la navigation entre images repose l'échelle à « contain » (jamais un zoom hérité)", () => {
    // `show()` (boutons ‹ › ET flèches du clavier) appelle `resetView()` AVANT
    // de changer de source : on ne passe jamais d'une image zoomée à une autre
    // image zoomée au même endroit.
    const showBody = CODE.slice(CODE.indexOf("function show(next)"), CODE.indexOf("function build()"));
    expect(showBody).toContain("resetView()");
    expect(showBody.indexOf("resetView()")).toBeLessThan(showBody.indexOf("imgEl.src"));
  });

  it("la fermeture retire TOUS les écouteurs et le nœud (PIÈGE ④ : aucun orphelin)", () => {
    expect(SOURCE).toContain("doc.removeEventListener(\"keydown\", onKeyDown, true)");
    expect(SOURCE).toContain("overlay.remove()");
    expect(SOURCE).toContain("pointers.clear()");
  });
});

describe("garde-fous STATIQUES de styles.css (vignette bornée, jamais déformée)", () => {
  it("la vignette est bornée en HAUTEUR sur bureau (320 px) et jamais déformée", () => {
    const block = CSS.slice(CSS.indexOf(".md-image-zoom > img"));
    const rule = block.slice(0, block.indexOf("}"));
    expect(rule).toContain("max-height: 320px");
    expect(rule).toContain("max-width: 100%");
    expect(rule).toContain("object-fit: contain");
    // ⚠️ Jamais une hauteur/largeur IMPOSÉE : c'est `max-*` + `contain`, sinon
    // l'image serait écrasée (PIÈGE ②/⑦).
    expect(rule).not.toMatch(/(^|[^-])height:\s*\d+px/);
    expect(rule).not.toMatch(/(^|[^-])width:\s*\d+px/);
    expect(rule).not.toContain("fill");
  });

  it("sur TÉLÉPHONE la vignette est plus petite encore (220 px)", () => {
    const media = CSS.slice(CSS.indexOf("@media (max-width: 767px), (max-height: 480px) and (pointer: coarse) {\n  .md-image-zoom > img"));
    expect(media.startsWith("@media")).toBe(true);
    expect(media.slice(0, media.indexOf("}")).concat("}")).toContain("max-height: 220px");
  });

  it("l'image agrandie est CONTENUE et centrée (jamais `fill`)", () => {
    const block = CSS.slice(CSS.indexOf(".lightbox__img {"));
    const rule = block.slice(0, block.indexOf("}"));
    expect(rule).toContain("object-fit: contain");
    expect(rule).toContain("max-width: 100%");
    expect(rule).toContain("max-height: 100%");
    expect(rule).not.toContain("fill");
    // Zoom UNIFORME (même facteur en X et Y) : le rapport de l'image est préservé.
    expect(SOURCE).toContain("scale(${zoom.scale})");
  });

  it("le calque est FIXE et au-dessus de toutes les autres surcouches (PIÈGE ①)", () => {
    const block = CSS.slice(CSS.indexOf(".lightbox {"));
    const rule = block.slice(0, block.indexOf("}"));
    expect(rule).toContain("position: fixed");
    expect(rule).toContain("inset: 0");
    // 1400 > fenêtre de validation (1200/1201), menu contextuel (1000), menus
    // téléphone (940), bouton « revenir en bas » (900).
    expect(rule).toContain("z-index: 1400");
  });

  it("aucun geste ne fuit vers le fil (défilement, zoom du navigateur)", () => {
    const block = CSS.slice(CSS.indexOf(".lightbox {"));
    const rule = block.slice(0, block.indexOf("}"));
    expect(rule).toContain("touch-action: none");
    expect(rule).toContain("overscroll-behavior: contain");
  });

  it("sur écran TACTILE l'indice de clic est TOUJOURS visible (il n'y a pas de survol)", () => {
    const block = CSS.slice(CSS.indexOf("@media (hover: none) {\n  .md-image-zoom__hint"));
    expect(block.startsWith("@media (hover: none)")).toBe(true);
    expect(block.slice(0, block.indexOf("}")).concat("}")).toMatch(/opacity:\s*0?\.9/);
  });

  it("le bouton de vignette porte le curseur `zoom-in` (indice de clic sur bureau)", () => {
    const block = CSS.slice(CSS.indexOf(".md-image-zoom {"));
    const rule = block.slice(0, block.indexOf("}"));
    expect(rule).toContain("cursor: zoom-in");
  });
});
