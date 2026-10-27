/**
 * NOMS DE FICHIERS — assainissement (PIÈGE ⑤).
 *
 * Un nom fourni par un client n'est JAMAIS utilisé comme chemin : l'identifiant
 * aléatoire est le seul nom sur disque. Il reste utilisé pour l'AFFICHAGE et
 * pour `Content-Disposition` ; il doit donc être neutralisé :
 *
 *  - `../`, `/`, `\` (traversée) : on ne garde que le DERNIER segment ;
 *  - caractères de contrôle (`Cc`, `Cf`, `Cn` : y compris les inversions
 *    bidirectionnelles qui réécrivent visuellement l'extension) ;
 *  - `.` / `..` (segments réservés) et noms vides ;
 *  - espaces et points en tête/queue (Windows les tronque silencieusement) ;
 *  - longueur extrême (borne d'affichage ET d'en-tête HTTP).
 *
 * L'extension retenue est une ALLOWLIST de forme (`[a-z0-9]{1,10}`), jamais un
 * chemin : c'est elle qui décide du service et du `Content-Disposition`.
 */

import { MAX_FILE_NAME_CHARS } from "./types.js";

/** Nom de repli quand rien d'exploitable ne subsiste. */
export const FALLBACK_FILE_NAME = "fichier";

/** Extension de repli (aucune extension exploitable). */
export const FALLBACK_EXT = "bin";

/** Caractères de contrôle et d'inversion bidirectionnelle à supprimer. */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Dernier segment d'un nom (les deux séparateurs sont traités, y compris sur
 * un nom venant d'un client Windows). `""` si le nom ne contient que des
 * séparateurs.
 */
export function lastPathSegment(raw: string): string {
  const slashed = raw.replace(/\\/g, "/");
  const parts = slashed.split("/");
  return parts[parts.length - 1] ?? "";
}

/**
 * Assainit un nom de fichier pour l'AFFICHAGE et le téléchargement.
 * Ne lève jamais ; renvoie toujours une chaîne non vide.
 */
export function sanitizeFileName(raw: string): string {
  const segment = lastPathSegment(typeof raw === "string" ? raw : "");
  const cleaned = segment
    .replace(UNSAFE_CHARS, "")
    // Les espaces multiples (dont les tabulations) sont ramenés à UN espace.
    .replace(/\s+/g, " ")
    .trim()
    // Points/espaces de tête et de queue : Windows les retire, ce qui changerait
    // silencieusement le nom affiché.
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (cleaned === "" || cleaned === "." || cleaned === "..") {
    return FALLBACK_FILE_NAME;
  }
  if (cleaned.length <= MAX_FILE_NAME_CHARS) return cleaned;
  // Troncature en préservant l'extension (elle porte le type du téléchargement).
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 ? cleaned.slice(dot) : "";
  const keep = Math.max(1, MAX_FILE_NAME_CHARS - ext.length);
  const head = cleaned.slice(0, keep).replace(/[.\s]+$/, "");
  return `${head === "" ? FALLBACK_FILE_NAME : head}${ext}`.slice(0, MAX_FILE_NAME_CHARS);
}

/** Extension normalisée d'un nom (`bin` si absente ou douteuse). */
export function extensionOf(name: string): string {
  const base = lastPathSegment(name);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return FALLBACK_EXT;
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : FALLBACK_EXT;
}

/**
 * Nom de fichier pour `Content-Disposition` (repli ASCII + forme `filename*`).
 * Aucun caractère de contrôle, aucun séparateur de chemin, aucun guillemet.
 */
export function contentDispositionName(name: string): {
  ascii: string;
  encoded: string;
} {
  const safe = sanitizeFileName(name);
  // Repli ASCII : tout ce qui n'est pas imprimable ASCII devient `_`.
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return { ascii, encoded: encodeURIComponent(safe) };
}
