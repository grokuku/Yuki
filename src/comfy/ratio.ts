/**
 * RATIO D'IMAGE — déduction des dimensions injectées (`YUKI_WIDTH`/`YUKI_HEIGHT`).
 *
 * ⚠️ LE DÉFAUT CORRIGÉ : Yuki n'écrivait QUE les dimensions des réglages
 * (`images.width` × `images.height`, un couple FIXE), quelle que soit la demande.
 * Un graphe qui déduit son format du ratio de l'image d'entrée (cas réel :
 * `FL_ImageBlank` → `AIHResolutionPresetV2` avec `use_image_ratio`) recevait donc
 * TOUJOURS un canevas carré : « ratio 16:9 » restait dans le TEXTE du prompt, et
 * le latent sortait carré.
 *
 * Ici, un ratio DEMANDÉ (« 16:9 », « 9:16 », « 3:2 »…) devient un couple de
 * dimensions qui CONSERVE le budget de pixels des réglages
 * (`images.width` × `images.height`) : la forme change, la quantité de pixels
 * non. Les côtés sont alignés sur un multiple de 16 (exigence des latents SD /
 * Flux, et condition pour que le preset du graphe retrouve le ratio demandé),
 * puis bornés comme les réglages (64 … 4096).
 *
 * Aucune valeur inventée : un ratio illisible est REFUSÉ explicitement
 * (`ComfyError` `invalid_ratio`), jamais remplacé en silence par un carré.
 */

import { ComfyError } from "./types.js";

/** Multiple d'alignement des côtés (latents SD/Flux). */
const SIDE_MULTIPLE = 16;

/** Bornes identiques à celles des réglages `images.width`/`images.height`. */
const MIN_SIDE = 64;
const MAX_SIDE = 4_096;

export interface AspectRatio {
  /** Largeur du ratio (numérateur). */
  width: number;
  /** Hauteur du ratio (dénominateur). */
  height: number;
}

/** Formes acceptées : « 16:9 », « 16/9 », « 16x9 », « 16 : 9 » (espaces tolérés). */
const RATIO_PATTERN = /^\s*(\d{1,4})\s*[:/xX]\s*(\d{1,4})\s*$/;

/**
 * Lit un ratio DEMANDÉ. Renvoie `undefined` si le texte n'est pas un ratio
 * exploitable (aucun repli silencieux : c'est à l'appelant de refuser).
 */
export function parseAspectRatio(text: unknown): AspectRatio | undefined {
  if (typeof text !== "string") return undefined;
  const match = RATIO_PATTERN.exec(text);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  // Un ratio démesuré (1:1000) n'a aucun sens pour une image : on refuse.
  const ratio = width / height;
  if (ratio < 0.1 || ratio > 10) return undefined;
  return { width, height };
}

/** Arrondit au multiple de 16 le plus proche, en restant dans les bornes. */
function snap(value: number): number {
  const snapped = Math.round(value / SIDE_MULTIPLE) * SIDE_MULTIPLE;
  return Math.max(MIN_SIDE, Math.min(MAX_SIDE, snapped));
}

/**
 * Dimensions pour un ratio, à budget de pixels CONSTANT.
 *
 * `base` = les dimensions des réglages (`images.width` × `images.height`) : leur
 * PRODUIT est le budget conservé. Exemple avec le défaut 1024×1024 (1 048 576 px)
 * et un ratio 16:9 : 1360×768 (≈ 1,04 Mpx, mêmes pixels que 1024×1024).
 *
 * @param ratio ratio demandé, déjà validé par `parseAspectRatio`.
 * @param base dimensions de référence (budget de pixels).
 * @returns dimensions alignées sur 16 et bornées.
 */
export function sizeForRatio(
  ratio: AspectRatio,
  base: { width: number; height: number },
): { width: number; height: number } {
  const area = Math.max(1, Math.round(base.width) * Math.round(base.height));
  const aspect = ratio.width / ratio.height;
  // w / h = aspect et w * h = area  ⇒  w = sqrt(area * aspect), h = area / w.
  const width = snap(Math.sqrt(area * aspect));
  const height = snap(Math.sqrt(area / aspect));
  return { width, height };
}

/**
 * Dimensions injectées pour un ratio DEMANDÉ, ou refus explicite.
 *
 * @throws {ComfyError} `invalid_ratio` si le ratio est illisible.
 */
export function sizeForRatioOrThrow(
  text: string,
  base: { width: number; height: number },
): { width: number; height: number } {
  const ratio = parseAspectRatio(text);
  if (!ratio) {
    throw new ComfyError(
      "invalid_ratio",
      `Le format « ${String(text).trim()} » n'est pas un ratio lisible : écris-le ` +
        "sous la forme largeur:hauteur (exemples : 16:9, 9:16, 4:3, 1:1).",
    );
  }
  return sizeForRatio(ratio, base);
}
