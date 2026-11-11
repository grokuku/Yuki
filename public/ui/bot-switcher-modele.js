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
 * @param {{refuses?: Array<string>, plafond?: number}} [options] bots `actif`
 *   REFUSÉS au démarrage par le plafond (`bots.maxActifs`). ⚠️ Sans cela, un bot
 *   refusé s'afficherait « état inconnu » : l'utilisateur ne saurait pas que son
 *   bot ne tourne pas PARCE QU'un plafond l'a écarté.
 * @returns {{code: "principal"|"refuse"|"demarre"|"erreur"|"arrete"|"inconnu",
 *   libelle: string, raison: string, demarrable: boolean, demarre: boolean,
 *   doitTourner: boolean}}
 */
export function etatBot(bot, principal = null, options = {}) {
  const doitTourner = bot?.actif === true;
  const execution = bot?.execution;
  const refuses = Array.isArray(options?.refuses) ? options.refuses : [];
  const plafond = normaliserPlafondModele(options?.plafond);
  if (principal !== null && bot?.id === principal) {
    // ⚠️ Le bot de la pile suit le gateway : `estDemarre` le dit TOUJOURS démarré
    // (c'est `main()` qui l'a démarré). On l'affiche comme tel, sans bouton.
    return {
      code: "principal",
      // ⚠️ FRANÇAIS SIMPLE (demande utilisateur) : jamais « bot principal ».
      libelle: "en marche",
      raison: "",
      demarrable: false,
      demarre: true,
      doitTourner,
    };
  }
  /**
   * ⚠️ REFUS DU PLAFOND — AVANT le mode dégradé : un bot `actif: true` écarté au
   * démarrage n'a NI pile NI host, donc aucun `execution` ; sans cette branche il
   * retomberait sur « état inconnu » et l'utilisateur chercherait la panne au
   * mauvais endroit. Le libellé nomme le plafond et le geste (éteindre un autre).
   */
  if (doitTourner && execution?.demarre !== true && refuses.includes(String(bot?.id ?? ""))) {
    return {
      code: "refuse",
      // ⚠️ Pas « actif », pas « plafond autorisé » : la cause et le geste, en clair.
      libelle: `pas démarré — ${plafond} bots en marche au maximum`,
      raison: `La limite de ${plafond} bots en marche est atteinte : éteignez-en un, puis réessayez.`,
      demarrable: true,
      demarre: false,
      doitTourner,
    };
  }
  if (execution === undefined || execution === null) {
    // Mode dégradé : aucun port d'exécution ⇒ on ne sait pas. On ne ment pas.
    return {
      code: "inconnu",
      libelle: doitTourner ? "état inconnu (devrait tourner)" : "état inconnu",
      raison: "",
      demarrable: doitTourner !== true,
      demarre: false,
      doitTourner,
    };
  }
  if (execution.demarre === true) {
    return {
      code: "demarre",
      libelle: "en marche",
      raison: "",
      demarrable: false,
      demarre: true,
      doitTourner,
    };
  }
  /**
   * ⚠️ LA RAISON, PAS UN CODE. `execution.erreur` porte le message RÉEL du
   * serveur (« dossier de sessions partagé », « configuration absente », erreur
   * de `host.start()`…). L'ancien libellé fixe « arrêté (erreur au démarrage) »
   * disait QUELQUE CHOSE A ÉCHOUÉ sans jamais dire POURQUOI : c'est le défaut
   * rapporté. On l'affiche tel quel, préfixé pour rester lisible.
   */
  const raison = typeof execution.erreur === "string" ? execution.erreur.trim() : "";
  return {
    code: raison !== "" ? "erreur" : "arrete",
    libelle: raison !== "" ? `arrêté — ${raison}` : "arrêté",
    raison,
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

/**
 * Plafond utilisable pour l'affichage : entier positif, sinon le défaut.
 *
 * @param {unknown} valeur
 * @returns {number}
 */
export function normaliserPlafondModele(valeur) {
  if (Number.isInteger(valeur) && valeur > 0) return valeur;
  return PLAFOND_ACTIFS_DEFAUT;
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
 * @param {Array<string>} [refuses] bots `actif` refusés au démarrage par le plafond
 */
export function resumeBots(bots, plafond = PLAFOND_ACTIFS_DEFAUT, refuses = []) {
  const liste = Array.isArray(bots) ? bots : [];
  const demarres = liste.filter((bot) => bot?.execution?.demarre === true).length;
  const borne = normaliserPlafondModele(plafond);
  const ecartes = Array.isArray(refuses) ? refuses.length : 0;
  if (liste.length === 0) return "Aucun bot lisible sur cette instance.";
  /**
   * ⚠️ FRANÇAIS LISIBLE (demande utilisateur) : l'ancienne phrase
   * « 2 bot(s) - 2 actif(s) sur 3 maximum - 1 démarré(s) » était du jargon de
   * registre. On dit maintenant l'état RÉEL, en clair, et la RAISON de chaque
   * échec — jamais un code.
   */
  const arretes = liste.length - demarres;
  const debut = `${liste.length} bot${liste.length > 1 ? "s" : ""}.`;
  const etats = [`${demarres} en marche`];
  if (arretes > 0) etats.push(`${arretes} arrêté${arretes > 1 ? "s" : ""}`);
  let texte = `${debut} ${etats.join(", ")}.`;
  const problemes = liste
    .filter(
      (bot) =>
        typeof bot?.execution?.erreur === "string" && bot.execution.erreur.trim() !== "",
    )
    .map((bot) => `${nomAfficheBot(bot)} : ${bot.execution.erreur.trim()}`);
  if (problemes.length > 0) texte += ` ${problemes.join(" ; ")}.`;
  if (ecartes > 0) {
    texte += ` ${ecartes} bot${ecartes > 1 ? "s" : ""} pas démarré${ecartes > 1 ? "s" : ""} :`;
    texte += ` la limite de ${borne} bots en marche est atteinte.`;
  }
  return texte;
}

/**
 * Vue d'une ENTRÉE de la liste : tout ce que l'écran affiche, calculé ici pour
 * être testable sans navigateur.
 *
 * @param {object} bot
 * @param {{principal?: string|null, courant?: string|null, refuses?: Array<string>,
 *   plafond?: number}} [options]
 */
export function entreeListe(bot, options = {}) {
  const principal = options.principal ?? null;
  const courant = options.courant ?? null;
  const refuses = Array.isArray(options.refuses) ? options.refuses : [];
  const plafond = normaliserPlafondModele(options.plafond);
  const etat = etatBot(bot, principal, { refuses, plafond });
  const nom = typeof bot?.nom === "string" && bot.nom !== "" ? bot.nom : String(bot?.id ?? "");
  return {
    id: String(bot?.id ?? ""),
    nom,
    /** Nom AFFICHABLE : `nom` seul, jamais le slug (décision utilisateur). */
    nomAffiche: nomAfficheBot(bot),
    etat: etat.code,
    libelleEtat: etat.libelle,
    /** Raison RÉELLE de l'échec (message du serveur), "" s'il n'y en a pas. */
    raison: etat.raison,
    demarrable: etat.demarrable,
    demarre: etat.demarre,
    doitTourner: etat.doitTourner,
    principal: principal !== null && bot?.id === principal,
    courant: courant !== null && bot?.id === courant,
    /** `true` si le bot est `actif` mais écarté au démarrage par le plafond. */
    refuse: etat.code === "refuse",
    monogramme: monogramme(nom),
    avatarClasse: classeMonogramme(String(bot?.id ?? "")),
    url: urlConversationBot(String(bot?.id ?? ""), principal),
  };
}

/**
 * Nom AFFICHABLE d'un bot : `nom`, ou son identifiant s'il n'a pas de nom.
 *
 * ⚠️ AUCUNE DÉSAMBIGUÏSATION À L'ÉCRAN (décision utilisateur) : « le slug on s'en
 * fout ». Deux bots de même nom ne doivent PAS être distingués par un suffixe —
 * c'est la CRÉATION qui refuse un nom déjà pris.
 *
 * @param {object} bot
 * @returns {string}
 */
export function nomAfficheBot(bot) {
  const id = String(bot?.id ?? "");
  return typeof bot?.nom === "string" && bot.nom.trim() !== "" ? bot.nom.trim() : id;
}

/**
 * Libellé du bouton de la barre du haut (`nom` + avatar) : le nom du bot AFFICHÉ.
 *
 * ⚠️ Vide si le bot courant n'est pas connu : l'appelant ne réécrit alors rien
 * plutôt que d'inventer un nom (la barre garde son contenu d'origine).
 *
 * @param {Array<object>} bots
 * @param {string|null} courantId
 * @returns {string}
 */
export function nomBarreHaut(bots, courantId) {
  const liste = Array.isArray(bots) ? bots : [];
  if (typeof courantId !== "string" || courantId === "") return "";
  const bot = liste.find((entree) => String(entree?.id ?? "") === courantId);
  return bot ? nomAfficheBot(bot) : "";
}

/** Initiales d'un nom (1 à 2 lettres) : repli d'avatar SANS image. */
export function monogramme(nom) {  const texte = typeof nom === "string" ? nom.trim() : "";
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
    `Ce bot n'est pas en marche : ${actifs.length} bot${actifs.length > 1 ? "s" : ""} ` +
    `en marche sur ${plafond} au maximum` +
    `${nomsActifs === "" ? "" : ` (${nomsActifs})`}.` +
    " « Démarrer » (ci-dessous, ou dans la barre du haut) l'allume sans redémarrer " +
    "l'instance. Ses réglages s'enregistrent bien sur LUI ; la personnalité, la " +
    "voix, les plateformes et les déclencheurs restent, eux, ceux du bot en marche."
  );
}

/** Clé `localStorage` de l'attribution « session → bot » (badges de non-lus). */
export const SESSION_BOT_STORAGE_KEY = "yuki-session-bot";

/** Compteur exploitable (entier ≥ 0), sinon 0. */
function normaliserCompteur(valeur) {
  const n = Number(valeur);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Attribue des conversations à un bot (retourne le MÊME objet si rien ne change).
 *
 * ⚠️ POURQUOI : le compteur de non-lus existant (`unread.js`) est PAR
 * CONVERSATION ; une conversation ne dit pas à quel bot elle appartient. Le
 * client l'apprend quand il reçoit la liste des sessions de SA connexion (une
 * connexion = un bot). Cette table, persistée, permet ensuite d'additionner
 * par bot sans jamais confondre deux bots qui auraient des identifiants de
 * session proches.
 */
export function attribuerSessions(attribution, sessions, botId) {
  const table = attribution && typeof attribution === "object" ? attribution : {};
  if (typeof botId !== "string" || botId === "") return table;
  const ids = Array.isArray(sessions) ? sessions : [];
  let change = false;
  const next = { ...table };
  for (const id of ids) {
    if (typeof id !== "string" || id === "") continue;
    if (next[id] !== botId) {
      next[id] = botId;
      change = true;
    }
  }
  return change ? next : table;
}

/**
 * Non-lus PAR BOT : somme des compteurs des conversations attribuées à ce bot.
 *
 * ⚠️ LIMITE DITE : ce sont les non-lus CONNUS DE CET APPAREIL (l'état vit dans
 * le navigateur, `unread.js`). Une conversation d'un bot jamais ouvert ici n'a
 * pas de compteur — on ne l'invente pas.
 */
export function nonLusParBot(unread, attribution) {
  const compteurs = {};
  const parSession = unread && typeof unread === "object" ? unread : {};
  const table = attribution && typeof attribution === "object" ? attribution : {};
  for (const [sessionId, valeur] of Object.entries(parSession)) {
    const n = normaliserCompteur(valeur);
    if (n <= 0) continue;
    const botId = table[sessionId];
    if (typeof botId !== "string" || botId === "") continue;
    compteurs[botId] = (compteurs[botId] ?? 0) + n;
  }
  return compteurs;
}

/**
 * Texte du badge : « • » pour UN message, le nombre au-delà (« 9+ » borné).
 *
 * ⚠️ Un point unique est plus discret qu'un « 1 » sur un avatar de 24 px ; dès
 * qu'il y en a plusieurs, le nombre est l'information utile. Vide = aucun badge.
 */
export function badgeNonLus(nombre) {
  const n = normaliserCompteur(nombre);
  if (n <= 0) return "";
  if (n === 1) return "•";
  return n > 9 ? "9+" : String(n);
}

/** Libellé accessible du badge (lecteur d'écran + infobulle). */
export function libelleNonLus(nombre) {
  const n = normaliserCompteur(nombre);
  if (n <= 0) return "";
  return `${n} message${n > 1 ? "s" : ""} non lu${n > 1 ? "s" : ""} sur cet appareil`;
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
