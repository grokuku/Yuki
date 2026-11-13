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

import { jetonChatDeBot, nomsSecretsChat } from "../jetons-bot.js";

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

/**
 * Miroir minimal nécessaire : l'ANCIEN paramètre vit dans `settings.baseUrl` du
 * miroir D'UN bot (`<state>/bots/<id>/chat-mirror.json`, `src/chat/mirror/store.ts`).
 *
 * ⚠️ Structurel, pas `ChatMirrorStore` : ce module reste sans dépendance lourde,
 * et une fixture suffit à prouver la règle.
 */
export interface MiroirUrlBot {
  baseUrl(): string;
  setBaseUrl(url: string): void;
}

/**
 * Ce qu'un adaptateur Mattermost reçoit pour SON bot : son adresse ET son jeton.
 *
 * ⚠️ POURQUOI LES DEUX ICI, ENSEMBLE : l'URL et le jeton doivent venir du MÊME
 * bot. Les résoudre séparément — l'URL par bot, le jeton par un nom d'instance
 * (`YUKI_CHAT_MATTERMOST`) — donne le pire cas possible : le jeton d'un compte
 * envoyé au serveur d'un autre, donc un échec d'authentification que rien
 * n'explique (ou, si les deux instances se connaissent, une réponse publiée
 * chez le mauvais bot). Une seule fonction = une seule vérité.
 */
export interface CablageMattermostBot {
  /** Bot propriétaire de ce câblage (jamais « le bot courant »). */
  readonly botId: string;
  /** Adresse EFFECTIVE passée à `baseUrl` de l'adaptateur DE CE BOT. */
  url(): string;
  /** État « configurée » (vide = fait affichable, jamais une exception). */
  configuree(): boolean;
  /** Noms acceptés pour le jeton DE CE BOT, dans l'ordre de lecture. */
  nomsJeton(): readonly string[];
  /** Jeton DE CE BOT (premier nom renseigné), ou `undefined`. */
  jeton(): string | undefined;
  /**
   * Écrit l'ANCIEN paramètre dans le miroir DE CE BOT — et dans aucun autre.
   *
   * ⚠️ C'est la seule écriture d'URL encore vivante (la clé par bot s'écrit par
   * `PUT /api/bots/<id>/config`) : elle doit viser le miroir du bot DEMANDÉ, pas
   * une instance partagée qui ferait converger deux bots sur un serveur.
   */
  enregistrerUrlHistorique(url: string): void;
}

export interface EntreesCablageMattermostBot {
  /** Bot demandé. */
  readonly botId: string;
  /** Surcharge de l'overlay de CE bot (`chat.mattermost.url`). */
  readonly urlDuBot: () => string;
  /** Miroir de CE bot (l'ANCIEN paramètre y sert de repli). */
  readonly miroir: MiroirUrlBot;
  /** Lecture du coffre (valeur d'un secret, jamais journalisée). */
  readonly lookup: (nom: string) => string | undefined;
}

/**
 * Câblage Mattermost d'UN bot : son adresse, son jeton, son miroir.
 *
 * ⚠️ Deux bots ⇒ DEUX câblages, chacun fermé sur SA configuration et SON miroir.
 * Un câblage ne lit jamais la configuration ni le miroir d'un autre bot : c'est
 * ce qui rend deux serveurs Mattermost simultanés possibles.
 */
export function cablageMattermostBot(
  entrees: EntreesCablageMattermostBot,
): CablageMattermostBot {
  const botId = String(entrees.botId).trim();
  const noms = botId === "" ? [] : nomsSecretsChat(botId, "mattermost");
  const url = (): string =>
    resoudreUrlMattermost(entrees.urlDuBot, () => entrees.miroir.baseUrl());
  return {
    botId,
    url,
    // ⚠️ Aucune exception ici : « adresse absente » est un ÉTAT, pas une panne.
    configuree: () => urlMattermostConfiguree(url()),
    nomsJeton: () => noms,
    jeton: () => jetonChatDeBot(entrees.lookup, botId, "mattermost"),
    enregistrerUrlHistorique: (valeur) => entrees.miroir.setBaseUrl(valeur),
  };
}
