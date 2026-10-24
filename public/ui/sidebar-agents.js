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
// Repli/dépli de la barre (56 px / 280 px) : la pastille (initiale + témoin de
// connexion) tient dans les 56 px ; le nom et l'état ne s'affichent qu'à 280 px
// (CSS, `.sidebar:hover …`). En rail, l'entrée EST la pastille : le clic droit
// dessus ouvre le menu.
//
// ⚠️ TÉLÉPHONE : le même composant rend AUSSI la liste du menu « Agents »
// (`extraTargets`), avec la pastille de connexion, le nom, la DERNIÈRE ACTIVITÉ
// et le NIVEAU de garde-fou visible. Le menu de niveau est le MÊME (un seul
// système), ouvert par clic droit sur bureau et par APPUI LONG au doigt.
//
// ⚠️ VERROU « MATÉRIEL SENSIBLE » : un agent sensible verrouillé porte un
// CADENAS (dans la pastille + libellé « verrouillé »), sur BUREAU comme sur
// TÉLÉPHONE. Le même menu (clic droit / appui long) expose alors une action
// « Déverrouiller l'agent… » qui demande le mot de passe d'INSTANCE — c'est la
// SEULE voie : le modèle ne peut pas la déclencher (décision utilisateur n°4).
// L'état verrouillé est DISTINCT du niveau : il ne le modifie JAMAIS.

import { attachLongPress } from "./long-press.js";

/** Libellés COURTS de niveau pour l'encart (le détail vit dans /config). */
const LEVEL_LABELS = {
  disabled: "désactivé",
  always: "valide tout",
  destructive: "valide le destructif",
  never: "sans validation",
};

/**
 * Libellés COMPACTS du niveau, pour la pastille du menu téléphone : ils disent
 * en UN MOT ce que l'agent a le droit de faire. Ce sont les mêmes 4 niveaux
 * (D118) que `LEVEL_MENU_ITEMS`, jamais un second vocabulaire.
 */
export const LEVEL_BADGES = {
  disabled: "Désactivé",
  always: "Chaque cmd",
  destructive: "Destructrices",
  never: "Aucune",
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

/**
 * `true` si l'agent est sensible ET VERROUILLÉ (matériel sensible).
 *
 * ⚠️ État SÉPARÉ du niveau : un agent verrouillé peut très bien être au niveau
 * « Pas de validation ». Tant qu'il est verrouillé, AUCUNE commande ne part.
 */
export function isAgentLocked(agent) {
  return agent?.locked === true;
}

/**
 * Libellé du verrou (« verrouillé » / « déverrouillé · reverrouille dans N min »),
 * jamais vide pour un agent sensible : c'est une information de SÉCURITÉ, elle
 * doit être lisible en TEXTE (jamais seulement une couleur ou un glyphe).
 */
export function agentLockLabel(agent) {
  if (agent?.sensitive !== true) return "";
  if (isAgentLocked(agent)) return "verrouillé";
  const remaining = Number(agent?.unlockRemainingMs);
  if (!Number.isFinite(remaining) || remaining <= 0) return "déverrouillé";
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  return `déverrouillé · reverrouille dans ${minutes} min`;
}

/**
 * Phrase d'aide du verrou (title/aria-label) : dit ce qui est REFUSÉ et qui
 * peut déverrouiller. C'est l'HUMAIN qui agit, jamais le modèle.
 */
export function agentLockHint(agent) {
  if (agent?.sensitive !== true) return "";
  if (isAgentLocked(agent)) {
    return (
      "Agent sensible VERROUILLÉ : aucune commande ne partira. Déverrouillez-le " +
      "(clic droit ou appui long → Déverrouiller l'agent…) avec le mot de passe d'instance."
    );
  }
  return (
    "Agent sensible DÉVERROUILLÉ : il se reverrouillera tout seul après 15 min " +
    "sans activité (une commande réellement transmise remet le compte à zéro)."
  );
}

/** `true` si l'agent est actuellement CONNECTÉ à Yuki (canal vivant). */
export function isAgentConnected(agent) {
  return agent?.online === true;
}

/**
 * Libellé EXPLICITE de la CONNEXION (« Connecté » / « Déconnecté »).
 * ⚠️ La pastille couleur (vert/rouge) est inaccessible au daltonisme : ce
 * libellé la double en texte (title / aria-label / état) — il est OBLIGATOIRE.
 */
export function agentConnectionLabel(agent) {
  return isAgentConnected(agent) ? "Connecté" : "Déconnecté";
}

/** Libellé court du niveau (« désactivé », « valide le destructif »…). */
export function agentLevelLabel(level) {
  return LEVEL_LABELS[level] ?? String(level ?? "");
}

/** Libellé COMPACT du niveau (« Destructrices », « Chaque cmd », « Aucune »). */
export function agentLevelBadge(level) {
  return LEVEL_BADGES[level] ?? agentLevelLabel(level);
}

/**
 * Dernière activité d'un agent, en clair : « vu à 14:32 » (aujourd'hui),
 * « vu le 8 oct. » (autre jour), « jamais connecté » (aucune trace).
 * ⚠️ Jamais une date inventée : sans `lastSeen` exploitable, on le DIT.
 *
 * @param {string|null|undefined} lastSeen date ISO fournie par le serveur.
 * @param {Date} [now] instant de référence (injectable pour les tests).
 */
export function agentLastSeenLabel(lastSeen, now = new Date()) {
  if (lastSeen === null || lastSeen === undefined || lastSeen === "") {
    return "jamais connecté";
  }
  const date = new Date(lastSeen);
  if (Number.isNaN(date.getTime())) return "jamais connecté";
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  try {
    if (sameDay) {
      const hour = new Intl.DateTimeFormat("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
      }).format(date);
      return `vu à ${hour}`;
    }
    const day = new Intl.DateTimeFormat("fr-FR", {
      day: "numeric",
      month: "short",
    }).format(date);
    return `vu le ${day}`;
  } catch {
    return "jamais connecté";
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
 * Monte l'encart agents.
 *
 * @param {object} deps
 * @param {(agentId: string, enabled: boolean) => void} deps.onToggle
 *   Appelé au clic sur le on/off ; l'application envoie la trame `agent_enabled`.
 * @param {(agentId: string, level: string) => void} [deps.onSetLevel]
 *   Appelé au choix d'un niveau dans le menu contextuel ; l'application envoie
 *   la trame `agent_level` (même état que le on/off : `disabled` = off).
 * @param {(agentId: string) => void} [deps.onUnlock]
 *   Appelé par l'action « Déverrouiller l'agent… » d'un agent sensible
 *   VERROUILLÉ. C'est une action HUMAINE : l'application demande le mot de passe
 *   d'instance et l'envoie au serveur (jamais au modèle).
 * @param {Array<{list: HTMLElement, empty?: HTMLElement}>} [deps.extraTargets]
 *   cibles SUPPLÉMENTAIRES (menu téléphone « Agents ») : même état, même menu de
 *   niveau, avec la dernière activité et le niveau de garde-fou en pastille.
 * @returns {{ element: HTMLElement, update(agents: unknown): void, closeMenu(): void }}
 */
export function initSidebarAgents(deps = {}) {
  const onToggle = deps.onToggle ?? (() => undefined);
  const onSetLevel = deps.onSetLevel ?? (() => undefined);
  const onUnlock = deps.onUnlock ?? (() => undefined);

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

  /** Cibles de rendu : l'encart de la barre + le menu téléphone. */
  const targets = [{ list, empty, variant: "rail" }];
  for (const extra of Array.isArray(deps.extraTargets) ? deps.extraTargets : []) {
    if (extra && extra.list instanceof Node) {
      targets.push({
        list: extra.list,
        empty: extra.empty instanceof Node ? extra.empty : null,
        variant: "menu",
      });
    }
  }

  /** Niveau courant par agent (mis à jour à chaque trame `agents`). */
  const levels = new Map();
  /** État VERROUILLÉ par agent (`sensitive` + `locked`), mis à jour avec la trame. */
  const locks = new Map();

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
  /** Action « Déverrouiller l'agent… » — visible SEULEMENT si l'agent est verrouillé. */
  let unlockItem = null;

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
    // Verrou : l'action de déverrouillage n'apparaît QUE sur un agent sensible
    // verrouillé (sinon elle n'aurait aucun sens).
    if (unlockItem) {
      const lock = locks.get(agentId);
      const locked = lock?.sensitive === true && lock?.locked === true;
      unlockItem.hidden = !locked;
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
    // ─── Action de DÉVERROUILLAGE (matériel sensible) ─────────────────────
    // Placée APRÈS les 4 niveaux (ce sont toujours les 4 mêmes entrées radio ;
    // cette action n'est pas un niveau). Masquée tant que l'agent n'est pas
    // verrouillé : elle n'apparaît que là où elle a un sens.
    const unlock = el(
      "button",
      { class: "ctx-menu__item ctx-menu__item--action", type: "button", role: "menuitem" },
      "",
    );
    const unlockCol = el("span", { class: "ctx-menu__col" });
    unlockCol.append(
      el("span", { class: "ctx-menu__text" }, "Déverrouiller l'agent…"),
      el(
        "span",
        { class: "ctx-menu__hint" },
        "Agent sensible verrouillé : demande le mot de passe d'instance.",
      ),
    );
    unlock.append(el("span", { class: "ctx-menu__check", "aria-hidden": "true" }, "🔒"), unlockCol);
    unlock.hidden = true;
    unlock.addEventListener("click", () => {
      const id = menuAgentId;
      closeMenu();
      if (id) onUnlock(id);
    });
    unlockItem = unlock;
    menu.appendChild(unlock);
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

  /**
   * Rendu d'un agent (hors révoqués, filtrés en amont).
   *
   * @param {object} agent agent de la trame `agents`.
   * @param {"rail"|"menu"} variant `rail` = encart de la barre (INCHANGÉ) ;
   *   `menu` = menu téléphone (niveau en pastille + dernière activité).
   */
  function renderAgent(agent, variant = "rail") {
    const menuVariant = variant === "menu";
    const enabled = isAgentEnabled(agent);
    const connected = isAgentConnected(agent);
    const connectionLabel = agentConnectionLabel(agent);
    const label = agentLabel(agent);
    // VERROU « matériel sensible » : état DISTINCT du niveau.
    const locked = isAgentLocked(agent);
    const lockLabel = agentLockLabel(agent);
    const lockHint = agentLockHint(agent);
    // ⚠️ La classe de LIGNE diffère en menu (`.mnav-agent`) : les sélecteurs E2E
    // du bureau (`.side-agent`) restent sans ambiguïté. Les classes INTERNES
    // (pastille, nom, état) sont les mêmes — un seul système visuel.
    const item = el("li", { class: menuVariant ? "mnav-agent" : "side-agent" });
    item.setAttribute("data-agent-id", String(agent.agentId ?? ""));
    if (agent.sensitive === true) item.setAttribute("data-sensitive", "true");
    if (locked) item.setAttribute("data-locked", "true");

    // ⚠️ La PASTILLE (`.side-agent__dot`) indique UNIQUEMENT la CONNEXION
    // (vert = connecté, rouge = déconnecté). L'état activé/désactivé reste porté
    // par la COULEUR DU BOUTON (`data-enabled`), JAMAIS par la pastille.
    // ⚠️ La couleur seule est inaccessible (daltonisme) : le libellé explicite
    // « Connecté »/« Déconnecté » (title + aria-label + état) double la pastille.
    const badge = el("button", {
      class: "side-agent__badge",
      type: "button",
      role: "switch",
      "aria-checked": enabled ? "true" : "false",
      "aria-label":
        `${label} — ${connectionLabel}` +
        (lockLabel !== "" ? ` — ${lockLabel}` : "") +
        ` — ${enabled ? "désactiver" : "activer"}`,
      title:
        (enabled
          ? `${label} : actif (${agentLevelLabel(agent.level)}), ${connectionLabel.toLowerCase()}. Cliquer pour désactiver, clic droit pour régler le niveau.`
          : `${label} : désactivé, ${connectionLabel.toLowerCase()}. Cliquer pour réactiver, clic droit pour régler le niveau.`) +
        (lockHint !== "" ? ` ${lockHint}` : ""),
    });
    if (enabled) badge.setAttribute("data-enabled", "true");
    badge.setAttribute("data-online", connected ? "true" : "false");
    if (locked) badge.setAttribute("data-locked", "true");
    badge.append(
      el("span", { class: "side-agent__initial", "aria-hidden": "true" }, agentInitial(agent)),
      el("span", {
        class: "side-agent__dot",
        role: "img",
        "aria-label": connectionLabel,
        title: connectionLabel,
      }),
    );
    // CADENAS : glyphe posé en haut à gauche de la pastille (le témoin de
    // connexion reste en bas à droite). Purement DÉCORATIF ici : le nom
    // accessible est sur le bouton (`aria-label`) et le libellé texte ci-dessous.
    if (locked) {
      badge.append(
        el(
          "span",
          { class: "side-agent__lock", "aria-hidden": "true" },
          "🔒",
        ),
      );
    }
    badge.addEventListener("click", () => onToggle(agent.agentId, !enabled));

    const main = el("span", { class: "side-agent__main" });
    if (menuVariant) {
      // Menu téléphone : connexion + DERNIÈRE ACTIVITÉ, le VERROU et le NIVEAU
      // visible en pastille (une information de sécurité ne se devine pas).
      main.append(
        el("span", { class: "side-agent__name" }, label),
        el(
          "span",
          { class: "side-agent__state" },
          [connectionLabel, agentLastSeenLabel(agent.lastSeen), lockLabel]
            .filter(Boolean)
            .join(" · "),
        ),
        el(
          "span",
          {
            class: "mnav-agent__level",
            "data-level": String(agent.level ?? ""),
          },
          agentLevelBadge(agent.level),
        ),
        ...(lockLabel !== ""
          ? [
              el(
                "span",
                { class: "mnav-agent__lock", "data-locked": locked ? "true" : "false" },
                lockLabel,
              ),
            ]
          : []),
      );
    } else {
      main.append(
        el("span", { class: "side-agent__name" }, label),
        el(
          "span",
          { class: "side-agent__state" },
          [agentLevelLabel(agent.level), connectionLabel.toLowerCase(), lockLabel]
            .filter(Boolean)
            .join(" · "),
        ),
      );
    }

    // APPUI LONG (tactile) : même menu de niveau, ouvert au point de l'appui —
    // puisqu'au doigt le clic droit n'existe pas (voir long-press.js).
    if (menuVariant) {
      attachLongPress(item, (point) => openMenuAt(agent.agentId, point.x, point.y));
    }

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
    locks.clear();
    for (const agent of agents) {
      if (!agent || !agent.agentId) continue;
      levels.set(agent.agentId, agent.level);
      locks.set(agent.agentId, {
        sensitive: agent.sensitive === true,
        locked: agent.locked === true,
      });
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
        // L'action de déverrouillage suit l'état de l'agent (il a pu être
        // déverrouillé pendant que le menu était ouvert).
        if (unlockItem) {
          const lock = locks.get(menuAgentId);
          unlockItem.hidden = !(lock?.sensitive === true && lock?.locked === true);
        }
      }
    }
    for (const target of targets) {
      target.list.replaceChildren();
      for (const agent of visible) target.list.append(renderAgent(agent, target.variant));
      if (target.empty) target.empty.hidden = visible.length > 0;
    }

    count.textContent = visible.length > 0 ? String(visible.length) : "";
    count.hidden = visible.length === 0;
    const isEmpty = visible.length === 0;
    empty.hidden = !isEmpty;
    list.hidden = isEmpty;
    section.hidden = false;
  }

  return { element: section, update, closeMenu };
}
