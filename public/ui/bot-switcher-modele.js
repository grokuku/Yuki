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

/** Nombre maximal de bots d'une instance (copie de `MAX_BOTS`, `registry.ts`). */
export const MAX_BOTS_SELECTEUR = 6;

/**
 * État LISIBLE d'un bot, pour le sélecteur.
 *
 * @param {{id?: string, actif?: boolean, execution?: {demarre?: boolean, erreur?: string}}} bot
 * @param {string|null} [duRun] identifiant du bot du RUN (il tourne avec le
 *   gateway : il n'est ni démarrable ni arrêtable). ⚠️ LOT 45 : c'est le PREMIER
 *   bot par `ordre` — aucun identifiant n'est privilégié.
 * @returns {{code: "duRun"|"demarre"|"erreur"|"arrete"|"inconnu",
 *   libelle: string, raison: string, demarrable: boolean, demarre: boolean,
 *   doitTourner: boolean}}
 */
export function etatBot(bot, duRun = null) {
  const doitTourner = bot?.actif === true;
  const execution = bot?.execution;
  if (duRun !== null && bot?.id === duRun) {
    // ⚠️ Le bot de la pile suit le gateway : `estDemarre` le dit TOUJOURS démarré
    // (c'est `main()` qui l'a démarré). On l'affiche comme tel, sans bouton.
    return {
      code: "duRun",
      // ⚠️ FRANÇAIS SIMPLE (demande utilisateur) : jamais « bot principal ».
      libelle: "en marche",
      raison: "",
      demarrable: false,
      demarre: true,
      doitTourner,
    };
  }
  /**
   * ⚠️ PLUS DE BRANCHE « REFUSÉ PAR LE PLAFOND » (décision utilisateur du
   * 2026-11-13) : un bot `actif` démarre toujours. S'il ne tourne pas, la cause
   * est une VRAIE erreur (`execution.erreur`, affichée plus bas) — jamais une
   * limite d'installation.
   */
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
 * ⚠️ LE BOT DU RUN N'A PAS DE `?b=` : sans ce paramètre, la page ne demande
 * aucun bot et parle au bot du run (premier par `ordre`) — c'est la convention de
 * L4, et c'est le SEUL moyen de fonctionner sur une instance MONO-BOT (sans
 * `state/bots.json`, le transport WebSocket refuse tout `botId`, y compris celui
 * du bot du run).
 *
 * @param {string} botId
 * @param {string|null} [duRun]
 */
export function urlConversationBot(botId, duRun = null) {
  if (typeof botId !== "string" || botId === "") return "/";
  if (duRun !== null && botId === duRun) return "/";
  return `/?b=${encodeURIComponent(botId)}`;
}

/**
 * URL des RÉGLAGES d'un bot (`/bots?b=…`) — destination du bouton « Réglages du
 * bot » de la barre du haut (lot 41).
 *
 * ⚠️ LE DÉFAUT CORRIGÉ ICI : ce bouton menait à `/bots` sans `?b=`, donc
 * TOUJOURS aux réglages de `yuki`, quel que soit le bot affiché dans la barre
 * du haut. Il porte maintenant le bot AFFICHÉ (`welcome.bot` de la connexion, à
 * défaut `?b=` de la page).
 *
 * ⚠️ `bots` = liste CONNUE (celle du sélecteur, `/api/bots`, triée par le
 * SERVEUR : `ordre`). Un bot affiché qui n'y figure PLUS (supprimé de
 * l'instance) ne doit pas produire un `?b=` mort : on retombe sur le PREMIER de
 * la liste, c'est-à-dire le premier par `ordre` — ⚠️ LOT 45 : plus de repli sur
 * « yuki », qui peut avoir été supprimée comme n'importe quel bot. Liste VIDE
 * (pas encore lue, ou instance injoignable) : on garde le bot affiché s'il y en
 * a un, sinon l'URL ne porte AUCUN `?b=` et le serveur résout (premier par
 * `ordre`) — une intention, jamais un identifiant inventé.
 *
 * @param {string|null} botAffiche
 * @param {Array<{id?: string}|string>} [bots]
 * @returns {string}
 */
export function urlReglagesBot(botAffiche, bots = []) {
  const connus = (Array.isArray(bots) ? bots : [])
    .map((bot) => (typeof bot === "string" ? bot.trim() : String(bot?.id ?? "")))
    .filter((id) => id !== "");
  const affiche = typeof botAffiche === "string" ? botAffiche.trim() : "";
  if (affiche !== "" && (connus.length === 0 || connus.includes(affiche))) {
    return `/bots?b=${encodeURIComponent(affiche)}`;
  }
  const premier = connus[0];
  if (typeof premier === "string" && premier !== "") {
    return `/bots?b=${encodeURIComponent(premier)}`;
  }
  return "/bots";
}

/** Bots marqués ACTIFS (ce qui doit tourner), dans l'ordre du registre. */
export function botsActifs(bots) {
  return (Array.isArray(bots) ? bots : []).filter((bot) => bot?.actif === true);
}

/**
 * Phrase de SYNTHÈSE du panneau : le VRAI nombre, jamais « un seul bot ».
 *
 * ⚠️ Aucun « maximum » : il n'y a plus de plafond de bots en marche.
 *
 * @param {Array<object>} bots
 */
export function resumeBots(bots) {
  const liste = Array.isArray(bots) ? bots : [];
  const demarres = liste.filter((bot) => bot?.execution?.demarre === true).length;
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
  return texte;
}

/**
 * Vue d'une ENTRÉE de la liste : tout ce que l'écran affiche, calculé ici pour
 * être testable sans navigateur.
 *
 * @param {object} bot
 * @param {{duRun?: string|null, courant?: string|null}} [options]
 */
export function entreeListe(bot, options = {}) {
  const duRun = options.duRun ?? null;
  const courant = options.courant ?? null;
  const etat = etatBot(bot, duRun);
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
    duRun: duRun !== null && bot?.id === duRun,
    courant: courant !== null && bot?.id === courant,
    monogramme: monogramme(nom),
    avatarClasse: classeMonogramme(String(bot?.id ?? "")),
    url: urlConversationBot(String(bot?.id ?? ""), duRun),
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
 * l'instance (yuki) » se lisait « il n'y a qu'un seul bot actif ». Ici le nombre
 * est le vrai, la liste est réelle, et le GESTE qui répare est nommé (démarrer,
 * depuis la barre du haut ou depuis la zone « Exécution » de cette page).
 *
 * ⚠️ PLUS DE « sur N au maximum » : le plafond de bots en marche n'existe plus
 * (décision utilisateur du 2026-11-13).
 *
 * @param {{bot: object|null, bots?: Array<object>,
 *   duRun?: string|null}} options
 * @returns {string} texte ("" ⇒ aucun bandeau à afficher)
 */
export function messageBandeauBot(options) {
  const bot = options?.bot ?? null;
  if (!bot) return "";
  const bots = Array.isArray(options.bots) ? options.bots : [];
  const actifs = botsActifs(bots);
  if (actifs.some((entree) => entree.id === bot.id)) return "";
  const nomsActifs = actifs.map((entree) => entree.id).join(", ");
  return (
    `Ce bot n'est pas en marche : ${actifs.length} bot${actifs.length > 1 ? "s" : ""} ` +
    `en marche` +
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
