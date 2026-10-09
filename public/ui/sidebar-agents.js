// Yuki — encart « Agents » en bas de la barre latérale du chat.
//
// Affiche les agents appairés avec, pour chacun, un bouton on/off. Le on/off
// RÉUTILISE le niveau existant (D118) : « off » = niveau `disabled`, « on » =
// niveau précédent mémorisé côté SERVEUR (aucun second drapeau d'activation ici).
// L'UI ne calcule donc JAMAIS le niveau cible : elle envoie `agent_enabled` et
// reflète la trame `agents` renvoyée par le serveur (source de vérité).
//
// CLIC DROIT sur l'entrée d'un agent (ou touche `Menu contextuel` / Maj+F10) :
// ouvre le menu de RÉGLAGE DU NIVEAU de confirmation (les 4 niveaux D118). Le
// niveau courant est marqué (`role="menuitemradio"` + `aria-checked` + ✓). ⚠️
// « Désactivé » EST le même état que « off » : un seul état, jamais deux.
//
// Chaque niveau affiche AUSSI la CONSÉQUENCE réelle (une phrase) : un acte de
// sécurité doit être lisible SANS ouvrir /config — « Désactivé » = commandes
// REFUSÉES, « Pas de validation » = aucune validation. Les phrases reprennent
// la sémantique du garde-fou serveur (`AgentExecutionService.authorize`).
//
// CSP stricte : rendu PUREMENT DOM (jamais d'injection HTML), aucun attribut de
// style en ligne. Seule la POSITION du menu flottant utilise le CSSOM
// (`position: fixed`), comme le menu des conversations.
// Repli/dépli de la barre (56 px / 280 px) : la pastille (initiale + témoin on/off)
// tient dans les 56 px ; le nom et l'état ne s'affichent qu'à 280 px (CSS, `.sidebar:hover …`).
// En rail, l'entrée EST la pastille : le clic droit dessus ouvre le menu.

/** Libellés COURTS de niveau pour l'encart (le détail vit dans /config). */
const LEVEL_LABELS = {
  disabled: "désactivé",
  always: "valide tout",
  destructive: "valide le destructif",
  never: "sans validation",
};

/**
 * Libellés EXPLICITES des 4 niveaux (D118), dans l'ordre de `AGENT_LEVELS`.
 * Ce sont ceux du menu contextuel (mêmes mots que la page /config, sans numéro).
 */
export const LEVEL_MENU_ITEMS = [
  {
    level: "disabled",
    label: "Désactivé",
    hint: "Commandes REFUSÉES : l'agent ne peut plus rien exécuter.",
  },
  {
    level: "always",
    label: "Validation à chaque commande",
    hint: "Chaque commande vous demande validation avant de s'exécuter.",
  },
  {
    level: "destructive",
    label: "Validation des commandes destructrices",
    hint: "Seules les commandes destructrices vous demandent validation.",
  },
  {
    level: "never",
    label: "Pas de validation",
    hint: "Aucune validation : les commandes s'exécutent directement.",
  },
];

/**
 * Nom affichable d'un agent — JAMAIS vide : son nom s'il existe, sinon son
 * identifiant technique.
 */
export function agentLabel(agent) {
  const name = typeof agent?.name === "string" ? agent.name.trim() : "";
  if (name !== "") return name;
  const id = agent?.agentId;
  return typeof id === "string" && id !== "" ? id : "agent";
}

/** Initiale (majuscule) dérivée du nom, pour la pastille du rail. Jamais vide. */
export function agentInitial(agent) {
  const label = agentLabel(agent);
  const first = label.slice(0, 1);
  return first === "" ? "?" : first.toUpperCase();
}

/** `true` si l'agent est ACTIF (tout niveau sauf `disabled`). */
export function isAgentEnabled(agent) {
  return agent?.level !== "disabled";
}

/** Libellé court du niveau (« désactivé », « valide le destructif »…). */
export function agentLevelLabel(level) {
  return LEVEL_LABELS[level] ?? String(level ?? "");
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
 * Monte l'encart agents.
 *
 * @param {object} deps
 * @param {(agentId: string, enabled: boolean) => void} deps.onToggle
 *   Appelé au clic sur le on/off ; l'application envoie la trame `agent_enabled`.
 * @param {(agentId: string, level: string) => void} [deps.onSetLevel]
 *   Appelé au choix d'un niveau dans le menu contextuel ; l'application envoie
 *   la trame `agent_level` (même état que le on/off : `disabled` = off).
 * @returns {{ element: HTMLElement, update(agents: unknown): void, closeMenu(): void }}
 */
export function initSidebarAgents(deps = {}) {
  const onToggle = deps.onToggle ?? (() => undefined);
  const onSetLevel = deps.onSetLevel ?? (() => undefined);

  const section = el("section", {
    class: "side-agents",
    "aria-label": "Agents d'exécution",
  });
  // Masqué tant que le serveur n'a rien dit : on ne prétend pas « aucun agent »
  // avant de le savoir (le sous-système peut être indisponible).
  section.hidden = true;

  const head = el("div", { class: "side-agents__head" });
  const title = el("span", { class: "side-agents__title" }, "Agents");
  const count = el("span", { class: "side-agents__count" });
  head.append(title, count);

  const list = el("ul", { class: "side-agents__list" });
  const empty = el("p", { class: "side-agents__empty" }, "Aucun agent appairé.");

  section.append(head, list, empty);

  /** Niveau courant par agent (mis à jour à chaque trame `agents`). */
  const levels = new Map();

  // ─── Menu contextuel (clic droit sur l'entrée d'un agent) ─────────────────
  // Menu PARTAGÉ par toutes les entrées de l'encart, comme celui des
  // conversations : construit une fois, positionné au CURSEUR via le CSSOM.
  const menu = el("div", { class: "ctx-menu ctx-menu--levels", role: "menu" });
  menu.hidden = true;
  // ⚠️ Monté À LA DEMANDE dans `document.body` (`position: fixed`, aucun ancêtre
  // `transform`), puis DÉTACHÉ à la fermeture. Le montage fainéant évite de
  // faire de l'ombre au menu des CONVERSATIONS (`querySelector('.ctx-menu')`
  // doit rester sans ambiguïté) et ne laisse aucun nœud résiduel au repos.
  let menuMounted = false;

  function mountMenu() {
    if (menuMounted) return;
    document.body.appendChild(menu);
    menuMounted = true;
  }

  function unmountMenu() {
    if (!menuMounted) return;
    menu.remove();
    menuMounted = false;
  }

  let menuAgentId = null;
  /** level → bouton (pour marquer l'élément courant à l'ouverture). */
  const levelItems = new Map();

  function closeMenu() {
    if (menu.hidden && !menuMounted) return;
    menu.hidden = true;
    menuAgentId = null;
    // Aucun `style` résiduel au repos (CSP), et aucun nœud inutile dans le DOM.
    menu.removeAttribute("style");
    unmountMenu();
  }

  function openMenuAt(agentId, x, y) {
    menuAgentId = agentId;
    const current = levels.get(agentId);
    for (const [level, item] of levelItems) {
      const checked = level === current;
      item.setAttribute("aria-checked", checked ? "true" : "false");
    }
    mountMenu();
    menu.hidden = false;
    // Position au CURSEUR (`position: fixed` via CSSOM, jamais d'attribut de
    // style en ligne dans le markup).
    const width = menu.offsetWidth || 240;
    const height = menu.offsetHeight || 200;
    let left = x;
    let top = y;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - width - 8);
    }
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, y - height);
    }
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }

  function buildMenu() {
    const label = el(
      "div",
      { class: "ctx-menu__label", "aria-hidden": "true" },
      "Niveau de confirmation",
    );
    menu.appendChild(label);
    for (const { level, label: text, hint } of LEVEL_MENU_ITEMS) {
      const item = el(
        "button",
        { class: "ctx-menu__item ctx-menu__item--radio", type: "button", role: "menuitemradio" },
        "",
      );
      item.append(
        el("span", { class: "ctx-menu__check", "aria-hidden": "true" }, "✓"),
        (() => {
          // Libellé EXPLICITE + CONSÉQUENCE sur une seconde ligne : un seul
          // libellé radio (`.ctx-menu__text`) porte l'état, la phrase explique
          // l'effet réel. Jamais d'injection HTML (nœuds créés).
          const col = el("span", { class: "ctx-menu__col" });
          col.append(
            el("span", { class: "ctx-menu__text" }, text),
            el("span", { class: "ctx-menu__hint" }, hint),
          );
          return col;
        })(),
      );
      item.setAttribute("aria-checked", "false");
      item.addEventListener("click", () => {
        const id = menuAgentId;
        closeMenu();
        if (id) onSetLevel(id, level);
      });
      levelItems.set(level, item);
      menu.appendChild(item);
    }
  }
  buildMenu();

  // Fermeture hors clic / Échap / défilement / redimensionnement.
  document.addEventListener("click", (event) => {
    if (menu.hidden) return;
    if (!menu.contains(event.target)) closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
  window.addEventListener("resize", closeMenu);
  // Défilement : on ne referme QUE si c'est la BARRE LATÉRALE (qui porte
  // l'entrée) qui défile. ⚠️ Un écouteur GLOBAL sur `window` (phase de capture)
  // se déclenchait sur TOUT `scroll` — y compris le FIL de discussion, qui
  // défile EN CONTINU pendant une réponse — et refermait le menu aussitôt
  // ouvert (l'utilisateur ne pouvait rien sélectionner). Les événements `scroll`
  // ne remontent pas : on garde la phase de CAPTURE, mais on FILTRE la cible,
  // exactement comme le menu des conversations (scopé à la barre).
  window.addEventListener(
    "scroll",
    (event) => {
      if (menu.hidden) return;
      const sidebar = section.closest(".sidebar");
      if (!sidebar) return;
      const target = event.target;
      if (target === sidebar || (target instanceof Node && sidebar.contains(target))) {
        closeMenu();
      }
    },
    true,
  );

  /** Rendu d'un agent (hors révoqués, filtrés en amont). */
  function renderAgent(agent) {
    const enabled = isAgentEnabled(agent);
    const label = agentLabel(agent);
    const item = el("li", { class: "side-agent" });
    item.setAttribute("data-agent-id", String(agent.agentId ?? ""));

    const badge = el("button", {
      class: "side-agent__badge",
      type: "button",
      role: "switch",
      "aria-checked": enabled ? "true" : "false",
      "aria-label": `${label} — ${enabled ? "désactiver" : "activer"}`,
      title: enabled
        ? `${label} : actif (${agentLevelLabel(agent.level)}). Cliquer pour désactiver, clic droit pour régler le niveau.`
        : `${label} : désactivé. Cliquer pour réactiver, clic droit pour régler le niveau.`,
    });
    if (enabled) badge.setAttribute("data-enabled", "true");
    if (agent.online) badge.setAttribute("data-online", "true");
    badge.append(
      el("span", { class: "side-agent__initial", "aria-hidden": "true" }, agentInitial(agent)),
      el("span", { class: "side-agent__dot", "aria-hidden": "true" }),
    );
    badge.addEventListener("click", () => onToggle(agent.agentId, !enabled));

    const main = el("span", { class: "side-agent__main" });
    main.append(
      el("span", { class: "side-agent__name" }, label),
      el(
        "span",
        { class: "side-agent__state" },
        [agentLevelLabel(agent.level), agent.online ? "en ligne" : "hors ligne"]
          .filter(Boolean)
          .join(" · "),
      ),
    );

    // Clic droit (ou touche « Menu contextuel » / Maj+F10) sur TOUTE l'entrée
    // (la pastille EST l'entrée en rail 56 px) : menu de réglage du niveau.
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openMenuAt(agent.agentId, event.clientX, event.clientY);
    });
    item.addEventListener("keydown", (event) => {
      if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault();
        const rect = (event.target instanceof Element ? event.target : item).getBoundingClientRect();
        openMenuAt(agent.agentId, rect.left + 8, rect.bottom + 4);
      }
    });

    item.append(badge, main);
    return item;
  }

  function updateAgentState(agents) {
    levels.clear();
    for (const agent of agents) {
      if (agent && agent.agentId) levels.set(agent.agentId, agent.level);
    }
  }

  function update(agents) {
    const list0 = Array.isArray(agents) ? agents : [];
    // Les agents RÉVOQUÉS ne se pilotent pas ici (ils ne peuvent plus se
    // connecter) : leur gestion (restaurer / supprimer) vit dans /config.
    const visible = list0.filter((agent) => agent && !agent.revoked);
    updateAgentState(visible);
    // ⚠️ Un rafraîchissement du registre (trame `agents` : un agent se connecte,
    // passe en ligne/hors ligne, change de niveau…) ne doit PAS détruire un menu
    // contextuel OUVERT : le nœud re-créé/retiré sous le curseur faisait
    // disparaître le menu (impossible de sélectionner un niveau). On le referme
    // SEULEMENT si l'agent ciblé a disparu (déconnecté/révoqué) ; sinon on
    // rafraîchit uniquement la coche du niveau courant.
    if (!menu.hidden) {
      const stillThere = menuAgentId !== null && visible.some((agent) => agent.agentId === menuAgentId);
      if (!stillThere) {
        closeMenu();
      } else {
        const current = levels.get(menuAgentId);
        for (const [level, item] of levelItems) {
          item.setAttribute("aria-checked", level === current ? "true" : "false");
        }
      }
    }
    list.replaceChildren();
    for (const agent of visible) list.append(renderAgent(agent));

    count.textContent = visible.length > 0 ? String(visible.length) : "";
    count.hidden = visible.length === 0;
    const isEmpty = visible.length === 0;
    empty.hidden = !isEmpty;
    list.hidden = isEmpty;
    section.hidden = false;
  }

  return { element: section, update, closeMenu };
}
