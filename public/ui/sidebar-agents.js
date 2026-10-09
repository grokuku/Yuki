// Yuki — encart « Agents » en bas de la barre latérale du chat.
//
// Affiche les agents appairés avec, pour chacun, un bouton on/off. Le on/off
// RÉUTILISE le niveau existant (D118) : « off » = niveau `disabled`, « on » =
// niveau précédent mémorisé côté SERVEUR (aucun second drapeau d'activation ici).
// L'UI ne calcule donc JAMAIS le niveau cible : elle envoie `agent_enabled` et
// reflète la trame `agents` renvoyée par le serveur (source de vérité).
//
// CSP stricte : rendu PUREMENT DOM (jamais d'injection HTML), aucun attribut de
// style en ligne. Repli/dépli de la barre (56 px / 280 px) : la pastille (initiale + témoin
// on/off) tient dans les 56 px ; le nom et l'état ne s'affichent qu'à 280 px
// (CSS, `.sidebar:hover …`). Toujours utilisable en rail : la pastille EST le
// bouton on/off (role="switch").
//

/** Libellés COURTS de niveau pour l'encart (le détail vit dans /config). */
const LEVEL_LABELS = {
  disabled: "désactivé",
  always: "valide tout",
  destructive: "valide le destructif",
  never: "sans validation",
};

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
 * @returns {{ element: HTMLElement, update(agents: unknown): void }}
 */
export function initSidebarAgents(deps = {}) {
  const onToggle = deps.onToggle ?? (() => undefined);

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
        ? `${label} : actif (${agentLevelLabel(agent.level)}). Cliquer pour désactiver.`
        : `${label} : désactivé. Cliquer pour réactiver.`,
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

    item.append(badge, main);
    return item;
  }

  function update(agents) {
    const list0 = Array.isArray(agents) ? agents : [];
    // Les agents RÉVOQUÉS ne se pilotent pas ici (ils ne peuvent plus se
    // connecter) : leur gestion (restaurer / supprimer) vit dans /config.
    const visible = list0.filter((agent) => agent && !agent.revoked);
    list.replaceChildren();
    for (const agent of visible) list.append(renderAgent(agent));

    count.textContent = visible.length > 0 ? String(visible.length) : "";
    count.hidden = visible.length === 0;
    const isEmpty = visible.length === 0;
    empty.hidden = !isEmpty;
    list.hidden = isEmpty;
    section.hidden = false;
  }

  return { element: section, update };
}
