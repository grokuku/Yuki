/**
 * Validation LOCALE des composants de chemin d'archivage (`name`, `version`).
 *
 * ⚠️ Le libraire exige que `name` et `version` soient des COMPOSANTS DE CHEMIN
 * valides : ni « / », ni « \\ », ni « .. » (sinon 400). Cette validation est
 * faite AVANT tout appel réseau (donc jamais bloquante) et son message est
 * renvoyé TEL QUEL au modèle, qui doit le relayer à l'utilisateur.
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
