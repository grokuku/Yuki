#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — visibilité de l'activité de Yuki (Chantier 1).
 *
 * Prouve, dans un VRAI navigateur (Chromium headless + CDP, CSP réelle) :
 *   1. l'indicateur d'attente `#thinking` est VISIBLE **AVANT le premier token**
 *      (on OBSERVE l'état : bulle assistant ENCORE VIDE) puis disparaît ;
 *   2. les trames `job_*` produisent un élément VISIBLE (en cours → terminée) ;
 *   3. les libellés d'état ne sont JAMAIS prononcés (le synthétiseur TTS, réel
 *      mais simulé, n'enregistre QUE le contenu).
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-activity.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { collectViolations, waitForGateway } from "./browser-violations.mjs";

const TOOLS = import.meta.dirname;
const WORKSPACE = join(TOOLS, "..");
const YUKI_DIR = join(WORKSPACE, "Yuki");
const TSX = join(YUKI_DIR, "node_modules", ".bin", "tsx");

// Captures dans un dossier TEMPORAIRE : aucun artefact suivi n'est modifié.
const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-activity-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THINKING_LABEL = "Yuki réfléchit…";
const REPLY_TEXT = "Voici la réponse, une fois l'attente terminée.";

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
const logs = [];
const proc = spawn(TSX, [join(TOOLS, "e2e-activity-serve.ts")], {
  cwd: YUKI_DIR,
  env: { ...process.env, YUKI_LOG_LEVEL: "error" },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stdout.on("data", (d) => logs.push(d.toString()));
proc.stderr.on("data", (d) => logs.push(d.toString()));

const { base, control } = await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("serveur non démarré :\n" + logs.join(""))),
    40_000,
  );
  let baseUrl;
  const onData = () => {
    const text = logs.join("");
    const b = text.match(/READY (http:\/\/\S+)/);
    const c = text.match(/CONTROL (http:\/\/\S+)/);
    if (b) baseUrl = b[1].trim();
    if (baseUrl && c) {
      clearTimeout(timer);
      resolve({ base: baseUrl, control: c[1].trim() });
    }
  };
  proc.stdout.on("data", onData);
  proc.on("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`serveur quitté (${code}) :\n` + logs.join("")));
  });
});
await waitForGateway(base);

/* ─── Chromium headless (CDP) ───────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-activity-chrome-"));
const chrome = spawn(
  "/usr/bin/chromium",
  [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--user-data-dir=${profileDir}`,
    "--remote-debugging-port=0",
    "about:blank",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);

const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const timer = setTimeout(() => reject(new Error("DevTools WS introuvable")), 15_000);
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
  chrome.on("exit", (code) => reject(new Error("chromium a quitté : " + code)));
});

const listTargets = await fetch(
  wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"),
).then((r) => r.json());
const page = listTargets.find((t) => t.type === "page");
if (!page) throw new Error("aucune cible page");
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((res, rej) => {
  ws.on("open", res);
  ws.on("error", rej);
});

let seq = 0;
const pending = new Map();
const consoleMessages = [];
const logEntries = [];
const pageExceptions = [];
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method === "Runtime.consoleAPICalled") {
    consoleMessages.push({
      type: msg.params.type,
      text: (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "),
    });
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails || {};
    pageExceptions.push(d.exception?.description ?? d.text ?? "exception");
  } else if (msg.method === "Log.entryAdded") {
    logEntries.push({
      source: msg.params.entry.source,
      level: msg.params.entry.level,
      text: msg.params.entry.text,
    });
  }
});

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

async function navigate(url) {
  const loaded = new Promise((resolve) => {
    const h = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Page.loadEventFired") {
        ws.off("message", h);
        resolve();
      }
    };
    ws.on("message", h);
    setTimeout(() => {
      ws.off("message", h);
      resolve();
    }, 8000);
  });
  await send("Page.navigate", { url });
  await loaded;
  await sleep(500);
}

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error("eval: " + (res.exceptionDetails.exception?.description || "exception"));
  }
  return res.result.value;
}

async function waitFor(expression, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  return false;
}

async function stopPage() {
  const done = new Promise((resolve) => {
    const h = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Page.loadEventFired") {
        ws.off("message", h);
        resolve();
      }
    };
    ws.on("message", h);
    setTimeout(() => {
      ws.off("message", h);
      resolve();
    }, 5000);
  });
  await send("Page.navigate", { url: "about:blank" });
  await done;
}

/* ─── Lecture d'un état : attente + contenu assistant ───────────────────── */
const readState = () =>
  evaluate(`(() => {
    const th = document.querySelector('#thinking');
    const bubbles = [...document.querySelectorAll('.message--assistant .markdown')];
    const last = bubbles[bubbles.length - 1];
    const ja = document.querySelector('#job-activity');
    return {
      thinkingVisible: th ? !th.hidden && getComputedStyle(th).display !== 'none' : false,
      thinkingText: th ? th.textContent : '',
      assistantBubbles: bubbles.length,
      lastAssistantText: last ? last.textContent : '',
      jobVisible: ja ? !ja.hidden && getComputedStyle(ja).display !== 'none' : false,
      jobText: ja ? ja.textContent : '',
      jobTone: ja ? (ja.getAttribute('data-tone') || '') : '',
      inConversation: !!(th && document.querySelector('#conversation')?.contains(th)),
      threadText: document.querySelector('#conversation')?.textContent ?? '',
    };
  })()`);

await navigate(`${base}/`);
check(
  "connexion au gateway établie",
  await waitFor(`document.querySelector('#connection')?.textContent === 'connecté'`),
);
check(
  "l'indicateur d'attente est HORS de la conversation (jamais dans le transcript)",
  (await readState()).inConversation === false,
);

/* ══════════ 1) Indicateur VISIBLE avant le premier token ═════════════════ */
const spokenAtStart = await fetch(`${control}/spoken`).then((r) => r.json());
check("TTS : rien de prononcé avant le premier tour", spokenAtStart.spoken.length === 0);

// Envoi via l'INTERFACE (saisie + clic sur Envoyer).
await evaluate(`(() => {
  const input = document.querySelector('#input');
  input.value = 'Bonjour, tu es là ?';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#send').click();
  return true;
})()`);

// On échantillonne FINEMENT la fenêtre send → premier token (1,6 s de silence).
const samples = [];
const deadline = Date.now() + 5000;
let sawBeforeFirstToken = false;
let sawLabel = false;
let contentAppeared = false;
while (Date.now() < deadline) {
  const s = await readState();
  samples.push({
    t: Date.now(),
    thinkingVisible: s.thinkingVisible,
    assistantText: s.lastAssistantText,
  });
  if (s.thinkingVisible && s.thinkingText === THINKING_LABEL) sawLabel = true;
  if (s.thinkingVisible && s.lastAssistantText.trim() === '') {
    sawBeforeFirstToken = true;
  }
  if (s.lastAssistantText.includes(REPLY_TEXT)) {
    contentAppeared = true;
    break;
  }
  await sleep(40);
}

check(
  "OBSERVATION : l'indicateur est visible alors que la bulle assistant est ENCORE VIDE (avant le premier token)",
  sawBeforeFirstToken,
  `${samples.filter((s) => s.thinkingVisible && s.assistantText.trim() === '').length} échantillons`,
);
check(
  `libellé affiché = « ${THINKING_LABEL} »`,
  sawLabel,
);
check(
  "le contenu arrive ensuite (fin de l'attente)",
  contentAppeared && (await waitFor(`document.querySelector('#conversation')?.textContent.includes(${JSON.stringify(REPLY_TEXT)})`)),
);

// L'indicateur DISPARAÎT dès que le texte est là.
const afterContent = await readState();
check(
  "l'indicateur disparaît une fois le texte affiché",
  afterContent.thinkingVisible === false,
  `thinkingVisible=${afterContent.thinkingVisible}`,
);
check(
  "le libellé d'état n'est JAMAIS entré dans le fil",
  !afterContent.threadText.includes(THINKING_LABEL),
);

/* ══════════ 2) Tâches de fond VISIBLES (trames `job_*`) ══════════════════ */
await fetch(`${control}/spoken-reset`);
await fetch(`${control}/job-start?jobId=job-1&task=analyse%20du%20d%C3%A9p%C3%B4t`);
const jobRunning = await waitFor(
  `(() => { const ja = document.querySelector('#job-activity'); return ja && !ja.hidden && /en cours/.test(ja.textContent) && /analyse du dépôt/.test(ja.textContent); })()`,
);
check(
  "job_started : une tâche de fond VISIBLE (« en cours »)",
  jobRunning,
  JSON.stringify((await readState()).jobText),
);
check(
  "job en cours : tonalité « active »",
  (await readState()).jobTone === "active",
  (await readState()).jobTone,
);

await fetch(`${control}/job-finish?jobId=job-1&status=completed`);
const jobFinished = await waitFor(
  `(() => { const ja = document.querySelector('#job-activity'); return ja && !ja.hidden && /terminée \\(succès\\)/.test(ja.textContent); })()`,
);
check(
  "job_finished : statut terminal VISIBLE (« terminée (succès) » + durée)",
  jobFinished && /—\s*\d/.test((await readState()).jobText),
  JSON.stringify((await readState()).jobText),
);
check(
  "job terminé : tonalité « ok »",
  (await readState()).jobTone === "ok",
  (await readState()).jobTone,
);
await send("Page.captureScreenshot", { format: "png" }).then((res) =>
  writeFileSync(join(SHOTS, "activity-jobs.png"), Buffer.from(res.data, "base64")),
);

/* ══════════ 3) TTS : les libellés d'état NE SONT PAS prononcés ══════════ */
// Un second tour pour laisser le pipeline synthétiser le contenu.
await evaluate(`(() => {
  const input = document.querySelector('#input');
  input.value = 'Deuxième question.';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#send').click();
  return true;
})()`);
await waitFor(`document.querySelector('#conversation')?.textContent.includes('Deuxième réponse.')`);
await sleep(500);
const spoken = await fetch(`${control}/spoken`).then((r) => r.json());
const spokenText = spoken.spoken.join(" ⏎ ");
check(
  "TTS : le CONTENU a bien été synthétisé (la preuve n'est pas vide)",
  spoken.spoken.length > 0,
  `${spoken.spoken.length} segment(s)`,
);
check(
  "TTS : AUCUN libellé d'état prononcé (ni « réfléchit », ni « tâche de fond »)",
  !/réfléchit/.test(spokenText) && !/tâche de fond/i.test(spokenText),
  spokenText.slice(0, 200),
);

/* ══════════ 4) Retour au fil : l'activité de fond est purgée ════════════ */
check(
  "le libellé d'activité de fond n'entre JAMAIS dans le transcript",
  !(await readState()).threadText.includes("Tâche de fond"),
);

/* ══════════ 5) E3 — BLOC D'ACTIVITÉ DU SOUS-AGENT (replié/dépliable, MUET) ═ */
const ACTIVITY_SECRET = "ETAPE-SECRETE-DU-SOUS-AGENT";
await fetch(`${control}/spoken-reset`);
await fetch(
  `${control}/job-activity?jobId=act-1&stage=job_started&task=${encodeURIComponent("analyse du dépôt")}`,
);
await fetch(
  `${control}/job-activity?jobId=act-1&stage=job_progress&detail=${encodeURIComponent(ACTIVITY_SECRET)}`,
);

const readActivity = () =>
  evaluate(`(() => {
    const root = document.querySelector('#conversation .subagent-activity');
    if (!root) return { present: false };
    const toggle = root.querySelector('.subagent-activity__toggle');
    const steps = root.querySelector('.subagent-activity__steps');
    return {
      present: true,
      inConversation: !!document.querySelector('#conversation')?.contains(root),
      isMessage: root.classList.contains('message'),
      ariaExpanded: toggle ? toggle.getAttribute('aria-expanded') : null,
      stepsHidden: steps ? (steps.hidden || getComputedStyle(steps).display === 'none') : null,
      stepsVisible: steps ? (!steps.hidden && getComputedStyle(steps).display !== 'none') : null,
      headerText: toggle ? toggle.textContent : '',
      stepsText: steps ? steps.textContent : '',
    };
  })()`);

await waitFor(`!!document.querySelector('#conversation .subagent-activity')`);
const collapsed = await readActivity();
check(
  "E3 : un bloc d'activité apparaît DANS le fil",
  collapsed.present === true && collapsed.inConversation === true,
);
check(
  "E3 : le bloc est un COMPOSANT du fil, PAS un message",
  collapsed.isMessage === false,
);
check(
  "E3 : replié PAR DÉFAUT (aria-expanded=false, étapes masquées)",
  collapsed.ariaExpanded === "false" &&
    collapsed.stepsHidden === true &&
    collapsed.stepsVisible === false,
  JSON.stringify({ aria: collapsed.ariaExpanded, hidden: collapsed.stepsHidden }),
);

// Clic RÉEL sur le bouton de repli/dépli.
await evaluate(`document.querySelector('#conversation .subagent-activity__toggle').click()`);
await sleep(120);
const expanded = await readActivity();
check(
  "E3 : le clic DÉPLIE (aria-expanded=true, étapes visibles)",
  expanded.ariaExpanded === "true" && expanded.stepsVisible === true,
  JSON.stringify({ aria: expanded.ariaExpanded, visible: expanded.stepsVisible }),
);
check(
  "E3 : le bloc montre l'ACTIVITÉ RÉELLE (tâche + progression)",
  expanded.stepsText.includes("analyse du dépôt") &&
    expanded.stepsText.includes(ACTIVITY_SECRET),
  expanded.stepsText.slice(0, 200),
);
await send("Page.captureScreenshot", { format: "png" }).then((res) =>
  writeFileSync(join(SHOTS, "subagent-activity.png"), Buffer.from(res.data, "base64")),
);

/* ══════════ 6) E3 — SILENCE TTS (synthétiseur enregistreur) ═════════════ */
await evaluate(`(() => {
  const input = document.querySelector('#input');
  input.value = 'Troisième question.';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#send').click();
  return true;
})()`);
await waitFor(`document.querySelector('#conversation')?.textContent.includes('Troisième réponse.')`);
await sleep(500);
const spoken5 = await fetch(`${control}/spoken`).then((r) => r.json());
const spoken5Text = spoken5.spoken.join(" ⏎ ");
check(
  "E3 TTS : la réponse NORMALE est bien synthétisée (la preuve n'est pas vide)",
  spoken5.spoken.some((t) => t.includes("Troisième réponse.")),
  spoken5Text.slice(0, 160),
);
check(
  "E3 TTS : AUCUN segment issu de la trame d'ACTIVITÉ (ni titre, ni étapes)",
  !spoken5.spoken.some((t) => t.includes(ACTIVITY_SECRET)) &&
    !/Activité du sous-agent/.test(spoken5Text) &&
    !spoken5Text.includes("analyse du dépôt"),
  spoken5Text.slice(0, 200),
);
await fetch(`${control}/job-activity?jobId=act-1&stage=job_finished&status=completed`);
await sleep(100);

/* ══════════ 7) E3 — ÉPHÉMÉRITÉ (transcript + snapshot/rejeu) ════════════ */
const transcript5 = await fetch(`${control}/transcript`).then((r) => r.json());
check(
  "E3 ÉPHÉMÉRITÉ : l'activité n'est NI dans le transcript serveur NI un message",
  !transcript5.text.includes(ACTIVITY_SECRET) &&
    !transcript5.text.includes("Activité du sous-agent"),
  transcript5.text.slice(0, 200),
);
await navigate(`${base}/`);
check(
  "E3 : connexion rétablie après rechargement",
  await waitFor(`document.querySelector('#connection')?.textContent === 'connecté'`),
);
check(
  "E3 ÉPHÉMÉRITÉ : après rechargement (snapshot/rejeu), le bloc a DISPARU",
  (await evaluate(
    `document.querySelectorAll('#conversation .subagent-activity').length`,
  )) === 0,
);

/* ══════════ 8) E5 — VERROU ANTI-MENSONGE (badge « tâche en cours ») ═══════ */
// L'état SERVEUR `waiting` (lu dans le JobStore) pilote le badge. Le texte du
// modèle n'entre PAS dans cette décision : on émet l'état directement et on
// vérifie que l'interface le reflète, indépendamment de tout texte.
await fetch(`${control}/spoken-reset`);
await fetch(`${control}/state?state=waiting`);
const badgeVisible = await waitFor(
  `(() => { const b = document.querySelector('#pending-badge'); return !!b && !b.hidden; })()`,
);
check(
  "E5 : l'état serveur `waiting` affiche le badge « tâche en cours » (NON MASQUABLE)",
  badgeVisible,
  await evaluate(`document.querySelector('#pending-badge')?.textContent ?? ''`),
);
check(
  "E5 : la pastille d'état indique « en attente » (et non un mensonge « idle »)",
  (await evaluate(`document.querySelector('#session-state')?.textContent`)) === "en attente",
  await evaluate(`document.querySelector('#session-state')?.textContent`),
);
check(
  "E5 : le badge est HORS de la conversation (jamais dans le fil)",
  await evaluate(
    `!document.querySelector('#conversation')?.contains(document.querySelector('#pending-badge'))`,
  ),
);
// Le libellé n'est JAMAIS prononcé (seul le tour visible parle).
await sleep(200);
const spokenWaiting = await fetch(`${control}/spoken`).then((r) => r.json());
check(
  "E5 TTS : le libellé du badge n'est JAMAIS prononcé",
  !spokenWaiting.spoken.some((t) => /tâche en cours/i.test(t)),
  spokenWaiting.spoken.join(" ⏎ ").slice(0, 160),
);
// Retour à l'état normal : le badge DISPARAÎT (décision serveur).
await fetch(`${control}/state?state=idle`);
const badgeHidden = await waitFor(
  `(() => { const b = document.querySelector('#pending-badge'); return !!b && b.hidden; })()`,
);
check("E5 : l'état serveur `idle` retire le badge (seul le serveur le décide)", badgeHidden);

await stopPage();
proc.kill("SIGTERM");
await sleep(300);

/* ═══════════════════════ Bilan CSP / exceptions ══════════════════════════ */
const { cspViolations, connectionErrors } = collectViolations(consoleMessages, logEntries);
check(
  "ZÉRO erreur de connexion réseau",
  connectionErrors.length === 0,
  connectionErrors.map((v) => v.text).join(" | ").slice(0, 300),
);
check("ZÉRO violation CSP", cspViolations.length === 0, cspViolations.map((v) => v.text).join(" | "));
check("ZÉRO exception JS non capturée", pageExceptions.length === 0, pageExceptions.join(" | ").slice(0, 300));

console.log(`\nCaptures (temporaires) : ${SHOTS}`);
const failed = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`,
);

chrome.kill("SIGKILL");
process.exit(
  failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1,
);
