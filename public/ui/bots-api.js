/**
 * BOTS — accès commun aux routes d'administration des bots
 * (lot 35b, sous-lot 1b-3). Logique PURE, sans DOM : testable sans navigateur.
 *
 * Deux routes, deux usages :
 *  - `GET /api/bots` : la liste (`id`, `nom`, `profil`, `actif`, `ordre`) ;
 *  - `GET/PUT /api/bots/<id>/config` : la configuration d'UN bot.
 *
 * ⚠️ POURQUOI CE MODULE : depuis le découpage Instance/Bot, un réglage propre à
 * un bot (`chat.mode`, `tts.voice`, `chat.remoteAgents`…) s'écrit sur la route
 * du bot, JAMAIS sur `PUT /api/config` (qui le refuse : `bot_scoped_field`).
 * Trois écrivains de l'interface ont besoin de la même règle ; la dupliquer
 * ferait diverger la règle.
 *
 * Aucun `innerHTML`, aucun style inline : le module ne touche pas au DOM.
 */

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
 * Liste des bots connus de l'instance.
 *
 * ⚠️ Ne lève jamais : une liste illisible rend le SEUL bot de repli. Un écran
 * qui ne peut pas lister les bots doit quand même pouvoir enregistrer un
 * réglage sur le bot historique.
 */
export async function listerBots(fetchImpl) {
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
    return bots;
  } catch {
    return [
      {
        id: BOT_PAR_DEFAUT,
        nom: BOT_PAR_DEFAUT,
        profil: "complet",
        actif: true,
        ordre: 0,
      },
    ];
  }
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
