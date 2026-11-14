/**
 * INJECTION DES CONSIGNES DURABLES — blocs `<consignes>` et `<faits>`.
 *
 * ⚠️ POSITION DANS LE PROMPT : **après** `</personnalite>` et **avant** le
 * prompt système du rôle. `<regles>` (règles communes) reste EN DERNIER et
 * prime : c'est l'ordre décidé le 2026-11-14, et il est inscrit ici, une seule
 * fois.
 *
 * ⚠️ TOUJOURS INJECTÉ, JAMAIS RECHERCHÉ : contrairement à la mémoire (rappel
 * pertinent au tour), ces listes sont **toujours** présentes. C'est même la
 * raison d'être du fichier : une consigne « ne fais plus jamais ça » qui
 * dépendrait d'un rappel ne serait pas respectée.
 *
 * ⚠️ LISTES VIDES ⇒ AUCUN BLOC (jamais un bloc vide dans le prompt).
 *
 * ⚠️ PLAFOND GLOBAL (`MAX_INJECTION_CHARS`) : au-delà, on tronque **en le disant
 * dans le prompt** — le modèle doit pouvoir répondre « il y en a plus que ce
 * que je vois ». Jamais une troncature silencieuse.
 *
 * Aucun import SDK/typebox : données pures, testable sans SDK.
 */

import {
  IDENTITY_TAG,
  PERSONALITY_TAG,
} from "../llm/prompt-systeme.js";

import {
  MAX_INJECTION_CHARS,
  type ConsignesDocument,
  type NatureEntree,
} from "./consignes.js";

/** Balise du bloc des consignes impératives. */
export const CONSIGNES_TAG = "consignes";
/** Balise du bloc des faits déclaratifs. */
export const FAITS_TAG = "faits";

/** Phrase d'ouverture de chaque bloc : elle dit la NATURE de la donnée. */
const ENTETE_BLOC: Readonly<Record<NatureEntree, string>> = {
  consigne:
    "Consignes DURABLES posées par l'utilisateur : elles s'appliquent à chaque " +
    "tour et priment sur vos habitudes. Ce ne sont pas des souvenirs de la mémoire.",
  fait:
    "Faits DURABLES à connaître à chaque tour (informations déclaratives, toujours " +
    "rappelées). Ce ne sont pas des souvenirs de la mémoire.",
};

/** Mention de troncature (elle est écrite DANS le prompt, jamais silencieuse). */
function mentionTroncature(nonInjectees: number, maxChars: number): string {
  return (
    `⚠️ ${nonInjectees} entrée(s) non injectée(s) : le plafond de ${maxChars} ` +
    "caractères est atteint. Demandez la liste complète pour les voir, ou " +
    "supprimez-en dans l'onglet Personnalité du bot."
  );
}

/** Une liste rendue en bloc balisé (vide ⇒ chaîne vide, jamais un bloc vide). */
function blocListe(nature: NatureEntree, entrees: readonly string[]): string {
  if (entrees.length === 0) return "";
  const tag = nature === "consigne" ? CONSIGNES_TAG : FAITS_TAG;
  return [
    `<${tag}>`,
    ENTETE_BLOC[nature],
    ...entrees.map((entree) => `- ${entree}`),
    `</${tag}>`,
  ].join("\n");
}

/**
 * Rendu des DEUX blocs pour des tranches données (sans plafond : le plafond est
 * appliqué par `blocsConsignes`, qui a besoin de mesurer).
 */
export function renduBlocs(
  consignes: readonly string[],
  faits: readonly string[],
  mention = "",
): string {
  const blocs = [blocListe("consigne", consignes), blocListe("fait", faits)].filter(
    (bloc) => bloc !== "",
  );
  if (mention !== "" && blocs.length > 0) blocs.push(mention);
  return blocs.join("\n\n");
}

/**
 * Blocs `<consignes>` + `<faits>` prêts à insérer, sous le plafond global.
 *
 * `document` vide ⇒ `""` (aucun bloc). Au-delà du plafond, les entrées en trop
 * sont retirées de la FIN (les plus anciennes restent) et la mention de
 * troncature DIT combien manquent.
 */
export function blocsConsignes(
  document: ConsignesDocument,
  maxChars: number = MAX_INJECTION_CHARS,
): string {
  const total = document.consignes.length + document.faits.length;
  if (total === 0) return "";
  const complet = renduBlocs(document.consignes, document.faits);
  if (Array.from(complet).length <= maxChars) return complet;
  // Recherche linéaire du plus grand préfixe qui tient, mention comprise.
  for (let gardees = total - 1; gardees >= 0; gardees -= 1) {
    const consignes = document.consignes.slice(
      0,
      Math.min(gardees, document.consignes.length),
    );
    const faits = document.faits.slice(
      0,
      Math.max(0, gardees - consignes.length),
    );
    const mention = mentionTroncature(total - gardees, maxChars);
    const essai = renduBlocs(consignes, faits, mention);
    if (Array.from(essai).length <= maxChars) return essai;
  }
  // Même vide, la mention dépasse le plafond : on la rend seule (elle est courte
  // et c'est la seule information utile).
  return mentionTroncature(total, maxChars);
}

/**
 * INSÈRE les blocs au bon endroit du prompt système du tour.
 *
 * Ordre visé : identité → personnalité → **consignes/faits** → prompt système →
 * outils. On s'ancre donc APRÈS le bloc de personnalité ; à défaut après
 * l'identité (il n'y a alors pas de personnalité composée) ; en dernier recours
 * en TÊTE du prompt (aucun bloc connu : un prompt nu, cas des tests et du
 * worker lourd).
 *
 * ⚠️ Aucune réécriture du prompt : les blocs existants sont laissés INTACTS.
 */
export function insererConsignes(prompt: string, blocs: string): string {
  const texte = blocs.trim();
  if (texte === "") return prompt;
  const base = prompt ?? "";
  const ancres = [`</${PERSONALITY_TAG}>`, `</${IDENTITY_TAG}>`];
  for (const ancre of ancres) {
    const position = base.lastIndexOf(ancre);
    if (position < 0) continue;
    const fin = position + ancre.length;
    const avant = base.slice(0, fin);
    const apres = base.slice(fin).replace(/^\s*/u, "");
    return apres === "" ? `${avant}\n\n${texte}` : `${avant}\n\n${texte}\n\n${apres}`;
  }
  return base.trim() === "" ? texte : `${texte}\n\n${base}`;
}
