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
    title:
      "Canaux Mattermost du bot : configuration, jeton et état dans " +
      "/config → Conversation → « Discussions — Mattermost ».",
  },
  {
    mode: "discord",
    label: "Discord",
    title:
      "Salons Discord du bot : configuration, jeton et état dans " +
      "/config → Conversation → « Discussions — Discord ». " +
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
 * Citer (ou non) l'auteur du message auquel Yuki répond.
 *
 * ⚠️ `non` est le DÉFAUT côté serveur (`DEFAULT_QUOTE_AUTHOR`) : aucune citation n'est
 * ajoutée tant que l'utilisateur ne le demande pas.
 */
export const QUOTE_AUTHOR_OPTIONS = [
  { quote: "oui", label: "Citer l'auteur", title: "La réponse commence par une citation de l'auteur du message." },
  { quote: "non", label: "Ne pas citer l'auteur", title: "La réponse ne cite personne (comportement par défaut)." },
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

/**
 * Contenu d'état vide / bandeau pour le mode courant.
 *
 * @returns `null` en mode local (comportement inchangé), sinon
 *   `{ kind: "vide" | "bandeau", titre, detail }`.
 */
export function modeNotice(status) {
  const mode = status?.mode;
  if (mode === "mattermost") {
    return {
      kind: "vide",
      titre: "Aucun canal synchronisé.",
      detail:
        "Renseignez l'URL du serveur et le jeton du bot dans " +
        "/config → Conversation → « Discussions — Mattermost », puis " +
        "cliquez sur « Se connecter » : les canaux et deux semaines d'historique seront " +
        "alors importés.",
    };
  }
  if (mode === "discord") {
    return {
      kind: "vide",
      titre: "Aucun salon synchronisé.",
      detail:
        "Enregistrez le jeton du bot Discord dans " +
        "/config → Conversation → « Discussions — Discord » (et activez " +
        "l'intent MESSAGE_CONTENT dans le portail développeur), puis cliquez sur " +
        "« Se connecter » : les salons texte du serveur seront importés.",
    };
  }
  return null;
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
    for (const [value, button] of buttons) {
      const pressed = value === mode;
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
