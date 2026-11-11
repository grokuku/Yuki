/**
 * LES DEUX PAGES DE CONFIGURATION — vanilla, `type="module"`, aucune chaîne de
 * build. UN SEUL module pour DEUX pages (lot 35d, sous-lot 1b-4) :
 *
 *  - **Instance** (`/config`, `config.html`) : ce qui est commun à toute
 *    l'installation — 7 onglets ;
 *  - **Bot** (`/bots?b=<slug>`, `bots.html`) : ce qui est propre à UN bot —
 *    6 onglets, avec un sélecteur de bot.
 *
 * La page est déclarée par `data-config-page` sur `<body>` : elle décide des
 * onglets, des groupes rendus et de la DESTINATION des écritures.
 *
 * - lit `GET /api/config` (Instance) ou `GET /api/bots/<id>/config` (Bot) ;
 * - écrit via `PUT /api/config` (Instance : clés `instance` + côté instance des
 *   clés `mixte`) ou `PUT /api/bots/<id>/config` (Bot : clés `bot` + côté bot
 *   des clés `mixte`) — jamais les deux sur la même page ;
 * - teste une connexion LLM via `POST /api/config/llm/test` ;
 * - affiche l'état réel (`status.lightKey/heavyKey/ready`, poll `/health/ready`).
 *
 * La valeur d'une clé saisie n'est JAMAIS réaffichée dans le DOM après
 * enregistrement (uniquement `configured` + `masked`).
 */

/**
 * Brique holaf-fetch — copie pinnée servie sous `/ui/vendor/holaf/holaf-fetch.js`.
 * Import ESM explicite : le chargement est géré par le graphe de modules
 * (`config.html` n'a plus besoin de charger la brique séparément).
 */
import { HolafFetch } from './vendor/holaf/holaf-fetch.js';

/**
 * Brique holaf-modal — copie pinnée sous `/ui/vendor/holaf/holaf-modal.js`.
 * Le CSS n'est PAS injecté par JS (CSP `style-src 'self'` interdit les
 * `<style>` posés dynamiquement) : il est servi en fichier statique, référencé
 * par `config.html` via `/ui/vendor/holaf/holaf-modal.css` (extrait de
 * `HolafModal.getCss()`). `injectStyles: false` coupe l'injection.
 */
import { HolafModal } from './vendor/holaf/holaf-modal.js';
import { createApprovalChannel } from './approval-channel.js';
import { createApprovalLayer } from './approval-window.js';
import { initAgentsPanel } from './agents-panel.js';
import { initImagesPanel } from './images-panel.js';
import { initInstancePasswordPanel } from './instance-password-panel.js';
import { initPersonalityPanel } from './personality-panel.js';
import { initSecretsPanel } from './secrets-panel.js';
import { initSourcesPanel } from './sources-panel.js';
import { initChatPanel } from './chat-panel.js';
import {
  buildConfigPatch,
  emptyValueRefusals,
  engineFieldState,
  originLabel,
  presentConfigSaveError,
  presentRestartRefusal,
  resetValueFor,
  splitConfigPatchByScope,
} from './config-patch.js';
import { cheminConfigBot, listerBots } from './bots-api.js';
import { ouvrirCreationBot, ouvrirSuppressionBot } from './bots-admin.js';
import {
  ANCRES_PROFONDES as ANCRES_PROFONDES_PAR_PAGE,
  CAPACITES_PAGE,
  PHRASE_CAPACITES,
  champsDePage,
  demandeChangementBot,
  groupesDePage,
  groupesParOnglet,
  ligneDePage,
  modaleCreationBot,
  ongletDuHash,
  ongletsDePage,
  pageConnue,
} from './config-pages.js';
import { ALL_FIELDS, FIELD_DEFAULTS, GROUPS, LABELS } from './config-fields.js';
import { initTheme } from './theme.js';
import { setTimeZone } from './horodatage.js';
import { createTtsPlayer } from './tts-player.js';
import { initTtsAssistant } from './tts-assistant.js';
import { initVoicesPanel } from './voices-panel.js';
import { bandeauTravail } from './modeles-aide.js';

HolafModal.configure({ injectStyles: false });

// Rend la brique visible à `theme.js` (son `setTheme` global ne pilote que les
// modales/toasts déjà chargés) — un import ESM ne pose rien sur `window`.
window.HolafModal = HolafModal;

// Thème (famille + mode clair/sombre) : applique le choix persisté (migration
// silencieuse des anciennes valeurs plates) et câble les contrôles de la
// topbar. Le pont `window.HolafModal` ci-dessus permet à theme.js de piloter
// la brique avec le nom exact du preset (holaf-modal 0.5.0).
initTheme();

/* ─── Validations humaines — FENÊTRE FLOTTANTE (D118) ────────────────────
 * ⚠️ `/config` est une AUTRE page que `/` : elle n'avait aucune connexion
 * temps réel. On ouvre la MÊME connexion `/ws` (même protocole,
 * `approval-channel.js`) pour recevoir les demandes de validation EN ATTENTE —
 * notamment à la CONNEXION : `hello` fait ré-émettre l'état vivant par le
 * serveur, donc la fenêtre ne disparaît PAS en passant de `/` à `/config`.
 * La fenêtre est NON bloquante (aucun voile), DÉPLAÇABLE, et ne se ferme pas
 * au clic à côté. */
const approvalLayer = createApprovalLayer({
  onDecide: (id, decision) => {
    if (approvalChannel.decide(id, decision)) return;
    approvalLayer.resetBusy();
    void HolafModal.alert(
      "Hors ligne",
      "Impossible d'envoyer votre décision : la connexion au gateway est perdue. " +
        "Réessayez une fois reconnecté.",
      { okText: "Compris" },
    );
  },
});

const approvalChannel = createApprovalChannel({
  onApproval: (approval) => approvalLayer.show(approval),
  onCleared: (id) => approvalLayer.clear(id),
  onResult: (result) => approvalLayer.showResult(result),
  onError: (code, message) => {
    approvalLayer.resetBusy();
    void HolafModal.alert(
      "Validation impossible",
      message || "Cette demande de validation n'existe plus.",
      { okText: "Compris" },
    );
  },
});

approvalChannel.connect();

const WRITE_HEADERS = {
  "content-type": "application/json",
  "x-yuki-config": "1",
};

/**
 * Identifiant de FLUX (diagnostic en production) transmis au serveur pour
 * chaque écriture : le gateway journalise QUELLE action a demandé la
 * modification (`activate-engine`, `enable-voice`, `config-save`…).
 */
function writeHeaders(flow) {
  return { ...WRITE_HEADERS, "x-yuki-config-flow": flow };
}

/** Délai entre deux sondages de `/health/live` pendant un redémarrage. */
const RESTART_POLL_MS = 1000;
/** Délai maximal d'attente du retour du gateway avant d'annoncer l'échec. */
const RESTART_TIMEOUT_MS = 90_000;

/**
 * PAGE COURANTE — déclarée par le markup (`<body data-config-page="…">`).
 *
 * ⚠️ Une page INCONNUE retombe sur « instance » : c'est la page historique,
 * celle dont tous les réglages vivaient là avant la scission. Un repli sur
 * « bot » demanderait un identifiant de bot que rien ne fournit.
 */
const PAGE = pageConnue(document.body?.dataset?.configPage)
  ? document.body.dataset.configPage
  : "instance";

/** `true` sur la page d'un bot (`/bots`). */
const PAGE_BOT = PAGE === "bot";

/**
 * Bot AFFICHÉ (page Bot uniquement) : renseigné par `resoudreBot()` avant le
 * premier chargement. Sert à lire ET à écrire la configuration de CE bot.
 */
let botCourant = null;
/** Liste `{ id, nom, capacites, actif, ordre }` des bots connus. */
let botsConnus = [];

/**
 * Message d'une action de CYCLE DE VIE (démarrer/arrêter), gardé le temps d'un
 * rendu : le rendu reconstruit la zone, donc le texte doit lui survivre.
 */
let flashBotExecution = "";

/** Slug de bot par défaut quand l'URL en désigne un inconnu (repli silencieux). */
const BOT_REPLI = "yuki";

const state = {
  fields: {},
  status: { lightKey: false, heavyKey: false, ready: false },
  /**
   * Instruction vocale RÉELLE servie par `GET /api/config` (`voiceInstruction`).
   * Jamais recopiée dans l'UI : le bloc affiché est bien celui injecté.
   */
  voiceInstruction: "",
  initial: new Map(),
  inputs: new Map(),
  rows: new Map(),
  secretState: new Map(),
  pendingResets: new Set(),
  /** Note « sans effet avec ce moteur » par champ (voir `refreshEngineFields`). */
  engineNotes: new Map(),
  healthReady: false,
  /** `true` si au moins un contrôle de la page diffère de sa valeur enregistrée. */
  sale: false,
};

/** Des modifications sont-elles en attente sur cette page ? */
function estSale() {
  return state.sale === true;
}

const tablistEl = document.querySelector('.config-tablist[role="tablist"]');
const tabButtons = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
const saveButton = document.getElementById("save");
const saveStatus = document.getElementById("save-status");
const saveDirty = document.getElementById("save-dirty");
const globalError = document.getElementById("global-error");
const availabilityEl = document.getElementById("availability");
/**
 * Bandeau de l'onglet **Modèles** : rôle TRAVAIL indisponible. Élément STATIQUE
 * de `config.html` (CSP inchangée, pas de création de markup) ; seul son
 * `textContent` et son attribut `hidden` changent.
 */
const workModelNoticeEl = document.getElementById("work-model-notice");
const appliedEl = document.getElementById("applied");
const appliedHot = document.getElementById("applied-hot");
const appliedRestart = document.getElementById("applied-restart");
const readyPill = document.getElementById("ready");
const lightPill = document.getElementById("light-key");
const heavyPill = document.getElementById("heavy-key");
const restartButton = document.getElementById("restart");
const restartStatus = document.getElementById("restart-status");
const voicesRoot = document.getElementById("voices-root");
const ttsAssistantRoot = document.getElementById("tts-assistant-root");
/** Zone ⑤ (technique repliée) — second point de montage du MÊME assistant. */
const ttsEngineRoot = document.getElementById("tts-engine-root");
/** Panneau des agents d'exécution (Lot 4, B5) — monté par id. */
const agentsRoot = document.getElementById("agents-root");
/** Section « Mot de passe d'instance » (verrou des agents sensibles). */
const instancePasswordRoot = document.getElementById("instance-password-root");
const secretsRoot = document.getElementById("secrets-root");
/** Panneau des workflows d'images générées (serveur ComfyUI) — monté par id. */
const imagesRoot = document.getElementById("images-root");
/** Panneau des SOURCES (programmes qui réveillent Yuki) — monté par id. */
const sourcesRoot = document.getElementById("sources-root");
/** Conteneur du panneau « Discussions » (Mattermost ET Discord), onglet Conversation. */
const chatRoot = document.getElementById("chat-root");
/** Panneau de la personnalité — monté par id. */
const personalityRoot = document.getElementById("personality-root");
/** Ligne d'explication SOUS le titre (④ : où est allé ce qui a déménagé). */
const pageLigneEl = document.getElementById("page-ligne");
/** Bouton « + » d'ajout de bot (page Bot) : ouvre la modale de CRÉATION. */
const botAddButton = document.getElementById("bot-add");
/** Sélecteur de bot (page Bot) — état porté par `?b=<slug>`. */
const botSelect = document.getElementById("bot-select");
/**
 * LOT 36 (L4) — lien vers la CONVERSATION du bot affiché (`/?b=<slug>`). Sans
 * lui, la page de conversation ouvrirait toujours celle du bot principal.
 */
const botConversationEl = document.getElementById("bot-conversation");
/** Bandeau d'honnêteté (page Bot) : ce qui n'est pas éditable pour ce bot. */
const botNoticeEl = document.getElementById("bot-notice");
/** Zone « Général » d'un bot (nom, slug, avatar, capacités, zone de danger). */
const botGeneralRoot = document.getElementById("bot-general-root");
/** Panneau des voix (Lot 7) — instancié après le premier chargement. */
let voicesPanel = null;
/** Panneau des workflows d'images — instancié après le premier chargement. */
let imagesPanel = null;
/** Page de gestion des DÉCLENCHEURS — onglet « Déclencheurs » (page Bot). */
let sourcesPanel = null;

/**
 * Onglet qui porte chaque groupe SUR CETTE PAGE (page → groupe → onglet).
 * Sert aux pastilles « modifications non enregistrées » et au rendu : un groupe
 * absent de cette table n'a RIEN à faire ici (aucune clé de la portée de la
 * page).
 */
const ONGLET_PAR_GROUPE = new Map(
  groupesDePage(PAGE, GROUPS).map((group) => [group.id, group.tabs[PAGE]]),
);

function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function applyBadge(apply) {
  return h("span", {
    class: `badge badge--${apply === "hot" ? "hot" : "restart"}`,
    text: apply === "hot" ? "à chaud" : "redémarrage",
  });
}

function lockedBadge(variable) {
  return h("span", {
    class: "badge badge--locked",
    text: `Verrouillé par l'environnement (${variable})`,
  });
}

/**
 * Badge d'ORIGINE (③) : rend visible ce qui est réellement actif.
 *
 *  - « valeur par défaut » : rien n'est enregistré, le défaut s'applique (pour un
 *    prompt : le fichier livré, `config/pi/system-prompt.md`) ;
 *  - « personnalisé » : une valeur ENREGISTRÉE l'emporte sur le défaut livré.
 *
 * ⚠️ C'est la seule façon de distinguer les deux cas à l'écran : le contrôle
 * affiche la valeur effective dans les deux cas, et une valeur enregistrée qui
 * copie le défaut est indiscernable sans ce badge.
 */
function originBadge(entry) {
  // Verrouillé par l'environnement : `lockedBadge` le dit déjà (valeur imposée).
  const label = originLabel(entry);
  if (label === null) return null;
  const modifier = entry.origin === "store" ? "store" : "default";
  return h("span", { class: `badge badge--origin-${modifier}`, text: label });
}

function renderSelect(field, entry) {
  const select = h("select", { class: "config-select" });
  for (const [value, label] of field.options) {
    const option = h("option", { value, text: label });
    if (String(entry.value) === value) option.selected = true;
    select.append(option);
  }
  return select;
}

function renderTextLike(field, entry) {
  if (field.kind === "textarea") {
    return h("textarea", { class: "config-textarea", spellcheck: "false" }, entry.value);
  }
  const props = { class: "config-input" };
  if (field.kind === "number") {
    props.type = "number";
    if (field.min !== undefined) props.min = field.min;
    if (field.max !== undefined) props.max = field.max;
    props.value = entry.value;
  } else {
    props.type = "text";
    props.value = entry.value;
  }
  return h("input", props);
}

/** Curseur (`<input type="range">`) avec valeur affichée — pour-mille, etc. */
function renderRange(field, entry) {
  const input = h("input", {
    class: "config-range",
    type: "range",
    min: field.min !== undefined ? field.min : 0,
    max: field.max !== undefined ? field.max : 100,
    step: field.step !== undefined ? field.step : 1,
    value: entry.value,
    "aria-label": field.label,
  });
  const out = h("output", { class: "config-range__value", text: String(entry.value) });
  input.addEventListener("input", () => {
    out.textContent = input.value;
  });
  const wrap = h("div", { class: "config-range-wrap" }, [input, out]);
  return { input, wrap };
}

function renderSecret(field, entry) {
  const locked = Boolean(entry.lockedByEnv);
  const secret = { mode: "idle", input: null };
  state.secretState.set(field.path, secret);

  const container = h("div", { class: "config-secret" });
  const input = h("input", { class: "config-input", type: "password", autocomplete: "off", placeholder: "Nouvelle valeur" });
  input.hidden = true;
  secret.input = input;
  input.addEventListener("input", () => updateDirtyIndicators());

  const valueSpan = h("span", {
    class: "config-secret__value",
    text: entry.configured ? `Clé configurée (${entry.masked})` : "Aucune clé configurée",
  });
  const replaceButton = h("button", { class: "button button--ghost button--small", type: "button", text: "Remplacer" });
  const clearButton = h("button", { class: "button button--danger button--small", type: "button", text: "Effacer" });

  if (locked) {
    container.append(valueSpan, lockedBadge(entry.lockedByEnv));
    input.remove();
    secret.input = null;
    return container;
  }

  if (!entry.configured) {
    input.hidden = false;
    secret.mode = "replace";
    container.append(valueSpan, input);
    return container;
  }

  replaceButton.addEventListener("click", () => {
    secret.mode = "replace";
    input.hidden = false;
    input.value = "";
    input.focus();
    valueSpan.textContent = "Remplacement en cours…";
    updateDirtyIndicators();
  });
  clearButton.addEventListener("click", () => {
    secret.mode = "clear";
    input.hidden = true;
    valueSpan.textContent = "La clé sera effacée à l'enregistrement.";
    updateDirtyIndicators();
  });

  container.append(valueSpan, replaceButton, clearButton, input);
  return container;
}

/** Libellé lisible d'une valeur (mappe les options des `<select>`).
 *
 * ⚠️ Un prompt système livré fait des milliers de caractères : l'afficher ENTIER
 * dans l'aide « Valeur par défaut : … » noierait la page. On tronque (aperçu sur
 * une ligne + nombre de caractères), la valeur réelle restant celle écrite dans
 * le contrôle par « Réinitialiser au défaut ».
 */
function valueLabel(field, value) {
  if (field.kind === "select" && Array.isArray(field.options)) {
    const found = field.options.find(([v]) => String(v) === String(value));
    if (found) return found[1];
  }
  const text = String(value ?? "");
  if (text === "") return "∅ (vide)";
  if (field.kind === "textarea" || text.length > 96) {
    const preview = text.replace(/\s+/g, " ").trim().slice(0, 60);
    return `${preview}… (${text.length} caractères)`;
  }
  return text;
}

/**
 * Valeur par défaut RÉELLE d'un champ, utilisée par l'aide « Valeur par défaut »
 * et par « Réinitialiser au défaut ».
 *
 * Ordre de priorité :
 *  1. `default` servi par `GET /api/config` — c'est la SEULE source exacte, car
 *     pour `prompts.light` / `prompts.heavy` le défaut est le CONTENU DU FICHIER
 *     LIVRÉ (`src/config/runtime.ts`, `readTextFile(env.piSystemPromptPath)`),
 *     que le navigateur ne peut pas deviner ;
 *  2. à défaut, le miroir `FIELD_DEFAULTS` (gateway ancien), qui ne couvre pas
 *     les prompts précisément parce qu'il ne peut pas les connaître.
 *
 * `undefined` = défaut inconnu du client (le bouton reste utile si une
 * surcharge existe : il l'efface côté serveur).
 */
function fieldDefault(field) {
  return resetValueFor(field, state.fields[field.path], FIELD_DEFAULTS);
}

/**
 * « Réinitialiser au défaut » : restaure la valeur PAR DÉFAUT **réelle** dans le
 * contrôle et, si une surcharge existe (`origin === "store"`), demande au
 * serveur de l'effacer (`null` dans le patch via `pendingResets`).
 *
 * ⚠️ DÉCISION : on **efface la surcharge enregistrée** au lieu de réécrire le
 * défaut dans le store. Pourquoi :
 *  - le défaut des prompts est le contenu d'un fichier LIVRÉ (mis à jour avec
 *    l'image) ; le recopier dans le store figerait une copie Périmée, exactement
 *    la panne signalée (un prompt sauvegardé garde l'ancienne consigne) ;
 *  - le store reste minimal (état « par défaut » = absence de clé), et le
 *    fichier livré redevient effectif au prochain démarrage.
 * Le contrôle est donc rempli avec le défaut **servi par le serveur** :
 * l'affichage dit la vérité immédiatement, sans attendre le rechargement.
 */
function resetField(field, control, entry) {
  const fallback = fieldDefault(field);
  if (fallback !== undefined) {
    control.value = String(fallback);
    const out = control.parentElement?.querySelector?.(".config-range__value");
    if (out) out.textContent = control.value;
  }
  if (entry.origin === "store") state.pendingResets.add(field.path);
  else state.pendingResets.delete(field.path);
  refreshVisibility();
  refreshEngineFields();
  updateDirtyIndicators();
}

function renderField(field) {
  const entry = state.fields[field.path] ?? { value: "", origin: "default", apply: "restart" };
  const row = h("div", { class: "config-row" });
  state.rows.set(field.path, row);

  const label = h("label", { class: "config-label" }, [field.label]);
  if (field.kind !== "secret") label.append(applyBadge(entry.apply));
  // ⚠️ ÉTAT VISIBLE (③) : l'utilisateur doit savoir si ce qu'il voit est le
  // défaut livré ou SA valeur. Sans ce badge, un prompt personnalisé (ou vide)
  // est indistinguable du prompt livré — c'est ce qui a fait croire à une
  // « réinitialisation » réussie alors que la consigne n'était plus là.
  if (field.kind !== "secret") {
    const origin = originBadge(entry);
    if (origin) label.append(origin);
  }
  if (entry.lockedByEnv) label.append(lockedBadge(entry.lockedByEnv));
  row.append(label);

  if (field.kind === "secret") {
    row.append(renderSecret(field, entry));
    // Aide contextuelle des secrets (ex. libraire) : jamais de valeur, seulement
    // une explication du rôle du secret.
    if (field.helper) row.append(h("p", { class: "config-helper", text: field.helper }));
  } else {
    let control;
    let node;
    if (field.kind === "select") {
      control = renderSelect(field, entry);
      node = control;
    } else if (field.kind === "range") {
      const range = renderRange(field, entry);
      control = range.input;
      node = range.wrap;
    } else {
      control = renderTextLike(field, entry);
      node = control;
    }
    state.inputs.set(field.path, control);
    state.initial.set(field.path, entry.value);
    if (entry.lockedByEnv) control.disabled = true;
    control.addEventListener("input", () => {
      state.pendingResets.delete(field.path);
      refreshVisibility();
      refreshEngineFields();
      updateDirtyIndicators();
    });
    row.append(node);

    // Aide contextuelle courte (classe existante `config-helper`).
    if (field.helper) {
      row.append(h("p", { class: "config-helper", text: field.helper }));
    }

    // Note « sans effet avec ce moteur » (masquée jusqu'à `refreshEngineFields`).
    const engineNote = h("p", {
      class: "config-helper config-engine-note",
      hidden: "hidden",
    });
    state.engineNotes.set(field.path, engineNote);
    row.append(engineNote);

    // Défaut / surcharge + « Réinitialiser au défaut » — désormais pour TOUS les
    // champs qui ont un défaut (auparavant réservé aux textarea).
    const defaults = h("div", { class: "config-reset" });
    const fallback = fieldDefault(field);
    // ⚠️ Le bouton existe aussi quand le défaut n'est pas connu du client (miroir
    // absent + gateway ancien) mais qu'une SURCHARGE existe : le clic l'efface
    // alors côté serveur (`null`), donc le défaut s'applique quand même.
    if (!entry.lockedByEnv && (fallback !== undefined || entry.origin === "store")) {
      if (entry.origin === "store") {
        defaults.append(
          h("p", {
            class: "config-helper",
            text:
              fallback !== undefined
                ? `Valeur personnalisée enregistrée : elle surcharge le défaut : ${valueLabel(field, fallback)}.`
                : "Valeur personnalisée enregistrée (surcharge le défaut).",
          }),
        );
      } else if (entry.origin === "default") {
        defaults.append(
          h("p", {
            class: "config-helper",
            text: `Valeur par défaut : ${valueLabel(field, fallback)}.`,
          }),
        );
      }
      const reset = h("button", {
        class: "button button--ghost button--small",
        type: "button",
        text: "Réinitialiser au défaut",
      });
      reset.addEventListener("click", () => resetField(field, control, entry));
      defaults.append(reset);
    } else if (entry.origin === "store") {
      defaults.append(
        h("p", { class: "config-helper", text: "Valeur enregistrée (surcharge le défaut)." }),
      );
    }
    if (defaults.childElementCount > 0) row.append(defaults);
  }
  row.append(h("p", { class: "config-error", hidden: "hidden" }));
  return row;
}

/**
 * Bloc LECTURE SEULE — l'instruction vocale **réellement injectée** dans le
 * prompt système léger (volet 1 du chantier interface de chat). Le texte vient
 * du serveur (`voiceInstruction`), donc l'UI montre bien CELUI injecté, jamais
 * une copie susceptible de diverger. Aucun style inline (CSP stricte).
 */
function renderVoiceInstruction() {
  const block = h("div", { class: "config-voice-instruction" });
  block.append(
    h("p", {
      class: "config-helper",
      text: "Instruction de voix (lecture seule)",
    }),
  );
  block.append(
    h("pre", {
      class: "config-voice-instruction__text",
      text: state.voiceInstruction || "",
    }),
  );
  block.append(
    h("p", {
      class: "config-helper",
      text:
        "Ce bloc n'est ajouté au prompt système léger que lorsque la voix est " +
        "active (tts.enabled = on) ; sinon le prompt reste exactement celui ci-dessus.",
    }),
  );
  return block;
}

/**
 * ENCART DE RENVOI (④) — dit où est allé un réglage déplacé, AVEC un lien.
 *
 * ⚠️ Un groupe peut avoir perdu des champs au profit de l'AUTRE page (clé
 * `mixte` : valeur commune ici, surcharge là-bas ; clé d'une autre portée :
 * page d'en face). Sans cet encart, l'utilisateur cherche un champ qui n'est
 * plus là et croit qu'il a disparu. `textContent` + un `<a>` : aucun markup
 * dynamique, CSP inchangée.
 */
function renderRenvoi(renvoi) {
  if (!renvoi || typeof renvoi.texte !== "string" || renvoi.texte === "") return null;
  const block = h("p", { class: "config-helper config-renvoi" }, [renvoi.texte]);
  const lien = renvoi.lien;
  if (lien && typeof lien.href === "string" && lien.href !== "") {
    block.append(" ");
    block.append(
      h("a", { class: "config-renvoi__lien", href: lien.href }, [lien.libelle ?? lien.href]),
    );
  }
  return block;
}

/**
 * Rendu EAGER de la page courante : un conteneur `#group-<onglet>` par onglet
 * qui porte des champs, et les champs filtrés par PORTÉE.
 *
 * ⚠️ Ce n'est plus « tous les groupes dans tous les onglets » : depuis la
 * scission Instance / Bot, un groupe peut avoir des clés des deux côtés
 * (`tts`, `memoire`, `prompts`, `notifications`). La portée de CHAQUE clé (lue
 * dans le snapshot du serveur) décide : la page Instance ne rend que
 * `instance`/`mixte`, la page Bot que `bot`/`mixte`. Une clé `mixte` apparaît
 * donc UNE fois par page, jamais deux.
 */
function render() {
  const scopes = scopesOfState();
  const parOnglet = groupesParOnglet(PAGE, GROUPS);
  const containers = new Map();
  for (const onglet of ongletsDePage(PAGE)) {
    const container = document.getElementById(`group-${onglet.id}`);
    if (!container) continue;
    container.textContent = "";
    containers.set(onglet.id, container);
  }
  for (const [ongletId, groupes] of Object.entries(parOnglet)) {
    const container = containers.get(ongletId);
    // Pas de conteneur = l'onglet ne porte que des composants autonomes
    // (Secrets, Maintenance, Plateformes…) : rien à rendre ici.
    if (!container) continue;
    for (const group of groupes) {
      const champs = champsDePage(PAGE, group, scopes);
      if (champs.length === 0) continue;
      container.append(renderGroup(group, champs));
    }
  }
  refreshVisibility();
  refreshEngineFields();
  updateDirtyIndicators();
}

/** Une section de champs (groupe) — bouton de test, aide, repli « Avancé ». */
function renderGroup(group, champs) {
  const section = h("section", { class: "config-group" });
  const status = h("span", { class: "config-helper" });
  const head = h("div", { class: "config-group__head" }, [
    h("h2", { class: "config-group__title", text: group.title }),
  ]);
  if (group.role) {
    const test = h("button", { class: "button button--ghost button--small", type: "button", text: "Tester la connexion" });
    test.addEventListener("click", () => testConnection(group.role, status));
    head.append(h("div", { class: "config-secret" }, [test, status]));
  } else if (group.test === "images") {
    // Bouton de test DÉDIÉ au serveur d'images (route `/api/images/test`) : il
    // interroge `GET /system_stats` avec les valeurs SAISIES (pas encore
    // enregistrées), sans rien écrire.
    const test = h("button", { class: "button button--ghost button--small", type: "button", text: "Tester la connexion" });
    test.addEventListener("click", () => testImagesConnection(status));
    head.append(h("div", { class: "config-secret" }, [test, status]));
  } else if (group.test === "librarian") {
    // Bouton de test DÉDIÉ au libraire (route `/api/config/librarian/test`) :
    // il appelle `GET {base}/api/librarian/status` et affiche un résultat
    // honnête et distinct (joignable, auth refusée, web indisponible, injoignable).
    const test = h("button", { class: "button button--ghost button--small", type: "button", text: "Tester la connexion" });
    test.addEventListener("click", () => testLibrarianConnection(status));
    head.append(h("div", { class: "config-secret" }, [test, status]));
  }
  section.append(head);
  // Texte d'aide du GROUPE (une phrase) : il explique le RÔLE, jamais une clé.
  if (typeof group.intro === "string" && group.intro !== "") {
    section.append(
      h("p", { class: "config-helper config-group__intro", text: group.intro }),
    );
  }
  // Note de GROUPE (ex. ce qui n'est PAS réglable dans cet onglet).
  if (group.note) {
    section.append(h("p", { class: "config-helper config-group__note", text: group.note }));
  }
  // ENCART DE RENVOI : où est allé ce qui n'est pas ici.
  const renvoi = renderRenvoi(group.renvoi?.[PAGE]);
  if (renvoi) section.append(renvoi);
  // Rendu EAGER : les champs « essentiels » sont directement dans la section ;
  // les champs `advanced` sont regroupés dans un repli `<details>` DISTINCT
  // (classe `config-advanced`, jamais `tts-details`) — masqué, jamais retiré.
  const advanced = [];
  for (const field of champs) {
    if (field.advanced) advanced.push(renderField(field));
    else section.append(renderField(field));
  }
  if (advanced.length > 0) {
    section.append(
      h("details", { class: "config-advanced" }, [
        h("summary", { class: "config-advanced__summary", text: "Avancé" }),
        h("div", { class: "config-advanced__body" }, advanced),
      ]),
    );
  }
  if (group.voiceInstruction) {
    section.append(renderVoiceInstruction());
  }
  return section;
}

/**
 * (Dé)active les champs **sans effet pour le moteur** `tts.engine` et affiche
 * une note explicite en français. Réagit au changement de moteur (l'écouteur
 * `input` de chaque contrôle — dont `tts.engine` — appelle cette fonction).
 *
 * ⚠️ Ne touche QUE les champs à dépendance moteur (`engineFieldState`) et
 * **respecte** le verrou d'environnement (`lockedByEnv`). Un contrôle désactivé
 * garde sa valeur et n'est PAS retiré du patch d'enregistrement : griser ne
 * bloque jamais le `PUT /api/config` (voir `buildConfigPatch`).
 */
function refreshEngineFields() {
  const engineControl = state.inputs.get("tts.engine");
  const engine = engineControl
    ? engineControl.value
    : state.fields["tts.engine"]?.value;
  for (const field of ALL_FIELDS) {
    const engineState = engineFieldState(field.path, engine);
    if (!engineState) continue;
    const control = state.inputs.get(field.path);
    const note = state.engineNotes.get(field.path);
    if (control) {
      const locked = Boolean(state.fields[field.path]?.lockedByEnv);
      control.disabled = locked || engineState.disabled;
    }
    if (note) {
      note.textContent = engineState.note;
      note.hidden = engineState.note === "";
    }
  }
}

/**
 * (Dé)masque les champs conditionnels (`revealWhen`) : le cran `personnalisee`
 * de `tts.emotion` révèle par exemple les curseurs `exaggeration` / `cfg`.
 */
function refreshVisibility() {
  for (const field of ALL_FIELDS) {
    if (!field.revealWhen) continue;
    const row = state.rows.get(field.path);
    if (!row) continue;
    const control = state.inputs.get(field.revealWhen.path);
    const value = control
      ? control.value
      : state.fields[field.revealWhen.path]?.value;
    row.hidden = String(value) !== String(field.revealWhen.equals);
    // Un champ révélé mais enfermé dans un repli fermé resterait invisible :
    // on OUVRE le repli « Avancé » qui le contient (on ne le referme jamais :
    // l'utilisateur reste maître de la fermeture).
    if (!row.hidden) {
      const details = row.closest("details.config-advanced");
      if (details && !details.open) details.open = true;
    }
  }
}

/**
 * ANCRES PROFONDES de la page — table déclarée dans `config-pages.js` (module
 * pur, testé) : id d'un CONTRÔLE → onglet qui le contient.
 *
 * ⚠️ Depuis le sous-lot 1b-4, `/bots?b=<slug>#chat-remote-agents` doit ouvrir
 * « Plateformes » (le panneau des discussions y vit) et `#declencheurs` ouvre la
 * page de gestion des sources. La correspondance se fait par ID D'ÉLÉMENT,
 * jamais par GROUPE de champs. Une ancre inconnue retombe sur le premier onglet.
 */
const ANCRES_PROFONDES = new Map(
  (ANCRES_PROFONDES_PAR_PAGE[PAGE] ?? []).map(([cle, onglet]) => [cle, onglet]),
);

/** Identifiant d'onglet valide déduit du hash courant, sinon `null`. */
function tabFromHash() {
  return ongletDuHash(PAGE, location.hash);
}

/**
 * Amène la cible du hash dans la vue (défilement seul, aucun état modifié).
 *
 * ⚠️ Retourne `false` si l'élément n'est pas encore monté : l'appelant réessaie après
 * le montage des panneaux (le panneau des discussions est monté par `initChatPanel`, et
 * son contrôle n'existe qu'à ce moment-là).
 */
function revealHashTarget() {
  const raw = location.hash.replace(/^#/, "");
  if (raw === "") return false;
  const target = document.getElementById(raw);
  if (!target || typeof target.scrollIntoView !== "function") return false;
  target.scrollIntoView({ block: "center" });
  return true;
}

/**
 * Active un onglet : état `aria-selected`/`tabindex` sur les onglets et
 * `hidden` sur les panneaux. Le DOM reste EAGER (aucun panneau n'est vidé).
 * `refreshVisibility()` est rappelé car les champs conditionnels d'un onglet
 * peuvent dépendre d'un champ d'un autre onglet.
 */
function activateTab(tabId, { focus = false } = {}) {
  if (!ongletsDePage(PAGE).some((onglet) => onglet.id === tabId)) return;
  for (const button of tabButtons) {
    const active = button.getAttribute("aria-controls") === `panel-${tabId}`;
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  }
  for (const panel of panels) panel.hidden = panel.id !== `panel-${tabId}`;
  refreshVisibility();
}

/**
 * Sélectionne un onglet ; met à jour le hash sans empiler d'historique
 * (`replaceState`, donc pas d'entrée de navigation par onglet).
 */
function selectTab(tabId, { focus = false, updateHash = false } = {}) {
  if (!ongletsDePage(PAGE).some((onglet) => onglet.id === tabId)) return;
  activateTab(tabId, { focus });
  // Les workflows d'images peuvent avoir changé hors de cette page : on relit
  // la liste à chaque affichage de l'onglet Images (lecture seule, aucun effet
  // de bord).
  if (tabId === "images") void imagesPanel?.refresh?.();
  // Les déclencheurs travaillent en arrière-plan (horloge) : on relit leur page à
  // chaque affichage de l'onglet, sinon « dernier passage » resterait figé.
  if (tabId === "declencheurs") void sourcesPanel?.refresh?.();
  if (updateHash && location.hash !== `#${tabId}`) {
    history.replaceState(null, "", `#${tabId}`);
  }
}

/** Un champ diffère-t-il de sa valeur initiale (ou sera-t-il modifié) ? */
function isFieldDirty(field) {
  const entry = state.fields[field.path];
  if (entry?.lockedByEnv) return false;
  if (field.kind === "secret") {
    const secret = state.secretState.get(field.path);
    if (!secret) return false;
    if (secret.mode === "clear") return true;
    return Boolean(secret.input && secret.input.value.trim() !== "");
  }
  if (state.pendingResets.has(field.path)) return true;
  const control = state.inputs.get(field.path);
  if (!control) return false;
  return String(control.value) !== String(state.initial.get(field.path));
}

/**
 * Recalcule l'indicateur global « modifications non enregistrées » et les
 * pastilles par onglet. Le calcul porte sur TOUS les champs du DOM, y compris
 * ceux des onglets masqués (pas seulement l'onglet actif).
 */
function updateDirtyIndicators() {
  const dirtyTabs = new Set();
  let anyDirty = false;
  // ⚠️ Seuls les groupes RENDUS sur cette page comptent : les champs de l'autre
  // page n'ont pas de contrôle ici (`isFieldDirty` renverrait `false`, mais le
  // parcours serait trompeur si un groupe était un jour déplacé).
  for (const group of groupesDePage(PAGE, GROUPS)) {
    const tabId = ONGLET_PAR_GROUPE.get(group.id);
    for (const field of group.fields) {
      if (isFieldDirty(field)) {
        anyDirty = true;
        if (tabId) dirtyTabs.add(tabId);
      }
    }
  }
  state.sale = anyDirty;
  if (saveDirty) saveDirty.hidden = !anyDirty;
  for (const button of tabButtons) {
    const tabId = button.getAttribute("aria-controls").replace(/^panel-/, "");
    const dirty = dirtyTabs.has(tabId);
    button.classList.toggle("config-tab--dirty", dirty);
    const label = button.textContent.trim();
    if (dirty) button.setAttribute("aria-label", `${label} — modifications non enregistrées`);
    else button.removeAttribute("aria-label");
  }
}

function showFieldErrors(fields) {
  for (const row of state.rows.values()) {
    const error = row.querySelector(".config-error");
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
  }
  globalError.hidden = true;
  globalError.textContent = "";
  for (const field of fields ?? []) {
    const row = field.path ? state.rows.get(field.path) : null;
    if (row) {
      const error = row.querySelector(".config-error");
      error.textContent = field.message;
      error.hidden = false;
    } else {
      globalError.textContent = field.message;
      globalError.hidden = false;
    }
  }
}

function buildPatch() {
  return buildConfigPatch({ allFields: ALL_FIELDS, state });
}

/**
 * PORTÉE de chaque champ, telle que le serveur la déclare (`scope` du snapshot).
 * Sert au découpage du patch : l'écran d'instance n'écrit que les clés
 * `instance`/`mixte`, les clés propres à un bot partent sur la route du bot.
 */
function scopesOfState() {
  const scopes = {};
  for (const [path, entry] of Object.entries(state.fields)) {
    if (entry && typeof entry.scope === 'string') scopes[path] = entry.scope;
  }
  return scopes;
}

/**
 * Lit les valeurs EFFECTIVES de la page courante.
 *
 * - Instance : `GET /api/config` (store commun + côté instance des clés mixtes) ;
 * - Bot : `GET /api/bots/<id>/config` (overlay du bot affiché + côté bot des
 *   clés mixtes). Un bot inconnu répond 404 `bot_not_found` : on ne l'affiche
 *   jamais comme un succès.
 */
async function load() {
  const url = PAGE_BOT
    ? cheminConfigBot(botCourant?.id ?? BOT_REPLI)
    : "/api/config";
  const body = await HolafFetch.get(url, {
    headers: { accept: "application/json" },
  });
  applySnapshot(body);
  render();
}

function applySnapshot(body) {
  state.fields = body.fields ?? {};
  // ⚠️ FUSEAU DES HORODATAGES (réglage `ui.timeZone`, défaut UTC) : cette page
  // affiche aussi des dates (déclencheurs, pré-autorisations, agents, secrets).
  // Elles suivent la MÊME autorité que la conversation — jamais le fuseau du
  // navigateur. `setTimeZone` retombe sur UTC si la valeur manque ou est illisible.
  const fuseau = state.fields["ui.timeZone"]?.value;
  setTimeZone(typeof fuseau === "string" ? fuseau : undefined);
  state.status = body.status ?? state.status;
  // Le champ n'est présent qu'en réponse à `GET/PUT /api/config` : on ne
  // l'efface pas si une réponse ne le porte pas (robustesse).
  if (typeof body.voiceInstruction === "string") {
    state.voiceInstruction = body.voiceInstruction;
  }
  state.initial.clear();
  state.inputs.clear();
  state.rows.clear();
  state.secretState.clear();
  state.pendingResets.clear();
  updateAvailability();
}

async function save(flow = "config-save") {
  saveStatus.textContent = "Enregistrement…";
  globalError.hidden = true;
  // ⚠️ REFUS AVANT ENVOI : un champ texte vidé alors qu'un défaut non vide
  // existe (prompts système) n'est JAMAIS persisté — le modèle se retrouverait
  // sans consigne, silencieusement. L'utilisateur voit quoi faire.
  const refusals = emptyValueRefusals({ allFields: ALL_FIELDS, state, labels: LABELS });
  if (refusals.length > 0) {
    showFieldErrors(refusals);
    saveStatus.textContent = refusals.map((refusal) => refusal.message).join(" ");
    return false;
  }
  try {
    // ⚠️ UNE SEULE ÉCRITURE PAR PAGE, et sa DESTINATION dépend de la page :
    //  - page **Instance** : `PUT /api/config` — clés `instance` et côté
    //    INSTANCE des clés `mixte` (découpage de `config-patch.js`) ;
    //  - page **Bot** : `PUT /api/bots/<id>/config` — TOUT le patch y va : la
    //    page ne rend que des clés `bot`/`mixte`, et une clé `mixte` doit
    //    écrire son côté BOT (`portee: "bot"`). Envoyer un côté bot à
    //    `/api/config` est REFUSÉ par le serveur (`bot_scoped_field`).
    const patch = buildPatch();
    const ecritures = [];
    if (PAGE_BOT) {
      ecritures.push({
        url: cheminConfigBot(botCourant?.id ?? BOT_REPLI),
        body: patch,
      });
    } else {
      const split = splitConfigPatchByScope(patch, scopesOfState());
      if (Object.keys(split.instance).length > 0 || Object.keys(split.bot).length === 0) {
        ecritures.push({
          url: "/api/config",
          body: split.instance,
        });
      }
    }
    let body = null;
    const applied = { hot: [], restart: [] };
    for (const ecriture of ecritures) {
      // Corps JSON envoyé en objet : la brique le sérialise et pose le
      // Content-Type ; les en-têtes maison (WRITE_HEADERS) sont préservés.
      body = await HolafFetch.put(ecriture.url, {
        headers: writeHeaders(flow),
        body: ecriture.body,
      });
      const partiel = body?.applied ?? {};
      for (const path of Array.isArray(partiel.hot) ? partiel.hot : []) applied.hot.push(path);
      for (const path of Array.isArray(partiel.restart) ? partiel.restart : []) {
        applied.restart.push(path);
      }
    }
    applySnapshot(body ?? {});
    render();
    showApplied(applied);
    saveStatus.textContent = "Enregistré.";
    // La voix active a pu changer côté formulaire : resynchronise le panneau.
    void voicesPanel?.refresh();
    return true;
  } catch (error) {
    // Erreurs métier : HolafFetch expose le corps JSON parsé dans `error.data`.
    // La cause RÉELLE (code + message + champ) est affichée, jamais un texte
    // générique : `presentConfigSaveError` (module pur `config-patch.js`).
    const presented = presentConfigSaveError(error, LABELS);
    showFieldErrors(presented.fields);
    saveStatus.textContent = presented.summary;
    return false;
  }
}

/**
 * Raccourci du bandeau « Activer la voix » (zone ①) : **un seul chemin
 * d'écriture** pour `tts.enabled`. Le bouton ne fait AUCUN `PUT` propre et ne
 * redémarre RIEN en silence : il règle le select « Activer la voix » (zone ③)
 * puis passe par l'**enregistrement global** (barre sticky), comme tout le
 * reste ; c'est ensuite à l'utilisateur de redémarrer Yuki (onglet Maintenance).
 *
 * @returns {Promise<boolean>} `true` si l'enregistrement a réussi.
 */
async function enableVoiceShortcut() {
  const control = state.inputs.get("tts.enabled");
  if (control && control.value !== "on") {
    control.value = "on";
    state.pendingResets.delete("tts.enabled");
    updateDirtyIndicators();
  }
  return save("enable-voice");
}

/**
 * Raccourci « Choisir comme moteur » (UI de téléchargement, zone ⑤) : **un seul
 * chemin d'écriture** pour `tts.engine`. Il règle le select « Moteur de
 * synthèse » (zone ③) puis passe par l'**enregistrement global** — aucun `PUT`
 * propre, aucun redémarrage silencieux.
 *
 * @param {string} id Identifiant de catalogue (= valeur de `tts.engine`).
 * @returns {Promise<boolean>} `true` si l'enregistrement a réussi.
 */
async function activateEngineShortcut(id) {
  if (typeof id !== "string" || id.length === 0) return false;
  const control = state.inputs.get("tts.engine");
  if (control && control.value !== id) {
    control.value = id;
    state.pendingResets.delete("tts.engine");
    updateDirtyIndicators();
  }
  return save("activate-engine");
}

function showApplied(applied) {
  const labelsOf = (paths) => (paths.length > 0 ? paths.map((p) => LABELS.get(p) ?? p).join(", ") : "—");
  appliedHot.textContent = labelsOf(applied.hot ?? []);
  appliedRestart.textContent = labelsOf(applied.restart ?? []);
  appliedEl.hidden = false;
}

async function testConnection(role, statusEl) {
  statusEl.textContent = "Test en cours…";
  try {
    const secret = state.secretState.get(`llm.${role}.apiKey`);
    const apiKey = secret?.input && secret.input.value.trim() !== "" ? secret.input.value.trim() : undefined;
    const body = await HolafFetch.post("/api/config/llm/test", {
      headers: WRITE_HEADERS,
      body: { role, ...(apiKey ? { apiKey } : {}) },
    });
    if (body.ok) {
      const count = Array.isArray(body.models) ? body.models.length : null;
      statusEl.textContent = count !== null ? `Connexion OK (${count} modèles).` : "Connexion OK.";
    } else {
      statusEl.textContent = `Échec : ${body.error ?? "inconnu"}.`;
    }
  } catch (error) {
    statusEl.textContent = `Échec : ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Teste la connexion au LIBRAIRE (Libry) (`POST /api/config/librarian/test`).
 * Le message affiché vient du SERVEUR (il reflète ce qui a réellement été
 * observé : joignable, authentification refusée, moteurs web indisponibles,
 * libraire injoignable). Aucune cause n'est inventée côté navigateur.
 *
 * Les valeurs NON ENREGISTRÉES saisies dans le formulaire (URL, jetons) sont
 * transmises pour permettre de tester avant d'enregistrer ; elles ne sont ni
 * écrites ni journalisées.
 */
async function testLibrarianConnection(statusEl) {
  statusEl.textContent = "Test en cours…";
  statusEl.classList.remove("config-status--error");
  try {
    const baseControl = state.inputs.get("librarian.baseUrl");
    const baseUrl =
      baseControl && baseControl.value.trim() !== "" ? baseControl.value.trim() : undefined;
    const tokenSecret = state.secretState.get("librarian.agentToken");
    const agentToken =
      tokenSecret?.input && tokenSecret.input.value.trim() !== ""
        ? tokenSecret.input.value.trim()
        : undefined;
    const keySecret = state.secretState.get("librarian.apiKey");
    const apiKey =
      keySecret?.input && keySecret.input.value.trim() !== ""
        ? keySecret.input.value.trim()
        : undefined;
    const body = await HolafFetch.post("/api/config/librarian/test", {
      headers: WRITE_HEADERS,
      body: {
        ...(baseUrl ? { baseUrl } : {}),
        ...(agentToken ? { agentToken } : {}),
        ...(apiKey ? { apiKey } : {}),
      },
    });
    statusEl.textContent = body.message ?? (body.ok ? "Connexion OK." : "Échec.");
    statusEl.classList.toggle("config-status--error", !body.ok);
  } catch (error) {
    statusEl.textContent = `Échec : ${error instanceof Error ? error.message : String(error)}`;
    statusEl.classList.add("config-status--error");
  }
}

/**
 * Teste la connexion au SERVEUR D'IMAGES (ComfyUI) (`POST /api/images/test`).
 *
 * ⚠️ Il envoie l'URL et la CLÉ SAISIES dans le formulaire (pas encore
 * enregistrées) : elles ne sont ni écrites ni journalisées. Le message affiché
 * est celui que le serveur a RÉELLEMENT observé (statut HTTP, code réseau) :
 * aucune cause n'est inventée ici.
 */
async function testImagesConnection(statusEl) {
  statusEl.textContent = "Test en cours…";
  statusEl.classList.remove("config-status--error");
  try {
    const baseControl = state.inputs.get("images.baseUrl");
    const baseUrl =
      baseControl && baseControl.value.trim() !== "" ? baseControl.value.trim() : undefined;
    const keySecret = state.secretState.get("images.apiKey");
    const apiKey =
      keySecret?.input && keySecret.input.value.trim() !== ""
        ? keySecret.input.value.trim()
        : undefined;
    const body = await HolafFetch.post("/api/images/test", {
      headers: WRITE_HEADERS,
      body: { ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) },
    });
    statusEl.textContent = body.message ?? (body.ok ? "Serveur joignable." : "Échec.");
    statusEl.classList.toggle("config-status--error", !body.ok);
  } catch (error) {
    statusEl.textContent = `Échec : ${error instanceof Error ? error.message : String(error)}`;
    statusEl.classList.add("config-status--error");
  }
}

function setRestartStatus(text, isError = false) {
  restartStatus.textContent = text;
  restartStatus.classList.toggle("config-status--error", isError);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `true` si le gateway répond à `/health/live`. */
async function isGatewayLive() {
  try {
    // `cache: "no-store"` est une option native forwardée par la brique.
    await HolafFetch.get("/health/live", { cache: "no-store" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Après une demande de redémarrage : attend que le gateway tombe PUIS qu'il
 * revienne, et recharge la page. Échoue clairement si le programme ne revient
 * pas (par ex. un crash au démarrage — le superviseur ne relance que le code
 * de redémarrage demandé).
 */
async function waitForGatewayRestart() {
  const startedAt = Date.now();
  let sawDown = false;
  await delay(700); // laisse passer le délai avant l'arrêt côté serveur
  while (Date.now() - startedAt < RESTART_TIMEOUT_MS) {
    const alive = await isGatewayLive();
    if (!alive) {
      if (!sawDown) setRestartStatus("Redémarrage en cours… Yuki est arrêté.");
      sawDown = true;
    } else if (sawDown) {
      setRestartStatus("Yuki est revenu — rechargement…");
      await delay(400);
      location.reload();
      return;
    }
    await delay(RESTART_POLL_MS);
  }
  setRestartStatus(
    "Yuki n'est pas revenu dans le délai imparti. Vérifiez les journaux du " +
      "conteneur (docker compose logs yuki-gateway) : l'arrêt a peut-être " +
      "échoué au démarrage.",
    true,
  );
  restartButton.disabled = false;
  saveButton.disabled = false;
}

async function requestGatewayRestart() {
  restartButton.disabled = true;
  saveButton.disabled = true;
  setRestartStatus("Redémarrage demandé…");
  try {
    await HolafFetch.post("/api/admin/restart", { headers: WRITE_HEADERS });
  } catch (error) {
    // Corps JSON d'erreur exposé par la brique : `message` d'abord
    // (convention du gateway), sinon `error`, sinon le message typé.
    // Un refus pour téléchargement en cours (409) n'est PAS une panne : il est
    // présenté comme une information, pas comme un échec (voir
    // `presentRestartRefusal`).
    const described = presentRestartRefusal(error);
    setRestartStatus(described.message, !described.info);
    restartButton.disabled = false;
    saveButton.disabled = false;
    return false;
  }
  await waitForGatewayRestart();
  return true;
}

async function restart() {
  const confirmed = await HolafModal.confirm(
    "Redémarrer Yuki ?",
    "Cela interrompt la conversation et les jobs en cours.\n\n" +
      "Yuki redémarre son programme en interne ; le conteneur reste en place.",
  );
  if (!confirmed) return;
  await requestGatewayRestart();
}

function setPill(el, ok, onText, offText) {
  if (!el) return;
  el.textContent = ok ? onText : offText;
  el.classList.toggle("pill--online", ok);
  el.classList.toggle("pill--offline", !ok);
}

function updateAvailability() {
  const { lightKey, heavyKey } = state.status;
  setPill(lightPill, lightKey, "clé légère OK", "clé légère manquante");
  setPill(heavyPill, heavyKey, "clé lourde OK", "clé lourde manquante");
  const conversationOk = lightKey && state.healthReady;
  setPill(readyPill, conversationOk, "prêt", "non prêt");
  // ⚠️ Les pastilles et le bandeau de disponibilité n'existent que sur la page
  // Instance : la page Bot n'affiche pas la préparation du gateway (elle est
  // commune aux deux pages, donc sans objet par bot).
  if (!availabilityEl) return;
  if (!lightKey) {
    availabilityEl.textContent =
      "La conversation est indisponible — saisissez une clé LLM légère ci-dessous.";
    availabilityEl.hidden = false;
    availabilityEl.className = "config-banner config-banner--warn";
  } else {
    availabilityEl.hidden = true;
  }
  // ⚠️ Rôle TRAVAIL indisponible (présence de clé, MÊME mesure que
  // `src/llm/availability.ts:63-69` : seule la présence compte, aucun appel
  // réseau). Le bandeau est MASQUÉ dès que la clé est là : conditionnel, jamais
  // permanent. `textContent` uniquement (aucun markup injecté, CSP inchangée).
  if (workModelNoticeEl) {
    const bandeau = bandeauTravail(heavyKey);
    workModelNoticeEl.hidden = bandeau.hidden;
    workModelNoticeEl.textContent = bandeau.texte;
  }
}

async function pollHealth() {
  try {
    // 200 = prêt ; tout autre statut (503 « non prêt », réseau) lève une erreur.
    await HolafFetch.get("/health/ready");
    state.healthReady = true;
  } catch {
    state.healthReady = false;
  }
  if (availabilityEl) {
    if (!state.healthReady && state.status.lightKey) {
      availabilityEl.textContent =
        "Le service n'est pas encore prêt (profil GPU ou PiHost). Vérifiez /health.";
      availabilityEl.hidden = false;
      availabilityEl.className = "config-banner config-banner--warn";
    } else if (state.healthReady) {
      availabilityEl.hidden = true;
    }
  }
  updateAvailability();
}

/* ═══════════════════════════════════════════════════════════════════════════
 * PAGE BOT — sélecteur, identité et honnêteté sur ce qui n'est pas éditable
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Résout le bot AFFICHÉ depuis `?b=<slug>`.
 *
 * ⚠️ Un slug INCONNU retombe sur `yuki` SANS erreur visible : une URL partagée
 * qui désigne un bot supprimé doit rester utilisable (elle ouvre le bot
 * historique), pas afficher un écran mort. Sans `?b=`, on prend le bot ACTIF
 * (c'est lui que l'instance utilise réellement).
 */
async function resoudreBot() {
  botsConnus = await listerBots();
  const demande = new URLSearchParams(location.search).get("b");
  const parId = (id) => botsConnus.find((bot) => bot.id === id) ?? null;
  const actif = botsConnus.find((bot) => bot.actif === true) ?? null;
  let choisi;
  if (typeof demande === "string" && demande !== "") {
    choisi = parId(demande) ?? parId(BOT_REPLI) ?? actif ?? botsConnus[0] ?? null;
  } else {
    choisi = actif ?? parId(BOT_REPLI) ?? botsConnus[0] ?? null;
  }
  botCourant = choisi;
  if (botCourant) {
    // ⚠️ L'URL est RÉÉCRITE avec le bot effectivement affiché : elle reste
    // partageable et un rechargement retombe sur le même bot.
    const url = new URL(location.href);
    url.searchParams.set("b", botCourant.id);
    history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }
  return botCourant;
}

/** `true` si le bot affiché est le bot ACTIF de l'instance. */
function botAfficheEstActif() {
  if (!botCourant) return false;
  const actif = botsConnus.find((bot) => bot.actif === true);
  return Boolean(actif && actif.id === botCourant.id);
}

/** URL de la page d'un bot (état partageable, rechargement sûr). */
function urlBot(botId, hash = "") {
  return `/bots?b=${encodeURIComponent(botId)}${hash}`;
}

/** Une ligne « libellé : valeur » en LECTURE SEULE (identité du bot). */
function ligneLecture(texte, valeur) {
  const row = h("div", { class: "config-row bot-info" });
  row.append(h("span", { class: "config-label", text: texte }));
  row.append(h("span", { class: "bot-info__valeur", text: valeur }));
  return row;
}

/**
 * Zone « EXÉCUTION » d'un bot (lot 36, L8) : ce qui TOURNE, et les deux boutons.
 *
 * ⚠️ POURQUOI ELLE EXISTE : le champ `actif` dit ce que le bot **doit** faire
 * (« doit tourner »), pas ce qu'il fait. Un bot allumé dont le host a échoué
 * s'affichait donc « actif » — l'interface mentait. Ici, tout vient de
 * `execution` (`demarre`, `erreur`, `sessions`, `workers`), joint par le serveur
 * depuis l'EXÉCUTION, jamais recalculé côté navigateur.
 *
 * ⚠️ Les deux boutons écrivent le MÊME état que `PATCH /api/bots/<id>/actif`
 * (`{ actif: true | false }`) : « Démarrer » ouvre la pile et démarre le host
 * (créé au besoin), « Arrêter » les détruit. La réponse du serveur fait foi :
 * elle remplace la liste locale (`donnees.bots`).
 */
function sectionExecution(bot) {
  const section = h("section", { class: "config-group" });
  section.append(
    h("div", { class: "config-group__head" }, [
      h("h2", { class: "config-group__title", text: "Exécution" }),
    ]),
  );
  section.append(
    h("p", {
      class: "config-helper",
      text:
        "Ce qui TOURNE maintenant, et non ce qui est enregistré : un bot peut être " +
        "« actif » (il doit tourner) et arrêté (son démarrage a échoué — la cause " +
        "est affichée). « Démarrer » ouvre ses sources puis son host ; « Arrêter » " +
        "les ferme. Le bot principal de l'instance suit le gateway.",
    }),
  );
  const execution = bot.execution ?? null;
  if (execution === null) {
    section.append(
      h("p", {
        class: "config-helper",
        text: "État d'exécution indisponible sur cette instance (mode dégradé).",
      }),
    );
    return section;
  }
  section.append(ligneLecture("Démarrage", execution.demarre === true ? "démarré" : "arrêté"));
  section.append(ligneLecture("Sessions", String(execution.sessions ?? 0)));
  section.append(
    ligneLecture("Worker lourd", execution.workers === 1 ? "construit" : "non construit"),
  );
  if (typeof execution.erreur === "string" && execution.erreur !== "") {
    section.append(ligneLecture("Dernière erreur", execution.erreur));
  }

  const status = h("p", { class: "config-helper", role: "status", hidden: true });
  if (flashBotExecution !== "") {
    status.textContent = flashBotExecution;
    status.hidden = false;
  }
  const demarrer = h("button", {
    class: "button button--primary button--small",
    type: "button",
    text: "Démarrer",
  });
  const arreter = h("button", {
    class: "button button--small",
    type: "button",
    text: "Arrêter",
  });
  // ⚠️ Un bouton inutile est DÉSACTIVÉ (aucun aller-retour qui ne changerait rien).
  demarrer.disabled = execution.demarre === true;
  arreter.disabled = execution.demarre !== true;

  const changer = (actif) => {
    void (async () => {
      flashBotExecution = "";
      status.hidden = true;
      demarrer.disabled = true;
      arreter.disabled = true;
      try {
        const reponse = await fetch(`/api/bots/${encodeURIComponent(bot.id)}/actif`, {
          method: "PATCH",
          headers: writeHeaders(actif ? "bot-demarrer" : "bot-arreter"),
          body: JSON.stringify({ actif }),
        });
        const donnees = await reponse.json().catch(() => ({}));
        if (!reponse.ok) {
          throw Object.assign(new Error(donnees.message ?? "Changement impossible."), {
            data: donnees,
          });
        }
        // ⚠️ La LISTE du serveur fait foi (registre en mémoire + état réel).
        if (Array.isArray(donnees.bots)) botsConnus = donnees.bots;
        const misAJour =
          (Array.isArray(donnees.bots)
            ? donnees.bots.find((entree) => entree.id === bot.id)
            : null) ?? null;
        if (misAJour) appliquerBotExecution(misAJour);
        const raison = donnees.applique?.raison ?? "";
        flashBotExecution =
          donnees.applique?.ok === false
            ? raison
            : donnees.inchange === true
              ? raison !== ""
                ? raison
                : "Rien à changer : ce bot est déjà dans cet état."
              : actif
                ? "Démarrage effectué."
                : "Arrêt effectué.";
        renderBotGeneral();
      } catch (error) {
        const donnees = error?.data ?? {};
        flashBotExecution =
          donnees.message ?? (error instanceof Error ? error.message : String(error));
        renderBotGeneral();
      }
    })();
  };
  demarrer.addEventListener("click", () => changer(true));
  arreter.addEventListener("click", () => changer(false));

  section.append(h("div", { class: "config-actions" }, [demarrer, arreter]), status);
  return section;
}

/**
 * Remplace un bot de la liste locale par la version du SERVEUR (état réel).
 * ⚠️ Ne touche que l'état d'exécution : les capacités et le nom déjà affichés
 * viennent de la même réponse et sont repris tels quels.
 */
function appliquerBotExecution(bot) {
  if (!bot || typeof bot.id !== "string") return;
  botsConnus = botsConnus.map((entree) => (entree.id === bot.id ? bot : entree));
  if (botCourant && botCourant.id === bot.id) botCourant = bot;
}

/**
 * Zone « Général » d'un bot : NOM (modifiable), slug (lecture seule), avatar,
 * CAPACITÉS (cases à cocher) et zone de danger.
 *
 * ⚠️ Les capacités sont la SEULE chose qui décide de ce qu'un bot peut faire
 * (`OUTILS_DES_CAPACITES`, `src/llm/tool-policy.ts`) : elles vivent ICI, par bot,
 * et nulle part dans `/config` (qui décrit l'instance). Le slug, lui, est
 * IMMUABLE (il nomme un dossier) et reste en lecture seule.
 *
 * ⚠️ Un bot neuf n'a AUCUNE capacité : « Un bot peut toujours répondre. Tout le
 * reste s'autorise ici. » — la phrase est affichée telle quelle.
 */
function renderBotGeneral() {
  if (!botGeneralRoot) return;
  botGeneralRoot.textContent = "";
  const bot = botCourant;
  if (!bot) {
    botGeneralRoot.append(
      h("p", { class: "config-helper", text: "Aucun bot lisible : la liste des bots est indisponible." }),
    );
    return;
  }
  const identite = h("section", { class: "config-group" });
  identite.append(
    h("div", { class: "config-group__head" }, [
      h("h2", { class: "config-group__title", text: "Identité du bot" }),
    ]),
  );
  identite.append(
    h("p", {
      class: "config-helper",
      text:
        "Le nom se modifie ici ; l'identifiant (slug) est IMMUABLE — il nomme le " +
        "dossier et les chemins du bot. Un autre bot s'ajoute par « ＋ » et se " +
        "retire par la zone de danger ci-dessous.",
    }),
  );
  const champNom = h("input", {
    class: "config-input",
    type: "text",
    id: "bot-general-nom",
    maxlength: "40",
    autocomplete: "off",
    value: bot.nom ?? bot.id,
  });
  const ligneNom = h("div", { class: "config-row" }, [
    h("label", { class: "config-label", for: "bot-general-nom", text: "Nom" }),
    champNom,
  ]);
  identite.append(ligneNom);
  identite.append(ligneLecture("Identifiant (slug)", bot.id));
  identite.append(
    ligneLecture("Enregistré", bot.actif === true ? "actif (doit tourner)" : "inactif (ne doit pas tourner)"),
  );
  const avatarRow = h("div", { class: "config-row bot-info" });
  avatarRow.append(h("span", { class: "config-label", text: "Avatar" }));
  if (botAfficheEstActif()) {
    // ⚠️ `/avatar` sert l'avatar du bot ACTIF : c'est le seul cas où cette image
    // est la sienne. Les autres bots ne l'affichent pas ici (on ne montre pas
    // l'avatar de quelqu'un d'autre).
    const avatar = h("img", {
      class: "bot-avatar",
      src: "/avatar",
      alt: `Avatar de ${bot.nom ?? bot.id}`,
      width: "64",
      height: "64",
    });
    const remplacement = h("span", {
      class: "bot-info__valeur",
      text: "aucun avatar (flocon par défaut)",
      hidden: "hidden",
    });
    // Aucun avatar déposé ⇒ `/avatar` répond 404 : on l'annonce en texte plutôt
    // que de laisser une image cassée (aucun style inline, CSP inchangée).
    avatar.addEventListener("error", () => {
      avatar.hidden = true;
      remplacement.hidden = false;
    });
    avatarRow.append(avatar, remplacement);
  } else {
    avatarRow.append(
      h("span", {
        class: "bot-info__valeur",
        text:
          "non affiché ici : l'image servie par /avatar est celle du bot actif. " +
          "L'avatar de ce bot lui appartient (il est copié lors d'un clonage).",
      }),
    );
  }
  identite.append(avatarRow);
  botGeneralRoot.append(identite);
  // ⚠️ LOT 36 (L8) : l'état RÉEL, et les boutons qui le changent.
  botGeneralRoot.append(sectionExecution(bot));

  botGeneralRoot.append(sectionCapacites(bot, champNom));

  const danger = h("section", { class: "config-group bot-danger" });
  danger.append(
    h("div", { class: "config-group__head" }, [
      h("h2", { class: "config-group__title", text: "Zone de danger" }),
    ]),
  );
  danger.append(
    h("p", {
      class: "config-helper",
      text:
        "La suppression N'EFFACE RIEN : le dossier du bot est DÉPLACÉ dans les " +
        "archives de l'instance (`bots-supprimes/`, même volume) et ses données " +
        "sont CONSERVÉES 3 mois (90 jours), puis effacées par le balayeur. La " +
        "confirmation affiche le nombre réel de conversations, de souvenirs et de " +
        "déclencheurs, avec une case à cocher obligatoire.",
    }),
  );
  // ⚠️ `button--danger` (bouton TEXTE) et non `button--stop` : ce dernier est
  // l'icône carrée de 36 px du bandeau du chat — le texte y serait coupé.
  const supprimer = h("button", {
    class: "button button--danger button--small",
    type: "button",
    text: "Supprimer ce bot",
  });
  supprimer.addEventListener("click", () => void supprimerBotCourant());
  danger.append(h("div", { class: "config-actions" }, [supprimer]));
  botGeneralRoot.append(danger);
}

/**
 * SECTION « CAPACITÉS » — une case à cocher par famille d'outils, puis un bouton
 * d'enregistrement.
 *
 * ⚠️ TOUTES DÉCOCHÉES pour un bot neuf (`capacites: []`) : c'est l'état réel
 * renvoyé par `GET /api/bots`, jamais un défaut inventé par l'interface. La
 * phrase fixe dit ce que l'état vide signifie : le bot répond quand même.
 *
 * ⚠️ L'écriture passe par `PATCH /api/bots/<id>` (`{ nom, capacites }`) et le
 * serveur VALIDE chaque clé : une case inconnue serait refusée, jamais ignorée.
 * Les cases reprennent l'état RÉEL en cas d'échec (aucune case qui mente).
 */
function sectionCapacites(bot, champNom) {
  const section = h("section", { class: "config-group" });
  section.append(
    h("div", { class: "config-group__head" }, [
      h("h2", { class: "config-group__title", text: "Capacités" }),
    ]),
  );
  section.append(h("p", { class: "config-helper", text: PHRASE_CAPACITES }));

  const cochees = new Set(Array.isArray(bot.capacites) ? bot.capacites : []);
  const cases = new Map();
  // ⚠️ Un `div` (pas un `fieldset`) : le regroupement Flex d'un `fieldset`
  // déborde de son contenu et ferait passer les boutons au MILIEU de la liste.
  const fieldset = h("div", { class: "bot-capacites" });
  for (const capacite of CAPACITES_PAGE) {
    const id = `bot-capacite-${bot.id}-${capacite.id}`;
    const laCase = h("input", { type: "checkbox", id });
    laCase.checked = cochees.has(capacite.id);
    cases.set(capacite.id, laCase);
    const ligne = h("div", { class: "config-row" }, [
      h("label", { class: "config-label", for: id }, [laCase, ` ${capacite.libelle}`]),
      h("span", { class: "config-helper", text: capacite.aide }),
    ]);
    fieldset.append(ligne);
  }
  section.append(fieldset);

  const status = h("p", { class: "config-helper", role: "status", hidden: true });
  const enregistrer = h("button", {
    class: "button button--primary button--small",
    type: "button",
    text: "Enregistrer les capacités",
  });
  enregistrer.addEventListener("click", () => {
    void (async () => {
      status.hidden = true;
      const demandees = CAPACITES_PAGE.map((capacite) => capacite.id).filter(
        (id) => cases.get(id)?.checked === true,
      );
      enregistrer.disabled = true;
      try {
        const reponse = await fetch(`/api/bots/${encodeURIComponent(bot.id)}`, {
          method: "PATCH",
          headers: writeHeaders("bot-capacites"),
          body: JSON.stringify({ nom: botNomSaisi(bot, champNom), capacites: demandees }),
        });
        const donnees = await reponse.json().catch(() => ({}));
        if (!reponse.ok) {
          throw Object.assign(new Error(donnees.message ?? "Enregistrement impossible."), {
            data: donnees,
          });
        }
        appliquerBotMisAJour(donnees.bot);
        status.textContent = donnees.rechargementRequis
          ? "Enregistré. Redémarrez le gateway pour que ce bot applique ses nouvelles capacités."
          : "Enregistré.";
        status.hidden = false;
      } catch (error) {
        // Échec : les cases reprennent l'état RÉEL (aucune case qui mente).
        for (const [id, laCase] of cases) laCase.checked = cochees.has(id);
        const donnees = error?.data ?? {};
        status.textContent =
          donnees.message ?? (error instanceof Error ? error.message : String(error));
        status.hidden = false;
      } finally {
        enregistrer.disabled = false;
      }
    })();
  });
  section.append(h("div", { class: "config-actions" }, [enregistrer]), status);
  return section;
}

/** Nom saisi (nettoyé) — le nom courant si le champ n'existe pas. */
function botNomSaisi(bot, champ) {
  const valeur = typeof champ?.value === "string" ? champ.value.trim() : "";
  return valeur === "" ? (bot.nom ?? bot.id) : valeur;
}

/** Applique la réponse de `PATCH /api/bots/<id>` à l'état local (source = serveur). */
function appliquerBotMisAJour(bot) {
  if (!bot || typeof bot.id !== "string") return;
  botsConnus = botsConnus.map((entree) => (entree.id === bot.id ? bot : entree));
  if (botCourant && botCourant.id === bot.id) botCourant = bot;
  remplirSelecteurBot();
}

/**
 * Bandeau d'HONNÊTETÉ : les sections qui lisent encore le bot ACTIF
 * (personnalité, voix, plateformes, déclencheurs) ne sont pas éditables pour un
 * autre bot. Mieux vaut le dire que d'enregistrer au mauvais endroit.
 */
function afficherBandeauBot() {
  if (!botNoticeEl) return;
  if (!botCourant || botAfficheEstActif()) {
    botNoticeEl.hidden = true;
    botNoticeEl.textContent = "";
    return;
  }
  const actif = botsConnus.find((bot) => bot.actif === true);
  botNoticeEl.hidden = false;
  botNoticeEl.textContent =
    `Ce bot n'est pas le bot ACTIF de l'instance (${actif?.id ?? "aucun"}). ` +
    "Ses réglages de configuration s'affichent et s'enregistrent bien sur LUI, " +
    "mais la personnalité, la voix, les plateformes et les déclencheurs restent " +
    "ceux du bot actif : ils ne sont donc pas modifiables ici (leur édition par " +
    "bot est un lot ultérieur).";
}

/**
 * Modale à TROIS CHOIX (HolafModal) — jamais une confirmation native du
 * navigateur.
 * Résout `"enregistrer" | "abandonner" | "rester"` ; une fermeture par ✕ ou
 * Échap vaut « rester » (choix sûr : on ne perd rien, on ne change rien).
 */
function ouvrirChoix(spec) {
  return new Promise((resolve) => {
    const contenu = h("div", {}, [
      h("p", { class: "holaf-modal-message", text: spec.message }),
    ]);
    HolafModal.open({
      title: spec.titre,
      size: "sm",
      content: contenu,
      buttons: spec.boutons.map((bouton) => ({
        text: bouton.text,
        value: bouton.value,
        type: bouton.type,
        guard: false,
        autoFocus: bouton.value === "enregistrer",
      })),
      closeOnOverlay: false,
      _onResolve: (valeur) => resolve(typeof valeur === "string" ? valeur : "rester"),
    });
  });
}

/**
 * Changement de bot depuis le sélecteur — l'URL est l'ÉTAT (`?b=<slug>`).
 *
 * ⚠️ Des modifications non enregistrées ouvrent une modale à TROIS CHOIX :
 * enregistrer, abandonner, ou RESTER sur le bot courant. On ne jette JAMAIS une
 * saisie en silence, et on ne change jamais de bot sans le dire.
 */
async function changerDeBot(cible) {
  if (!botSelect) return;
  const id = typeof cible === "string" ? cible : "";
  if (id === "" || id === botCourant?.id) {
    botSelect.value = botCourant?.id ?? "";
    return;
  }
  const demande = demandeChangementBot({
    sale: estSale(),
    botActuel: botCourant?.id,
    botVise: id,
  });
  if (demande) {
    // ⚠️ Le sélecteur REVIENT tout de suite sur le bot affiché : tant que la
    // question n'est pas tranchée, on ne montre pas un bot qu'on n'a pas ouvert.
    botSelect.value = botCourant?.id ?? "";
    const choix = await ouvrirChoix(demande);
    if (choix === "rester") return;
    if (choix === "enregistrer") {
      const ok = await save("changement-bot");
      if (!ok) {
        // L'enregistrement a échoué : on reste, l'erreur est affichée.
        botSelect.value = botCourant?.id ?? "";
        return;
      }
    }
    // « abandonner » : rien n'est écrit, la navigation jette les saisies.
  }
  // Navigation COMPLÈTE : l'état de l'autre bot est relu de zéro (aucun
  // résidu de formulaire de l'ancien bot).
  location.assign(urlBot(id, location.hash));
}

/**
 * Remplit le sélecteur de bot et l'ouvre sur le bot affiché.
 * ⚠️ Séparé du câblage de l'événement : après une CRÉATION, la liste change et
 * le sélecteur est re-rempli SANS empiler un second écouteur.
 */
function remplirSelecteurBot() {
  if (!botSelect) return;
  botSelect.textContent = "";
  for (const bot of botsConnus) {
    const libelle = bot.nom && bot.nom !== bot.id ? `${bot.nom} (${bot.id})` : bot.id;
    const option = h("option", { value: bot.id, text: libelle });
    if (bot.id === botCourant?.id) option.selected = true;
    botSelect.append(option);
  }
  botSelect.disabled = botsConnus.length === 0;
  // LOT 36 (L4) — le lien mène à la conversation DU BOT AFFICHÉ (aucun bot
  // affiché ⇒ page de conversation sans `?b=` : le bot principal, comme avant).
  if (botConversationEl) {
    const id = botCourant?.id ?? "";
    botConversationEl.href = id === "" ? "/" : `/?b=${encodeURIComponent(id)}`;
    botConversationEl.setAttribute(
      "aria-label",
      id === "" ? "Ouvrir la conversation" : `Ouvrir la conversation de ${id}`,
    );
  }
}

/** Remplit le sélecteur ET câble le changement (une seule fois). */
function cablerSelecteurBot() {
  remplirSelecteurBot();
  if (!botSelect) return;
  botSelect.addEventListener("change", () => void changerDeBot(botSelect.value));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * AJOUTER / SUPPRIMER UN BOT (lot 35e)
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * « ＋ » : ouvre la modale de CRÉATION (NOM, avatar facultatif ; le clonage est
 * un second choix replié). ⚠️ Le bot est créé pour de vrai (`POST /api/bots`) :
 * le sélecteur l'affiche et la page bascule dessus.
 *
 * ⚠️ Un bot neuf n'a AUCUNE capacité : le message de succès le dit, sinon
 * l'utilisateur croirait à une panne (« il ne répond pas comme Yuki »).
 */
async function creerBotDepuisModale() {
  if (!PAGE_BOT) return;
  if (botsConnus.length >= modaleCreationBot({ bots: botsConnus }).maxBots) {
    await HolafModal.alert(
      "Limite de bots atteinte",
      modaleCreationBot({ bots: botsConnus }).limite,
      { okText: "Compris" },
    );
    return;
  }
  const cree = await ouvrirCreationBot({ HolafModal, bots: botsConnus });
  if (!cree || typeof cree.id !== "string") return;
  // Le sélecteur montre le nouveau bot AVANT la navigation (retour immédiat),
  // puis la page bascule dessus : `?b=<slug>` est l'état, et tout est relu.
  botsConnus = [...botsConnus, cree];
  botCourant = cree;
  remplirSelecteurBot();
  await HolafModal.alert(
    "Bot créé",
    "Bot créé. Il ne peut rien faire tant que tu ne l'autorises pas.",
    { okText: "Compris" },
  );
  location.assign(urlBot(cree.id));
}

/**
 * Zone de danger : SUPPRESSION avec compteurs réels et case à cocher
 * obligatoire. ⚠️ Le serveur n'efface rien : il déplace le dossier dans
 * `bots-supprimes/` et le conserve 3 mois.
 */
async function supprimerBotCourant() {
  if (!PAGE_BOT || !botCourant) return;
  if (botsConnus.length <= 1) {
    await HolafModal.alert(
      "Suppression impossible",
      "C'est le DERNIER bot de l'instance : une instance sans bot ne peut pas " +
        "démarrer. Créez d'abord un autre bot (bouton « ＋ »).",
      { okText: "Compris" },
    );
    return;
  }
  const resultat = await ouvrirSuppressionBot({ HolafModal, bot: botCourant });
  if (!resultat) return;
  const bots = Array.isArray(resultat.bots) ? resultat.bots : [];
  const cible =
    resultat.botActifSuivant ??
    bots.find((bot) => bot.actif === true)?.id ??
    bots[0]?.id ??
    null;
  if (resultat.rechargementRequis) {
    // ⚠️ Le gateway EN COURS applique encore les chemins du bot supprimé : c'est
    // dit à l'utilisateur, jamais passé sous silence.
    await HolafModal.alert(
      "Redémarrage nécessaire",
      "Le bot ACTIF de l'instance vient d'être supprimé : le gateway en cours " +
        "applique encore ses anciens chemins. Redémarrez le gateway (onglet " +
        "« Maintenance » de la page Instance) pour que le bot suivant devienne " +
        "réellement actif. Ses données sont conservées 3 mois.",
      { okText: "Compris" },
    );
  }
  if (resultat.sessionsPi?.etat === "echec") {
    // ⚠️ LOT 35i : la copie des sessions Pi a échoué. Les conversations sont
    // INTACTES sur leur volume, mais elles ne sont plus visibles par le bot
    // supprimé : l'utilisateur doit le SAVOIR, jamais une perte silencieuse.
    await HolafModal.alert(
      "Conversations conservées à part",
      "Les conversations (sessions Pi) de ce bot n'ont pas pu être copiées dans " +
        "l'archive : elles restent INTACTES à leur emplacement d'origine" +
        (resultat.sessionsPi.origine ? ` (${resultat.sessionsPi.origine})` : "") +
        ". Rien n'a été effacé. Elles seront purgées à l'échéance de la rétention " +
        "(3 mois) avec le reste de l'archive.",
      { okText: "Compris" },
    );
  }
  if (cible === null || cible === botCourant.id) {
    location.reload();
    return;
  }
  location.assign(urlBot(cible, location.hash));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * CÂBLAGE
 * ═══════════════════════════════════════════════════════════════════════════ */

saveButton.addEventListener("click", () => void save());
// Le redémarrage n'existe que sur la page Instance (onglet Maintenance).
if (restartButton) restartButton.addEventListener("click", () => void restart());

if (botAddButton) {
  botAddButton.addEventListener("click", () => void creerBotDepuisModale());
}

// Navigation par onglets : clic, clavier (flèches + Home/End, activation au
// focus), et hash (`#voix`, etc.) pour les liens directs et back/forward.
for (const button of tabButtons) {
  button.addEventListener("click", () => {
    selectTab(button.getAttribute("aria-controls").replace(/^panel-/, ""), {
      updateHash: true,
    });
  });
}
if (tablistEl) {
  tablistEl.addEventListener("keydown", (event) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const index = tabButtons.indexOf(document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (index + 1) % tabButtons.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (index - 1 + tabButtons.length) % tabButtons.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = tabButtons.length - 1;
    }
    selectTab(
      tabButtons[next].getAttribute("aria-controls").replace(/^panel-/, ""),
      { updateHash: true, focus: true },
    );
  });
}
window.addEventListener("hashchange", () => {
  selectTab(tabFromHash() ?? premierOnglet());
  revealHashTarget();
});

/** Onglet d'ouverture par défaut : le premier de la page (Instance : Modèles). */
function premierOnglet() {
  return ongletsDePage(PAGE)[0]?.id ?? "modeles";
}

// Ligne d'explication SOUS le titre (④) : elle dit où est allé ce qui a
// déménagé. Une seule source de vérité (`config-pages.js`).
if (pageLigneEl) pageLigneEl.textContent = ligneDePage(PAGE);

// Onglet initial : celui du hash, sinon le premier de la page. Appliqué avant
// le chargement des données pour que le bon panneau soit visible sans latence.
selectTab(tabFromHash() ?? premierOnglet());

void (async () => {
  try {
    // PAGE BOT : le bot affiché doit être connu AVANT toute lecture ou écriture
    // (c'est lui qui décide de la route `GET/PUT /api/bots/<id>/config`).
    if (PAGE_BOT) {
      await resoudreBot();
      cablerSelecteurBot();
      renderBotGeneral();
      afficherBandeauBot();
      selectTab(tabFromHash() ?? premierOnglet());
    }
    await load();
    await pollHealth();
    // Un seul lecteur Web Audio est partagé (voix + assistant) : la lecture
    // nécessite un geste utilisateur, on `resume()` le contexte au clic.
    const player = createTtsPlayer();
    // ⚠️ Les composants autonomes qui lisent le bot ACTIF (personnalité, voix,
    // plateformes) ne sont montés que si le bot affiché EST le bot actif : sinon
    // ils afficheraient les données d'un autre bot et enregistreraient chez lui
    // (`bots-api.js` : `idBotActif`). Le bandeau `#bot-notice` explique l'absence.
    // ⚠️ LOT 35j — EXCEPTION : le panneau des DÉCLENCHEURS est monté pour TOUT bot
    // affiché (voir plus bas), parce que ses routes sont désormais PAR BOT
    // (`?bot=<id>`) : il n'a plus besoin d'être le bot actif pour être juste.
    const panneauxDuBotActif = !PAGE_BOT || botAfficheEstActif();
    if (voicesRoot && panneauxDuBotActif) {
      voicesPanel = initVoicesPanel({
        root: voicesRoot,
        HolafFetch,
        HolafModal,
        player,
        getActiveVoice: () => String(state.fields["tts.voice"]?.value ?? ""),
        onVoiceSelected: (id) => {
          // `tts.voice` n'est plus un champ du formulaire : le select de la
          // bibliothèque (zone ②) l'écrit immédiatement (`PUT` `tts.voice`).
          // On ne tient à jour que `state.fields` (lu par `getActiveVoice`).
          const entry = state.fields["tts.voice"];
          if (entry) entry.value = id;
          updateDirtyIndicators();
        },
      });
    }
    // Assistant de mise en route du TTS (Lot 8) : composant autonome monté par
    // id. La zone ① (bandeau d'état) vit dans `#tts-assistant-root` et la zone
    // ⑤ (technique repliée) dans `#tts-engine-root` : deux emplacements, UN
    // SEUL composant, jamais dupliqué.
    if (panneauxDuBotActif && ttsAssistantRoot) {
      initTtsAssistant(ttsAssistantRoot, {
        HolafFetch,
        HolafModal,
        player,
        engineRoot: ttsEngineRoot,
        getActiveVoice: () => String(state.fields["tts.voice"]?.value ?? ""),
        onConfigChanged: () => void load(),
        // Chemin d'écriture UNIQUE de `tts.enabled` : le bandeau passe par
        // l'enregistrement global (plus de redémarrage silencieux du bouton).
        requestEnableVoice: enableVoiceShortcut,
        // Chemin d'écriture UNIQUE de `tts.engine` (raccourci « Choisir comme
        // moteur » de l'UI de téléchargement, zone ⑤).
        requestActivateEngine: activateEngineShortcut,
        openMaintenance: () => selectTab("maintenance", { updateHash: true }),
      });
    }
    // Section « Mot de passe d'instance » : UN SEUL mot de passe pour toute
    // l'instance (haché scrypt), qui déverrouille les agents « matériel
    // sensible ». Aucune valeur n'est jamais réaffichée.
    if (panneauxDuBotActif && instancePasswordRoot) {
      initInstancePasswordPanel({ root: instancePasswordRoot, HolafFetch, HolafModal });
    }
    // Panneau des agents d'exécution (Lot 4, B5) : liste, état, niveau,
    // privilège, « matériel sensible » (verrou), suppression (HolafModal) et
    // validations en attente.
    if (panneauxDuBotActif && agentsRoot) {
      initAgentsPanel({ root: agentsRoot, HolafFetch, HolafModal });
    }
    // Panneau des secrets : coffre chiffré (noms seulement), ajout/modification/
    // suppression à chaud. Aucune valeur n'est jamais réaffichée.
    if (panneauxDuBotActif && secretsRoot) {
      initSecretsPanel({ root: secretsRoot, HolafFetch, HolafModal });
    }
    // Panneau des IMAGES générées : import des workflows (format API), étiquettes
    // trouvées / manquantes, « par défaut », suppression. Composant autonome.
    if (panneauxDuBotActif && imagesRoot) {
      imagesPanel = initImagesPanel({ root: imagesRoot, HolafFetch, HolafModal });
    }
    // Panneau des SOURCES : programmes extérieurs autorisés à réveiller Yuki
    // (nom + jeton du coffre + trois réglages indépendants + consigne libre).
    // ⚠️ Le jeton n'est affiché qu'UNE fois, à sa création.
    // ⚠️ LOT 35j : monté pour TOUT bot AFFICHÉ (pas seulement l'actif) et avec SON
    // identifiant — chaque bot a SES déclencheurs, ses pré-autorisations et ses
    // envois (`?bot=<id>`), et le panneau les nomme. Sans bot résolu (page des bots
    // sans registre), on ne monte rien : on n'affiche jamais « ceux du bot actif »
    // en laissant croire qu'ils sont à lui.
    const botDesSources = PAGE_BOT ? (botCourant?.id ?? "") : "";
    if ((!PAGE_BOT || botDesSources !== "") && sourcesRoot) {
      sourcesPanel = initSourcesPanel({
        root: sourcesRoot,
        HolafFetch,
        HolafModal,
        botId: botDesSources,
      });
    }
    // Panneau « Discussions » (Mattermost, Discord) : jeton saisi une fois, état de la
    // connexion, backfill 2 semaines, canaux suivis. Composant autonome monté par id.
    if (panneauxDuBotActif && chatRoot) {
      initChatPanel({
        root: chatRoot,
        HolafModal,
        // ⚠️ Ancre `/config#chat-remote-agents` : le contrôle « Agents distants » n'existe
        // qu'APRÈS ce montage, et la hauteur de l'onglet n'est DÉFINITIVE qu'après la
        // première lecture d'état (les sections de plateforme se remplissent alors). On
        // refait donc le défilement une fois, puis plus jamais (l'utilisateur est maître
        // de son défilement ensuite).
        onFirstRender: () => revealHashTarget(),
      });
      revealHashTarget();
    }
    // Panneau de la personnalité : édition, enregistrement, retour arrière,
    // historique. Composant autonome monté par id.
    if (panneauxDuBotActif && personalityRoot) {
      initPersonalityPanel({ root: personalityRoot, HolafFetch, HolafModal });
    }
    setInterval(() => void pollHealth(), 5000);
  } catch (error) {
    globalError.textContent = `Impossible de charger la configuration : ${
      error instanceof Error ? error.message : String(error)
    }`;
    globalError.hidden = false;
  }
})();
