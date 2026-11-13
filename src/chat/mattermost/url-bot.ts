/**
 * QUELLE ADRESSE MATTERMOST POUR QUEL BOT.
 *
 * ⚠️ CE QUE CE MODULE FERME (demande utilisateur du 2026-11-13 : « il y a pas
 * d'option pour rentrer l'adresse du serveur mattermost XD ») : Mattermost est
 * AUTO-HÉBERGÉ — chaque installation a sa propre URL. Jusqu'ici une SEULE valeur
 * globale servait tous les bots (`ChatMirrorStore.baseUrl()`, persistée dans
 * `<state>/chat-mirror.json`), et le panneau « Plateformes » d'un bot n'exposait
 * même pas de champ : un bot ne pouvait donc pas viser un autre serveur que
 * celui de la pile.
 *
 * Règle de PRÉCÉDENCE, une seule fois pour tout le programme (adaptateur du bot
 * de la pile, adaptateur de chaque bot, port des routes de discussion) :
 *  1. `chat.mattermost.url` de l'overlay du BOT (`scope: bot`, défaut VIDE) —
 *     la SURCHARGE par bot, écrite par le panneau « Plateformes » ;
 *  2. sinon l'ANCIEN paramètre, toujours vivant : `chat-mirror.json` → `baseUrl`,
 *     écrit depuis le lot 18 par `PUT /api/chat/mattermost` et le champ « URL du
 *     serveur » de `/config → Conversation`. Une instance déjà configurée
 *     continue donc de se connecter SANS RIEN RESSAISIR — c'est le défaut.
 *
 * ⚠️ L'ancien paramètre n'a pas été supprimé ni déplacé (aucune migration, aucune
 * ressaisie) : la clé par bot ne fait que le SURCHARGER. Le jour où le repli
 * historique sera retiré, ce sera avec une annonce de démarrage, comme pour les
 * variables d'environnement retirées.
 *
 * ⚠️ Les deux valeurs sont des FONCTIONS, pas des chaînes : l'URL est relue à
 * CHAQUE appel (`apply: hot`), sinon changer le champ obligerait un redémarrage.
 * Une valeur vide (des deux côtés) n'est PAS une erreur ici : c'est l'état
 * « adresse non configurée », que le client REST refuse explicitement au moment
 * d'appeler (`MattermostApiError` `not_configured`).
 *
 * Aucun import SDK/typebox.
 */

/**
 * URL Mattermost EFFECTIVE : la clé par bot PRIME, l'historique sert de repli.
 *
 * @param urlDuBot surcharge de l'overlay du bot (`chat.mattermost.url`), vide si absente.
 * @param urlHistorique ANCIEN paramètre : `chat-mirror.json` → `baseUrl` (défaut).
 */
export function resoudreUrlMattermost(
  urlDuBot: () => string,
  urlHistorique: () => string,
): string {
  const dediee = urlDuBot().trim();
  return dediee !== "" ? dediee : urlHistorique().trim();
}

/** `true` si l'adresse est renseignée (état « configuré ») — le vide est un FAIT, pas une erreur. */
export function urlMattermostConfiguree(url: string): boolean {
  return url.trim() !== "";
}
