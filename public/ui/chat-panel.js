/**
 * Panneau « Discussions » de la page `/config` — **Mattermost ET Discord** (lot 21).
 *
 * Il branche Yuki sur une plateforme de discussion : pour Mattermost l'URL du serveur,
 * pour Discord le serveur à suivre et la borne d'envoi ; dans les deux cas le JETON du bot
 * (saisi UNE SEULE FOIS, jamais réaffiché), l'état de la connexion, l'avancement du
 * backfill (deux semaines) et la liste des canaux suivis.
 *
 * Routes utilisées (aucune dépendance nouvelle, toutes same-origin et gardées par
 * l'en-tête `X-Yuki-Config: 1`) :
 *   GET   /api/chat/status                 → état complet (mode, plateformes)
 *   PUT   /api/chat/mattermost             → { baseUrl }
 *   PUT   /api/chat/discord                → { guildId?, maxUploadBytes? }
 *   POST  /api/chat/<plateforme>/jeton     → { jeton }  ⚠️ jamais relu
 *   POST  /api/chat/<plateforme>/connexion → démarrage de la synchronisation
 *
 * ⚠️ CSP STRICTE (`default-src 'none'`, `style-src 'self'`) : aucun `innerHTML`, aucun
 * attribut `style`, aucun appel du NAVIGATEUR vers Mattermost ni vers Discord. Tout passe
 * par le gateway : le jeton ne quitte donc jamais le serveur (il n'est même pas relu par
 * cette page, qui n'apprend que « jeton enregistré : oui / non »).
 *
 * ⚠️ UN SEUL code pour les deux plateformes (`renderPlatform`) : recopier le panneau pour
 * Discord aurait dupliqué la saisie du jeton, l'affichage de l'état et de la liste des
 * canaux — c'est-à-dire exactement ce qui ne doit pas diverger entre deux plateformes.
 *
 * ⚠️ LIMITES AFFICHÉES, pas cachées : les demandes d'APPROBATION ne sont pas relayées dans
 * un canal et la MÉMOIRE durable n'est pas branchée en mode distant.
 *
 * ⚠️ CE PANNEAU NE PORTE PLUS LES DEUX INTERRUPTEURS D'ACCÈS DISTANT : « Agents
 * distants » (`chat.remoteAgents`) et « Outils distants » (`chat.remoteTools`) sont
 * des clés d'INSTANCE (classement validé) et vivent désormais dans le catalogue de
 * la page Instance, onglet « Agents » (`config-fields.js`, groupe `acces-distant`).
 * Seul `chat.mode` — le choix de plateforme d'UN bot — reste ici.
 */

import { badgeFor } from "./chat-mode.js";
import { BOT_PAR_DEFAUT, BOT_WRITE_HEADERS, cheminConfigBot } from "./bots-api.js";
import { formatDateTimeFr } from "./horodatage.js";

/** En-tête exigé par les routes de discussion (lecture ET écriture). */
const READ_HEADERS = { accept: "application/json", "x-yuki-config": "1" };
const WRITE_HEADERS = { "content-type": "application/json", "x-yuki-config": "1" };

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "on" && typeof value === "function") el.addEventListener("click", value);
    else if (value === true) el.setAttribute(key, "");
    else if (value !== false && value !== undefined && value !== null) {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** Horodatage lisible — fuseau `ui.timeZone` (défaut UTC), suffixé, jamais celui du navigateur. */
function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return formatDateTimeFr(date);
}

/** Message d'erreur rendu par le serveur (français), sinon le code HTTP. */
function apiMessage(error, fallback) {
  const data = error?.data ?? {};
  return data.message ?? data.error ?? error?.message ?? fallback;
}

/** Libellés des modes de réponse (mêmes mots que le menu contextuel du canal). */
export const REPLY_MODE_TEXT = {
  tout: "Répondre à tous les messages",
  auto: "Répondre quand on s'adresse à elle (jugé par le modèle)",
  mention: "Répondre seulement si elle est citée",
};

/** Texte du réglage « COMMENT répondre » (`fil` | `nouveau`), valeur EFFECTIVE. */
export const REPLY_STYLE_TEXT = {
  fil: "réponse dans le fil",
  nouveau: "nouveau message",
};

/** Texte du réglage « CITER l'auteur » (`oui` | `non`), valeur EFFECTIVE. */
export const QUOTE_AUTHOR_TEXT = {
  oui: "mention de l'auteur (notifie)",
  non: "sans mention",
};

/** Texte du bandeau « historique antérieur non importé ». */
export const BACKFILL_BANNER =
  "Historique antérieur non importé : le backfill est borné à 2 semaines ET à 1 000 " +
  "messages par canal. Ce qui précède reste sur la plateforme, Yuki ne l'a pas lu.";

/**
 * Avertissement affiché quand l'intent `MESSAGE_CONTENT` n'est pas activé.
 *
 * ⚠️ C'est LA cause n°1 de « le bot est connecté mais ne répond pas » : sans cet intent,
 * Discord envoie les messages avec un contenu VIDE. Le panneau le dit EN GRAS, avant que
 * l'utilisateur ne cherche ailleurs.
 */
export const MESSAGE_CONTENT_WARNING =
  "⚠️ L'intent privilégié MESSAGE_CONTENT n'est pas activé : Discord renvoie des messages " +
  "au contenu VIDE, et Yuki ne lit que ceux où elle est citée. Activez-le dans le portail " +
  "développeur (Applications → votre bot → Bot → Privileged Gateway Intents → MESSAGE " +
  "CONTENT), puis relancez la connexion.";

/** Texte de l'état de l'intent quand il EST actif (ou pas encore lu). */
export const MESSAGE_CONTENT_OK = "Intent MESSAGE_CONTENT : activé.";
export const MESSAGE_CONTENT_UNKNOWN =
  "Intent MESSAGE_CONTENT : pas encore vérifié (lancez la connexion pour le savoir).";

/**
 * Nombre lisible d'octets (français, une décimale).
 *
 * ⚠️ Sert à AFFICHER l'ampleur de ce qu'une suppression ferait perdre — jamais à décider.
 */
export function formatOctets(octets) {
  const n = Number.isFinite(octets) ? Math.max(0, Math.trunc(octets)) : 0;
  if (n < 1024) return `${n} octet${n > 1 ? "s" : ""}`;
  const ko = n / 1024;
  if (ko < 1024) return `${ko.toFixed(1).replace(".", ",")} Kio`;
  return `${(ko / 1024).toFixed(1).replace(".", ",")} Mio`;
}

/** Phrase de confirmation de la case à cocher (saisie EXPLICITE, pas un simple « OK »). */
export const CONFIRMATION_SUPPRESSION =
  "Je comprends que ces conversations seront effacées définitivement et ne pourront " +
  "pas être récupérées.";

/**
 * Texte affiché AVANT de supprimer : ce qui sera perdu, en clair.
 *
 * ⚠️ On ne demande pas de confirmer une destruction sans en montrer l'ampleur : nombre de
 * conversations, nombre de messages, taille du miroir.
 */
export function texteSuppression(platform, miroir) {
  const nom = platform === "discord" ? "Discord" : "Mattermost";
  const conversations = Number(miroir?.conversations ?? 0);
  const messages = Number(miroir?.messages ?? 0);
  const octets = Number(miroir?.octets ?? 0);
  return (
    `La connexion ${nom} sera supprimée : ${conversations} ` +
    `conversation${conversations > 1 ? "s" : ""} et ${messages} ` +
    `message${messages > 1 ? "s" : ""} du miroir (${formatOctets(octets)}) seront ` +
    "effacés, ainsi que le jeton du bot dans le coffre."
  );
}

/** Texte du débranchement (action NON destructive : le miroir reste). */
export function texteDebranchement(platform, miroir) {
  const nom = platform === "discord" ? "Discord" : "Mattermost";
  const conversations = Number(miroir?.conversations ?? 0);
  return (
    `Débrancher ${nom} ? Le jeton du bot sera effacé et la synchronisation arrêtée. ` +
    `Les ${conversations} conversation${conversations > 1 ? "s" : ""} déjà importée` +
    `${conversations > 1 ? "s" : ""} resteront lisibles dans leur onglet : il suffira de ` +
    "remettre le jeton pour repartir."
  );
}

/** Description d'une plateforme : ce qui la distingue, rien de plus. */
const PLATFORMS = [
  {
    id: "mattermost",
    titre: "Discussions — Mattermost",
    intro:
      "Yuki lit les canaux Mattermost dont son bot est membre (deux semaines d'historique, " +
      "1 000 messages par canal au plus) et y répond selon le mode choisi par canal " +
      "(clic droit sur le canal, dans la barre latérale).",
    /** Champs propres à la plateforme, au-dessus du jeton. */
    extraFields: "mattermost",
  },
  {
    id: "discord",
    titre: "Discussions — Discord",
    intro:
      "Yuki lit les salons TEXTE des serveurs Discord où son bot est présent (deux " +
      "semaines d'historique, 1 000 messages par canal au plus). Les fils ne sont pas des " +
      "conversations : leurs messages rejoignent le salon qui les contient.",
    extraFields: "discord",
  },
];


/**
 * Monte le panneau (une section par plateforme câblée côté serveur).
 *
 * @param {object} deps
 * @param {HTMLElement} deps.root conteneur (`#chat-root`).
 * @param {object} [deps.HolafModal] modale de la brique (`alert`).
 * @param {(url: string, init?: RequestInit) => Promise<Response>} [deps.fetchImpl] `fetch` injectable (tests).
 * @param {string} [deps.botId] bot AFFICHÉ (`/bots?b=<id>`). Absent ou égal à
 *   `botDePile` ⇒ panneau d'INSTANCE (`/api/chat/**`) ; sinon le panneau vise SES
 *   routes et SON jeton (`initChatPanelBot`).
 * @param {string} [deps.botDePile] bot de la PILE (`GET /api/bots` → `principal`) :
 *   le seul que servent les routes d'instance `/api/chat/**`.
 * @param {string} [deps.botNom] nom lisible du bot affiché.
 * @param {boolean} [deps.botDemarre] ce qui TOURNE (`execution.demarre`), distinct
 *   de « actif » : un bot arrêté reste configurable.
 * @param {() => void} [deps.onFirstRender] appelé UNE fois, après la PREMIÈRE
 *   lecture de l'état (succès ou échec) et le rendu qui la suit. Sert aux ancres
 *   (`/config#chat-remote-agents`) : la hauteur de la page n'est définitive qu'à ce
 *   moment-là (les sections des plateformes sont remplies par cette lecture).
 */
export function initChatPanel(deps) {
  const root = deps.root;
  if (!root) throw new Error("initChatPanel : racine absente");
  const modal = deps.HolafModal ?? null;
  const doFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  /**
   * Bot AFFICHÉ (`/bots?b=<id>`) et bot de la PILE (`GET /api/bots` → `principal`).
   *
   * ⚠️ LOT 42 — POURQUOI CE PANNEAU SAIT VISER UN AUTRE BOT QUE CELUI DE LA PILE :
   * les routes d'instance `/api/chat/**` sont liées au bot de la PILE (elles lisent et
   * écrivent SON miroir, SON jeton, SON `chat.mode`). Les monter pour un autre bot
   * afficherait les réglages de `yuki` et écrirait CHEZ LUI. Pour tout autre bot, le
   * panneau passe donc par SES routes : `PUT /api/bots/<id>/config` (réglages propres)
   * et le coffre (`POST /api/secrets`, nom `YUKI_CHAT_<BOT>__<PLATEFORME>`).
   */
  const botId = typeof deps.botId === "string" ? deps.botId : "";
  const botDePile =
    typeof deps.botDePile === "string" && deps.botDePile !== ""
      ? deps.botDePile
      : BOT_PAR_DEFAUT;
  if (botId !== "" && botId !== botDePile) {
    return initChatPanelBot({ ...deps, botId, botDePile });
  }
  const onFirstRender = typeof deps.onFirstRender === "function" ? deps.onFirstRender : null;
  let premiereLectureTerminee = false;
  /** ⚠️ Une SEULE fois : ensuite l'utilisateur est maître de son défilement. */
  function signalerPremierRendu() {
    if (premiereLectureTerminee) return;
    premiereLectureTerminee = true;
    onFirstRender?.();
  }
  /**
   * État PARTAGÉ par les sections (une seule requête `GET /api/chat/status`).
   *
   * ⚠️ Aucune donnée secrète : URL, booléens, compteurs. Chaque section relit ce qu'elle
   * doit afficher ; aucune ne garde une copie qui pourrait diverger.
   */
  const shared = { state: null, error: undefined };

  async function request(url, init) {
    const response = await doFetch(url, init);
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const error = new Error(data?.message ?? `HTTP ${response.status}`);
      error.data = data;
      throw error;
    }
    return data;
  }

  async function refresh() {
    try {
      shared.state = await request("/api/chat/status", { headers: READ_HEADERS, cache: "no-store" });
      shared.error = undefined;
      mount();
      for (const platform of platforms) platform.render();
      signalerPremierRendu();
    } catch (error) {
      // ⚠️ ON N'INVENTE RIEN : l'état précédent est OUBLIÉ (un état périmé serait un
      // mensonge de plus) et le réglage « Agents distants » affiche « Valeur inconnue »
      // avec ses contrôles DÉSACTIVÉS — il ne retombe jamais sur « Désactivés (défaut) ».
      const message = apiMessage(error, "erreur inconnue");
      shared.state = null;
      shared.error = message;
      // Journalisation côté client, SANS secret : la route ne rend que URL, booléens,
      // compteurs (jamais un jeton).
      console.warn("[config/chat] état des discussions illisible :", message);
      for (const platform of platforms) {
        platform.setError(`Impossible de lire l'état des discussions : ${message}`);
      }
      signalerPremierRendu();
    }
  }

  async function report(onFallback, titre, error) {
    const message = apiMessage(error, "erreur inconnue");
    if (modal?.alert) await modal.alert(titre, message, { okText: "Compris" });
    else onFallback(`${titre} — ${message}`);
  }

  /** Une section par plateforme, construite par la MÊME fabrique. */
  const platforms = PLATFORMS.map((description) =>
    renderPlatform({ description, request, report, shared, refresh, modal }),
  );

  /**
   * ⚠️ LES DEUX INTERRUPTEURS D'ACCÈS DISTANT NE SONT PLUS ICI. « Agents distants »
   * et « Outils distants » (`chat.remoteAgents`, `chat.remoteTools`) sont des clés
   * d'INSTANCE depuis le classement validé (`docs/classement-des-reglages.md`) :
   * ils sont rendus par le CATALOGUE de la page Instance (onglet « Agents »,
   * `config-fields.js` groupe `acces-distant`, `#chat-remote-agents` /
   * `#chat-remote-tools`). Ce panneau-ci ne rend plus que les PLATEFORMES et les
   * canaux suivis de CE bot (`chat.mode` reste une clé de bot).
   *
   * ⚠️ Les garder ici en double aurait créé DEUX contrôles écrivant la même clé,
   * dont un sur une route qui la refuse (`instance_scoped_field`).
   */
  const limites = h("p", {
    class: "config-helper",
    text:
      "Limites assumées : les demandes d'APPROBATION ne sont pas relayées dans un canal " +
      "(une approbation se donne dans l'interface web), et la MÉMOIRE durable n'est pas " +
      "branchée en mode distant — il n'existe donc AUCUN réglage pour l'activer. Les deux " +
      "interrupteurs qui décident des outils d'un canal (« Agents distants », « Outils " +
      "distants ») sont communs à l'installation : voir Configuration → Agents.",
  });

  /**
   * Monte les sections RÉELLEMENT câblées côté serveur.
   *
   * ⚠️ On ne rend PAS une section pour une plateforme non câblée : afficher « État
   * Discord indisponible » dans un processus qui n'a jamais eu de client Discord serait
   * une fausse alerte. Avant le premier état, les deux sections sont montées (elles
   * affichent alors la raison de l'échec de lecture).
   */
  function mount() {
    const visibles =
      shared.state === null
        ? platforms
        : platforms.filter((platform) => shared.state?.[platform.platform] !== undefined);
    root.replaceChildren(...visibles.map((platform) => platform.element), limites);
  }
  mount();

  void refresh();
  return { element: root, refresh };
}

/**
 * Fabrique d'une section de plateforme.
 *
 * ⚠️ Tout ce qui n'est PAS spécifique (badge, raison, jeton, backfill, canaux) est écrit
 * ici UNE fois. Les `extraFields` sont la seule différence : URL du serveur pour Mattermost,
 * serveur suivi + borne d'envoi pour Discord.
 */
function renderPlatform({ description, request, report, shared, refresh, modal }) {
  const platform = description.id;
  const section = h("section", { class: "config-group" });
  const title = h("h2", { class: "config-group__title", text: description.titre });
  const intro = h("p", { class: "config-helper", text: description.intro });
  const statusLine = h("p", { class: "config-helper chat-panel__status" });
  const reasonLine = h("p", { class: "config-helper chat-panel__reason" });
  reasonLine.hidden = true;
  // ⚠️ L'avertissement d'INTENT est un vrai bandeau (rouge) : c'est un prérequis manquant,
  // pas une information neutre.
  const intentLine = h("p", { class: "config-error" });
  intentLine.hidden = true;

  // ─── Champs propres à la plateforme ─────────────────────────────────────
  let extraRow = null;
  let urlInput = null;
  let guildInput = null;
  let uploadInput = null;
  if (description.extraFields === "mattermost") {
    urlInput = h("input", {
      class: "config-input",
      type: "url",
      id: "chat-mattermost-url",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "https://mattermost.exemple.fr",
      "aria-label": "URL du serveur Mattermost",
    });
    const saveUrl = h("button", {
      class: "button button--small",
      type: "button",
      text: "Enregistrer l'URL",
    });
    saveUrl.addEventListener("click", () => {
      void (async () => {
        try {
          await request("/api/chat/mattermost", {
            method: "PUT",
            headers: WRITE_HEADERS,
            body: JSON.stringify({ baseUrl: urlInput.value.trim() }),
          });
          await refreshSelf();
        } catch (error) {
          await report(setError, "URL non enregistrée", error);
        }
      })();
    });
    extraRow = h("div", { class: "chat-panel__field" }, [
      h("label", { class: "config-label", for: "chat-mattermost-url", text: "URL du serveur" }),
      h("div", { class: "config-actions" }, [urlInput, saveUrl]),
    ]);
  } else {
    guildInput = h("input", {
      class: "config-input",
      type: "text",
      id: "chat-discord-guild",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "identifiant du serveur (vide = tous)",
      "aria-label": "Serveur Discord à suivre",
    });
    uploadInput = h("input", {
      class: "config-input",
      type: "number",
      id: "chat-discord-upload",
      min: "1",
      step: "1048576",
      "aria-label": "Borne d'envoi par fichier (octets)",
    });
    const saveSettings = h("button", {
      class: "button button--small",
      type: "button",
      text: "Enregistrer les réglages",
    });
    saveSettings.addEventListener("click", () => {
      void (async () => {
        const bytes = Number.parseInt(uploadInput.value, 10);
        try {
          await request("/api/chat/discord", {
            method: "PUT",
            headers: WRITE_HEADERS,
            body: JSON.stringify({
              guildId: guildInput.value.trim(),
              ...(Number.isFinite(bytes) && bytes > 0 ? { maxUploadBytes: bytes } : {}),
            }),
          });
          await refreshSelf();
        } catch (error) {
          await report(setError, "Réglages non enregistrés", error);
        }
      })();
    });
    extraRow = h("div", { class: "chat-panel__field" }, [
      h("label", {
        class: "config-label",
        for: "chat-discord-guild",
        text: "Serveur à suivre (vide = tous ceux du bot)",
      }),
      h("div", { class: "config-actions" }, [guildInput, saveSettings]),
      h("label", {
        class: "config-label",
        for: "chat-discord-upload",
        text: "Borne d'envoi par fichier (octets)",
      }),
      h("div", { class: "config-actions" }, [uploadInput]),
      h("p", {
        class: "config-helper",
        text:
          "8 Mio par défaut (8 388 608 octets), 25 Mio au maximum (26 214 400 octets, soit " +
          "la taille maximale d'une requête Discord). Un fichier plus gros est refusé AVANT " +
          "tout envoi, et le texte part quand même.",
      }),
    ]);
  }

  // ─── Jeton (commun) ─────────────────────────────────────────────────────
  const tokenInput = h("input", {
    class: "config-input",
    type: "password",
    id: `chat-${platform}-token`,
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "jeton du bot (affiché une seule fois)",
    "aria-label": "Jeton du bot",
  });
  const saveToken = h("button", {
    class: "button button--small",
    type: "button",
    text: "Enregistrer le jeton",
  });
  const tokenState = h("p", { class: "config-helper" });
  /**
   * ⚠️ LOT 36 (L10) : état des jetons PAR BOT (`vue.jetonsBots`, calculé par le
   * serveur depuis le coffre). Un bot sans jeton reste en local : c'est écrit,
   * jamais supposé. Aucune valeur de jeton n'est affichée — seulement « posé »
   * ou « absent » et le NOM du secret à créer.
   */
  const jetonsBotsState = h("p", { class: "config-helper" });
  saveToken.addEventListener("click", () => {
    void (async () => {
      const jeton = tokenInput.value.trim();
      if (jeton === "") {
        await report(
          setError,
          "Jeton vide",
          new Error(
            platform === "discord"
              ? "Copiez le jeton du bot depuis le portail développeur Discord avant de l'enregistrer."
              : "Copiez le jeton du bot depuis Mattermost avant de l'enregistrer.",
          ),
        );
        return;
      }
      try {
        await request(`/api/chat/${platform}/jeton`, {
          method: "POST",
          headers: WRITE_HEADERS,
          body: JSON.stringify({ jeton }),
        });
        // ⚠️ Le champ est vidé IMMÉDIATEMENT : le jeton ne reste pas dans le DOM.
        tokenInput.value = "";
        await refreshSelf();
      } catch (error) {
        await report(setError, "Jeton non enregistré", error);
      }
    })();
  });
  const tokenRow = h("div", { class: "chat-panel__field" }, [
    h("label", { class: "config-label", for: `chat-${platform}-token`, text: "Jeton du bot" }),
    h("div", { class: "config-actions" }, [tokenInput, saveToken]),
    tokenState,
    jetonsBotsState,
    h("p", {
      class: "config-helper",
      text:
        "Le jeton est chiffré dans le coffre de Yuki et n'est PLUS JAMAIS réaffiché : " +
        "s'il est perdu, remplacez-le par un nouveau jeton.",
    }),
  ]);

  const connectButton = h("button", {
    class: "button button--small",
    type: "button",
    text: "Se connecter",
  });
  const connectRow = h("div", { class: "config-actions" }, [connectButton]);
  connectButton.addEventListener("click", () => {
    void (async () => {
      connectButton.disabled = true;
      try {
        const body = {
          ...(urlInput !== null ? { baseUrl: urlInput.value.trim() } : {}),
          ...(tokenInput.value.trim() !== "" ? { jeton: tokenInput.value.trim() } : {}),
        };
        await request(`/api/chat/${platform}/connexion`, {
          method: "POST",
          headers: WRITE_HEADERS,
          body: JSON.stringify(body),
        });
        tokenInput.value = "";
        await refreshSelf();
      } catch (error) {
        await report(setError, "Connexion impossible", error);
      } finally {
        connectButton.disabled = false;
      }
    })();
  });

  const backfillLine = h("p", { class: "config-helper chat-panel__backfill" });
  const bannerLine = h("p", { class: "config-error" });
  bannerLine.hidden = true;
  const channelsList = h("ul", { class: "chat-panel__channels" });

  // ─── Débrancher / Supprimer la connexion (lot 30) ──────────────────────────
  // ⚠️ DEUX actions DISTINCTES, jamais une seule :
  //  · Débrancher = jeton effacé + synchro arrêtée, MIROIR CONSERVÉ (réversible) ;
  //  · Supprimer  = jeton ET miroir effacés (DESTRUCTIF, IRRÉVERSIBLE) — confirmation
  //    FORTE : compteurs affichés + case à cocher explicite (`HolafModal`, jamais
  //    `window.confirm`).
  const disconnectButton = h("button", {
    class: "button button--ghost button--small",
    type: "button",
    text: "Débrancher",
  });
  const removeButton = h("button", {
    class: "button button--stop button--small",
    type: "button",
    text: "Supprimer la connexion",
  });
  const dangerActions = h("div", { class: "config-actions" }, [disconnectButton, removeButton]);
  const dangerRow = h("div", { class: "chat-panel__field" }, [
    h("h3", { class: "config-group__title", text: "Connexion" }),
    dangerActions,
    h("p", {
      class: "config-helper",
      text:
        "« Débrancher » efface le jeton et arrête la synchronisation : les conversations " +
        "déjà importées restent lisibles, et remettre le jeton suffit à repartir. " +
        "« Supprimer la connexion » efface AUSSI ces conversations (action destructive, " +
        "irréversible).",
    }),
  ]);

  /** Vue courante de CETTE plateforme (ce que l'utilisateur vient de lire). */
  function vueCourante() {
    return shared.state?.[platform] ?? {};
  }

  /**
   * Confirmation FORTE d'une suppression : compteurs + CASE À COCHER explicite.
   *
   * ⚠️ Pas un simple « OK » : le bouton destructeur reste DÉSACTIVÉ tant que la case
   * n'est pas cochée (et `onClick` refuse de toute façon), et le texte dit ce qui sera
   * perdu (`texteSuppression`).
   *
   * @returns `true` seulement si l'utilisateur a coché la case puis confirmé.
   */
  async function confirmerSuppression(miroir) {
    if (!modal?.open) {
      // ⚠️ Sans modale, aucune confirmation possible : on REFUSE, on ne dégrade pas en
      // action destructive silencieuse.
      setError(
        "Suppression impossible : la fenêtre de confirmation n'est pas disponible dans " +
          "cette page. Rechargez /config.",
      );
      return false;
    }
    const idCase = `chat-${platform}-confirme-suppression`;
    const laCase = h("input", { type: "checkbox", id: idCase });
    const corps = h("div", { class: "chat-panel__danger" }, [
      h("p", { text: texteSuppression(platform, miroir) }),
      h("p", {
        class: "config-error",
        text:
          "Cette action est IRRÉVERSIBLE : le miroir (les fichiers des conversations) et " +
          "le jeton du bot seront effacés, sans corbeille.",
      }),
      h("label", { class: "config-label", for: idCase }, [laCase, ` ${CONFIRMATION_SUPPRESSION}`]),
    ]);
    return new Promise((resolve) => {
      modal.open({
        title: "Supprimer la connexion",
        size: "sm",
        content: corps,
        closeOnOverlay: false,
        buttons: [
          { text: "Annuler", value: false, type: "cancel", guard: false },
          {
            text: "Supprimer définitivement",
            value: true,
            type: "danger",
            // Double garde : le bouton est désactivé, et le clic refuse tant que la
            // case n'est pas cochée.
            onClick: () => laCase.checked === true,
          },
        ],
        onOpen: (ctrl) => {
          const bouton = ctrl?.footer?.querySelector?.(".holaf-modal-btn-danger") ?? null;
          if (!bouton) return;
          bouton.disabled = true;
          laCase.addEventListener("change", () => {
            bouton.disabled = laCase.checked !== true;
          });
        },
        onClose: (resultat) => resolve(resultat === true),
      });
    });
  }

  disconnectButton.addEventListener("click", () => {
    void (async () => {
      const confirme = modal?.confirm
        ? await modal.confirm("Débrancher la connexion", texteDebranchement(platform, vueCourante().miroir), {
            confirmText: "Débrancher",
          })
        : true;
      if (!confirme) return;
      try {
        await request(`/api/chat/${platform}/connexion`, {
          method: "DELETE",
          headers: WRITE_HEADERS,
        });
        // ⚠️ Le panneau se met à jour : état `off`, champs vidés, compteurs relus.
        tokenInput.value = "";
        await refreshSelf();
      } catch (error) {
        await report(setError, "Débranchement impossible", error);
      }
    })();
  });

  removeButton.addEventListener("click", () => {
    void (async () => {
      const miroir = vueCourante().miroir ?? {};
      const confirme = await confirmerSuppression(miroir);
      if (!confirme) return;
      try {
        await request(`/api/chat/${platform}/miroir`, {
          method: "DELETE",
          headers: WRITE_HEADERS,
          // ⚠️ Le serveur REFUSE sans cette confirmation : un simple DELETE ne suffit
          // jamais à détruire un miroir.
          body: JSON.stringify({ confirmation: true }),
        });
        tokenInput.value = "";
        await refreshSelf();
      } catch (error) {
        await report(setError, "Suppression impossible", error);
      }
    })();
  });

  section.append(
    title,
    intro,
    statusLine,
    reasonLine,
    intentLine,
    ...(extraRow !== null ? [extraRow] : []),
    tokenRow,
    connectRow,
    dangerRow,
    backfillLine,
    bannerLine,
    h("h3", { class: "config-group__title", text: "Canaux suivis" }),
    channelsList,
  );

  /** Relit l'état PARTAGÉ et redessine toutes les sections. */
  async function refreshSelf() {
    await refresh();
  }

  function setError(message) {
    statusLine.textContent = message;
  }

  function render() {
    const vue = shared.state?.[platform];
    if (!vue) {
      statusLine.textContent =
        platform === "discord"
          ? "État Discord indisponible : redémarrez Yuki."
          : "État Mattermost indisponible : redémarrez Yuki.";
      return;
    }
    const badge = badgeFor({ plateforme: vue.plateforme });
    statusLine.textContent = `${badge.glyph} ${badge.label}`;
    statusLine.title = badge.title;
    const raison = vue.plateforme?.raison;
    reasonLine.hidden = typeof raison !== "string" || raison === "";
    reasonLine.textContent = raison ?? "";

    if (urlInput !== null && document.activeElement !== urlInput) urlInput.value = vue.url ?? "";
    if (guildInput !== null && document.activeElement !== guildInput) {
      guildInput.value = vue.guildId ?? "";
    }
    if (uploadInput !== null && document.activeElement !== uploadInput) {
      uploadInput.value = String(vue.maxUploadBytes ?? "");
    }
    tokenState.textContent = vue.jetonEnregistre
      ? "Un jeton est enregistré (il n'est jamais réaffiché)."
      : "Aucun jeton enregistré : la connexion est impossible tant qu'il manque.";
    jetonsBotsState.textContent = texteJetonsBots(vue.jetonsBots);
    // ⚠️ Une fois enregistré, le champ reste VIDE : on ne pré-remplit jamais un secret.
    tokenInput.value = "";

    // ─── Intent MESSAGE_CONTENT (Discord seulement) ────────────────────────
    if (platform === "discord") {
      const intent = vue.intentMessageContent;
      intentLine.hidden = intent !== false;
      intentLine.textContent = intent === false ? MESSAGE_CONTENT_WARNING : "";
      if (intent === true) {
        intentLine.hidden = false;
        intentLine.className = "config-helper";
        intentLine.textContent = MESSAGE_CONTENT_OK;
      } else if (intent === null) {
        intentLine.hidden = false;
        intentLine.className = "config-helper";
        intentLine.textContent = MESSAGE_CONTENT_UNKNOWN;
      }
    }

    const sync = vue.synchronisation ?? {};
    const backfill = sync.backfill ?? {};
    const parts = [];
    parts.push(
      sync.canauxSuivis !== undefined ? `${sync.canauxSuivis} canal(aux) suivi(s)` : "aucun canal suivi",
    );
    parts.push(
      backfill.fait
        ? `backfill effectué depuis le ${formatDate(backfill.depuis)}`
        : "backfill non terminé",
    );
    parts.push(`${backfill.imports ?? 0} message(s) importé(s)`);
    if (sync.rattrapageActif) parts.push("rattrapage périodique actif (60 s)");
    backfillLine.textContent = parts.join(" · ");
    bannerLine.hidden = backfill.borneAtteinte !== true;
    bannerLine.textContent = BACKFILL_BANNER;

    channelsList.replaceChildren();
    const canaux = Array.isArray(vue.canaux) ? vue.canaux : [];
    if (canaux.length === 0) {
      channelsList.append(h("li", { class: "config-helper", text: "Aucun canal pour l'instant." }));
      return;
    }
    for (const canal of canaux) {
      // ⚠️ Les trois réglages sont LUS, jamais devinés : ce sont les valeurs EFFECTIVES
      // du serveur (défauts appliqués côté serveur, qui diffèrent par plateforme).
      // ⚠️ Le serveur rend déjà la valeur EFFECTIVE ; ce repli n'existe que pour un état
      // incomplet, et il suit le défaut par plateforme (`mention` pour les deux aujourd'hui).
      const mode = canal.replyMode ?? "mention";
      const style = canal.replyStyle ?? "fil";
      const quote = canal.quoteAuthor ?? "non";
      channelsList.append(
        h("li", { class: "chat-panel__channel" }, [
          h("span", { class: "chat-panel__channel-name", text: canal.titre ?? canal.id }),
          h("span", {
            class: "config-helper",
            text:
              ` — ${canal.messageCount ?? 0} message(s) · ${REPLY_MODE_TEXT[mode] ?? mode}` +
              ` · ${REPLY_STYLE_TEXT[style] ?? style} · ${QUOTE_AUTHOR_TEXT[quote] ?? quote}`,
          }),
          canal.historiqueAnterieur
            ? h("span", { class: "config-error", text: " · historique antérieur non importé" })
            : null,
        ]),
      );
    }
  }

  return {
    element: section,
    platform,
    render,
    setError,
    refresh: refreshSelf,
  };
}

/**
 * Texte de l'état des jetons PAR BOT (lot 36, L10).
 *
 * ⚠️ Le NOM du secret (`YUKI_CHAT_<BOT>__<PLATEFORME>`) est affiché, jamais sa
 * valeur : on explique donc exactement ce qu'il reste à créer, sans jamais
 * exposer un secret dans la page.
 *
 * @param {unknown} jetonsBots liste `{ botId, nom, configure }` du serveur.
 * @returns {string} une ligne lisible (vide si l'instance n'en fournit pas).
 */
export function texteJetonsBots(jetonsBots) {
  if (!Array.isArray(jetonsBots) || jetonsBots.length === 0) return "";
  const parts = jetonsBots.map((entree) => {
    const bot = typeof entree?.botId === "string" ? entree.botId : "?";
    const nom = typeof entree?.nom === "string" ? entree.nom : "";
    const pose = entree?.configure === true;
    return `${bot} : ${pose ? "jeton posé" : `aucun jeton (${nom})`}`;
  });
  return `Jetons par bot — ${parts.join(" · ")}`;
}

// ─── JETON D'UN BOT : le NOM du secret (même règle que le serveur) ──────────

/** Préfixe commun des jetons de discussion (`src/secrets/references.ts`). */
export const PREFIXE_SECRET_CHAT = "YUKI_CHAT";

/**
 * Nom du secret du jeton d'un bot pour une plateforme :
 * `YUKI_CHAT_<BOT>__<PLATEFORME>` (séparateur `__`, tirets du slug → `_`).
 *
 * ⚠️ COPIE ASSUMÉE de `nomSecretChat` (`src/chat/jetons-bot.ts`) : cette page est
 * du JavaScript servi tel quel, elle ne peut pas importer un module TypeScript du
 * serveur. La règle est verrouillée par un test qui COMPARE les deux
 * (`tests/ui/plateformes-par-bot.test.ts`) : renommer l'un sans l'autre ferait
 * écrire un jeton que le serveur ne lirait jamais.
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

/** Plateformes de discussion proposées à un bot (mêmes identifiants que `chat.mode`). */
const PLATEFORMES_BOT = [
  {
    id: "mattermost",
    titre: "Discussions — Mattermost",
    intro:
      "Le bot se connecte à Mattermost avec SON jeton : il lit les canaux dont il est " +
      "membre (deux semaines d'historique, 1 000 messages par canal au plus).",
  },
  {
    id: "discord",
    titre: "Discussions — Discord",
    intro:
      "Le bot se connecte à Discord avec SON jeton : il lit les salons TEXTE des " +
      "serveurs où il est présent (deux semaines d'historique, 1 000 messages au plus).",
  },
];

/** Choix de plateforme (`chat.mode`) : libellé lisible pour chaque valeur du schéma. */
const MODES_BOT = [
  { valeur: "local", libelle: "Local — aucune plateforme" },
  { valeur: "mattermost", libelle: "Mattermost" },
  { valeur: "discord", libelle: "Discord" },
];

/**
 * Phrase d'honnêteté sur l'état de CE bot : ce qu'on sait, et ce qu'on ne sait pas.
 *
 * ⚠️ L'état de connexion en direct (`connecté` / `erreur`) n'est exposé par le
 * serveur QUE pour le bot de la pile (`GET /api/chat/status`) : il n'existe aucune
 * route d'état par bot. On le DIT, au lieu de laisser croire à un état inconnu
 * présenté comme « non configuré ».
 */
export function texteEtatConnexionBot(demarre) {
  const demarrage =
    demarre === true
      ? "Le bot tourne : son jeton est lu à son démarrage, un jeton ajouté maintenant " +
        "sera pris en compte à son prochain démarrage."
      : demarre === false
        ? "Le bot est arrêté : ce panneau reste ÉDITABLE (on configure un bot arrêté), " +
          "et ces réglages s'appliqueront à son démarrage."
        : "Ces réglages s'appliquent au démarrage du bot.";
  return (
    `${demarrage} L'état de la connexion en direct (connecté / erreur) n'est exposé ` +
    "que pour le bot de la pile : ici, on sait seulement si le jeton de ce bot est au " +
    "coffre."
  );
}

/**
 * Panneau « Plateformes » d'un bot AUTRE que celui de la pile (`/bots?b=<id>`).
 *
 * ⚠️ ÉCRITURES, toutes vers CE bot :
 *  - `chat.mode`, `chat.discord.guildId`, `chat.discord.maxUploadBytes` →
 *    `PUT /api/bots/<id>/config` (ce sont des clés `scope: bot`) ;
 *  - le jeton → `POST /api/secrets` au nom `YUKI_CHAT_<BOT>__<PLATEFORME>`.
 * ⚠️ AUCUNE route d'instance `/api/chat/**` n'est appelée ici : elles écrivent dans
 * l'overlay et le jeton du bot de la PILE (`yuki`). C'est le bug le plus grave que
 * ce panneau pouvait causer, et la raison d'être de cette branche.
 *
 * @param {object} deps mêmes dépendances que `initChatPanel`, plus `botId`,
 *   `botDePile`, `botNom` et `botDemarre` (`GET /api/bots` → `execution.demarre`).
 */
export function initChatPanelBot(deps) {
  const root = deps.root;
  if (!root) throw new Error("initChatPanelBot : racine absente");
  const modal = deps.HolafModal ?? null;
  const doFetch = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const onFirstRender = typeof deps.onFirstRender === "function" ? deps.onFirstRender : null;
  const botId = String(deps.botId);
  const botNom =
    typeof deps.botNom === "string" && deps.botNom !== "" ? deps.botNom : botId;
  const botDemarre = deps.botDemarre === true;
  const chemin = cheminConfigBot(botId);

  /** État LU (jamais deviné) : valeurs effectives du bot + noms du coffre. */
  const etat = {
    mode: "local",
    guildId: "",
    maxUploadBytes: "",
    noms: new Set(),
    coffreConfigure: true,
    erreur: "",
    statut: "",
  };
  let premierRenduFait = false;
  function signalerPremierRendu() {
    if (premierRenduFait) return;
    premierRenduFait = true;
    onFirstRender?.();
  }

  async function request(url, init) {
    const response = await doFetch(url, init);
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    if (!response.ok) {
      const error = new Error(data?.message ?? `HTTP ${response.status}`);
      error.data = data;
      throw error;
    }
    return data;
  }

  async function report(titre, error) {
    const message = apiMessage(error, "erreur inconnue");
    if (modal?.alert) await modal.alert(titre, message, { okText: "Compris" });
    else etat.statut = `${titre} — ${message}`;
  }

  // ─── En-tête : à QUI appartient ce panneau ───────────────────────────────
  const titre = h("h2", {
    class: "config-group__title",
    text: `Plateformes de ${botNom}`,
  });
  const identite = h("p", {
    class: "config-helper",
    text:
      `Ces réglages appartiennent à « ${botNom} » (identifiant ${botId}) : ils sont ` +
      "enregistrés pour ce bot, jamais pour celui de la pile.",
  });

  // ─── ① Choix de la plateforme (`chat.mode`) ─────────────────────────────
  const modeSelect = h("select", {
    class: "config-input",
    id: "chat-bot-mode",
    "aria-label": `Plateforme de discussion de ${botNom}`,
  });
  for (const mode of MODES_BOT) {
    modeSelect.append(h("option", { value: mode.valeur, text: mode.libelle }));
  }
  const saveMode = h("button", {
    class: "button button--small",
    type: "button",
    text: "Enregistrer la plateforme",
  });
  const modeStatut = h("p", { class: "config-helper", role: "status" });
  saveMode.addEventListener("click", () => {
    void (async () => {
      const valeur = String(modeSelect.value ?? "");
      if (!MODES_BOT.some((mode) => mode.valeur === valeur)) {
        modeStatut.textContent = "Choisissez Local, Mattermost ou Discord.";
        return;
      }
      saveMode.disabled = true;
      modeStatut.textContent = "Enregistrement…";
      try {
        await request(chemin, {
          method: "PUT",
          headers: BOT_WRITE_HEADERS,
          body: JSON.stringify({ "chat.mode": valeur }),
        });
        modeStatut.textContent = `Plateforme de ${botNom} enregistrée : ${libelleMode(valeur)}.`;
        await refresh();
      } catch (error) {
        modeStatut.textContent = "";
        await report("Plateforme non enregistrée", error);
      } finally {
        saveMode.disabled = false;
      }
    })();
  });
  const modeSection = h("section", { class: "config-group" }, [
    h("h2", { class: "config-group__title", text: "Plateforme de discussion" }),
    h("p", {
      class: "config-helper",
      text:
        "Quelle plateforme ce bot utilise comme discussion PRINCIPALE. La " +
        "synchronisation, elle, démarre dès qu'un jeton est présent.",
    }),
    h("div", { class: "config-row" }, [
      h("label", { class: "config-label", for: "chat-bot-mode", text: "Plateforme" }),
      h("div", { class: "config-actions" }, [modeSelect, saveMode]),
    ]),
    modeStatut,
  ]);

  // ─── ② Jeton + réglages propres, une section par plateforme ─────────────
  const sections = PLATEFORMES_BOT.map((plateforme) => {
    const jetonInput = h("input", {
      class: "config-input",
      type: "password",
      id: `chat-bot-${plateforme.id}-jeton`,
      autocomplete: "new-password",
      spellcheck: "false",
      placeholder: "jeton du bot (jamais réaffiché)",
      "aria-label": `Jeton ${plateforme.id} de ${botNom}`,
    });
    const saveJeton = h("button", {
      class: "button button--small",
      type: "button",
      text: "Enregistrer le jeton",
    });
    const jetonEtat = h("p", { class: "config-helper" });
    const jetonStatut = h("p", { class: "config-helper", role: "status" });
    saveJeton.addEventListener("click", () => {
      void (async () => {
        const jeton = jetonInput.value.trim();
        if (jeton === "") {
          jetonStatut.textContent =
            "Collez d'abord le jeton de ce bot (il est chiffré dans le coffre).";
          return;
        }
        saveJeton.disabled = true;
        jetonStatut.textContent = "Enregistrement…";
        try {
          await request("/api/secrets", {
            method: "POST",
            headers: BOT_WRITE_HEADERS,
            body: JSON.stringify({
              name: nomSecretChatBot(botId, plateforme.id),
              value: jeton,
              label: `Jeton ${plateforme.id} du bot ${botId}`,
            }),
          });
          // ⚠️ Le champ est vidé IMMÉDIATEMENT : le jeton ne reste pas dans le DOM.
          jetonInput.value = "";
          jetonStatut.textContent = "Jeton enregistré : il ne sera plus jamais affiché.";
          await refresh();
        } catch (error) {
          jetonStatut.textContent = "";
          await report("Jeton non enregistré", error);
        } finally {
          saveJeton.disabled = false;
        }
      })();
    });

    const enfants = [
      h("h2", { class: "config-group__title", text: plateforme.titre }),
      h("p", { class: "config-helper", text: plateforme.intro }),
      h("div", { class: "chat-panel__field" }, [
        h("label", {
          class: "config-label",
          for: `chat-bot-${plateforme.id}-jeton`,
          text: "Jeton du bot",
        }),
        h("div", { class: "config-actions" }, [jetonInput, saveJeton]),
        jetonEtat,
        jetonStatut,
        h("p", {
          class: "config-helper",
          text:
            "Le jeton est chiffré dans le coffre de Yuki sous le nom propre à ce bot : " +
            "il n'est plus jamais réaffiché.",
        }),
      ]),
    ];

    // Options PROPRES au bot (Discord) : serveur suivi et borne d'envoi.
    let guildInput = null;
    let uploadInput = null;
    const optionsStatut = h("p", { class: "config-helper", role: "status" });
    if (plateforme.id === "discord") {
      guildInput = h("input", {
        class: "config-input",
        type: "text",
        id: "chat-bot-discord-guild",
        autocomplete: "off",
        spellcheck: "false",
        placeholder: "identifiant du serveur (vide = tous)",
        "aria-label": "Serveur Discord suivi",
      });
      uploadInput = h("input", {
        class: "config-input",
        type: "number",
        min: "1",
        id: "chat-bot-discord-upload",
        autocomplete: "off",
        "aria-label": "Taille maximale d'un fichier envoyé (octets)",
      });
      const saveOptions = h("button", {
        class: "button button--small",
        type: "button",
        text: "Enregistrer les options",
      });
      saveOptions.addEventListener("click", () => {
        void (async () => {
          const octets = Number(uploadInput.value);
          if (!Number.isInteger(octets) || octets < 1) {
            optionsStatut.textContent =
              "La borne d'envoi doit être un nombre entier d'octets (au moins 1).";
            return;
          }
          saveOptions.disabled = true;
          optionsStatut.textContent = "Enregistrement…";
          try {
            await request(chemin, {
              method: "PUT",
              headers: BOT_WRITE_HEADERS,
              body: JSON.stringify({
                "chat.discord.guildId": guildInput.value.trim(),
                "chat.discord.maxUploadBytes": octets,
              }),
            });
            optionsStatut.textContent = "Options Discord de ce bot enregistrées.";
            await refresh();
          } catch (error) {
            optionsStatut.textContent = "";
            await report("Options non enregistrées", error);
          } finally {
            saveOptions.disabled = false;
          }
        })();
      });
      enfants.push(
        h("div", { class: "chat-panel__field" }, [
          h("h3", { class: "config-group__title", text: "Options de ce bot" }),
          h("div", { class: "config-row" }, [
            h("label", {
              class: "config-label",
              for: "chat-bot-discord-guild",
              text: "Serveur suivi",
            }),
            guildInput,
          ]),
          h("div", { class: "config-row" }, [
            h("label", {
              class: "config-label",
              for: "chat-bot-discord-upload",
              text: "Taille maximale d'un fichier envoyé (octets)",
            }),
            uploadInput,
          ]),
          h("div", { class: "config-actions" }, [saveOptions]),
          optionsStatut,
        ]),
      );
    }

    return {
      id: plateforme.id,
      element: h("section", { class: "config-group" }, enfants),
      jetonEtat,
      guildInput,
      uploadInput,
    };
  });

  // ─── ③ Ce qu'on sait (et ce qu'on ne sait pas) de l'état ────────────────
  const etatConnexion = h("p", { class: "config-helper", text: texteEtatConnexionBot(botDemarre) });
  const erreurLecture = h("p", { class: "config-error" });
  erreurLecture.hidden = true;

  const limites = h("p", {
    class: "config-helper",
    text:
      "Limites assumées : l'URL du serveur Mattermost se règle depuis le panneau du bot " +
      "de la pile (aucune route ne l'expose pour un autre bot), et les demandes " +
      "d'APPROBATION ne sont pas relayées dans un canal.",
  });

  function libelleMode(valeur) {
    return MODES_BOT.find((mode) => mode.valeur === valeur)?.libelle ?? valeur;
  }

  function render() {
    // ⚠️ On ne réécrit pas le champ que l'utilisateur est en train de changer.
    if (document.activeElement !== modeSelect) modeSelect.value = etat.mode;
    for (const section of sections) {
      section.jetonEtat.textContent = texteEtatJetonBot(
        botId,
        section.id,
        etat.noms,
        etat.coffreConfigure,
      );
      if (section.guildInput !== null && document.activeElement !== section.guildInput) {
        section.guildInput.value = etat.guildId;
      }
      if (section.uploadInput !== null && document.activeElement !== section.uploadInput) {
        section.uploadInput.value = etat.maxUploadBytes;
      }
    }
    const messages = [etat.erreur, etat.statut].filter((texte) => texte !== "");
    erreurLecture.hidden = messages.length === 0;
    erreurLecture.textContent = messages.join(" · ");
  }

  async function refresh() {
    const erreurs = [];
    try {
      const config = await request(chemin, { headers: READ_HEADERS, cache: "no-store" });
      const champs = config?.fields ?? {};
      etat.mode =
        typeof champs["chat.mode"]?.value === "string" ? champs["chat.mode"].value : "local";
      etat.guildId = String(champs["chat.discord.guildId"]?.value ?? "");
      etat.maxUploadBytes = String(champs["chat.discord.maxUploadBytes"]?.value ?? "");
    } catch (error) {
      erreurs.push(`configuration de ce bot illisible : ${apiMessage(error, "erreur inconnue")}`);
    }
    try {
      const secrets = await request("/api/secrets", { headers: READ_HEADERS, cache: "no-store" });
      etat.coffreConfigure = secrets?.configured !== false;
      const entrees = Array.isArray(secrets?.entries) ? secrets.entries : [];
      etat.noms = new Set(
        entrees.map((entree) => String(entree?.name ?? "")).filter((nom) => nom !== ""),
      );
    } catch (error) {
      etat.coffreConfigure = false;
      erreurs.push(`coffre illisible : ${apiMessage(error, "erreur inconnue")}`);
    }
    etat.erreur = erreurs.join(" · ");
    render();
    signalerPremierRendu();
  }

  root.replaceChildren(titre, identite, modeSection, ...sections.map((s) => s.element), etatConnexion, erreurLecture, limites);
  render();
  void refresh();
  return { element: root, refresh };
}
