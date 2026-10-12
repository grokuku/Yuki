/**
 * Filtre DÉTERMINISTE de la mémoire durable (Lot 14) — MODULE PUR.
 *
 * ⚠️ PRINCIPE : ce qui ne doit JAMAIS devenir un souvenir ne doit même pas être
 * SOUMIS au modèle d'extraction. Le filtre est du CODE (pas une consigne, donc
 * pas un jugement faillible) : une sortie d'outil encadrée n'atteint JAMAIS le
 * modèle qui décide.
 *
 * Sont écartés, avant toute construction de prompt :
 *  - les CADRAGES de données techniques : `<sortie …>` (sortie de commande),
 *    `<libraire …>`, `<agents_disponibles …>`, `<regles …>`, `<personnalite …>`,
 *    `<vie_anterieure …>` — blocs ET leur rappel de sécurité ;
 *  - les PROMPTS SYNTHÉTIQUES (`[RÉSULTAT DE TÂCHE EN ARRIÈRE-PLAN]`,
 *    `[RÉSULTAT DE COMMANDE VALIDÉE]`) : rapport de tâche, résultat d'exécution.
 *
 * ⚠️ HONNÊTETÉ : le filtre ne rattrape PAS la paraphrase. Un modèle qui RÉSUME
 * un `ls` dans sa réponse (« la commande a listé 42 fichiers… ») produit un texte
 * ordinaire : aucune balise ne le distingue. C'est l'inverse du filtre (la
 * consigne d'extraction « n'écris que si ça durera ») qui borne ce cas.
 *
 * ⚠️ Ce module (comme tout `src/memory/**`) n'importe NI le SDK Pi NI `typebox`.
 * Il n'importe que des CONSTANTES de cadrage (pures) pour rester aligné sur les
 * balises RÉELLEMENT émises par le reste du code (aucune recopie à main levée).
 */

import { AGENT_LIST_TAG, SORTIE_TAG } from "../agents/output.js";
import { LIBRARIAN_TAG } from "../librarian/output.js";
import { PERSONALITY_TAG } from "../personality/personality.js";
import { SYNTHETIC_USER_PREFIXES } from "../pi/synthetic.js";
import { RULES_TAG } from "../rules/rules.js";
import { HERITAGE_TAG } from "./heritage.js";

/**
 * Balises dont le CONTENU est une donnée technique encadrée (jamais un
 * souvenir). Aligné sur les constantes émises par les modules concernés.
 */
export const EXCLUDED_FRAME_TAGS: readonly string[] = [
  SORTIE_TAG,
  AGENT_LIST_TAG,
  LIBRARIAN_TAG,
  RULES_TAG,
  PERSONALITY_TAG,
  HERITAGE_TAG,
];

/** Préfixes des prompts SYNTHÉTIQUES (jamais mémorisés) — source unique. */
export const EXCLUDED_PROMPT_PREFIXES: readonly string[] = SYNTHETIC_USER_PREFIXES;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TAG_ALTERNATION = EXCLUDED_FRAME_TAGS.map(escapeRegExp).join("|");

/** Bloc encadré COMPLET : `<balise …>…</balise>` (attributs optionnels). */
const FRAME_BLOCK_RE = new RegExp(
  `<(${TAG_ALTERNATION})(?:\\s[^>]*)?>[\\s\\S]*?<\\/\\1>`,
  "gi",
);

/** Rappel de sécurité qui suit chaque bloc (« ⚠️ Le bloc <balise> ci-dessus… »). */
const FRAME_REMINDER_RE = /^[^\S\n]*⚠️[^\S\n]*Le bloc[^\S\n]*<[a-z_]+>[^\n]*$/gim;

/** Bloc encadré NON refermé (sortie tronquée) : de l'ouverture jusqu'à la fin. */
const FRAME_OPEN_RE = new RegExp(
  `<(?:${TAG_ALTERNATION})(?:\\s[^>]*)?>[\\s\\S]*$`,
  "i",
);

/**
 * Retire d'un texte les blocs encadrés exclus et leurs rappels. Ne touche PAS au
 * texte ordinaire (un `<` isolé reste intact). Renvoie le texte nettoyé, borné
 * aux espaces de bord.
 */
export function stripExcludedMemoryBlocks(text: string): string {
  if (typeof text !== "string" || text.length === 0) return "";
  let cleaned = text.replace(FRAME_BLOCK_RE, " ");
  cleaned = cleaned.replace(FRAME_REMINDER_RE, " ");
  cleaned = cleaned.replace(FRAME_OPEN_RE, " ");
  return cleaned.trim();
}

/**
 * Normalise un texte candidat AVANT extraction :
 *  - un prompt SYNTHÉTIQUE (rapport/validation) ⇒ chaîne vide (jamais soumis) ;
 *  - les blocs encadrés exclus sont retirés ;
 *  - le texte ordinaire est conservé intégralement.
 */
export function sanitizeMemoryText(text: string): string {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  for (const prefix of EXCLUDED_PROMPT_PREFIXES) {
    if (prefix.length > 0 && trimmed.startsWith(prefix)) return "";
  }
  return stripExcludedMemoryBlocks(trimmed);
}

/** `true` si le texte, une fois nettoyé, ne contient PLUS rien d'exploitable. */
export function isExcludedMemoryText(text: string): boolean {
  return sanitizeMemoryText(text).length === 0;
}
