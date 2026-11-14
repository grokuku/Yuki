/**
 * Yuki — ÉTAT DES PLATEFORMES **DU BOT AFFICHÉ** (logique pure + lecture HTTP).
 *
 * ⚠️ DÉFAUT CORRIGÉ (capture utilisateur, 3 pièces) : la barre latérale annonçait
 * « Discord est ACTIVÉ mais aucun jeton n'est enregistré » pour le bot AFFICHÉ
 * `granolaf`, alors que son jeton `YUKI_CHAT_GRANOLAF__DISCORD` est bien au coffre
 * (la page `/bots?b=granolaf` le disait, elle), et renvoyait vers
 * les réglages de `yuki`. Cause : l'encart et les interrupteurs lisaient
 * `GET /api/chat/status`, route d'INSTANCE qui décrit le bot de la PILE — donc
 * `yuki` — quel que soit le bot de la conversation ouverte.
 *
 * ⚠️ CE QUE LE SERVEUR SAIT PAR BOT (et ce qu'il ne sait pas) :
 *  - les INTERRUPTEURS : `GET /api/bots/<id>/config` (`chat.<p>.enabled`) ;
 *  - la présence d'un JETON : `GET /api/secrets` (noms seulement, jamais de
 *    valeur) + la règle de nom `YUKI_CHAT_<BOT>__<PLATEFORME>` ;
 *  - l'ÉTAT DE CONNEXION : `GET /api/bots/<id>/config` → `plateformes` (lot 48).
 *    ⚠️ Avant ce champ, seul le bot de la pile le donnait (`GET /api/chat/status`)
 *    et l'interface disait « état inconnu » pour tout autre bot — un bot ABSENT
 *    (aucune connexion WebSocket, donc « hors ligne » dans Mattermost) restait
 *    indescriptible. On préfère `null` (inconnu) à une affirmation inventée.
 *
 * Aucun `innerHTML`, aucun style : ce module ne touche pas au DOM.
 */

import { cheminConfigBot, lireListeBots } from "./bots-api.js";
import { jetonPosePour } from "./jetons-chat-bot.js";
import { PLATEFORME_OPTIONS } from "./chat-mode.js";

/** Clé de configuration qui porte l'INTERRUPTEUR d'une plateforme. */
export const CLE_ACTIVATION = {
  mattermost: "chat.mattermost.enabled",
  discord: "chat.discord.enabled",
};

/** En-têtes de LECTURE des routes gardées (mêmes que la page `/config`). */
const READ_HEADERS = { accept: "application/json", "x-yuki-config": "1" };

/** Phrase d'un état de connexion qu'on ne peut PAS observer. */
export const RAISON_CONNEXION_NON_EXPOSEE =
  "L'état de connexion n'est exposé que pour le bot de la pile : pour ce bot, " +
  "on sait seulement que la plateforme est activée et si son jeton est au coffre.";

/** Valeur d'interrupteur lue dans `fields` (`"on"` = activé, tout le reste = non). */
function interrupteurLu(champs, plateforme) {
  const cle = CLE_ACTIVATION[plateforme];
  return champs?.[cle]?.value === "on";
}

/**
 * État des plateformes d'UN BOT, à la FORME de `GET /api/chat/status`.
 *
 * ⚠️ La forme est volontairement identique à celle du serveur : l'encart
 * (`platformsNotice`), les avertissements (`plateformesAvertissements`) et les
 * interrupteurs (`initPlatformToggles`) n'ont donc pas deux vocabulaires à
 * connaître — seule la SOURCE change (ce bot, et non celui de la pile).
 *
 * @param {object} faits
 * @param {string} faits.botId bot dont on veut l'état (le bot AFFICHÉ).
 * @param {Record<string, {value?: unknown}>} [faits.champs] `fields` de
 *   `GET /api/bots/<id>/config` (lu seulement quand l'état vient du bot lui-même).
 * @param {Iterable<string>|null} [faits.noms] noms présents au coffre
 *   (`GET /api/secrets` → `entries[].name`) ; `null` = illisible/inconnu.
 * @param {boolean} [faits.coffreConfigure] faux ⇒ coffre verrouillé (jeton inconnu).
 * @param {unknown} [faits.statutPile] corps de `GET /api/chat/status`, utilisé
 *   UNIQUEMENT si `botId` est le bot de la pile (état le plus direct).
 * @param {Record<string, object>|null} [faits.etatServeur] champ `plateformes` de
 *   `GET /api/bots/<id>/config` : l'état de connexion RÉEL du bot demandé.
 * @param {string} [faits.botDuRun] identifiant du bot du RUN (`GET /api/bots`
 *   → `botDuRun`).
 * @returns {{bot: string, botDuRun: string|null, connexionConnue: boolean,
 *   plateformes: Record<string, boolean>,
 *   mattermost: object, discord: object}}
 */
export function etatPlateformesDepuisFaits(faits = {}) {
  // ⚠️ LOT 45 : plus de repli sur un identifiant en dur (`yuki` peut être
  // supprimée). Sans bot affiché, la valeur est VIDE et l'appelant le dit.
  const botId = typeof faits.botId === "string" ? faits.botId.trim() : "";
  const botDuRun =
    typeof faits.botDuRun === "string" && faits.botDuRun.trim() !== ""
      ? faits.botDuRun.trim()
      : null;
  const statutPile =
    faits.statutPile !== null && typeof faits.statutPile === "object"
      ? faits.statutPile
      : null;
  /** L'état en direct n'existe que pour le bot de la pile, et s'il a été reçu. */
  const depuisPile = botDuRun !== null && botId === botDuRun && statutPile !== null;
  /**
   * ⚠️ ÉTAT PAR BOT (lot 48) : `plateformes` de `GET /api/bots/<id>/config`. Il
   * décrit CE bot (adaptateur présent, connecté ou non, raison de l'échec) — c'est
   * ce qui permet de DIRE « hors ligne parce que le jeton est refusé ».
   */
  const serveur =
    faits.etatServeur !== null && typeof faits.etatServeur === "object"
      ? faits.etatServeur
      : null;
  const etatConnu = depuisPile || serveur !== null;

  const etat = {
    bot: botId,
    botDuRun,
    connexionConnue: etatConnu,
    plateformes: {},
  };
  for (const option of PLATEFORME_OPTIONS) {
    const plateforme = option.plateforme;
    const vuePile = depuisPile ? statutPile[plateforme] : null;
    const vueServeur = serveur !== null ? serveur[plateforme] : null;
    const active = depuisPile
      ? statutPile.plateformes?.[plateforme] === true
      : vueServeur !== null && typeof vueServeur === "object"
        ? vueServeur.active === true
        : interrupteurLu(faits.champs, plateforme);
    const jetonEnregistre = depuisPile
      ? vuePile?.jetonEnregistre === true
        ? true
        : vuePile?.jetonEnregistre === false
          ? false
          : null
      : vueServeur !== null && typeof vueServeur === "object"
        ? vueServeur.jetonEnregistre === true
          ? true
          : vueServeur.jetonEnregistre === false
            ? false
            : null
        : jetonPosePour(botId, plateforme, faits.noms ?? null, faits.coffreConfigure !== false);
    const etatConnexion = depuisPile
      ? typeof vuePile?.plateforme?.etat === "string"
        ? vuePile.plateforme.etat
        : "off"
      : vueServeur !== null && typeof vueServeur === "object"
        ? typeof vueServeur.etat === "string"
          ? vueServeur.etat
          : "inconnu"
        : "inconnu";
    const raison = depuisPile
      ? typeof vuePile?.plateforme?.raison === "string"
        ? vuePile.plateforme.raison
        : ""
      : vueServeur !== null && typeof vueServeur === "object"
        ? typeof vueServeur.raison === "string"
          ? vueServeur.raison
          : ""
        : RAISON_CONNEXION_NON_EXPOSEE;
    etat.plateformes[plateforme] = active;
    etat[plateforme] = {
      active,
      jetonEnregistre,
      plateforme: { etat: etatConnexion, raison },
      // ⚠️ CANAUX SUIVIS : zéro canal avec une connexion « on » n'est pas un
      // défaut du miroir, c'est « ce bot ne voit aucun canal » — dit par le serveur.
      ...(vueServeur !== null && typeof vueServeur === "object"
        ? {
            canaux: Number.isFinite(vueServeur.canaux) ? vueServeur.canaux : null,
            adaptateur: vueServeur.adaptateur === true,
          }
        : {}),
    };
  }
  return etat;
}

/**
 * Lit l'état des plateformes DU BOT AFFICHÉ.
 *
 * Requêtes :
 *  1. `GET /api/bots` — pour savoir si le bot affiché EST celui de la pile ;
 *  2. bot de la pile ⇒ `statutPile` (déjà lu par l'appelant) suffit : aucune
 *     requête de plus, et l'état de connexion est en direct ;
 *  3. autre bot ⇒ `GET /api/bots/<id>/config` (interrupteurs de CE bot) et
 *     `GET /api/secrets` (noms au coffre). L'état de connexion reste INCONNU.
 *
 * ⚠️ Ne lève jamais : une lecture ratée rend un état dont les faits manquants
 * sont `null` (inconnus) et la raison est remontée dans `erreur`. Afficher
 * « aucun jeton » sur une lecture ratée serait exactement le mensonge corrigé.
 *
 * @param {string} [botId] bot AFFICHÉ (`?b=` de la page, ou `welcome.bot`).
 * @param {object} [options]
 * @param {unknown} [options.statutPile] corps de `GET /api/chat/status` (peut être `null`).
 * @param {(url: string, init?: RequestInit) => Promise<Response>} [options.fetchImpl]
 * @returns {Promise<object>} état (voir `etatPlateformesDepuisFaits`) + `erreur`.
 */
export async function fetchEtatPlateformes(botId, options = {}) {
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const erreurs = [];
  const liste = await lireListeBots(doFetch);
  // ⚠️ LOT 45 : repli sur le PREMIER bot de la liste par `ordre` (celle du
  // serveur), jamais sur un identifiant en dur.
  const botDuRun =
    typeof liste.botDuRun === "string" && liste.botDuRun !== ""
      ? liste.botDuRun
      : (liste.bots[0]?.id ?? "");
  const affiche =
    typeof botId === "string" && botId.trim() !== "" ? botId.trim() : botDuRun;

  // Bot de la PILE : l'état en direct du serveur décrit CE bot — rien de plus à lire.
  if (
    affiche !== "" &&
    affiche === botDuRun &&
    options.statutPile !== null &&
    typeof options.statutPile === "object"
  ) {
    return {
      ...etatPlateformesDepuisFaits({
        botId: affiche,
        botDuRun,
        statutPile: options.statutPile,
      }),
      erreur: "",
    };
  }

  let champs = {};
  let etatServeur = null;
  try {
    const response = await doFetch(cheminConfigBot(affiche), {
      headers: READ_HEADERS,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const corps = await response.json();
    champs = corps?.fields ?? {};
    // ⚠️ `plateformes` décrit CE bot : sans lui, l'interface ne pouvait que dire
    // « état inconnu » et l'utilisateur devait redémarrer pour comprendre.
    etatServeur =
      corps !== null && typeof corps === "object" ? (corps.plateformes ?? null) : null;
  } catch (error) {
    champs = {};
    erreurs.push(
      `configuration de ${affiche} illisible : ${messageDErreur(error)}`,
    );
  }

  let noms = null;
  let coffreConfigure = true;
  try {
    const response = await doFetch("/api/secrets", {
      headers: READ_HEADERS,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const corps = await response.json();
    coffreConfigure = corps?.configured !== false;
    const entrees = Array.isArray(corps?.entries) ? corps.entries : [];
    noms = entrees
      .map((entree) => String(entree?.name ?? ""))
      .filter((nom) => nom !== "");
  } catch (error) {
    noms = null;
    coffreConfigure = false;
    erreurs.push(`coffre illisible : ${messageDErreur(error)}`);
  }

  return {
    ...etatPlateformesDepuisFaits({
      botId: affiche,
      botDuRun,
      champs,
      noms,
      coffreConfigure,
      etatServeur,
      // L'état en direct du bot de la pile ne décrit PAS ce bot : on ne le passe pas.
      statutPile: null,
    }),
    erreur: erreurs.join(" · "),
  };
}

/** Message lisible d'une erreur de lecture (jamais un secret). */
function messageDErreur(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.trim() !== "" ? message.trim() : "erreur inconnue";
}
