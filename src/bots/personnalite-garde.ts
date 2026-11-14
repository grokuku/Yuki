/**
 * GARDE FORTE — un bot ne parle JAMAIS avec la personnalité d'un AUTRE bot.
 *
 * ⚠️ LE BUG QU'ELLE FERME (2026-11-14) : `grolaf` avait « Tu es Grolaf, une
 * conscience numérique… » enregistré, le badge disait « à chaud », et il répondait
 * « je suis Yuki ». La cascade de résolution peut remonter au fichier HISTORIQUE
 * d'instance (`<state>/personality.md`), qui est le texte de Yuki : un bot sans
 * valeur propre héritait donc, sans le dire, du texte d'un autre bot.
 *
 * ⚠️ POURQUOI UN REFUS ET PAS UN AVERTISSEMENT : un texte d'identité faux ne se
 * corrige pas en aval. Le modèle lit « tu es Yuki » et le répète à la personne qui
 * parle à Grolaf. On préfère un prompt SANS bloc de personnalité (l'identité, elle,
 * reste celle du bot) à un prompt qui affirme une fausse identité — et le journal
 * le DIT, avec l'action à faire.
 *
 * ⚠️ CE QUI N'EST JAMAIS REFUSÉ : une source EXPLICITE du bot (son champ
 * `prompts.personnalite`, son propre fichier `personality.md`). Si l'utilisateur a
 * délibérément collé le même texte dans deux bots, c'est son droit : le prompt
 * n'est pas un accident de résolution.
 *
 * Données pures : aucun accès disque, aucun import SDK.
 */

import type { ProvenancePersonnalite } from "../personality/personality.js";

/** Personnalité connue d'un AUTRE bot (pour comparaison). */
export interface PersonnaliteConnue {
  readonly botId: string;
  readonly texte: string;
}

export interface EntreeGardePersonnalite {
  /** Bot dont on compose le prompt. */
  readonly botId: string;
  /** Texte RETENU par la résolution. */
  readonly texte: string;
  /**
   * Provenance de ce texte (`bot`/`fichier-bot` = sources EXPLICITES du bot,
   * `fichier-instance`/`defaut` = replis).
   */
  readonly provenance: ProvenancePersonnalite;
  /** Personnalités connues des autres bots. */
  readonly autres: readonly PersonnaliteConnue[];
}

export interface VerdictGardePersonnalite {
  /** Texte à injecter (`""` quand la garde a refusé : aucun bloc de personnalité). */
  readonly texte: string;
  /** Bot dont le texte a été refusé (`undefined` quand rien n'a été refusé). */
  readonly refus?: { readonly autreBot: string; readonly provenance: ProvenancePersonnalite };
}

/**
 * Longueur minimale (caractères normalisés) pour qu'une égalité soit tenue pour
 * une vraie reprise de texte : « Réponds court. » est un réglage banal que deux
 * bots peuvent partager, ce n'est pas une identité empruntée.
 */
export const LONGUEUR_MIN_PERSONNALITE_COMPAREE = 40;

/** Compacte un texte pour comparer des contenus (blancs, casse). */
function normaliser(texte: string): string {
  return texte.replace(/\s+/gu, " ").trim().toLowerCase();
}

/** Le texte vient-il d'une source EXPLICITE du bot (jamais refusée) ? */
function sourceExpliciteDuBot(provenance: ProvenancePersonnalite): boolean {
  return provenance === "bot" || provenance === "fichier-bot";
}

/**
 * Applique la garde : rend le texte à injecter, ou `""` + le refus motivé.
 *
 * ⚠️ On ne compare QUE des textes assez longs (une identité, pas une consigne
 * courte) et seulement quand la source n'est PAS explicite pour ce bot.
 */
export function refuserPersonnaliteEtrangere(
  entree: EntreeGardePersonnalite,
): VerdictGardePersonnalite {
  const texte = entree.texte;
  const normalise = normaliser(texte);
  if (
    normalise === "" ||
    normalise.length < LONGUEUR_MIN_PERSONNALITE_COMPAREE ||
    sourceExpliciteDuBot(entree.provenance)
  ) {
    return { texte };
  }
  for (const autre of entree.autres) {
    if (autre.botId === entree.botId) continue;
    if (normaliser(autre.texte) !== normalise) continue;
    return {
      texte: "",
      refus: { autreBot: autre.botId, provenance: entree.provenance },
    };
  }
  return { texte };
}
