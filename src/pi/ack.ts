/**
 * ACCUSÉ DE RÉCEPTION — règle UNIQUE de déclenchement et de libellé.
 *
 * ⚠️ LE CRITÈRE EST L'ACTION, JAMAIS UNE PRÉDICTION DE DURÉE. Yuki n'a rien à
 * estimer (nombre de tokens, longueur probable, temps restant) : la décision est
 * un **test booléen** — « une action vient-elle de démarrer ? ». C'est ce qui la
 * rend INSTANTANÉE (aucun calcul, aucun appel modèle supplémentaire, donc AUCUN
 * coût au TTFT : l'accusé part APRÈS le premier token, au moment où l'outil
 * commence).
 *
 * Trois déclencheurs, et trois seulement :
 *   1. une DÉLÉGATION démarre (`delegate`) ;
 *   2. une GÉNÉRATION D'IMAGE démarre (`generer_image`) ;
 *   3. une COMMANDE part sur un agent (`run_command`).
 *
 * Une question simple, une réponse immédiate, une lecture rapide : AUCUN accusé
 * (aucune action n'est lancée, donc le test est faux).
 *
 * ⚠️ Le libellé est COURT et HUMAIN, en français, et ne PROMET AUCUN RÉSULTAT :
 * « je m'en occupe » dit qu'on prend la demande en charge, pas qu'elle a réussi.
 * Le badge anti-mensonge et le ticket de délégation disent déjà le vrai état.
 */

/** Outils dont le DÉMARRAGE déclenche un accusé (liste fermée, verrouillée par test). */
export const ACK_TOOLS: readonly string[] = ["delegate", "generer_image", "run_command"];

/**
 * Texte de l'accusé pour un outil, ou `undefined` si l'outil n'est pas un
 * déclencheur (⇒ aucun accusé, jamais un accusé « au cas où »).
 */
export function ackTextForTool(tool: string): string | undefined {
  switch (tool) {
    case "delegate":
      // Long travail d'exécution : on prend la demande en charge, on rendra la
      // main, le rapport arrivera dans un tour ultérieur.
      return "Je m'en occupe.";
    case "generer_image":
      // Génération : l'image arrive dans le fil quand elle est prête.
      return "C'est parti.";
    case "run_command":
      // Commande envoyée à un agent : elle peut demander une validation.
      return "C'est parti.";
    default:
      return undefined;
  }
}

/**
 * Vrai si un accusé doit partir pour ce démarrage d'outil.
 *
 * ⚠️ Fonction PURE, à coût constant : aucune E/S, aucune mesure, aucun modèle.
 * `alreadySaid` / `alreadyAcked` sont les deux seuls faits nécessaires :
 *  - `alreadySaid` : le run a DÉJÀ produit du texte (elle a donc répondu, ou dit
 *    elle-même « je m'en occupe ») ⇒ PAS d'accusé (PIÈGE ②, pas de doublon) ;
 *  - `alreadyAcked` : un accusé est déjà parti pour ce run (deux outils longs dans
 *    le même tour ne produisent pas deux lignes).
 */
export function shouldAcknowledge(input: {
  tool: string;
  alreadySaid: boolean;
  alreadyAcked: boolean;
}): boolean {
  if (input.alreadyAcked || input.alreadySaid) return false;
  return ackTextForTool(input.tool) !== undefined;
}
