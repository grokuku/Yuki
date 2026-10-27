// Yuki — bloc d'IMAGE GÉNÉRÉE affiché DANS la conversation.
//
// ⚠️ C'est un ÉTAT TEMPORAIRE de l'interface — jamais un message, jamais dans
// l'historique (ni transcript, ni session, ni mémoire). Le serveur ne l'envoie
// QUE par la trame de contrôle `image` (aucun `seq` consommé, jamais bufferisée) :
// le bloc apparaît dans la conversation où l'image a été demandée et disparaît
// dès que le fil est reconstruit (snapshot/rejeu).
//
// ⚠️ La source est un chemin SAME-ORIGIN (`/images/<id>.<ext>`, servi par le
// gateway) : `img-src 'self'` suffit, la CSP n'est JAMAIS élargie. Aucun octet
// d'image ne transite par la trame, et le nom de fichier renvoyé par ComfyUI
// n'est jamais exposé (l'identifiant est aléatoire côté serveur).
//
// ⚠️ Contrairement aux captures d'écran d'agents, cette image a AUSSI été
// transmise à Yuki : elle l'a vue et peut la juger ou régénérer.
//
// Rendu PUREMENT DOM (`createElement`), aucun attribut de style en ligne,
// aucune injection HTML directe (CSP `style-src 'self'`).

import { isSafeImageSrc } from "./markdown.js";
import { formatBytes } from "./screenshot-block.js";

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

/** Badge de métadonnées : « 1024×1024 · ~1,2 Mio » (jamais une valeur inventée). */
export function generatedImageMeta(image) {
  const width = Number(image?.width);
  const height = Number(image?.height);
  const dims =
    Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
      ? `${width}×${height}`
      : "dimensions inconnues";
  return `${dims} · ${formatBytes(image?.bytes)}`;
}

/**
 * Gère l'affichage des IMAGES GÉNÉRÉES dans `container` (`#conversation`).
 *
 * @param {object} deps
 * @param {HTMLElement} deps.container conteneur du fil.
 * @returns {{ show(image: object): void, reset(): void }}
 */
export function createImageBlocks({ container }) {
  if (!container) throw new Error("createImageBlocks : conteneur absent");

  function buildImage(image) {
    const src = typeof image?.imageSrc === "string" ? image.imageSrc : "";
    const alt = `Image générée (${generatedImageMeta(image)})`;
    // ⚠️ MÊME garde-fou que le markdown : seules les sources `data:image/…` et
    // les chemins de MÊME ORIGINE passent (jamais un domaine externe).
    if (isSafeImageSrc(src)) {
      const img = document.createElement("img");
      img.className = "md-image generated-image__image";
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

  function build(image) {
    return h(
      "div",
      {
        class: "generated-image",
        role: "group",
        "aria-label": "Image générée",
      },
      [
        h("div", { class: "generated-image__head" }, [
          h("span", { class: "generated-image__title", text: "Image générée" }),
          h("span", { class: "generated-image__badge", text: generatedImageMeta(image) }),
        ]),
        buildImage(image),
        h("p", {
          class: "generated-image__note",
          text:
            "Image produite par le serveur d'images, affichée ici et transmise à " +
            "Yuki ; elle n'est pas conservée dans l'historique de la conversation.",
        }),
      ],
    );
  }

  /** Affiche une image générée dans le fil. */
  function show(image) {
    if (!image) return;
    container.appendChild(build(image));
  }

  /** Retire TOUTES les images générées (le fil est reconstruit depuis un snapshot). */
  function reset() {
    for (const el of [...container.querySelectorAll(".generated-image")]) el.remove();
  }

  return { show, reset };
}
