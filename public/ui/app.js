// Yuki — UI minimale (vanilla, sans build).
//
// Reçoit les événements du gateway via WebSocket, applique strictement le
// curseur `seq` (ni trou ni doublon) et réinitialise son rendu à partir d'un
// `snapshot` lorsque la fenêtre de rejeu est dépassée ou à la reconnexion.

import { initTheme } from "./theme.js";
import { decodeTtsFrame } from "./tts-frames.js";
import { createTtsPlayer } from "./tts-player.js";
import { createTtsPreference, resolveSpeechState } from "./tts-preference.js";

// Thème (dropdown + bascule) : applique le choix persisté ou le réglage
// système, et câble les contrôles de la topbar.
initTheme();

const CLIENT_VERSION = "1";
const MAX_RECONNECT_DELAY_MS = 8000;

const els = {
  conversation: document.getElementById("conversation"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  stop: document.getElementById("stop"),
  connection: document.getElementById("connection"),
  sessionState: document.getElementById("session-state"),
  queued: document.getElementById("queued"),
  thinking: document.getElementById("thinking"),
  ttsToggle: document.getElementById("tts-toggle"),
  ttsStatus: document.getElementById("tts-status"),
};

let socket = null;
let lastSeq = 0;
let sessionId = null;
let currentAssistant = null;
let resumePending = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let clientMsgCounter = 0;

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

function appendMessage(role, text) {
  clearEmpty();
  const div = document.createElement("div");
  div.className = `message message--${role}`;
  div.textContent = text ?? "";
  els.conversation.appendChild(div);
  els.conversation.scrollTop = els.conversation.scrollHeight;
  return div;
}

function applyTranscript(transcript) {
  els.conversation.innerHTML = "";
  if (!Array.isArray(transcript) || transcript.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Envoyez un message pour commencer.";
    els.conversation.appendChild(p);
    return;
  }
  for (const entry of transcript) {
    const role = entry.role === "user" ? "user" : "assistant";
    appendMessage(role, entry.text ?? "");
  }
  els.conversation.scrollTop = els.conversation.scrollHeight;
}

function setMeta(element, text) {
  if (!element) return;
  let meta = element.querySelector(".message__meta");
  if (!meta) {
    meta = document.createElement("span");
    meta.className = "message__meta";
    element.appendChild(meta);
  }
  meta.textContent = text;
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
    return;
  }
  if (type === "pong" || type === "bye") return;
  if (type === "error") {
    appendMessage("assistant error", frame.message || "erreur");
    return;
  }
  if (type === "snapshot") {
    applySnapshot(frame);
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
      if (frame.state === "idle" || frame.state === "error") currentAssistant = null;
      return;
    case "run_started":
      els.queued.hidden = true;
      els.thinking.hidden = true;
      currentAssistant = appendMessage("assistant", "");
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
      if (!currentAssistant) currentAssistant = appendMessage("assistant", "");
      currentAssistant.textContent += frame.text ?? "";
      els.conversation.scrollTop = els.conversation.scrollHeight;
      return;
    case "phase":
      if (frame.stage === "first_token") els.thinking.hidden = true;
      if (typeof frame.stage === "string" && frame.stage.startsWith("tts_")) {
        onTtsPhase(frame);
      } else if (frame.stage === "sentence_segmented") {
        onTtsPhase(frame);
      }
      return;
    case "run_finished":
      els.thinking.hidden = true;
      els.queued.hidden = true;
      if (
        ttsAudible() &&
        typeof frame.runId === "string" &&
        frame.runId === ttsRequestedRun &&
        frame.runId !== ttsActivityRun
      ) {
        // Une requête TTS a été émise mais AUCUN octet n'est revenu : moteur
        // probablement indisponible. On le signale sans le taire.
        setTtsStatus(
          "Aucun son reçu alors que la voix est active : le moteur TTS semble indisponible.",
          9000,
        );
      }
      if (currentAssistant) {
        if (frame.reason === "abort" && currentAssistant.textContent.length === 0) {
          currentAssistant.textContent = "(interrompu)";
        }
        if (frame.reason === "error") {
          currentAssistant.classList.add("message--error");
          currentAssistant.textContent =
            frame.errorMessage || "Une erreur est survenue.";
        }
      } else if (frame.reason === "error") {
        appendMessage("assistant error", frame.errorMessage || "Une erreur est survenue.");
      }
      currentAssistant = null;
      return;
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
  ttsActivityRun = decoded.header.runId ?? ttsActivityRun;
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
  // Nouveau message = barge-in local : la voix en cours s'arrête net.
  ttsPlayer.stopAll();
  // Geste utilisateur : débloque l'AudioContext pour la lecture à venir.
  if (ttsAudible()) void ttsPlayer.unlock();
  const clientMsgId = `m${++clientMsgCounter}`;
  clearEmpty();
  appendMessage("user", text);
  currentAssistant = null;
  els.input.value = "";
  els.input.style.height = "auto";
  if (!sendRaw({ type: "message", clientMsgId, text })) {
    appendMessage("assistant error", "Non connecté au gateway.");
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
