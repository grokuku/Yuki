/**
 * Règles STRICTES de Yuki — RÈGLES PURES (bornes, format du bloc injecté).
 *
 * ⚠️ Ce ne sont PAS des choses « réglables dans le code » : le fichier
 * `rules.md` démarre VIDE et c'est l'UTILISATEUR qui le rédige. Ces règles sont
 * des CONSIGNES (posées sur Yuki), pas des garanties : AUCUN câblage
 * d'interdiction ne les accompagne — on ne bloque aucun outil, on n'ajoute
 * aucun refus. Elles sont injectées EN PREMIER, AVANT la personnalité.
 */

import { clampText } from "../state/text-document-store.js";

/** Borne DURE du contenu de règles (même limite que la personnalité : 8 000). */
export const RULES_MAX_CHARS = 8_000;
/** Nombre de versions conservées dans l'historique (comme la personnalité : 20). */
export const RULES_HISTORY_MAX = 20;
/** Nom du fichier de règles (dans le volume `state`, voisin de `personality.md`). */
export const RULES_FILE_NAME = "rules.md";
/** Sous-dossier des snapshots horodatés. */
export const RULES_HISTORY_DIR_NAME = "rules-history";
/** Journal append-only des écritures (avant/après, source, horodatage). */
export const RULES_JOURNAL_FILE_NAME = "rules-journal.jsonl";
/** Balise d'encadrement du bloc de règles injecté dans le prompt. */
export const RULES_TAG = "regles";

/**
 * En-tête du bloc injecté. Explicite sur la NATURE du contenu : ce sont des
 * CONSIGNES posées par l'utilisateur, ABSOLUES et non modifiables par Yuki, qui
 * PRIMENT sur la personnalité et la mémoire en cas de conflit.
 */
export const RULES_BLOCK_HEADER = [
  "## Règles strictes de l'utilisateur",
  "Les consignes encadrées ci-dessous sont définies par l'utilisateur. Elles sont ABSOLUES, NON NÉGOCIABLES et NON MODIFIABLES : vous ne pouvez ni les éditer, ni les contourner, ni les ignorer.",
  "Priorité en cas de conflit : ces règles PRIMENT sur votre personnalité, qui prime elle-même sur votre mémoire.",
].join("\n");

/** Résultat de la normalisation d'un texte de règles à la borne. */
export interface ClampedRules {
  /** Contenu borné (au plus `max` points de code). */
  text: string;
  /** Nombre de points de code du contenu borné. */
  chars: number;
  /** `true` si le texte fourni dépassait la borne et a été tronqué. */
  truncated: boolean;
}

/**
 * Borne un texte de règles à `max` points de code. Le débordement est SIGNALÉ
 * (`truncated`), jamais silencieux (socle partagé `clampText`).
 */
export function clampRulesText(
  text: string,
  max: number = RULES_MAX_CHARS,
): ClampedRules {
  return clampText(text, max);
}

/**
 * Encadre les règles dans le bloc injecté au prompt système du tour. Renvoie
 * une chaîne VIDE si le contenu est vide (⇒ RIEN n'est injecté : pas d'en-tête
 * orphelin). Le contenu est du Markdown de CONFIANCE (l'utilisateur l'édite),
 * donc NON échappé.
 */
export function frameRules(text: string): string {
  if (text.trim().length === 0) return "";
  return [RULES_BLOCK_HEADER, "", `<${RULES_TAG}>`, text, `</${RULES_TAG}>`].join("\n");
}
