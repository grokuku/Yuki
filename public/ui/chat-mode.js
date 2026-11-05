/**
 * Yuki — SÉLECTEUR DE MODE DE DISCUSSION (barre latérale).
 *
 * Trois modes, comme demandé : **Local** (les conversations de Yuki, mode
 * historique), **Mattermost** et **Discord**.
 *
 * ⚠️ Ce module ne parle à AUCUNE plateforme : il lit `GET /api/chat/status` par
 * le gateway (CSP stricte : aucun appel navigateur vers un service distant) et
 * écrit le mode choisi par `PUT /api/config` (en-tête `X-Yuki-Config: 1`). L'état
 * est donc **persisté côté serveur**, pas dans le navigateur.
 *
 * ⚠️ Rendu PUREMENT DOM (`createElement`), aucune injection HTML directe, aucun
 * style en ligne : la CSP `style-src 'self'` reste inchangée.
 */

/**
 * CHEMIN EXACT du réglage de chaque plateforme, dans `/config`.
 *
 * ⚠️ Les MOTS sont ceux de la page elle-même : l'onglet s'appelle
 * « Conversation » et la SECTION « Discussions — Mattermost » / « Discussions —
 * Discord » (`public/ui/chat-panel.js`, titres des panneaux). C'est vérifiable par
 * ancre : `/config#chat-remote-agents` ouvre cet onglet puis défile jusqu'au
 * réglage (`ANCRES_PROFONDES`, `public/ui/config.js:1348`).
 *
 * ⚠️ Un chemin approximatif (« … → « Discussions » ») envoie l'utilisateur
 * chercher une section qui n'existe pas : c'est le défaut corrigé le 2026-11-02.
 * Les textes ci-dessous n'écrivent donc JAMAIS « Discussions » sans la
 * plateforme — un test verrouille l'égalité.
 */
export const CHEMIN_MATTERMOST = "/config → Conversation → « Discussions — Mattermost »";

/** Chemin exact de la section Discord (`/config`, onglet « Conversation »). */
export const CHEMIN_DISCORD = "/config → Conversation → « Discussions — Discord »";

/** Les trois modes proposés, dans l'ordre d'affichage. */
export const CHAT_MODE_OPTIONS = [
  {
    mode: "local",
    label: "Local",
    title: "Conversations de Yuki (mode actuel).",
  },
  {
    mode: "mattermost",
    label: "Mattermost",
    title: `Canaux Mattermost du bot : configuration, jeton et état dans ${CHEMIN_MATTERMOST}.`,
  },
  {
    mode: "discord",
    label: "Discord",
    title:
      `Salons Discord du bot : configuration, jeton et état dans ${CHEMIN_DISCORD}. ` +
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

/** Libellé d'un mode (`mode` inconnu ⇒ la valeur brute, jamais un vide). */
export function chatModeLabel(mode) {
  const option = CHAT_MODE_OPTIONS.find((item) => item.mode === mode);
  return option ? option.label : String(mode ?? "");
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
function noticeVide(mode) {
  if (mode === "discord") {
    return {
      kind: "vide",
      titre: "Aucun salon synchronisé.",
      detail:
        `Enregistrez le jeton du bot Discord dans ${CHEMIN_DISCORD} (et activez ` +
        "l'intent MESSAGE_CONTENT dans le portail développeur), puis cliquez sur " +
        "« Se connecter » : les salons texte du serveur seront importés.",
    };
  }
  return {
    kind: "vide",
    titre: "Aucun canal synchronisé.",
    detail:
      `Renseignez l'URL du serveur et le jeton du bot dans ${CHEMIN_MATTERMOST}, puis ` +
      "cliquez sur « Se connecter » : les canaux et deux semaines d'historique seront " +
      "alors importés.",
  };
}

/**
 * Encart de la barre latérale — DÉCISION UNIQUE, à partir de l'état du mode ET
 * de ce que la liste montre VRAIMENT.
 *
 * ⚠️ DÉFAUT DE PRODUCTION corrigé ici (2026-11-02) : la décision ne regardait que
 * `status.mode`. En mode Mattermost, l'encart « Aucun canal synchronisé »
 * s'affichait donc AUSSI quand 5 canaux étaient listés — deux informations
 * contradictoires, l'utilisateur croyait à une panne de synchronisation.
 *
 * Règles, dans cet ordre (UNE SEULE vérité affichée à la fois) :
 *  ① mode local ou inconnu ⇒ aucun encart ;
 *  ② liste NON VIDE ⇒ aucun encart (la liste dit la vérité, l'état vide la
 *    contredirait) — même si la synchronisation signale une erreur, la raison
 *    reste lisible sur le badge (`badgeFor`) ;
 *  ③ état du mode ou liste pas encore REÇUS ⇒ « chargement » discret (jamais
 *    « aucun canal », jamais une liste vide présentée comme définitive) ;
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
export function modeNotice(status, etatListe) {
  const mode = status?.mode;
  if (mode !== "mattermost" && mode !== "discord") return null;

  const nombre = Number(etatListe?.nombre ?? 0);
  const listeConnue = etatListe?.connue === true;
  const plateforme = status?.plateforme ?? {};
  const raison = typeof plateforme.raison === "string" ? plateforme.raison.trim() : "";

  // ② La LISTE est la première vérité : tant qu'elle a du contenu, aucun encart
  //    d'état vide ni de chargement ne vient la contredire.
  if (Number.isFinite(nombre) && nombre > 0) return null;
  // ③ Rien n'est encore affirmable : ni l'état du mode, ni la liste.
  if (!listeConnue) return noticeChargement(mode);
  // ④ La synchro n'a pas abouti : la raison du SERVEUR, jamais « aucun canal ».
  if (plateforme.etat === "off") return noticeEchec(mode, raison, "impossible");
  if (plateforme.etat !== "on" && raison !== "") return noticeEchec(mode, raison, "interrompue");
  // ⑤ Connexion EN COURS (`connexion` sans raison) : l'import peut encore remplir la
  //    liste, donc on ne prétend pas qu'elle est vide.
  if (plateforme.etat !== "on") return noticeChargement(mode);
  // ⑥ Synchro faite et rien à lister.
  return noticeVide(mode);
}

/**
 * MODES DE DISCUSSION RÉELLEMENT ACTIFS, dans l'ordre du sélecteur.
 *
 * ⚠️ DÉFINITION TRANCHÉE (2026-11-05) — **un type de discussion est actif quand il y a
 * quelque chose à y faire ou à y lire** :
 *  - `local` est TOUJOURS actif (les conversations de Yuki existent même à zéro) ;
 *  - une plateforme est active si un **jeton est enregistré au coffre**
 *    (`jetonEnregistre === true` : on peut s'y connecter, ou il ne manque que l'URL) **ou
 *    si son miroir contient au moins une conversation** (`canaux.length > 0` : même
 *    débranchée, les conversations importées restent lisibles).
 *
 * ⚠️ POURQUOI PAS « `plateforme.etat === "on"` » (connectée seulement) : une plateforme
 * configurée mais momentanément en erreur (jeton refusé, serveur injoignable, redémarrage)
 * est exactement le moment où l'on veut GARDER son onglet pour y lire la raison et la
 * réparer. Inversement, « configurée mais déconnectée » garde ses conversations miroir :
 * les masquer rendrait ces conversations inaccessibles depuis l'interface.
 *
 * @param {unknown} status corps de `GET /api/chat/status`.
 * @returns {string[]} modes actifs (au moins `["local"]`).
 */
export function modesActifs(status) {
  const actifs = ["local"];
  for (const platform of ["mattermost", "discord"]) {
    const vue = status?.[platform];
    if (!vue || typeof vue !== "object") continue;
    const jeton = vue.jetonEnregistre === true;
    const canaux = Array.isArray(vue.canaux) ? vue.canaux.length : 0;
    if (jeton || canaux > 0) actifs.push(platform);
  }
  return actifs;
}

/**
 * Le SÉLECTEUR DE MODE doit-il être visible ?
 *
 * ⚠️ Règle demandée le 2026-11-05 : il ne s'affiche que s'il y a **au moins DEUX types de
 * discussion actifs**. Avec un seul, il n'y a aucun choix à faire : le sélecteur est
 * MASQUÉ (pas « désactivé » — un bouton grisé serait un espace perdu et une question
 * sans réponse).
 *
 * ⚠️ État INCONNU (`status` absent : gateway injoignable) ⇒ visible. Ne rien savoir n'est
 * pas une raison de retirer un contrôle : le masquer affirmerait « un seul type actif »,
 * ce qu'on ne sait pas.
 */
export function selectorVisible(status) {
  if (!status || typeof status !== "object") return true;
  return modesActifs(status).length >= 2;
}

/**
 * Mode sur lequel BASCULER quand le mode courant n'est plus actif, ou `null`.
 *
 * ⚠️ Cas réel : `chat.mode = mattermost` et la connexion est supprimée ⇒ sans bascule,
 * l'interface afficherait un mode MORT (aucune conversation à lister). On retombe sur
 * `local`, qui est toujours actif ; sinon sur le premier mode encore actif.
 *
 * ⚠️ Cette fonction ne DÉCIDE rien côté serveur : elle rend le mode à demander, et
 * l'appelant l'écrit par `saveChatMode` (`PUT /api/config`). Le serveur reste l'autorité.
 */
export function resolveActiveMode(status) {
  if (!status || typeof status !== "object") return null;
  const actifs = modesActifs(status);
  const courant = status.mode;
  if (typeof courant === "string" && actifs.includes(courant)) return null;
  if (actifs.includes("local")) return "local";
  return actifs[0] ?? null;
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
 * Enregistre le mode choisi (`PUT /api/config`) puis rend l'état relu.
 *
 * ⚠️ Le mode est un réglage du serveur (`chat.mode`, `apply: hot`) : un autre
 * onglet voit le changement au rechargement, et le serveur refuse de son côté
 * toute création en mode distant.
 */
export async function saveChatMode(mode, fetchImpl) {
  const doFetch = fetchImpl ?? ((url, init) => fetch(url, init));
  const response = await doFetch("/api/config", {
    method: "PUT",
    headers: { ...WRITE_HEADERS, "x-yuki-config-flow": "chat-mode" },
    body: JSON.stringify({ "chat.mode": mode }),
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
 * Monte le sélecteur segmenté + son badge.
 *
 * @param {object} deps
 * @param {HTMLElement} deps.root conteneur (créé par l'appelant).
 * @param {(mode: string) => void} deps.onChange appelé au clic sur un mode.
 * @returns {{ element: HTMLElement, update(status: unknown): void }}
 */
export function initChatModeSelector(deps) {
  const root = deps.root;
  if (!root) throw new Error("initChatModeSelector : racine absente");
  const onChange = deps.onChange ?? (() => undefined);

  const group = el("div", {
    class: "chat-mode",
    role: "group",
    "aria-label": "Mode de discussion",
  });
  const buttons = new Map();
  for (const option of CHAT_MODE_OPTIONS) {
    const button = el(
      "button",
      {
        class: "chat-mode__btn",
        type: "button",
        "data-mode": option.mode,
        title: option.title,
        "aria-pressed": "false",
      },
      option.label,
    );
    button.addEventListener("click", () => onChange(option.mode));
    buttons.set(option.mode, button);
    group.append(button);
  }
  const badge = el("span", {
    class: "chat-mode__badge",
    role: "img",
    "aria-label": CHAT_BADGES.off.label,
  }, CHAT_BADGES.off.glyph);
  group.append(badge);
  root.replaceChildren(group);

  function update(status) {
    const mode = status?.mode;
    const actifs = modesActifs(status);
    const visible = selectorVisible(status);
    // ⚠️ MASQUÉ, pas désactivé : aucun espace vide, aucun bouton inutile. Le conteneur
    // entier (`root` = `.sidebar__mode`) est retiré du flux, pas seulement grisé.
    root.hidden = !visible;
    group.hidden = !visible;
    for (const [value, button] of buttons) {
      const pressed = value === mode;
      // ⚠️ Un mode INACTIF n'apparaît pas non plus DANS le sélecteur : c'est le but
      // (« s'il n'y a que 2 types actifs dont aucun Discord, Discord n'apparaît plus »).
      button.hidden = !actifs.includes(value);
      button.setAttribute("aria-pressed", pressed ? "true" : "false");
      button.classList.toggle("chat-mode__btn--active", pressed);
    }
    const state = badgeFor(status);
    badge.textContent = state.glyph;
    badge.title = state.title;
    badge.setAttribute("aria-label", `${state.label} — ${state.title}`);
    badge.setAttribute("data-etat", state.etat);
    return state;
  }

  return { element: group, update };
}
