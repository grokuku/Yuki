// Yuki — UI minimale (vanilla, sans build).
//
// Reçoit les événements du gateway via WebSocket, applique strictement le
// curseur `seq` (ni trou ni doublon) et réinitialise son rendu à partir d'un
// `snapshot` lorsque la fenêtre de rejeu est dépassée ou à la reconnexion.

import { initTheme } from "./theme.js";
import { createMarkdownRenderer } from "./markdown.js";
import { decodeTtsFrame } from "./tts-frames.js";
import { createTtsPlayer } from "./tts-player.js";
import { createTtsPreference, resolveSpeechState } from "./tts-preference.js";
import { HolafModal } from "./vendor/holaf/holaf-modal.js";
import {
  createNotificationsControl,
  initPresenceTracking,
  registerServiceWorker,
} from "./push.js";
import { conversationTitle, initSessionsPanel } from "./sessions-panel.js";
import {
  UNREAD_STORAGE_KEY,
  addUnread,
  clearUnread,
  parseUnread,
  pruneUnread,
  serializeUnread,
  shouldMarkUnread,
} from "./unread.js";
import { initSidebarAgents } from "./sidebar-agents.js";
import { createApprovalLayer } from "./approval-window.js";
import { createScrollToBottom } from "./scroll-button.js";
import { createScreenshotBlocks } from "./screenshot-block.js";
import { createSubagentActivity } from "./subagent-activity.js";
import { createThinkingBlocks } from "./thinking.js";
import {
  JOB_FINISHED_HOLD_MS,
  JOB_TICK_MS,
  THINKING_LABEL,
  describeActivity,
} from "./activity.js";
import { liveRunMetricsText, runMetricsText } from "./run-stats.js";

// Thème (dropdown + bascule) : applique le choix persisté ou le réglage
// système, et câble les contrôles de la topbar.
initTheme();

const CLIENT_VERSION = "1";
const MAX_RECONNECT_DELAY_MS = 8000;

const els = {
  chat: document.getElementById("chat"),
  conversation: document.getElementById("conversation"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  stop: document.getElementById("stop"),
  emptyNew: document.getElementById("empty-new"),
  connection: document.getElementById("connection"),
  sessionState: document.getElementById("session-state"),
  pendingBadge: document.getElementById("pending-badge"),
  queued: document.getElementById("queued"),
  thinking: document.getElementById("thinking"),
  jobActivity: document.getElementById("job-activity"),
  ttsToggle: document.getElementById("tts-toggle"),
  ttsStatus: document.getElementById("tts-status"),
};

let socket = null;
let lastSeq = 0;
let sessionId = null;
let currentAssistant = null;
let currentRenderer = null;
let resumePending = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let clientMsgCounter = 0;

/* ─── Notifications (PWA + Web Push) ──────────────────────────────────────
 * Le service worker est enregistré dès l'ouverture (l'interface devient
 * installable) ; le bouton de topbar gère l'abonnement de CET appareil, toujours
 * à la demande de l'utilisateur. Le clic d'une notification rouvre la
 * conversation concernée (`/?session=<id>`), que l'on adopte ci-dessous. */
const notifControl = createNotificationsControl({
  button: document.getElementById("notif-toggle"),
  onError: (message) => {
    void HolafModal.alert("Notifications", message, { okText: "Compris" });
  },
});
void registerServiceWorker().then(() => notifControl.refresh());
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void notifControl.refresh();
});

/** Conversation visée par un clic de notification (`?session=<id>`). */
const deepLinkSession = new URLSearchParams(window.location.search).get("session");
let deepLinkHandled = false;

/* ─── E2 — STORES PAR CONVERSATION (transport multiplexé) ──────────────────
 * Le serveur diffuse, PAR ABONNEMENT, les trames de TOUTES les conversations
 * listées (pas seulement la focalisée). Chaque trame porte son `sessionId` :
 * on la route vers le store du fil concerné. Le DOM ne reflète QUE la
 * conversation FOCALISÉE (comportement inchangé) — mais l'activité d'un fil
 * d'arrière-plan est VISIBLE dans la barre latérale, et on peut y basculer sans
 * rien perdre (le run continue côté serveur, l'historique arrive par snapshot).
 */
const storeBySession = new Map();
let lastSessions = [];
let lastBusyKey = "";

/* ─── Indicateur « message NON LU » (barre latérale) ───────────────────────
 * Deux informations DISTINCTES cohabitent dans la liste :
 *   - « en cours » (`.conv--busy`) : une tâche travaille MAINTENANT ;
 *   - « non lu » (`.conv--unread`) : un tour assistant s'est TERMINÉ dans une
 *     conversation que l'on ne regardait pas.
 * Un « non lu » s'allume sur la FIN D'UN TOUR (`run_finished`), jamais sur un
 * delta (sinon il s'allumerait en permanence pendant le flux). Il s'éteint
 * dès que la conversation devient la conversation FOCALISÉE (ouvrir = lire).
 * L'état est PERSISTÉ en `localStorage` : il survit à un rechargement / à un
 * redémarrage de la PWA, comme le repli de la barre.
 */

/** État persisté : `{ <sessionId>: <compteur> }`, purgé de tout non-exploitable. */
function loadUnread() {
  try {
    return parseUnread(window.localStorage.getItem(UNREAD_STORAGE_KEY));
  } catch {
    return {}; // Stockage indisponible (mode privé) : état en mémoire seulement.
  }
}

/** Persiste l'état non lu (best-effort, jamais bloquant). */
function persistUnread(counts) {
  try {
    window.localStorage.setItem(UNREAD_STORAGE_KEY, serializeUnread(counts));
  } catch {
    // Stockage indisponible : l'état reste en mémoire pour la session.
  }
}

let unreadBySession = loadUnread();

/** Remplace l'état non lu, le persiste et rafraîchit la barre. */
function commitUnread(next, refresh = true) {
  if (next === unreadBySession) return;
  unreadBySession = next;
  persistUnread(next);
  if (refresh) sessionsPanel.setUnread(next);
}

/** Allume/compte un non-lu sur un fil NON focalisé (la conversation regardée ne s'allume jamais). */
function markConversationUnread(id) {
  if (!id || id === sessionId) return;
  commitUnread(addUnread(unreadBySession, id));
}

/** Éteint le non-lu d'une conversation (ouvrir = lire, sans exiger d'aller en bas). */
function markConversationRead(id) {
  if (!id) return;
  commitUnread(clearUnread(unreadBySession, id));
}

/** Store d'une conversation (créé à la demande). */
function storeOf(id) {
  if (!id) return null;
  let store = storeBySession.get(id);
  if (!store) {
    store = {
      id,
      state: "idle",
      activeRunId: null,
      lastSeq: 0,
      runningJobs: new Set(),
    };
    storeBySession.set(id, store);
  }
  return store;
}

/** `true` si la conversation TRAVAILLE (run en cours, tâche de fond active ou
 * résultat en attente de livraison). */
function isBusy(store) {
  return (
    Boolean(store) &&
    (store.state === "streaming" ||
      store.state === "waiting" ||
      store.runningJobs.size > 0)
  );
}

/** Reflète l'ensemble des conversations « en cours » dans la barre latérale. */
function refreshSidebarBusy() {
  const busy = busyIdList();
  const key = busy.join(",");
  if (key === lastBusyKey) return;
  lastBusyKey = key;
  sessionsPanel.setBusy(busy);
}

/** Identifiants des conversations EN COURS (triés, stable pour la comparaison). */
function busyIdList() {
  const busy = [];
  for (const store of storeBySession.values()) {
    // La conversation FOCALISÉE garde ses indicateurs habituels (attente, activité
    // de fond) : le point « en cours » de la barre ne sert qu'aux AUTRES fils,
    // pour que la conversation affichée se comporte EXACTEMENT comme avant.
    if (store.id === sessionId) continue;
    if (isBusy(store)) busy.push(store.id);
  }
  return busy.sort();
}

/** Applique un événement de session à l'ÉTAT (hors DOM) de son fil. */
function updateStoreState(store, frame) {
  switch (frame.type) {
    case "state":
      store.state = typeof frame.state === "string" ? frame.state : "idle";
      store.activeRunId = typeof frame.activeRunId === "string" ? frame.activeRunId : null;
      return;
    case "run_started":
      store.state = "streaming";
      return;
    case "run_finished":
      store.state = "idle";
      store.activeRunId = null;
      return;
    case "job_started":
      if (frame.jobId !== undefined && frame.jobId !== null) {
        store.runningJobs.add(String(frame.jobId));
      }
      return;
    case "job_finished":
      if (frame.jobId !== undefined && frame.jobId !== null) {
        store.runningJobs.delete(String(frame.jobId));
      }
      return;
    default:
      return;
  }
}

/**
 * Événement d'un fil NON focalisé : on nourrit SON store (aucun `seq` global,
 * aucun `resume` demandé — le rejeu ne concerne que la session focalisée).
 * Le DOM de la conversation affichée n'est JAMAIS touché ⇒ aucun mélange.
 */
function applyBackgroundEvent(id, frame) {
  const store = storeOf(id);
  if (!store) return;
  if (typeof frame.seq === "number" && frame.seq > 0) {
    if (frame.seq <= store.lastSeq) return; // doublon / REJEU de CE fil
  }
  // Décision AVANT d'avancer `lastSeq` : la garde anti-rejeu de
  // `shouldMarkUnread` compare le `seq` de la trame à celui DÉJÀ appliqué.
  const unread = shouldMarkUnread(store, frame);
  if (typeof frame.seq === "number" && frame.seq > 0) store.lastSeq = frame.seq;
  updateStoreState(store, frame);
  refreshSidebarBusy();
  // Un tour assistant TERMINÉ dans un fil non focalisé = un message non lu.
  if (unread) markConversationUnread(id);
}

/** Titre lisible d'une conversation (repli honnête), pour étiqueter une demande. */
function conversationLabelFor(id) {
  if (!id) return "";
  const info = lastSessions.find((entry) => entry.id === id);
  return info ? conversationTitle(info) : "";
}

/* ─── Attente & activité de fond ─────────────────────────────────────────
 * `#thinking` (`.thinking-indicator`) est l'UNIQUE indicateur d'attente : il
 * s'affiche dès qu'un run est lancé (`run_started`) et disparaît dès le premier
 * contenu. Le canal `thinking` du modèle est mort (modèle léger sans
 * raisonnement) — l'indicateur est donc piloté par l'ÉTAT DU RUN, jamais par
 * un canal qui n'arrive pas.
 *
 * `#job-activity` rend visible le cycle de vie des jobs d'arrière-plan (trames
 * `job_*`) : sans lui, une délégation de fond est INVISIBLE jusqu'au tour de
 * rapport. Il vit HORS de la conversation (jamais dans le transcript).
 */
els.thinking.textContent = THINKING_LABEL;

/** État des jobs d'arrière-plan connus, par `jobId`. */
const jobs = new Map();
let jobsTick = null;
let jobsHideTimer = null;
const jobActivityText = document.createElement("span");
jobActivityText.className = "job-activity__text";
const jobActivityTimer = document.createElement("span");
jobActivityTimer.className = "job-activity__timer";
// Le compteur change chaque seconde : il ne doit PAS être annoncé (anti-spam).
jobActivityTimer.setAttribute("aria-hidden", "true");
els.jobActivity.append(jobActivityText, jobActivityTimer);

function showThinking() {
  els.thinking.hidden = false;
}

function hideThinking() {
  els.thinking.hidden = true;
}

function renderJobActivity() {
  const view = describeActivity([...jobs.values()], Date.now());
  if (!view) {
    els.jobActivity.hidden = true;
    jobActivityText.textContent = "";
    jobActivityTimer.textContent = "";
    els.jobActivity.removeAttribute("data-tone");
    return;
  }
  jobActivityText.textContent = view.text;
  jobActivityTimer.textContent = view.timer;
  els.jobActivity.dataset.tone = view.tone;
  els.jobActivity.hidden = false;
}

/** Met à jour la cadence du compteur selon qu'une tâche est EN COURS. */
function syncJobsTick() {
  const hasRunning = [...jobs.values()].some((job) => job.status === "running");
  if (hasRunning && !jobsTick) {
    jobsTick = setInterval(renderJobActivity, JOB_TICK_MS);
  } else if (!hasRunning && jobsTick) {
    clearInterval(jobsTick);
    jobsTick = null;
  }
}

/** Efface l'activité de fond (bascule de fil : l'état appartient à un fil). */
function resetJobActivity() {
  jobs.clear();
  if (jobsTick) {
    clearInterval(jobsTick);
    jobsTick = null;
  }
  if (jobsHideTimer) {
    clearTimeout(jobsHideTimer);
    jobsHideTimer = null;
  }
  renderJobActivity();
}

function onJobStarted(frame) {
  const id = String(frame.jobId ?? "");
  if (!id) return;
  if (jobsHideTimer) {
    clearTimeout(jobsHideTimer);
    jobsHideTimer = null;
  }
  jobs.set(id, {
    id,
    task: typeof frame.task === "string" ? frame.task : undefined,
    status: "running",
    startedAt: Date.now(),
  });
  renderJobActivity();
  syncJobsTick();
}

function onJobFinished(frame) {
  const id = String(frame.jobId ?? "");
  if (!id) return;
  const existing = jobs.get(id);
  const startedAt = existing?.startedAt ?? Date.now();
  jobs.set(id, {
    id,
    task: existing?.task,
    status: typeof frame.status === "string" ? frame.status : "completed",
    startedAt,
    durationMs: Math.max(0, Date.now() - startedAt),
  });
  renderJobActivity();
  syncJobsTick();
  // Un statut terminal reste visible un moment : il porte le résultat (statut +
  // durée). Il ne s'efface QUE s'il n'y a plus aucune tâche en cours.
  if (jobsHideTimer) clearTimeout(jobsHideTimer);
  jobsHideTimer = setTimeout(() => {
    jobsHideTimer = null;
    if ([...jobs.values()].some((job) => job.status === "running")) return;
    jobs.clear();
    renderJobActivity();
  }, JOB_FINISHED_HOLD_MS);
}

/* ─── Conversations multiples (barre latérale) ─────────────────────────────
 * Le panneau est un composant autonome monté par id. Chaque action envoie une
 * trame au gateway, qui reste la SOURCE DE VÉRITÉ (liste + conversation
 * active) : le client ne fait que refléter les trames `sessions` reçues.
 */
// Encart « agents » ancré en BAS de la barre latérale (sous la liste). Le
// on/off envoie `agent_enabled` : le SERVEUR décide du niveau (`disabled` ⇄
// précédent) et rediffuse la trame `agents` — un seul état, aucune divergence.
const sidebarAgents = initSidebarAgents({
  onToggle: (agentId, enabled) => {
    if (sendRaw({ type: "agent_enabled", agentId, enabled })) return;
    void HolafModal.alert(
      "Hors ligne",
      "Impossible de changer l'état de l'agent : la connexion au gateway est perdue.",
      { okText: "Compris" },
    );
  },
  // Menu contextuel de l'agent : choix du niveau de confirmation (D118).
  // ⚠️ MÊME état que le on/off : « Désactivé » = off ; un autre niveau = on.
  onSetLevel: (agentId, level) => {
    if (sendRaw({ type: "agent_level", agentId, level })) return;
    void HolafModal.alert(
      "Hors ligne",
      "Impossible de régler le niveau de l'agent : la connexion au gateway est perdue.",
      { okText: "Compris" },
    );
  },
});

const sessionsPanel = initSessionsPanel({
  root: document.getElementById("sessions-sidebar"),
  HolafModal,
  footer: sidebarAgents.element,
  onSwitch: (id) => {
    if (id !== sessionId) sendRaw({ type: "switch", sessionId: id });
  },
  onNew: () => {
    sendRaw({ type: "new" });
  },
  onRename: (id, title) => {
    sendRaw({ type: "rename", sessionId: id, title });
  },
  onSetAside: (id) => {
    sendRaw({ type: "setAside", sessionId: id });
  },
  onPin: (id, pinned) => {
    sendRaw({ type: "pin", sessionId: id, pinned });
  },
});

/* ─── Validation humaine — FENÊTRE FLOTTANTE (D118) ─────────────────────
 * La demande s'affiche AU-DESSUS de l'interface (position `fixed`), PARTOUT
 * (y compris sur `/config`), NON bloquante (aucun voile), DÉPLAÇABLE, et ne se
 * ferme PAS au clic à côté. Elle REMPLACE le bloc qui vivait dans le fil : une
 * seule fenêtre par demande, aucun double compte à rebours. État TEMPORAIRE de
 * l'interface (jamais un message, jamais dans l'historique : le serveur ne
 * l'envoie que par trames de contrôle). La décision part par le WebSocket
 * (trame `approval_decision`). */
const approvalLayer = createApprovalLayer({
  onDecide: (id, decision) => {
    if (sendRaw({ type: "approval_decision", id, decision })) return;
    approvalLayer.resetBusy();
    void HolafModal.alert(
      "Hors ligne",
      "Impossible d'envoyer votre décision : la connexion au gateway est perdue. " +
        "Réessayez une fois reconnecté.",
      { okText: "Compris" },
    );
  },
  // Demande de SECRET (`awaiting_secret`) : la valeur saisie part par le
  // WebSocket (trame `secret_submit`) puis est CHIFFRÉE côté serveur. ⚠️ Elle
  // n'est jamais renvoyée par l'API et n'est jamais journalisée.
  onSubmitSecret: (id, values) => {
    if (sendRaw({ type: "secret_submit", id, values })) return;
    approvalLayer.resetBusy();
    void HolafModal.alert(
      "Hors ligne",
      "Impossible d'envoyer le secret : la connexion au gateway est perdue. " +
        "Réessayez une fois reconnecté.",
      { okText: "Compris" },
    );
  },
});

/* ─── Capture d'écran DANS la conversation ────────────────────────────────
 * État TEMPORAIRE de l'interface (jamais un message, jamais dans l'historique) :
 * le serveur ne l'envoie QUE par trame de contrôle `screenshot`, jamais dans le
 * transcript ni le rejeu. L'image n'est affichée qu'ICI (à l'humain) : le modèle
 * ne la reçoit jamais. */
const screenshotBlocks = createScreenshotBlocks({ container: els.conversation });

/* ─── E3 — Activité d'un SOUS-AGENT DANS le fil ────────────────────────────
 * Bloc COMPOSANT du fil (jamais un message) : replié par défaut, dépliable. Il
 * est alimenté par les trames de CONTRÔLE `job_activity` (éphémères, MUETTES) et
 * rattaché au fil `sessionId` de la conversation qui a lancé le sous-agent. */
const subagentActivity = createSubagentActivity({ container: els.conversation });

/* ─── Réflexion du modèle DANS le fil (canal `thinking`) ────────────────────
 * Alimenté par une trame de CONTRÔLE éphémère (aucun `seq` consommé) : un bloc
 * replié par défaut apparaît AVANT la réponse du tour, à sa place. Jamais dans
 * le transcript ni le rejeu ; jamais prononcé (voir thinking.js). */
const thinkingBlocks = createThinkingBlocks({ container: els.conversation });

/** Bascule l'état « aucune conversation ouverte » (le fil est masqué). */
function setEmptyState(empty) {
  if (els.chat) els.chat.classList.toggle("chat--empty", Boolean(empty));
}

/* ─── Voix / TTS (Lot 7, Lot C) ───────────────────────────────────────────
 * Articulation (voir docs/lot7.md §9.3) :
 *   - l'activation SERVEUR (`tts.enabled`) est décidée sur la page /config ;
 *   - le bouton de topbar = SOURDINE locale (localStorage), instantanée ;
 *   - l'affichage du bouton reflète l'état EFFECTIF (serveur ∧ non sourd) et
 *     ne ment donc jamais.
 */
const ttsPreference = createTtsPreference();
let ttsServerEnabled = false;
let ttsServerKnown = false;
let ttsStatusTimer = null;
/* Diagnostic « moteur absent » : requête TTS émise sans jamais de premier
 * octet PCM → on signale au lieu de prétendre que tout va bien. */
let ttsRequestedRun = null;
let ttsActivityRun = null;

const ttsPlayer = createTtsPlayer({
  onEvent: (event) => {
    // Alimente les étages serveur `playback_started` / `playback_aborted`.
    if (event.runId) {
      sendRaw({ type: "playback", runId: event.runId, event: event.type });
    }
  },
});

/** `true` si les trames reçues doivent être lues (serveur on + non sourd). */
function ttsAudible() {
  return ttsServerEnabled && !ttsPreference.muted;
}

function setTtsStatus(text, autoHideMs = 6000) {
  if (!els.ttsStatus) return;
  if (ttsStatusTimer) {
    clearTimeout(ttsStatusTimer);
    ttsStatusTimer = null;
  }
  els.ttsStatus.textContent = text ?? "";
  els.ttsStatus.hidden = !text;
  if (text && autoHideMs > 0) {
    ttsStatusTimer = setTimeout(() => {
      els.ttsStatus.hidden = true;
      els.ttsStatus.textContent = "";
    }, autoHideMs);
  }
}

/** Reflète l'état effectif de la voix dans le bouton de topbar. */
function refreshTtsToggle() {
  if (!els.ttsToggle) return;
  const state = resolveSpeechState({
    serverEnabled: ttsServerEnabled,
    muted: ttsPreference.muted,
  });
  // L'icône (haut-parleur / barré) est un SVG inline présent dans le markup :
  // les classes d'état ci-dessous décident lequel est visible (styles.css).
  els.ttsToggle.setAttribute("aria-pressed", String(state.pressed));
  els.ttsToggle.setAttribute("aria-label", state.label);
  els.ttsToggle.title = state.hint;
  els.ttsToggle.classList.toggle("tts-toggle--off", state.state === "off");
  els.ttsToggle.classList.toggle("tts-toggle--muted", state.state === "muted");
}

/** Lit l'état serveur (`tts.enabled`, `tts.volume`) — pas de mensonge sinon. */
async function loadTtsServerState() {
  try {
    const response = await fetch("/api/config", {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const enabled = body?.fields?.["tts.enabled"]?.value;
    ttsServerEnabled = enabled === "on";
    ttsServerKnown = true;
    const volume = Number(body?.fields?.["tts.volume"]?.value);
    if (Number.isFinite(volume)) ttsPlayer.setVolume(volume);
  } catch {
    // Config illisible : état INCONNU → on n'affirme pas que la voix est active.
    ttsServerKnown = false;
    ttsServerEnabled = false;
  }
  refreshTtsToggle();
}

/** Geste utilisateur : débloque le contexte audio (autoplay) et bascule la sourdine. */
function onTtsToggleClick() {
  void ttsPlayer.unlock();
  if (!ttsServerEnabled) {
    setTtsStatus(
      ttsServerKnown
        ? "La voix est désactivée côté serveur : activez-la dans « Voix / TTS » (Configuration), puis redémarrez Yuki."
        : "État de la voix inconnu (configuration illisible).",
      9000,
    );
    return;
  }
  const muted = ttsPreference.toggle();
  if (muted) {
    // Coupe INSTANTANÉMENT la lecture en cours (sans aller-retour réseau).
    ttsPlayer.stopAll();
  }
  refreshTtsToggle();
  setTtsStatus(muted ? "Voix en sourdine sur ce navigateur." : "Voix active.");
}

function setConnection(online) {
  els.connection.textContent = online ? "connecté" : "hors ligne";
  els.connection.classList.toggle("pill--online", online);
  els.connection.classList.toggle("pill--offline", !online);
}

function setSessionState(state) {
  if (state === "streaming") {
    els.sessionState.textContent = "streaming";
    els.stop.disabled = false;
  } else if (state === "waiting") {
    // E5 — travail en cours (lu dans le JobStore) : l'état « en attente » est
    // affiché quoi que dise le texte du modèle.
    els.sessionState.textContent = "en attente";
    els.stop.disabled = true;
  } else if (state === "error") {
    els.sessionState.textContent = "erreur";
    els.stop.disabled = true;
    hideThinking();
  } else {
    els.sessionState.textContent = "idle";
    els.stop.disabled = true;
    hideThinking();
  }
  // E5 — badge NON MASQUABLE : visible UNIQUEMENT sur l'état serveur `waiting`.
  if (els.pendingBadge) els.pendingBadge.hidden = state !== "waiting";
}

function clearEmpty() {
  const empty = els.conversation.querySelector(".empty");
  if (empty) empty.remove();
}

/* ─── Défilement ─────────────────────────────────────────────────────────
 * On ne colle en bas QUE si l'utilisateur y était DÉJÀ avant la mutation.
 * Sinon, remonter dans l'historique devient impossible : chaque delta le
 * ramènerait de force en bas. Le seuil tolère un léger décalage (arrondis).
 *
 * ⚠️ L'épinglage est un ÉTAT STICKY, réévalué UNIQUEMENT sur un `scroll` RÉEL.
 * La distance au fond NE SUFFIT PAS à décider : elle grandit aussi SANS que
 * l'utilisateur bouge, chaque fois que #conversation RÉTRÉCIT — la zone de
 * saisie grandit quand on tape un message LONG, et l'indicateur d'attente
 * s'affiche. Mesurer à ce moment-là déclarerait à tort le fil « non épinglé »
 * alors que personne n'a remonté (bug « le scroll auto se désactive quand
 * j'envoie un long message »). Un défilement de l'utilisateur, lui, émet un
 * `scroll` : c'est le SEUL signal fiable.
 */
const SCROLL_PIN_THRESHOLD_PX = 24;
/** Durée (ms) du maintien en bas après un clic « revenir en bas » (le contenu
 * qui streame grandit : on suit le fond, puis l'utilisateur reprend la main). */
const STICK_TO_BOTTOM_MS = 600;

/** Bouton « revenir en bas » (créé plus bas) ; référence pour rafraîchir sa
 * visibilité depuis `pinIfNeeded`, SEUL point de passage après chaque mutation. */
let scrollButton = null;
/** `true` tant qu'un retour en bas FLUIDE est en cours (voir `goToEnd`). */
let stickToBottom = false;
let stickToBottomTimer = null;

/** État d'épinglage STICKY (voir la règle en tête de section). */
let conversationPinned = true;

/** Distance (px) au fond du fil ; 0 = collé en bas. */
function distanceFromBottom() {
  const el = els.conversation;
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function isConversationPinned() {
  return conversationPinned;
}

/** Ré-évalue l'épinglage depuis la distance RÉELLE — appelé sur les `scroll`
 * (geste utilisateur ou défilement programmatique), JAMAIS après une mutation. */
function refreshPinnedFromScroll() {
  // Retour en bas FLUIDE en cours : les positions intermédiaires de l'animation
  // sont loin du fond ; les mesurer dé-épinglerait à tort avant stabilisation.
  if (stickToBottom) return;
  conversationPinned = distanceFromBottom() <= SCROLL_PIN_THRESHOLD_PX;
}

/** `true` si le poste demande à réduire les animations (accessibilité). */
function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}

/** Défile jusqu'au fond MÊME calcul que `pinIfNeeded`, mais FLUIDE si permis. */
function scrollConversationToEnd() {
  const el = els.conversation;
  if (typeof el.scrollTo === "function" && !prefersReducedMotion()) {
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  } else {
    el.scrollTop = el.scrollHeight;
  }
}

/**
 * Retour en bas d'un clic sur le bouton : fluide, puis le fil RESTE épinglé le
 * temps que la position se stabilise (le contenu en cours de flux grandit
 * encore). Réutilise le défilement existant (`scrollConversationToEnd`).
 */
function goToEnd() {
  conversationPinned = true;
  stickToBottom = true;
  scrollConversationToEnd();
  if (stickToBottomTimer) clearTimeout(stickToBottomTimer);
  stickToBottomTimer = setTimeout(() => {
    stickToBottom = false;
    stickToBottomTimer = null;
  }, STICK_TO_BOTTOM_MS);
}

/**
 * L'utilisateur VIENT D'AGIR : il envoie un message. On lui montre TOUJOURS le
 * fond et on RÉ-ÉPINGLE — SANS dépendre d'un seuil de distance. C'est la règle
 * « un envoi ⇒ on va en bas » : quelle que soit la longueur du message (et donc
 * la taille de la zone de saisie), il veut voir sa bulle ET la réponse.
 * Distinct du cas « un message arrive alors qu'il lit plus haut » (on ne bouge
 * PAS) : ici l'utilisateur est l'AUTEUR du geste.
 */
function pinAfterUserSend() {
  conversationPinned = true;
  els.conversation.scrollTop = els.conversation.scrollHeight;
  if (scrollButton) scrollButton.refresh();
}

/** Geste utilisateur (molette, toucher, clavier) : il reprend la main. */
function cancelStickToBottom() {
  if (!stickToBottom) return;
  stickToBottom = false;
  if (stickToBottomTimer) {
    clearTimeout(stickToBottomTimer);
    stickToBottomTimer = null;
  }
}

function pinIfNeeded(pinned) {
  // Pendant un retour en bas, on SUIT le fond (le contenu grandit) au lieu de
  // mesurer un `pinned` devenu faux le temps de l'animation. Sinon, l'état
  // STICKY fait foi : il ne dépend pas de la croissance du contenu.
  if (stickToBottom) scrollConversationToEnd();
  else if (pinned || conversationPinned)
    els.conversation.scrollTop = els.conversation.scrollHeight;
  // Seul point de passage après mutation : la visibilité du bouton y est remise
  // à jour (masqué en bas, révélé dès qu'on remonte).
  if (scrollButton) scrollButton.refresh();
}

/* L'épinglage se réévalue sur chaque `scroll` RÉEL : un geste de l'utilisateur
 * (ou un défilement programmatique) qui éloigne du fond dé-épingle ; revenir au
 * fond ré-épingle. Enregistré AVANT le bouton pour que `isPinned()` voie l'état
 * à jour (le bouton, lui, rafraîchit sur `requestAnimationFrame`). */
els.conversation.addEventListener("scroll", refreshPinnedFromScroll, { passive: true });

/* ─── Bouton « revenir en bas » (uniquement si on a remonté le fil) ──────────
 * Flottant, discret, il n'apparaît qu'au-delà du seuil d'apparition et ramène en
 * bas (fluide + ré-épinglage) en RÉUTILISANT le défilement existant ci-dessus :
 * la visibilité relit `isConversationPinned`, l'état de retour `stickToBottom`,
 * et le clic appelle `goToEnd` — aucun second système de défilement.
 * ⚠️ Créé APRÈS `pinIfNeeded` : `refresh()` lit `stickToBottom` (état `let`). */
scrollButton = createScrollToBottom({
  conversation: els.conversation,
  isPinned: isConversationPinned,
  isReturning: () => stickToBottom,
  onActivate: goToEnd,
  onUserIntent: cancelStickToBottom,
});

/* ─── Horodatage de l'interface ───────────────────────────────────────────
 * L'heure « juste HH:mm » est affichée PETITE et discrète sur la ligne de
 * métadonnées de chaque message ; la date complète n'apparaît QUE dans le
 * séparateur de jour (`Intl.DateTimeFormat("fr-FR")`). Rendu fidèle à la
 * maquette validée (chat-layout) : trait interrompu autour d'un libellé centré.
 *
 * Le fuseau utilisé est celui du NAVIGATEUR : on le transmet au serveur (trame
 * `message`, champ `tz`) pour que le préfixe STOCKÉ soit, lui aussi, daté dans
 * l'heure locale de l'utilisateur (même si le conteneur tourne en UTC). */
const hourFormatter = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
});
const dayFormatter = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
});
const CLIENT_TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
})();

/** Instant exploitable (ms Unix positif), sinon `false`. */
function isTimestamp(ts) {
  return typeof ts === "number" && Number.isFinite(ts) && ts > 0;
}

/** Clé de jour LOCALE (comparaison des séparateurs), ou `null` si pas d'heure. */
function dayKeyOf(ts) {
  if (!isTimestamp(ts)) return null;
  const date = new Date(ts);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/* Dernière clé de jour rendue (le séparateur ne se répète pas dans un même
 * jour). Réinitialisée à chaque rendu complet (`applyTranscript`). */
let lastDayKey = null;

/** Séparateur de jour : deux demi-traits (`::before`/`::after`) autour du libellé.
 * `before` permet de l'insérer AVANT un nœud existant (message utilisateur
 * inséré pendant une sortie en cours) au lieu de la fin du fil. */
function appendDaySeparator(label, before = null) {
  const separator = document.createElement("div");
  separator.className = "daysep";
  separator.setAttribute("role", "separator");
  separator.setAttribute("aria-label", label);
  const span = document.createElement("span");
  span.className = "daysep__label";
  span.textContent = label;
  separator.appendChild(span);
  if (before) els.conversation.insertBefore(separator, before);
  else els.conversation.appendChild(separator);
  return separator;
}

/** Insère un séparateur SI le jour change (le premier jour du fil est conservé). */
function ensureDaySeparator(ts, before = null) {
  const key = dayKeyOf(ts);
  if (key === null || key === lastDayKey) return;
  lastDayKey = key;
  appendDaySeparator(dayFormatter.format(new Date(ts)), before);
}

/**
 * Corps `.message__body` d'un message (texte brut). Le rendu markdown de
 * l'assistant possède son propre `.message__body.markdown` (voir `markdown.js`).
 * Le corps hérite du `white-space: pre-wrap` de la bulle (les sauts de ligne de
 * l'utilisateur sont conservés).
 */
function createMessageBody(text) {
  const body = document.createElement("div");
  body.className = "message__body";
  body.textContent = text ?? "";
  return body;
}

/**
 * Pose l'heure « juste HH:mm » EN TÊTE d'un message (`.message__head`, AU-DESSUS
 * du texte). `alignEnd` = bord extérieur à droite (messages utilisateur). Un
 * message SANS horodatage n'affiche rien (pas de ligne d'en-tête vide).
 */
function setMessageTime(element, ts, alignEnd) {
  if (!element || !isTimestamp(ts)) return;
  let head = element.querySelector(".message__head");
  if (!head) {
    head = document.createElement("div");
    head.className = "message__head";
    // Inséré AVANT le corps : l'heure est TOUJOURS au-dessus du texte.
    element.insertBefore(head, element.firstChild);
  }
  if (alignEnd) head.classList.add("message__head--end");
  let time = head.querySelector(".message__time");
  if (!time) {
    time = document.createElement("span");
    time.className = "message__time";
    head.appendChild(time);
  }
  time.textContent = hourFormatter.format(new Date(ts));
}

function appendMessage(role, text, pinned = isConversationPinned(), ts = null, before = null) {
  clearEmpty();
  ensureDaySeparator(ts, before);
  const div = document.createElement("div");
  div.className = `message message--${role}`;
  div.appendChild(createMessageBody(text));
  if (before) els.conversation.insertBefore(div, before);
  else els.conversation.appendChild(div);
  // L'heure est EN TÊTE pour TOUT message ; alignée au bord extérieur (droite)
  // pour l'utilisateur, à gauche pour l'assistant (y compris les bulles d'erreur).
  setMessageTime(div, ts, role === "user");
  pinIfNeeded(pinned);
  return div;
}

/**
 * Bulle assistant : le texte y est rendu en markdown (blocs stabilisés). Le
 * balisage est construit PROGRAMMATIQUEMENT (voir `markdown.js`) — jamais par
 * `innerHTML`, donc aucune injection possible et aucun style en ligne (CSP).
 *
 * @param {string|null} [text] — texte initial (rejeu de snapshot) ; `null` en flux.
 * @param {boolean} [pinned]
 * @param {number|null} [ts] — instant du message (ms Unix) ; `null` si inconnu.
 */
function appendAssistantMessage(text = null, pinned = isConversationPinned(), ts = null) {
  clearEmpty();
  ensureDaySeparator(ts);
  const div = document.createElement("div");
  div.className = "message message--assistant";
  const renderer = createMarkdownRenderer();
  if (typeof text === "string" && text.length > 0) renderer.setText(text);
  div.appendChild(renderer.element);
  els.conversation.appendChild(div);
  setMessageTime(div, ts, false);
  currentRenderer = renderer;
  pinIfNeeded(pinned);
  return div;
}

function applyTranscript(transcript) {
  const pinned = isConversationPinned();
  // Le fil est reconstruit : on purge les blocs de validation (timers inclus)
  // et les captures ÉPHÉMÈRES. Ils seront ré-affichés par le serveur s'ils sont
  // ENCORE vivants (états de contrôle).
  approvalLayer.reset();
  screenshotBlocks.reset();
  subagentActivity.reset();
  thinkingBlocks.reset();
  // Le fil est reconstruit : toute statistique EN DIRECT (provisoire) devient
  // obsolète. On arrête le minuteur et on oublie l'alignement t0 des runs en
  // vol — les valeurs FINALES reviendront par le `run_summary`.
  stopLiveStats();
  runT0ByRun.clear();
  els.conversation.innerHTML = "";
  currentRenderer = null;
  lastDayKey = null;
  if (!Array.isArray(transcript) || transcript.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Envoyez un message pour commencer.";
    els.conversation.appendChild(p);
    pinIfNeeded(pinned);
    return;
  }
  for (const entry of transcript) {
    const ts = entry.timestamp;
    if (entry.role === "user") {
      appendMessage("user", entry.text ?? "", pinned, ts);
    } else {
      // Statistiques PERSISTÉES : elles rétablissent le pied technique après un
      // rechargement. Absentes (ancienne session) ⇒ aucun pied, aucune ligne.
      const div = appendAssistantMessage(entry.text ?? "", pinned, ts);
      const meta = runMetricsText(entry.metrics);
      if (meta) setMeta(div, meta);
    }
  }
  currentRenderer = null;
  pinIfNeeded(pinned);
}

/**
 * Pied de message assistant (`.message__footer` > `.message__stats`) : ligne
 * TECHNIQUE « TTFT … · total … · N tok », EN BAS À DROITE. Créé À LA DEMANDE.
 * Aucune région `aria-live` : la valeur peut changer en continu, elle ne doit
 * pas être annoncée à chaque rafraîchissement.
 */
function statsSpan(element) {
  let footer = element.querySelector(".message__footer");
  if (!footer) {
    footer = document.createElement("div");
    footer.className = "message__footer";
    element.appendChild(footer);
  }
  let stats = footer.querySelector(".message__stats");
  if (!stats) {
    stats = document.createElement("span");
    stats.className = "message__stats";
    footer.appendChild(stats);
  }
  return stats;
}

/**
 * Valeurs FINALES (trame `run_summary`) : SEULES elles font foi. Le pied reprend
 * son état normal — il redevient annonçable (accessibilité), un message sans
 * statistiques n'ayant de toute façon AUCUN pied.
 */
function setMeta(element, text) {
  if (!element || !text) return;
  const stats = statsSpan(element);
  stats.removeAttribute("aria-hidden");
  stats.textContent = text;
}

/**
 * Valeurs PROVISOIRES (pendant le run) : purement VISUELLES. Le texte change en
 * continu, on le retire donc de l'arbre d'accessibilité pendant qu'il évolue
 * (même garde que le compteur de tâche de fond, `jobActivityTimer`) : un lecteur
 * d'écran ne bégaie pas sur une valeur par seconde. Il sera réintégré à l'arrivée
 * des valeurs finales.
 */
function setLiveMeta(element, text) {
  if (!element || !text) return;
  const stats = statsSpan(element);
  stats.setAttribute("aria-hidden", "true");
  stats.textContent = text;
}

/** Retire le pied (aucune statistique ⇒ aucune ligne, même provisoire). */
function clearMeta(element) {
  const footer = element ? element.querySelector(".message__footer") : null;
  if (footer) footer.remove();
}

/* ─── Stats EN DIRECT (pied provisoire, remplacé par les valeurs finales) ──
 * Dès `run_started`, un pied est posé et rafraîchi : le temps écoulé avance,
 * le TTFT apparaît au premier token (MESURE serveur, trame `phase`). À la fin,
 * le `run_summary` REMPLACE ces valeurs provisoires par les valeurs FINALES
 * (celles qui sont persistées) — jamais l'inverse. Le pied est créé EN MÊME
 * TEMPS que la bulle : sa présence ne décale donc jamais le fil.
 */
const LIVE_STATS_TICK_MS = 200;
/** Alignement `t0` serveur → horloge client, par `runId` (trame `phase`). */
const runT0ByRun = new Map();
let liveStats = null;
let liveStatsTimer = null;

function renderLiveStats() {
  if (!liveStats) return;
  const text = liveRunMetricsText({
    elapsedMs: Date.now() - liveStats.clientT0,
    ttftMs: liveStats.ttftMs,
  });
  if (text) setLiveMeta(liveStats.element, text);
}

function startLiveStats(runId, element) {
  stopLiveStats();
  if (typeof runId !== "string" || !element) return;
  const aligned = runT0ByRun.get(runId);
  liveStats = {
    runId,
    element,
    // Repli HONNÊTE : sans trame d'instrumentation alignée, on compte depuis
    // l'instant où l'interface a vu le run démarrer (jamais de valeur inventée).
    clientT0: typeof aligned === "number" ? aligned : Date.now(),
    ttftMs: null,
  };
  renderLiveStats();
  liveStatsTimer = setInterval(renderLiveStats, LIVE_STATS_TICK_MS);
}

function stopLiveStats() {
  if (liveStatsTimer) {
    clearInterval(liveStatsTimer);
    liveStatsTimer = null;
  }
  liveStats = null;
}

function sendRaw(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

/** Déclare la présence (onglet visible / fenêtre focalisée) au serveur. */
const sendPresence = initPresenceTracking(sendRaw);

function handleFrame(frame) {
  if (!frame || typeof frame !== "object") return;
  const type = frame.type;

  if (type === "welcome") {
    if (frame.sessionId) sessionId = frame.sessionId;
    // Un `welcome { resumed: true }` acquitte notre `resume` : le rejeu (ou le
    // snapshot) suit, on autorise une nouvelle demande si un trou apparaissait.
    if (frame.resumed) resumePending = false;
    // Reconnexion : on purge les fenêtres de validation AVANT que le serveur ne
    // ré-émette les demandes ENCORE en attente. Une demande décidée PENDANT la
    // coupure ne doit PAS rester affichée (état vivant, pas d'historique).
    approvalLayer.reset();
    screenshotBlocks.reset();
    subagentActivity.reset();
    thinkingBlocks.reset();
    // Présence : le serveur sait ainsi si CETTE fenêtre regarde la conversation
    // (décision anti-spam des notifications). Envoyée après `hello`, une fois la
    // session courante connue du serveur.
    sendPresence();
    return;
  }
  if (type === "pong" || type === "bye") return;
  if (type === "error") {
    // Les erreurs de GESTION des conversations (doublon refusé, conversation
    // introuvable) ne sont pas des réponses de modèle : on les montre dans une
    // modale explicite, jamais comme une bulle d'assistant.
    if (frame.code === "session_inconnue" || frame.code === "PI_SESSION_ERROR") {
      void HolafModal.alert(
        "Action impossible",
        frame.message || "Cette action a échoué ; le serveur n'a fourni aucun détail.",
        { okText: "Compris" },
      );
      return;
    }
    // Validation tardive (déjà décidée ou expirée) : message HONNÊTE, jamais un
    // succès trompeur. La fenêtre correspondante a été retirée par `approval_cleared`.
    if (frame.code === "approval_not_found" || frame.code === "approval_unavailable") {
      approvalLayer.resetBusy();
      void HolafModal.alert(
        "Validation impossible",
        frame.message || "Cette demande de validation n'existe plus.",
        { okText: "Compris" },
      );
      return;
    }
    // Autre échec (réseau, erreur serveur) : on réactive les boutons de la fenêtre.
    approvalLayer.resetBusy();
    appendMessage("assistant error", frame.message || "erreur", undefined, Date.now());
    return;
  }
  if (type === "sessions") {
    const activeId = typeof frame.activeId === "string" ? frame.activeId : null;
    lastSessions = Array.isArray(frame.sessions) ? frame.sessions : [];
    sessionId = activeId;
    // « NON LU » : on purge les conversations disparues (mises de côté), puis
    // OUVRIR la conversation focalisée éteint son indicateur (ouvrir = lire,
    // sans exiger de faire défiler jusqu'en bas). `refresh=false` : le `update`
    // ci-dessous rend la liste complète avec l'état à jour.
    commitUnread(
      clearUnread(
        pruneUnread(
          unreadBySession,
          lastSessions.map((entry) => entry.id),
        ),
        activeId,
      ),
      false,
    );
    // E2 : la liste porte l'ensemble des conversations SUIVIES ; on y joint
    // l'état « en cours » ET « non lu » de chacune (indicateurs de la barre).
    sessionsPanel.update(lastSessions, activeId, busyIdList(), unreadBySession);
    setEmptyState(activeId === null);
    // Clic sur une notification : on adopte la conversation visée, une seule
    // fois, et seulement si elle existe (sinon on reste sur l'état courant).
    if (!deepLinkHandled && deepLinkSession) {
      deepLinkHandled = true;
      const known = lastSessions.some((entry) => entry.id === deepLinkSession);
      if (known && deepLinkSession !== activeId) {
        sendRaw({ type: "switch", sessionId: deepLinkSession });
      }
    }
    return;
  }
  // Encart agents : ÉTAT de contrôle (aucun `seq` consommé), envoyé à la
  // connexion puis rediffusé à chaque changement du registre (jamais bufferisé).
  if (type === "agents") {
    sidebarAgents.update(frame.agents);
    return;
  }
  if (type === "snapshot") {
    applySnapshot(frame);
    return;
  }

  // Validation humaine : ÉTAT TEMPORAIRE, trame de CONTRÔLE (aucun `seq`
  // consommé). Traitée AVANT la logique de curseur `seq`, sinon elle serait
  // prise pour un doublon. Jamais rejouée, jamais conservée.
  if (type === "approval") {
    // E2 : la fenêtre est GLOBALE ; on précise de QUELLE conversation vient la
    // demande (plusieurs fils peuvent en avoir en attente).
    approvalLayer.show(frame.approval, {
      conversation: conversationLabelFor(
        frame.approval ? frame.approval.sessionId : undefined,
      ),
    });
    return;
  }
  if (type === "approval_cleared") {
    approvalLayer.clear(String(frame.id));
    return;
  }
  if (type === "approval_result") {
    approvalLayer.showResult(frame.result);
    return;
  }
  // Demande de SECRET : ÉTAT TEMPORAIRE, trame de CONTRÔLE (aucun `seq`
  // consommé), traitée AVANT le curseur `seq`. Jamais rejouée, jamais
  // conservée. ⚠️ Ne porte JAMAIS une valeur : seulement les NOMS à fournir.
  if (type === "secret_request") {
    approvalLayer.showSecret(frame.request, {
      conversation: conversationLabelFor(
        frame.request ? frame.request.sessionId : undefined,
      ),
    });
    return;
  }
  if (type === "secret_cleared") {
    approvalLayer.clearSecret(String(frame.id));
    return;
  }
  // Capture d'écran : ÉTAT TEMPORAIRE, trame de CONTRÔLE (aucun `seq` consommé).
  // Traitée AVANT la logique de curseur `seq`, sinon elle serait prise pour un
  // doublon. Jamais rejouée, jamais conservée, jamais envoyée au modèle.
  if (type === "screenshot") {
    screenshotBlocks.show(frame.screenshot);
    return;
  }
  // E3 — ACTIVITÉ d'un sous-agent : trame de CONTRÔLE (aucun `seq` consommé),
  // traitée AVANT le curseur `seq` (sinon prise pour un doublon). Éphémère :
  // jamais rejouée, jamais conservée. Un fil NON focalisé ne la DESSINE pas
  // (son activité reste suivie via son store) ⇒ aucun mélange de fils.
  if (type === "job_activity") {
    const activityTarget =
      typeof frame.sessionId === "string" && frame.sessionId.length > 0
        ? frame.sessionId
        : sessionId;
    if (activityTarget && activityTarget !== sessionId) return;
    subagentActivity.apply(frame);
    return;
  }
  // RÉFLEXION du modèle : trame de CONTRÔLE (aucun `seq` consommé), routée comme
  // l'activité ⇒ JAMAIS bufferisée (ni rejeu, ni snapshot). ÉPHÉMÈRE et MUETTE
  // (le serveur ne l'envoie jamais au TTS). Un fil NON focalisé ne la dessine
  // pas. Le bloc est inséré AVANT la réponse du tour (ancrage sur le message
  // assistant en cours).
  if (type === "delta" && frame.channel === "thinking") {
    const thinkingTarget =
      typeof frame.sessionId === "string" && frame.sessionId.length > 0
        ? frame.sessionId
        : sessionId;
    if (!thinkingTarget || thinkingTarget !== sessionId) return;
    showThinking();
    thinkingBlocks.append(frame.runId, frame.text, currentAssistant);
    return;
  }

  // ⚠️ E2 — ROUTAGE PAR CONVERSATION ──────────────────────────────────────
  // Toute trame de session porte son `sessionId`. Le fil FOCALISÉ suit le
  // chemin historique (curseur `seq` STRICT + rendu DOM). Un fil NON focalisé
  // ne nourrit QUE son propre store : le DOM affiché n'est JAMAIS touché ⇒
  // aucun mélange de messages entre deux fils.
  const target =
    typeof frame.sessionId === "string" && frame.sessionId.length > 0
      ? frame.sessionId
      : sessionId;
  if (target && target !== sessionId) {
    applyBackgroundEvent(target, frame);
    return;
  }

  // Événements de la conversation FOCALISÉE : application stricte par `seq`.
  if (typeof frame.seq === "number" && frame.seq > 0) {
    if (frame.seq <= lastSeq) return; // doublon
    if (frame.seq !== lastSeq + 1) {
      requestResume();
      return;
    }
    lastSeq = frame.seq;
  }
  if (frame.sessionId) sessionId = frame.sessionId;
  // Le store du fil focalisé reflète aussi son état (indicateur de la barre).
  // On y avance `lastSeq` : si ce fil devient NON focalisé, ses trames déjà
  // vues seront reconnues comme doublons (et un rejeu ne comptera pas).
  const focusedStore = storeOf(sessionId);
  if (focusedStore) {
    updateStoreState(focusedStore, frame);
    if (typeof frame.seq === "number" && frame.seq > focusedStore.lastSeq) {
      focusedStore.lastSeq = frame.seq;
    }
    refreshSidebarBusy();
  }
  applyEvent(frame);
}

function applySnapshot(frame) {
  if (frame.sessionId) sessionId = frame.sessionId;
  lastSeq = typeof frame.seq === "number" ? frame.seq : 0;
  resumePending = false;
  currentAssistant = null;
  currentRenderer = null;
  // Le store du fil focalisé adopte l'état AUTORITATIF du snapshot (le run d'un
  // fil d'arrière-plan continue, lui, côté serveur et reste dans SON store).
  const store = storeOf(sessionId);
  if (store) {
    store.state = typeof frame.state === "string" ? frame.state : "idle";
    store.activeRunId = typeof frame.activeRunId === "string" ? frame.activeRunId : null;
    store.lastSeq = lastSeq;
    store.runningJobs.clear();
  }
  refreshSidebarBusy();
  // Ouvrir/afficher une conversation éteint son indicateur « non lu ».
  markConversationRead(sessionId);
  // L'activité de fond appartient au FIL : on repart propre à chaque rendu.
  resetJobActivity();
  applyTranscript(frame.transcript);
  setSessionState(frame.state || "idle");
}

function applyEvent(frame) {
  switch (frame.type) {
    case "accepted":
      els.queued.hidden = !frame.queued;
      return;
    case "state":
      setSessionState(frame.state);
      if (frame.state === "idle") els.queued.hidden = true;
      if (frame.state === "idle" || frame.state === "error") {
        currentAssistant = null;
        currentRenderer = null;
        // Filet de sécurité : le `run_summary` précède TOUJOURS l'état terminal
        // (il porte les valeurs FINALES et arrête déjà le minuteur). Si une trame
        // se perdait, ceci évite un minuteur orphelin qui tournerait sans fin.
        stopLiveStats();
      }
      return;
    case "run_started":
      els.queued.hidden = true;
      // Dès le lancement du run — AVANT le premier token — l'attente est
      // visible : c'est le seul indicateur entre l'envoi et le premier contenu.
      showThinking();
      currentAssistant = appendAssistantMessage(null, undefined, Date.now());
      // Pied de stats VISIBLE dès le lancement, mis à jour en direct (temps
      // écoulé) puis complété au premier token (TTFT).
      startLiveStats(frame.runId, currentAssistant);
      // Nouveau run : réinitialise le diagnostic TTS.
      ttsRequestedRun = frame.runId ?? null;
      ttsActivityRun = null;
      // Un prompt de report (`origin: "job_report"`) est SYNTHÉTIQUE : l'UI ne
      // doit jamais afficher de bulle utilisateur pour lui. Le serveur exclut
      // déjà ce prompt du transcript ; ici on ne crée que la bulle assistant.
      if (frame.origin === "job_report") {
        currentAssistant.dataset.origin = "job_report";
        if (frame.jobId) currentAssistant.dataset.jobId = frame.jobId;
      }
      return;
    case "delta":
      if (frame.channel === "thinking") {
        showThinking();
        return;
      }
      {
        // Du CONTENU arrive : l'attente est finie, l'indicateur disparaît.
        hideThinking();
        // `pinned` est mesuré AVANT d'ajouter le moindre contenu : on ne colle
        // en bas que si l'utilisateur y était déjà.
        const pinned = isConversationPinned();
        if (!currentAssistant) {
          currentAssistant = appendAssistantMessage(null, pinned, Date.now());
        }
        if (currentRenderer) currentRenderer.push(frame.text ?? "");
        pinIfNeeded(pinned);
      }
      return;
    case "phase":
      // Instrumentation : chaque trame porte `sinceT0Ms` (relatif au `t0`
      // SERVEUR). On en déduit l'alignement horloge client ↔ serveur, puis on
      // lit le TTFT RÉEL au premier token — jamais une valeur inventée.
      if (
        typeof frame.runId === "string" &&
        typeof frame.sinceT0Ms === "number" &&
        Number.isFinite(frame.sinceT0Ms) &&
        !runT0ByRun.has(frame.runId)
      ) {
        runT0ByRun.set(frame.runId, Date.now() - frame.sinceT0Ms);
      }
      if (liveStats && liveStats.runId === frame.runId) {
        const aligned = runT0ByRun.get(frame.runId);
        if (typeof aligned === "number") liveStats.clientT0 = aligned;
        if (frame.stage === "first_token" && typeof frame.sinceT0Ms === "number") {
          liveStats.ttftMs = frame.sinceT0Ms;
        }
        renderLiveStats();
      }
      if (frame.stage === "first_token") hideThinking();
      if (typeof frame.stage === "string" && frame.stage.startsWith("tts_")) {
        onTtsPhase(frame);
      } else if (frame.stage === "sentence_segmented") {
        onTtsPhase(frame);
      }
      return;
    case "run_finished": {
      hideThinking();
      els.queued.hidden = true;
      // L'alignement `t0` de ce run n'a plus d'usage (le `run_summary` — qui
      // porte les valeurs FINALES — suit immédiatement).
      runT0ByRun.delete(frame.runId);
      const pinned = isConversationPinned();
      // Dernier bloc (souvent resté en texte brut) : on le rend maintenant que
      // le flux est terminé, avant toute décision d'affichage. Le flush change
      // la hauteur : `pinned` a été mesuré AVANT.
      if (currentRenderer) currentRenderer.flush();
      // Le contenu RÉELLEMENT reçu (canal `content`). Sert à ne pas accuser le
      // moteur TTS à tort : une réponse vide n'a rien à prononcer.
      const producedContent = currentRenderer
        ? currentRenderer.text().trim().length > 0
        : false;
      if (
        ttsAudible() &&
        typeof frame.runId === "string" &&
        frame.runId === ttsRequestedRun
      ) {
        // Aucune trame audio encore reçue. DEUX causes très différentes :
        //  - aucune réponse texte : rien n'a été envoyé au moteur (réponse vide
        //    ou entièrement muette) — le moteur n'est PAS en cause ;
        //  - du texte existait mais aucun son n'est (encore) revenu.
        // Le diagnostic est DIFFÉRÉ : la synthèse du dernier segment démarre au
        // `run_finished`, ses premières trames arrivent juste après. Conclure
        // immédiatement accuserait à tort un run pourtant sonore. On laisse une
        // courte fenêtre, puis on distingue les deux causes sans jamais
        // affirmer que le moteur est mort alors qu'il est prêt.
        const finishedRunId = frame.runId;
        setTimeout(() => {
          if (finishedRunId === ttsActivityRun) return; // du son est arrivé
          setTtsStatus(
            producedContent
              ? "Aucun son reçu pour cette réponse : le texte n'a pas été prononcé."
              : "Aucune réponse texte à lire : le modèle n'a produit aucun contenu à prononcer.",
            9000,
          );
        }, 600);
      }
      if (currentAssistant) {
        // `hasText` doit porter sur le CONTENU seul : l'en-tête (heure) et le
        // pied (infos techniques) font partie de la bulle mais ne sont PAS des
        // réponses du modèle.
        const hasText = producedContent;
        if (frame.reason === "abort" && !hasText) {
          // On écrit dans le CORPS markdown (jamais `textContent` de la bulle :
          // cela effacerait l'en-tête d'heure et le pied technique).
          if (currentRenderer) currentRenderer.setText("(interrompu)");
        } else if (frame.reason === "done" && !hasText) {
          // Rien à afficher : on le DIT (bulle muette + métadonnées sinon
          // incompréhensibles), au lieu de laisser une bulle vide.
          if (currentRenderer) currentRenderer.setText("(aucune réponse texte reçue)");
        }
        if (frame.reason === "error") {
          currentAssistant.classList.add("message--error");
          if (currentRenderer) {
            currentRenderer.setText(
              frame.errorMessage || "Le modèle n'a pas répondu (aucun détail fourni).",
            );
          }
        }
        pinIfNeeded(pinned);
      } else if (frame.reason === "error") {
        appendMessage(
          "assistant error",
          frame.errorMessage || "Le modèle n'a pas répondu (aucun détail fourni).",
          undefined,
          Date.now(),
        );
      }
      currentAssistant = null;
      currentRenderer = null;
      return;
    }
    case "run_summary": {
      // Valeurs FINALES : elles REMPLACENT les provisoires (jamais l'inverse) et
      // ce sont les seules que le serveur persiste (`yuki.run_metrics`).
      const text = runMetricsText(frame);
      const live =
        liveStats && liveStats.runId === frame.runId ? liveStats : null;
      stopLiveStats();
      runT0ByRun.delete(frame.runId);
      const target = live ? live.element : els.conversation.lastElementChild;
      if (target && target.classList.contains("message--assistant")) {
        if (text) setMeta(target, text);
        else clearMeta(target); // aucune stat réelle ⇒ aucun pied (pas de ligne fantôme)
      }
      return;
    }
    case "job_started":
      onJobStarted(frame);
      // Le cycle de vie des jobs d'arrière-plan est DÉSORMAIS VISIBLE : sans
      // cela, une délégation de fond reste invisible jusqu'au tour de rapport.
      return;
    case "job_finished":
      onJobFinished(frame);
      return;
    case "job_report":
      // Le tour de rapport arrive par `run_started` (origin="job_report") :
      // l'activité de fond reste affichée jusqu'à son statut terminal.
      return;
    default:
      return;
  }
}

function requestResume() {
  if (resumePending) return;
  resumePending = true;
  if (!sendRaw({ type: "resume", sessionId, fromSeq: lastSeq })) {
    resumePending = false;
  }
}

/** Traite une trame binaire `YTA1` (audio) — décodage défensif puis lecture. */
function handleBinaryFrame(data) {
  const decoded = decodeTtsFrame(data);
  if (!decoded) {
    console.warn("[tts] trame binaire illisible ignorée");
    return;
  }
  // E2 — DÉFENSE EN PROFONDEUR : on ne lit QUE l'audio du fil FOCALISÉ. Le
  // serveur ne synthétise déjà que la session focalisée (garde `routeTtsEvent`)
  // et ne livre l'audio qu'aux clients ABONNÉS ; si une trame d'un fil de fond
  // arrivait malgré tout, elle est JETÉE (jamais de double voix).
  if (decoded.header.sessionId && decoded.header.sessionId !== sessionId) return;
  // Seules les trames AUDIO comptent comme « du son a été émis » : les trames de
  // contrôle (`tts_end`/`tts_cancel`) sont émises même sans contenu. Compter ces
  // dernières comme de l'activité masquerait un vrai « aucun son ».
  if (decoded.header.type === "tts_audio") {
    ttsActivityRun = decoded.header.runId ?? ttsActivityRun;
  }
  // Sourdine locale ou serveur off : la trame est jetée (pas de lecture).
  if (!ttsAudible()) return;
  ttsPlayer.handleFrame(decoded);
}

/** Suit les étages TTS pour détecter un moteur absent (requête sans octet). */
function onTtsPhase(frame) {
  if (typeof frame.runId !== "string") return;
  if (frame.stage === "tts_requested") ttsRequestedRun = frame.runId;
  else if (frame.stage === "tts_first_byte" || frame.stage === "tts_segment_done") {
    ttsActivityRun = frame.runId;
  }
}

function sendMessage() {
  const text = els.input.value.trim();
  if (text.length === 0) return;
  // Aucune conversation ouverte (état vide) : on n'envoie RIEN dans le vide.
  if (!sessionId) return;
  // Nouveau message = barge-in local : la voix en cours s'arrête net.
  ttsPlayer.stopAll();
  // Geste utilisateur : débloque l'AudioContext pour la lecture à venir.
  if (ttsAudible()) void ttsPlayer.unlock();
  const clientMsgId = `m${++clientMsgCounter}`;
  const sentAt = Date.now();
  clearEmpty();
  // ⚠️ MESSAGE ENVOYÉ PENDANT UNE SORTIE EN COURS (steer) : le message assistant
  // EN COURS garde SON bloc. On n'ouvre PAS un nouveau bloc (ni ne réinitialise
  // `currentAssistant`/`currentRenderer`) : le flux continue d'être rendu dans
  // l'unique bloc déjà affiché, ce qui garde le markdown cohérent (une fence de
  // code ouverte reste rendue comme du code) et évite qu'une ligne soit coupée
  // au milieu. La bulle utilisateur est insérée JUSTE AVANT ce bloc, à sa place
  // chronologique (le message a été envoyé avant la fin de la réponse).
  const streamingAssistant = currentAssistant;
  appendMessage("user", text, undefined, sentAt, streamingAssistant);
  // L'utilisateur vient d'AGIR : on va en bas et on ré-épingle EXPLICITEMENT,
  // indépendamment du seuil (un message LONG fait grandir la zone de saisie et
  // gonfle la distance au fond sans que l'utilisateur ait remonté).
  pinAfterUserSend();
  if (!streamingAssistant) {
    currentAssistant = null;
    currentRenderer = null;
  }
  els.input.value = "";
  els.input.style.height = "auto";
  // Le fuseau du navigateur part avec le message : le préfixe STOCKÉ est ainsi
  // daté dans l'heure locale de l'utilisateur (le conteneur peut être en UTC).
  if (
    !sendRaw({
      type: "message",
      clientMsgId,
      text,
      ...(CLIENT_TIME_ZONE ? { tz: CLIENT_TIME_ZONE } : {}),
    })
  ) {
    appendMessage("assistant error", "Non connecté au gateway.", undefined, Date.now());
    return;
  }
  // Attente LOCALE dès l'envoi : elle couvre le court intervalle avant
  // `run_started` (le serveur peut mettre un instant à accepter le run).
  showThinking();
}

function abort() {
  // Stop = arrêt IMMÉDIAT de la lecture locale + purge du buffer, cohérent
  // avec le barge-in serveur (l'abort purge aussi la file TTS côté serveur).
  ttsPlayer.stopAll();
  sendRaw({ type: "abort" });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(
    MAX_RECONNECT_DELAY_MS,
    500 * 2 ** reconnectAttempts,
  );
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${proto}//${location.host}/ws`);
  // L'audio arrive en trames BINAIRES : on les reçoit en `ArrayBuffer`.
  socket.binaryType = "arraybuffer";

  socket.addEventListener("open", () => {
    reconnectAttempts = 0;
    setConnection(true);
    if (sessionId && lastSeq > 0) {
      // Reconnexion : on redemande le rejeu STRICTEMENT depuis le dernier `seq`
      // appliqué (le serveur rejoue `seq > fromSeq`, ou renvoie un snapshot).
      resumePending = true;
      if (!sendRaw({ type: "resume", sessionId, fromSeq: lastSeq })) {
        resumePending = false;
      }
    } else {
      // Première connexion : `hello` renvoie l'état autoritatif (snapshot).
      resumePending = false;
      sendRaw({
        type: "hello",
        clientVersion: CLIENT_VERSION,
        ...(sessionId ? { sessionId } : {}),
      });
    }
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      handleBinaryFrame(event.data); // trame binaire `YTA1` (audio)
      return;
    }
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    handleFrame(frame);
  });

  socket.addEventListener("close", () => {
    setConnection(false);
    resumePending = false;
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  });
}

els.send.addEventListener("click", sendMessage);
els.stop.addEventListener("click", abort);
if (els.emptyNew) {
  els.emptyNew.addEventListener("click", () => {
    sendRaw({ type: "new" });
  });
}
if (els.ttsToggle) els.ttsToggle.addEventListener("click", onTtsToggleClick);
els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
});

setConnection(false);
setSessionState("idle");
refreshTtsToggle();
void loadTtsServerState();
connect();
