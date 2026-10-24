// Yuki — APPUI LONG (tactile) partagé par les listes de l'interface.
//
// Sur un téléphone, le CLIC DROIT n'existe pas : sans appui long, le menu
// contextuel (renommer / épingler / mettre de côté / conversation dédiée… pour
// une conversation, niveau de confirmation pour un agent) serait INATTEIGNABLE.
// Ce module ajoute donc UN comportement, réutilisé par les deux listes, sans
// toucher au clic droit de la souris (comportement bureau inchangé).
//
// ⚠️ Décisions :
//   - la SOURIS est ignorée (`pointerType === "mouse"`) : sur bureau, seul le
//     clic droit ouvre le menu, exactement comme avant ;
//   - un déplacement de plus de `movePx` (ou un relâchement) ANNULA l'appui
//     long : faire défiler la liste ne doit jamais ouvrir un menu ;
//   - le `click` qui SUIT un appui long est absorbé (capture) : il ne doit pas
//     déclencher l'action normale (changer de conversation, activer l'agent) ;
//   - aucune dépendance au DOM hors `addEventListener` : testable avec un
//     élément factice (voir tests/ui/long-press.test.ts).

/** Durée (ms) d'un appui reconnu comme « long » (seuil usuel des navigateurs). */
export const LONG_PRESS_MS = 500;

/** Déplacement (px) toléré pendant l'appui avant annulation. */
export const LONG_PRESS_MOVE_PX = 10;

/** Durée (ms) pendant laquelle le `click` suivant est absorbé (filet de sécurité
 * si aucun clic ne suit réellement le relâchement). */
export const LONG_PRESS_CLICK_GUARD_MS = 1200;

/**
 * Arme l'appui long sur `element`.
 *
 * @param {HTMLElement} element cible (ligne de conversation, entrée d'agent…).
 * @param {(point: {x: number, y: number}) => void} onLongPress appelé UNE fois
 *   quand l'appui est reconnu, avec le point de départ (coordonnées viewport).
 * @param {{ms?: number, movePx?: number}} [options]
 * @returns {() => void} désarmement (retrait des écouteurs + minuteur).
 */
export function attachLongPress(element, onLongPress, options = {}) {
  if (!element || typeof element.addEventListener !== "function") return () => {};
  const ms = Number.isFinite(options.ms) ? options.ms : LONG_PRESS_MS;
  const movePx = Number.isFinite(options.movePx) ? options.movePx : LONG_PRESS_MOVE_PX;
  const doc = element.ownerDocument || globalThis.document;

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let startX = 0;
  let startY = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let swallowTimer = null;

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  /**
   * Absorbe le `click` qui SUIT l'appui long, où qu'il atterrisse.
   * ⚠️ Écouteur de CAPTURE sur le DOCUMENT : il s'exécute avant TOUS les
   * écouteurs d'éléments (y compris ceux d'un bouton enfant comme la pastille
   * d'agent) ; un écouteur posé sur l'élément arriverait trop tard quand
   * l'appui long démarre sur un enfant. One-shot, avec filet de sécurité
   * (aucun vrai clic ne suit parfois).
   */
  function swallowClick(event) {
    unfire();
    if (typeof event.preventDefault === "function") event.preventDefault();
    if (typeof event.stopPropagation === "function") event.stopPropagation();
    if (typeof event.stopImmediatePropagation === "function") {
      event.stopImmediatePropagation();
    }
  }

  function unfire() {
    if (swallowTimer !== null) {
      clearTimeout(swallowTimer);
      swallowTimer = null;
    }
    if (doc && typeof doc.removeEventListener === "function") {
      doc.removeEventListener("click", swallowClick, true);
    }
  }

  function onPointerDown(event) {
    // Souris (et stylet « souris ») : le clic droit reste le seul déclencheur.
    if (!event || event.pointerType === "mouse") return;
    if (Number.isFinite(event.button) && event.button > 0) return;
    clearTimer();
    unfire();
    startX = Number(event.clientX) || 0;
    startY = Number(event.clientY) || 0;
    timer = setTimeout(() => {
      timer = null;
      if (doc && typeof doc.addEventListener === "function") {
        // `true` = capture : aucun écouteur d'élément n'aura l'occasion de
        // traiter ce clic.
        doc.addEventListener("click", swallowClick, true);
        swallowTimer = setTimeout(unfire, LONG_PRESS_CLICK_GUARD_MS);
      }
      onLongPress({ x: startX, y: startY });
    }, ms);
  }

  function onPointerMove(event) {
    if (timer === null) return;
    const dx = (Number(event.clientX) || 0) - startX;
    const dy = (Number(event.clientY) || 0) - startY;
    if (Math.hypot(dx, dy) > movePx) clearTimer();
  }

  function onPointerEnd() {
    clearTimer();
  }

  element.addEventListener("pointerdown", onPointerDown);
  element.addEventListener("pointermove", onPointerMove);
  element.addEventListener("pointerup", onPointerEnd);
  element.addEventListener("pointercancel", onPointerEnd);
  element.addEventListener("pointerleave", onPointerEnd);

  return function detach() {
    clearTimer();
    unfire();
    element.removeEventListener("pointerdown", onPointerDown);
    element.removeEventListener("pointermove", onPointerMove);
    element.removeEventListener("pointerup", onPointerEnd);
    element.removeEventListener("pointercancel", onPointerEnd);
    element.removeEventListener("pointerleave", onPointerEnd);
  };
}
