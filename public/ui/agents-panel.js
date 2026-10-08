/**
 * Panneau « Agents » de la page `/config` (Lot 4, B5 — décision D125).
 *
 * Appaire un nouvel agent (D119) : l'agent affiche un code sur la console de la
 * MACHINE ; l'utilisateur le recopie dans le champ ci-dessous et clique sur
 * « Appairer » (`POST /api/agents/pair`). La validation/normalisation du code
 * est faite CÔTÉ SERVEUR (`PairingManager.submitCode` → `normalizeCode`) : l'UI
 * envoie la saisie telle quelle et affiche le message exact renvoyé.
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

/** Délai après un appairage réussi avant de rafraîchir la liste (l'agent apparaît en ~1 s). */
const PAIR_REFRESH_MS = 1500;

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
  "Lancez-y « yuki-agent pair » : l'agent GÉNÈRE un code et l'AFFICHE dans sa console (preuve de possession).",
  "Recopiez ce code dans le champ ci-dessous, puis cliquez sur « Appairer ».",
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

/**
 * Nom affichable d'un agent : son NOM s'il existe, sinon son ID technique — on
 * n'affiche JAMAIS un vide (ni pour l'humain, ni pour le modèle).
 */
function displayName(agent) {
  const name = typeof agent?.name === "string" ? agent.name.trim() : "";
  return name !== "" ? name : String(agent?.agentId ?? "");
}

/** Identité affichable : le nom (ou l'ID en repli) + l'ID en note s'il diffère. */
function identityNode(agentId, label) {
  const nodes = [h("span", { class: "agent-id", text: label })];
  if (label !== agentId) {
    nodes.push(h("span", { class: "agent-id-sub", text: `id ${agentId}` }));
  }
  return h("span", { class: "agent-identity" }, nodes);
}

export function initAgentsPanel({ root, HolafFetch, HolafModal }) {
  const state = { agents: [], approvals: [], history: new Map(), error: "", pairStatus: "" };

  /** Nom affichable d'un agent à partir de son ID (repli : l'ID lui-même). */
  function nameOf(agentId) {
    const agent = state.agents.find((a) => a.agentId === agentId);
    return agent ? displayName(agent) : String(agentId);
  }

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
    const label = displayName(agent);
    const idNote = label === agent.agentId ? "" : ` (identifiant ${agent.agentId})`;
    const confirmed = await HolafModal.confirm(
      "Supprimer cet agent ?",
      `L'agent « ${label} »${idNote} sera révoqué : son certificat cessera d'être ` +
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
            identityNode(approval.agentId, nameOf(approval.agentId)),
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
      identityNode(agent.agentId, displayName(agent)),
      stateBadge(agent),
    ]);
    card.append(head);
    card.append(
      h("p", { class: "config-helper", text: `Dernière connexion : ${formatDate(agent.lastSeen)}` }),
    );

    const status = h("span", { class: "config-save-status" });

    // Nom (alias lisible) — champ `hot` : enregistré SANS redémarrage. La
    // validation (bornes, espaces) et l'unicité sont faites CÔTÉ SERVEUR ; on
    // affiche tel quel le message renvoyé (jamais une cause inventée).
    const nameInput = h("input", {
      class: "agent-name__input",
      type: "text",
      autocomplete: "off",
      spellcheck: "false",
      maxlength: "64",
      value: agent.name ?? "",
      placeholder: "ex. nuc00 (nom d'hôte)",
      "aria-label": "Nom de l'agent",
    });
    const nameStatus = h("span", { class: "config-save-status" });
    const saveName = () => {
      const value = nameInput.value.trim();
      if (value === (agent.name ?? "")) return;
      if (value === "") {
        nameStatus.textContent = "Le nom ne peut pas être vide.";
        return;
      }
      void patchAgent(agent.agentId, { name: value }, nameStatus);
    };
    nameInput.addEventListener("change", saveName);
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveName();
      }
    });

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
        h("label", { class: "agent-field agent-field--wide" }, [
          h("span", { class: "agent-field__label" }, [
            "Nom (alias lisible) ",
            h("span", { class: "badge badge--hot", text: "à chaud" }),
          ]),
          nameInput,
        ]),
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
    card.append(nameStatus);
    card.append(
      h("p", {
        class: "config-helper",
        text:
          "Le nom est un alias lisible pour vous et pour le modèle (ex. « nuc00 »). " +
          "L'identifiant technique reste la référence : il fonctionne toujours.",
      }),
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

  /** Section d'appairage : mode d'emploi + champ de saisie du code (D119). */
  function renderPairingSection() {
    const section = h("section", { class: "agent-help" });
    section.append(h("h3", { class: "agent-card__title", text: "Comment appairer un agent ?" }));
    const steps = h("ol", { class: "agent-help__steps" });
    for (const step of PAIRING_HELP) steps.append(h("li", { text: step }));
    section.append(steps);

    // Formulaire d'appairage (D119) : le code vient de la console de l'agent.
    const inputId = "agent-pair-code";
    const statusId = "agent-pair-status";
    const input = h("input", {
      id: inputId,
      class: "agent-pair__input",
      type: "text",
      autocomplete: "off",
      autocapitalize: "characters",
      spellcheck: "false",
      maxlength: "32",
      placeholder: "XXXX-XXXX-XXXX",
      "aria-describedby": statusId,
    });
    const button = h("button", { class: "button", type: "button", text: "Appairer" });
    const status = h("span", { id: statusId, class: "config-save-status", role: "status" });
    // Le message d'appairage survit aux re-rendus (chaque `load()` reconstruit
    // le formulaire : sans cet état, « Code accepté » disparaîtrait aussitôt).
    status.textContent = state.pairStatus;

    const submit = () => void submitPair(input, button, status);
    button.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submit();
      }
    });

    const field = h("div", { class: "agent-pair" }, [
      h("label", { class: "agent-field__label", for: inputId, text: "Code affiché par l'agent" }),
      h("div", { class: "agent-pair__row" }, [input, button]),
      status,
    ]);
    section.append(field);
    return section;
  }

  /**
   * Soumet le code d'appairage. La normalisation/validation est faite par le
   * SERVEUR (`normalizeCode`, TS) : on envoie la saisie brute (casse, tirets et
   * espaces tolérés côté serveur) et on affiche le message EXACT renvoyé (jamais
   * une cause inventée).
   */
  async function submitPair(input, button, status) {
    const setStatus = (text) => {
      state.pairStatus = text;
      status.textContent = text;
    };
    const value = input.value.trim();
    if (value === "") {
      setStatus("Saisissez le code affiché dans la console de l'agent.");
      input.focus();
      return;
    }
    button.disabled = true;
    setStatus("Appairage en cours…");
    try {
      const result = await HolafFetch.post("/api/agents/pair", {
        headers: WRITE_HEADERS,
        body: { code: value },
      });
      if (result?.matched) {
        setStatus(
          `Code accepté (${result.code}). L'agent s'appaire : il apparaîtra ci-dessous ` +
            "d'ici quelques secondes.",
        );
        input.value = "";
        // `load()` reconstruit le panneau : le message est relu depuis l'état.
        await load();
        // L'agent finalise en ~1 s : un second rafraîchissement le fait apparaître.
        setTimeout(() => void load(), PAIR_REFRESH_MS);
      } else {
        setStatus(
          `Code enregistré (${result?.code ?? ""}), mais aucun agent n'attend avec ce code. ` +
            "Vérifiez que « yuki-agent pair » tourne toujours sur la machine et que le " +
            "code saisi est exactement celui affiché sur sa console.",
        );
      }
    } catch (error) {
      // Code invalide/expiré/déjà utilisé ou trop de tentatives : on montre le
      // message du serveur tel quel (véridique).
      setStatus(apiMessage(error, "Appairage impossible."));
    } finally {
      button.disabled = false;
    }
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

    // Le formulaire d'appairage est TOUJOURS proposé (même quand des agents sont
    // déjà appairés : on peut en ajouter d'autres).
    wrap.append(renderPairingSection());

    if (state.agents.length === 0) {
      wrap.append(
        h("p", { class: "config-helper", text: "Aucun agent appairé pour le moment." }),
      );
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
