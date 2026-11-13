/**
 * BOTS — accès commun aux routes d'administration des bots
 * (lot 35b, sous-lot 1b-3). Logique PURE, sans DOM : testable sans navigateur.
 *
 * Deux routes, deux usages :
 *  - `GET /api/bots` : la liste (`id`, `nom`, `capacites`, `actif`, `ordre`) ;
 *  - `GET/PUT /api/bots/<id>/config` : la configuration d'UN bot.
 *
 * ⚠️ POURQUOI CE MODULE : depuis le découpage Instance/Bot, un réglage propre à
 * un bot (`chat.mattermost.enabled`, `tts.voice`, `chat.remoteAgents`…) s'écrit sur la route
 * du bot, JAMAIS sur `PUT /api/config` (qui le refuse : `bot_scoped_field`).
 * Trois écrivains de l'interface ont besoin de la même règle ; la dupliquer
 * ferait diverger la règle.
 *
 * Aucun `innerHTML`, aucun style inline : le module ne touche pas au DOM.
 */

import { CAPACITES_PAGE } from "./config-pages.js";

/**
 * Identifiant du bot HISTORIQUE — uniquement pour la COMPATIBILITÉ des noms de
 * secrets (`YUKI_CHAT_MATTERMOST` accepté en plus de
 * `YUKI_CHAT_YUKI__MATTERMOST`). ⚠️ LOT 45 : ce n'est PAS un bot par défaut.
 * Aucun écran ne choisit « yuki » parce qu'il ne sait pas quel bot viser : la
 * liste du serveur est triée par `ordre` et c'est son PREMIER bot qui sert de
 * repli — yuki peut avoir été supprimée comme n'importe quel bot.
 */
export const BOT_HISTORIQUE = "yuki";

/** En-têtes d'écriture de configuration (mêmes que la page `/config`). */
export const BOT_WRITE_HEADERS = {
  "content-type": "application/json",
  "x-yuki-config": "1",
};

/** Chemin de configuration d'un bot donné. */
export function cheminConfigBot(botId) {
  return `/api/bots/${encodeURIComponent(String(botId))}/config`;
}

/**
 * Réponse COMPLÈTE de `GET /api/bots` : les bots, ET les deux informations que
 * l'interface doit dire VRAIE (lot 37).
 *
 *  - `botDuRun` : le bot du RUN (`runtime.botId`) — sa conversation s'ouvre
 *                  SANS `?b=`. ⚠️ LOT 45 : c'est le PREMIER bot par `ordre`,
 *                  plus un « bot principal » élu ;
 *  - `echanges`  : les boucles on/off entre bots (`{"a->b": {actif}}`).
 *
 * ⚠️ PLUS DE `plafond` : il n'y a plus de limite au nombre de bots en marche
 * (décision utilisateur du 2026-11-13) — tous les bots `actif` démarrent.
 *
 * ⚠️ Ne lève jamais : une réponse illisible rend le bot de repli et aucune
 * boucle — jamais un écran mort.
 */
export async function lireListeBots(fetchImpl) {
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  try {
    const response = await doFetch("/api/bots", {
      headers: { accept: "application/json", "x-yuki-config": "1" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const liste = Array.isArray(body?.bots) ? body.bots : [];
    const bots = liste.filter(
      (bot) => bot && typeof bot.id === "string" && bot.id.length > 0,
    );
    if (bots.length === 0) throw new Error("liste vide");
    // ⚠️ Le repli est `bots[0]` : la liste est triée par le SERVEUR (`ordre`),
    // donc premier par `ordre` — jamais un identifiant en dur.
    const botDuRun = typeof body?.botDuRun === "string" ? body.botDuRun : bots[0].id;
    const echanges =
      body?.echanges !== null && typeof body?.echanges === "object" ? body.echanges : {};
    return { bots, botDuRun, echanges };
  } catch {
    // ⚠️ LOT 45 : l'API est INJOIGNABLE (serveur arrêté, page servie par un
    // cache) : on ne fabrique PLUS un bot « yuki » de toutes pièces — il aurait
    // l'air d'exister alors qu'il a pu être supprimé. Liste VIDE et aucun bot du
    // run : les appelants disent l'absence au lieu d'écrire chez un fantôme.
    return { bots: [], botDuRun: "", echanges: {} };
  }
}

/**
 * RÉSOLUTION UNIQUE du « bot courant » côté interface — miroir exact de
 * `resoudreBotCourant` (`src/bots/courant.ts`) :
 *
 *  ① le bot DEMANDÉ (`?b=`) **s'il existe** ;
 *  ② sinon le **PREMIER de la liste** — `GET /api/bots` la trie par `ordre`, donc
 *     c'est le premier par `ordre`, puis par `id` ;
 *  ③ sinon `null` (aucun bot : l'écran dit l'absence).
 *
 * ⚠️ LOT 45 : AUCUN identifiant en dur. `yuki` est supprimable comme n'importe
 * quel bot ; un repli sur « yuki » la ferait réapparaître, ou pointerait dans le
 * vide. Une demande INCONNUE (bot supprimé, favori partagé) suit la règle ②.
 *
 * @param {Array<{id?: string}>} bots liste du serveur (ordre d'affichage)
 * @param {string|null|undefined} [demande] identifiant demandé par l'URL
 * @returns {{id?: string}|null}
 */
export function resoudreBotCourantListe(bots, demande) {
  const liste = Array.isArray(bots) ? bots : [];
  const voulu = typeof demande === "string" ? demande.trim() : "";
  if (voulu !== "") {
    const trouve = liste.find((bot) => String(bot?.id ?? "") === voulu);
    if (trouve) return trouve;
  }
  return liste[0] ?? null;
}

/**
 * Liste des bots connus de l'instance (le strict nécessaire des écrivains de
 * configuration : `id`, `nom`, `capacites`, `actif`, `ordre`).
 *
 * ⚠️ Ne lève jamais : une liste illisible rend le SEUL bot de repli. Un écran
 * qui ne peut pas lister les bots doit quand même pouvoir enregistrer un
 * réglage sur le bot historique.
 */
export async function listerBots(fetchImpl) {
  const { bots } = await lireListeBots(fetchImpl);
  return bots;
}

/**
 * Identifiant du bot ACTIF — celui dont la configuration est réellement
 * appliquée par le gateway, donc celui qu'un réglage de bot doit viser.
 * Repli : premier bot de la liste (triée par `ordre` par le serveur), puis `""`
 * — ⚠️ LOT 45 : plus de `yuki` en dur, un bot supprimé ne doit pas revivre.
 */
export async function idBotActif(fetchImpl) {
  const bots = await listerBots(fetchImpl);
  const actif = bots.find((bot) => bot.actif === true);
  return (actif ?? bots[0])?.id ?? "";
}
