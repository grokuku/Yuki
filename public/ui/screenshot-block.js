// Yuki — bloc de CAPTURE D'ÉCRAN affiché DANS la conversation.
//
// ⚠️ C'est un ÉTAT TEMPORAIRE de l'interface — jamais un message, jamais dans
// l'historique (ni transcript, ni session, ni mémoire). Le bloc apparaît dans la
// conversation où la capture a été demandée, affiche l'image à l'HUMAIN, et
// disparaît dès que le fil est reconstruit (snapshot/rejeu) : le serveur ne
// l'envoie QUE par trames de contrôle.
//
// ⚠️ Le modèle ne reçoit JAMAIS l'image : elle n'est visible qu'ICI.
//
// Rendu PUREMENT DOM (`createElement`), AUCUN attribut de style en ligne,
// aucune injection HTML directe (CSP `style-src 'self'`). L'image utilise le
// MÊME chemin que le markdown : `isSafeImageSrc` (accepte `data:image/`) et la
// classe `.md-image`. Aucun élargissement de CSP n'est nécessaire
// (`img-src 'self' data:`).

import { isSafeImageSrc } from "./markdown.js";
import { machineLabel } from "./approval-block.js";

/** Petit constructeur DOM (attributs + enfants), sans injection HTML. */
function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
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

/** Taille lisible : « ~140 Ko », « 512 octets ». */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "taille inconnue";
  if (n < 1024) return `${Math.round(n)} octets`;
  return `~${Math.max(1, Math.round(n / 1024))} Ko`;
}

/** Badge de métadonnées : « 1280×720 · ~140 Ko ». */
export function screenshotMeta(shot) {
  const w = Number(shot?.width);
  const he = Number(shot?.height);
  const dims =
    Number.isFinite(w) && Number.isFinite(he) && w > 0 && he > 0 ? `${w}×${he}` : "dimensions inconnues";
  return `${dims} · ${formatBytes(shot?.bytes)}`;
}

/**
 * Gère l'affichage d'UNE capture dans `container` (`#conversation`).
 *
 * @param {object} deps
 * @param {HTMLElement} deps.container conteneur du fil.
 * @returns {{ show(shot: object): void, reset(): void }}
 */
export function createScreenshotBlocks({ container }) {
  if (!container) throw new Error("createScreenshotBlocks : conteneur absent");

  function buildImage(shot, label) {
    const src = typeof shot?.dataUrl === "string" ? shot.dataUrl : "";
    const alt = `Capture d'écran de ${label} (${screenshotMeta(shot)})`;
    // ⚠️ MÊME garde-fou que le markdown : seules les sources `data:image/…`
    // passent (jamais un domaine externe → aucun élargissement de CSP).
    if (isSafeImageSrc(src)) {
      const img = document.createElement("img");
      img.className = "md-image screenshot__image";
      img.src = src;
      img.alt = alt;
      img.loading = "lazy";
      return img;
    }
    const span = h("span", { class: "md-image md-image--placeholder", role: "img" }, [
      "image indisponible",
    ]);
    span.setAttribute("aria-label", alt);
    return span;
  }

  function build(shot) {
    const label = machineLabel(shot);
    const machineChildren = [h("span", { class: "screenshot__name", text: label })];
    if (label !== String(shot?.agentId ?? "")) {
      machineChildren.push(h("span", { class: "screenshot__agent-id", text: `id ${shot.agentId}` }));
    }
    return h(
      "div",
      {
        class: "screenshot",
        role: "group",
        "aria-label": "Capture d'écran",
      },
      [
        h("div", { class: "screenshot__head" }, [
          h("span", { class: "screenshot__title", text: "Capture d'écran" }),
          h("span", { class: "screenshot__machine" }, machineChildren),
          h("span", { class: "screenshot__badge", text: screenshotMeta(shot) }),
        ]),
        buildImage(shot, label),
        h("p", {
          class: "screenshot__note",
          text: "Capture temporaire, affichée à vous seul : elle n'est pas conservée dans l'historique de la conversation.",
        }),
      ],
    );
  }

  /** Affiche une capture dans le fil. */
  function show(shot) {
    if (!shot) return;
    container.appendChild(build(shot));
  }

  /** Retire TOUTES les captures (le fil est reconstruit depuis un snapshot). */
  function reset() {
    for (const el of [...container.querySelectorAll(".screenshot")]) el.remove();
  }

  return { show, reset };
}
