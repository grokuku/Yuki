// Yuki — CARTES de FICHIERS dans la conversation (envoi ET réception).
//
// ⚠️ Deux usages, un seul rendu :
//  1. les fichiers joints par l'UTILISATEUR : leur marqueur
//     `[fichier] <id> <nom> (<n> octets)` est DANS le message (donc dans le
//     transcript) → la carte survit au rechargement et reste à sa place ;
//  2. les fichiers ENVOYÉS PAR YUKI : trame de CONTRÔLE `file_sent` (aucun `seq`
//     consommé, jamais bufferisée) → carte affichée immédiatement.
//
// ⚠️ Aucun contenu de fichier n'est affiché : la carte porte le nom, la taille,
// le genre, un lien de TÉLÉCHARGEMENT (`/fichiers/<id>.<ext>`, same-origin,
// `Content-Disposition: attachment`) et, pour une IMAGE, un aperçu `<img>` dont
// la source reste `/fichiers/…` — donc `img-src 'self'` suffit : AUCUN
// élargissement de CSP.
//
// ⚠️ L'aperçu d'une IMAGE passe par la VISIONNEUSE partagée (`lightbox.js`,
// dépendance `zoom` INJECTÉE, comme `createScreenshotBlocks`) : la vignette est
// bornée en hauteur et s'ouvre en plein écran au clic. Sans `zoom` (dépendance
// facultative), l'image reste affichée telle quelle.
//
// Rendu PUREMENT DOM (`createElement`), jamais d'injection de balisage, aucun
// attribut de style en ligne (CSP `style-src 'self'`).

import { isSafeImageSrc } from "./markdown.js";
import { formatBytes } from "./screenshot-block.js";

/** Libellé du genre de fichier (français, jamais un code). */
const KIND_LABELS = {
  text: "texte",
  image: "image",
  pdf: "PDF",
  unknown: "format inconnu",
};

/**
 * Marqueur d'un fichier dans un message — ⚠️ format PARTAGÉ avec
 * `src/files/frame.ts` (`formatFileMarker`), verrouillé par un test.
 */
export function formatFileMarker(file) {
  const bytes = Number.isFinite(Number(file?.bytes))
    ? Math.max(0, Math.trunc(Number(file.bytes)))
    : 0;
  return `[fichier] ${file?.id ?? ""} ${file?.name ?? ""} (${bytes} octets)`;
}

/** Marqueur reconnu : identifiant hexadécimal 32 (impossible à confondre). */
const MARKER_RE = /^\[fichier\] ([a-f0-9]{32}) (.+) \((\d+) octets\)$/;

/** Extrait un fichier d'une ligne de marqueur, ou `null`. */
export function parseFileMarker(line) {
  const match = MARKER_RE.exec(String(line ?? "").trim());
  if (!match) return null;
  return { id: match[1], name: match[2], bytes: Number.parseInt(match[3], 10) };
}

/**
 * Sépare un texte de message de ses marqueurs de fichiers.
 *
 * @param {string} text texte du message (tel que stocké).
 * @returns {{ text: string, files: Array<{id: string, name: string, bytes: number}> }}
 *   `text` sans les lignes de marqueur, `files` dans l'ORDRE du message.
 */
export function parseMessageFiles(text) {
  const source = typeof text === "string" ? text : "";
  if (!source.includes("[fichier] ")) return { text: source, files: [] };
  const kept = [];
  const files = [];
  for (const line of source.split("\n")) {
    const file = parseFileMarker(line);
    if (file) files.push(file);
    else kept.push(line);
  }
  if (files.length === 0) return { text: source, files: [] };
  // Les lignes de marqueur étaient séparées par une ligne vide : on retire les
  // lignes vides de queue pour ne pas laisser un blanc fantôme.
  const cleaned = kept.join("\n").replace(/\s+$/, "");
  return { text: cleaned, files };
}

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

/** Badge de métadonnées : « image · ~140 Ko ». */
export function fileMeta(file) {
  const kind = KIND_LABELS[file?.kind] ?? "fichier";
  return `${kind} · ${formatBytes(file?.bytes)}`;
}

/** Extensions d'IMAGE affichables (mêmes que le service : `img-src 'self'`). */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

/** Extension normalisée d'un nom (`bin` si douteuse) — miroir du serveur. */
export function extensionOfName(name) {
  const base = String(name ?? "");
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "bin";
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : "bin";
}

/**
 * Complète une vue de fichier MINIMALE (issue d'un marqueur : identifiant, nom,
 * taille) avec ce qui se DÉDUIT du nom — le chemin de service et l'aperçu d'une
 * image.
 *
 * ⚠️ Le marqueur reste volontairement pauvre : il voyage dans le message. Le
 * serveur, lui, vérifie que l'extension du chemin CORRESPOND à la fiche ; déduire
 * l'URL du nom donne donc toujours une URL juste (ou un 404 honnête si le fichier
 * a expiré).
 */
export function completeFile(file) {
  if (!file || typeof file.id !== "string") return file;
  const ext = extensionOfName(file.name);
  const url =
    typeof file.url === "string" && file.url !== ""
      ? file.url
      : `/fichiers/${file.id}.${ext}`;
  const known = file.kind === "image" || file.kind === "text" || file.kind === "pdf" || file.kind === "unknown";
  const isImage = file.kind === "image" || (!known && IMAGE_EXTENSIONS.has(ext));
  return {
    ...file,
    url,
    ...(isImage ? { kind: "image", imageSrc: file.imageSrc ?? url } : {}),
  };
}

/**
 * Construit la carte d'UN fichier.
 *
 * @param {object} file vue du fichier (`id`, `name`, `bytes`, `kind`, `url`, `imageSrc`…).
 * @param {object} [options]
 * @param {"user"|"yuki"} [options.from] auteur de l'envoi (libellé de la carte).
 * @param {{ decorate(img: HTMLImageElement): HTMLElement }} [options.zoom]
 *   visionneuse partagée (`lightbox.js`) : enveloppe l'aperçu dans la vignette
 *   cliquable. Absente ⇒ l'image est affichée telle quelle (aucun zoom).
 * @returns {HTMLElement}
 */
export function createFileCard(rawFile, options = {}) {
  const from = options.from === "yuki" ? "yuki" : "user";
  const file = completeFile(rawFile);
  const name = String(file?.name ?? "fichier");
  const url = typeof file?.url === "string" ? file.url : "";
  const label = from === "yuki" ? "Fichier envoyé" : "Fichier joint";
  const children = [
    h("div", { class: "file-card__head" }, [
      h("span", { class: "file-card__title", text: label }),
      h("span", { class: "file-card__meta", text: fileMeta(file) }),
    ]),
    h("p", { class: "file-card__name", text: name }),
  ];
  // Aperçu : UNIQUEMENT une image servie en same-origin (`img-src 'self'`).
  // ⚠️ MÊME vignette cliquable que les images générées et les captures : on
  // passe l'image à `zoom.decorate` quand la visionneuse est fournie (patron
  // exact de `screenshot-block.js`).
  if (file?.kind === "image" && isSafeImageSrc(file.imageSrc ?? "")) {
    const img = document.createElement("img");
    img.className = "md-image file-card__image";
    img.src = file.imageSrc;
    img.alt = `Aperçu de l'image jointe « ${name} »`;
    img.loading = "lazy";
    children.push(options.zoom ? options.zoom.decorate(img) : img);
  }
  if (url !== "") {
    // `download` demande le TÉLÉCHARGEMENT (le serveur envoie de toute façon
    // `Content-Disposition: attachment` pour tout ce qui n'est pas une image).
    children.push(
      h(
        "a",
        {
          class: "file-card__download",
          href: url,
          download: name,
          rel: "noopener",
        },
        [h("span", { class: "file-card__download-label", text: "Télécharger" })],
      ),
    );
  }
  if (file?.readable === false && typeof file?.reason === "string") {
    // ⚠️ HONNÊTETÉ : quand Yuki ne peut pas lire le fichier, elle le DIT — ici,
    // à l'écran, comme dans le bloc transmis au modèle.
    children.push(h("p", { class: "file-card__note", text: file.reason }));
  }
  return h(
    "div",
    {
      class: `file-card file-card--${from}`,
      role: "group",
      "aria-label": `${label} : ${name}`,
    },
    children,
  );
}

/**
 * Gère l'affichage des fichiers ENVOYÉS PAR YUKI dans `container`
 * (`#conversation`). État ÉPHÉMÈRE : un snapshot/rejeu reconstruit le fil et
 * `reset()` retire les cartes (les fichiers joints par l'utilisateur, eux,
 * reviennent avec leur message).
 *
 * @param {object} deps
 * @param {HTMLElement} deps.container conteneur du fil.
 * @param {{ decorate(img: HTMLImageElement): HTMLElement }} [deps.zoom]
 *   visionneuse partagée (`lightbox.js`) : propagée aux cartes d'IMAGE.
 */
export function createFileBlocks({ container, zoom } = {}) {
  if (!container) throw new Error("createFileBlocks : conteneur absent");

  /** Affiche la carte d'un fichier envoyé par Yuki. */
  function show(file, options = {}) {
    if (!file) return;
    container.appendChild(
      createFileCard(file, { from: options.from ?? "yuki", zoom }),
    );
  }

  /** Retire les cartes ÉPHÉMÈRES (le fil est reconstruit depuis un snapshot). */
  function reset() {
    for (const el of [...container.querySelectorAll(".file-card--yuki")]) el.remove();
  }

  return { show, reset };
}
