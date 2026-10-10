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
import { initSessionsPanel } from "./sessions-panel.js";
import { initSidebarAgents } from "./sidebar-agents.js";
import { createApprovalBlocks } from "./approval-block.js";
import { createScreenshotBlocks } from "./screenshot-block.js";

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
  queued: document.getElementById("queued"),
  pendingValidation: document.getElementById("pending-validation"),
  thinking: document.getElementById("thinking"),
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

/* ─── Validation humaine DANS la conversation (D118) ─────────────────────
 * État TEMPORAIRE de l'interface (jamais un message) : un bloc apparaît dans le
 * fil OÙ la commande a été demandée, on valide / refuse sur place, il disparaît
 * une fois décidé ou expiré. Il n'entre JAMAIS dans l'historique : le serveur ne
 * l'envoie que par trames de contrôle (jamais dans le transcript ni le rejeu).
 * La décision part par le WebSocket (trame `approval_decision`). */
const approvalBlocks = createApprovalBlocks({
  container: els.conversation,
  // ⚠️ Défilement au MÊME mécanisme que l'auto-scroll des messages : on ne
  // colle en bas que si l'utilisateur y était DÉJÀ (mesuré avant insertion).
  isPinned: isConversationPinned,
  scrollToEnd: () => pinIfNeeded(true),
  // Sinon, un indicateur visible signale la demande sans déplacer la vue.
  onAttention: (active) => setPendingValidation(active),
  onDecide: (id, decision) => {
    if (sendRaw({ type: "approval_decision", id, decision })) return;
    approvalBlocks.resetBusy();
    void HolafModal.alert(
      "Hors ligne",
      "Impossible d'envoyer votre décision : la connexion au gateway est perdue. " +
        "Réessayez une fois reconnecté.",
      { okText: "Compris" },
    );
  },
});

/* ─── Indicateur « une validation est en attente » ──────────────────────
 * Affiché SEULEMENT quand une demande de validation arrive alors que
 * l'utilisateur a remonté le fil : on ne le déplace pas de force (ce serait
 * désagréable pendant une lecture), mais il ne peut pas rater la demande — le
 * bouton ramène la vue sur le bloc. */
function setPendingValidation(active) {
  if (els.pendingValidation) els.pendingValidation.hidden = !active;
}

if (els.pendingValidation) {
  els.pendingValidation.addEventListener("click", () => approvalBlocks.reveal());
}
// Revenu près du bas : l'indicateur n'a plus lieu d'être.
els.conversation.addEventListener("scroll", () => {
  if (isConversationPinned()) approvalBlocks.acknowledge();
});

/* ─── Capture d'écran DANS la conversation ────────────────────────────────
 * État TEMPORAIRE de l'interface (jamais un message, jamais dans l'historique) :
 * le serveur ne l'envoie QUE par trame de contrôle `screenshot`, jamais dans le
 * transcript ni le rejeu. L'image n'est affichée qu'ICI (à l'humain) : le modèle
 * ne la reçoit jamais. */
const screenshotBlocks = createScreenshotBlocks({ container: els.conversation });

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
  } else if (state === "error") {
    els.sessionState.textContent = "erreur";
    els.stop.disabled = true;
    els.thinking.hidden = true;
  } else {
    els.sessionState.textContent = "idle";
    els.stop.disabled = true;
    els.thinking.hidden = true;
  }
}

function clearEmpty() {
  const empty = els.conversation.querySelector(".empty");
  if (empty) empty.remove();
}

/* ─── Défilement ─────────────────────────────────────────────────────────
 * On ne colle en bas QUE si l'utilisateur y était DÉJÀ avant la mutation.
 * Sinon, remonter dans l'historique devient impossible : chaque delta le
 * ramènerait de force en bas. Le seuil tolère un léger décalage (arrondis).
 */
const SCROLL_PIN_THRESHOLD_PX = 24;

function isConversationPinned() {
  const el = els.conversation;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_PIN_THRESHOLD_PX;
}

function pinIfNeeded(pinned) {
  if (pinned) els.conversation.scrollTop = els.conversation.scrollHeight;
}

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

/** Séparateur de jour : deux demi-traits (`::before`/`::after`) autour du libellé. */
function appendDaySeparator(label) {
  const separator = document.createElement("div");
  separator.className = "daysep";
  separator.setAttribute("role", "separator");
  separator.setAttribute("aria-label", label);
  const span = document.createElement("span");
  span.className = "daysep__label";
  span.textContent = label;
  separator.appendChild(span);
  els.conversation.appendChild(separator);
  return separator;
}

/** Insère un séparateur SI le jour change (le premier jour du fil est conservé). */
function ensureDaySeparator(ts) {
  const key = dayKeyOf(ts);
  if (key === null || key === lastDayKey) return;
  lastDayKey = key;
  appendDaySeparator(dayFormatter.format(new Date(ts)));
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

function appendMessage(role, text, pinned = isConversationPinned(), ts = null) {
  clearEmpty();
  ensureDaySeparator(ts);
  const div = document.createElement("div");
  div.className = `message message--${role}`;
  div.appendChild(createMessageBody(text));
  els.conversation.appendChild(div);
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
  approvalBlocks.reset();
  screenshotBlocks.reset();
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
    if (entry.role === "user") appendMessage("user", entry.text ?? "", pinned, ts);
    else appendAssistantMessage(entry.text ?? "", pinned, ts);
  }
  currentRenderer = null;
  pinIfNeeded(pinned);
}

/**
 * Infos TECHNIQUES du message assistant (ligne « TTFT … · total … · N tok »),
 * EN BAS À DROITE (`.message__footer`). Le pied est créé À LA DEMANDE : un
 * message SANS statistiques n'a AUCUN pied (pas de ligne fantôme, pas de saut
 * de mise en page). Un texte vide est ignoré (rien à montrer).
 */
function setMeta(element, text) {
  if (!element || !text) return;
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
  stats.textContent = text;
}

function sendRaw(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
}

function handleFrame(frame) {
  if (!frame || typeof frame !== "object") return;
  const type = frame.type;

  if (type === "welcome") {
    if (frame.sessionId) sessionId = frame.sessionId;
    // Un `welcome { resumed: true }` acquitte notre `resume` : le rejeu (ou le
    // snapshot) suit, on autorise une nouvelle demande si un trou apparaissait.
    if (frame.resumed) resumePending = false;
    // Reconnexion : on purge les blocs de validation AVANT que le serveur ne
    // ré-émette les demandes ENCORE en attente. Un bloc décidé PENDANT la
    // coupure ne doit PAS rester affiché (état vivant, pas d'historique).
    approvalBlocks.reset();
    screenshotBlocks.reset();
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
        frame.message || "Une erreur est survenue.",
        { okText: "Compris" },
      );
      return;
    }
    // Validation tardive (déjà décidée ou expirée) : message HONNÊTE, jamais un
    // succès trompeur. Le bloc correspondant a été retiré par `approval_cleared`.
    if (frame.code === "approval_not_found" || frame.code === "approval_unavailable") {
      approvalBlocks.resetBusy();
      void HolafModal.alert(
        "Validation impossible",
        frame.message || "Cette demande de validation n'existe plus.",
        { okText: "Compris" },
      );
      return;
    }
    // Autre échec (réseau, erreur serveur) : on réactive les boutons du bloc.
    approvalBlocks.resetBusy();
    appendMessage("assistant error", frame.message || "erreur", undefined, Date.now());
    return;
  }
  if (type === "sessions") {
    const activeId = typeof frame.activeId === "string" ? frame.activeId : null;
    sessionsPanel.update(frame.sessions, activeId);
    sessionId = activeId;
    setEmptyState(activeId === null);
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
    approvalBlocks.show(frame.approval);
    return;
  }
  if (type === "approval_cleared") {
    approvalBlocks.clear(String(frame.id));
    return;
  }
  if (type === "approval_result") {
    approvalBlocks.showResult(frame.result);
    return;
  }
  // Capture d'écran : ÉTAT TEMPORAIRE, trame de CONTRÔLE (aucun `seq` consommé).
  // Traitée AVANT la logique de curseur `seq`, sinon elle serait prise pour un
  // doublon. Jamais rejouée, jamais conservée, jamais envoyée au modèle.
  if (type === "screenshot") {
    screenshotBlocks.show(frame.screenshot);
    return;
  }

  // Événements de session : application stricte par curseur `seq`.
  if (typeof frame.seq === "number" && frame.seq > 0) {
    if (frame.seq <= lastSeq) return; // doublon
    if (frame.seq !== lastSeq + 1) {
      requestResume();
      return;
    }
    lastSeq = frame.seq;
  }
  if (frame.sessionId) sessionId = frame.sessionId;
  applyEvent(frame);
}

function applySnapshot(frame) {
  if (frame.sessionId) sessionId = frame.sessionId;
  lastSeq = typeof frame.seq === "number" ? frame.seq : 0;
  resumePending = false;
  currentAssistant = null;
  currentRenderer = null;
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
      }
      return;
    case "run_started":
      els.queued.hidden = true;
      els.thinking.hidden = true;
      currentAssistant = appendAssistantMessage(null, undefined, Date.now());
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
        els.thinking.hidden = false;
        return;
      }
      {
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
      if (frame.stage === "first_token") els.thinking.hidden = true;
      if (typeof frame.stage === "string" && frame.stage.startsWith("tts_")) {
        onTtsPhase(frame);
      } else if (frame.stage === "sentence_segmented") {
        onTtsPhase(frame);
      }
      return;
    case "run_finished": {
      els.thinking.hidden = true;
      els.queued.hidden = true;
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
            currentRenderer.setText(frame.errorMessage || "Une erreur est survenue.");
          }
        }
        pinIfNeeded(pinned);
      } else if (frame.reason === "error") {
        appendMessage("assistant error", frame.errorMessage || "Une erreur est survenue.", undefined, Date.now());
      }
      currentAssistant = null;
      currentRenderer = null;
      return;
    }
    case "run_summary": {
      const target = els.conversation.lastElementChild;
      if (target && target.classList.contains("message--assistant")) {
        const parts = [];
        if (typeof frame.ttftMs === "number") parts.push(`TTFT ${Math.round(frame.ttftMs)} ms`);
        parts.push(`total ${Math.round(frame.totalMs)} ms`);
        if (typeof frame.tokensOut === "number") parts.push(`${frame.tokensOut} tok`);
        setMeta(target, parts.join(" · "));
      }
      return;
    }
    case "job_started":
    case "job_finished":
    case "job_report":
      // Cycle de vie des jobs d'arrière-plan : informatif. Le rendu se fait via
      // le tour de report du léger (`run_started` origin="job_report").
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
  appendMessage("user", text, undefined, sentAt);
  currentAssistant = null;
  currentRenderer = null;
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
  }
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
