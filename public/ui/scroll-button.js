// Yuki — BOUTON « REVENIR EN BAS DE LA CONVERSATION ».
//
// Un bouton FLOTTANT, discret, qui n'apparaît QUE lorsqu'on a remonté le fil
// (au-delà d'un SEUIL) et qui, au clic, ramène en bas d'un geste FLUIDE puis
// laisse le fil ÉPINGLÉ (le défilement automatique reprend la main).
//
// ⚠️ Ce module ne possède AUCUN système de défilement : la visibilité s'appuie
// sur `isPinned` (le seuil d'épinglage de l'app, `isConversationPinned`), l'état
// de retour en cours sur `isReturning` (le drapeau `stickToBottom` de l'app) et
// le clic sur `onActivate` (`goToEnd`, qui réutilise `pinIfNeeded`). Le bouton
// n'écrit jamais `scrollTop` lui-même.
//
// ⚠️ CSP stricte (`default-src 'none'; style-src 'self'`) : aucune injection
// HTML, aucun attribut de style dans le markup. Le DOM est construit par
// `createElement`, l'icône SVG par `DOMParser`/`importNode` (patron de
// `markdown.js`/`sessions-panel.js`), et le positionnement par CSSOM
// (`el.style.left/top`) — exactement comme la fenêtre de validation
// (`approval-window.js`) et le menu contextuel.
//
// ⚠️ Placement : la fenêtre de validation flottante apparaît PAR DÉFAUT dans le
// coin BAS-DROITE (large paysage) et sa position est MÉMORISÉE. Le bouton prend
// donc le coin BAS-GAUCHE, et si la fenêtre y empiète (écran étroit : elle est
// quasi pleine largeur), il BASCULE dans le coin HAUT-GAUCHE — mesuré, jamais
// recouvert, jamais recouvrant (z-index SOUS la fenêtre).

import { HolafIcons } from "./vendor/holaf/holaf-icons.js";

/** Distance (px) du bas à partir de laquelle le bouton APPARAÎT. */
export const SCROLL_BUTTON_SHOW_PX = 80;
/** Marge (px) entre le bouton et le bord du fil. */
const EDGE_PX = 16;
/** Côté (px) du bouton (carré, affiché en pastille ronde). */
const SIZE_PX = 40;
/** Libellé accessible (français), porté par `aria-label` ET `title`. */
export const SCROLL_BOTTOM_LABEL = "Revenir en bas de la conversation";

/**
 * Décision PURE de visibilité (hystérésis anti-clignotement) :
 *   - une fois VISIBLE, le bouton reste visible tant que le fil n'est pas
 *     ré-épinglé (distance ≤ seuil d'épinglage) ⇒ il ne clignote pas quand le
 *     défilement oscille entre les deux seuils ;
 *   - une fois MASQUÉ, il ne réapparaît qu'au-delà du SEUIL D'APPARITION (80 px),
 *     très supérieur au seuil d'épinglage (24 px) ⇒ jamais déclenché par 5 px.
 *
 * @param {boolean} visible état courant.
 * @param {number} distance distance (px) au bas du fil (0 = collé en bas).
 * @param {boolean} pinned `true` si le fil est épinglé (distance ≤ seuil).
 */
export function shouldShowScrollButton(visible, distance, pinned) {
  if (visible) return !pinned;
  return distance > SCROLL_BUTTON_SHOW_PX;
}

/** Deux rectangles (coordonnées viewport) se recouvrent-ils ? */
export function rectsIntersect(a, b) {
  return (
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  );
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
  // Purement décoratif : le nom accessible vient du `<button>`.
  node.setAttribute("aria-hidden", "true");
  return node;
}

/**
 * Crée le bouton « revenir en bas » et le câble au fil.
 *
 * @param {object} deps
 * @param {HTMLElement} deps.conversation conteneur défilant (`#conversation`).
 * @param {() => boolean} deps.isPinned `true` si le fil est collé en bas.
 * @param {() => boolean} deps.isReturning `true` tant qu'un retour en bas FLUIDE
 *   est en cours (le bouton reste alors masqué).
 * @param {() => void} deps.onActivate retour en bas (fluide + ré-épinglage).
 * @param {() => void} [deps.onUserIntent] geste utilisateur (molette/toucher/
 *   clavier) : annule un éventuel retour en bas en cours.
 * @param {Document} [deps.doc]
 * @param {Window} [deps.win]
 * @returns {{ button: HTMLButtonElement, refresh: () => void, destroy: () => void,
 *   isVisible: () => boolean }}
 */
export function createScrollToBottom({
  conversation,
  isPinned,
  isReturning,
  onActivate,
  onUserIntent,
  doc = typeof document !== "undefined" ? document : undefined,
  win = typeof window !== "undefined" ? window : undefined,
} = {}) {
  if (!doc || !conversation) {
    throw new Error("createScrollToBottom : document et conversation requis");
  }
  const view = win ?? doc.defaultView ?? {};

  const button = doc.createElement("button");
  button.type = "button";
  button.className = "scroll-bottom";
  button.hidden = true;
  button.setAttribute("aria-label", SCROLL_BOTTOM_LABEL);
  button.title = SCROLL_BOTTOM_LABEL;
  const icon = iconNode(doc, "arrow-down", "icon scroll-bottom__icon");
  if (icon) button.append(icon);
  doc.body.append(button);

  let visible = false;

  /** Distance (px) du bas du fil ; 0 = collé en bas. */
  function distanceFromBottom() {
    return conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
  }

  /** Le fil est-il exploitable (conversation montée et dimensionnée) ? */
  function usable() {
    return conversation.clientHeight > 0 && conversation.clientWidth > 0;
  }

  /** Fenêtres flottantes de validation présentes (rectangles viewport). */
  function obstacles() {
    return [...doc.querySelectorAll(".approval-window")].map((el) =>
      el.getBoundingClientRect(),
    );
  }

  /** Positionne le bouton dans le fil : `top` = haut-gauche, sinon bas-gauche. */
  function place(slot) {
    const rect = conversation.getBoundingClientRect();
    const left = Math.round(rect.left + EDGE_PX);
    const top =
      slot === "top"
        ? Math.round(rect.top + EDGE_PX)
        : Math.round(rect.bottom - SIZE_PX - EDGE_PX);
    button.style.left = `${left}px`;
    button.style.top = `${top}px`;
    button.dataset.slot = slot;
  }

  /**
   * Choisit le coin LIBRE : bas-gauche par défaut ; si une fenêtre de validation
   * l'occupe, bascule haut-gauche ; si les deux sont occupés (fenêtre plein
   * écran), on garde le bas (la fenêtre reste AU-DESSUS, jamais recouverte).
   */
  function placeBest() {
    const windows = obstacles();
    for (const slot of ["bottom", "top"]) {
      place(slot);
      if (!windows.some((w) => rectsIntersect(button.getBoundingClientRect(), w))) return slot;
    }
    place("bottom");
    return "bottom";
  }

  function setShown(next) {
    if (next === visible) return;
    visible = next;
    // ⚠️ On AFFICHE d'abord (un élément `hidden` a un rectangle NUL) : le
    // placement ci-dessous mesure la position RÉELLE pour éviter la fenêtre.
    button.hidden = !next;
    if (next) placeBest();
  }

  let frame = 0;
  function schedule() {
    if (frame) return;
    const raf = view.requestAnimationFrame
      ? view.requestAnimationFrame.bind(view)
      : (cb) => view.setTimeout(cb, 16);
    frame = raf(() => {
      frame = 0;
      refresh();
    });
  }

  function refresh() {
    if (!usable()) {
      setShown(false);
      return;
    }
    // Retour en bas en cours : le bouton reste masqué jusqu'à ré-épinglage.
    if (typeof isReturning === "function" && isReturning()) {
      setShown(false);
      return;
    }
    const next = shouldShowScrollButton(
      visible,
      distanceFromBottom(),
      isPinned(),
    );
    setShown(next);
  }

  /** Re-positionne un bouton VISIBLE (redimensionnement, fenêtre déplacée). */
  function reposition() {
    if (visible) placeBest();
  }

  function onUserGesture() {
    if (typeof onUserIntent === "function") onUserIntent();
    schedule();
  }

  button.addEventListener("click", () => {
    setShown(false);
    if (typeof onActivate === "function") onActivate();
  });
  conversation.addEventListener("scroll", schedule, { passive: true });
  // Gestes EXPLICITES de l'utilisateur : annulent un retour en bas en cours.
  for (const type of ["wheel", "touchstart", "keydown"]) {
    conversation.addEventListener(type, onUserGesture, { passive: true });
  }
  if (typeof view.addEventListener === "function") {
    view.addEventListener("resize", reposition);
  }

  // Les fenêtres de validation s'ajoutent/retirent dans la couche flottante :
  // un bouton VISIBLE se replace alors pour ne jamais rester sous l'une d'elles.
  let observer = null;
  const layer = doc.querySelector(".approval-layer");
  const MutationObserverCtor = view.MutationObserver;
  if (layer && typeof MutationObserverCtor === "function") {
    observer = new MutationObserverCtor(() => reposition());
    observer.observe(layer, { childList: true });
  }

  refresh();

  return {
    button,
    refresh,
    isVisible: () => visible,
    destroy() {
      if (observer) observer.disconnect();
      conversation.removeEventListener("scroll", schedule);
      for (const type of ["wheel", "touchstart", "keydown"]) {
        conversation.removeEventListener(type, onUserGesture);
      }
      if (typeof view.removeEventListener === "function") {
        view.removeEventListener("resize", reposition);
      }
      button.remove();
    },
  };
}
