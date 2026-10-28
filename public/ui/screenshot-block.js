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
// ⚠️ MÊME VIGNETTE que les images générées : une capture est ENVELOPPÉE dans le
// bouton `.md-image-zoom` (`lightbox.js`) — bornée en hauteur (320 px bureau,
// 220 px téléphone) et ouverte en PLEIN ÉCRAN au clic. Les deux familles d'images
// du fil (`/captures/` et `/images/`) se comportent donc EXACTEMENT pareil
// (PIÈGE ⑤).
//
// Rendu PUREMENT DOM (`createElement`), AUCUN attribut de style en ligne,
// aucune injection HTML directe (CSP `style-src 'self'`). L'image utilise le
// MÊME chemin que le markdown : `isSafeImageSrc` (accepte `data:image/`) et la
// classe `.md-image`. Aucun élargissement de CSP n'est nécessaire
// (`img-src 'self' data:`).

import { isSafeImageSrc } from "./markdown.js";
import { machineLabel } from "./approval-window.js";

/** Petit constructeur DOM (attributs + enfants), sans injection HTML. */
function h(tag, props = {}, children = []) {  const el = document.createElement(tag);
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
export function formatBytes(bytes) {  const n = Number(bytes);
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

/** Hôte lisible d'une URL (repli : chaîne vide). */
function hostOf(url) {
  if (typeof url !== "string" || url === "") return "";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Gère l'affichage d'UNE capture dans `container` (`#conversation`).
 *
 * @param {object} deps
 * @param {HTMLElement} deps.container conteneur du fil.
 * @param {{ decorate(img: HTMLImageElement): HTMLElement }} [deps.zoom]
 *   visionneuse partagée (`lightbox.js`) : enveloppe l'image dans la vignette
 *   cliquable. Absente ⇒ l'image est affichée telle quelle (aucun zoom).
 * @returns {{ show(shot: object, options?: { before?: Node|null }): void, reset(): void }}
 */
export function createScreenshotBlocks({ container, zoom } = {}) {
  if (!container) throw new Error("createScreenshotBlocks : conteneur absent");
  /**
   * Blocs déjà affichés, par CLÉ d'identité (aucun identifiant n'est fourni par le
   * serveur) : une même capture ré-émise ne doit jamais apparaître deux fois.
   */
  const blocks = new Map();

  /** Clé d'identité d'une capture : qui l'a prise, où et quand. */
  function keyOf(shot) {
    const agent = String(shot?.agentId ?? "");
    const at = String(shot?.capturedAt ?? "");
    const url = String(shot?.url ?? "");
    const src = String(shot?.dataUrl ?? "");
    return `${agent}|${at}|${url}|${src.length}`;
  }

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
      // ⚠️ MÊME vignette cliquable que les images générées (`lightbox.js`).
      return zoom ? zoom.decorate(img) : img;
    }
    const span = h("span", { class: "md-image md-image--placeholder", role: "img" }, [
      "image indisponible",
    ]);
    span.setAttribute("aria-label", alt);
    return span;
  }

  function build(shot) {
    const isWeb = shot?.source === "web";
    if (isWeb) {
      const host = hostOf(shot?.url) || String(shot?.agentId ?? "");
      return h(
        "div",
        {
          class: "screenshot",
          role: "group",
          "aria-label": "Capture de page web",
        },
        [
          h("div", { class: "screenshot__head" }, [
            h("span", { class: "screenshot__title", text: "Capture de page web" }),
            h("span", { class: "screenshot__machine" }, [
              h("span", { class: "screenshot__name", text: host }),
            ]),
            h("span", { class: "screenshot__badge", text: screenshotMeta(shot) }),
          ]),
          buildImage(shot, host),
          h("p", {
            class: "screenshot__note",
            // ⚠️ Une capture de PAGE WEB est CONSERVÉE (même rétention que les
            // pièces jointes) : elle revient après un rechargement. Seules les
            // captures d'une MACHINE restent temporaires (jamais écrites sur le
            // disque de Yuki).
            text:
              "Capture d'une page web, affichée ici et transmise à Yuki ; elle est " +
              "conservée avec la conversation (même durée que les pièces jointes) et " +
              "reste affichée après un rechargement.",
          }),
        ],
      );
    }
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

  /**
   * Affiche une capture dans le fil.
   *
   * @param {object} shot vue de capture.
   * @param {object} [options]
   * @param {Node|null} [options.before] nœud devant lequel insérer : après un
   *   rechargement, la capture est ré-émise APRÈS le snapshot (fil déjà complet)
   *   et doit retrouver sa place CHRONOLOGIQUE, jamais la fin du fil.
   */
  function show(shot, options = {}) {
    if (!shot) return;
    const key = keyOf(shot);
    if (blocks.has(key)) return;
    const block = build(shot);
    const before = options && options.before ? options.before : null;
    if (before && before.parentNode === container) container.insertBefore(block, before);
    else container.appendChild(block);
    blocks.set(key, block);
  }

  /** Retire TOUTES les captures (le fil est reconstruit depuis un snapshot). */
  function reset() {
    for (const el of [...container.querySelectorAll(".screenshot")]) el.remove();
    blocks.clear();
  }

  return { show, reset };
}
