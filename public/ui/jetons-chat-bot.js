/**
 * Yuki — NOMS DES JETONS DE DISCUSSION PAR BOT (logique PURE, sans DOM).
 *
 * ⚠️ POURQUOI CE MODULE EXISTE : la règle de nommage `YUKI_CHAT_<BOT>__<PLATEFORME>`
 * est utilisée par TROIS écrans (page `/bots` → onglet « Plateformes », panneau
 * d'instance `/config`, et la barre latérale de `/`). Elle était dans
 * `chat-panel.js` (panneau de page, qui importe `chat-mode.js`) : la barre
 * latérale n'aurait alors chargé tout le panneau QUE pour calculer un nom.
 * Extraite ici, elle est partagée sans cycle d'import et sans code mort.
 *
 * ⚠️ COPIE ASSUMÉE de `nomSecretChat` (`src/chat/jetons-bot.ts`) : ce fichier est
 * du JavaScript servi tel quel, il ne peut pas importer un module TypeScript du
 * serveur. La règle est verrouillée par un test qui COMPARE les deux
 * (`tests/ui/plateformes-par-bot.test.ts`) : renommer l'un sans l'autre ferait
 * écrire un jeton que le serveur ne lirait jamais.
 *
 * Aucun `innerHTML`, aucun style : ce module ne touche pas au DOM.
 */

import { BOT_PAR_DEFAUT } from "./bots-api.js";

/** Préfixe commun des jetons de discussion (`src/chat/jetons-bot.ts`). */
export const PREFIXE_SECRET_CHAT = "YUKI_CHAT";

/**
 * Nom du secret du jeton d'un bot pour une plateforme :
 * `YUKI_CHAT_<BOT>__<PLATEFORME>` (séparateur `__`, tirets du slug → `_`).
 */
export function nomSecretChatBot(botId, plateforme) {
  const proprietaire = String(botId).toUpperCase().replace(/-/g, "_");
  return `${PREFIXE_SECRET_CHAT}_${proprietaire}__${String(plateforme).toUpperCase()}`;
}

/**
 * Noms ACCEPTÉS pour le jeton d'un bot (le premier est celui d'un nouveau jeton).
 * Seul `yuki` garde droit à l'ancien nom d'instance (installations existantes).
 */
export function nomsSecretsChatBot(botId, plateforme) {
  const noms = [nomSecretChatBot(botId, plateforme)];
  if (botId === BOT_PAR_DEFAUT) {
    const historique = `${PREFIXE_SECRET_CHAT}_${String(plateforme).toUpperCase()}`;
    if (!noms.includes(historique)) noms.push(historique);
  }
  return noms;
}

/**
 * Le jeton de CE bot est-il au coffre ? — `true` / `false`, ou `null` (INCONNU).
 *
 * ⚠️ TROIS ÉTATS, jamais deux : un coffre verrouillé (`coffreConfigure === false`)
 * ou une liste de noms illisible (`noms == null`) ne permet PAS d'affirmer
 * « aucun jeton ». Rendre `false` dans ce cas produirait exactement le mensonge
 * signalé : « aucun jeton enregistré » alors que le coffre est simplement muet.
 *
 * @param {string} botId
 * @param {string} plateforme
 * @param {Iterable<string>|null|undefined} noms noms présents au coffre.
 * @param {boolean} [coffreConfigure] faux ⇒ le coffre est verrouillé.
 * @returns {boolean|null}
 */
export function jetonPosePour(botId, plateforme, noms, coffreConfigure = true) {
  if (coffreConfigure === false) return null;
  if (noms === null || noms === undefined) return null;
  const connu =
    noms instanceof Set ? noms : new Set(Array.isArray(noms) ? noms : [...noms]);
  return nomsSecretsChatBot(botId, plateforme).some((nom) => connu.has(nom));
}

/** Une ligne d'état du jeton de CE bot (le nom du secret, jamais sa valeur). */
export function texteEtatJetonBot(botId, plateforme, noms, coffreConfigure = true) {
  if (!coffreConfigure) {
    return (
      "Coffre verrouillé : aucun jeton ne peut être lu ni enregistré " +
      "(la clé maître `YUKI_VAULT_KEY` manque)."
    );
  }
  const attendus = nomsSecretsChatBot(botId, plateforme);
  const connu = new Set(Array.isArray(noms) ? noms : [...(noms ?? [])]);
  const present = attendus.find((nom) => connu.has(nom));
  if (present !== undefined) {
    return `Un jeton est enregistré pour ce bot sous « ${present} » (il n'est jamais réaffiché).`;
  }
  return `Aucun jeton pour ce bot : enregistrez-le ci-dessus (nom du coffre : ${attendus[0]}).`;
}
