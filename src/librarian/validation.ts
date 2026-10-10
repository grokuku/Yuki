/**
 * Validation LOCALE des composants de chemin d'archivage (`name`, `version`).
 *
 * ⚠️ Le libraire exige que `name` et `version` soient des COMPOSANTS DE CHEMIN
 * valides : ni « / », ni « \\ », ni « .. » (sinon 400). Cette validation est
 * faite AVANT tout appel réseau (donc jamais bloquante) et son message est
 * renvoyé TEL QUEL au modèle, qui doit le relayer à l'utilisateur.
 *
 * Ce module fournit aussi `validateCaptureUrl` : `file://` et les chemins
 * locaux ne sont PAS exposés par Libry (sécurité) ⇒ on refuse AVANT l'appel.
 */

/** Longueur maximale d'un composant de chemin accepté. */
export const MAX_PATH_COMPONENT_CHARS = 128;

export type PathComponentValidation =
  | { ok: true; value: string }
  | {
      ok: false;
      code: "empty" | "separator" | "dotdot" | "too_long" | "control";
      message: string;
    };

/**
 * Valide un composant de chemin (`name` ou `version`).
 *
 * Règles (alignées sur le contrat du libraire) :
 *  - non vide après rognage ;
 *  - aucun « / » ni « \\ » (pas de traversée de dossier) ;
 *  - aucune occurrence de « .. » ;
 *  - aucun caractère de contrôle ;
 *  - au plus `MAX_PATH_COMPONENT_CHARS` caractères.
 */
export function validatePathComponent(
  raw: unknown,
  label: string,
): PathComponentValidation {
  if (typeof raw !== "string") {
    return {
      ok: false,
      code: "empty",
      message: `${label} est obligatoire (texte non vide attendu).`,
    };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, code: "empty", message: `${label} est obligatoire (texte non vide).` };
  }
  if (value.length > MAX_PATH_COMPONENT_CHARS) {
    return {
      ok: false,
      code: "too_long",
      message: `${label} est trop long (maximum ${MAX_PATH_COMPONENT_CHARS} caractères).`,
    };
  }
  if (/[/\\]/.test(value)) {
    return {
      ok: false,
      code: "separator",
      message: `${label} ne doit contenir aucun « / » ni « \\ » (composant de chemin valide exigé).`,
    };
  }
  if (value.includes("..")) {
    return {
      ok: false,
      code: "dotdot",
      message: `${label} ne doit contenir aucune suite « .. » (composant de chemin valide exigé).`,
    };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return {
      ok: false,
      code: "control",
      message: `${label} ne doit contenir aucun caractère de contrôle.`,
    };
  }
  return { ok: true, value };
}

/** Longueur maximale d'une URL de capture acceptée. */
export const MAX_CAPTURE_URL_CHARS = 2_048;

export type CaptureUrlValidation =
  | { ok: true; value: string }
  | { ok: false; code: "empty" | "not_string" | "control" | "too_long" | "scheme"; message: string };

/**
 * Valide une URL de CAPTURE de page web.
 *
 * Règles (alignées sur le contrat de Libry) :
 *  - texte non vide, au plus `MAX_CAPTURE_URL_CHARS` caractères ;
 *  - aucun caractère de contrôle ;
 *  - schéma `http` ou `https` OBLIGATOIRE (⚠️ `file://` et les chemins locaux
 *    ne sont PAS exposés pour raison de sécurité).
 */
export function validateCaptureUrl(raw: unknown): CaptureUrlValidation {
  if (typeof raw !== "string") {
    return { ok: false, code: "not_string", message: "« url » est obligatoire (texte attendu)." };
  }
  const value = raw.trim();
  if (value.length === 0) {
    return { ok: false, code: "empty", message: "« url » est obligatoire (texte non vide)." };
  }
  if (value.length > MAX_CAPTURE_URL_CHARS) {
    return {
      ok: false,
      code: "too_long",
      message: `« url » est trop longue (maximum ${MAX_CAPTURE_URL_CHARS} caractères).`,
    };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, code: "control", message: "« url » ne doit contenir aucun caractère de contrôle." };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, code: "scheme", message: "« url » n'est pas une URL valide (http/https attendu)." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      code: "scheme",
      message: "« url » doit commencer par http:// ou https:// (les fichiers locaux ne sont pas capturables).",
    };
  }
  if (parsed.hostname === "") {
    return { ok: false, code: "scheme", message: "« url » n'a pas d'hôte (http/https attendu)." };
  }
  return { ok: true, value: parsed.toString() };
}
