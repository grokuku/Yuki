/**
 * Yuki — ÉTAT DES PLATEFORMES, LIBELLÉS ET RÉGLAGES D'UN CANAL.
 *
 * Ce module ne monte PLUS de boutons on/off : les interrupteurs de plateforme ont
 * été RETIRÉS de la barre latérale (demande utilisateur du 2026-11-13 — « pourquoi
 * il y a des boutons a priori on/off à cet endroit ? je crois pas l'avoir
 * demandé »). L'activation se règle dans `/bots → Plateformes`, où sont les
 * réglages d'un bot.
 *
 * Ce qui reste ici, et qui est partagé :
 *  - les libellés/options (plateformes, modes de réponse, style, citation) ;
 *  - `cheminPlateforme` / `titrePlateforme` : le chemin EXACT d'un réglage, pour
 *    le bot dont on parle ;
 *  - `platformsNotice` : l'encart de la barre latérale qui DIT pourquoi la liste
 *    est vide (jamais un cadre muet) ;
 *  - `savePlatformEnabled` : l'écriture de `chat.<plateforme>.enabled` sur la
 *    route DU BOT (`PUT /api/bots/<id>/config`) ;
 *  - `saveReplySettings` / `saveReplyMode` : les réglages d'un canal distant.
 *
 * ⚠️ Ce module ne parle à AUCUNE plateforme : il passe par le gateway (CSP
 * stricte : aucun appel navigateur vers un service distant) et par l'en-tête
 * `X-Yuki-Config: 1`. L'état est PERSISTÉ côté serveur, pas dans le navigateur.
 * ⚠️ Aucune injection HTML, aucun style en ligne : la CSP reste inchangée.
 */

import { cheminConfigBot, idBotActif } from "./bots-api.js";

/**
 * CHEMIN EXACT du réglage d'une plateforme, **pour LE BOT AFFICHÉ**.
 *
 * ⚠️ Depuis le sous-lot 1b-4 (deux pages), ce réglage vit sur la page du BOT :
 * `/bots?b=<slug>`, onglet « Plateformes », SECTION « Discussions — Mattermost »
 * / « Discussions — Discord » (`public/ui/chat-panel.js`, titres des panneaux).
 * C'est vérifiable par ancre : `#plateformes` ouvre cet onglet ; les deux
 * interrupteurs d'accès distant, eux, sont communs à l'installation et vivent
 * sur `/config#chat-remote-agents` (`ANCRES_PROFONDES`, `public/ui/config-pages.js`).
 *
 * ⚠️ DÉFAUT CORRIGÉ (capture utilisateur) : le chemin était GRAVÉ sur `yuki`
 * donc le bandeau de la barre latérale renvoyait vers les réglages de `yuki`
 * alors qu'il parlait d'un autre bot (et affirmait « aucun jeton » sur la foi de
 * l'état de `yuki`). Le bot est maintenant un ARGUMENT, jamais une constante.
 *
 * ⚠️ Un chemin approximatif (« … → « Discussions » ») envoie l'utilisateur
 * chercher une section qui n'existe pas : c'est le défaut corrigé le 2026-11-02.
 * Les textes ci-dessous n'écrivent donc JAMAIS « Discussions » sans la
 * plateforme — un test verrouille l'égalité.
 *
 * @param {"mattermost"|"discord"} plateforme
 * @param {string} [botId] bot dont on montre l'état. ⚠️ LOT 45 : sans bot, le
 *   chemin ne porte AUCUN `?b=` (le serveur résout vers le premier par `ordre`) —
 *   plus de repli sur un identifiant en dur, qui nommerait un bot supprimé.
 * @returns {string}
 */
export function cheminPlateforme(plateforme, botId) {
  const id = typeof botId === "string" ? botId.trim() : "";
  const section =
    plateforme === "discord" ? "Discussions — Discord" : "Discussions — Mattermost";
  const page = id === "" ? "/bots" : `/bots?b=${encodeURIComponent(id)}`;
  return `${page} → Plateformes → « ${section} »`;
}

/**
 * PLATEFORMES DISTANTES proposées à un bot : des INTERRUPTEURS, plus un choix.
 *
 * ⚠️ AVANT (régression) : `chat.mode` était un enum EXCLUSIF (`local` /
 * `mattermost` / `discord`) rendu par un sélecteur « un seul à la fois » —
 * choisir « Local » COUPAIT Mattermost et Discord. Un bot doit pouvoir être
 * joignable sur PLUSIEURS plateformes EN MÊME TEMPS.
 * ⚠️ Le LOCAL n'est donc PAS dans cette liste : ce n'est pas un choix, il est
 * toujours disponible (comme avant la régression).
 */
export const PLATEFORME_OPTIONS = [
  { plateforme: "mattermost", label: "Mattermost" },
  { plateforme: "discord", label: "Discord" },
];

/**
 * Info-bulle d'une plateforme, pour le BOT AFFICHÉ (`/bots?b=<bot>`).
 *
 * ⚠️ Calculée à l'affichage, jamais figée dans `PLATEFORME_OPTIONS` : un titre
 * gravé ne peut pas désigner le bot qu'on regarde.
 *
 * @param {"mattermost"|"discord"} plateforme
 * @param {string} [botId]
 * @returns {string}
 */
export function titrePlateforme(plateforme, botId) {
  const chemin = cheminPlateforme(plateforme, botId);
  if (plateforme === "discord") {
    return (
      `Salons Discord du bot : interrupteur, jeton et état dans ${chemin}. ` +
      "L'intent MESSAGE_CONTENT doit être activé dans le portail développeur."
    );
  }
  return `Canaux Mattermost du bot : interrupteur, jeton et état dans ${chemin}.`;
}

/**
 * MODES DE RÉPONSE d'un canal distant, dans l'ordre d'affichage du menu contextuel.
 *
 * ⚠️ `mention` est le DÉFAUT côté serveur (`DEFAULT_REPLY_MODE`, `src/chat/reply/
 * responder.ts`) : le libellé le dit, pour que l'utilisateur sache ce qui se passe tant
 * qu'il n'a rien choisi.
 */
export const REPLY_MODE_OPTIONS = [
  {
    mode: "tout",
    label: "Répondre à tous les messages",
    title: "Yuki répond à chaque message HUMAIN du canal (jamais à ses propres messages).",
  },
  {
    mode: "auto",
    label: "Répondre quand on s'adresse à elle (jugé par le modèle)",
    title:
      "Un appel modèle léger décide, message par message, si Yuki est concernée. " +
      "Chaque message n'est jugé qu'une seule fois.",
  },
  {
    mode: "mention",
    label: "Répondre seulement si elle est citée",
    title: "Yuki ne répond que si son nom est cité (@yuki). C'est le mode par défaut.",
  },
];

/** Libellé d'un mode de réponse (`mode` inconnu ⇒ la valeur brute). */
export function replyModeLabel(mode) {
  const option = REPLY_MODE_OPTIONS.find((item) => item.mode === mode);
  return option ? option.label : String(mode ?? "");
}

/**
 * COMMENT répondre dans un canal distant (`fil` | `nouveau`), dans l'ordre d'affichage.
 *
 * ⚠️ `fil` est le DÉFAUT côté serveur (`DEFAULT_REPLY_STYLE`, `src/chat/types.ts`) :
 * c'est le comportement historique, et le libellé le dit.
 */
export const REPLY_STYLE_OPTIONS = [
  {
    style: "fil",
    label: "Réponse dans le fil",
    title:
      "La réponse se place dans le fil du message (comportement par défaut). " +
      "Si le message est déjà dans un fil, la réponse reste dans CE fil.",
  },
  {
    style: "nouveau",
    label: "Nouveau message",
    title:
      "La réponse est publiée comme un nouveau message à la racine du canal, " +
      "même si le message d'origine était dans un fil.",
  },
];

/**
 * MENTIONNER (ou non) l'auteur du message auquel Yuki répond.
 *
 * ⚠️ Il s'agit d'une MENTION NATIVE (`@pseudo` chez Mattermost, `<@identifiant>` chez
 * Discord), pas d'une citation de texte : la plateforme affiche déjà le message
 * d'origine. ⚠️ Une mention NATIVE **notifie** la personne (choix utilisateur du
 * 2026-11-02 : « je veux la version qui notifie »).
 *
 * ⚠️ `non` est le DÉFAUT côté serveur (`DEFAULT_QUOTE_AUTHOR`) : aucune mention n'est
 * ajoutée tant que l'utilisateur ne le demande pas.
 */
export const QUOTE_AUTHOR_OPTIONS = [
  {
    quote: "oui",
    label: "Mentionner l'auteur",
    title:
      "La réponse commence par une mention native de l'auteur du message : " +
      "elle le NOTIFIE (aucune citation du texte n'est ajoutée).",
  },
  {
    quote: "non",
    label: "Ne mentionner personne",
    title: "La réponse ne mentionne personne et ne cite personne (comportement par défaut).",
  },
];

/** Libellé d'un style de réponse (`style` inconnu ⇒ la valeur brute). */
export function replyStyleLabel(style) {
  const option = REPLY_STYLE_OPTIONS.find((item) => item.style === style);
  return option ? option.label : String(style ?? "");
}

/** Libellé d'un réglage de citation (`quote` inconnu ⇒ la valeur brute). */
export function quoteAuthorLabel(quote) {
  const option = QUOTE_AUTHOR_OPTIONS.find((item) => item.quote === quote);
  return option ? option.label : String(quote ?? "");
}

/**
 * Enregistre les réglages de RÉPONSE d'un canal distant
 * (`PATCH /api/chat/conversations/<id>`).
 *
 * ⚠️ Un seul point d'écriture : la route accepte n'importe quel SOUS-ENSEMBLE de
 * `{ replyMode, replyStyle, quoteAuthor }` (`null` = revenir au défaut). L'appelant
 * n'envoie que ce qu'il change, le serveur n'écrase pas le reste. Le corps est bâti par
 * `JSON.stringify` : aucune concaténation de HTML, aucun nœud construit à la main.
 */
export async function saveReplySettings(conversationId, patch, fetchImpl) {
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  const response = await doFetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    headers: WRITE_HEADERS,
    body: JSON.stringify(patch ?? {}),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = typeof body?.message === "string" ? body.message : "";
    } catch {
      // Corps illisible : on garde le code HTTP, jamais un succès supposé.
    }
    throw new Error(detail !== "" ? detail : `HTTP ${response.status}`);
  }
  return response.json();
}

/** Enregistre le mode de RÉPONSE d'un canal distant (`PATCH /api/chat/conversations/<id>`). */
export async function saveReplyMode(conversationId, mode, fetchImpl) {
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  const response = await doFetch(`/api/chat/conversations/${encodeURIComponent(conversationId)}`, {
    method: "PATCH",
    headers: WRITE_HEADERS,
    body: JSON.stringify({ replyMode: mode ?? null }),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = typeof body?.message === "string" ? body.message : "";
    } catch {
      // Corps illisible : on garde le code HTTP, jamais un succès supposé.
    }
    throw new Error(detail !== "" ? detail : `HTTP ${response.status}`);
  }
  return response.json();
}

/** Glyphes d'état du badge, par état serveur. */
export const CHAT_BADGES = {
  on: { glyph: "●", label: "connecté" },
  connexion: { glyph: "◐", label: "connexion en cours" },
  off: { glyph: "○", label: "non configuré" },
  /**
   * ⚠️ État NON EXPOSÉ pour ce bot : le gateway ne dit l'état de connexion que
   * pour le bot de la pile. On l'affiche comme tel — jamais « non configuré »,
   * qui serait une affirmation fausse sur un bot simplement non observable.
   */
  inconnu: { glyph: "?", label: "état inconnu" },
};

/** Libellé d'une plateforme distante (`plateforme` inconnue ⇒ la valeur brute). */
export function platformLabel(plateforme) {
  const option = PLATEFORME_OPTIONS.find((item) => item.plateforme === plateforme);
  return option ? option.label : String(plateforme ?? "");
}

/**
 * Badge d'état : `{ glyph, label, etat, title }`.
 *
 * `title` porte la RAISON EXACTE donnée par le serveur (jamais un « erreur »
 * générique) : c'est ce que l'utilisateur voit au survol.
 */
export function badgeFor(status) {
  const etat = status?.plateforme?.etat;
  const known = CHAT_BADGES[etat] ?? CHAT_BADGES.off;
  const raison =
    typeof status?.plateforme?.raison === "string" && status.plateforme.raison.length > 0
      ? status.plateforme.raison
      : known.label;
  return { glyph: known.glyph, label: known.label, etat: etat ?? "off", title: raison };
}

/**
 * Motif du refus de créer une conversation locale, tel que le SERVEUR le
 * renvoie (`creation.autorisee === false`), ou `null` si la création est permise.
 *
 * ⚠️ On ne décide pas ici : le serveur refuse aussi (`creation_desactivee`). Ce
 * module ne fait qu'empêcher un clic inutile.
 */
export function creationRefusal(status) {
  if (!status || !status.creation || status.creation.autorisee !== false) return null;
  return typeof status.creation.raison === "string" && status.creation.raison.length > 0
    ? status.creation.raison
    : "La création d'une conversation est désactivée dans ce mode.";
}

/** Mot du serveur pour « ce que la plateforme liste », au PLURIEL (canaux / salons). */
const MOTS_LISTE = { mattermost: "canaux", discord: "salons" };

/** Chemin du réglage pour un mode distant (jamais vide), POUR CE BOT. */
function cheminDeReglage(mode, botId) {
  return cheminPlateforme(mode === "discord" ? "discord" : "mattermost", botId);
}

/** Bot dont on parle : argument explicite, sinon celui porté par l'état. */
function botDeLEtat(status, options) {
  const demande = typeof options?.botId === "string" ? options.botId.trim() : "";
  if (demande !== "") return demande;
  const porte = typeof status?.bot === "string" ? status.bot.trim() : "";
  return porte;
}

/** Encart « on n'affirme encore RIEN » (état ou liste pas encore reçus). */
function noticeChargement(mode) {
  return {
    kind: "chargement",
    titre: `Chargement des ${MOTS_LISTE[mode]}…`,
    detail: "Lecture de l'état de la synchronisation…",
  };
}

/**
 * Encart d'ÉCHEC de synchronisation (jeton refusé, URL injoignable, plateforme
 * non configurée). ⚠️ Ce n'est PAS « aucun canal » : la raison du serveur est
 * recopiée, et le chemin du réglage est ajouté s'il n'y figure pas déjà.
 *
 * @param {"impossible" | "interrompue"} forme « rien n'a pu démarrer » (adapter
 *   absent ou non configuré) vs « la connexion s'est arrêtée » (raison d'erreur).
 */
function noticeEchec(mode, raison, forme, botId) {
  const chemin = cheminDeReglage(mode, botId);
  const motif =
    raison !== ""
      ? raison.includes("« Discussions") // la raison du serveur cite déjà la section
        ? raison
        : `${raison} Réglage : ${chemin}.`
      : `Le serveur n'a pas donné de raison. Réglage : ${chemin}.`;
  return {
    kind: "echec",
    titre: `Synchronisation des ${MOTS_LISTE[mode]} ${forme}.`,
    detail: motif,
  };
}

/**
 * Encart d'état INCONNU : la synchronisation n'est pas observable pour ce bot.
 *
 * ⚠️ Le gateway n'expose `etat` / `raison` que pour le bot de la PILE
 * (`GET /api/chat/status`). Pour tout autre bot, seuls l'interrupteur et le
 * jeton sont lisibles : on le DIT, au lieu de présenter « aucun canal » ou
 * « chargement » qui laisseraient croire à une mesure en cours.
 */
function noticeEtatInconnu(mode, botId) {
  const nom = botId !== "" ? `« ${botId} »` : "ce bot";
  return {
    kind: "inconnu",
    titre: `Synchronisation des ${MOTS_LISTE[mode]} : état inconnu.`,
    detail:
      `Le gateway n'expose l'état de connexion que pour le bot de la pile : ` +
      `pour ${nom}, on sait seulement que la plateforme est activée. ` +
      `Réglage : ${cheminDeReglage(mode, botId)}.`,
  };
}

/** Page où se règlent les plateformes d'un bot (une seule adresse, jamais un id en dur). */
function pagePlateformes(botId) {
  const id = typeof botId === "string" ? botId.trim() : "";
  return id !== "" ? `/bots?b=${encodeURIComponent(id)} → Plateformes` : "/bots → Plateformes";
}

/**
 * Encart quand AUCUNE plateforme n'est activée pour ce bot ET que la liste est vide.
 *
 * ⚠️ Une liste vide ne doit JAMAIS être muette (exigence du 2026-11-13) : sans
 * canal, l'utilisateur ne peut régler AUCUN canal (mode de réponse, style,
 * mention) — c'est son point d'entrée. L'encart dit donc où activer une
 * plateforme, au lieu de laisser un cadre vide qu'on prendrait pour une panne.
 */
function noticeAucunePlateforme(botId) {
  const nom = typeof botId === "string" && botId.trim() !== "" ? `« ${botId.trim()} »` : "ce bot";
  return {
    kind: "vide",
    titre: "Aucune conversation distante : aucune plateforme n'est activée.",
    detail:
      `Les canaux et salons listés ici sont ceux des plateformes ACTIVES de ${nom} : ` +
      `aucune ne l'est. Activez Mattermost ou Discord dans ${pagePlateformes(botId)}, ` +
      "puis cliquez sur « Se connecter » : les canaux apparaîtront ici, avec leurs " +
      "réglages de réponse (clic droit sur la conversation).",
  };
}

/** Encart d'état VIDE : la synchro est faite, il n'y a sincèrement rien à lister. */
function noticeVide(plateformes, botId) {
  const liste = Array.isArray(plateformes) ? plateformes : [plateformes];
  const plusieurs = liste.length > 1;
  const cheminDe = (plateforme) => cheminDeReglage(plateforme, botId);
  const details = liste.map((plateforme) =>
    plateforme === "discord"
      ? `Enregistrez le jeton du bot Discord dans ${cheminDe("discord")} (et activez ` +
        "l'intent MESSAGE_CONTENT et l'accès aux salons dans le portail développeur), " +
        "puis cliquez sur « Se connecter » : les salons texte du serveur seront importés."
      : `Renseignez l'URL du serveur et le jeton du bot dans ${cheminDe("mattermost")}, puis ` +
        "cliquez sur « Se connecter » : les canaux et deux semaines d'historique seront " +
        "alors importés.",
  );
  return {
    kind: "vide",
    titre:
      liste.length === 2
        ? "Aucun canal visible (Mattermost et Discord)."
        : liste[0] === "discord"
          ? "Aucun salon visible par ce bot."
          : "Aucun canal visible par ce bot.",
    detail:
      (plusieurs ? details.join(" ") : (details[0] ?? "")) +
      " Réglages des plateformes : " +
      pagePlateformes(botId) +
      ".",
  };
}

/**
 * Encart de la barre latérale — DÉCISION UNIQUE, à partir des INTERRUPTEURS et
 * de ce que la liste montre VRAIMENT.
 *
 * ⚠️ La règle de 2026-11-02 tient toujours : la décision ne peut pas se fonder
 * sur un état seul, sinon « Aucun canal synchronisé » s'affiche AU-DESSUS de cinq
 * canaux listés (deux vérités contradictoires à l'écran).
 * ⚠️ Ce qui a changé (2026-11-10) : il n'y a plus UN mode mais 0, 1 ou 2
 * plateformes ACTIVÉES. L'encart décrit donc la PREMIÈRE plateforme activée qui a
 * quelque chose à dire — et rien du tout si aucune n'est activée (le local seul
 * est un état normal, pas une panne : il n'y a rien à signaler).
 *
 * Règles, dans cet ordre (UNE SEULE vérité affichée à la fois) :
 *  ⓪ AUCUNE plateforme activée et liste VIDE ⇒ encart d'état vide qui DIT où
 *    activer une plateforme (`/bots → Plateformes`) : un cadre vide ne doit
 *    jamais être muet (`noticeAucunePlateforme`) ;
 *  ① état inconnu (statut pas encore reçu) ⇒ « chargement » discret ;
 *  ② liste NON VIDE ⇒ aucun encart (la liste dit la vérité, l'état vide la
 *    contredirait) — même si la synchronisation signale une erreur, la raison
 *    reste lisible sur la pastille (`badgeFor`) ;
 *  ③ liste pas encore REÇUE ⇒ « chargement » discret (jamais « aucun canal »,
 *    jamais une liste vide présentée comme définitive) ;
 *  ④ synchronisation inaboutie (`plateforme.etat` ≠ `on` AVEC raison serveur, ou
 *    `off`) ⇒ encart d'ÉCHEC avec la raison — ce n'est pas « aucun canal » ;
 *  ⑤ connexion EN COURS sans raison d'échec (`connexion`) ⇒ « chargement » :
 *    l'import peut encore remplir la liste, on n'affirme pas qu'elle est vide ;
 *  ⑥ synchro faite (`on`) et aucun élément ⇒ encart d'état vide, avec le chemin
 *    EXACT du réglage.
 *
 * @param {unknown} status état des plateformes du BOT AFFICHÉ (forme de
 *   `GET /api/chat/status`, ou état par bot de `plateformes-bot.js`).
 * @param {{nombre?: number, connue?: boolean}} [etatListe] ce que la barre sait de
 *   SA liste : nombre d'éléments rendus, et fait de l'avoir REÇUE du serveur.
 * @param {{botId?: string}} [options] bot dont on parle (défaut : `status.bot`) :
 *   c'est LUI qui apparaît dans le chemin de remédiation.
 * @returns `null` (rien à dire), ou `{ kind: "chargement" | "echec" | "vide" |
 *   "inconnu", titre, detail }`.
 */
export function platformsNotice(status, etatListe, options = {}) {
  const actives = plateformesActives(status);
  const botIdStatus = botDeLEtat(status, options);
  const nombre0 = Number(etatListe?.nombre ?? 0);
  const connue0 = etatListe?.connue === true;
  // ⓪ AUCUNE plateforme activée ET liste vide ⇒ on DIT où l'activer.
  //   ⚠️ Avant, on ne disait rien : un cadre vide, qu'on prenait pour une panne
  //   muette. Or sans canal, aucun réglage par canal n'est atteignable.
  if (actives.length === 0) {
    // ⚠️ On ne peut parler d'« aucune plateforme activée » QUE si l'état des
    // plateformes a été reçu (`status.plateformes`) : sans lui, on ne sait rien et
    // on n'affirme rien (statut absent, ou client d'avant les interrupteurs).
    const drapeaux = status?.plateformes;
    if (!drapeaux || typeof drapeaux !== "object") return null;
    if (!connue0) return noticeChargement("mattermost");
    return nombre0 > 0 ? null : noticeAucunePlateforme(botIdStatus);
  }

  const botId = botIdStatus;
  const nombre = nombre0;
  const listeConnue = connue0;
  const vueDe = (plateforme) => status?.[plateforme] ?? {};
  const etatDe = (plateforme) => vueDe(plateforme).plateforme ?? {};
  const raisonDe = (plateforme) => {
    const raison = etatDe(plateforme).raison;
    return typeof raison === "string" ? raison.trim() : "";
  };

  // ② La LISTE est la première vérité.
  if (Number.isFinite(nombre) && nombre > 0) return null;
  // ③ Rien n'est encore affirmable : la liste n'est pas arrivée.
  if (!listeConnue) return noticeChargement(actives[0]);
  // ④ L'état de connexion n'est PAS observable pour ce bot : on le dit, au lieu
  //   de laisser croire à une mesure en cours (ou à une liste définitivement vide).
  if (status?.connexionConnue === false) return noticeEtatInconnu(actives[0], botId);
  // ⑤ Une plateforme ACTIVÉE qui n'a pas abouti : sa raison, jamais « aucun canal ».
  for (const plateforme of actives) {
    if (etatDe(plateforme).etat === "off") {
      return noticeEchec(plateforme, raisonDe(plateforme), "impossible", botId);
    }
    const raison = raisonDe(plateforme);
    if (etatDe(plateforme).etat !== "on" && raison !== "") {
      return noticeEchec(plateforme, raison, "interrompue", botId);
    }
  }
  // ⑥ Connexion EN COURS : l'import peut encore remplir la liste.
  for (const plateforme of actives) {
    if (etatDe(plateforme).etat !== "on") return noticeChargement(plateforme);
  }
  // ⑦ Synchro faite et rien à lister.
  return noticeVide(actives, botId);
}

/**
 * PLATEFORMES DISTANTES ACTIVÉES (`chat.<plateforme>.enabled === "on"`).
 *
 * ⚠️ AVANT (régression) : la fonction rendait les « modes actifs » dont `local`
 * était TOUJOURS le premier — et un « type de discussion actif » se déduisait de
 * l'existence d'un jeton. Deux défauts : le local cessait d'être listé dès qu'on
 * passait en mode distant (liste locale vide), et un jeton posé suffisait à
 * présenter une plateforme comme active. Ici, UN SEUL fait compte : l'interrupteur.
 * ⚠️ Le LOCAL n'est pas une plateforme : il n'y a rien à activer, il est toujours
 * disponible.
 *
 * @param {unknown} status corps de `GET /api/chat/status`.
 * @returns {string[]} plateformes activées (0, 1 ou 2), dans l'ordre d'affichage.
 */
export function plateformesActives(status) {
  if (!status || typeof status !== "object") return [];
  const drapeaux = status.plateformes;
  if (!drapeaux || typeof drapeaux !== "object") return [];
  const actives = [];
  for (const option of PLATEFORME_OPTIONS) {
    if (drapeaux[option.plateforme] === true) actives.push(option.plateforme);
  }
  return actives;
}

/**
 * Phrase d'HONNÊTETÉ sur une plateforme d'un bot, ou `null`.
 *
 * ⚠️ Cas à DIRE (exigence 2026-11-10) : « interrupteur allumé, jeton absent » ⇒
 * aucune connexion n'est possible. Le contraire est aussi à dire : « jeton posé,
 * plateforme désactivée » — un jeton seul n'active RIEN.
 *
 * ⚠️ TROIS ÉTATS DE JETON (défaut corrigé) : `jetonEnregistre` peut valoir
 * `true`, `false` **ou `null` (inconnu : coffre verrouillé / noms illisibles)**.
 * Un `null` pris pour `false` produisait le mensonge signalé — « aucun jeton »
 * alors que le coffre n'était simplement pas lisible.
 *
 * @param {unknown} status état des plateformes du BOT AFFICHÉ.
 * @param {{botId?: string}} [options] bot dont on parle (défaut : `status.bot`).
 * @returns {string[]} une phrase par situation, dans l'ordre d'affichage.
 */
export function plateformesAvertissements(status, options = {}) {
  if (!status || typeof status !== "object") return [];
  const botId = botDeLEtat(status, options);
  const phrases = [];
  for (const option of PLATEFORME_OPTIONS) {
    const plateforme = option.plateforme;
    const vue = status[plateforme];
    if (!vue || typeof vue !== "object") continue;
    const active = status?.plateformes?.[plateforme] === true;
    const jeton = vue.jetonEnregistre;
    const chemin = cheminPlateforme(plateforme, botId);
    if (active && jeton === true) {
      phrases.push(
        `${option.label} est activé et son jeton est enregistré pour ce bot ` +
          `(il n'est jamais réaffiché). Réglage : ${chemin}.`,
      );
    }
    if (active && jeton === false) {
      phrases.push(
        `${option.label} est ACTIVÉ mais aucun jeton n'est enregistré : ` +
          `aucune connexion ne sera ouverte (${chemin}).`,
      );
    }
    if (active && jeton === null) {
      phrases.push(
        `${option.label} est ACTIVÉ mais l'état de son jeton est INCONNU ` +
          `(coffre illisible) : on ne peut pas affirmer qu'il manque (${chemin}).`,
      );
    }
    if (!active && jeton === true) {
      phrases.push(
        `${option.label} : jeton posé, plateforme DÉSACTIVÉE — elle ne se connecte pas ` +
          "tant que l'interrupteur n'est pas allumé.",
      );
    }
  }
  return phrases;
}

/** En-têtes d'écriture de configuration (mêmes que la page `/config`). */
const WRITE_HEADERS = {
  "content-type": "application/json",
  "x-yuki-config": "1",
};

/** En-têtes de LECTURE : la route d'état est gardée comme la configuration. */
const READ_HEADERS = { accept: "application/json", "x-yuki-config": "1" };

/** Lit `GET /api/chat/status` (état + motif de refus de création). */
export async function fetchChatStatus(fetchImpl) {
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  const response = await doFetch("/api/chat/status", {
    headers: READ_HEADERS,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

/**
 * Allume ou éteint UNE plateforme (`PUT /api/bots/<id>/config`) puis rend l'état
 * relu.
 *
 * ⚠️ `chat.<plateforme>.enabled` (`on` | `off`) est un réglage PROPRE AU BOT : la
 * route est donc celle de CE bot, jamais `/api/config` (qui répondrait
 * `bot_scoped_field`).
 * ⚠️ DÉFAUT CORRIGÉ (capture utilisateur) : la route visait le « bot actif »
 * (`idBotActif`), pas le bot AFFICHÉ. Sur `/bots?b=granolaf` ou dans la barre
 * latérale de `/?b=granolaf`, l'interrupteur écrivait donc chez `yuki`. L'appelant
 * passe maintenant `options.botId` (le bot dont il montre l'état) ; à défaut, on
 * retombe sur le comportement historique (bot actif), qui reste juste en mono-bot.
 * ⚠️ Ce n'est PLUS un choix exclusif : allumer Discord n'éteint pas Mattermost,
 * et RIEN n'éteint le local (il n'est pas un réglage).
 * ⚠️ Le JETON n'est pas touché ici : désactiver une plateforme ne détruit pas son
 * secret (on peut la rallumer), et poser un jeton n'active rien — l'interrupteur
 * est la seule intention.
 *
 * @param {"mattermost"|"discord"} plateforme
 * @param {boolean} actif état À DEMANDER.
 * @param {((url: string, init?: RequestInit) => Promise<Response>)
 *   | {fetchImpl?: Function, botId?: string}} [options] `fetch` injectable
 *   (signature historique) ou `{ fetchImpl, botId }`.
 */
export async function savePlatformEnabled(plateforme, actif, options) {
  const opts = typeof options === "function" ? { fetchImpl: options } : (options ?? {});
  const fetchImpl = opts.fetchImpl;
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  const demande =
    typeof opts.botId === "string" && opts.botId.trim() !== "" ? opts.botId.trim() : null;
  const botId = demande ?? (await idBotActif(fetchImpl));
  const response = await doFetch(cheminConfigBot(botId), {
    method: "PUT",
    headers: { ...WRITE_HEADERS, "x-yuki-config-flow": "chat-mode" },
    body: JSON.stringify({ [`chat.${plateforme}.enabled`]: actif === true ? "on" : "off" }),
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = typeof body?.message === "string" ? body.message : "";
    } catch {
      // Corps illisible : on garde le code HTTP, jamais un succès supposé.
    }
    throw new Error(detail !== "" ? detail : `HTTP ${response.status}`);
  }
  return fetchChatStatus(fetchImpl);
}

/**
 * ⚠️ PLUS DE MONTAGE D'INTERRUPTEURS ICI (2026-11-13).
 *
 * `initPlatformToggles` est SUPPRIMÉ : la barre latérale n'affiche plus de
 * boutons on/off de plateforme (« je crois pas l'avoir demandé »). Ce sont des
 * RÉGLAGES DE BOT : leur unique emplacement est la page du bot
 * (`/bots?b=<id>` → onglet « Plateformes », `chat-panel.js`).
 * Ce qui RESTE ici : les libellés et options partagés, `titrePlateforme`,
 * `plateformesActives`, `platformsNotice` (l'encart qui DIT pourquoi une liste
 * est vide) et `savePlatformEnabled` (l'écriture de `chat.<p>.enabled` sur la
 * route du bot).
 */

