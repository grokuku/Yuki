/**
 * BOT DE LA CONVERSATION (lot 36, L4) — logique PURE, sans DOM : testable sans
 * navigateur.
 *
 * ⚠️ POURQUOI CE MODULE : depuis L4, le transport WebSocket sert PLUSIEURS hosts.
 * Une trame sans `botId` désigne le bot PRINCIPAL (compatibilité totale avec les
 * clients d'avant L4) ; une trame qui en porte un est servie par CE bot. La page
 * de conversation doit donc :
 *  - DIRE à qui elle parle (champ `botId` de `hello`/`resume`) ;
 *  - MONTRER qui lui répond (`welcome.bot`), pour qu'on ne croie jamais parler à
 *    Yuki en parlant à `kohai`.
 *
 * ⚠️ L'état vient de l'URL (`?b=<slug>`), exactement comme `/bots` : elle est
 * partageable et un rechargement retombe sur le même bot. Sans `?b=`, la page ne
 * demande AUCUN bot — c'est le bot du RUN (premier par `ordre`), comportement d'avant L4.
 *
 * Aucun `innerHTML`, aucun style inline : le module ne touche pas au DOM.
 */

/**
 * Bot demandé par la page de conversation, ou `null` (= bot du RUN).
 *
 * Une valeur vide ou faite d'espaces vaut « aucun bot » : on ne transmet jamais
 * un identifiant vide au serveur (il le refuserait, à juste titre).
 */
export function botDeLaPage(search) {
  const brut = new URLSearchParams(typeof search === "string" ? search : "").get("b");
  const botId = typeof brut === "string" ? brut.trim() : "";
  return botId.length > 0 ? botId : null;
}

/**
 * Champ `botId` à joindre aux trames de connexion (`hello`, `resume`).
 *
 * ⚠️ Rend un objet VIDE quand aucun bot n'est demandé : la trame envoyée est alors
 * strictement celle d'avant L4 (aucun champ ajouté).
 */
export function champBot(botId) {
  return typeof botId === "string" && botId.length > 0 ? { botId } : {};
}

/**
 * Libellé du bot à AFFICHER dans la barre du haut, ou `null` (rien à montrer).
 *
 *  1. `annonce` = `welcome.bot` : la seule source AUTORITAIRE (c'est le serveur
 *     qui sait quel host a répondu) ;
 *  2. à défaut, `demande` (le slug de l'URL) : la page a demandé un bot et le
 *     serveur ne l'a pas confirmé (serveur d'avant L4) — on affiche donc
 *     « conversation principale », la VÉRITÉ, plutôt que de laisser croire au
 *     slug ;
 *  3. sans demande ni annonce : `null` (aucun badge, écran inchangé).
 */
export function texteBot(annonce, demande) {
  if (typeof annonce === "string" && annonce.trim().length > 0) return annonce.trim();
  if (typeof demande === "string" && demande.trim().length > 0) return "conversation principale";
  return null;
}
