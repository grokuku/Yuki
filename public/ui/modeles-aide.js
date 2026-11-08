/**
 * Bloc « Modèles » de `/config` — TEXTES et ÉTAT du bandeau (module PUR).
 *
 * Pourquoi un module séparé : `config.js` est un script à effets de bord (DOM,
 * réseau) ; la phrase d'aide et la règle « visible seulement si le rôle travail
 * est indisponible » doivent être vérifiables SANS navigateur. Ici : aucune
 * dépendance, aucun DOM, aucune écriture.
 *
 * ⚠️ Le bandeau ne se déduit QUE de la présence de clé (`status.heavyKey`,
 * `src/llm/availability.ts:63-69`) — jamais d'un appel réseau. Il est MASQUÉ
 * dès que le rôle est disponible : conditionnel, jamais permanent.
 */

/** Texte d'aide affiché sous le titre du groupe « Modèle de discussion ». */
export const MODELE_DISCUSSION_INTRO =
  "Le modèle de discussion est l'interface : il comprend, choisit les " +
  "outils, répond. Le modèle de travail exécute les tâches déléguées et " +
  "les travaux de fond.";

/** Message du bandeau quand le rôle TRAVAIL est indisponible. */
export const MODELE_TRAVAIL_INDISPONIBLE =
  "Le modèle de travail est indisponible : les travaux de fond utilisent " +
  "le modèle de discussion (qualité réduite).";

/**
 * État d'affichage du bandeau.
 *
 * @param {boolean} travailDisponible présence de la clé du rôle travail.
 * @returns {{ hidden: boolean, texte: string }}
 */
export function bandeauTravail(travailDisponible) {
  return travailDisponible
    ? { hidden: true, texte: "" }
    : { hidden: false, texte: MODELE_TRAVAIL_INDISPONIBLE };
}
