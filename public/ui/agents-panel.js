/**
 * Panneau « Agents » de la page `/config` (Lot 4, B5 — décision D125).
 *
 * Par agent appairé : état (en ligne / hors ligne / révoqué), dernière
 * connexion, petit historique (heure + commande + code de sortie — ⚠️ JAMAIS
 * la sortie complète, D127), niveau de garde-fou (4 choix, D118), privilège
 * (D120) et bouton de suppression (révocation, confirmation `HolafModal`).
 *
 * Affiche aussi les VALIDATIONS EN ATTENTE (niveaux 2/3) : c'est le point où un
 * humain approuve une commande que le modèle ne peut pas s'auto-autoriser.
 *
 * CSP stricte (`style-src 'self'`) : aucun `<style>` injecté, aucun `style=` —
 * tout le CSS vit dans `config.css`.
 */

const JSON_HEADERS = { accept: "application/json" };
const WRITE_HEADERS = { "content-type": "application/json", "x-yuki-agents": "1" };

/** Niveaux de garde-fou PAR AGENT (D118) — libellés français. */
const LEVELS = [
  ["disabled", "1 · Désactivé"],
  ["always", "2 · Validation à chaque commande"],
  ["destructive", "3 · Validation des destructrices"],
  ["never", "4 · Pas de validation"],
];

/** Privilèges par machine (D120). */
const PRIVILEGES = [
  ["normal", "Compte normal"],
  ["root", "Root"],
];

/** Aide à l'appairage (là où trouver le code, quoi faire). */
const PAIRING_HELP = [
  "Installez l'agent d'exécution sur la machine cible et indiquez-lui l'adresse de Yuki.",
  "L'agent affiche un CODE dans sa console (preuve de possession).",
  "Recopiez ce code ci-dessous, puis cliquez sur « Appairer ».",
];

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "on") el.addEventListener("click", value);
    else if (value === true) el.setAttribute(key, "");
    else if (value !== false && value !== undefined && value !== null) {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function shortCommand(command, max = 80) {
  const text = String(command ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatDate(iso) {
  if (!iso) return "jamais";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString("fr-FR");
}

function apiMessage(error, fallback) {
  const data = error?.data ?? {};
  return data.message ?? data.error ?? error?.message ?? fallback;
}

export function initAgentsPanel({ root, HolafFetch, HolafModal }) {
  const state = { agents: [], approvals: [], history: new Map(), error: "" };

  async function load() {
    state.error = "";
    try {
      const [list, approvals] = await Promise.all([
        HolafFetch.get("/api/agents", { headers: JSON_HEADERS }),
        HolafFetch.get("/api/agents/approvals", { headers: JSON_HEADERS }).catch(() => ({
          approvals: [],
        })),
      ]);
      state.agents = Array.isArray(list?.agents) ? list.agents : [];
      state.approvals = Array.isArray(approvals?.approvals) ? approvals.approvals : [];
      // Historique par agent (petit, jamais la sortie).
      state.history = new Map();
      await Promise.all(
        state.agents.map(async (agent) => {
          try {
            const detail = await HolafFetch.get(`/api/agents/${encodeURIComponent(agent.agentId)}`, {
              headers: JSON_HEADERS,
            });
            state.history.set(agent.agentId, Array.isArray(detail?.history) ? detail.history : []);
          } catch {
            state.history.set(agent.agentId, []);
          }
        }),
      );
    } catch (error) {
      state.error = apiMessage(error, "Impossible de charger les agents.");
    }
    render();
  }

  function stateBadge(agent) {
    if (agent.revoked) return h("span", { class: "agent-badge agent-badge--revoked", text: "Révoqué" });
    return agent.online
      ? h("span", { class: "agent-badge agent-badge--online", text: "En ligne" })
      : h("span", { class: "agent-badge agent-badge--offline", text: "Hors ligne" });
  }

  function renderHistory(agentId) {
    const history = state.history.get(agentId) ?? [];
    if (history.length === 0) {
      return h("p", { class: "config-helper", text: "Aucune commande exécutée récemment." });
    }
    const list = h("ul", { class: "agent-history" });
    for (const entry of history) {
      const code = entry.exitCode === null || entry.exitCode === undefined ? "—" : String(entry.exitCode);
      list.append(
        h("li", { class: "agent-history__item" }, [
          h("span", { class: "agent-history__time", text: formatDate(entry.ts) }),
          h("code", { class: "agent-history__cmd", text: shortCommand(entry.command) }),
          h("span", { class: "agent-history__code", text: `code ${code}` }),
        ]),
      );
    }
    return list;
  }

  async function patchAgent(agentId, patch, statusEl) {
    try {
      await HolafFetch.patch(`/api/agents/${encodeURIComponent(agentId)}`, {
        headers: WRITE_HEADERS,
        body: patch,
      });
      if (statusEl) statusEl.textContent = "Enregistré.";
      await load();
    } catch (error) {
      if (statusEl) statusEl.textContent = apiMessage(error, "Échec de l'enregistrement.");
    }
  }

  async function removeAgent(agent) {
    const confirmed = await HolafModal.confirm(
      "Supprimer cet agent ?",
      `L'agent « ${agent.agentId} » sera révoqué : son certificat cessera d'être ` +
        "accepté et son canal sera coupé. Cette action peut être annulée en le restaurant.",
      { danger: true, confirmText: "Révoquer" },
    );
    if (!confirmed) return;
    try {
      await HolafFetch.delete(`/api/agents/${encodeURIComponent(agent.agentId)}`, {
        headers: WRITE_HEADERS,
      });
      await load();
    } catch (error) {
      state.error = apiMessage(error, "Suppression impossible.");
      render();
    }
  }

  async function restoreAgent(agent) {
    try {
      await HolafFetch.post(`/api/agents/${encodeURIComponent(agent.agentId)}/restore`, {
        headers: WRITE_HEADERS,
      });
      await load();
    } catch (error) {
      state.error = apiMessage(error, "Restauration impossible.");
      render();
    }
  }

  function renderApprovals() {
    const section = h("section", { class: "agent-approvals" });
    if (state.approvals.length === 0) return null;
    section.append(
      h("h3", { class: "agent-card__title", text: "Validations en attente" }),
      h("p", {
        class: "config-helper",
        text:
          "Ces commandes attendent votre approbation (niveaux 2 et 3). Le modèle ne peut " +
          "pas les autoriser lui-même : approuvez-les ici, puis relancez la demande.",
      }),
    );
    for (const approval of state.approvals) {
      const actions = h("div", { class: "agent-actions" });
      const approve = h("button", {
        class: "button button--small",
        type: "button",
        text: "Approuver",
      });
      approve.addEventListener("click", () => decideApproval(approval.id, "approve"));
      const deny = h("button", {
        class: "button button--danger button--small",
        type: "button",
        text: "Refuser",
      });
      deny.addEventListener("click", () => decideApproval(approval.id, "deny"));
      actions.append(approve, deny);
      section.append(
        h("div", { class: "agent-approval" }, [
          h("div", { class: "agent-approval__head" }, [
            h("span", { class: "agent-id", text: approval.agentId }),
            approval.destructive
              ? h("span", { class: "agent-badge agent-badge--danger", text: "Destructrice" })
              : h("span", { class: "agent-badge", text: "Ordinaire" }),
          ]),
          h("code", { class: "agent-approval__cmd", text: shortCommand(approval.command, 200) }),
          h("p", { class: "config-helper", text: `Demandée le ${formatDate(approval.createdAt)}.` }),
          actions,
        ]),
      );
    }
    return section;
  }

  async function decideApproval(id, decision) {
    try {
      await HolafFetch.post(
        `/api/agents/approvals/${encodeURIComponent(id)}/${decision}`,
        { headers: WRITE_HEADERS },
      );
      await load();
    } catch (error) {
      state.error = apiMessage(error, "Décision impossible.");
      render();
    }
  }

  function renderAgent(agent) {
    const card = h("article", { class: "agent-card" });
    const head = h("div", { class: "agent-card__head" }, [
      h("span", { class: "agent-id", text: agent.agentId }),
      stateBadge(agent),
    ]);
    card.append(head);
    card.append(
      h("p", { class: "config-helper", text: `Dernière connexion : ${formatDate(agent.lastSeen)}` }),
    );

    const status = h("span", { class: "config-save-status" });

    // Niveau (D118).
    const levelSelect = h("select", { class: "config-select" });
    for (const [value, label] of LEVELS) {
      const option = h("option", { value, text: label });
      if (agent.level === value) option.selected = true;
      levelSelect.append(option);
    }
    levelSelect.addEventListener("change", () => patchAgent(agent.agentId, { level: levelSelect.value }, status));

    // Privilège (D120).
    const privSelect = h("select", { class: "config-select" });
    for (const [value, label] of PRIVILEGES) {
      const option = h("option", { value, text: label });
      if (agent.privilege === value) option.selected = true;
      privSelect.append(option);
    }
    privSelect.addEventListener("change", () =>
      patchAgent(agent.agentId, { privilege: privSelect.value }, status),
    );

    card.append(
      h("div", { class: "agent-fields" }, [
        h("label", { class: "agent-field" }, [
          h("span", { class: "agent-field__label", text: "Niveau de validation" }),
          levelSelect,
        ]),
        h("label", { class: "agent-field" }, [
          h("span", { class: "agent-field__label", text: "Privilège du processus" }),
          privSelect,
        ]),
      ]),
    );
    card.append(status);

    // Historique (replié).
    card.append(
      h("details", { class: "agent-history-details" }, [
        h("summary", { text: "Historique récent" }),
        renderHistory(agent.agentId),
      ]),
    );

    const actions = h("div", { class: "agent-actions" });
    if (agent.revoked) {
      const restore = h("button", {
        class: "button button--ghost button--small",
        type: "button",
        text: "Restaurer",
      });
      restore.addEventListener("click", () => restoreAgent(agent));
      actions.append(restore);
    } else {
      const remove = h("button", {
        class: "button button--danger button--small",
        type: "button",
        text: "Supprimer l'agent",
      });
      remove.addEventListener("click", () => removeAgent(agent));
      actions.append(remove);
    }
    card.append(actions);
    return card;
  }

  function renderPairingHelp() {
    const section = h("section", { class: "agent-help" });
    section.append(h("h3", { class: "agent-card__title", text: "Comment appairer un agent ?" }));
    const steps = h("ol", { class: "agent-help__steps" });
    for (const step of PAIRING_HELP) steps.append(h("li", { text: step }));
    section.append(steps);
    return section;
  }

  function render() {
    root.textContent = "";
    const wrap = h("section", { class: "agents-panel" });
    wrap.append(
      h("div", { class: "config-group__head" }, [
        h("h2", { class: "config-group__title", text: "Machines appairées" }),
      ]),
    );

    const refresh = h("button", {
      class: "button button--ghost button--small",
      type: "button",
      text: "Rafraîchir",
    });
    refresh.addEventListener("click", () => void load());
    wrap.append(h("div", { class: "agent-actions" }, [refresh]));

    if (state.error) {
      wrap.append(h("p", { class: "config-banner config-banner--warn", text: state.error }));
    }

    const approvals = renderApprovals();
    if (approvals) wrap.append(approvals);

    if (state.agents.length === 0) {
      wrap.append(
        h("p", { class: "config-helper", text: "Aucun agent appairé pour le moment." }),
      );
      wrap.append(renderPairingHelp());
      root.append(wrap);
      return;
    }

    const list = h("div", { class: "agent-list" });
    for (const agent of state.agents) list.append(renderAgent(agent));
    wrap.append(list);
    root.append(wrap);
  }

  render();
  void load();
  return { refresh: load };
}
