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
 * Identifiant du bot historique. Sert de REPLI quand la liste est illisible :
 * c'est le nom que l'instance mono-bot utilise toujours, donc le seul qui ne
 * puisse pas désigner un bot inexistant.
 */
export const BOT_PAR_DEFAUT = "yuki";

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
 *  - `principal` : le bot de la PILE (`runtime.botId`), seul à tourner avec le
 *                  gateway : sa conversation s'ouvre SANS `?b=` ;
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
    const principal = typeof body?.principal === "string" ? body.principal : bots[0].id;
    const echanges =
      body?.echanges !== null && typeof body?.echanges === "object" ? body.echanges : {};
    return { bots, principal, echanges };
  } catch {
    const bots = [
      {
        id: BOT_PAR_DEFAUT,
        nom: BOT_PAR_DEFAUT,
        // ⚠️ Repli : le bot historique porte le produit entier, donc TOUTES les
        // capacités (même choix que le repli serveur, `GET /api/bots`). Un repli à
        // `[]` ferait afficher un bot vide et un enregistrement les retirerait
        // vraiment.
        capacites: CAPACITES_PAGE.map((capacite) => capacite.id),
        actif: true,
        ordre: 0,
      },
    ];
    return { bots, principal: BOT_PAR_DEFAUT, echanges: {} };
  }
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
 * Repli : premier bot de la liste, puis `BOT_PAR_DEFAUT`.
 */
export async function idBotActif(fetchImpl) {
  const bots = await listerBots(fetchImpl);
  const actif = bots.find((bot) => bot.actif === true);
  return (actif ?? bots[0])?.id ?? BOT_PAR_DEFAUT;
}
