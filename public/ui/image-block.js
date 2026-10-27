// Yuki — bloc d'IMAGE GÉNÉRÉE affiché DANS la conversation.
//
// ⚠️ CONSERVATION : l'image est écrite sur le disque de Yuki IMMÉDIATEMENT après
// sa récupération (ComfyUI peut purger son `temp/` quand il le veut) et gardée
// comme une PIÈCE JOINTE : même réglage (`files.retentionDays`), même purge. La
// carte revient donc après un RECHARGEMENT : le serveur la renvoie en trame de
// contrôle `image` dans les instants qui suivent le snapshot.
//
// ⚠️ La source est un chemin SAME-ORIGIN (`/images/<id>.<ext>`, servi par le
// gateway) : `img-src 'self'` suffit, la CSP n'est JAMAIS élargie. Aucun octet
// d'image ne transite par la trame, et le nom de fichier renvoyé par ComfyUI
// n'est jamais exposé (l'identifiant est aléatoire côté serveur).
//
// ⚠️ Contrairement aux captures d'écran d'agents, cette image a AUSSI été
// transmise à Yuki : elle l'a vue et peut la juger ou régénérer.
//
// ⚠️ FICHE SOUS L'IMAGE (PIÈGE ⑤) : le prompt final (`YUKI_FINAL_PROMPT`) et les
// métadonnées sont TOUJOURS rendus APRÈS l'image dans le DOM. Quand la fiche
// arrive APRÈS l'image (trame `image_final_prompt`), elle est insérée juste après
// l'élément qui porte l'image (la VIGNETTE cliquable, voir plus bas) : l'image
// n'est JAMAIS retirée, déplacée ni reconstruite — elle ne bouge pas d'un pixel.
//
// ⚠️ VIGNETTE CLIQUABLE : l'image est ENVELOPPÉE dans un bouton (`.md-image-zoom`,
// voir `lightbox.js`) qui la borne en hauteur (320 px sur bureau, 220 px sur
// téléphone — `styles.css`) et l'ouvre en PLEIN ÉCRAN au clic. Sans cette borne,
// une image de ~2500×2500 écrase le fil. Le bouton ne contient QUE l'image et un
// indice décoratif : les métadonnées et la fiche restent dans le bloc, sous
// l'image, et les sélecteurs `setFinalPrompt` en tiennent compte.
//
// ⚠️ PROMPT FINAL : affiché SOUS l'image, en LECTURE seule, REPLIÉ (`<details>`)
// et copiable avec le MÊME bouton que les blocs de code (`createCopyButton` du
// markdown — un seul mécanisme de copie). Le texte est inséré comme NŒUD TEXTE
// (`textContent`) : aucune injection HTML, donc aucune injection possible.
//
// Rendu PUREMENT DOM (`createElement`), aucun attribut de style en ligne,
// aucune injection HTML directe (CSP `style-src 'self'`).

import { createCopyButton, isSafeImageSrc } from "./markdown.js";
import { ZOOM_WRAPPER_CLASS } from "./lightbox.js";
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

/** Libellé accessible du bouton de copie du prompt final (jamais un silence). */
export const FINAL_PROMPT_COPY_LABEL = "Copier le prompt final";

/**
 * Bloc REPLIABLE du prompt final : lecture seule, copiable, borné.
 *
 * `null` s'il n'y a aucun texte (le bloc n'apparaît alors pas du tout : un
 * workflow sans `YUKI_FINAL_PROMPT` a exactement l'affichage d'avant).
 */
function buildFinalPrompt(finalPrompt) {
  const text = typeof finalPrompt?.text === "string" ? finalPrompt.text : "";
  if (text === "") return null;
  const rawTotal = Number(finalPrompt?.totalChars);
  const totalChars = Number.isFinite(rawTotal) && rawTotal >= text.length ? rawTotal : text.length;
  const truncated = finalPrompt?.truncated === true || totalChars > text.length;
  // ⚠️ NŒUD TEXTE : `textContent`, jamais une affectation de balisage (un prompt
  // final est du texte GÉNÉRÉ : il ne doit pouvoir ni casser le DOM ni exécuter
  // quoi que ce soit).
  const code = h("code", { text });
  const body = h("div", { class: "md-code-block generated-image__prompt-body" }, [
    h("pre", {}, [code]),
  ]);
  // MÊME bouton que les blocs de code (icône, clavier, repli `execCommand`).
  body.append(
    createCopyButton(code, document, {
      label: FINAL_PROMPT_COPY_LABEL,
      copiedLabel: "Prompt final copié !",
      failedLabel: "Copie impossible : sélectionnez le texte à la main",
    }),
  );
  return h("details", { class: "generated-image__prompt" }, [
    h("summary", {
      class: "generated-image__prompt-summary",
      text: `Prompt final (${totalChars} caractère${totalChars > 1 ? "s" : ""}) — afficher`,
    }),
    body,
    h("p", {
      class: "generated-image__prompt-note",
      text: truncated
        ? `Texte produit par le workflow, affiché en LECTURE seule et borné à ` +
          `${text.length} caractères sur ${totalChars}.`
        : "Texte produit par le workflow, affiché en LECTURE seule. C'est une " +
          "sortie du graphe : il n'est jamais réinjecté dedans.",
    }),
  ]);
}

/**
 * Gère l'affichage des IMAGES GÉNÉRÉES dans `container` (`#conversation`).
 *
 * @param {object} deps
 * @param {HTMLElement} deps.container conteneur du fil.
 * @param {{ decorate(img: HTMLImageElement): HTMLElement }} [deps.zoom]
 *   visionneuse partagée (`lightbox.js`) : enveloppe l'image dans la vignette
 *   cliquable. Absente ⇒ l'image est affichée telle quelle (aucun zoom).
 * @returns {{
 *   show(image: object): void,
 *   setFinalPrompt(id: string, finalPrompt: object): boolean,
 *   reset(): void,
 * }}
 */
export function createImageBlocks({ container, zoom } = {}) {
  if (!container) throw new Error("createImageBlocks : conteneur absent");

  /** Blocs par identifiant d'image (retrouver l'image à compléter, sans déplacer). */
  const blocks = new Map();

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
      // ⚠️ VIGNETTE : l'image est BORNÉE par le CSS et ouverte en plein écran au
      // clic. Le bouton l'enveloppe sans la copier : mêmes octets, même cache.
      return zoom ? zoom.decorate(img) : img;
    }
    const span = h("span", { class: "md-image md-image--placeholder", role: "img" }, [
      "image indisponible",
    ]);
    span.setAttribute("aria-label", alt);
    return span;
  }

  function build(image) {
    const id = typeof image?.id === "string" ? image.id : "";
    return h(
      "div",
      {
        class: "generated-image",
        role: "group",
        "aria-label": "Image générée",
        ...(id !== "" ? { "data-image-id": id } : {}),
      },
      [
        h("div", { class: "generated-image__head" }, [
          h("span", { class: "generated-image__title", text: "Image générée" }),
          h("span", { class: "generated-image__badge", text: generatedImageMeta(image) }),
        ]),
        // ⚠️ ORDRE DU DOM = ORDRE D'AFFICHAGE : image, PUIS fiche (sous l'image).
        // ⚠️ AUCUNE phrase de conservation : la durée de rétention et le service
        // same-origin sont des détails techniques déjà dits aux réglages. La
        // carte se contente de montrer l'image, sa taille et sa fiche.
        buildImage(image),
        buildFinalPrompt(image?.finalPrompt),
      ],
    );
  }

  /** Affiche une image générée dans le fil (idempotent par identifiant). */
  function show(image) {
    if (!image) return;
    const id = typeof image.id === "string" ? image.id : "";
    if (id !== "" && blocks.has(id)) return;
    const block = build(image);
    container.appendChild(block);
    if (id !== "") blocks.set(id, block);
  }

  /**
   * Complète une image DÉJÀ affichée par sa FICHE (prompt final arrivé APRÈS).
   *
   * ⚠️ L'image n'est NI retirée, NI déplacée, NI reconstruite : la fiche est
   * insérée JUSTE APRÈS l'élément qui porte l'image — la VIGNETTE cliquable
   * (`.md-image-zoom`) qui enveloppe l'image, ou l'`<img>` lui-même quand aucune
   * visionneuse n'est branchée — donc au-dessus de la note. Si la fiche était
   * déjà là, elle est remplacée SUR PLACE — toujours au même endroit.
   *
   * @returns {boolean} `true` si l'image existe et a été complétée.
   */
  function setFinalPrompt(id, finalPrompt) {
    if (typeof id !== "string" || id === "") return false;
    const block = blocks.get(id);
    if (!block) return false;
    const fiche = buildFinalPrompt(finalPrompt);
    if (!fiche) return false;
    const previous = block.querySelector(":scope > .generated-image__prompt");
    if (previous) {
      // Remplacement SUR PLACE : l'image ne bouge pas d'un pixel.
      previous.replaceWith(fiche);
      return true;
    }
    const image = block.querySelector(
      `:scope > .${ZOOM_WRAPPER_CLASS}, :scope > .generated-image__image`,
    );
    if (image) {
      // ⚠️ APRÈS l'image : la fiche ne pousse donc jamais l'image vers le bas.
      image.after(fiche);
    } else {
      block.append(fiche);
    }
    return true;
  }

  /** Retire TOUTES les images générées (le fil est reconstruit depuis un snapshot). */
  function reset() {
    for (const el of [...container.querySelectorAll(".generated-image")]) el.remove();
    blocks.clear();
  }

  return { show, setFinalPrompt, reset };
}
