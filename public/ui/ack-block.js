// Yuki — ACCUSÉ DE RÉCEPTION affiché DANS la conversation.
//
// ⚠️ CE QUE C'EST : une ligne de statut COURTE et HUMAINE (« Je m'en occupe. »,
// « C'est parti. ») qui dit que la demande est bien prise en compte QUAND Yuki
// lance une action qui ne rendra pas la main tout de suite : une délégation, une
// génération d'image, une commande envoyée à un agent.
//
// ⚠️ CE QUE CE N'EST PAS — trois règles tenues côté serveur (et vérifiées) :
//  - ce n'est PAS une réponse : le fond arrive ensuite, dans la bulle d'après ;
//  - il n'est JAMAIS produit pour une question simple (aucune action lancée) ;
//  - il ne PROMET AUCUN RÉSULTAT (« je m'en occupe » ≠ « voilà le résultat ») :
//    le badge anti-mensonge et le ticket de délégation disent déjà le vrai état.
//
// ⚠️ ÉPHÉMÈRE : trame de CONTRÔLE (aucun `seq` consommé, jamais bufferisée), donc
// jamais dans le rejeu, le snapshot, le transcript ou la mémoire. Elle n'est
// JAMAIS prononcée par la synthèse vocale : le moteur TTS ne reçoit que les
// trames de contenu (`delta` canal `content`), et l'accusé n'en est pas une —
// c'est une trame de STATUT, pas une phrase de la réponse.
//
// Rendu PUREMENT DOM (`textContent`) : aucune injection de balisage, aucun style
// en ligne (CSP `style-src 'self'`).

/** Accusé par défaut (le serveur envoie toujours un texte ; ceci n'est qu'un filet). */
export const DEFAULT_ACK_TEXT = "Je m'en occupe.";

/**
 * Gère l'affichage des ACCUSÉS DE RÉCEPTION dans `container` (`#conversation`).
 *
 * @param {object} deps
 * @param {HTMLElement} deps.container conteneur du fil.
 * @returns {{ show(text: string, options?: { before?: HTMLElement|null }): HTMLElement|null, reset(): void }}
 */
export function createAckBlocks({ container }) {
  if (!container) throw new Error("createAckBlocks : conteneur absent");

  /**
   * Affiche un accusé à la place COURANTE du fil.
   *
   * `before` permet de le placer JUSTE AVANT la bulle assistant encore vide du
   * run : l'accusé reste alors AU-DESSUS de la réponse (et de l'image) qui suit,
   * au lieu d'apparaître après coup sous un contenu qu'il précède pourtant dans
   * le temps. Aucun élément existant n'est déplacé.
   */
  function show(text, options = {}) {
    const label = typeof text === "string" && text.trim() !== "" ? text.trim() : DEFAULT_ACK_TEXT;
    const el = document.createElement("p");
    el.className = "ack-block";
    // Statut « poli » pour les lecteurs d'écran : annoncé sans voler le focus.
    el.setAttribute("role", "status");
    el.textContent = label;
    const before = options.before;
    if (before && before.parentNode === container) container.insertBefore(el, before);
    else container.appendChild(el);
    return el;
  }

  /** Retire TOUS les accusés (le fil est reconstruit depuis un snapshot). */
  function reset() {
    for (const el of [...container.querySelectorAll(".ack-block")]) el.remove();
  }

  return { show, reset };
}
