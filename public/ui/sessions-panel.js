// Yuki — panneau des conversations (barre latérale).
//
// Composant autonome, monté par id (`#sessions-sidebar`) depuis `app.js`.
// Rendu PUREMENT DOM (aucune injection HTML directe), aucune ressource externe,
// aucun style en ligne STATIQUE (CSP `style-src 'self'`). Les seuls styles posés
// par le JS sont la POSITION du menu contextuel flottant (`position: fixed`),
// via l'API CSSOM — le projet l'utilise déjà pour l'auto-croissance du champ de
// saisie (voir `app.js`), et la CSP ne s'applique pas aux mutations CSSOM.
//
// Actions : clic pour BASCULER, CLIC DROIT pour le menu contextuel
// (épingler / renommer / supprimer). PAS de bouton « trois points » (choix
// utilisateur explicite). La suppression passe par `HolafModal` (jamais de
// confirmation NATIVE du navigateur) et MET DE CÔTÉ.
//
// Le panneau peut recevoir un élément `footer` (encart agents) monté SOUS la
// liste, dans la même colonne interne : il profite du repli/dépli de la barre.

import { HolafModal } from "./vendor/holaf/holaf-modal.js";

// Mode CSS externe : le CSS de la brique est servi par la page (CSP stricte,
// pas de <style> injecté). Le pont `window.HolafModal` laisse `theme.js`
// accorder le thème de la modale avec celui de la page.
HolafModal.configure({ injectStyles: false });
if (typeof window !== "undefined") {
  window.HolafModal = HolafModal;
}

/** Repli d'affichage quand aucune conversation n'a de titre exploitable. */
export const UNTITLED = "Conversation sans titre";

/** Longueur maximale d'un titre dérivé des premiers mots d'un message. */
const MAX_TITLE_CHARS = 60;

/** Normalise un titre sur une seule ligne (espaces compactés, bornes retirées). */
export function normalizeTitle(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Titre d'affichage PRÊT À L'EMPLOI : titre serveur, sinon extrait, sinon
 * repli honnête (« Conversation sans titre »). Jamais vide.
 */
export function conversationTitle(info) {
  const title = normalizeTitle(info?.title);
  if (title) return title;
  const excerpt = normalizeTitle(info?.excerpt);
  if (excerpt) {
    return excerpt.length <= MAX_TITLE_CHARS
      ? excerpt
      : `${excerpt.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
  }
  return UNTITLED;
}

/** `true` si `title` est déjà porté par une AUTRE conversation (doublon refusé). */
export function isDuplicateTitle(title, sessions, excludeId) {
  const needle = normalizeTitle(title).toLowerCase();
  if (!needle) return false;
  return (Array.isArray(sessions) ? sessions : []).some(
    (info) =>
      info &&
      info.id !== excludeId &&
      conversationTitle(info).toLowerCase() === needle,
  );
}

/** Nombre de messages, au pluriel correct, jamais négatif. */
export function formatMessageCount(count) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return `${n} message${n > 1 ? "s" : ""}`;
}

/** Initiales (1–2 lettres) dérivées du titre, pour la pastille du rail. */
export function initialsFor(title) {
  const words = String(title ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0].slice(0, 1);
  const second = words.length > 1 ? words[1].slice(0, 1) : "";
  return `${first}${second}`.toUpperCase();
}

/** Date courte localisée (« 8 oct. »), chaîne vide si inconnue/illisible. */
export function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      day: "numeric",
      month: "short",
    }).format(date);
  } catch {
    return "";
  }
}

/** `createElement` + attributs, sans aucune injection HTML directe. */
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
 * Monte le panneau des conversations dans `root` (`<aside>`).
 *
 * @param {object} deps
 * @param {HTMLElement} deps.root       le `<aside>` à remplir.
 * @param {(id: string) => void} deps.onSwitch
 * @param {() => void} deps.onNew
 * @param {(id: string, title: string) => void} deps.onRename
 * @param {(id: string) => void} deps.onSetAside
 * @param {(id: string, pinned: boolean) => void} deps.onPin
 * @param {HTMLElement} [deps.footer] encart fixe en bas de la barre (agents).
 * @returns {{ update(sessions: unknown, activeId: unknown): void, closeMenu(): void }}
 */
export function initSessionsPanel(deps) {
  const root = deps.root;
  if (!root) throw new Error("initSessionsPanel : racine absente");
  const modal = deps.HolafModal ?? HolafModal;
  const onSwitch = deps.onSwitch ?? (() => undefined);
  const onNew = deps.onNew ?? (() => undefined);
  const onRename = deps.onRename ?? (() => undefined);
  const onSetAside = deps.onSetAside ?? (() => undefined);
  const onPin = deps.onPin ?? (() => undefined);

  let sessions = [];
  let activeId = null;
  let pinned = false;
  let menuTargetId = null;
  let pinItem = null;

  // ─── Squelette ──────────────────────────────────────────────────────────
  const inner = el("div", { class: "sidebar__inner" });

  const top = el("div", { class: "sidebar__top" });
  const title = el("span", { class: "sidebar__title" }, "Conversations");
  const pin = el("button", {
    class: "sidebar__pin",
    type: "button",
    title: "Épingler la barre (rester dépliée)",
    "aria-label": "Épingler la barre latérale",
    "aria-pressed": "false",
    "aria-expanded": "false",
  });
  pin.appendChild(el("span", { "aria-hidden": "true" }, "📌"));
  top.append(title, pin);

  const newBtn = el("button", {
    class: "sidebar__new",
    type: "button",
    title: "Nouvelle conversation",
  });
  newBtn.append(
    el("span", { class: "sidebar__newplus", "aria-hidden": "true" }, "+"),
    el("span", { class: "sidebar__newlabel" }, "Nouvelle conversation"),
  );

  const list = el("nav", {
    class: "sidebar__list",
    "aria-label": "Liste des conversations",
  });

  inner.append(top, newBtn, list);
  // Encart FIXE en bas de la barre (agents), fourni par l'appelant : monté DANS
  // la colonne interne pour profiter du repli/dépli et rester lisible en rail.
  if (deps.footer instanceof Node) inner.append(deps.footer);
  root.replaceChildren(inner);

  // ─── Menu contextuel (clic droit) ───────────────────────────────────────
  const menu = el("div", { class: "ctx-menu", role: "menu" });
  menu.hidden = true;
  document.body.appendChild(menu);

  function closeMenu() {
    if (menu.hidden && menuTargetId === null) return;
    menu.hidden = true;
    menuTargetId = null;
    // Retire l'attribut de position (aucun `style` résiduel au repos, CSP).
    menu.removeAttribute("style");
  }

  function openMenu(id, anchor) {
    menuTargetId = id;
    // Le libellé de l'action d'épinglage BASCULE selon l'état courant de la
    // conversation ciblée (Épingler / Désépingler).
    if (pinItem) {
      const current = sessions.find((info) => info.id === id);
      const isPinned = Boolean(current && current.pinned);
      pinItem.textContent = isPinned ? "Désépingler" : "Épingler";
      pinItem.setAttribute(
        "aria-label",
        isPinned ? "Désépingler la conversation" : "Épingler la conversation",
      );
    }
    menu.hidden = false;
    // Position CSSOM : `position: fixed` échappe au recadrage de la barre
    // latérale (aucun ancêtre `transform`). Jamais de `style=` dans le markup.
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth || 200;
    const height = menu.offsetHeight || 128;
    let left = rect.left + 8;
    let top = rect.bottom + 4;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - width - 8);
    }
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - height - 4);
    }
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function buildMenu() {
    pinItem = el(
      "button",
      { class: "ctx-menu__item", type: "button", role: "menuitem" },
      "Épingler",
    );
    pinItem.addEventListener("click", () => {
      const id = menuTargetId;
      closeMenu();
      if (!id) return;
      const current = sessions.find((info) => info.id === id);
      onPin(id, !(current && current.pinned));
    });

    const rename = el(
      "button",
      { class: "ctx-menu__item", type: "button", role: "menuitem" },
      "Renommer",
    );
    rename.addEventListener("click", () => {
      const id = menuTargetId;
      closeMenu();
      if (id) void promptRename(id);
    });

    // Place RÉSERVÉE pour le titre généré par le modèle (lot suivant) :
    // affiché DÉSACTIVÉ pour l'annoncer sans promettre ce qui n'existe pas.
    const genTitle = el(
      "button",
      { class: "ctx-menu__item", type: "button", role: "menuitem" },
      "Titre généré par le modèle",
    );
    genTitle.disabled = true;
    genTitle.title = "Bientôt disponible (lot suivant).";

    const del = el(
      "button",
      {
        class: "ctx-menu__item ctx-menu__item--danger",
        type: "button",
        role: "menuitem",
      },
      "Supprimer",
    );
    del.addEventListener("click", () => {
      const id = menuTargetId;
      closeMenu();
      if (id) void confirmSetAside(id);
    });

    menu.append(
      pinItem,
      rename,
      genTitle,
      el("div", { class: "ctx-menu__sep", role: "separator" }),
      del,
    );
  }
  buildMenu();

  // ─── Renommer / supprimer ────────────────────────────────────────────────
  async function promptRename(id) {
    const current = sessions.find((info) => info.id === id);
    const currentTitle = current ? conversationTitle(current) : "";
    const answer = await modal.prompt(
      "Renommer la conversation",
      "Nouveau titre (laisser vide = titre automatique d'après le premier message) :",
      {
        initial: currentTitle === UNTITLED ? "" : currentTitle,
        okText: "Renommer",
        cancelText: "Annuler",
      },
    );
    if (answer === null) return;
    const normalized = normalizeTitle(answer);
    if (normalized && isDuplicateTitle(normalized, sessions, id)) {
      await modal.alert(
        "Renommage refusé",
        `« ${normalized} » est déjà utilisé par une autre conversation. Choisissez un autre titre.`,
        { okText: "Compris" },
      );
      return;
    }
    onRename(id, normalized);
  }

  async function confirmSetAside(id) {
    const current = sessions.find((info) => info.id === id);
    const label = current ? conversationTitle(current) : "cette conversation";
    const confirmed = await modal.confirm(
      "Supprimer cette conversation ?",
      `« ${label} » sera MISE DE CÔTÉ : déplacée dans « conversations-supprimees/<horodatage>/ », pas détruite. Elle reste récupérable à la main. Si c'est la conversation ouverte, l'écran revient à l'état vide (ce n'est pas une erreur).`,
      { danger: true, confirmText: "Mettre de côté", cancelText: "Annuler" },
    );
    if (confirmed) onSetAside(id);
  }

  // ─── Épinglage ───────────────────────────────────────────────────────────
  function setPinned(value) {
    pinned = Boolean(value);
    if (pinned) root.setAttribute("data-pinned", "true");
    else root.removeAttribute("data-pinned");
    pin.setAttribute("aria-pressed", pinned ? "true" : "false");
    pin.setAttribute("aria-expanded", pinned ? "true" : "false");
    pin.title = pinned
      ? "Désépingler (revenir au survol)"
      : "Épingler la barre (rester dépliée)";
  }
  pin.addEventListener("click", () => setPinned(!pinned));
  newBtn.addEventListener("click", () => onNew());

  // ─── Rendu de la liste ───────────────────────────────────────────────────
  function renderItem(info) {
    const active = info.id === activeId;
    const isPinned = Boolean(info.pinned);
    const item = el("div", {
      class: `conv${active ? " conv--active" : ""}${isPinned ? " conv--pinned" : ""}`,
      role: "button",
      tabindex: "0",
      "data-id": info.id,
    });
    if (active) item.setAttribute("aria-current", "true");
    if (isPinned) item.setAttribute("data-pinned", "true");
    // Indicateur VISUEL discret : un 📌 (la seule position en tête ne suffirait
    // pas à faire comprendre pourquoi la conversation est remontée).
    if (isPinned) {
      const mark = el("span", { class: "conv__pin", "aria-hidden": "true" }, "📌");
      mark.title = "Conversation épinglée";
      item.appendChild(mark);
    }
    item.appendChild(
      el(
        "span",
        { class: "conv__av", "aria-hidden": "true" },
        initialsFor(conversationTitle(info)),
      ),
    );
    const main = el("span", { class: "conv__main" });
    main.append(
      el("span", { class: "conv__title" }, conversationTitle(info)),
      el(
        "span",
        { class: "conv__meta" },
        [formatDate(info.updatedAt), formatMessageCount(info.messageCount)]
          .filter(Boolean)
          .join(" · "),
      ),
    );
    item.appendChild(main);

    item.addEventListener("click", () => onSwitch(info.id));
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onSwitch(info.id);
      } else if (
        event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10")
      ) {
        event.preventDefault();
        openMenu(info.id, item);
      }
    });
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openMenu(info.id, item);
    });
    return item;
  }

  function render() {
    list.replaceChildren();
    for (const info of sessions) {
      if (info && typeof info.id === "string") list.appendChild(renderItem(info));
    }
  }

  // Fermeture du menu hors clic / Échap / défilement / redimensionnement.
  document.addEventListener("click", (event) => {
    if (menu.hidden) return;
    if (!menu.contains(event.target)) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
  window.addEventListener("resize", closeMenu);
  if (typeof root.addEventListener === "function") {
    root.addEventListener("scroll", closeMenu, true);
  }

  return {
    update(nextSessions, nextActiveId) {
      sessions = Array.isArray(nextSessions) ? nextSessions : [];
      activeId = typeof nextActiveId === "string" ? nextActiveId : null;
      closeMenu();
      render();
    },
    closeMenu,
  };
}
