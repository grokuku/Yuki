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
import { initTheme } from './theme.js';
import { createTtsPlayer } from './tts-player.js';
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
    fields: [
      { path: "prompts.light", label: "Prompt système — léger", kind: "textarea" },
      { path: "prompts.heavy", label: "Prompt système — lourd", kind: "textarea" },
    ],
  },
  {
    id: "tts",
    title: "Voix / TTS",
    fields: [
      { path: "tts.enabled", label: "Activation", kind: "select", options: OPTIONS.ttsEnabled },
      { path: "tts.engine", label: "Moteur", kind: "select", options: OPTIONS.ttsEngine },
      { path: "tts.baseUrl", label: "URL du service TTS", kind: "text" },
      { path: "tts.language", label: "Langue", kind: "select", options: OPTIONS.ttsLanguage },
      { path: "tts.voice", label: "Voix (identifiant du registre)", kind: "text" },
      { path: "tts.emotion", label: "Émotion", kind: "select", options: OPTIONS.ttsEmotion },
      { path: "tts.speed", label: "Débit (%)", kind: "number", min: 50, max: 200 },
      {
        path: "tts.exaggeration",
        label: "Exagération (pour-mille)",
        kind: "range",
        min: 0,
        max: 1500,
        step: 10,
        revealWhen: { path: "tts.emotion", equals: "personnalisee" },
      },
      {
        path: "tts.cfg",
        label: "CFG (pour-mille)",
        kind: "range",
        min: 0,
        max: 1500,
        step: 10,
        revealWhen: { path: "tts.emotion", equals: "personnalisee" },
      },
      { path: "tts.prefetchDepth", label: "Prefetch (phrases d'avance)", kind: "number", min: 0, max: 2 },
      { path: "tts.minSentenceChars", label: "Longueur minimale de phrase", kind: "number", min: 8, max: 500 },
      { path: "tts.maxSentenceChars", label: "Longueur maximale de phrase", kind: "number", min: 40, max: 2000 },
      { path: "tts.timeoutMs", label: "Timeout de synthèse (ms)", kind: "number", min: 1000, max: 120000 },
      { path: "tts.volume", label: "Volume de lecture (%)", kind: "number", min: 0, max: 100 },
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

const state = {
  fields: {},
  status: { lightKey: false, heavyKey: false, ready: false },
  initial: new Map(),
  inputs: new Map(),
  rows: new Map(),
  secretState: new Map(),
  pendingResets: new Set(),
  healthReady: false,
};

const groupsEl = document.getElementById("groups");
const saveButton = document.getElementById("save");
const saveStatus = document.getElementById("save-status");
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
  });
  clearButton.addEventListener("click", () => {
    secret.mode = "clear";
    input.hidden = true;
    valueSpan.textContent = "La clé sera effacée à l'enregistrement.";
  });

  container.append(valueSpan, replaceButton, clearButton, input);
  return container;
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
    });
    row.append(node);
    if (field.kind === "textarea") {
      const reset = h("button", { class: "button button--ghost button--small", type: "button", text: "Réinitialiser au défaut" });
      reset.addEventListener("click", () => {
        control.value = "";
        state.pendingResets.add(field.path);
      });
      row.append(h("div", { class: "config-helper" }, [reset]));
    }
    if (entry.origin === "store") {
      row.append(h("span", { class: "config-helper", text: "Valeur enregistrée (surcharge le défaut)." }));
    }
  }
  row.append(h("p", { class: "config-error", hidden: "hidden" }));
  return row;
}

function render() {
  groupsEl.textContent = "";
  for (const group of GROUPS) {
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
    for (const field of group.fields) section.append(renderField(field));
    groupsEl.append(section);
  }
  refreshVisibility();
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
  const patch = {};
  for (const field of ALL_FIELDS) {
    const entry = state.fields[field.path];
    if (entry?.lockedByEnv) continue;

    if (field.kind === "secret") {
      const secret = state.secretState.get(field.path);
      if (!secret) continue;
      if (secret.mode === "clear") {
        patch[field.path] = null;
        continue;
      }
      const value = secret.input ? secret.input.value.trim() : "";
      if (value !== "") patch[field.path] = value;
      continue;
    }

    if (state.pendingResets.has(field.path)) {
      patch[field.path] = null;
      continue;
    }
    const control = state.inputs.get(field.path);
    if (!control) continue;
    const value = control.value;
    const initial = state.initial.get(field.path);
    if (field.path === "gpu.profile" && value === "") {
      if (initial !== "") patch[field.path] = null;
      continue;
    }
    if (String(value) !== String(initial)) patch[field.path] = value;
  }
  return patch;
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
  state.initial.clear();
  state.inputs.clear();
  state.rows.clear();
  state.secretState.clear();
  state.pendingResets.clear();
  updateAvailability();
}

async function save() {
  saveStatus.textContent = "Enregistrement…";
  globalError.hidden = true;
  try {
    // Corps JSON envoyé en objet : la brique le sérialise et pose le
    // Content-Type ; les en-têtes maison (WRITE_HEADERS) sont préservés.
    const body = await HolafFetch.put("/api/config", {
      headers: WRITE_HEADERS,
      body: buildPatch(),
    });
    applySnapshot(body);
    render();
    showApplied(body.applied ?? { hot: [], restart: [] });
    saveStatus.textContent = "Enregistré.";
    // La voix active a pu changer côté formulaire : resynchronise le panneau.
    void voicesPanel?.refresh();
  } catch (error) {
    // Erreurs métier : HolafFetch expose le corps JSON parsé dans `error.data`
    // (fields/message/error), sinon le message typé de la brique.
    const data = error?.data ?? {};
    showFieldErrors(
      data.fields ?? [
        {
          path: "",
          message:
            data.message ??
            data.error ??
            (error instanceof Error ? error.message : String(error)),
        },
      ],
    );
    saveStatus.textContent = "Échec de l'enregistrement.";
  }
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

async function restart() {
  const confirmed = await HolafModal.confirm(
    "Redémarrer Yuki ?",
    "Cela interrompt la conversation et les jobs en cours.\n\n" +
      "Yuki redémarre son programme en interne ; le conteneur reste en place.",
  );
  if (!confirmed) return;

  restartButton.disabled = true;
  saveButton.disabled = true;
  setRestartStatus("Redémarrage demandé…");
  try {
    await HolafFetch.post("/api/admin/restart", { headers: WRITE_HEADERS });
  } catch (error) {
    // Corps JSON d'erreur exposé par la brique : `message` d'abord
    // (convention du gateway), sinon `error`, sinon le message typé.
    const data = error?.data ?? {};
    const message =
      data.message ??
      data.error ??
      (error instanceof Error ? error.message : String(error));
    setRestartStatus(
      `Échec de la demande de redémarrage : ${message}`,
      true,
    );
    restartButton.disabled = false;
    saveButton.disabled = false;
    return;
  }
  await waitForGatewayRestart();
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

void (async () => {
  try {
    await load();
    await pollHealth();
    if (voicesRoot) {
      voicesPanel = initVoicesPanel({
        root: voicesRoot,
        HolafFetch,
        HolafModal,
        player: createTtsPlayer(),
        getActiveVoice: () => String(state.fields["tts.voice"]?.value ?? ""),
        onVoiceSelected: (id) => {
          const entry = state.fields["tts.voice"];
          if (entry) entry.value = id;
          const input = state.inputs.get("tts.voice");
          if (input) input.value = id;
          state.initial.set("tts.voice", id);
        },
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
