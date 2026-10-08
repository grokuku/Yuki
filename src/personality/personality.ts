/**
 * Personnalité de Yuki — RÈGLES PURES (bornes, format du bloc injecté).
 *
 * La personnalité est la **BASE** du prompt de chaque tour : elle vit dans un
 * fichier SÉPARÉ (jamais dans `prompts.light`, la base de sûreté) et est
 * encadrée par un délimiteur explicite avant d'être concaténée au prompt du
 * tour.
 */

/** Borne DURE du contenu de personnalité (décision utilisateur : 8 000 caractères). */
export const PERSONALITY_MAX_CHARS = 8_000;
/** Nombre de versions conservées dans l'historique (décision utilisateur : 20). */
export const PERSONALITY_HISTORY_MAX = 20;
/** Nom du fichier de personnalité (dans le volume `state`). */
export const PERSONALITY_FILE_NAME = "personality.md";
/** Sous-dossier des snapshots horodatés. */
export const PERSONALITY_HISTORY_DIR_NAME = "personality-history";
/** Journal append-only des écritures (avant/après, source, horodatage). */
export const PERSONALITY_JOURNAL_FILE_NAME = "personality-journal.jsonl";
/** Balise d'encadrement du bloc de personnalité injecté dans le prompt. */
export const PERSONALITY_TAG = "personnalite";

/**
 * En-tête du bloc injecté. Explicite sur la NATURE du contenu : c'est
 * l'IDENTITÉ de Yuki (sa base), à la différence de la mémoire (données
 * factuelles) et de l'annuaire (données machines).
 */
export const PERSONALITY_BLOCK_HEADER = [
  "## Personnalité de Yuki",
  "Le texte encadré ci-dessous décrit QUI est Yuki et COMMENT elle s'exprime.",
  "C'est sa base d'identité : incarnez-la comme votre propre voix.",
].join("\n");

/** Résultat de la normalisation d'un texte de personnalité à la borne. */
export interface ClampedPersonality {
  /** Contenu borné (au plus `max` points de code). */
  text: string;
  /** Nombre de points de code du contenu borné. */
  chars: number;
  /** `true` si le texte fourni dépassait la borne et a été tronqué. */
  truncated: boolean;
}

/**
 * Borne un texte de personnalité à `max` **points de code** (un emoji = un
 * caractère, pas deux). Le débordement est SIGNALÉ (`truncated`), jamais
 * silencieux.
 */
export function clampPersonalityText(
  text: string,
  max: number = PERSONALITY_MAX_CHARS,
): ClampedPersonality {
  const codePoints = Array.from(text);
  if (codePoints.length <= max) {
    return { text, chars: codePoints.length, truncated: false };
  }
  return {
    text: codePoints.slice(0, max).join(""),
    chars: max,
    truncated: true,
  };
}

/**
 * Encadre la personnalité dans le bloc injecté au prompt système du tour.
 * Renvoie une chaîne VIDE si le contenu est vide (⇒ RIEN n'est injecté : pas de
 * bloc vide). Le contenu est du Markdown de CONFIANCE (l'utilisateur l'édite),
 * donc NON échappé — le balisage Markdown doit rester interprétable.
 */
export function framePersonality(text: string): string {
  if (text.trim().length === 0) return "";
  return [
    PERSONALITY_BLOCK_HEADER,
    "",
    `<${PERSONALITY_TAG}>`,
    text,
    `</${PERSONALITY_TAG}>`,
  ].join("\n");
}
