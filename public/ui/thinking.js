// Yuki — BLOC DE RÉFLEXION du modèle (canal `thinking`) affiché DANS le fil.
//
// ⚠️ ÉTAT ÉPHÉMÈRE de l'interface — jamais un message, jamais dans l'historique.
// Il vit DANS le fil, À SA PLACE (juste AVANT la réponse du tour), et reste un
// COMPOSANT à part (`.thinking-block`) : replié PAR DÉFAUT, DÉPLIABLE au clic et
// au clavier (vrai `<button>` + `aria-expanded`).
//
// ⚠️ MUET : son contenu vient du canal `thinking`, que le serveur n'achemine
// JAMAIS vers le moteur TTS (`routeTtsEvent` ne transmet que `content`). Le titre
// comme le raisonnement ne sont donc jamais prononcés.
//
// ⚠️ ÉPHÉMÈRE : alimenté par une trame de CONTRÔLE (comme l'activité du
// sous-agent). Après rechargement (snapshot) ou bascule de fil, le bloc DISPARAÎT :
// il n'est ni dans le transcript, ni dans le rejeu, ni dans la mémoire.
//
// Rendu PUREMENT DOM (`createElement`), AUCUN style en ligne, AUCUNE injection
// HTML directe (CSP `style-src 'self'`). Couleurs de thème uniquement.

import { THINKING_BLOCK_LABEL, thinkingToggleLabel } from "./activity.js";

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
 * Gère l'affichage des blocs de RÉFLEXION dans `container` (`#conversation`).
 * Un bloc par `runId`, replié par défaut, inséré AVANT le message assistant
 * correspondant (donc avant la réponse, à sa place chronologique).
 *
 * @param {object} deps
 * @param {HTMLElement} deps.container conteneur du fil.
 * @returns {{ append(runId: string, text: string, anchor: Node|null): void, reset(): void }}
 */
export function createThinkingBlocks({ container }) {
  if (!container) throw new Error("createThinkingBlocks : conteneur absent");

  /** `runId → { root, toggle, chevron, body, count, chars }` */
  const blocks = new Map();

  function setExpanded(record, expanded) {
    record.toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    record.body.hidden = !expanded;
    record.chevron.textContent = expanded ? "▾" : "▸";
    record.toggle.setAttribute(
      "aria-label",
      thinkingToggleLabel(record.chars, expanded),
    );
  }

  function build(runId, anchor) {
    const root = h("div", {
      class: "thinking-block",
      "data-run-id": runId,
      "data-state": "running",
    });
    const toggle = h("button", {
      type: "button",
      class: "thinking-block__toggle",
      "aria-expanded": "false",
    });
    const chevron = h("span", {
      class: "thinking-block__chevron",
      "aria-hidden": "true",
      text: "▸",
    });
    const title = h("span", {
      class: "thinking-block__title",
      text: THINKING_BLOCK_LABEL,
    });
    const count = h("span", { class: "thinking-block__count" });
    toggle.append(chevron, title, count);
    // Le raisonnement est rendu en TEXTE BRUT (jamais du markdown) : c'est une
    // trace de raisonnement, pas une réponse — et cela évite tout HTML injecté.
    const body = h("div", { class: "thinking-block__body", hidden: true });
    root.append(toggle, body);
    const record = { root, toggle, chevron, body, count, chars: 0 };
    toggle.addEventListener("click", () => {
      setExpanded(record, toggle.getAttribute("aria-expanded") !== "true");
    });
    // Le repli par défaut est posé dès la construction (aria + `hidden`).
    setExpanded(record, false);
    // Insertion AVANT la réponse du tour quand elle est encore dans le fil,
    // sinon en fin de fil (repli défensif).
    if (anchor && anchor.parentNode === container) {
      container.insertBefore(root, anchor);
    } else {
      container.appendChild(root);
    }
    blocks.set(runId, record);
    return record;
  }

  /**
   * Ajoute un fragment de raisonnement. Crée le bloc au PREMIER fragment (ainsi
   * un run sans `thinking` n'affiche RIEN). `anchor` = message assistant du tour
   * (position d'insertion : juste avant la réponse).
   */
  function append(runId, text, anchor = null) {
    if (typeof runId !== "string" || runId.length === 0) return;
    if (typeof text !== "string" || text.length === 0) return;
    let record = blocks.get(runId);
    if (!record) record = build(runId, anchor);
    record.body.append(document.createTextNode(text));
    record.chars += text.length;
    record.count.textContent = String(record.chars);
    const expanded = record.toggle.getAttribute("aria-expanded") === "true";
    record.toggle.setAttribute(
      "aria-label",
      thinkingToggleLabel(record.chars, expanded),
    );
  }

  /** Retire TOUS les blocs (fil reconstruit : snapshot/rejeu/reconnexion). */
  function reset() {
    for (const el of [...container.querySelectorAll(".thinking-block")]) el.remove();
    blocks.clear();
  }

  return { append, reset };
}
