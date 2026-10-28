// Yuki — VIGNETTE CLIQUABLE d'image + VISIONNEUSE PLEIN ÉCRAN (lightbox).
//
// ⚠️ PROBLÈME RÉSOLU : une image générée fait ~6 Mpx (~2500×2500). Affichée en
// pleine largeur, elle écrase le fil : on ne voit plus ni la conversation ni la
// fiche (prompt final). Il faut donc une VIGNETTE BORNÉE, et un moyen de voir le
// détail : un clic ouvre la visionneuse.
//
// ⚠️ SURCOUCHE, JAMAIS UN AGRANDISSEMENT DANS LE FIL : la visionneuse est un
// calque `position: fixed` ajouté à `document.body`. Elle ne touche NI au fil
// (`#conversation`), NI à `scrollTop`, NI à `scrollHeight`, NI à la mise en page.
// C'est la seule façon de ne pas casser l'état STICKY (`conversationPinned`), le
// bouton « revenir en bas » et le défilement automatique (PIÈGE ①). Preuve par
// MESURE dans `_tools/e2e-lightbox.mjs` : `scrollTop` IDENTIQUE avant/après.
//
// ⚠️ CSP stricte (`default-src 'none'; style-src 'self'`) : aucun `innerHTML`,
// aucun attribut `style=` dans le balisage. Le DOM est construit par
// `createElement`, les icônes viennent de la brique `holaf-icons` via
// `DOMParser` + `importNode` (patron de `scroll-button.js`), et le zoom / le
// déplacement passent par le CSSOM (`img.style.transform`) — exactement la
// technique de la fenêtre de validation (`approval-window.js`) et du menu
// contextuel. `style-src 'self'` ne bloque PAS les mutations CSSOM.
//
// ⚠️ JAMAIS DE DÉFORMATION (PIÈGE ②/⑦) : la vignette ET l'image agrandie sont en
// `object-fit: contain` avec `max-width`/`max-height` — jamais `width: 100%` ni
// `height: 100%` sur une image, jamais `fill`. Le zoom est un `scale()` UNIFORME
// (même facteur en X et Y) : le rapport largeur/hauteur reste celui de l'image.
//
// ⚠️ TÉLÉPHONE (PIÈGE ③) : pas de survol ⇒ l'indice de clic est TOUJOURS visible
// (voir `styles.css`, `@media (hover: none)`) ; pas d'Échap ⇒ un bouton de
// fermeture visible et atteignable au pouce en haut à droite ; la navigation
// entre images vit dans une barre EN BAS (zone du pouce) ; le pincement à deux
// doigts est géré (Pointer Events + `touch-action: none`).
//
// ⚠️ DEUX DOIGTS = UN SEUL GESTE (zoom) : le pincement ne déplace jamais l'image
// (voir `pinchZoom`). Le glisser d'un doigt, le tap et la navigation gardent leur
// comportement, inchangé.
//
// INSPIRATION : la galerie de `ComfyUI-AI-Helper` (brique `HolafViewport` :
// molette → zoom vers le curseur, glisser → déplacement, `fit` = échelle 1,
// déplacement borné pour que l'image ne quitte jamais la vue). Cette
// visionneuse reprend ces règles géométriques (voir les fonctions PURES
// ci-dessous, testées sans navigateur) mais PAS la brique : Yuki n'embarque pas
// `holaf-viewport` (zéro dépendance nouvelle) et la brique ne gère pas le
// pincement à deux doigts.

import { HolafIcons } from "./vendor/holaf/holaf-icons.js";

/** Classe du BOUTON qui enveloppe une image cliquable (vignette). */
export const ZOOM_WRAPPER_CLASS = "md-image-zoom";
/** Classe de l'IMAGE cliquable elle-même (sert à dresser la liste des images). */
export const ZOOM_IMAGE_CLASS = "md-image--zoom";
/** Libellé accessible du bouton de vignette (français, jamais un silence). */
export const ZOOM_HINT_LABEL = "Agrandir l'image";
/** Libellé accessible du calque plein écran. */
export const LIGHTBOX_LABEL = "Image agrandie";
/** Libellé accessible du bouton de fermeture (existe AUSSI sans Échap). */
export const LIGHTBOX_CLOSE_LABEL = "Fermer l'image";
/** Libellés accessibles de la navigation entre images. */
export const LIGHTBOX_PREV_LABEL = "Image précédente";
export const LIGHTBOX_NEXT_LABEL = "Image suivante";

/** Échelle « contain » : l'image entière tient dans la zone, jamais déformée. */
export const LIGHTBOX_MIN_SCALE = 1;
/** Plafond ABSOLU du zoom : garde-fou, jamais un agrandissement absurde. */
export const LIGHTBOX_MAX_SCALE = 16;
/** Zoom d'une image PLUS PETITE que l'écran : la taille réelle n'y changerait
 * rien (elle vaut déjà 1) — sans ce plancher, le clic semblerait sans effet. */
export const LIGHTBOX_SMALL_IMAGE_SCALE = 2;
/** Déplacement (px) au-delà duquel un geste n'est plus un CLIC mais un GLISSER. */
export const LIGHTBOX_DRAG_THRESHOLD_PX = 6;

/* ═══════════════════════════════════════════════════════════════════════════
 * GÉOMÉTRIE PURE (testée sans navigateur : `tests/ui/lightbox.test.ts`)
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Échelle « TAILLE RÉELLE » : 1 pixel d'image = 1 pixel d'écran.
 *
 * `baseWidth` est la largeur d'affichage à l'échelle 1 (celle de `contain`) ;
 * elle est toujours ≤ `naturalWidth`, donc le rapport vaut ≥ 1. Une valeur
 * absente ou nulle (image pas encore décodée) retombe sur `contain` : jamais de
 * division par zéro, jamais un zoom inventé.
 */
export function realScale(naturalWidth, baseWidth) {
  const natural = Number(naturalWidth);
  const base = Number(baseWidth);
  if (!Number.isFinite(natural) || !Number.isFinite(base) || natural <= 0 || base <= 0) {
    return LIGHTBOX_MIN_SCALE;
  }
  return Math.max(LIGHTBOX_MIN_SCALE, natural / base);
}

/**
 * Échelle maximale UTILE : la taille réelle, avec un plancher pour les images
 * plus petites que l'écran (sinon le clic n'aurait aucun effet visible), et le
 * plafond absolu de sécurité.
 */
export function zoomCeiling(naturalWidth, baseWidth) {
  const target = Math.max(realScale(naturalWidth, baseWidth), LIGHTBOX_SMALL_IMAGE_SCALE);
  return Math.min(LIGHTBOX_MAX_SCALE, target);
}

/** Borne une échelle dans `[contain, plafond]` ; une valeur non finie ⇒ contain. */
export function clampScale(scale, ceiling = LIGHTBOX_MAX_SCALE) {
  const value = Number(scale);
  const top = Math.max(Number(ceiling) || LIGHTBOX_MAX_SCALE, LIGHTBOX_MIN_SCALE);
  if (!Number.isFinite(value)) return LIGHTBOX_MIN_SCALE;
  return Math.min(Math.max(value, LIGHTBOX_MIN_SCALE), top);
}

/** Cible d'un CLIC sur l'image : `contain` ⇒ taille réelle, sinon ⇒ `contain`. */
export function clickZoomTarget(scale, naturalWidth, baseWidth) {
  if (Number(scale) > LIGHTBOX_MIN_SCALE + 1e-3) return LIGHTBOX_MIN_SCALE;
  return zoomCeiling(naturalWidth, baseWidth);
}

/**
 * Borne le déplacement : une image PLUS PETITE que la zone reste CENTRÉE
 * (déplacement 0), une image plus grande ne peut jamais laisser de vide sur un
 * bord (elle ne « sort » pas de la vue).
 */
export function clampPan(tx, ty, renderedWidth, renderedHeight, stageWidth, stageHeight) {
  const width = Number(renderedWidth) || 0;
  const height = Number(renderedHeight) || 0;
  const limitX = Math.max(0, (width - (Number(stageWidth) || 0)) / 2);
  const limitY = Math.max(0, (height - (Number(stageHeight) || 0)) / 2);
  const x = Number(tx);
  const y = Number(ty);
  return {
    // `|| 0` : `-0` n'a aucun sens pour un déplacement (et se lit mal dans un test).
    tx: Math.min(limitX, Math.max(-limitX, Number.isFinite(x) ? x : 0)) || 0,
    ty: Math.min(limitY, Math.max(-limitY, Number.isFinite(y) ? y : 0)) || 0,
  };
}

/**
 * Déplacement à appliquer pour que le point pointé RESTE sous le curseur (ou
 * sous le doigt) quand l'échelle passe de `prevScale` à `nextScale`.
 *
 * `dx`/`dy` = distance du point au CENTRE de l'image à l'écran (le `scale` se
 * fait autour du centre : la mise à l'échelle seule ne déplace donc rien).
 */
export function zoomTranslate(tx, ty, prevScale, nextScale, dx, dy) {
  const prev = Number(prevScale);
  const next = Number(nextScale);
  const ratio = Number.isFinite(prev) && prev > 0 && Number.isFinite(next) ? next / prev : 1;
  return {
    tx: (Number(tx) || 0) + (Number(dx) || 0) * (1 - ratio),
    ty: (Number(ty) || 0) + (Number(dy) || 0) * (1 - ratio),
  };
}

/**
 * Déplacement à appliquer pour un PINCEment à deux doigts : SEULE l'échelle change,
 * autour d'un point ANCRÉ (le milieu des doigts au DÉBUT du geste).
 *
 * ⚠️ DÉFAUT CORRIGÉ : le pincement faisait AUSSI suivre le milieu des doigts
 * (déplacement), donc dès que les deux doigts glissaient — même d'un seul côté —
 * l'image fuyait pendant qu'on zoomait : « ça fait aussi bouger l'image, du coup
 * c'est pas contrôlable ». Ici, deux doigts = UN SEUL geste : la mise à l'échelle.
 * Le déplacement reste au doigt UNIQUE (glisser), et rien ne se cumule.
 *
 * `anchor` = point d'écran tenu fixe (milieu initial), `center` = centre de l'image
 * à l'échelle 1 (coordonnées client), `translate` = déplacement courant.
 */
export function pinchZoom(translate, anchor, center, prevScale, nextScale) {
  const tx = Number(translate?.tx) || 0;
  const ty = Number(translate?.ty) || 0;
  // Distance du point ancré au CENTRE de l'image à l'écran : le `scale()` se fait
  // autour du centre, donc c'est cette distance qui doit être conservée.
  return zoomTranslate(
    tx,
    ty,
    prevScale,
    nextScale,
    (Number(anchor?.x) || 0) - ((Number(center?.x) || 0) + tx),
    (Number(anchor?.y) || 0) - ((Number(center?.y) || 0) + ty),
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
 * DOM
 * ═════════════════════════════════════════════════════════════════════════ */

/** Petit constructeur DOM (attributs + enfants), sans injection HTML. */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (value !== undefined && value !== null && value !== false) {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Convertit une icône de la brique `holaf-icons` en nœud SVG DOM (sans HTML). */
function iconNode(doc, name, className) {
  const Parser =
    (doc.defaultView && doc.defaultView.DOMParser) ||
    (typeof DOMParser !== "undefined" ? DOMParser : null);
  if (!Parser) return null;
  const parsed = new Parser().parseFromString(
    HolafIcons.render(name, { class: className }),
    "image/svg+xml",
  );
  const node = doc.importNode
    ? doc.importNode(parsed.documentElement, true)
    : parsed.documentElement;
  // Purement décoratif : le nom accessible vient du contrôle qui le porte.
  node.setAttribute("aria-hidden", "true");
  return node;
}

/** Distance entre deux points `{ x, y }`. */
function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Milieu de deux points `{ x, y }`. */
function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/**
 * Crée LA visionneuse d'images de la conversation (une seule instance, partagée
 * par les blocs qui affichent des images).
 *
 * @param {object} deps
 * @param {HTMLElement} deps.root conteneur du fil (`#conversation`) : sert à
 *   dresser la LISTE des images agrandissables, dans l'ordre du DOM.
 * @param {Document} [deps.doc]
 * @param {Window} [deps.win]
 * @returns {{
 *   decorate(img: HTMLImageElement): HTMLElement,
 *   open(img: HTMLImageElement): boolean,
 *   close(): void,
 *   isOpen(): boolean,
 *   destroy(): void,
 * }}
 */
export function createImageLightbox({
  root,
  doc = typeof document !== "undefined" ? document : undefined,
  win = typeof window !== "undefined" ? window : undefined,
} = {}) {
  if (!doc || !root) throw new Error("createImageLightbox : document et racine requis");
  const view = win ?? doc.defaultView ?? {};

  /** Calque courant (`null` = fermé). */
  let overlay = null;
  /** Zone de l'image (le zoom/le déplacement n'y touchent pas). */
  let stage = null;
  /** Image de la visionneuse (copie : la vignette du fil n'est jamais touchée). */
  let imgEl = null;
  let closeBtn = null;
  let prevBtn = null;
  let nextBtn = null;
  let countEl = null;
  /** `true` pendant un glisser (le relâchement ne doit pas fermer le calque). */
  let gestureMoved = false;
  /** Doigts/pointeurs actifs (id → position client). */
  const pointers = new Map();
  /** Geste en cours : `pan` (1 pointeur) ou `pinch` (2 pointeurs). */
  let gesture = null;
  /** État de vue de l'image affichée. */
  const zoom = { scale: LIGHTBOX_MIN_SCALE, tx: 0, ty: 0, baseW: 0, baseH: 0, naturalW: 0, naturalH: 0 };
  /** Images agrandissables (`{ src, alt }`), dans l'ordre du DOM. */
  let items = [];
  let index = 0;
  /** Élément qui avait le focus avant l'ouverture (rendu à la fermeture). */
  let previousFocus = null;

  /* ─── Mesures et transform ────────────────────────────────────────────── */

  /** Applique le transform (CSSOM : `style-src 'self'` n'y touche pas). */
  function applyTransform() {
    if (!imgEl || !overlay) return;
    imgEl.style.transform = `translate(${zoom.tx}px, ${zoom.ty}px) scale(${zoom.scale})`;
    overlay.classList.toggle("lightbox--zoomed", zoom.scale > LIGHTBOX_MIN_SCALE + 1e-3);
  }

  /** Mesure la taille d'affichage à l'échelle 1 et la taille NATURELLE. */
  function measure() {
    if (!imgEl) return;
    zoom.naturalW = Number(imgEl.naturalWidth) || 0;
    zoom.naturalH = Number(imgEl.naturalHeight) || 0;
    const scale = zoom.scale > 1e-3 ? zoom.scale : 1;
    const rect = imgEl.getBoundingClientRect();
    zoom.baseW = rect.width / scale;
    zoom.baseH = rect.height / scale;
  }

  /** Recompose la vue en `contain`, centrée, sans déplacement. */
  function resetView() {
    zoom.scale = LIGHTBOX_MIN_SCALE;
    zoom.tx = 0;
    zoom.ty = 0;
    applyTransform();
  }

  /** Borne le déplacement courant pour que l'image ne quitte jamais la zone. */
  function clampView() {
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const panned = clampPan(
      zoom.tx,
      zoom.ty,
      zoom.baseW * zoom.scale,
      zoom.baseH * zoom.scale,
      rect.width,
      rect.height,
    );
    zoom.tx = panned.tx;
    zoom.ty = panned.ty;
  }

  /** Centre de l'image à l'échelle 1 (coordonnées client) — invariant au zoom. */
  function baseCenter() {
    const rect = imgEl.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2 - zoom.tx,
      y: rect.top + rect.height / 2 - zoom.ty,
    };
  }

  /**
   * Change l'échelle en gardant sous le point `(clientX, clientY)` le même détail
   * de l'image. Sans point fourni : zoom autour du centre de l'image.
   */
  function setScale(nextScale, clientX, clientY) {
    if (!imgEl || !stage) return;
    const target = clampScale(nextScale, zoomCeiling(zoom.naturalW, zoom.baseW));
    if (Math.abs(target - zoom.scale) < 1e-4) return;
    const center = baseCenter();
    const point =
      typeof clientX === "number" && typeof clientY === "number"
        ? { x: clientX, y: clientY }
        : { x: center.x + zoom.tx, y: center.y + zoom.ty };
    const moved = zoomTranslate(
      zoom.tx,
      zoom.ty,
      zoom.scale,
      target,
      point.x - (center.x + zoom.tx),
      point.y - (center.y + zoom.ty),
    );
    zoom.scale = target;
    zoom.tx = moved.tx;
    zoom.ty = moved.ty;
    clampView();
    applyTransform();
  }

  /** Bascule `contain` ↔ taille réelle (le clic sur l'image, ou Entrée). */
  function toggleZoom(clientX, clientY) {
    setScale(clickZoomTarget(zoom.scale, zoom.naturalW, zoom.baseW), clientX, clientY);
  }

  /* ─── Gestes (Pointer Events : souris, doigt, stylet) ──────────────────── */

  function onPointerDown(event) {
    if (!stage) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (!pointers.has(event.pointerId)) {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }
    gestureMoved = false;
    const ids = [...pointers.keys()];
    if (ids.length === 1) {
      gesture = {
        kind: "pan",
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        tx: zoom.tx,
        ty: zoom.ty,
        // ⚠️ Mémorisé ICI : au relâchement, la cible d'un pointeur capturé
        // pourrait être la zone et non l'image.
        onImage: event.target === imgEl,
      };
      overlay?.classList.add("lightbox--grab");
    } else if (ids.length === 2) {
      const [a, b] = ids.map((id) => pointers.get(id));
      gesture = {
        kind: "pinch",
        dist: distance(a, b),
        mid: midpoint(a, b),
        scale: zoom.scale,
        center: baseCenter(),
      };
    }
  }

  function onPointerMove(event) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const ids = [...pointers.keys()];

    if (gesture && gesture.kind === "pinch" && ids.length >= 2) {
      const [a, b] = ids.map((id) => pointers.get(id));
      const dist = distance(a, b);
      const start = gesture.dist > 0 ? gesture.dist : dist || 1;
      const nextScale = clampScale(
        gesture.scale * (dist / start),
        zoomCeiling(zoom.naturalW, zoom.baseW),
      );
      // ⚠️ L'ANCRE est le milieu des doigts au DÉBUT du geste, et elle ne bouge
      // plus : un pincement ne déplace JAMAIS l'image (deux doigts ne sont pas un
      // glisser). Le milieu COURANT ne sert qu'à mesurer l'écart.
      const moved = pinchZoom(zoom, gesture.mid, gesture.center, zoom.scale, nextScale);
      zoom.scale = nextScale;
      zoom.tx = moved.tx;
      zoom.ty = moved.ty;
      clampView();
      applyTransform();
      gestureMoved = true;
      event.preventDefault();
      return;
    }

    // ⚠️ DÉPLACEMENT SEULEMENT AVEC UN DOIGT : si un second pointeur est actif
    // (pincement en cours, ou doigt posé pendant un glisser), le glisser est
    // SUSPENDU — jamais deux gestes concurrents qui se disputent l'image.
    if (
      gesture &&
      gesture.kind === "pan" &&
      event.pointerId === gesture.id &&
      pointers.size === 1
    ) {
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (Math.hypot(dx, dy) > LIGHTBOX_DRAG_THRESHOLD_PX) {
        gestureMoved = true;
        overlay?.classList.add("lightbox--dragging");
      }
      if (zoom.scale <= LIGHTBOX_MIN_SCALE + 1e-3) {
        // À l'échelle « contain », l'image est déjà entière : rien à déplacer.
        if (gestureMoved) event.preventDefault();
        return;
      }
      zoom.tx = gesture.tx + dx;
      zoom.ty = gesture.ty + dy;
      clampView();
      applyTransform();
      if (gestureMoved) event.preventDefault();
    }
  }

  function onPointerUp(event) {
    const tracked = pointers.delete(event.pointerId);
    overlay?.classList.remove("lightbox--dragging", "lightbox--grab");
    if (!tracked || !gesture) return;
    const finished = gesture;
    if (pointers.size === 0) {
      gesture = null;
      // TAP simple sur l'IMAGE ⇒ bascule contain ↔ taille réelle.
      if (finished.kind === "pan" && !gestureMoved && finished.onImage) {
        toggleZoom(event.clientX, event.clientY);
      }
      // Un pincement a DÉJÀ marqué `gestureMoved` : le `click` qui suit ne doit
      // pas fermer le calque (le gestionnaire de clic le consomme).
      return;
    }
    if (pointers.size === 1) {
      const [id] = [...pointers.keys()];
      const point = pointers.get(id);
      gesture = {
        kind: "pan",
        id,
        x: point.x,
        y: point.y,
        tx: zoom.tx,
        ty: zoom.ty,
        onImage: false,
      };
    }
  }

  function onWheel(event) {
    // ⚠️ TOUJOURS `preventDefault` : la molette ne doit JAMAIS atteindre le fil
    // (le calque est au-dessus, mais on ne laisse rien passer).
    event.preventDefault();
    if (!stage) return;
    if (event.target !== stage && event.target !== imgEl) return;
    const factor = Math.exp(-(Number(event.deltaY) || 0) * 0.002);
    setScale(zoom.scale * factor, event.clientX, event.clientY);
  }

  /* ─── Clavier (Échap, flèches, +/-, 0, piège à focus) ─────────────────── */

  function focusables() {
    if (!overlay) return [];
    return [...overlay.querySelectorAll("button")].filter((el) => !el.hidden);
  }

  function onKeyDown(event) {
    if (!overlay) return;
    const target = event.target;
    const tag = target && target.tagName ? String(target.tagName).toLowerCase() : "";
    if (tag === "input" || tag === "textarea" || (target && target.isContentEditable)) return;

    if (event.key === "Escape") {
      event.preventDefault();
      // Le calque est le DERNIER ouvert : il consomme Échap avant les menus.
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      show(index - 1);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      show(index + 1);
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setScale(zoom.scale * 1.25);
      return;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      setScale(zoom.scale / 1.25);
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      resetView();
      return;
    }
    if (event.key === "Tab") {
      const list = focusables();
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && doc.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && doc.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  /* ─── Ouverture / fermeture ───────────────────────────────────────────── */

  function onResize() {
    if (!imgEl) return;
    const scale = zoom.scale;
    resetView();
    measure();
    // On garde le niveau de zoom (une rotation de téléphone ne doit pas le
    // perdre), mais on re-borne le déplacement : jamais de vide sur un bord.
    zoom.scale = clampScale(scale, zoomCeiling(zoom.naturalW, zoom.baseW));
    clampView();
    applyTransform();
  }

  function onImageLoad() {
    if (!imgEl) return;
    const wasZoomed = zoom.scale > LIGHTBOX_MIN_SCALE + 1e-3;
    measure();
    if (!wasZoomed) {
      resetView();
      return;
    }
    clampView();
    applyTransform();
  }

  /** Affiche l'image `next` (navigation circulaire), vue remise en `contain`. */
  function show(next) {
    if (!imgEl || items.length === 0) return;
    index = ((next % items.length) + items.length) % items.length;
    resetView();
    imgEl.src = items[index].src;
    imgEl.alt = items[index].alt;
    const many = items.length > 1;
    if (prevBtn) prevBtn.hidden = !many;
    if (nextBtn) nextBtn.hidden = !many;
    if (countEl) {
      countEl.hidden = !many;
      countEl.textContent = `${index + 1} / ${items.length}`;
    }
    overlay?.setAttribute("data-index", String(index));
  }

  /** Construit le calque (une fois par ouverture) et câble ses événements. */
  function build() {
    stage = h("div", { class: "lightbox__stage" });
    imgEl = h("img", { class: "lightbox__img", alt: "", draggable: "false" });
    stage.append(imgEl);

    closeBtn = h(
      "button",
      {
        class: "lightbox__close",
        type: "button",
        "aria-label": LIGHTBOX_CLOSE_LABEL,
        title: LIGHTBOX_CLOSE_LABEL,
      },
      [iconNode(doc, "x", "icon lightbox__icon")],
    );
    prevBtn = h(
      "button",
      {
        class: "lightbox__nav lightbox__nav--prev",
        type: "button",
        "aria-label": LIGHTBOX_PREV_LABEL,
        title: LIGHTBOX_PREV_LABEL,
      },
      [iconNode(doc, "chevron-left", "icon lightbox__icon")],
    );
    nextBtn = h(
      "button",
      {
        class: "lightbox__nav lightbox__nav--next",
        type: "button",
        "aria-label": LIGHTBOX_NEXT_LABEL,
        title: LIGHTBOX_NEXT_LABEL,
      },
      [iconNode(doc, "chevron-right", "icon lightbox__icon")],
    );
    countEl = h("span", { class: "lightbox__count", "aria-live": "polite" });
    const bar = h("div", { class: "lightbox__bar" }, [prevBtn, countEl, nextBtn]);

    overlay = h(
      "div",
      {
        class: "lightbox",
        role: "dialog",
        "aria-modal": "true",
        "aria-label": LIGHTBOX_LABEL,
      },
      [stage, bar, closeBtn],
    );

    // Fermeture : clic à CÔTÉ (le fond, ou la zone autour de l'image) — jamais
    // après un GLISSER (sinon on fermerait en fin de déplacement).
    overlay.addEventListener("click", (event) => {
      if (gestureMoved) {
        gestureMoved = false;
        return;
      }
      if (event.target === overlay || event.target === stage) close();
    });
    overlay.addEventListener("wheel", onWheel, { passive: false });
    closeBtn.addEventListener("click", () => close());
    prevBtn.addEventListener("click", () => show(index - 1));
    nextBtn.addEventListener("click", () => show(index + 1));
    stage.addEventListener("pointerdown", onPointerDown);
    imgEl.addEventListener("load", onImageLoad);

    doc.addEventListener("pointermove", onPointerMove, { passive: false });
    doc.addEventListener("pointerup", onPointerUp);
    doc.addEventListener("pointercancel", onPointerUp);
    // Capture : le calque consomme Échap avant les menus (`mobile-nav.js`, etc.).
    doc.addEventListener("keydown", onKeyDown, true);
    if (typeof view.addEventListener === "function") view.addEventListener("resize", onResize);

    doc.body.append(overlay);
  }

  /** Retire le calque ET tous ses écouteurs (PIÈGE ④ : aucun nœud orphelin). */
  function dispose() {
    doc.removeEventListener("pointermove", onPointerMove, { passive: false });
    doc.removeEventListener("pointerup", onPointerUp);
    doc.removeEventListener("pointercancel", onPointerUp);
    doc.removeEventListener("keydown", onKeyDown, true);
    if (typeof view.removeEventListener === "function") view.removeEventListener("resize", onResize);
    pointers.clear();
    gesture = null;
    gestureMoved = false;
    if (overlay) overlay.remove();
    overlay = null;
    stage = null;
    imgEl = null;
    closeBtn = null;
    prevBtn = null;
    nextBtn = null;
    countEl = null;
    items = [];
    index = 0;
    zoom.scale = LIGHTBOX_MIN_SCALE;
    zoom.tx = 0;
    zoom.ty = 0;
    zoom.baseW = 0;
    zoom.baseH = 0;
    zoom.naturalW = 0;
    zoom.naturalH = 0;
  }

  function close() {
    const focusTarget = previousFocus;
    previousFocus = null;
    if (!overlay) return;
    dispose();
    // ⚠️ `preventScroll` : rendre le focus ne doit PAS faire défiler le fil
    // d'un pixel (PIÈGE ①).
    if (focusTarget && typeof focusTarget.focus === "function") {
      try {
        focusTarget.focus({ preventScroll: true });
      } catch {
        /* élément détaché : rien à rendre */
      }
    }
  }

  /**
   * Ouvre la visionneuse sur `img` (une image DÉCORÉE), avec la LISTE des autres
   * images du fil pour la navigation.
   *
   * @returns {boolean} `false` si `img` n'est pas une vignette agrandissable.
   */
  function open(img) {
    if (!img || !root) return false;
    const decorated = [...root.querySelectorAll(`img.${ZOOM_IMAGE_CLASS}`)];
    const start = decorated.indexOf(img);
    if (start < 0) return false;
    if (overlay) close();
    items = decorated.map((el) => ({
      src: el.currentSrc || el.getAttribute("src") || "",
      alt: el.getAttribute("alt") || "",
    }));
    previousFocus = doc.activeElement ?? null;
    build();
    show(start);
    // Le focus entre dans le calque sans faire défiler le fil.
    if (closeBtn) {
      try {
        closeBtn.focus({ preventScroll: true });
      } catch {
        /* focus impossible : le calque reste utilisable */
      }
    }
    return true;
  }

  /**
   * Enveloppe une image dans le BOUTON de vignette (indice de clic + clic).
   *
   * ⚠️ L'image n'est ni copiée ni rechargée : elle est seulement ENVELOPPÉE, donc
   * le bloc d'image garde ses métadonnées et sa fiche. Le bouton ne contient que
   * l'image et un indice décoratif : aucun texte parasite dans le fil.
   *
   * @returns {HTMLElement} le bouton (à insérer à la place de l'image).
   */
  function decorate(img) {
    if (!img) return img;
    const existing = typeof img.closest === "function" ? img.closest(`.${ZOOM_WRAPPER_CLASS}`) : null;
    if (existing) return existing;
    img.classList.add(ZOOM_IMAGE_CLASS);
    img.setAttribute("draggable", "false");
    const hint = h("span", { class: `${ZOOM_WRAPPER_CLASS}__hint`, "aria-hidden": "true" }, [
      iconNode(doc, "zoom-in", "icon"),
    ]);
    const wrapper = h(
      "button",
      {
        class: ZOOM_WRAPPER_CLASS,
        type: "button",
        "aria-label": ZOOM_HINT_LABEL,
        title: ZOOM_HINT_LABEL,
      },
      [img, hint],
    );
    wrapper.addEventListener("click", () => {
      open(img);
    });
    return wrapper;
  }

  return {
    decorate,
    open,
    close,
    isOpen: () => overlay !== null,
    destroy: dispose,
  };
}
