// Yuki — UI minimale (vanilla, sans build).
//
// Reçoit les événements du gateway via WebSocket, applique strictement le
// curseur `seq` (ni trou ni doublon) et réinitialise son rendu à partir d'un
// `snapshot` lorsque la fenêtre de rejeu est dépassée ou à la reconnexion.

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
};

let socket = null;
let lastSeq = 0;
let sessionId = null;
let currentAssistant = null;
let resumePending = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let clientMsgCounter = 0;

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
      return;
    case "run_finished":
      els.thinking.hidden = true;
      els.queued.hidden = true;
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

function sendMessage() {
  const text = els.input.value.trim();
  if (text.length === 0) return;
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
    if (typeof event.data !== "string") return; // trames binaires ignorées
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
connect();
