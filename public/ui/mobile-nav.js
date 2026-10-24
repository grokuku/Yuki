// Yuki — NAVIGATION TÉLÉPHONE : trois menus déroulants en haut de l'écran.
//
// Sur téléphone, la barre latérale est ABSENTE (le fil prend toute la largeur) :
// ses informations et ses actions vivent dans trois menus déroulants — ①
// Conversations, ② Agents, ③ Config — ouverts depuis une barre de trois boutons
// de largeur ÉGALE (voir styles.css, `.mnav`).
//
// ⚠️ Ce module ne fait QUE la mécanique d'ouverture/fermeture (état, position,
// fond assombri, focus, Échap). Le CONTENU est rendu par les composants
// existants, qui reçoivent une cible supplémentaire :
//   - conversations → `sessions-panel.js` (même rendu, même menu contextuel,
//     même appui long) ;
//   - agents → `sidebar-agents.js` (mêmes pastilles, même menu de niveau) ;
//   - config → liens vers `/config#<onglet>` (une seule page de configuration).
//
// ⚠️ CSP stricte : aucun `innerHTML`, aucun style en ligne STATIQUE. La seule
// mutation CSSOM est la POSITION du calque (`top`), exactement comme le menu
// contextuel et la fenêtre de validation.

import { renderIconSlots } from "./icons.js";

/**
 * Requête média qui décide du dessin TÉLÉPHONE (la même que la feuille de
 * style — une seule source de vérité pour le CSS ET le JS).
 *
 * SEUIL : 767 px de large (soit « moins de 768 px »). En dessous, la barre
 * latérale de 280 px dépliée mangerait 39 % d'un écran de 720 px et le rail de
 * 56 px encore 15,5 % d'un écran de 360 px : le fil ne « prendrait » plus toute
 * la place, qui est la demande n°1.
 *
 * ⚠️ Un téléphone en PAYSAGE est LARGE (844×390 par exemple) : le seul critère
 * de largeur le classerait à tort en « bureau ». On ajoute donc le cas
 * `(max-height: 480px) and (pointer: coarse)` : hauteur de téléphone couché +
 * doigt (pointeur grossier) ⇒ dessin téléphone.
 */
export const MOBILE_MEDIA_QUERY =
  "(max-width: 767px), (max-height: 480px) and (pointer: coarse)";

/** Largeur (px) à partir de laquelle le dessin BUREAU reprend. */
export const MOBILE_MAX_WIDTH_PX = 767;

/** Noms des trois menus, dans l'ordre de la barre. */
export const NAV_SECTIONS = ["conversations", "agents", "config"];

/** `true` si la fenêtre doit utiliser le dessin téléphone. */
export function isMobileViewport(win = globalThis.window) {
  if (!win || typeof win.matchMedia !== "function") return false;
  try {
    return Boolean(win.matchMedia(MOBILE_MEDIA_QUERY).matches);
  } catch {
    return false;
  }
}

/**
 * Câble la barre de navigation téléphone.
 *
 * @param {object} deps
 * @param {HTMLElement} deps.root barre des trois boutons (`#mobile-nav`).
 * @param {HTMLElement} deps.layer calque des menus (`#mobile-nav-layer`).
 * @param {() => void} [deps.onNew] action « + Nouvelle » (conversations).
 * @param {() => void} [deps.onToggleTheme] action « Thème » (bascule clair/sombre).
 * @param {() => string} [deps.getThemeSummary] libellé du thème courant.
 * @param {Document} [deps.doc]
 * @param {Window} [deps.win]
 * @returns {{ open(name: string): void, close(): void, toggle(name: string): void,
 *   isOpen(): boolean, current(): string | null, refreshTheme(): void }}
 */
export function initMobileNav({
  root,
  layer,
  onNew,
  onToggleTheme,
  getThemeSummary,
  doc = globalThis.document,
  win = globalThis.window,
} = {}) {
  if (!root || !layer) throw new Error("initMobileNav : barre ou calque absent");
  const buttons = new Map();
  for (const section of NAV_SECTIONS) {
    const button = root.querySelector(`[data-nav="${section}"]`);
    if (button) buttons.set(section, button);
  }
  const panels = new Map();
  for (const section of NAV_SECTIONS) {
    const panel = layer.querySelector(`[data-panel="${section}"]`);
    if (panel) panels.set(section, panel);
  }
  const newButton = layer.querySelector('[data-action="new"]');
  const themeButton = layer.querySelector('[data-action="theme"]');
  const themeValue = themeButton ? themeButton.querySelector("[data-theme-value]") : null;

  // Icônes de la brique dans les emplacements du markup statique.
  renderIconSlots(root, doc);

  /** Menu ouvert (`null` = tout fermé). */
  let openName = null;

  /** Libellé du thème courant (famille + mode), jamais vide. */
  function themeSummary() {
    let summary = "";
    if (typeof getThemeSummary === "function") {
      try {
        summary = String(getThemeSummary() ?? "");
      } catch {
        summary = "";
      }
    }
    return summary;
  }

  /** Reflète le thème courant dans l'entrée « Thème » du menu Config. */
  function refreshTheme() {
    if (!themeButton) return;
    const summary = themeSummary();
    if (themeValue) themeValue.textContent = summary;
    const label = summary ? `Thème : ${summary}. Changer de mode clair/sombre.` : "Changer de thème";
    themeButton.setAttribute("aria-label", label);
    themeButton.title = label;
  }

  /** Place le calque SOUS la barre (la hauteur restante lui est donnée). */
  function placeLayer() {
    const rect = root.getBoundingClientRect();
    const top = Math.max(0, Math.round(rect.bottom));
    layer.style.top = `${top}px`;
    // Filet de sécurité : si le calque n'a pas de `bottom: 0` (thème exotique),
    // il ne doit jamais dépasser le bas de la fenêtre.
    const viewport = typeof win.innerHeight === "number" ? win.innerHeight : top;
    layer.style.maxHeight = `${Math.max(0, Math.round(viewport - top))}px`;
  }

  /** Ouvre (ou bascule) le menu `name`. */
  function open(name) {
    if (!buttons.has(name) || !panels.has(name)) return;
    if (!isMobileViewport(win)) return; // dessin bureau : la barre n'existe pas
    if (openName === name) {
      close();
      return;
    }
    close();
    openName = name;
    layer.hidden = false;
    placeLayer();
    for (const [section, button] of buttons) {
      const active = section === name;
      button.setAttribute("aria-expanded", active ? "true" : "false");
      button.classList.toggle("mnav__btn--open", active);
    }
    for (const [section, panel] of panels) {
      panel.hidden = section !== name;
    }
    if (name === "config") refreshTheme();
    const panel = panels.get(name);
    if (panel && typeof panel.focus === "function") {
      try {
        panel.focus({ preventScroll: true });
      } catch {
        // Navigateur sans options de focus : sans focus, rien ne casse.
      }
    }
  }

  /** Ferme le menu ouvert (sans effet s'il n'y en a pas). */
  function close() {
    if (openName === null && layer.hidden) return;
    openName = null;
    layer.hidden = true;
    // Aucun style résiduel au repos (CSP : pas d'attribut `style` permanent).
    layer.removeAttribute("style");
    for (const panel of panels.values()) panel.hidden = true;
    for (const button of buttons.values()) {
      button.setAttribute("aria-expanded", "false");
      button.classList.remove("mnav__btn--open");
    }
  }

  function toggle(name) {
    if (openName === name) close();
    else open(name);
  }

  // ─── Câblage ─────────────────────────────────────────────────────────────
  for (const [section, button] of buttons) {
    button.addEventListener("click", () => toggle(section));
  }

  // Le calque EST le fond assombri : un toucher à côté du panneau ferme.
  layer.addEventListener("click", (event) => {
    if (event.target === layer) close();
  });

  // Un lien du menu (config, /config#agents, gérer les agents…) navigue : on
  // referme pour que le retour à la page de discussion reparte proprement.
  layer.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (target) close();
  });

  if (newButton) {
    newButton.addEventListener("click", () => {
      close();
      if (typeof onNew === "function") onNew();
    });
  }

  if (themeButton) {
    themeButton.addEventListener("click", () => {
      if (typeof onToggleTheme === "function") onToggleTheme();
      refreshTheme();
    });
    refreshTheme();
  }

  const onKeyDown = (event) => {
    if (event.key === "Escape") close();
  };
  doc.addEventListener("keydown", onKeyDown);
  // Redimensionnement / rotation : la position du calque dépend de la barre.
  win.addEventListener("resize", close);

  return {
    open,
    close,
    toggle,
    isOpen: () => openName !== null,
    current: () => openName,
    refreshTheme,
  };
}
