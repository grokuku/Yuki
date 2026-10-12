// Statistiques d'exécution du pied de message — logique PURE (testable hors
// navigateur : `tests/ui/run-stats.test.ts`). Aucun DOM, aucun réseau.
//
// ⚠️ DEUX JEUX DE VALEURS, JAMAIS CONFONDUS :
//   - PROVISOIRES (`liveRunMetricsText`) : RENDU SEUL, recalculé en continu par
//     l'interface. Le temps écoulé avance ; le TTFT provient de la MESURE
//     SERVEUR (trame `phase`, étage `first_token`, champ `sinceT0Ms`). Ces
//     valeurs ne sont NI persistées NI transmises au serveur.
//   - FINALES (`runMetricsText`) : issues de la trame `run_summary` (qui réutilise
//     la synthèse du serveur). SEULES ces valeurs font foi et SEULES elles sont
//     persistées dans le JSONL de session (`yuki.run_metrics`, côté serveur).
//
// ⚠️ HONNÊTETÉ : une valeur INCONNUE n'est PAS affichée (jamais « 0 tok »
// trompeur, jamais de TTFT inventé). Le décompte de tokens n'est donc affiché
// qu'à l'arrivée du `run_summary` — jamais estimé.

/**
 * Texte des infos TECHNIQUES FINALES (« TTFT … ms · total … ms · N tok »), ou
 * `null` quand aucune statistique exploitable n'est fournie. Un message sans
 * statistiques n'affiche alors AUCUN pied (pas de ligne fantôme).
 * @param {{ ttftMs?: number, totalMs?: number, tokensOut?: number }|null|undefined} metrics
 * @returns {string|null}
 */
export function runMetricsText(metrics) {
  if (!metrics || typeof metrics.totalMs !== "number") return null;
  const parts = [];
  if (typeof metrics.ttftMs === "number") parts.push(`TTFT ${Math.round(metrics.ttftMs)} ms`);
  parts.push(`total ${Math.round(metrics.totalMs)} ms`);
  if (typeof metrics.tokensOut === "number") parts.push(`${metrics.tokensOut} tok`);
  return parts.join(" · ");
}

/**
 * Texte des infos TECHNIQUES PROVISOIRES, affichées PENDANT le run et
 * remplacées à la fin par `runMetricsText`. N'affiche QUE ce qui est connu :
 *  - `elapsedMs` : temps écoulé depuis le lancement (toujours connu) ;
 *  - `ttftMs`    : TTFT MESURÉ par le serveur, fourni seulement au 1er token.
 * Une valeur absente ou non finie est OMISE (aucun zéro de complaisance).
 * @param {{ elapsedMs?: number, ttftMs?: number|null }} [state]
 * @returns {string|null}
 */
export function liveRunMetricsText(state = {}) {
  const parts = [];
  const { ttftMs, elapsedMs } = state;
  if (typeof ttftMs === "number" && Number.isFinite(ttftMs)) {
    parts.push(`TTFT ${Math.round(Math.max(0, ttftMs))} ms`);
  }
  if (typeof elapsedMs === "number" && Number.isFinite(elapsedMs)) {
    parts.push(`total ${Math.round(Math.max(0, elapsedMs))} ms`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
