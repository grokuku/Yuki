// Yuki — ACCUSÉ DE RÉCEPTION et ATTENTE affichés EN TÊTE de la bulle de réponse.
//
// ⚠️ CE QUE C'EST : une ligne de statut COURTE et HUMAINE qui dit que la demande
// est bien prise en compte QUAND Yuki lance une action qui ne rendra pas la main
// tout de suite : une délégation, une génération d'image, une commande envoyée à
// un agent.
//
// ⚠️ SON TEXTE VIENT DU MODÈLE : c'est le PREMIER texte de son tour (consigne de
// ton dans le prompt système). Le module ne fabrique donc plus la phrase ; il
// n'en garde qu'un libellé de secours (`DEFAULT_ACK_TEXT`) si le serveur en
// omettait un. Le repli EN DUR existe côté serveur, avec des VARIATIONS.
//
// ⚠️ ELLE APPARTIENT À LA RÉPONSE — c'est la PREMIÈRE ligne de la bulle
// assistant, juste AVANT le corps markdown. Ce n'est pas un bloc posé à côté :
// une ligne séparée au-dessus d'une bulle vide faisait croire que Yuki n'avait
// rien répondu (défaut signalé par l'utilisateur).
//
// Trois règles tenues côté serveur (et vérifiées) :
//  - ce n'est PAS une réponse : le fond arrive ensuite, dans la MÊME bulle ;
//  - il n'est JAMAIS produit pour une question simple (aucune action lancée) ;
//  - il ne PROMET AUCUN RÉSULTAT (« je m'en occupe » ≠ « voilà le résultat ») :
//    le badge anti-mensonge et le ticket de délégation disent déjà le vrai état.
//
// ⚠️ PERSISTÉ AVEC LE MESSAGE : le serveur l'attache à l'entrée de transcript du
// message (`ack`) et l'écrit dans le JSONL de session (`yuki.run_ack`). Il
// revient donc après un rechargement, à l'identique. Il n'est jamais émis comme
// trame de CONTENU, donc jamais prononcé par la synthèse vocale (le moteur TTS ne
// reçoit que les trames de contenu) ni appris comme un souvenir (l'extracteur de
// mémoire écarte le préambule d'accusé d'un message qui appelle un outil).
//
// `data-ack-source` (« model » / « fallback ») est une MIETTE de mesure, invisible
// et muette : elle permet de compter les replis (voir `_tools/e2e-ack.mjs`).
//
// ⚠️ AUCUNE BULLE VIDE : tant que la bulle n'a ni accusé ni contenu, elle porte
// l'indicateur d'attente (`.message__pending`, trois points discrets et MUETS :
// `aria-hidden`, il n'est jamais lu ni copié). Il disparaît dès l'accusé ou le
// premier mot de la réponse.
//
// Rendu PUREMENT DOM (`textContent`) : aucune injection de balisage, aucun style
// en ligne (CSP `style-src 'self'`).

/** Accusé par défaut (le serveur envoie toujours un texte ; ceci n'est qu'un filet). */
export const DEFAULT_ACK_TEXT = "Je m'en occupe.";

/** Classe de la ligne d'accusé (DANS la bulle, avant le corps). */
export const ACK_CLASS = "ack-block";

/** Classe de l'indicateur d'attente (DANS la bulle, avant le corps). */
export const PENDING_CLASS = "message__pending";

/** Classes posées sur la ligne d'accusé / l'indicateur d'attente. */
const ACK_CLASSES = [ACK_CLASS, "message__ack"];
const PENDING_CLASSES = [PENDING_CLASS];

/**
 * Gère l'accusé de réception et l'attente DANS les bulles assistant.
 *
 * @param {object} deps
 * @param {HTMLElement} deps.container conteneur du fil (`#conversation`).
 * @returns {{
 *   pending(message: HTMLElement): HTMLElement|null,
 *   show(message: HTMLElement, text: string, source?: string): HTMLElement|null,
 *   has(message: HTMLElement|null): boolean,
 *   settled(message: HTMLElement|null): void,
 *   reset(): void,
 * }}
 */
export function createAckBlocks({ container }) {
  if (!container) throw new Error("createAckBlocks : conteneur absent");

  /**
   * Point d'insertion : JUSTE AVANT le corps markdown de la bulle (donc sous
   * l'heure et au-dessus de la réponse). Repli : en fin de bulle si le corps
   * n'existe pas encore — la ligne reste de toute façon DANS la bulle.
   */
  function slotOf(message) {
    if (!message) return null;
    return message.querySelector(".message__body") ?? null;
  }

  function place(message, element) {
    const slot = slotOf(message);
    if (slot && slot.parentNode === message) message.insertBefore(element, slot);
    else message.appendChild(element);
    return element;
  }

  function pendingElement(message) {
    return message ? message.querySelector(`:scope > .${PENDING_CLASS}`) : null;
  }

  function ackElement(message) {
    return message ? message.querySelector(`:scope > .${ACK_CLASS}`) : null;
  }

  /**
   * Affiche l'ATTENTE (aucun accusé, aucun contenu encore). Idempotent : un
   * second appel ne crée pas un second indicateur, et un indicateur n'est JAMAIS
   * posé à côté d'un accusé (l'accusé EST le début de la réponse).
   */
  function pending(message) {
    if (!message || ackElement(message)) return null;
    const existing = pendingElement(message);
    if (existing) return existing;
    const el = document.createElement("p");
    el.className = PENDING_CLASSES.join(" ");
    // ⚠️ MUET : ce n'est ni du texte de la réponse ni une information — il ne
    // doit être ni lu par un lecteur d'écran (le `#thinking` le fait déjà), ni
    // ramassé par une sélection. Aucun texte : la forme vient du CSS.
    el.setAttribute("aria-hidden", "true");
    return place(message, el);
  }

  /**
   * Affiche l'ACCUSÉ EN TÊTE de la bulle `message` — la première ligne de la
   * réponse, pas un bloc séparé. L'indicateur d'attente est retiré au même
   * instant (jamais les deux). Un accusé par bulle : un second appel REMPLACE
   * le texte au lieu d'empiler une seconde ligne.
   *
   * @param {string} [source] `"model"` (le modèle a écrit la phrase) ou
   *   `"fallback"` (repli en dur). Posé en `data-ack-source` : MIETTE de mesure
   *   (taux de repli), muette et invisible, jamais du balisage.
   */
  function show(message, text, source) {
    if (!message) return null;
    const label =
      typeof text === "string" && text.trim() !== "" ? text.trim() : DEFAULT_ACK_TEXT;
    const existing = ackElement(message);
    if (existing) {
      existing.textContent = label;
      if (typeof source === "string") existing.dataset.ackSource = source;
      settled(message);
      return existing;
    }
    const el = document.createElement("p");
    el.className = ACK_CLASSES.join(" ");
    // Statut « poli » pour les lecteurs d'écran : annoncé sans voler le focus.
    el.setAttribute("role", "status");
    el.textContent = label;
    if (typeof source === "string") el.dataset.ackSource = source;
    place(message, el);
    settled(message);
    return el;
  }

  /** Vrai si cette bulle porte un ACCUSÉ (elle a donc déjà dit quelque chose). */
  function has(message) {
    return ackElement(message) !== null;
  }

  /** Le contenu arrive (ou le run est fini) : l'attente n'a plus lieu d'être. */
  function settled(message) {
    const el = pendingElement(message);
    if (el) el.remove();
  }

  /** Retire accusés et attentes du fil (le fil est reconstruit depuis un snapshot). */
  function reset() {
    for (const selector of [`.${ACK_CLASS}`, `.${PENDING_CLASS}`]) {
      for (const el of [...container.querySelectorAll(selector)]) el.remove();
    }
  }

  return { pending, show, has, settled, reset };
}
