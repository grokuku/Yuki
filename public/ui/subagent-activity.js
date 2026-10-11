// Yuki — BLOC D'ACTIVITÉ D'UN SOUS-AGENT affiché DANS la conversation (E3).
//
// ⚠️ ÉTAT TEMPORAIRE de l'interface — jamais un message, jamais dans
// l'historique. Il vit DANS le fil mais reste un COMPOSANT à part
// (`.subagent-activity`) : replié PAR DÉFAUT, DÉPLIABLE au clic et au clavier
// (vrai `<button>` + `aria-expanded`).
//
// ⚠️ MUET : son contenu vient de trames de CONTRÔLE `job_activity`, que le
// serveur n'achemine JAMAIS vers le moteur TTS (`routeTtsEvent`). Le titre comme
// les étapes ne sont donc jamais prononcés.
//
// Rendu PUREMENT DOM (`createElement`), AUCUN style en ligne, AUCUNE injection
// HTML directe (CSP `style-src 'self'`). Couleurs de thème uniquement.

import {
  SUBAGENT_ACTIVITY_LABEL,
  jobStatusView,
  subagentStepView,
  subagentToggleLabel,
} from "./activity.js";

/** Petit constructeur DOM (attributs + enfants), sans injection HTML. */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "hidden") el.hidden = Boolean(value);
    else if (value !== undefined && value !== null && value !== false) {
      el.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/**
 * Gère l'affichage des blocs d'activité de sous-agents dans `container`
 * (`#conversation`). Un bloc par `jobId`, replié par défaut.
 *
 * @param {object} deps
 * @param {HTMLElement} deps.container conteneur du fil.
 * @returns {{ apply(frame: object): void, reset(): void }}
 */
export function createSubagentActivity({ container }) {
  if (!container) throw new Error("createSubagentActivity : conteneur absent");

  /** `jobId → { root, toggle, chevron, status, count, steps, stepCount }` */
  const blocks = new Map();

  function setExpanded(record, expanded) {
    record.toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    record.steps.hidden = !expanded;
    record.chevron.textContent = expanded ? "▾" : "▸";
    record.toggle.setAttribute(
      "aria-label",
      subagentToggleLabel(record.stepCount, expanded),
    );
  }

  function build(jobId) {
    const root = h("div", {
      class: "subagent-activity",
      "data-job-id": jobId,
      "data-state": "running",
    });
    const toggle = h("button", {
      type: "button",
      class: "subagent-activity__toggle",
      "aria-expanded": "false",
    });
    const chevron = h("span", {
      class: "subagent-activity__chevron",
      "aria-hidden": "true",
      text: "▸",
    });
    const title = h("span", {
      class: "subagent-activity__title",
      text: SUBAGENT_ACTIVITY_LABEL,
    });
    const status = h("span", { class: "subagent-activity__status", text: "en cours" });
    const count = h("span", { class: "subagent-activity__count" });
    toggle.append(chevron, title, status, count);
    const steps = h("ol", { class: "subagent-activity__steps", hidden: true });
    root.append(toggle, steps);
    const record = {
      root,
      toggle,
      chevron,
      status,
      count,
      steps,
      stepCount: 0,
    };
    toggle.addEventListener("click", () => {
      setExpanded(record, toggle.getAttribute("aria-expanded") !== "true");
    });
    // Le repli par défaut est posé dès la construction (aria + `hidden`).
    setExpanded(record, false);
    blocks.set(jobId, record);
    return record;
  }

  function pushStep(record, view) {
    record.steps.appendChild(
      h("li", {
        class: "subagent-activity__step",
        "data-tone": view.tone,
        "data-key": view.key,
        text: view.label,
      }),
    );
    record.stepCount += 1;
    record.count.textContent = record.stepCount > 0 ? String(record.stepCount) : "";
    const expanded = record.toggle.getAttribute("aria-expanded") === "true";
    record.toggle.setAttribute(
      "aria-label",
      subagentToggleLabel(record.stepCount, expanded),
    );
  }

  /** Applique une trame de contrôle `job_activity` (crée le bloc si besoin). */
  function apply(frame) {
    if (!frame || typeof frame !== "object") return;
    const jobId = String(frame.jobId ?? "");
    if (!jobId) return;
    let record = blocks.get(jobId);
    if (!record) {
      record = build(jobId);
      container.appendChild(record.root);
    }
    const view = subagentStepView(frame.stage, {
      task: frame.task,
      detail: frame.detail,
      status: frame.status,
    });
    // Évite la répétition d'une progression IDENTIQUE collée (le sous-agent peut
    // réémettre le même partiel à chaque fin de tour).
    const last = record.steps.lastElementChild;
    const sameProgress =
      view.key === "progress" &&
      last !== null &&
      last.dataset.key === "progress" &&
      last.textContent === view.label;
    if (!sameProgress) pushStep(record, view);
    if (view.key === "finished") {
      record.root.dataset.state = "finished";
      const status = jobStatusView(frame.status);
      record.status.textContent = status.label;
      record.status.dataset.tone = status.tone;
    }
  }

  /** Retire TOUS les blocs (fil reconstruit : snapshot/rejeu/reconnexion). */
  function reset() {
    for (const el of [...container.querySelectorAll(".subagent-activity")]) el.remove();
    blocks.clear();
  }

  return { apply, reset };
}
