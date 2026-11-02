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
 */

import { badgeFor } from "./chat-mode.js";

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

function formatDate(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString("fr-FR");
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
 * Libellés du réglage « Agents distants » (`chat.remoteAgents`).
 *
 * ⚠️ CE SONT LES MOTS EMPLOYÉS PAR LE MESSAGE DE REFUS d'un outil long
 * (`REMOTE_AGENTS_SETTING_PATH`, `src/llm/tool-policy.ts`) : « Configuration →
 * Conversation → Agents distants (tout en bas de la page) ». L'onglet s'appelle
 * « Conversation » — ⚠️ PAS « Discussions », qui n'existe pas comme onglet
 * (défaut de production corrigé le 2026-11-02). Renommer ce libellé sans renommer
 * le chemin rendrait le refus inutilisable — un test statique verrouille l'égalité.
 */
export const REMOTE_AGENTS_LABEL = "Agents distants";

/**
 * Id STABLE du contrôle : c'est AUSSI l'ancre de la page (`/config#chat-remote-agents`),
 * reconnue par `tabFromHash` (`public/ui/config.js`) pour ouvrir l'onglet
 * « Conversation » puis défiler jusqu'ici.
 */
export const REMOTE_AGENTS_ANCHOR = "chat-remote-agents";

/**
 * SECOND réglage, INDÉPENDANT (demande utilisateur du 2026-11-02 : « images oui,
 * agents non » était impossible avec un seul interrupteur).
 *
 * ⚠️ Les deux contrôles sont côte à côte et NE partagent AUCUNE option : changer
 * l'un ne touche pas l'autre. C'est la seule façon de répondre à « est-ce que je
 * peux différencier l'accès aux agents de l'accès aux outils ? ».
 */
export const REMOTE_TOOLS_LABEL = "Outils distants";

/** Ancre de page du contrôle « Outils distants » (`/config#chat-remote-tools`). */
export const REMOTE_TOOLS_ANCHOR = "chat-remote-tools";

/**
 * Texte affiché quand l'état effectif n'a PAS pu être lu (`GET /api/chat/status`).
 *
 * ⚠️ On n'affiche JAMAIS « Désactivé » dans ce cas : ce serait un état effectif
 * INVENTÉ, et l'utilisateur croirait la délégation coupée alors qu'elle ne l'est
 * peut-être pas (défaut de production constaté le 2026-11-02).
 */
export const REMOTE_AGENTS_UNKNOWN = "Valeur inconnue (impossible de joindre le serveur)";

/** Texte d'aide du réglage « Agents distants ». */
export const REMOTE_AGENTS_HELP =
  "Ouvre l'accès aux MACHINES que vous avez appairées : déléguer une tâche à un agent, " +
  "lister les agents, consulter le coffre de secrets (noms seulement). Activé : Yuki peut " +
  "DÉLÉGUER un travail long (il part en arrière-plan, son résultat revient dans le canal). " +
  "Désactivé (défaut) : aucune délégation, aucune commande, aucun transfert de fichier. " +
  "⚠️ La GÉNÉRATION D'IMAGE ne dépend PAS de ce réglage : elle est ouverte par « " +
  "Outils distants » ci-dessous. ⚠️ Réglage GLOBAL : il vaut pour TOUS les canaux " +
  "suivis, et n'importe quel membre d'un canal peut alors faire exécuter du travail sur " +
  "vos machines.";

/** Texte d'aide du réglage « Outils distants ». */
export const REMOTE_TOOLS_HELP =
  "Ouvre les capacités qui ne touchent à AUCUNE machine : génération d'image, libraire " +
  "(recherche, lecture, archivage, capture de page), archive « vie antérieure » et " +
  "recherche dans les conversations archivées. Activé : ces outils fonctionnent dans un " +
  "canal sans ouvrir la délégation. Désactivé (défaut) : Yuki converse, lit les pièces " +
  "jointes et publie des messages, mais ne génère rien et n'interroge aucune archive. " +
  "⚠️ Restent TOUJOURS ouverts : lister/lire une pièce jointe, publier dans un canal " +
  "suivi, envoyer un fichier déjà rattaché à la conversation. ⚠️ Restent TOUJOURS " +
  "fermés : les outils qui demandent une approbation humaine (commande, capture " +
  "d'écran, transfert de fichier, demande de secret).";

/**
 * MONTE une section de réglage d'accès distant.
 *
 * ⚠️ DEUX contrôles, DEUX réglages (2026-11-02) : ce n'est pas cosmétique —
 * chacun écrit SA clé de configuration et lit SA valeur effective (`distant.agents`
 * ou `distant.outils`). Aucun des deux ne devine l'autre.
 *
 * ⚠️ Ce réglage n'avait AUCUNE interface au départ : le message de refus renvoyait
 * vers un chemin qui n'existait pas, et l'activer demandait d'éditer `config.json`.
 * La valeur effective vient du serveur (`GET /api/chat/status`), jamais d'une
 * supposition locale.
 *
 * ⚠️ ÉTAT INCONNU ASSUMÉ : si `GET /api/chat/status` échoue, le `<select>` affiche
 * « Valeur inconnue (impossible de joindre le serveur) » et les DEUX contrôles sont
 * désactivés — on ne modifie pas un état qu'on ne connaît pas, et on n'affiche pas
 * un « Désactivés (défaut) » qui serait un mensonge.
 */
function renderRemoteSwitch({
  label,
  anchor,
  aide: texteAide,
  cle,
  flux,
  lire,
  textes,
  request,
  report,
  shared,
  refresh,
}) {
  const section = h("section", { class: "config-group" });
  const title = h("h2", { class: "config-group__title", text: label });
  const aide = h("p", { class: "config-helper", text: texteAide });
  const select = h("select", {
    class: "config-input",
    id: anchor,
    "aria-label": label,
  });
  for (const [valeur, libelle] of textes.options) {
    select.append(h("option", { value: valeur, text: libelle }));
  }
  /** ⚠️ Option d'ÉTAT INCONNU : présente SEULEMENT quand le statut manque. */
  const optionInconnue = h("option", { value: "inconnue", text: REMOTE_AGENTS_UNKNOWN });
  let inconnueAffichee = false;
  const save = h("button", {
    class: "button button--small",
    type: "button",
    text: "Enregistrer le réglage",
  });
  const etat = h("p", { class: "config-helper" });
  save.addEventListener("click", () => {
    void (async () => {
      // ⚠️ Garde supplémentaire : un clic ne doit jamais écrire une valeur dont on
      // n'a pas lu l'état courant (`shared.state` absent).
      if (lire(shared.state) === undefined) {
        render();
        return;
      }
      try {
        // ⚠️ `PUT /api/config` (même route que les autres réglages) : la valeur est
        // validée par le schéma serveur, appliquée à chaud (`apply: hot`). L'en-tête
        // de FLUX est le même diagnostic que la page Configuration.
        await request("/api/config", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "x-yuki-config": "1",
            "x-yuki-config-flow": flux,
          },
          body: JSON.stringify({ [cle]: select.value }),
        });
        await refresh();
      } catch (error) {
        await report(etat, "Réglage non enregistré", error);
      }
    })();
  });
  section.append(
    title,
    aide,
    h("div", { class: "config-actions" }, [select, save]),
    etat,
  );

  function render() {
    const valeur = lire(shared.state);
    if (valeur === undefined) {
      // ⚠️ État NON LU (statut indisponible, ou pas encore arrivé) : on le DIT, et on
      // n'offre pas d'écriture.
      if (!inconnueAffichee) {
        select.append(optionInconnue);
        inconnueAffichee = true;
      }
      select.value = "inconnue";
      select.disabled = true;
      save.disabled = true;
      // La RAISON de l'échec n'est pas recopiée dans le texte (elle peut être longue) :
      // elle est disponible au survol, et JOURNALISÉE côté client.
      etat.title = typeof shared.error === "string" ? shared.error : "";
      etat.textContent =
        "Valeur effective : inconnue (impossible de joindre le serveur) — rechargez la page " +
        "pour réessayer.";
      return;
    }
    if (inconnueAffichee) {
      select.removeChild(optionInconnue);
      inconnueAffichee = false;
    }
    select.disabled = false;
    save.disabled = false;
    select.value = valeur === "actives" ? "actives" : "desactive";
    etat.textContent = valeur === "actives" ? textes.actives : textes.desactives;
  }

  return { element: section, render };
}

/**
 * Section « Agents distants » (`chat.remoteAgents`) : les MACHINES appairées.
 *
 * ⚠️ Montée EN PREMIER dans le panneau : c'est la section que cherche la personne
 * qui lit le chemin d'un refus (« Configuration → Conversation → Agents distants »),
 * et l'ordre ne change rien à l'independent des deux réglages.
 */
function renderRemoteAgents(deps) {
  return renderRemoteSwitch({
    label: REMOTE_AGENTS_LABEL,
    anchor: REMOTE_AGENTS_ANCHOR,
    aide: REMOTE_AGENTS_HELP,
    cle: "chat.remoteAgents",
    flux: "chat-remote-agents",
    lire: (state) => state?.distant?.agents,
    textes: {
      options: [
        ["desactive", "Désactivés (défaut)"],
        ["actives", "Activés (délégation possible)"],
      ],
      actives: "Valeur effective : agents ACTIVÉS (délégation disponible dans les canaux).",
      desactives:
        "Valeur effective : agents DÉSACTIVÉS (aucune délégation, aucune commande, " +
        "aucun transfert de fichier depuis un canal).",
    },
    ...deps,
  });
}

/** Section « Outils distants » (`chat.remoteTools`) : image, libraire, archives. */
function renderRemoteTools(deps) {
  return renderRemoteSwitch({
    label: REMOTE_TOOLS_LABEL,
    anchor: REMOTE_TOOLS_ANCHOR,
    aide: REMOTE_TOOLS_HELP,
    cle: "chat.remoteTools",
    flux: "chat-remote-tools",
    lire: (state) => state?.distant?.outils,
    textes: {
      options: [
        ["desactive", "Désactivés (défaut)"],
        ["actives", "Activés (images, libraire, archives)"],
      ],
      actives:
        "Valeur effective : outils ACTIVÉS (génération d'image, libraire, archives " +
        "disponibles dans les canaux).",
      desactives:
        "Valeur effective : outils DÉSACTIVÉS (pas de génération d'image, pas de " +
        "libraire, pas d'archive depuis un canal).",
    },
    ...deps,
  });
}

/**
 * Monte le panneau (une section par plateforme câblée côté serveur).
 *
 * @param {object} deps
 * @param {HTMLElement} deps.root conteneur (`#chat-root`).
 * @param {object} [deps.HolafModal] modale de la brique (`alert`).
 * @param {typeof fetch} [deps.fetchImpl] `fetch` injectable (tests).
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
      remoteAgents.render();
      remoteTools.render();
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
      remoteAgents.render();
      remoteTools.render();
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
    renderPlatform({ description, request, report, shared, refresh }),
  );

  /**
   * ⚠️ DEUX RÉGLAGES D'ACCÈS DISTANT, INDÉPENDANTS : « Agents distants » (les
   * machines appairées) et « Outils distants » (image, libraire, archives). Ils
   * décident des outils de TOUS les canaux, donc ils n'appartiennent à aucune
   * plateforme — chacun est monté UNE fois.
   *
   * ⚠️ ORDRE : les AGENTS d'abord — c'est ce chemin que nomme le message de refus
   * d'un outil long (`REMOTE_AGENTS_SETTING_PATH`).
   */
  const remoteAgents = renderRemoteAgents({ request, report, shared, refresh });
  const remoteTools = renderRemoteTools({ request, report, shared, refresh });

  const limits = h("p", {
    class: "config-helper",
    text:
      "Limites assumées : les demandes d'APPROBATION ne sont pas relayées dans un canal " +
      "(une approbation se donne dans l'interface web), et la MÉMOIRE durable n'est pas " +
      "branchée en mode distant — il n'existe donc AUCUN réglage pour l'activer. Seuls « " +
      REMOTE_AGENTS_LABEL +
      " » et « " +
      REMOTE_TOOLS_LABEL +
      " » décident des outils d'un canal, et chacun n'ouvre QUE sa famille.",
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
    root.replaceChildren(
      ...visibles.map((platform) => platform.element),
      remoteAgents.element,
      remoteTools.element,
      limits,
    );
  }
  mount();
  // ⚠️ Avant la première lecture, l'état effectif est INCONNU : on l'affiche comme tel
  // au lieu de laisser les `<select>` sur « Désactivés (défaut) », une valeur que
  // personne n'a lue (défaut de production corrigé le 2026-11-02).
  remoteAgents.render();
  remoteTools.render();

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
function renderPlatform({ description, request, report, shared, refresh }) {
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

  section.append(
    title,
    intro,
    statusLine,
    reasonLine,
    intentLine,
    ...(extraRow !== null ? [extraRow] : []),
    tokenRow,
    connectRow,
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
