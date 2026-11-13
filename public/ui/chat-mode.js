/**
 * Yuki — INTERRUPTEURS DE PLATEFORMES (barre latérale).
 *
 * ⚠️ Ce n'est plus un sélecteur exclusif de mode : **deux interrupteurs
 * indépendants** (Mattermost, Discord). Le **Local** n'est pas un choix — il est
 * TOUJOURS disponible (les conversations de Yuki restent dans la liste).
 *
 * ⚠️ Ce module ne parle à AUCUNE plateforme : il lit `GET /api/chat/status` par
 * le gateway (CSP stricte : aucun appel navigateur vers un service distant) et
 * écrit le mode choisi par `PUT /api/bots/<id>/config` (en-tête
 * `X-Yuki-Config: 1`). L'état est donc **persisté côté serveur**, pas dans le
 * navigateur.
 *
 * ⚠️ MULTI-BOT (lot 35b, sous-lot 1b-3) : l'interrupteur est un réglage PROPRE
 * AU BOT ACTIF (`chat.<plateforme>.enabled`). `PUT /api/config` le REFUSE
 * (`bot_scoped_field`) : il s'écrit sur la route du bot actif, résolue par
 * `GET /api/bots`.
 *
 * ⚠️ Rendu PUREMENT DOM (`createElement`), aucune injection HTML directe, aucun
 * style en ligne : la CSP `style-src 'self'` reste inchangée.
 */

import { cheminConfigBot, idBotActif } from "./bots-api.js";

/**
 * CHEMIN EXACT du réglage de chaque plateforme.
 *
 * ⚠️ Depuis le sous-lot 1b-4 (deux pages), ce réglage vit sur la page du BOT :
 * `/bots?b=<slug>`, onglet « Plateformes », SECTION « Discussions — Mattermost »
 * / « Discussions — Discord » (`public/ui/chat-panel.js`, titres des panneaux).
 * C'est vérifiable par ancre : `#plateformes` ouvre cet onglet ; les deux
 * interrupteurs d'accès distant, eux, sont communs à l'installation et vivent
 * sur `/config#chat-remote-agents` (`ANCRES_PROFONDES`, `public/ui/config-pages.js`).
 *
 * ⚠️ Un chemin approximatif (« … → « Discussions » ») envoie l'utilisateur
 * chercher une section qui n'existe pas : c'est le défaut corrigé le 2026-11-02.
 * Les textes ci-dessous n'écrivent donc JAMAIS « Discussions » sans la
 * plateforme — un test verrouille l'égalité.
 */
export const CHEMIN_MATTERMOST = "/bots?b=yuki → Plateformes → « Discussions — Mattermost »";

/** Chemin exact de la section Discord (page du bot, onglet « Plateformes »). */
export const CHEMIN_DISCORD = "/bots?b=yuki → Plateformes → « Discussions — Discord »";

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
  {
    plateforme: "mattermost",
    label: "Mattermost",
    title: `Canaux Mattermost du bot : interrupteur, jeton et état dans ${CHEMIN_MATTERMOST}.`,
  },
  {
    plateforme: "discord",
    label: "Discord",
    title:
      `Salons Discord du bot : interrupteur, jeton et état dans ${CHEMIN_DISCORD}. ` +
      "L'intent MESSAGE_CONTENT doit être activé dans le portail développeur.",
  },
];

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

/** Chemin du réglage pour un mode distant (jamais vide). */
function cheminDeReglage(mode) {
  return mode === "discord" ? CHEMIN_DISCORD : CHEMIN_MATTERMOST;
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
function noticeEchec(mode, raison, forme) {
  const chemin = cheminDeReglage(mode);
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

/** Encart d'état VIDE : la synchro est faite, il n'y a sincèrement rien à lister. */
function noticeVide(plateformes) {
  const liste = Array.isArray(plateformes) ? plateformes : [plateformes];
  const plusieurs = liste.length > 1;
  const details = liste.map((plateforme) =>
    plateforme === "discord"
      ? `Enregistrez le jeton du bot Discord dans ${CHEMIN_DISCORD} (et activez ` +
        "l'intent MESSAGE_CONTENT dans le portail développeur), puis cliquez sur " +
        "« Se connecter » : les salons texte du serveur seront importés."
      : `Renseignez l'URL du serveur et le jeton du bot dans ${CHEMIN_MATTERMOST}, puis ` +
        "cliquez sur « Se connecter » : les canaux et deux semaines d'historique seront " +
        "alors importés.",
  );
  return {
    kind: "vide",
    titre:
      liste.length === 2
        ? "Aucun canal synchronisé (Mattermost et Discord)."
        : liste[0] === "discord"
          ? "Aucun salon synchronisé."
          : "Aucun canal synchronisé.",
    detail: plusieurs ? details.join(" ") : (details[0] ?? ""),
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
 *  ① aucune plateforme activée, ou état inconnu ⇒ aucun encart ;
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
 * @param {unknown} status corps de `GET /api/chat/status` (`null` = pas encore reçu).
 * @param {{nombre?: number, connue?: boolean}} [etatListe] ce que la barre sait de
 *   SA liste : nombre d'éléments rendus, et fait de l'avoir REÇUE du serveur.
 * @returns `null` (rien à dire), ou `{ kind: "chargement" | "echec" | "vide",
 *   titre, detail }`.
 */
export function platformsNotice(status, etatListe) {
  const actives = plateformesActives(status);
  if (actives.length === 0) return null;

  const nombre = Number(etatListe?.nombre ?? 0);
  const listeConnue = etatListe?.connue === true;
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
  // ④ Une plateforme ACTIVÉE qui n'a pas abouti : sa raison, jamais « aucun canal ».
  for (const plateforme of actives) {
    if (etatDe(plateforme).etat === "off") {
      return noticeEchec(plateforme, raisonDe(plateforme), "impossible");
    }
    const raison = raisonDe(plateforme);
    if (etatDe(plateforme).etat !== "on" && raison !== "") {
      return noticeEchec(plateforme, raison, "interrompue");
    }
  }
  // ⑤ Connexion EN COURS : l'import peut encore remplir la liste.
  for (const plateforme of actives) {
    if (etatDe(plateforme).etat !== "on") return noticeChargement(plateforme);
  }
  // ⑥ Synchro faite et rien à lister.
  return noticeVide(actives);
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
 * Phrase d'HONNÊTETÉ sur une plateforme activée dont le jeton manque, ou `null`.
 *
 * ⚠️ Cas à DIRE (exigence 2026-11-10) : « interrupteur allumé, jeton absent » ⇒
 * aucune connexion n'est possible. Le contraire est aussi à dire : « jeton posé,
 * plateforme désactivée » — un jeton seul n'active RIEN.
 *
 * @param {unknown} status corps de `GET /api/chat/status`.
 * @returns {string[]} une phrase par situation, dans l'ordre d'affichage.
 */
export function plateformesAvertissements(status) {
  if (!status || typeof status !== "object") return [];
  const phrases = [];
  for (const option of PLATEFORME_OPTIONS) {
    const plateforme = option.plateforme;
    const vue = status[plateforme];
    if (!vue || typeof vue !== "object") continue;
    const active = status?.plateformes?.[plateforme] === true;
    const jeton = vue.jetonEnregistre === true;
    if (active && !jeton) {
      phrases.push(
        `${option.label} est ACTIVÉ mais aucun jeton n'est enregistré : ` +
          `aucune connexion ne sera ouverte (${plateforme === "discord" ? CHEMIN_DISCORD : CHEMIN_MATTERMOST}).`,
      );
    }
    if (!active && jeton) {
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
 * ⚠️ `chat.<plateforme>.enabled` (`on` | `off`) est un réglage PROPRE AU BOT
 * ACTIF : la route est donc celle de ce bot, jamais `/api/config` (qui répondrait
 * `bot_scoped_field`).
 * ⚠️ Ce n'est PLUS un choix exclusif : allumer Discord n'éteint pas Mattermost,
 * et RIEN n'éteint le local (il n'est pas un réglage).
 * ⚠️ Le JETON n'est pas touché ici : désactiver une plateforme ne détruit pas son
 * secret (on peut la rallumer), et poser un jeton n'active rien — l'interrupteur
 * est la seule intention.
 */
export async function savePlatformEnabled(plateforme, actif, fetchImpl) {
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  const botId = await idBotActif(fetchImpl);
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

/** Crée un élément DOM (jamais d'injection HTML). */
function el(tag, attrs = {}, text) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else node.setAttribute(key, value);
  }
  if (typeof text === "string") node.textContent = text;
  return node;
}

/**
 * Monte les DEUX INTERRUPTEURS de plateforme (Mattermost, Discord) + leur pastille.
 *
 * ⚠️ Ce n'est PLUS un sélecteur exclusif : chaque bouton est un interrupteur
 * indépendant (`aria-pressed` = activé). Allumer l'un n'éteint pas l'autre, et le
 * LOCAL n'a pas de bouton — il n'est pas un choix, il est toujours disponible.
 *
 * ⚠️ Les deux boutons sont TOUJOURS visibles (aucun masquage) : une plateforme
 * éteinte doit pouvoir être allumée, et la voir éteinte est l'information. Seul
 * l'état INCONNU (statut pas encore reçu) laisse les boutons à `aria-pressed=false`
 * sans rien affirmer d'autre.
 *
 * @param {object} deps
 * @param {HTMLElement} deps.root conteneur (créé par l'appelant).
 * @param {(plateforme: string, actif: boolean) => void} deps.onChange appelé au
 *   clic, avec l'état À DEMANDER (l'inverse de l'état affiché).
 * @returns {{ element: HTMLElement, update(status: unknown): void }}
 */
export function initPlatformToggles(deps) {
  const root = deps.root;
  if (!root) throw new Error("initPlatformToggles : racine absente");
  const onChange = deps.onChange ?? (() => undefined);

  const group = el("div", {
    class: "chat-mode",
    role: "group",
    "aria-label": "Plateformes de discussion",
  });
  /** `plateforme` → { button, badge } */
  const entrees = new Map();
  for (const option of PLATEFORME_OPTIONS) {
    const badge = el(
      "span",
      { class: "chat-mode__badge", role: "img", "aria-label": CHAT_BADGES.off.label },
      CHAT_BADGES.off.glyph,
    );
    const button = el(
      "button",
      {
        class: "chat-mode__btn",
        type: "button",
        "data-plateforme": option.plateforme,
        title: option.title,
        "aria-pressed": "false",
      },
      option.label,
    );
    button.append(badge);
    button.addEventListener("click", () => {
      const actif = button.getAttribute("aria-pressed") === "true";
      onChange(option.plateforme, !actif);
    });
    entrees.set(option.plateforme, { button, badge });
    group.append(button);
  }
  root.replaceChildren(group);

  function update(status) {
    for (const [plateforme, entree] of entrees) {
      const active = status?.plateformes?.[plateforme] === true;
      entree.button.setAttribute("aria-pressed", active ? "true" : "false");
      entree.button.classList.toggle("chat-mode__btn--active", active);
      const state = badgeFor(status?.[plateforme]);
      entree.badge.textContent = state.glyph;
      entree.badge.title = state.title;
      entree.badge.setAttribute("aria-label", `${state.label} — ${state.title}`);
      entree.badge.setAttribute("data-etat", state.etat);
    }
  }

  return { element: group, update };
}
