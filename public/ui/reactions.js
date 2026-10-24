// Yuki — RÉACTIONS aux messages de Yuki (« petit bouton en bas à droite »).
//
// L'utilisateur pose une réaction sur UN message de Yuki. Ce n'est PAS un
// message : le serveur la persiste À PART (volume `state`), la rediffuse aux
// onglets de la conversation et l'injecte au modèle au tour SUIVANT — sans
// jamais déclencher de réponse, et sans jamais la faire prononcer par la voix.
//
// ⚠️ TROIS SECTIONS TITRÉES dans UN SEUL menu (décision utilisateur) :
//   ① jugement technique (qualité de la réponse) ⇒ Yuki corrige son COMPORTEMENT ;
//   ② réaction émotionnelle (contenu, registre casual) ⇒ Yuki ajuste son REGISTRE ;
//   ③ humeur (sur l'utilisateur, pas sur le message) ⇒ Yuki module son TON.
// Chaque entrée porte son LIBELLÉ **et** une MINI-EXPLICATION, pour que
// l'utilisateur ne se trompe pas de registre.
//
// ⚠️ CORRÉLATION : la réaction est rattachée à l'identifiant STABLE du message
// (`entryId`, l'entrée de session — le même que les statistiques utilisent via
// `parentId`). Aucun identifiant n'est inventé côté navigateur : il vient du
// serveur (`snapshot` et trame `run_finished`).
//
// ⚠️ CSP stricte : aucun `innerHTML`, aucun style en ligne STATIQUE. La seule
// mutation CSSOM est la POSITION du menu flottant (`left`/`top`), comme le menu
// contextuel des conversations et la fenêtre de validation.

import { iconNode } from "./icons.js";

/**
 * Catalogue des réactions — MIROIR de `src/reactions/types.ts`.
 * ⚠️ Un test (`tests/ui/reactions.test.ts`) compare les DEUX listes, identifiant
 * par identifiant, libellé par libellé : toute divergence casse la suite.
 */
export const REACTION_GROUPS = [
  {
    id: "judgement",
    title: "Jugement technique",
    meaning: "sur la QUALITÉ de la réponse ⇒ corrige le COMPORTEMENT",
  },
  {
    id: "emotion",
    title: "Réaction émotionnelle",
    meaning: "sur le CONTENU (registre casual) ⇒ informe sur le REGISTRE",
  },
  {
    id: "mood",
    title: "Humeur",
    meaning: "sur MOI, pas sur le message ⇒ module le TON",
  },
];

export const REACTIONS = [
  { id: "utile", group: "judgement", emoji: "👍", label: "Utile", hint: "La réponse était ce qu'il fallait." },
  { id: "a-cote", group: "judgement", emoji: "👎", label: "À côté", hint: "La réponse ne répond pas à la question posée." },
  { id: "trop-long", group: "judgement", emoji: "🐢", label: "Trop long", hint: "Trop de texte pour ce qui était demandé." },
  { id: "trop-bavard", group: "judgement", emoji: "⚡", label: "Trop bavard", hint: "Trop de détails, de relances ou de remplissage." },
  { id: "incompris", group: "judgement", emoji: "❓", label: "Incompris", hint: "La demande n'a pas été comprise." },
  { id: "faux", group: "judgement", emoji: "⚠️", label: "Faux", hint: "Une affirmation de la réponse est fausse." },
  { id: "rire", group: "emotion", emoji: "😄", label: "Ça me fait rire", hint: "Ça m'a amusé — un ressenti, pas un avis sur la qualité." },
  { id: "touche", group: "emotion", emoji: "😢", label: "Ça me touche", hint: "Ça m'a ému." },
  { id: "reflexion", group: "emotion", emoji: "🤔", label: "Ça me fait réfléchir", hint: "Ça m'a donné à penser." },
  { id: "indifferent", group: "emotion", emoji: "😐", label: "Ça me laisse indifférent", hint: "Ni plus ni moins : neutre." },
  { id: "bien", group: "mood", emoji: "🙂", label: "Je vais bien", hint: "Mon humeur du moment, pas ton message." },
  { id: "fatigue", group: "mood", emoji: "😴", label: "Fatigué", hint: "Allège le rythme et la longueur." },
  { id: "agace", group: "mood", emoji: "😤", label: "Agacé", hint: "Ton plus direct, moins d'entrain." },
  { id: "content", group: "mood", emoji: "🎉", label: "Content", hint: "Ton enthousiaste bienvenu." },
];

const REACTION_BY_ID = new Map(REACTIONS.map((item) => [item.id, item]));

/** Définition d'une réaction connue, ou `undefined`. */
export function reactionById(id) {
  return typeof id === "string" ? REACTION_BY_ID.get(id) : undefined;
}

/**
 * Pictogramme de la réaction choisie (`""` si aucune) — c'est ce qui reste
 * affiché, discrètement, sur le message une fois la réaction posée.
 */
export function reactionEmoji(id) {
  const def = reactionById(id);
  return def ? def.emoji : "";
}

/** Nom accessible complet d'une réaction (« 😄 Ça me fait rire »). */
export function reactionName(id) {
  const def = reactionById(id);
  return def ? `${def.emoji} ${def.label}` : "";
}

/** Marge (px) conservée entre le menu et le bord de la fenêtre. */
export const MENU_MARGIN_PX = 8;

/**
 * Place le menu flottant par rapport au bouton, en le faisant basculer VERS LE
 * HAUT quand il n'y a pas la place en dessous (dernier message, petit écran).
 *
 * Fonction PURE (testable sans DOM) : elle ne connaît que des rectangles.
 *
 * @param {{left: number, top: number, bottom: number, right: number}} anchor
 *   rectangle du bouton (coordonnées écran).
 * @param {{width: number, height: number}} size taille du menu.
 * @param {{width: number, height: number}} viewport taille de la fenêtre.
 * @param {number} [margin]
 * @returns {{left: number, top: number, flippedUp: boolean}}
 */
export function menuPlacement(anchor, size, viewport, margin = MENU_MARGIN_PX) {
  const width = Math.max(0, Number(size && size.width) || 0);
  const height = Math.max(0, Number(size && size.height) || 0);
  const viewWidth = Math.max(0, Number(viewport && viewport.width) || 0);
  const viewHeight = Math.max(0, Number(viewport && viewport.height) || 0);
  // Horizontal : le bord DROIT du menu s'aligne sur celui du bouton (le bouton
  // est en bas à DROITE du message), puis on ramène dans la fenêtre si besoin.
  let left = (anchor ? anchor.right : 0) - width;
  if (left < margin) left = margin;
  if (left + width > viewWidth - margin) {
    left = Math.max(margin, viewWidth - width - margin);
  }
  // Vertical : d'abord SOUS le bouton ; si ça dépasse, AU-DESSUS.
  const anchorTop = anchor ? anchor.top : 0;
  const below = (anchor ? anchor.bottom : 0) + 4;
  const above = anchorTop - height - 4;
  let flippedUp = false;
  let top = below;
  if (below + height > viewHeight - margin) {
    if (above >= margin) {
      flippedUp = true;
      top = above;
    } else {
      // Ni dessous ni dessus : on choisit le côté qui a le PLUS de place, puis
      // on ramène dans la fenêtre (le menu défile si la place manque vraiment).
      const roomAbove = anchorTop - margin;
      const roomBelow = viewHeight - margin - below;
      top =
        roomAbove > roomBelow
          ? margin
          : Math.max(margin, viewHeight - height - margin);
    }
  }
  return { left: Math.round(left), top: Math.round(top), flippedUp };
}

/** Élément DOM minimal (aucun `innerHTML`, aucun style en ligne). */
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  if (typeof text === "string") node.textContent = text;
  return node;
}

/**
 * Contrôle de réaction : UN bouton par message assistant + UN menu partagé.
 *
 * @param {object} deps
 * @param {(entryId: string, reaction: string|null) => void} deps.onChange
 *   appelé au clic (`null` = retirer la réaction).
 */
export function createReactionControl(deps = {}) {
  const onChange = typeof deps.onChange === "function" ? deps.onChange : () => {};
  /** Bulle → son bouton (état d'affichage tenu à part du DOM du fil). */
  const buttons = new Map();
  /** Menu partagé, créé à la PREMIÈRE ouverture (aucun nœud au chargement). */
  let menu = null;
  let menuTarget = null;
  let menuAnchor = null;
  let removeItem = null;
  let removeSeparator = null;

  function closeMenu() {
    if (!menu) return;
    if (menu.hidden && menuTarget === null) return;
    menu.hidden = true;
    menu.removeAttribute("style");
    if (menuAnchor) {
      menuAnchor.setAttribute("aria-expanded", "false");
      menuAnchor = null;
    }
    menuTarget = null;
  }

  /** Construit le menu UNE fois : trois sections titrées, libellé + explication. */
  function buildMenu() {
    menu = el("div", { class: "ctx-menu ctx-menu--reactions", role: "menu" });
    // RETRAIT en TÊTE (visible seulement si une réaction est posée) : le menu
    // peut DÉFILER sur un petit écran, une action cachée en bas obligerait à
    // chercher — donc on la met là où elle est toujours atteignable.
    removeItem = el(
      "button",
      {
        class: "ctx-menu__item ctx-menu__item--danger reaction-item--remove",
        type: "button",
        role: "menuitem",
      },
      "Retirer la réaction",
    );
    removeItem.addEventListener("click", () => {
      const target = menuTarget;
      closeMenu();
      if (target) onChange(target.entryId, null);
    });
    menu.appendChild(removeItem);
    removeSeparator = el("div", { class: "ctx-menu__sep" });
    menu.appendChild(removeSeparator);
    for (const group of REACTION_GROUPS) {
      const title = el("div", { class: "ctx-menu__label" }, group.title);
      title.setAttribute("title", group.meaning);
      menu.appendChild(title);
      for (const def of REACTIONS.filter((item) => item.group === group.id)) {
        const item = el("button", {
          class: "ctx-menu__item ctx-menu__item--radio reaction-item",
          type: "button",
          role: "menuitemradio",
          "aria-checked": "false",
          "data-reaction": def.id,
        });
        const emoji = el("span", { class: "reaction-item__emoji", "aria-hidden": "true" }, def.emoji);
        const col = el("span", { class: "ctx-menu__col" });
        col.appendChild(el("span", { class: "ctx-menu__text" }, def.label));
        col.appendChild(el("span", { class: "ctx-menu__hint" }, def.hint));
        item.appendChild(emoji);
        item.appendChild(col);
        item.addEventListener("click", () => {
          const target = menuTarget;
          closeMenu();
          if (!target) return;
          // Re-cliquer la réaction DÉJÀ posée la retire (geste réversible, sans
          // menu supplémentaire).
          const next = target.reaction === def.id ? null : def.id;
          onChange(target.entryId, next);
        });
        menu.appendChild(item);
      }
    }
    menu.hidden = true;
    document.body.appendChild(menu);
  }

  /** Reflète l'état `aria-checked` / le bouton « Retirer » avant d'ouvrir. */
  function syncMenu(current) {
    if (!menu) return;
    for (const item of menu.querySelectorAll(".reaction-item[data-reaction]")) {
      const id = item.getAttribute("data-reaction");
      item.setAttribute("aria-checked", id === current ? "true" : "false");
    }
    if (removeItem) removeItem.hidden = current === null;
    if (removeSeparator) removeSeparator.hidden = current === null;
  }

  function positionMenu(anchor) {
    const rect = anchor.getBoundingClientRect();
    const placement = menuPlacement(
      { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      { width: menu.offsetWidth || 260, height: menu.offsetHeight || 320 },
      { width: window.innerWidth, height: window.innerHeight },
    );
    menu.style.left = `${placement.left}px`;
    menu.style.top = `${placement.top}px`;
  }

  /** État d'affichage porté par un bouton (les bulles sont les clés du map). */
  function stateOfButton(button) {
    for (const state of buttons.values()) {
      if (state.button === button) return state;
    }
    return null;
  }

  function openMenu(button) {
    if (!menu) buildMenu();
    const state = stateOfButton(button);
    if (!state || !state.entryId) return;
    closeMenu();
    syncMenu(state.reaction);
    menu.hidden = false;
    menuTarget = state;
    menuAnchor = button;
    button.setAttribute("aria-expanded", "true");
    positionMenu(button);
    const first = menu.querySelector('.reaction-item[aria-checked="true"]');
    const target = first || menu.querySelector(".reaction-item");
    if (target && typeof target.focus === "function") target.focus();
  }

  // Un clic hors du menu (et hors du bouton) referme ; Échap aussi.
  const onDocumentPointerDown = (event) => {
    if (!menu || menu.hidden) return;
    const target = event.target;
    if (target === menuAnchor || (menuAnchor && menuAnchor.contains(target))) return;
    if (target instanceof Node && menu.contains(target)) return;
    closeMenu();
  };
  const onDocumentKeyDown = (event) => {
    if (event.key === "Escape") closeMenu();
  };
  document.addEventListener("pointerdown", onDocumentPointerDown, true);
  document.addEventListener("keydown", onDocumentKeyDown);

  /**
   * Monte (ou met à jour) le bouton d'un message assistant.
   *
   * @param {HTMLElement} element la bulle (`.message--assistant`).
   * @param {object} [options]
   * @param {string|null} [options.entryId] identifiant du message (serveur).
   * @param {string|null} [options.reaction] réaction courante.
   */
  function attach(element, options = {}) {
    if (!element) return null;
    const entryId = typeof options.entryId === "string" && options.entryId.length > 0
      ? options.entryId
      : null;
    const reaction = reactionById(options.reaction) ? options.reaction : null;
    let state = buttons.get(element);
    if (!state) {
      const holder = el("div", { class: "message__react" });
      const button = el("button", {
        class: "message__react-btn",
        type: "button",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (menuAnchor === button && menu && !menu.hidden) {
          closeMenu();
          return;
        }
        openMenu(button);
      });
      holder.appendChild(button);
      element.appendChild(holder);
      state = { holder, button, entryId: null, reaction: null };
      buttons.set(element, state);
    }
    state.entryId = entryId;
    state.reaction = reaction;
    render(state);
    return state.holder;
  }

  /** Peint le bouton : pictogramme de la réaction posée, sinon l'icône neutre. */
  function render(state) {
    const { button, reaction } = state;
    if (!state.entryId) {
      // Message non encore persisté par le serveur (flux en cours) : aucune
      // action possible, donc aucun bouton visible.
      state.holder.hidden = true;
      return;
    }
    state.holder.hidden = false;
    const label = reaction ? reactionName(reaction) : "";
    button.textContent = "";
    if (reaction) {
      button.textContent = reactionEmoji(reaction);
      button.classList.add("message__react-btn--set");
      button.setAttribute(
        "aria-label",
        `Votre réaction : ${label}. Cliquer pour changer ou retirer.`,
      );
      button.setAttribute("title", `Votre réaction : ${label}`);
    } else {
      const icon = iconNode("sparkles", "icon");
      if (icon) button.appendChild(icon);
      button.classList.remove("message__react-btn--set");
      button.setAttribute("aria-label", "Réagir à ce message");
      button.setAttribute("title", "Réagir à ce message");
    }
    button.setAttribute("aria-expanded", menuAnchor === button && menu && !menu.hidden ? "true" : "false");
  }

  /** Cherche le bouton d'un message par identifiant (trame `reaction`). */
  function buttonFor(entryId) {
    for (const state of buttons.values()) {
      if (state.entryId === entryId) return state;
    }
    return null;
  }

  /**
   * Applique une trame `reaction` (état vivant) : la réaction s'affiche sur le
   * message VISÉ, et nulle part ailleurs.
   */
  function apply(frame) {
    if (!frame || frame.type !== "reaction") return;
    const state = buttonFor(frame.entryId);
    if (!state) return;
    state.reaction = reactionById(frame.reaction) ? frame.reaction : null;
    render(state);
    if (menuTarget === state) syncMenu(state.reaction);
  }

  /** Purge les références (reconstruction du fil, bascule de conversation). */
  function reset() {
    closeMenu();
    buttons.clear();
  }

  return { attach, apply, reset, closeMenu };
}
