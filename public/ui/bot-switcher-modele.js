/**
 * SÉLECTEUR DE BOTS DE LA BARRE DU HAUT — MODÈLE PUR (lot 37).
 *
 * ⚠️ POURQUOI CE MODULE EXISTE : la demande INITIALE du multi-bot était « dans la
 * barre de titre il y a écrit Yuki avec son avatar, on pourrait disposer de
 * plusieurs bots à cet endroit ». Livré à la place : un `<select>` dans la page
 * de configuration (`/bots`). Il fallait donc aller dans les paramètres pour
 * changer de bot — et un bot ARRÊTÉ y restait inutilisable.
 *
 * Ce module ne touche PAS au DOM : il décide seulement ce qu'il faut DIRE et
 * quelle URL ouvrir. Il est partagé par deux écrans qui doivent dire la MÊME
 * vérité :
 *  - `bot-switcher.js` : le panneau de la barre du haut ;
 *  - `config.js` : le bandeau d'honnêteté de la page `/bots`.
 *
 * ⚠️ Trois états DISTINCTS, jamais confondus (L8) :
 *  - `actif` (registre) = ce que le bot DOIT faire ;
 *  - `execution.demarre` = ce qu'il FAIT ;
 *  - `execution.erreur` = pourquoi son démarrage a échoué.
 * L'interface n'affiche QUE `execution` pour dire « démarré / arrêté », et
 * n'invente jamais un état quand `execution` manque (mode dégradé).
 *
 * Aucun `innerHTML`, aucun style inline : ce module ne produit que des données.
 */

/** Plafond des bots simultanés (copie du défaut serveur `bots.maxActifs`). */
export const PLAFOND_ACTIFS_DEFAUT = 3;

/** Nombre maximal de bots d'une instance (copie de `MAX_BOTS`, `registry.ts`). */
export const MAX_BOTS_SELECTEUR = 6;

/**
 * État LISIBLE d'un bot, pour le sélecteur.
 *
 * @param {{id?: string, actif?: boolean, execution?: {demarre?: boolean, erreur?: string}}} bot
 * @param {string|null} [principal] identifiant du bot de la PILE (il tourne avec
 *   le gateway : il n'est ni démarrable ni arrêtable).
 * @returns {{code: "principal"|"demarre"|"erreur"|"arrete"|"inconnu", libelle: string,
 *   demarrable: boolean, demarre: boolean, doitTourner: boolean}}
 */
export function etatBot(bot, principal = null) {
  const doitTourner = bot?.actif === true;
  const execution = bot?.execution;
  if (principal !== null && bot?.id === principal) {
    // ⚠️ Le bot de la pile suit le gateway : `estDemarre` le dit TOUJOURS démarré
    // (c'est `main()` qui l'a démarré). On l'affiche comme tel, sans bouton.
    return {
      code: "principal",
      libelle: "démarré (bot principal)",
      demarrable: false,
      demarre: true,
      doitTourner,
    };
  }
  if (execution === undefined || execution === null) {
    // Mode dégradé : aucun port d'exécution ⇒ on ne sait pas. On ne ment pas.
    return {
      code: "inconnu",
      libelle: doitTourner ? "état inconnu (doit tourner)" : "état inconnu",
      demarrable: doitTourner !== true,
      demarre: false,
      doitTourner,
    };
  }
  if (execution.demarre === true) {
    return {
      code: "demarre",
      libelle: "démarré",
      demarrable: false,
      demarre: true,
      doitTourner,
    };
  }
  const erreur = typeof execution.erreur === "string" && execution.erreur.trim() !== "";
  return {
    code: erreur ? "erreur" : "arrete",
    libelle: erreur ? "arrêté (erreur au démarrage)" : "arrêté",
    demarrable: true,
    demarre: false,
    doitTourner,
  };
}

/**
 * URL de conversation d'un bot.
 *
 * ⚠️ LE BOT PRINCIPAL N'A PAS DE `?b=` : sans ce paramètre, la page ne demande
 * aucun bot et parle au principal — c'est la convention de L4, et c'est le SEUL
 * moyen de fonctionner sur une instance MONO-BOT (sans `state/bots.json`, le
 * transport WebSocket refuse tout `botId`, y compris celui du principal).
 *
 * @param {string} botId
 * @param {string|null} [principal]
 */
export function urlConversationBot(botId, principal = null) {
  if (typeof botId !== "string" || botId === "") return "/";
  if (principal !== null && botId === principal) return "/";
  return `/?b=${encodeURIComponent(botId)}`;
}

/** Bots marqués ACTIFS (ce qui doit tourner), dans l'ordre du registre. */
export function botsActifs(bots) {
  return (Array.isArray(bots) ? bots : []).filter((bot) => bot?.actif === true);
}

/**
 * Phrase de SYNTHÈSE du panneau : le VRAI nombre, jamais « un seul bot ».
 *
 * @param {Array<object>} bots
 * @param {number} [plafond]
 */
export function resumeBots(bots, plafond = PLAFOND_ACTIFS_DEFAUT) {
  const liste = Array.isArray(bots) ? bots : [];
  const actifs = botsActifs(liste).length;
  const demarres = liste.filter((bot) => bot?.execution?.demarre === true).length;
  const borne = Number.isInteger(plafond) && plafond > 0 ? plafond : PLAFOND_ACTIFS_DEFAUT;
  if (liste.length === 0) return "Aucun bot lisible sur cette instance.";
  return (
    `${liste.length} bot(s) · ${actifs} actif(s) sur ${borne} maximum · ` +
    `${demarres} démarré(s)`
  );
}

/**
 * Vue d'une ENTRÉE de la liste : tout ce que l'écran affiche, calculé ici pour
 * être testable sans navigateur.
 *
 * @param {object} bot
 * @param {{principal?: string|null, courant?: string|null}} [options]
 */
export function entreeListe(bot, options = {}) {
  const principal = options.principal ?? null;
  const courant = options.courant ?? null;
  const etat = etatBot(bot, principal);
  const nom = typeof bot?.nom === "string" && bot.nom !== "" ? bot.nom : String(bot?.id ?? "");
  return {
    id: String(bot?.id ?? ""),
    nom,
    etat: etat.code,
    libelleEtat: etat.libelle,
    demarrable: etat.demarrable,
    demarre: etat.demarre,
    doitTourner: etat.doitTourner,
    principal: principal !== null && bot?.id === principal,
    courant: courant !== null && bot?.id === courant,
    monogramme: monogramme(nom),
    avatarClasse: classeMonogramme(String(bot?.id ?? "")),
    url: urlConversationBot(String(bot?.id ?? ""), principal),
  };
}

/** Initiales d'un nom (1 à 2 lettres) : repli d'avatar SANS image. */
export function monogramme(nom) {
  const texte = typeof nom === "string" ? nom.trim() : "";
  if (texte === "") return "?";
  const mots = texte.split(/\s+/u).filter((mot) => mot !== "");
  const lettres = mots
    .slice(0, 2)
    .map((mot) => mot[0] ?? "")
    .join("");
  return (lettres === "" ? texte[0] : lettres).toLocaleUpperCase("fr-FR");
}

/**
 * Classe CSS de couleur du monogramme (6 valeurs). ⚠️ DÉTERMINISTE et sans style
 * inline : la même teinte à chaque rendu, y compris après rechargement.
 */
export function classeMonogramme(botId) {
  const texte = String(botId ?? "");
  let somme = 0;
  for (let index = 0; index < texte.length; index += 1) {
    somme = (somme * 31 + texte.charCodeAt(index)) % 100_000;
  }
  return `bot-switcher__avatar--c${(somme % 6) + 1}`;
}

/**
 * Bandeau d'HONNÊTETÉ de la page `/bots` pour un bot NON actif.
 *
 * ⚠️ LE MESSAGE D'ORIGINE MENTAIT : « Ce bot n'est pas le bot ACTIF de
 * l'instance (yuki) » se lisait « il n'y a qu'un seul bot actif », alors que
 * `bots.maxActifs` en autorise TROIS. Ici le nombre est le vrai, la liste est
 * réelle, et le GESTE qui répare est nommé (démarrer, depuis la barre du haut
 * ou depuis la zone « Exécution » de cette page).
 *
 * @param {{bot: object|null, bots?: Array<object>, plafond?: number,
 *   principal?: string|null}} options
 * @returns {string} texte ("" ⇒ aucun bandeau à afficher)
 */
export function messageBandeauBot(options) {
  const bot = options?.bot ?? null;
  if (!bot) return "";
  const bots = Array.isArray(options.bots) ? options.bots : [];
  const actifs = botsActifs(bots);
  if (actifs.some((entree) => entree.id === bot.id)) return "";
  const plafond =
    Number.isInteger(options.plafond) && options.plafond > 0
      ? options.plafond
      : PLAFOND_ACTIFS_DEFAUT;
  const nomsActifs = actifs.map((entree) => entree.id).join(", ");
  const etat = etatBot(bot, options.principal ?? null);
  return (
    `Ce bot n'est pas ACTIF : ${actifs.length} bot(s) actif(s) sur ${plafond} ` +
    `maximum autorisé(s)${nomsActifs === "" ? "" : ` (${nomsActifs})`}.` +
    (etat.demarre ? "" : " Il n'est pas démarré non plus.") +
    " « Démarrer » (ci-dessous, ou barre du haut → avatar → « Démarrer ») " +
    "l'allume sans redémarrage. Ses réglages de configuration s'enregistrent bien " +
    "sur LUI ; la personnalité, la voix, les plateformes et les déclencheurs " +
    "restent, eux, ceux du bot actif."
  );
}

/** Clé de registre d'une paire d'échanges (`"<source>-><cible>"`). */
export function cleEchange(source, cible) {
  return `${source}->${cible}`;
}

/**
 * État d'une boucle entre deux bots : `"actif"`, `"inactif"` ou `"absent"`
 * (la paire n'a jamais été réglée — elle n'existe pas dans le registre).
 */
export function etatEchange(echanges, source, cible) {
  const table = echanges !== null && typeof echanges === "object" ? echanges : {};
  const entree = table[cleEchange(source, cible)];
  if (entree === undefined || entree === null) return "absent";
  return entree.actif === true ? "actif" : "inactif";
}

/** Libellé d'un état de boucle (jamais un booléen nu à l'écran). */
export function libelleEchange(etat) {
  if (etat === "actif") return "autorisée";
  if (etat === "inactif") return "coupée";
  return "non configurée";
}

/**
 * Boucles POSSIBLES depuis un bot (vers chaque AUTRE bot), avec leur état.
 * ⚠️ L'état vient du REGISTRE (`echanges`), jamais d'une supposition locale.
 */
export function pairesEchange(botId, bots, echanges) {
  const liste = Array.isArray(bots) ? bots : [];
  return liste
    .filter((bot) => bot?.id !== botId)
    .map((bot) => {
      const etat = etatEchange(echanges, botId, bot.id);
      return {
        cle: cleEchange(botId, bot.id),
        de: botId,
        vers: bot.id,
        nom: typeof bot.nom === "string" ? bot.nom : String(bot.id),
        etat,
        libelle: libelleEchange(etat),
        // Le bouton écrit l'INVERSE de l'état courant (absent ⇒ on autorise).
        actif: etat !== "actif",
      };
    });
}
