/**
 * Page « Configuration » — vanilla, `type="module"`, aucune chaîne de build.
 *
 * - lit `GET /api/config` (valeurs effectives, clés masquées) ;
 * - écrit via `PUT /api/config` (en-tête `X-Yuki-Config: 1`) ;
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
import { buildConfigPatch, engineFieldState, presentConfigSaveError, presentRestartRefusal } from './config-patch.js';
import { initTheme } from './theme.js';
import { createTtsPlayer } from './tts-player.js';
import { initTtsAssistant } from './tts-assistant.js';
import { initVoicesPanel } from './voices-panel.js';

HolafModal.configure({ injectStyles: false });

// Rend la brique visible à `theme.js` (son `setTheme` global ne pilote que les
// modales/toasts déjà chargés) — un import ESM ne pose rien sur `window`.
window.HolafModal = HolafModal;

// Thème (famille + mode clair/sombre) : applique le choix persisté (migration
// silencieuse des anciennes valeurs plates) et câble les contrôles de la
// topbar. Le pont `window.HolafModal` ci-dessus permet à theme.js de piloter
// la brique avec le nom exact du preset (holaf-modal 0.5.0).
initTheme();

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

const OPTIONS = {
  api: [["openai-completions", "openai-completions"]],
  thinking: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((v) => [v, v]),
  profiles: [
    ["", "∅ (auto)"],
    ["confort", "confort"],
    ["compact", "compact"],
    ["repli", "repli"],
    ["texte-seul", "texte-seul"],
  ],
  compat: [
    ["strict", "strict"],
    ["auto-degrade", "auto-degrade"],
  ],
  missingKey: [
    ["degrade", "degrade"],
    ["refuse", "refuse"],
  ],
  // Lot 7 — TTS / voix.
  ttsEnabled: [
    ["off", "désactivé"],
    ["on", "activé"],
  ],
  ttsEngine: [
    ["chatterbox", "chatterbox"],
    ["qwen3-tts", "qwen3-tts"],
    ["cosyvoice3", "cosyvoice3"],
    ["kokoro", "kokoro"],
    ["sanotts", "sanotts"],
  ],
  ttsLanguage: [["fr", "français (fr)"]],
  ttsEmotion: [
    ["neutre", "neutre"],
    ["expressive", "expressive"],
    ["dramatique", "dramatique"],
    ["personnalisee", "personnalisée"],
  ],
};

const GROUPS = [
  {
    id: "llm-light",
    title: "LLM léger",
    role: "light",
    fields: [
      { path: "llm.light.baseUrl", label: "URL de base", kind: "text" },
      { path: "llm.light.apiKey", label: "Clé d'API", kind: "secret" },
      { path: "llm.light.model", label: "Modèle", kind: "text" },
      { path: "llm.light.api", label: "Dialecte d'API", kind: "select", options: OPTIONS.api },
      { path: "llm.light.thinking", label: "Réflexion (thinking)", kind: "select", options: OPTIONS.thinking },
    ],
  },
  {
    id: "llm-heavy",
    title: "LLM lourd",
    role: "heavy",
    fields: [
      { path: "llm.heavy.baseUrl", label: "URL de base", kind: "text" },
      { path: "llm.heavy.apiKey", label: "Clé d'API", kind: "secret" },
      { path: "llm.heavy.model", label: "Modèle", kind: "text" },
      { path: "llm.heavy.api", label: "Dialecte d'API", kind: "select", options: OPTIONS.api },
      { path: "llm.heavy.thinking", label: "Réflexion (thinking)", kind: "select", options: OPTIONS.thinking },
    ],
  },
  {
    id: "delegation",
    title: "Délégation",
    fields: [
      { path: "llm.missingKeyMode", label: "Politique si clé manquante", kind: "select", options: OPTIONS.missingKey },
      { path: "delegation.defaultDeadlineMs", label: "Attente inline par défaut (ms)", kind: "number", min: 200, max: 60000 },
      { path: "delegation.maxConcurrent", label: "Jobs simultanés", kind: "number", min: 1 },
      { path: "delegation.maxQueue", label: "Taille de la file", kind: "number", min: 0 },
      { path: "delegation.idleTimeoutMs", label: "Timeout d'inactivité (ms)", kind: "number", min: 1 },
      { path: "delegation.totalTimeoutMs", label: "Timeout global (ms)", kind: "number", min: 1 },
    ],
  },
  {
    id: "gpu",
    title: "GPU",
    fields: [
      { path: "gpu.profile", label: "Profil forcé", kind: "select", options: OPTIONS.profiles },
      { path: "gpu.compatMode", label: "Mode de compatibilité", kind: "select", options: OPTIONS.compat },
      { path: "gpu.minDriver", label: "Driver NVIDIA minimal (majeure)", kind: "number", min: 1 },
    ],
  },
  {
    id: "prompts",
    title: "Prompts système",
    // Bloc LECTURE SEULE : l'instruction vocale réellement injectée (volet 1).
    voiceInstruction: true,
    fields: [
      { path: "prompts.light", label: "Prompt système — léger", kind: "textarea" },
      { path: "prompts.heavy", label: "Prompt système — lourd", kind: "textarea" },
    ],
  },
  {
    id: "tts",
    title: "Réglages de la voix",
    fields: [
      // — Zone ③ : les 6 réglages ESSENTIELS (visibles sans clic) —
      {
        path: "tts.enabled",
        label: "Activer la voix",
        kind: "select",
        options: OPTIONS.ttsEnabled,
        helper: "Active la synthèse vocale. Prise en compte après un redémarrage de Yuki.",
      },
      {
        path: "tts.engine",
        label: "Moteur de synthèse",
        kind: "select",
        options: OPTIONS.ttsEngine,
        helper: "Moteur qui prononce le texte. Certains réglages ne s'appliquent qu'à certains moteurs.",
      },
      {
        path: "tts.language",
        label: "Langue",
        kind: "select",
        options: OPTIONS.ttsLanguage,
        helper: "Langue de la voix.",
      },
      {
        path: "tts.emotion",
        label: "Émotion",
        kind: "select",
        options: OPTIONS.ttsEmotion,
        helper: "Intonation générale. « personnalisée » active les curseurs d'exagération et de guidage (zone « Avancé »).",
      },
      {
        path: "tts.speed",
        label: "Débit de parole (%)",
        kind: "number",
        min: 50,
        max: 200,
        helper: "Vitesse de la parole en pourcentage (100 = normal).",
      },
      {
        path: "tts.volume",
        label: "Volume de lecture (%)",
        kind: "number",
        min: 0,
        max: 100,
        helper: "Volume de lecture côté navigateur (100 = maximum).",
      },
      // ⚠️ `tts.voice` n'est PLUS un champ texte ici : la bibliothèque de voix
      // (zone ②, `voices-panel.js`) en est l'unique contrôle et l'écrit tout de suite.
      // — Zone ④ : le technique, replié sous « Avancé » —
      {
        path: "tts.baseUrl",
        label: "Adresse du moteur (avancé)",
        kind: "text",
        advanced: true,
        helper: "Adresse du service TTS dans le réseau Docker. À ne changer que si vous relocalisez le moteur.",
      },
      {
        path: "tts.exaggeration",
        label: "Exagération (pour-mille)",
        kind: "range",
        min: 0,
        max: 1500,
        step: 10,
        advanced: true,
        revealWhen: { path: "tts.emotion", equals: "personnalisee" },
        helper: "Force d'expression (500 = neutre). N'agit qu'avec une émotion « personnalisée » et un moteur compatible.",
      },
      {
        path: "tts.cfg",
        label: "Contrôle de guidage (CFG)",
        kind: "range",
        min: 0,
        max: 1500,
        step: 10,
        advanced: true,
        revealWhen: { path: "tts.emotion", equals: "personnalisee" },
        helper: "Fidélité au style demandé (500 = neutre). N'agit qu'avec une émotion « personnalisée » et un moteur compatible.",
      },
      {
        path: "tts.prefetchDepth",
        label: "Préchargement (phrases d'avance)",
        kind: "number",
        min: 0,
        max: 2,
        advanced: true,
        helper: "Nombre de phrases synthétisées à l'avance pour réduire l'attente entre les phrases.",
      },
      {
        path: "tts.minSentenceChars",
        label: "Découpe — longueur minimale d'une phrase",
        kind: "number",
        min: 8,
        max: 500,
        advanced: true,
        helper: "En deçà, un fragment n'est pas découpé seul.",
      },
      {
        path: "tts.maxSentenceChars",
        label: "Découpe — longueur maximale d'une phrase",
        kind: "number",
        min: 40,
        max: 2000,
        advanced: true,
        helper: "Au-delà, la phrase est coupée pour être synthétisée par morceaux.",
      },
      {
        path: "tts.timeoutMs",
        label: "Délai maximal de synthèse (ms)",
        kind: "number",
        min: 1000,
        max: 120000,
        advanced: true,
        helper: "Au-delà, la synthèse est abandonnée (le moteur est peut-être bloqué).",
      },
    ],
  },
  {
    id: "transport",
    title: "Transport temps réel",
    fields: [
      { path: "transport.replayBuffer", label: "Buffer de rejeu (trames)", kind: "number", min: 1 },
      { path: "transport.replayBytes", label: "Buffer de rejeu (octets)", kind: "number", min: 1 },
    ],
  },
];

const ALL_FIELDS = GROUPS.flatMap((group) => group.fields);
const LABELS = new Map(ALL_FIELDS.map((field) => [field.path, field.label]));
// `tts.voice` n'est plus un champ du groupe (la bibliothèque de la zone ② en est
// l'unique contrôle), mais son libellé reste utile pour les messages d'erreur.
LABELS.set("tts.voice", "Voix active");

/**
 * Valeurs par défaut des champs — **miroir UI** de `src/config/schema.ts`.
 * Sert UNIQUEMENT à l'aide « Valeur par défaut : X. » et au bouton
 * « Réinitialiser au défaut ». Le reset lui-même envoie `null` au serveur (qui
 * applique SON défaut) : cette table ne fige donc rien côté serveur, elle rend
 * seulement le contrôle cohérent immédiatement. Tenir synchronisée avec le
 * schéma (aucun accès au schéma depuis le navigateur).
 */
const FIELD_DEFAULTS = {
  "llm.light.baseUrl": "https://ollama.com/v1",
  "llm.light.model": "gemma4:31b",
  "llm.light.api": "openai-completions",
  "llm.light.thinking": "off",
  "llm.heavy.baseUrl": "https://ollama.com/v1",
  "llm.heavy.model": "deepseek-v4.1-flash",
  "llm.heavy.api": "openai-completions",
  "llm.heavy.thinking": "high",
  "llm.missingKeyMode": "degrade",
  "delegation.defaultDeadlineMs": 1500,
  "delegation.maxConcurrent": 3,
  "delegation.maxQueue": 10,
  "delegation.idleTimeoutMs": 120000,
  "delegation.totalTimeoutMs": 1200000,
  "gpu.profile": "",
  "gpu.compatMode": "strict",
  "gpu.minDriver": 580,
  "prompts.light": "",
  "prompts.heavy": "",
  "tts.enabled": "off",
  "tts.engine": "chatterbox",
  "tts.baseUrl": "http://tts:8081",
  "tts.language": "fr",
  "tts.emotion": "neutre",
  "tts.speed": 100,
  "tts.exaggeration": 500,
  "tts.cfg": 500,
  "tts.prefetchDepth": 2,
  "tts.minSentenceChars": 24,
  "tts.maxSentenceChars": 240,
  "tts.timeoutMs": 15000,
  "tts.volume": 100,
  "transport.replayBuffer": 1000,
  "transport.replayBytes": 5000000,
};

/**
 * Onglets de la page (5 sections) et répartition des groupes de champs.
 * Le rendu reste EAGER : le contenu de chaque onglet est construit dans le DOM
 * dès le chargement ; l'onglet actif n'est qu'une question de `hidden`.
 */
const TABS = [
  { id: "modeles", groups: ["llm-light", "llm-heavy"] },
  { id: "conversation", groups: ["delegation", "prompts"] },
  { id: "voix", groups: ["tts"] },
  { id: "systeme", groups: ["gpu", "transport"] },
  { id: "maintenance", groups: [] },
];

/** Groupe de champs → identifiant d'onglet qui le contient. */
const TAB_BY_GROUP = new Map();
for (const tab of TABS) {
  for (const groupId of tab.groups) TAB_BY_GROUP.set(groupId, tab.id);
}

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
};

const tablistEl = document.querySelector('.config-tablist[role="tablist"]');
const tabButtons = [...document.querySelectorAll('[role="tab"]')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
const saveButton = document.getElementById("save");
const saveStatus = document.getElementById("save-status");
const saveDirty = document.getElementById("save-dirty");
const globalError = document.getElementById("global-error");
const availabilityEl = document.getElementById("availability");
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
/** Panneau des voix (Lot 7) — instancié après le premier chargement. */
let voicesPanel = null;

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

/** Libellé lisible d'une valeur (mappe les options des `<select>`). */
function valueLabel(field, value) {
  if (field.kind === "select" && Array.isArray(field.options)) {
    const found = field.options.find(([v]) => String(v) === String(value));
    if (found) return found[1];
  }
  const text = String(value ?? "");
  return text === "" ? "∅ (vide)" : text;
}

/**
 * Valeur par défaut d'un champ (via `FIELD_DEFAULTS`), affichée en clair et
 * injectable dans le contrôle. `undefined` si le champ n'a pas de défaut connu
 * (les champs secrets n'en ont jamais).
 */
function fieldDefault(field) {
  return Object.prototype.hasOwnProperty.call(FIELD_DEFAULTS, field.path)
    ? FIELD_DEFAULTS[field.path]
    : undefined;
}

/**
 * « Réinitialiser au défaut » : restaure la valeur PAR DÉFAUT dans le contrôle
 * et, si une surcharge existe (`origin === "store"`), demande au serveur de
 * l'effacer (`null` dans le patch via `pendingResets`). Si le champ est déjà au
 * défaut, la remise à zéro reste purement locale (aucun envoi inutile).
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
  if (entry.lockedByEnv) label.append(lockedBadge(entry.lockedByEnv));
  row.append(label);

  if (field.kind === "secret") {
    row.append(renderSecret(field, entry));
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
    if (!entry.lockedByEnv && fallback !== undefined) {
      if (entry.origin === "store") {
        defaults.append(
          h("p", {
            class: "config-helper",
            text: `Valeur enregistrée (surcharge le défaut : ${valueLabel(field, fallback)}).`,
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

function render() {
  const containers = new Map();
  for (const tab of TABS) {
    const container = document.getElementById(`group-${tab.id}`);
    if (container) {
      container.textContent = "";
      containers.set(tab.id, container);
    }
  }
  for (const group of GROUPS) {
    const tabId = TAB_BY_GROUP.get(group.id);
    const container = containers.get(tabId) ?? containers.get("modeles");
    if (!container) continue;
    const section = h("section", { class: "config-group" });
    const status = h("span", { class: "config-helper" });
    const head = h("div", { class: "config-group__head" }, [
      h("h2", { class: "config-group__title", text: group.title }),
    ]);
    if (group.role) {
      const test = h("button", { class: "button button--ghost button--small", type: "button", text: "Tester la connexion" });
      test.addEventListener("click", () => testConnection(group.role, status));
      head.append(h("div", { class: "config-secret" }, [test, status]));
    }
    section.append(head);
    // Rendu EAGER : les champs « essentiels » sont directement dans la section ;
    // les champs `advanced` sont regroupés dans un repli `<details>` DISTINCT
    // (classe `config-advanced`, jamais `tts-details`) — masqué, jamais retiré.
    const advanced = [];
    for (const field of group.fields) {
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
    container.append(section);
  }
  refreshVisibility();
  refreshEngineFields();
  updateDirtyIndicators();
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

/** Identifiant d'onglet valide déduit du hash courant, sinon `null`. */
function tabFromHash() {
  const raw = location.hash.replace(/^#/, "");
  return TABS.some((tab) => tab.id === raw) ? raw : null;
}

/**
 * Active un onglet : état `aria-selected`/`tabindex` sur les onglets et
 * `hidden` sur les panneaux. Le DOM reste EAGER (aucun panneau n'est vidé).
 * `refreshVisibility()` est rappelé car les champs conditionnels d'un onglet
 * peuvent dépendre d'un champ d'un autre onglet.
 */
function activateTab(tabId, { focus = false } = {}) {
  if (!TABS.some((tab) => tab.id === tabId)) return;
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
  if (!TABS.some((tab) => tab.id === tabId)) return;
  activateTab(tabId, { focus });
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
  for (const group of GROUPS) {
    const tabId = TAB_BY_GROUP.get(group.id);
    for (const field of group.fields) {
      if (isFieldDirty(field)) {
        anyDirty = true;
        if (tabId) dirtyTabs.add(tabId);
      }
    }
  }
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

async function load() {
  const body = await HolafFetch.get("/api/config", {
    headers: { accept: "application/json" },
  });
  applySnapshot(body);
  render();
}

function applySnapshot(body) {
  state.fields = body.fields ?? {};
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
  try {
    // Corps JSON envoyé en objet : la brique le sérialise et pose le
    // Content-Type ; les en-têtes maison (WRITE_HEADERS) sont préservés.
    const body = await HolafFetch.put("/api/config", {
      headers: writeHeaders(flow),
      body: buildPatch(),
    });
    applySnapshot(body);
    render();
    showApplied(body.applied ?? { hot: [], restart: [] });
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
  if (!lightKey) {
    availabilityEl.textContent =
      "La conversation est indisponible — saisissez une clé LLM légère ci-dessous.";
    availabilityEl.hidden = false;
    availabilityEl.className = "config-banner config-banner--warn";
  } else {
    availabilityEl.hidden = true;
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
  if (!state.healthReady && state.status.lightKey) {
    availabilityEl.textContent =
      "Le service n'est pas encore prêt (profil GPU ou PiHost). Vérifiez /health.";
    availabilityEl.hidden = false;
    availabilityEl.className = "config-banner config-banner--warn";
  } else if (state.healthReady) {
    availabilityEl.hidden = true;
  }
  updateAvailability();
}

saveButton.addEventListener("click", () => void save());
restartButton.addEventListener("click", () => void restart());

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
  selectTab(tabFromHash() ?? "modeles");
});

// Onglet initial : celui du hash, sinon « Modèles ». Appliqué avant le
// chargement des données pour que le bon panneau soit visible sans latence.
selectTab(tabFromHash() ?? "modeles");

void (async () => {
  try {
    await load();
    await pollHealth();
    // Un seul lecteur Web Audio est partagé (voix + assistant) : la lecture
    // nécessite un geste utilisateur, on `resume()` le contexte au clic.
    const player = createTtsPlayer();
    if (voicesRoot) {
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
    if (ttsAssistantRoot) {
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
    setInterval(() => void pollHealth(), 5000);
  } catch (error) {
    globalError.textContent = `Impossible de charger la configuration : ${
      error instanceof Error ? error.message : String(error)
    }`;
    globalError.hidden = false;
  }
})();
