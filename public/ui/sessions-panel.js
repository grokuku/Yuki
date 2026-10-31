// Yuki — panneau des conversations (barre latérale + menu téléphone).
//
// Composant autonome, monté par id (`#sessions-sidebar`) depuis `app.js`.
// Rendu PUREMENT DOM (aucune injection HTML directe), aucune ressource externe,
// aucun style en ligne STATIQUE (CSP `style-src 'self'`). Les seuls styles posés
// par le JS sont la POSITION du menu contextuel flottant (`position: fixed`),
// via l'API CSSOM — le projet l'utilise déjà pour l'auto-croissance du champ de
// saisie (voir `app.js`), et la CSP ne s'applique pas aux mutations CSSOM.
//
// Actions : clic pour BASCULER, CLIC DROIT (ou APPUI LONG au doigt) pour le
// menu contextuel du TITRE (épingler / renommer / mettre de côté / conversation
// dédiée…). PAS de bouton « trois points » (choix utilisateur explicite). La
// mise de côté passe par `HolafModal` (jamais de confirmation NATIVE du
// navigateur).
//
// ⚠️ Le MÊME composant rend AUSSI la liste du menu téléphone (`extraLists`) :
// mêmes données, mêmes indicateurs (non lu, en cours, actif, épinglées), même
// menu contextuel — aucun second panneau à maintenir.
//
// Le panneau peut recevoir un élément `footer` (encart agents) monté SOUS la
// liste, dans la même colonne interne : il profite du repli/dépli de la barre.
//
// Repli/dépli de la barre : UN SEUL bouton (`.sidebar__toggle`) décide de
// l'état — plus d'ouverture au SURVOL ni de PUNAISE. L'état déplié est persisté
// en `localStorage` (`yuki-sidebar-expanded`) pour survivre au rechargement.
// L'ICÔNE (chevrons) vient de la brique `holaf-icons`, convertie en nœud DOM
// via `DOMParser` (aucune injection HTML directe).

import { HolafModal } from "./vendor/holaf/holaf-modal.js";
import { HolafIcons } from "./vendor/holaf/holaf-icons.js";
import { attachLongPress } from "./long-press.js";
import {
  composeConversationLabel,
  formatUnreadBadge,
  normalizeCount,
} from "./unread.js";

// Mode CSS externe : le CSS de la brique est servi par la page (CSP stricte,
// pas de <style> injecté). Le pont `window.HolafModal` laisse `theme.js`
// accorder le thème de la modale avec celui de la page.
HolafModal.configure({ injectStyles: false });
if (typeof window !== "undefined") {
  window.HolafModal = HolafModal;
}

/** Repli d'affichage quand aucune conversation n'a de titre exploitable. */
export const UNTITLED = "Conversation sans titre";

/**
 * Libellé de l'entrée « conversation dédiée » du MENU DU TITRE.
 * ⚠️ C'est désormais le SEUL déclencheur (il n'y a plus de bouton dans le
 * composeur, ni sur téléphone ni sur bureau). Le parcours lui-même reste
 * `recap-dedicated.js` : on ne fait que le rebrancher.
 */
export const RECAP_MENU_LABEL = "Conversation dédiée…";

/**
 * Libellé de l'entrée « compacter » du MENU DU TITRE : force une compression du
 * fil, précédée d'une passe de remplissage de mémoire (côté serveur).
 */
export const COMPACT_MENU_LABEL = "Compacter…";

/**
 * Libellé de l'entrée « supprimer » du MENU DU TITRE — action DÉFINITIVE.
 * ⚠️ Court comme « Mettre de côté » (les deux ne se confondent pas), mais la
 * CONFIRMATION, elle, nomme la conversation et dit l'irréversibilité.
 * ⚠️ Elle ne concerne que les conversations de la LISTE (les mises de côté en
 * sortent : elles n'y sont plus, donc pas supprimables ici).
 */
export const DELETE_MENU_LABEL = "Supprimer";

/**
 * Libellé du CHOIX « supprimer quand même » de la modale de suppression d'un fil
 * qui reçoit des sources (⚠️ les sources, elles, ne sont jamais supprimées).
 */
export const DELETE_WITH_SOURCES_LABEL = "Supprimer quand même";

/**
 * En-tête exigé par les routes des sources (lecture ET écriture) — même garde que
 * `/api/config`. Sert à réaffecter les sources d'un fil avant de le supprimer.
 */
const SOURCES_HEADERS = { "content-type": "application/json", "x-yuki-config": "1" };

/** Longueur maximale d'un titre dérivé des premiers mots d'un message. */
const MAX_TITLE_CHARS = 60;

/** Longueur maximale de l'aperçu du dernier message (menu téléphone). */
const MAX_EXCERPT_CHARS = 90;

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

/**
 * Heure courte pour le menu téléphone : « 14:32 » si la date est AUJOURD'HUI,
 * sinon la date courte (« 8 oct. »). Chaîne vide si inconnue/illisible.
 *
 * @param {string|null|undefined} iso date ISO de dernière activité.
 * @param {Date} [now] instant de référence (injectable pour les tests).
 */
export function formatHour(iso, now = new Date()) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (!sameDay) return formatDate(iso);
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return "";
  }
}

/** Aperçu borné d'un message (jamais un pavé dans la liste). */
export function excerptFor(info, title) {
  const excerpt = normalizeTitle(info?.excerpt);
  if (!excerpt) return "";
  // Un extrait identique au titre n'apprend rien : on ne le répète pas.
  if (excerpt.toLowerCase() === normalizeTitle(title).toLowerCase()) return "";
  return excerpt.length <= MAX_EXCERPT_CHARS
    ? excerpt
    : `${excerpt.slice(0, MAX_EXCERPT_CHARS - 1).trimEnd()}…`;
}

/** Clé `localStorage` de l'état déplié de la barre latérale (`"true"`/`"false"`). */
export const SIDEBAR_EXPANDED_KEY = "yuki-sidebar-expanded";

/**
 * Convertit une icône de la brique `holaf-icons` en nœud SVG DOM.
 * Passe par `DOMParser` (jamais d'injection HTML directe) : la source garde
 * donc sa règle « aucun HTML injecté ». Le SVG provient d'une brique statique
 * et de confiance, et `stroke="currentColor"` le laisse suivre la couleur CSS.
 */
function iconNode(name, className) {
  const svg = HolafIcons.render(name, { class: className });
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  return document.importNode(parsed.documentElement, true);
}

/** État déplié persisté ; replié par défaut, tolérant au stockage indisponible. */
function readExpanded() {
  try {
    return window.localStorage.getItem(SIDEBAR_EXPANDED_KEY) === "true";
  } catch {
    return false;
  }
}

/** Persiste l'état déplié (best-effort : mode privé / quota ignorés). */
function writeExpanded(value) {
  try {
    window.localStorage.setItem(SIDEBAR_EXPANDED_KEY, value ? "true" : "false");
  } catch {
    // Stockage indisponible : l'état reste en mémoire pour la session.
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
 * @param {(id: string) => void} [deps.onDelete] suppression DÉFINITIVE (après la
 *   confirmation qui nomme la conversation).
 * @param {(id: string) => void} [deps.onCompact] compaction forcée (passe de
 *   mémoire puis compression, côté serveur).
 * @param {(id: string, pinned: boolean) => void} deps.onPin
 * @param {(id: string) => void} [deps.onRecapDedicated] entrée « Conversation
 *   dédiée… » du menu du titre (parcours `recap-dedicated.js`).
 * @param {HTMLElement} [deps.footer] encart fixe en bas de la barre (agents).
 * @param {Array<{list: HTMLElement, empty?: HTMLElement}>} [deps.extraLists]
 *   cibles SUPPLÉMENTAIRES (menu téléphone) : même rendu, classe de ligne
 *   `.mnav-conv` (les mesures E2E de la barre latérale restent sans ambiguïté).
 * @returns {{ update(sessions: unknown, activeId: unknown, busyIds?: string[], unread?: Record<string, number>): void, setBusy(ids: string[]): void, setUnread(counts: Record<string, number>): void, closeMenu(): void }}
 */
export function initSessionsPanel(deps) {
  const root = deps.root;
  if (!root) throw new Error("initSessionsPanel : racine absente");
  const modal = deps.HolafModal ?? HolafModal;
  const onSwitch = deps.onSwitch ?? (() => undefined);
  const onNew = deps.onNew ?? (() => undefined);
  const onRename = deps.onRename ?? (() => undefined);
  const onSetAside = deps.onSetAside ?? (() => undefined);
  const onDelete = deps.onDelete ?? (() => undefined);
  const onCompact = deps.onCompact ?? (() => undefined);
  const onPin = deps.onPin ?? (() => undefined);
  const onRecapDedicated = deps.onRecapDedicated ?? (() => undefined);
  /** `fetch` injectable (tests) : la modale de suppression réaffecte les sources. */
  const doFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init));

  let sessions = [];
  let activeId = null;
  // E2 — conversations dont un run d'arrière-plan (ou une tâche de fond) est EN
  // COURS. Rafraîchi par `setBusy` (l'app calcule l'état depuis les trames
  // multiplexées), indépendamment de la conversation focalisée : on VOIT qu'un
  // autre fil travaille et on peut y basculer sans rien perdre.
  let busyIds = new Set();
  // Conversation → compteur de messages NON LUS. Alimenté par l'app depuis les
  // trames de fil (`run_finished`) : le point « en cours » dit qu'une tâche
  // travaille MAINTENANT, ce compteur dit que quelque chose est arrivé sans être
  // vu. Les deux peuvent être vrais EN MÊME TEMPS (pastilles distinctes).
  let unreadCounts = {};
  // État déplié/replié de la barre : replié par défaut, restauré du stockage
  // local (pour rester déplié après un rechargement), décidé par LE BOUTON.
  let expanded = readExpanded();
  let menuTargetId = null;
  let pinItem = null;
  let recapItem = null;
  /** Cibles de rendu : la barre latérale (`rail`) + les menus téléphone (`menu`). */
  const targets = [];

  // ─── Squelette ──────────────────────────────────────────────────────────
  const inner = el("div", { class: "sidebar__inner" });

  const top = el("div", { class: "sidebar__top" });
  // Bouton déplier/replier : placé EN TÊTE, donc visible et cliquable même
  // dans le rail (56 px). L'icône (chevron de la brique) bascule par CSS.
  const toggle = el("button", {
    class: "sidebar__toggle",
    type: "button",
    title: "Déplier la barre latérale",
    "aria-label": "Déplier la barre latérale",
    "aria-controls": "sessions-sidebar",
    "aria-expanded": "false",
  });
  toggle.append(
    iconNode("chevron-right", "icon icon--chevron-right"),
    iconNode("chevron-left", "icon icon--chevron-left"),
  );
  const title = el("span", { class: "sidebar__title" }, "Conversations");
  top.append(toggle, title);

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

  // ─── Cibles de rendu ───────────────────────────────────────────────────
  // La barre latérale (bureau) est rendue EXACTEMENT comme avant ; les cibles
  // supplémentaires (menu téléphone) reçoivent le même contenu, avec les
  // informations en plus (aperçu du dernier message, jour/heure).
  targets.push({ list, empty: null, variant: "rail" });
  for (const extra of Array.isArray(deps.extraLists) ? deps.extraLists : []) {
    if (extra && extra.list instanceof Node) {
      targets.push({
        list: extra.list,
        empty: extra.empty instanceof Node ? extra.empty : null,
        variant: "menu",
      });
    }
  }

  // ─── Menu contextuel (clic droit / appui long) ─────────────────────────
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

  /**
   * Ouvre le menu du TITRE.
   *
   * @param {string} id conversation ciblée.
   * @param {HTMLElement} anchor ancre (ligne de la conversation).
   * @param {{x: number, y: number}} [point] point de l'appui long (tactile).
   *   Sans lui, le menu s'ouvre sous l'ancre (clic droit), comme avant.
   */
  function openMenu(id, anchor, point) {
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
    // « Conversation dédiée… » : TOUJOURS proposée. Le parcours récapitule le
    // fil FOCALISÉ (`recap-dedicated.js`) ; sur une autre conversation,
    // `app.js` l'OUVRE d'abord (`switch`) puis déclenche le parcours dès que le
    // serveur confirme — l'entrée n'est donc jamais une promesse en l'air, et
    // jamais une fonction absente.
    if (recapItem) {
      const isActive = typeof activeId === "string" && id === activeId;
      recapItem.title = isActive
        ? "Récapituler cette conversation et continuer dans un nouveau fil dédié."
        : "Ouvrir cette conversation, puis la récapituler dans un nouveau fil dédié.";
      recapItem.setAttribute("aria-label", RECAP_MENU_LABEL);
    }
    menu.hidden = false;
    // Position CSSOM : `position: fixed` échappe au recadrage de la barre
    // latérale (aucun ancêtre `transform`). Jamais de `style=` dans le markup.
    const rect = anchor.getBoundingClientRect();
    const width = menu.offsetWidth || 200;
    const height = menu.offsetHeight || 128;
    let left = point ? point.x : rect.left + 8;
    let top = point ? point.y : rect.bottom + 4;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - width - 8);
    }
    if (top + height > window.innerHeight - 8) {
      // Appui long : on remonte le menu AU-DESSUS du doigt ; clic droit : on
      // le bascule au-dessus de l'ancre (comportement historique).
      top = point ? Math.max(8, point.y - height) : Math.max(8, rect.top - height - 4);
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

    // « Conversation dédiée… » — EX-déclencheur du composeur, désormais une
    // entrée de CE menu (téléphone ET bureau). Le parcours n'est pas réécrit :
    // `onRecapDedicated` appelle `recapDedicated.open()` (app.js).
    recapItem = el(
      "button",
      { class: "ctx-menu__item", type: "button", role: "menuitem" },
      RECAP_MENU_LABEL,
    );
    recapItem.addEventListener("click", () => {
      const id = menuTargetId;
      closeMenu();
      if (id) onRecapDedicated(id);
    });

    // « Compacter… » — force la compression du fil (le serveur lance d'abord une
    // PASSE DE MÉMOIRE sur la conversation entière). Action non destructive :
    // aucune confirmation, mais une attente VISIBLE gérée par `session-actions.js`.
    const compactItem = el(
      "button",
      { class: "ctx-menu__item", type: "button", role: "menuitem" },
      COMPACT_MENU_LABEL,
    );
    compactItem.title =
      "Remplir la mémoire de cette conversation, puis la compacter (compression du fil).";
    compactItem.setAttribute("aria-label", COMPACT_MENU_LABEL);
    compactItem.addEventListener("click", () => {
      const id = menuTargetId;
      closeMenu();
      if (id) onCompact(id);
    });

    // La mise de côté EST une façon de retirer un fil de la liste, mais elle le
    // DÉPLACE (récupérable). Le libellé le DIT, pour ne pas la confondre avec la
    // suppression définitive ci-dessous.
    const setAside = el(
      "button",
      {
        class: "ctx-menu__item ctx-menu__item--danger",
        type: "button",
        role: "menuitem",
      },
      "Mettre de côté",
    );
    setAside.addEventListener("click", () => {
      const id = menuTargetId;
      closeMenu();
      if (id) void confirmSetAside(id);
    });

    // SUPPRESSION DÉFINITIVE : le serveur sait désormais effacer le fil (`delete`).
    // ⚠️ Action IRRÉVERSIBLE : la confirmation nomme la conversation et dit
    // qu'il n'y a AUCUNE récupération ; jamais un « OK / Annuler » générique.
    const del = el(
      "button",
      {
        class: "ctx-menu__item ctx-menu__item--danger",
        type: "button",
        role: "menuitem",
      },
      DELETE_MENU_LABEL,
    );
    del.addEventListener("click", () => {
      const id = menuTargetId;
      closeMenu();
      if (id) void confirmDelete(id);
    });

    menu.append(
      rename,
      pinItem,
      genTitle,
      el("div", { class: "ctx-menu__sep", role: "separator" }),
      recapItem,
      compactItem,
      el("div", { class: "ctx-menu__sep", role: "separator" }),
      setAside,
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
      `Mettre de côté « ${label} » ?`,
      `« ${label} » sera MISE DE CÔTÉ : déplacée dans « conversations-supprimees/<horodatage>/ », pas détruite. Elle reste récupérable à la main. Si c'est la conversation ouverte, l'écran revient à l'état vide (ce n'est pas une erreur).`,
      { danger: true, confirmText: "Mettre de côté", cancelText: "Annuler" },
    );
    if (confirmed) onSetAside(id);
  }

  /**
   * Confirmation de SUPPRESSION DÉFINITIVE.
   *
   * ⚠️ Le nom de la conversation est DANS la fenêtre (pas un « OK / Annuler »
   * générique), et le texte dit l'irréversibilité ET ce qui n'est PAS touché
   * (la mémoire durable), pour que l'utilisateur sache exactement ce qu'il perd.
   */
  async function confirmDelete(id) {
    const current = sessions.find((info) => info.id === id);
    const label = current ? conversationTitle(current) : "cette conversation";
    // ⚠️ ③ Un fil qui REÇOIT des sources ne se supprime pas comme un autre : la
    // modale LISTE ces sources et exige un CHOIX explicite (aucune suppression
    // silencieuse d'un programme configuré pour y poster).
    const feeding = Array.isArray(current?.sources)
      ? current.sources.filter((nom) => typeof nom === "string" && nom !== "")
      : [];
    if (feeding.length > 0) {
      await confirmDeleteWithSources(id, label, feeding);
      return;
    }
    const confirmed = await modal.confirm(
      `Supprimer définitivement « ${label} » ?`,
      `Cette conversation sera EFFACÉE : c'est DÉFINITIF, aucune récupération possible, aucune corbeille. ` +
        "La mémoire durable n'est PAS touchée : les souvenirs déjà écrits restent." +
        (id === activeId ? " C'est la conversation ouverte : l'écran reviendra à l'état vide." : ""),
      { danger: true, confirmText: "Supprimer définitivement", cancelText: "Annuler" },
    );
    if (confirmed) onDelete(id);
  }

  /**
   * Réaffecte des sources à une autre destination (`PATCH /api/sources/<nom>`).
   * Lève si une requête échoue : l'appelant DIT l'échec et ne supprime rien.
   */
  async function reassignSources(noms, conversation) {
    for (const nom of noms) {
      const response = await doFetch(`/api/sources/${encodeURIComponent(nom)}`, {
        method: "PATCH",
        headers: SOURCES_HEADERS,
        body: JSON.stringify({ conversation }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          data?.message ?? `La source « ${nom} » n'a pas pu être réaffectée (HTTP ${response.status}).`,
        );
      }
    }
  }

  /**
   * Modale de SUPPRESSION d'un fil qui reçoit des sources.
   *
   * Trois choix EXPLICITES (aucun défaut) :
   *  1. rattacher ces sources à un autre fil (liste des autres conversations) ;
   *  2. les passer en « nouvelle conversation à chaque fois » ;
   *  3. supprimer quand même — ⚠️ les sources NE SONT PAS supprimées : le serveur
   *     les réaffecte et écrit une entrée d'alerte dans la boîte.
   */
  const DELETE_SOURCES_FORM = "sources-delete-form";

  async function confirmDeleteWithSources(id, label, noms) {
    const choices = [
      ["nouvelle", "Passer ces sources en « nouvelle conversation à chaque fois »"],
      ["supprimer", DELETE_WITH_SOURCES_LABEL],
    ];
    const targets = sessions.filter((info) => info.id !== id);
    const canReattach = targets.length > 0;
    if (canReattach) {
      choices.unshift(["rattacher", "Rattacher ces sources à un autre fil"]);
    }

    const choiceSelect = el("select", {
      class: "dialog-select",
      id: "sources-delete-choice",
      "aria-label": "Ce que deviennent les sources de ce fil",
    });
    for (const [value, text] of choices) choiceSelect.append(el("option", { value }, text));

    const targetSelect = el("select", {
      class: "dialog-select",
      id: "sources-delete-target",
      "aria-label": "Nouveau fil des sources",
    });
    for (const info of targets) {
      targetSelect.append(el("option", { value: info.id }, conversationTitle(info)));
    }
    const targetRow = el("div", { class: "dialog-field" });
    targetRow.append(
      el("label", { class: "dialog-label", for: "sources-delete-target" }, "Nouveau fil :"),
      targetSelect,
    );
    targetRow.hidden = true;
    choiceSelect.addEventListener("change", () => {
      targetRow.hidden = choiceSelect.value !== "rattacher";
    });

    const intro = el(
      "p",
      { class: "dialog-text" },
      `${noms.length} source${noms.length > 1 ? "s" : ""} poste${
        noms.length > 1 ? "nt" : ""
      } dans cette conversation. Elles ne seront PAS supprimées : choisissez où leurs ` +
        "prochains messages arriveront.",
    );
    const list = el("ul", { class: "dialog-list" });
    for (const nom of noms) list.append(el("li", {}, nom));
    const choiceRow = el("div", { class: "dialog-field" });
    choiceRow.append(
      el("label", { class: "dialog-label", for: "sources-delete-choice" }, "Que faire ?"),
      choiceSelect,
    );
    const note = el(
      "p",
      { class: "dialog-note" },
      "La conversation, elle, sera EFFACÉE : c'est DÉFINITIF, aucune récupération " +
        "possible, aucune corbeille. La mémoire durable n'est PAS touchée.",
    );
    const form = el("form", { class: "dialog-form", id: DELETE_SOURCES_FORM });
    form.append(intro, list, choiceRow, targetRow, note);

    const ctrl = modal.open({
      title: `Supprimer « ${label} » ?`,
      size: "md",
      content: form,
      actions: [
        { label: "Continuer", form: DELETE_SOURCES_FORM },
        { label: "Annuler", type: "cancel", guard: false },
      ],
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const choice = choiceSelect.value;
      void (async () => {
        if (choice === "rattacher") {
          const target = targetSelect.value;
          if (typeof target !== "string" || target === "") {
            await modal.alert(
              "Aucun fil disponible",
              "Il n'y a pas d'autre conversation où envoyer ces sources. Choisissez " +
                "« nouvelle conversation à chaque fois », ou annulez.",
              { okText: "Compris" },
            );
            return;
          }
          try {
            await reassignSources(noms, target);
          } catch (error) {
            await modal.alert(
              "Réaffectation impossible",
              error instanceof Error ? error.message : String(error),
              { okText: "Compris" },
            );
            return;
          }
          ctrl.close();
          onDelete(id);
          return;
        }
        if (choice === "nouvelle") {
          try {
            await reassignSources(noms, "nouvelle");
          } catch (error) {
            await modal.alert(
              "Réaffectation impossible",
              error instanceof Error ? error.message : String(error),
              { okText: "Compris" },
            );
            return;
          }
          ctrl.close();
          onDelete(id);
          return;
        }
        // « Supprimer quand même » : le serveur réaffecte les sources et écrit
        // une entrée d'alerte dans la boîte de notifications.
        ctrl.close();
        onDelete(id);
      })();
    });
  }

  // ─── Déplier / replier la barre ───────────────────────────────────
  // UNE SEULE commande : le bouton. `data-expanded` sur l'<aside> pilote la
  // largeur et la révélation du contenu (CSS). L'état est persisté localement
  // pour qu'un dépliage survive au rechargement.
  function setExpanded(value) {
    expanded = Boolean(value);
    if (expanded) root.setAttribute("data-expanded", "true");
    else root.removeAttribute("data-expanded");
    toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    const label = expanded
      ? "Replier la barre latérale"
      : "Déplier la barre latérale";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    writeExpanded(expanded);
  }
  toggle.addEventListener("click", () => setExpanded(!expanded));
  setExpanded(expanded);
  newBtn.addEventListener("click", () => onNew());

  // ─── Rendu de la liste ───────────────────────────────────────────────────
  /**
   * Ligne de conversation.
   *
   * @param {object} info session (`WireSession`).
   * @param {"rail"|"menu"} variant `rail` = barre latérale (bureau, rendu
   *   INCHANGÉ) ; `menu` = menu téléphone (même contenu + aperçu + jour/heure).
   */
  function renderItem(info, variant = "rail") {
    const active = info.id === activeId;
    const isPinned = Boolean(info.pinned);
    const menuVariant = variant === "menu";
    const baseClass = menuVariant ? "mnav-conv" : "conv";
    const item = el("div", {
      class: `${baseClass}${active ? (menuVariant ? " mnav-conv--active" : " conv--active") : ""}${
        isPinned ? (menuVariant ? " mnav-conv--pinned" : " conv--pinned") : ""
      }`,
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
    const avatar = el(
      "span",
      { class: "conv__av", "aria-hidden": "true" },
      initialsFor(conversationTitle(info)),
    );
    // Point « en cours » (E2) : visible quand un run d'arrière-plan travaille.
    // Toujours présent dans le DOM (visible via `.conv--busy`), donc le
    // rafraîchissement n'est qu'un basculement de classe.
    avatar.appendChild(el("span", { class: "conv__busy" }));
    // Pastille « NON LU » : compteur, forme et EMPLACEMENT différents du point
    // « en cours » (voir styles.css) — visible aussi dans le rail replié, car
    // ancrée sur la pastille d'initiales, elle-même toujours affichée.
    avatar.appendChild(
      el("span", { class: "conv__unread", "aria-hidden": "true" }),
    );
    item.appendChild(avatar);
    const main = el("span", { class: "conv__main" });
    const titleText = conversationTitle(info);
    main.append(el("span", { class: "conv__title" }, titleText));
    if (menuVariant) {
      // Aperçu du dernier message (le serveur expose le premier message de la
      // conversation comme extrait) : la liste téléphone doit dire de QUOI
      // parle le fil, pas seulement son titre.
      const excerpt = excerptFor(info, titleText);
      if (excerpt) main.append(el("span", { class: "conv__excerpt" }, excerpt));
      main.append(
        el(
          "span",
          { class: "conv__meta" },
          formatMessageCount(info.messageCount),
        ),
      );
    } else {
      main.append(
        el(
          "span",
          { class: "conv__meta" },
          [formatDate(info.updatedAt), formatMessageCount(info.messageCount)]
            .filter(Boolean)
            .join(" · "),
        ),
      );
    }
    item.appendChild(main);
    if (menuVariant) {
      // Colonne de droite : jour/heure + nombre de messages (l'heure complète
      // n'apparaît que pour aujourd'hui, sinon la date courte).
      const aside = el("span", { class: "mnav-conv__aside" });
      const time = formatHour(info.updatedAt);
      if (time) aside.append(el("span", { class: "mnav-conv__time" }, time));
      item.appendChild(aside);
    }

    // APPUI LONG (tactile) : le clic droit n'existe pas au doigt. Armé AVANT
    // l'écouteur de clic, et le clic qui suit est absorbé (voir long-press.js).
    attachLongPress(item, (point) => openMenu(info.id, item, point));
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
    applyIndicators(item, info.id);
    return item;
  }

  /** Toutes les lignes rendues, TOUTES cibles confondues (barre + menu). */
  function itemsByIdAll() {
    const items = [];
    for (const target of targets) {
      for (const item of target.list.querySelectorAll("[data-id]")) items.push(item);
    }
    return items;
  }

  /**
   * Applique les DEUX états d'une conversation — « en cours » ET « non lu » —
   * et compose le libellé accessible/tooltip qui les DIT tous les deux. La
   * couleur seule ne suffit pas (accessibilité) : on pose le compteur dans la
   * pastille ET le libellé complet sur l'item.
   */
  function applyIndicators(item, id) {
    const busy = busyIds.has(id);
    const unread = normalizeCount(unreadCounts[id]);
    item.classList.toggle("conv--busy", busy);
    item.classList.toggle("conv--unread", unread > 0);
    if (busy) item.setAttribute("data-busy", "true");
    else item.removeAttribute("data-busy");
    if (unread > 0) item.setAttribute("data-unread", String(unread));
    else item.removeAttribute("data-unread");
    const badge = item.querySelector(".conv__unread");
    if (badge) badge.textContent = formatUnreadBadge(unread);
    const label = composeConversationLabel(
      conversationTitle(sessions.find((s) => s.id === id) ?? {}),
      { busy, unread },
    );
    item.setAttribute("aria-label", label);
    item.title = label;
  }

  function render() {
    for (const target of targets) {
      target.list.replaceChildren();
      for (const info of sessions) {
        if (info && typeof info.id === "string") {
          target.list.appendChild(renderItem(info, target.variant));
        }
      }
      // État vide EXPLICITE dans le menu téléphone (jamais un cadre muet).
      if (target.empty) target.empty.hidden = sessions.length > 0;
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
    update(nextSessions, nextActiveId, nextBusyIds, nextUnread) {
      sessions = Array.isArray(nextSessions) ? nextSessions : [];
      activeId = typeof nextActiveId === "string" ? nextActiveId : null;
      if (Array.isArray(nextBusyIds)) busyIds = new Set(nextBusyIds);
      if (nextUnread && typeof nextUnread === "object") unreadCounts = { ...nextUnread };
      closeMenu();
      render();
    },
    /**
     * E2 — met à jour l'ensemble des conversations « en cours » SANS refaire le
     * rendu complet (basculage de classe ciblé) : l'indicateur s'allume/ s'éteint
     * au fil des trames, sans reconstruire la liste ni perdre le menu contextuel.
     */
    setBusy(ids) {
      busyIds = new Set(Array.isArray(ids) ? ids : []);
      for (const item of itemsByIdAll()) {
        applyIndicators(item, item.getAttribute("data-id") ?? "");
      }
    },
    /**
     * « NON LU » — même principe que `setBusy` : bascule ciblée des pastilles
     * des items EXISTANTS (aucun `render()`, le menu contextuel survit).
     */
    setUnread(counts) {
      unreadCounts = counts && typeof counts === "object" ? { ...counts } : {};
      for (const item of itemsByIdAll()) {
        applyIndicators(item, item.getAttribute("data-id") ?? "");
      }
    },
    closeMenu,
  };
}
