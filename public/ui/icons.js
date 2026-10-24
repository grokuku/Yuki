// Yuki — icônes de la brique holaf-lib `icons` RENDUES dans le DOM.
//
// ⚠️ CSP stricte (`style-src 'self'`, aucun `innerHTML`) : le SVG est produit
// par la brique (`HolafIcons.render`), puis converti en NŒUD DOM via
// `DOMParser` + `importNode` — jamais injecté en HTML. Le tracé garde
// `stroke="currentColor"` (il suit donc `color`/`--icon-color`) et son
// `aria-hidden` : il est purement décoratif, le nom accessible vient du
// bouton qui le porte.
//
// Un emplacement peut être déclaré dans le markup statique avec
// `data-holaf-icon="<nom>"` (et, si besoin, `data-holaf-icon-class`) :
// `renderIconSlots` y pose l'icône. Aucun SVG n'est donc écrit à la main dans
// `index.html`.

import { HolafIcons } from "./vendor/holaf/holaf-icons.js";

/**
 * Convertit une icône de la brique en nœud SVG.
 *
 * @param {string} name nom d'icône de la brique (`gear`, `chevron-down`…).
 * @param {string} [className] classe(s) du SVG (`.icon` par défaut côté brique).
 * @param {Document} [doc]
 * @returns {SVGElement | null} `null` si le DOM/parseur n'est pas disponible.
 */
export function iconNode(name, className, doc = globalThis.document) {
  const Parser =
    (doc && doc.defaultView && doc.defaultView.DOMParser) ||
    (typeof DOMParser !== "undefined" ? DOMParser : null);
  if (!doc || typeof name !== "string" || name === "" || !Parser) return null;
  const svg = HolafIcons.render(name, className ? { class: className } : {});
  const parsed = new Parser().parseFromString(svg, "image/svg+xml");
  const root = parsed && parsed.documentElement;
  if (!root || root.nodeName.toLowerCase() === "parsererror") return null;
  const node = doc.importNode(root, true);
  node.setAttribute("aria-hidden", "true");
  return node;
}

/**
 * Remplit les emplacements `[data-holaf-icon]` présents sous `root`.
 *
 * @param {ParentNode} root conteneur (le nœud lui-même n'est pas un emplacement).
 * @param {Document} [doc]
 */
export function renderIconSlots(root, doc = globalThis.document) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  for (const slot of root.querySelectorAll("[data-holaf-icon]")) {
    const name = slot.getAttribute("data-holaf-icon");
    const className = slot.getAttribute("data-holaf-icon-class") || "icon";
    const node = iconNode(name, className, doc);
    if (node) slot.replaceChildren(node);
  }
}
