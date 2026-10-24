/**
 * Déduplication DÉTERMINISTE de la mémoire (passe de mise de côté).
 *
 * ⚠️ PROBLÈME RÉEL : les tours d'une conversation écrivent DÉJÀ à chaud
 * (`onTurnEnd`). Une passe qui relit la conversation ENTIÈRE va donc retrouver
 * les mêmes choses ; sans garde-fou, la mémoire se remplit de DOUBLONS et le
 * rappel se dégrade (budget de caractères consommé par des redites).
 *
 * Trois barrières, dans cet ordre :
 *  1. le PROMPT fournit les souvenirs existants au modèle, qui peut alors
 *     FUSIONNER (`update`) au lieu de dupliquer — voir `buildConsolidationPrompt` ;
 *  2. le STORE refuse une entrée au texte identique (empreinte `foldText`) ;
 *  3. ce module : refus des QUASI-doublons — une reformulation (« L'utilisateur
 *     préfère le thé » vs « L'utilisateur préfère le thé au café ») qui n'apporte
 *     quasiment aucun mot nouveau est ÉCARTÉE (le code décide, pas le modèle).
 *
 * ⚠️ HONNÊTETÉ : la mesure est LEXICALE (recouvrement de mots ≥ 3 lettres,
 * casse/accents repliés). Elle attrape les reformulations proches et laisse
 * passer les VRAIES nouveautés (« habite à Rennes » vs « habite à Nantes » ne
 * sont PAS des doublons). C'est volontairement conservateur : on préfère ne pas
 * écrire que dupliquer.
 *
 * Aucun import SDK/typebox.
 */

import { foldText } from "./normalize.js";

/** Part des mots du candidat déjà présents dans un souvenir existant. */
export const NEAR_DUPLICATE_CONTAINMENT = 0.8;
/** En dessous de ce nombre de mots significatifs, aucune comparaison n'est faite. */
export const NEAR_DUPLICATE_MIN_TOKENS = 3;

/** Souvenir existant minimal pour la comparaison. */
export interface DedupEntry {
  id: string;
  text: string;
}

export interface NearDuplicateMatch {
  id: string;
  text: string;
  /** Part des mots du candidat déjà couverts par le souvenir existant (0–1). */
  containment: number;
}

/**
 * Mots SIGNIFICATIFS d'un souvenir (repliés, ≥ 3 caractères, dédupliqués).
 * Les mots trop courts (« au », « de », « et ») sont ignorés : ils créeraient
 * des faux positifs sans porter de sens.
 */
export function memoryTokens(text: string, minLength = 3): string[] {
  const tokens = new Set<string>();
  for (const raw of foldText(text).split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < minLength) continue;
    tokens.add(raw);
  }
  return [...tokens];
}

/**
 * `true` si `candidate` n'apporte RIEN de neuf par rapport à `existing` : au
 * moins `NEAR_DUPLICATE_CONTAINMENT` de ses mots significatifs y figurent déjà.
 */
export function isNearDuplicate(
  candidate: string,
  existing: string,
  options: { threshold?: number; minTokens?: number } = {},
): boolean {
  return findNearDuplicate(candidate, [{ id: "", text: existing }], options) !== undefined;
}

/**
 * Cherche un QUASI-doublon du candidat parmi les souvenirs existants. Renvoie le
 * plus proche (recouvrement maximal), ou `undefined` si le candidat apporte du
 * neuf.
 */
export function findNearDuplicate(
  candidate: string,
  existing: readonly DedupEntry[],
  options: { threshold?: number; minTokens?: number } = {},
): NearDuplicateMatch | undefined {
  const threshold = options.threshold ?? NEAR_DUPLICATE_CONTAINMENT;
  const minTokens = options.minTokens ?? NEAR_DUPLICATE_MIN_TOKENS;
  const candidateTokens = memoryTokens(candidate);
  if (candidateTokens.length < minTokens) return undefined;
  let best: NearDuplicateMatch | undefined;
  for (const entry of existing) {
    const existingTokens = new Set(memoryTokens(entry.text));
    if (existingTokens.size < minTokens) continue;
    let shared = 0;
    for (const token of candidateTokens) {
      if (existingTokens.has(token)) shared += 1;
    }
    const containment = shared / candidateTokens.length;
    if (containment < threshold) continue;
    if (!best || containment > best.containment) {
      best = { id: entry.id, text: entry.text, containment };
    }
  }
  return best;
}
