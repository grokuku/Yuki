// Yuki — UI minimale (vanilla, sans build).
//
// Reçoit les événements du gateway via WebSocket, applique strictement le
// curseur `seq` (ni trou ni doublon) et réinitialise son rendu à partir d'un
// `snapshot` lorsque la fenêtre de rejeu est dépassée ou à la reconnexion.

import { getTheme, initTheme, setTheme } from "./theme.js";
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
import { initSidebarAgents, agentLabel } from "./sidebar-agents.js";
import { unlockAgentWithPassword } from "./password-modal.js";
import { createApprovalLayer } from "./approval-window.js";
import { createScrollToBottom } from "./scroll-button.js";
import { createRecapDedicated } from "./recap-dedicated.js";
import { createSessionActions } from "./session-actions.js";
import { createReactionControl } from "./reactions.js";
import { iconNode } from "./icons.js";
import { MOBILE_MEDIA_QUERY, initMobileNav } from "./mobile-nav.js";
import { createScreenshotBlocks, formatBytes } from "./screenshot-block.js";
import { createAckBlocks } from "./ack-block.js";
import { createImageBlocks } from "./image-block.js";
import { createImageLightbox } from "./lightbox.js";
import {
  createFileBlocks,
  createFileCard,
  formatFileMarker,
  parseMessageFiles,
} from "./file-block.js";
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
  attach: document.getElementById("attach"),
  fileInput: document.getElementById("file-input"),
  pendingFiles: document.getElementById("pending-files"),
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

/**
 * RÉINSTALLE l'activité de fond d'un fil depuis la liste AUTORITAIRE du serveur
 * (snapshot `jobs`, lue dans le `JobStore`).
 *
 * ⚠️ SOURCE DE VÉRITÉ = LE SERVEUR, jamais un état local : la liste ne contient
 * que les jobs ENCORE ouverts ⇒ un job terminé pendant que l'on regardait un
 * autre fil n'est PAS ressuscité (aucun faux « en cours »). Les étapes
 * intermédiaires manquées (`job_activity`) ne sont pas rejouables : elles sont
 * éphémères par construction.
 *
 * @param {Array<{ jobId?: string, task?: string, status?: string, startedAt?: string }>} entries
 */
function restoreJobActivity(entries) {
  // Le conteneur est PARTAGÉ entre conversations : on repart d'un état propre.
  resetJobActivity();
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const id = typeof entry.jobId === "string" && entry.jobId.length > 0 ? entry.jobId : "";
    if (!id) continue;
    // `queued` compte comme « en cours » : la tâche n'est PAS terminée. Un statut
    // terminal n'arrive jamais ici (filtré côté serveur).
    const startedAt = typeof entry.startedAt === "string" ? Date.parse(entry.startedAt) : NaN;
    jobs.set(id, {
      id,
      task: typeof entry.task === "string" ? entry.task : undefined,
      status: "running",
      // Repli honnête : sans date serveur, aucun compteur de durée n'est affiché
      // (`describeActivity` rend un compteur vide pour un instant non fini).
      startedAt: Number.isFinite(startedAt) ? startedAt : NaN,
    });
  }
  renderJobActivity();
  syncJobsTick();
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
/** Dernier état des agents reçu (trame `agents`), par identifiant. */
let agentsById = new Map();

const sidebarAgents = initSidebarAgents({
  // Menu TÉLÉPHONE « Agents » : même état, même menu de niveau (appui long).
  extraTargets: [
    {
      list: document.getElementById("mnav-agent-list"),
      empty: document.getElementById("mnav-agent-empty"),
    },
  ],
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
  // DÉVERROUILLAGE d'un agent « matériel sensible » : action HUMAINE (saisie du
  // mot de passe d'instance). ⚠️ Le modèle ne peut pas la déclencher : il n'a
  // aucun outil pour ça, et le mot de passe ne quitte jamais navigateur → serveur.
  onUnlock: (agentId) => {
    const agent = agentsById.get(agentId);
    void (async () => {
      const result = await unlockAgentWithPassword({
        HolafModal,
        agentId,
        agentLabel: agent ? agentLabel(agent) : agentId,
      });
      if (result.cancelled) return;
      if (!result.ok) {
        await HolafModal.alert("Déverrouillage refusé", result.message, { okText: "Compris" });
        return;
      }
      await HolafModal.alert(
        "Agent déverrouillé",
        "L'agent est déverrouillé : il se reverrouillera tout seul après 15 min " +
          "sans activité (une commande réellement transmise remet le compte à zéro).",
        { okText: "Compris" },
      );
    })();
  },
});

/** Conversation à OUVRIR avant de déclencher « conversation dédiée » (menu). */
let pendingRecapId = null;
let recapSwitchTimer = null;
/** Délai (ms) au-delà duquel une bascule non confirmée est abandonnée. */
const RECAP_SWITCH_TIMEOUT_MS = 4000;

const sessionsPanel = initSessionsPanel({
  root: document.getElementById("sessions-sidebar"),
  HolafModal,
  footer: sidebarAgents.element,
  // Menu TÉLÉPHONE « Conversations » : MÊME rendu, mêmes indicateurs (non lu,
  // en cours, actif, épinglées), même menu du titre (appui long).
  extraLists: [
    {
      list: document.getElementById("mnav-conv-list"),
      empty: document.getElementById("mnav-conv-empty"),
    },
  ],
  onSwitch: (id) => {
    mobileNav.close();
    if (id !== sessionId) sendRaw({ type: "switch", sessionId: id });
  },
  onNew: () => {
    mobileNav.close();
    sendRaw({ type: "new" });
  },
  onRename: (id, title) => {
    mobileNav.close();
    sendRaw({ type: "rename", sessionId: id, title });
  },
  onSetAside: (id) => {
    mobileNav.close();
    sendRaw({ type: "setAside", sessionId: id });
  },
  // SUPPRESSION DÉFINITIVE (confirmation déjà donnée par le panneau, qui NOMME
  // la conversation). Le serveur efface le fil ; la mémoire n'est pas touchée.
  onDelete: (id) => {
    mobileNav.close();
    sendRaw({ type: "delete", sessionId: id });
  },
  // « Compacter… » : attente visible + compte rendu honnête (`session-actions.js`).
  onCompact: (id) => {
    mobileNav.close();
    if (sessionActions) sessionActions.request(id);
  },
  onPin: (id, pinned) => {
    sendRaw({ type: "pin", sessionId: id, pinned });
  },
  // Entrée « Conversation dédiée… » du MENU DU TITRE (téléphone ET bureau).
  // Le parcours n'est pas réécrit : on ouvre celui de `recap-dedicated.js`.
  // Sur une AUTRE conversation, on l'ouvre d'abord : le parcours repart quand
  // le serveur a confirmé la bascule (`pendingRecapId`, voir `sessions`).
  onRecapDedicated: (id) => {
    mobileNav.close();
    if (typeof id === "string" && id !== sessionId) {
      if (sendRaw({ type: "switch", sessionId: id })) {
        pendingRecapId = id;
        if (recapSwitchTimer) clearTimeout(recapSwitchTimer);
        // Filet de sécurité : si la bascule n'aboutit pas (conversation
        // disparue), on n'ouvre RIEN et on ne laisse pas d'état fantôme.
        recapSwitchTimer = setTimeout(() => {
          pendingRecapId = null;
          recapSwitchTimer = null;
        }, RECAP_SWITCH_TIMEOUT_MS);
        return;
      }
    }
    if (recapDedicated) recapDedicated.open();
  },
});

/* ─── Navigation TÉLÉPHONE (trois menus déroulants) ───────────────────────
 * Masquée en bureau par CSS : la barre latérale y reste entière. Sur téléphone,
 * elle remplace la barre latérale (absente) et donne accès à TOUT ce qu'elle
 * montrait : conversations (avec aperçu, non lus, en cours, actives, épinglées),
 * agents (connexion, niveau, dernière activité) et configuration.
 */
const mobileNav = initMobileNav({
  root: document.getElementById("mobile-nav"),
  layer: document.getElementById("mobile-nav-layer"),
  onNew: () => {
    sendRaw({ type: "new" });
  },
  getThemeSummary: () => {
    const select = document.getElementById("theme-family");
    const family = select?.selectedOptions?.[0]?.textContent?.trim() || "Neutre";
    const mode = String(getTheme()).endsWith("-light") ? "clair" : "sombre";
    return `${family} · ${mode}`;
  },
  // Bascule clair/sombre en CONSERVANT la famille (même moteur que la topbar).
  onToggleTheme: () => {
    const [family, mode] = String(getTheme()).split("-");
    setTheme(`${family}-${mode === "dark" ? "light" : "dark"}`);
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
/* ─── VISIONNEUSE D'IMAGE (vignette cliquable + plein écran) ───────────────
 * ⚠️ UNE SEULE visionneuse, PARTAGÉE par les deux familles d'images du fil
 * (générées `/images/…` et captures `/captures/…`) : une image = une vignette
 * bornée (320 px bureau, 220 px téléphone) qui s'ouvre en PLEIN ÉCRAN au clic.
 *
 * ⚠️ C'est une SURCOUCHE FIXE posée sur `document.body` : elle ne touche NI au
 * fil, NI au `scrollTop`, NI à l'état STICKY (`conversationPinned`), NI au bouton
 * « revenir en bas » (PIÈGE ①). La navigation entre images se fait sur la LISTE
 * des vignettes présentes dans `#conversation`, dans l'ordre du DOM. */
const imageLightbox = createImageLightbox({ root: els.conversation });

const screenshotBlocks = createScreenshotBlocks({
  container: els.conversation,
  zoom: imageLightbox,
});

/* ─── IMAGES GÉNÉRÉES dans la conversation ─────────────────────────────────
 * CONSERVÉES (même réglage que les pièces jointes) : la carte revient après un
 * RECHARGEMENT, le serveur la ré-envoyant en trame de CONTRÔLE `image` juste après
 * le snapshot. La source est un chemin SAME-ORIGIN (`/images/<id>.<ext>`) :
 * aucune CSP à élargir. ⚠️ Contrairement aux captures d'agents, l'image a AUSSI
 * été transmise à Yuki, qui l'a donc vue et peut la juger.
 * ⚠️ La FICHE (prompt final) peut arriver APRÈS l'image : elle est alors insérée
 * SOUS l'image, jamais au-dessus (l'image ne bouge pas).
 * ⚠️ MÊME vignette cliquable et MÊME visionneuse que les captures d'écran. */
const imageBlocks = createImageBlocks({ container: els.conversation, zoom: imageLightbox });

/* ─── ACCUSÉS DE RÉCEPTION dans la conversation ────────────────────────────
 * Trame de CONTRÔLE éphémère `ack` (aucun `seq` consommé, jamais bufferisée,
 * JAMAIS prononcée) : une ligne courte (« Je m'en occupe. ») au moment où une
 * ACTION démarre (délégation, génération d'image, commande). Jamais pour une
 * question simple : c'est le SERVEUR qui décide, sur un test booléen (une action
 * a-t-elle été lancée ?), sans aucun calcul ni appel modèle supplémentaire. */
const ackBlocks = createAckBlocks({ container: els.conversation });

/* ─── FICHIERS dans la conversation (envoi ET réception) ───────────────────
 * Deux sources DISTINCTES :
 *  - les fichiers joints par l'UTILISATEUR portent leur marqueur DANS le
 *    message : leur carte est rendue avec la bulle et revient au rechargement ;
 *  - les fichiers envoyés par YUKI arrivent par trame de CONTRÔLE `file_sent`
 *    (éphémère, jamais bufferisée) : carte affichée immédiatement, retirée quand
 *    le fil est reconstruit (`reset`). */
const fileBlocks = createFileBlocks({ container: els.conversation });

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

/* ─── RÉACTIONS aux messages de Yuki ───────────────────────────────────────
 * Un message assistant porte un petit bouton en bas à droite (au survol sur
 * bureau, toujours visible au toucher) qui déploie UN menu à quatre sections
 * titrées : jugement technique / émotion / humeur / gratitude, chaque entrée avec
 * son libellé ET son explication.
 *
 * ⚠️ Une réaction N'EST PAS un message : le serveur la persiste À PART, la
 * rediffuse ici (trame de CONTRÔLE, état vivant) et l'injecte au modèle au tour
 * SUIVANT — aucun tour n'est déclenché, rien n'est prononcé, rien n'entre dans la
 * mémoire (sauf régularité, côté serveur). */
const reactionControl = createReactionControl({
  onChange: (entryId, reaction) => {
    if (!entryId || !sessionId) return;
    // `sessionId` est celui de la conversation AFFICHÉE : la réaction est
    // rattachée à la conversation ET au message (`entryId`), jamais au hasard.
    sendRaw({ type: "reaction", sessionId, entryId, reaction });
  },
});

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
let recapDedicated = null;
/** Actions longues du menu du titre (« Compacter… ») — voir `session-actions.js`. */
let sessionActions = null;
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

/* ─── « Continuer dans une conversation dédiée » ────────────────────────
 * Depuis la conversation ouverte, l'utilisateur donne un SUJET ; le serveur
 * produit un RÉCAPITULATIF EXHAUSTIF (aperçu relisible/corrigeable) puis crée
 * une NOUVELLE conversation dédiée. Le fil d'origine n'est jamais modifié.
 * Le module ne fait QUE présenter et envoyer : toute la logique vit côté
 * serveur (un seul système de conversations, réutilisé).
 *
 * ⚠️ Plus de bouton dans le composeur : le déclencheur est l'entrée
 * « Conversation dédiée… » du MENU DU TITRE (téléphone ET bureau), câblée plus
 * haut via `onRecapDedicated` → `recapDedicated.open()`. */
recapDedicated = createRecapDedicated({
  send: sendRaw,
  getSessionId: () => sessionId,
  modal: HolafModal,
});

/* ─── « Compacter… » — COMPACTION FORCÉE ──────────────────────────────────
 * Le serveur lance D'ABORD une passe de mémoire sur la conversation entière,
 * PUIS compacte le fil (méthode de compaction du moteur, déclenchée a la
 * demande). L'attente est VISIBLE (même écran `HolafModal.busy` que le
 * récapitulatif) et le compte rendu vient du serveur : aucune invention ici. */
sessionActions = createSessionActions({ send: sendRaw, modal: HolafModal });

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
  // ⚠️ Les fichiers joints portent leur MARQUEUR dans le texte du message : on
  // les détache ici pour afficher une CARTE cliquable à la place de la ligne
  // technique. Un message sans marqueur est rendu tel quel (aucun changement).
  const parsed = parseMessageFiles(text ?? "");
  body.textContent = parsed.text;
  if (parsed.files.length === 0) return body;
  const files = document.createElement("div");
  files.className = "message__files";
  for (const file of parsed.files) {
    // Vue COMPLÈTE si la page la connaît (envoi à l'instant), sinon le marqueur
    // suffit : le chemin et l'aperçu se déduisent du nom.
    files.appendChild(createFileCard(knownFiles.get(file.id) ?? file, { from: "user" }));
  }
  body.appendChild(files);
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

/**
 * Bloc de RÉCAPITULATIF GÉNÉRÉ (point de départ d'une conversation dédiée).
 *
 * ⚠️ Ce n'est NI un message de l'utilisateur NI un message de Yuki : c'est une
 * DONNÉE générée, rendue dans un bloc distinct (`message--recap`) avec un
 * libellé explicite, le SUJET visé et la conversation d'origine. Le corps est
 * rendu en markdown comme une réponse (donc relisible), sans jamais être lu par
 * la synthèse vocale (c'est un message de rôle `user` côté modèle).
 */
function appendRecapBlock(entry, pinned = isConversationPinned(), ts = null) {
  clearEmpty();
  ensureDaySeparator(ts);
  const div = document.createElement("div");
  div.className = "message message--recap";
  const head = document.createElement("div");
  head.className = "message__head";
  const label = document.createElement("span");
  label.className = "recap-block__label";
  label.textContent = "Récapitulatif généré — point de départ";
  head.appendChild(label);
  div.appendChild(head);
  const metaParts = [];
  if (typeof entry.subject === "string" && entry.subject.length > 0) {
    metaParts.push(`Sujet : ${entry.subject}`);
  }
  if (typeof entry.origin === "string" && entry.origin.length > 0) {
    metaParts.push(`Depuis « ${entry.origin} »`);
  }
  if (metaParts.length > 0) {
    const meta = document.createElement("p");
    meta.className = "recap-block__meta";
    meta.textContent = metaParts.join(" · ");
    div.appendChild(meta);
  }
  const renderer = createMarkdownRenderer();
  renderer.element.classList.add("recap-block__body");
  if (typeof entry.text === "string" && entry.text.length > 0) {
    renderer.setText(entry.text);
  }
  div.appendChild(renderer.element);
  els.conversation.appendChild(div);
  setMessageTime(div, ts, false);
  pinIfNeeded(pinned);
  return div;
}

function applyTranscript(transcript) {
  const pinned = isConversationPinned();
  // Le fil est reconstruit : on purge les blocs ÉPHÉMÈRES (validation, captures,
  // réflexion, réactions). Le serveur les ré-affichera s'ils vivent encore.
  approvalLayer.reset();
  screenshotBlocks.reset();
  imageBlocks.reset();
  ackBlocks.reset();
  fileBlocks.reset();
  subagentActivity.reset();
  thinkingBlocks.reset();
  reactionControl.reset();
  // Toute statistique EN DIRECT devient obsolète : on arrête le minuteur et on
  // oublie l'alignement t0 (les valeurs FINALES reviennent par `run_summary`).
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
    } else if (entry.role === "recap") {
      appendRecapBlock(entry, pinned, ts);
    } else {
      // Statistiques PERSISTÉES : elles rétablissent le pied technique après un
      // rechargement. Absentes (ancienne session) ⇒ aucun pied, aucune ligne.
      // ⚠️ JAMAIS DE BULLE VIDE : une entrée sans contenu ET sans accusé n'est
      // pas rendue du tout (aucune bulle fantôme après restauration).
      if ((entry.text ?? "").trim() === "" && typeof entry.ack !== "string") continue;
      const div = appendAssistantMessage(entry.text ?? "", pinned, ts);
      const meta = runMetricsText(entry.metrics);
      if (meta) setMeta(div, meta);
      // RÉACTION : le serveur la fournit (store à part) avec l'identifiant STABLE
      // du message. Elle réapparaît donc à la bonne place après un RECHARGEMENT,
      // et peut être changée ou retirée.
      reactionControl.attach(div, {
        entryId: typeof entry.id === "string" ? entry.id : null,
        reaction: typeof entry.reaction === "string" ? entry.reaction : null,
      });
      // ACCUSÉ PERSISTÉ (il fait partie du message) : il revient donc après un
      // rechargement, en PREMIÈRE ligne de la bulle, AVANT le corps (le point
      // d'insertion est le corps, l'ordre des appels n'y change rien).
      if (typeof entry.ack === "string") ackBlocks.show(div, entry.ack);
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

  // « Conversation dédiée » : l'aperçu (`recap_ready`) et les erreurs corrélées
  // portent NOTRE `requestId`. On les traite en priorité pour ne pas les
  // confondre avec une réponse de modèle.
  if (recapDedicated && recapDedicated.handleFrame(frame)) return;
  // « Compacter… » : progression (`compact_progress`) et compte rendu
  // (`compact_done`) corrélés par `requestId` — traités AVANT tout le reste,
  // sinon une erreur de compaction deviendrait une bulle d'assistant.
  if (sessionActions && sessionActions.handleFrame(frame)) return;

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
    imageBlocks.reset();
    // ⚠️ Les accusés ne sont PLUS des blocs éphémères : ils font partie du
    // message (persistés avec lui). On ne les efface donc pas ici — le snapshot
    // qui suit reconstruit le fil, accusés compris.
    fileBlocks.reset();
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
    // Bascule demandée depuis « Conversation dédiée… » : le serveur vient de
    // confirmer que cette conversation est ouverte ⇒ le parcours peut partir.
    if (pendingRecapId !== null && pendingRecapId === activeId) {
      pendingRecapId = null;
      if (recapSwitchTimer) {
        clearTimeout(recapSwitchTimer);
        recapSwitchTimer = null;
      }
      if (recapDedicated) recapDedicated.open();
    }
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
    // Le dernier état connu par ID sert au DÉVERROUILLAGE (nom lisible de
    // l'agent dans la fenêtre de mot de passe).
    agentsById = new Map(
      (Array.isArray(frame.agents) ? frame.agents : [])
        .filter((agent) => agent && typeof agent.agentId === "string")
        .map((agent) => [agent.agentId, agent]),
    );
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
  // IMAGE GÉNÉRÉE : ÉTAT TEMPORAIRE, trame de CONTRÔLE (aucun `seq` consommé),
  // traitée AVANT le curseur `seq` (sinon prise pour un doublon). Jamais rejouée,
  // jamais conservée : le chemin est same-origin, donc la CSP reste inchangée.
  if (type === "image") {
    imageBlocks.show(frame.image);
    return;
  }
  // FICHE d'une image DÉJÀ affichée (prompt final publié par le workflow) : elle
  // arrive APRÈS l'image et se place SOUS elle, sans jamais la déplacer. Trame de
  // CONTRÔLE (aucun `seq` consommé), traitée AVANT le curseur `seq`.
  if (type === "image_final_prompt") {
    imageBlocks.setFinalPrompt(String(frame.id ?? ""), frame.finalPrompt);
    return;
  }
  // ACCUSÉ DE RÉCEPTION : trame de CONTRÔLE (aucun `seq` consommé), traitée AVANT
  // le curseur `seq` (sinon prise pour un doublon). ⚠️ C'est la PREMIÈRE LIGNE de
  // la réponse : elle s'affiche DANS la bulle assistant du run (au-dessus du
  // corps markdown où le texte s'ajoutera ensuite), jamais dans un bloc séparé.
  // Un fil non focalisé ne la dessine pas.
  if (type === "ack") {
    const ackTarget =
      typeof frame.sessionId === "string" && frame.sessionId.length > 0
        ? frame.sessionId
        : sessionId;
    if (ackTarget && ackTarget !== sessionId) return;
    const pinned = isConversationPinned();
    if (!currentAssistant) {
      currentAssistant = appendAssistantMessage(null, pinned, Date.now());
    }
    ackBlocks.show(currentAssistant, frame.text);
    pinIfNeeded(pinned);
    return;
  }
  // FICHIER envoyé par Yuki : trame de CONTRÔLE (aucun `seq` consommé). La carte
  // apparaît DANS le fil, cliquable et téléchargeable (même origine, donc aucune
  // CSP à élargir). ⚠️ Aucun contenu ne voyage : seulement des métadonnées.
  if (type === "file_sent") {
    rememberFile(frame.file);
    fileBlocks.show(frame.file, { from: frame.from === "user" ? "user" : "yuki" });
    return;
  }
  // RÉACTION posée sur un message : trame de CONTRÔLE (aucun `seq` consommé),
  // traitée AVANT le curseur `seq` (sinon prise pour un doublon). Elle se
  // rattache au message par son `entryId` — jamais par sa position à l'écran.
  // Un fil NON focalisé n'est pas redessiné : son état revient au snapshot quand
  // on y bascule (le serveur reste la source de vérité).
  if (type === "reaction") {
    const target = typeof frame.sessionId === "string" && frame.sessionId.length > 0
      ? frame.sessionId
      : sessionId;
    if (!target || target !== sessionId) return;
    reactionControl.apply(frame);
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
  // Jobs d'arrière-plan ENCORE ouverts, tels que le SERVEUR les connaît (il les lit
  // dans le `JobStore`). Absents d'un snapshot ⇒ aucun job ouvert : c'est la seule
  // information qui décide de l'activité affichée (aucun état local périmé).
  const snapshotJobs = Array.isArray(frame.jobs) ? frame.jobs : [];
  // Le store du fil focalisé adopte l'état AUTORITATIF du snapshot (le run d'un
  // fil d'arrière-plan continue, lui, côté serveur et reste dans SON store).
  const store = storeOf(sessionId);
  if (store) {
    store.state = typeof frame.state === "string" ? frame.state : "idle";
    store.activeRunId = typeof frame.activeRunId === "string" ? frame.activeRunId : null;
    store.lastSeq = lastSeq;
    // On REMPLACE l'ensemble (on n'accumule pas) : un job terminé pendant qu'on
    // était ailleurs disparaît donc aussi de l'indicateur « en cours ».
    store.runningJobs.clear();
    for (const job of snapshotJobs) {
      if (job && typeof job.jobId === "string" && job.jobId.length > 0) {
        store.runningJobs.add(job.jobId);
      }
    }
  }
  refreshSidebarBusy();
  // Ouvrir/afficher une conversation éteint son indicateur « non lu ».
  markConversationRead(sessionId);
  // Éphémères rattachés au fil : on repart propre, puis on RESTAURE depuis l'état
  // du serveur (voir `restoreThreadActivity`).
  applyTranscript(frame.transcript);
  setSessionState(frame.state || "idle");
  restoreThreadActivity(frame, snapshotJobs);
}

/**
 * RESTAURE DANS LE FIL les indicateurs d'ACTIVITÉ d'une conversation qu'on
 * vient de rouvrir (bascule, rechargement, reconnexion).
 *
 * ⚠️ Le BUG corrigé : ces indicateurs sont des états VIVANTS (trames de contrôle
 * éphémères : `run_started`/
 * `job_started`) et `applyTranscript` reconstruit le DOM SANS eux. En revenant
 * sur une conversation qui tournait, le fil paraissait donc INACTIF alors que le
 * run continuait côté serveur.
 *
 * ⚠️ La source de vérité est le SNAPSHOT (état du host + `JobStore`), jamais un
 * état local : un run terminé pendant qu'on regardait ailleurs ne laisse AUCUN
 * faux « en cours ».
 *
 * @param {object} frame trame `snapshot` (état autoritatif)
 * @param {Array<object>} snapshotJobs jobs ENCORE ouverts de ce fil
 */
function restoreThreadActivity(frame, snapshotJobs) {
  // 1) ATTENTE. L'indicateur « Yuki réfléchit… » s'affiche ENTRE le lancement d'un
  // run et son premier contenu — exactement l'état que le host expose
  // (`awaitingFirstToken`). Hors de ce cas il est ÉTEINT (aucun faux « en cours »).
  const streaming = frame.state === "streaming";
  const awaitingFirstToken =
    typeof frame.awaitingFirstToken === "boolean" ? frame.awaitingFirstToken : streaming;
  if (streaming && awaitingFirstToken) showThinking();
  else hideThinking();

  // 2) ACTIVITÉ DE FOND (indicateur de la barre du composeur) du fil rouvert.
  restoreJobActivity(snapshotJobs);

  // 3) BLOC D'ACTIVITÉ DU SOUS-AGENT DANS LE FIL : un bloc par job ENCORE ouvert.
  // Les étapes détaillées manquées pendant l'absence ne sont pas rejouables
  // (trames éphémères, jamais bufferisées) : le bloc repart de l'étape de
  // lancement, avec l'intitulé RÉEL fourni par le serveur.
  for (const job of snapshotJobs) {
    if (!job || typeof job.jobId !== "string" || job.jobId.length === 0) continue;
    subagentActivity.apply({
      jobId: job.jobId,
      stage: "job_started",
      ...(typeof job.task === "string" ? { task: job.task } : {}),
    });
  }
  // Les blocs ont grandi le fil APRÈS l'épinglage final : on ré-épingle si
  // l'utilisateur était en bas (état STICKY), sinon on ne bouge pas.
  if (snapshotJobs.length > 0) pinIfNeeded(conversationPinned);
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
    case "run_started": {
      els.queued.hidden = true;
      // Dès le lancement du run — AVANT le premier token — l'attente est
      // visible : c'est le seul indicateur entre l'envoi et le premier contenu.
      showThinking();
      // `pinned` mesuré AVANT que la bulle ne grandisse (attente + pied).
      const pinned = isConversationPinned();
      currentAssistant = appendAssistantMessage(null, pinned, Date.now());
      // AUCUNE BULLE VIDE : l'attente muette occupe la bulle tant que rien n'est dit.
      ackBlocks.pending(currentAssistant);
      // Pied de stats VISIBLE dès le lancement, mis à jour en direct (temps
      // écoulé) puis complété au premier token (TTFT).
      startLiveStats(frame.runId, currentAssistant);
      pinIfNeeded(pinned);
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
    }
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
        // Le premier mot de la réponse remplace l'indicateur d'attente : l'accusé,
        // s'il y en a un, reste la première ligne de la bulle.
        ackBlocks.settled(currentAssistant);
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
        // ⚠️ Le run vient d'être PERSISTÉ par le SDK : le serveur donne l'identifiant
        // STABLE de l'entrée de session du message. C'est LUI qui rattachera la
        // réaction au bon message (aucun identifiant inventé côté navigateur).
        // Sans identifiant (réponse vide, échec), aucun bouton n'est proposé.
        // Posé AVANT le `pinIfNeeded` final : la ligne du bouton fait grandir la
        // bulle, le défilement doit en tenir compte (état STICKY préservé).
        if (typeof frame.entryId === "string") {
          reactionControl.attach(currentAssistant, { entryId: frame.entryId, reaction: null });
        }
        // `hasText` doit porter sur le CONTENU seul : l'en-tête (heure) et le
        // pied (infos techniques) font partie de la bulle mais ne sont PAS des
        // réponses du modèle.
        const hasText = producedContent;
        // ⚠️ L'accusé est DÉJÀ le début de la réponse : quand il est là et que le
        // run s'achève NORMALEMENT, la bulle n'est pas muette, on n'ajoute donc
        // pas de parenthèse technique (elle contredirait la ligne de statut que
        // l'utilisateur vient de lire). ⚠️ Un ABANDON, lui, reste DIT : c'est une
        // issue distincte, l'utilisateur doit savoir que rien d'autre n'arrivera.
        const hasAck = ackBlocks.has(currentAssistant);
        ackBlocks.settled(currentAssistant);
        if (frame.reason === "abort" && !hasText) {
          // On écrit dans le CORPS markdown (jamais `textContent` de la bulle :
          // cela effacerait l'en-tête d'heure et le pied technique).
          if (currentRenderer) currentRenderer.setText("(interrompu)");
        } else if (frame.reason === "done" && !hasText && !hasAck) {
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

/* ─── FICHIERS à joindre (bouton, glisser-déposer, TÉLÉPHONE) ────────────────
 * Le fichier est DÉPOSÉ au serveur (`POST /api/files`, corps = octets bruts) dès
 * qu'il est choisi : la barre de progression n'existe pas, mais un refus (trop
 * gros, disque en échec) est dit IMMÉDIATEMENT et EXPLICITEMENT — jamais un
 * envoi silencieux de fichier manquant.
 *
 * ⚠️ Le corps est envoyé en FLUX par `fetch` (un `File`/`Blob` est accepté tel
 * quel) : l'interface ne charge jamais le fichier entier en mémoire.
 * ⚠️ TÉLÉPHONE : le même bouton ouvre le sélecteur système (appareil photo,
 * galerie, fichiers). Le glisser-déposer n'est qu'un CONFORT supplémentaire. */
const pendingFiles = new Map();
let uploadingCount = 0;
/**
 * Vues COMPLÈTES des fichiers connus de cette page (identifiant → vue du
 * serveur) : elles portent le genre, la lisibilité et la raison exacte, ce que
 * le simple MARQUEUR du message ne dit pas. Sert aux cartes de la bulle en
 * direct (après un rechargement, la carte se reconstruit à partir du marqueur).
 * Bornée : ce n'est qu'un cache d'affichage.
 */
const knownFiles = new Map();
const MAX_KNOWN_FILES = 50;

function rememberFile(file) {
  if (!file || typeof file.id !== "string") return;
  knownFiles.set(file.id, file);
  while (knownFiles.size > MAX_KNOWN_FILES) {
    const oldest = knownFiles.keys().next().value;
    if (oldest === undefined) break;
    knownFiles.delete(oldest);
  }
}

/** Taille lisible (même règle que les cartes, source unique `file-block.js`). */
function refreshPendingFiles() {
  if (!els.pendingFiles) return;
  els.pendingFiles.replaceChildren();
  for (const file of pendingFiles.values()) {
    const chip = document.createElement("div");
    chip.className = "pending-file";
    const label = document.createElement("span");
    label.className = "pending-file__name";
    label.textContent = file.name;
    const meta = document.createElement("span");
    meta.className = "pending-file__meta";
    meta.textContent = `${formatBytes(file.bytes)}${
      file.readable === false ? " · non lisible" : ""
    }`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "pending-file__remove";
    remove.setAttribute("aria-label", `Retirer ${file.name}`);
    remove.title = "Retirer";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      pendingFiles.delete(file.id);
      refreshPendingFiles();
    });
    chip.append(label, meta, remove);
    els.pendingFiles.appendChild(chip);
  }
  els.pendingFiles.hidden = pendingFiles.size === 0 && uploadingCount === 0;
  if (uploadingCount > 0) {
    const waiting = document.createElement("span");
    waiting.className = "pending-file pending-file--waiting";
    waiting.textContent = "Envoi du fichier…";
    els.pendingFiles.appendChild(waiting);
  }
}

/**
 * Dépose UN fichier au serveur. Renvoie la vue du fichier, ou `null` en échec
 * (l'échec est TOUJOURS annoncé à l'utilisateur).
 */
async function uploadFile(file) {
  const headers = {
    // ⚠️ Nom en en-tête (pourcent-encodé) : le corps reste les OCTETS bruts du
    // fichier (aucun formulaire multipart à analyser côté serveur).
    "x-yuki-filename": encodeURIComponent(file.name || "fichier"),
    "content-type": file.type || "application/octet-stream",
  };
  const current = sessionId;
  if (current) headers["x-yuki-session"] = current;
  let response;
  try {
    response = await fetch("/api/files", { method: "POST", headers, body: file });
  } catch {
    void HolafModal.alert(
      "Envoi impossible",
      `Le fichier « ${file.name} » n'a pas pu être envoyé : la connexion au gateway a échoué.`,
      { okText: "Compris" },
    );
    return null;
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok || !payload || !payload.file) {
    // ⚠️ Le message du serveur est REPRIS TEL QUEL : il dit la cause ET le
    // plafond (jamais un échec muet, jamais un chiffre inventé ici).
    const message =
      payload && typeof payload.message === "string"
        ? payload.message
        : `Le fichier « ${file.name} » n'a pas été accepté (statut ${response.status}).`;
    void HolafModal.alert("Fichier refusé", message, { okText: "Compris" });
    return null;
  }
  return payload.file;
}

/** Dépose une liste de fichiers (sélecteur, glisser-déposer, collage). */
async function addFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  uploadingCount += 1;
  refreshPendingFiles();
  try {
    for (const file of [...fileList]) {
      const stored = await uploadFile(file);
      if (stored) {
        pendingFiles.set(stored.id, stored);
        rememberFile(stored);
      }
    }
  } finally {
    uploadingCount = Math.max(0, uploadingCount - 1);
    refreshPendingFiles();
  }
}

function sendMessage() {
  const text = els.input.value.trim();
  // ⚠️ Un fichier SANS légende est un envoi légitime : on n'exige pas de texte.
  if (text.length === 0 && pendingFiles.size === 0) return;
  // Aucune conversation ouverte (état vide) : on n'envoie RIEN dans le vide.
  if (!sessionId) return;
  // Une dépose est en cours : on attend qu'elle finisse (sinon l'identifiant du
  // fichier n'existerait pas encore côté serveur).
  if (uploadingCount > 0) {
    void HolafModal.alert(
      "Envoi en cours",
      "Un fichier est encore en cours de dépôt : réessayez dans un instant.",
      { okText: "Compris" },
    );
    return;
  }
  const attached = [...pendingFiles.values()];
  // ⚠️ Le marqueur porte l'identifiant STABLE du fichier : la carte est rendue
  // avec la bulle et REVIENT au rechargement (le marqueur est dans le message).
  const composed = [text, ...attached.map((file) => formatFileMarker(file))]
    .filter((part) => part.length > 0)
    .join("\n\n");
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
  appendMessage("user", composed, undefined, sentAt, streamingAssistant);
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
  // Les fichiers joints sont maintenant DANS le message : la liste d'attente est
  // vidée (ils restent stockés et rattachés à la conversation côté serveur).
  pendingFiles.clear();
  refreshPendingFiles();
  // Le fuseau du navigateur part avec le message : le préfixe STOCKÉ est ainsi
  // daté dans l'heure locale de l'utilisateur (le conteneur peut être en UTC).
  if (
    !sendRaw({
      type: "message",
      clientMsgId,
      text,
      ...(CLIENT_TIME_ZONE ? { tz: CLIENT_TIME_ZONE } : {}),
      ...(attached.length > 0 ? { files: attached.map((file) => file.id) } : {}),
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

/* Téléphone : le texte d'invite du composeur est RACCOURCI (la consigne
 * clavier n'a pas de sens au doigt et débordait du champ sur 360 px). Le texte
 * du bureau est celui du markup, restauré tel quel hors du dessin téléphone. */
const DESKTOP_PLACEHOLDER = els.input.getAttribute("placeholder") ?? "";
const MOBILE_PLACEHOLDER = "Écrivez un message…";
const mobileMedia =
  typeof window.matchMedia === "function" ? window.matchMedia(MOBILE_MEDIA_QUERY) : null;
function syncInputPlaceholder() {
  const mobile = Boolean(mobileMedia && mobileMedia.matches);
  els.input.setAttribute(
    "placeholder",
    mobile ? MOBILE_PLACEHOLDER : DESKTOP_PLACEHOLDER,
  );
}
syncInputPlaceholder();
if (mobileMedia && typeof mobileMedia.addEventListener === "function") {
  mobileMedia.addEventListener("change", syncInputPlaceholder);
}

/* Bouton STOP : CARRÉ à icône (36×36), sans libellé texte. L'icône `stop` de la
 * brique holaf-icons est un rectangle en trait ; le CSS la REMPLIT pour obtenir
 * le carré plein arrondi du dessin validé (aucun SVG écrit à la main). Le bouton
 * d'ENVOI reste séparé. */
const stopIcon = iconNode("stop", "icon icon--stop");
if (stopIcon) els.stop.replaceChildren(stopIcon);

/* Joindre un fichier : icône `paperclip` de la brique holaf-icons (aucun SVG
 * écrit à la main). Le bouton reste SÉPARÉ de l'envoi et de l'arrêt. */
const attachIcon = iconNode("paperclip", "icon");
if (attachIcon && els.attach) els.attach.replaceChildren(attachIcon);
if (els.attach && els.fileInput) {
  els.attach.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    const files = els.fileInput.files;
    void addFiles(files);
    // On remet le sélecteur à zéro : réenvoyer DEUX FOIS le même fichier doit
    // fonctionner (sinon le second `change` ne se déclencherait jamais).
    els.fileInput.value = "";
  });
}

/* Glisser-déposer (ordinateur) : CONFORT seulement — le bouton ci-dessus reste
 * le moyen universel, y compris sur téléphone où le glisser-déposer n'existe
 * pas. On n'accepte QUE des fichiers (un texte glissé garde son usage normal). */
if (els.chat) {
  const hasFiles = (event) =>
    Boolean(
      event.dataTransfer &&
        Array.from(event.dataTransfer.types ?? []).includes("Files"),
    );
  els.chat.addEventListener("dragover", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    els.chat.classList.add("chat--dragover");
  });
  els.chat.addEventListener("dragleave", (event) => {
    if (event.target !== els.chat) return;
    els.chat.classList.remove("chat--dragover");
  });
  els.chat.addEventListener("drop", (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    els.chat.classList.remove("chat--dragover");
    void addFiles(event.dataTransfer.files);
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
