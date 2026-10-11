#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — E2 : TRANSPORT MULTIPLEXÉ (rendu dans un VRAI navigateur,
 * Chromium headless + CDP, CSP réelle).
 *
 * Prouve :
 *   1. DEUX conversations tournent en parallèle et CHACUNE reçoit SES messages
 *      (aucun croisement quand on bascule) ;
 *   2. l'utilisateur VOIT qu'un fil NON focalisé travaille (point « en cours »
 *      dans la barre latérale) et peut y basculer sans rien perdre ;
 *   3. un fil de FOND reste MUET : sa réponse est bien streamée mais AUCUN
 *      segment n'est synthétisé (0 audio), alors que le fil focalisé parle.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-multiplex.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { collectViolations, waitForGateway } from "./browser-violations.mjs";

const TOOLS = import.meta.dirname;
const YUKI_DIR = join(TOOLS, "..", "Yuki");
const TSX = join(YUKI_DIR, "node_modules", ".bin", "tsx");
const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-multiplex-"));
void STATE_DIR;

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
const logs = [];
const proc = spawn(TSX, [join(TOOLS, "e2e-multiplex-serve.ts")], {
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

const controlRun = (sessionId, text, chunks = 10, delayMs = 120) =>
  fetch(
    `${control}/run?sessionId=${encodeURIComponent(sessionId)}&text=${encodeURIComponent(
      text,
    )}&chunks=${chunks}&delayMs=${delayMs}`,
  ).then((r) => r.json());
const controlTranscript = (sessionId) =>
  fetch(`${control}/transcript?sessionId=${encodeURIComponent(sessionId)}`).then((r) => r.json());
const controlSpoken = () => fetch(`${control}/spoken`).then((r) => r.json());

/* ─── Chromium headless (CDP) ───────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-multiplex-chrome-"));
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
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

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
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error("eval: " + (res.exceptionDetails.exception?.description || "exception"));
  }
  return res.result.value;
}

async function waitFor(expression, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(80);
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

/** État lu du DOM : barre latérale (titre + « en cours ») + fil affiché. */
const readState = () =>
  evaluate(`(() => {
    const convs = [...document.querySelectorAll('.conv')].map((c) => ({
      id: c.getAttribute('data-id'),
      title: (c.querySelector('.conv__title') || {}).textContent || '',
      busy: c.classList.contains('conv--busy'),
      active: c.classList.contains('conv--active'),
    }));
    return {
      convs,
      thread: document.querySelector('#conversation')?.textContent ?? '',
      connection: document.querySelector('#connection')?.textContent ?? '',
    };
  })()`);

/** Envoi d'un message via l'INTERFACE (saisie + clic Envoyer). */
const sendViaUi = (text) =>
  evaluate(`(() => {
    const input = document.querySelector('#input');
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send').click();
    return true;
  })()`);

/** Clic sur une conversation de la barre latérale (bascule de fil). */
const clickConversation = (id) =>
  evaluate(`(() => {
    const item = document.querySelector('.conv[data-id="' + ${JSON.stringify(id)} + '"]');
    if (!item) return false;
    item.click();
    return true;
  })()`);

const convBusy = (id) =>
  evaluate(
    `!!document.querySelector('.conv[data-id="' + ${JSON.stringify(id)} + '"]')?.classList.contains('conv--busy')`,
  );

await navigate(`${base}/`);
check(
  "connexion au gateway établie",
  await waitFor(`document.querySelector('#connection')?.textContent === 'connecté'`),
);
check(
  "la barre latérale liste les DEUX conversations (A et B)",
  await waitFor(`document.querySelectorAll('.conv').length === 2`),
);

/* ══════════ 1) DEUX FILS, CHACUN SES MESSAGES (aucun croisement) ════════ */

// État initial : la conversation A est focalisée, son historique est affiché.
const initial = await readState();
check(
  "A est la conversation focalisée au démarrage",
  initial.convs.find((c) => c.id === "sess-A")?.active === true,
  JSON.stringify(initial.convs),
);
check(
  "l'historique de A est affiché, PAS celui de B",
  initial.thread.includes("Réponse historique A.") && !initial.thread.includes("Réponse historique B."),
);

// Message dans A : le run démarre. On bascule vers B SANS attendre sa fin —
// le run de A doit CONTINUER en arrière-plan.
await sendViaUi("ALPHA");
check(
  "A : le message est envoyé (bulle utilisateur immédiate)",
  await waitFor(`document.querySelector('#conversation').textContent.includes('ALPHA')`),
);
await clickConversation("sess-B");
check(
  "bascule vers B : l'historique de B s'affiche (aucun message de A)",
  await waitFor(
    `(() => { const t = document.querySelector('#conversation').textContent; return t.includes('Réponse historique B.') && !t.includes('ALPHA'); })()`,
  ),
);
check(
  "le run de A CONTINUE en arrière-plan (point « en cours » sur A, vu depuis B)",
  await waitFor(
    `!!document.querySelector('.conv[data-id="sess-A"]')?.classList.contains('conv--busy')`,
    4000,
  ),
);
await waitFor(
  `!document.querySelector('.conv[data-id="sess-A"]').classList.contains('conv--busy')`,
  8000,
);

// Message dans B.
await sendViaUi("BRAVO");
check(
  "B : sa propre réponse s'affiche",
  await waitFor(`document.querySelector('#conversation').textContent.includes('Réponse au message « BRAVO »')`),
);
const onB = await readState();
check(
  "AUCUN croisement : le fil B ne contient AUCUN message de A",
  !onB.thread.includes("ALPHA") && !onB.thread.includes("Réponse historique A."),
  onB.thread.slice(0, 120),
);

// Retour sur A : l'historique de A est INTACT (le run avait continué).
await clickConversation("sess-A");
check(
  "retour sur A : l'historique de A est intact (run continué, rien perdu)",
  await waitFor(
    `(() => { const t = document.querySelector('#conversation').textContent; return t.includes('Réponse au message « ALPHA »') && !t.includes('BRAVO'); })()`,
  ),
);

/* ══════════ 2) VOIR qu'un fil NON focalisé travaille, y basculer ════════ */
await clickConversation("sess-B");
await waitFor(`document.querySelector('.conv[data-id="sess-B"]').classList.contains('conv--active')`);

// Un run de FOND démarre sur A (la conversation focalisée est B).
const bg = await controlRun("sess-A", "REPONSE-ARRIERE-PLAN", 12, 130);
check("run de fond lancé sur A (non focalisée)", bg.ok === true, JSON.stringify(bg));
check(
  "l'utilisateur VOIT que A travaille (point « en cours ») sans la focaliser",
  await waitFor(`!!document.querySelector('.conv[data-id="sess-A"]').classList.contains('conv--busy')`),
);
const bgVisible = await readState();
check(
  "le fil de fond ne pollue PAS l'affichage de B",
  !bgVisible.thread.includes("REPONSE-ARRIERE-PLAN"),
);
check(
  "l'indicateur de A disparaît quand son run se termine (toujours sur B)",
  await waitFor(
    `!document.querySelector('.conv[data-id="sess-A"]').classList.contains('conv--busy')`,
    8000,
  ) && (await convBusy("sess-A")) === false,
);
const bgTranscript = await controlTranscript("sess-A");
check(
  "le run de fond a RÉELLEMENT eu lieu côté serveur (son texte est dans A)",
  bgTranscript.text.includes("REPONSE-ARRIERE-PLAN"),
);
await clickConversation("sess-A");
check(
  "basculer sur A après coup : son contenu de fond est LÀ (rien perdu)",
  await waitFor(`document.querySelector('#conversation').textContent.includes('REPONSE-ARRIERE-PLAN')`),
);

/* ══════════ 3) UN FIL DE FOND RESTE MUET (0 audio) ═════════════════════ */
await fetch(`${control}/spoken-reset`);
await clickConversation("sess-B");
await waitFor(`document.querySelector('.conv[data-id="sess-B"]').classList.contains('conv--active')`);

// Run de FOND (A muet) — on attend sa fin.
await controlRun("sess-A", "VOIX-DU-FOND-INTERDITE", 6, 90);
await waitFor(
  `!document.querySelector('.conv[data-id="sess-A"]').classList.contains('conv--busy')`,
  8000,
);
await sleep(400);
// Run du fil FOCALISÉ (B parle).
await controlRun("sess-B", "VOIX-DU-FIL-COURANT", 6, 90);
let currentSpoken = false;
for (let i = 0; i < 60; i += 1) {
  const spoken = await controlSpoken();
  if (spoken.spoken.some((text) => text.includes("VOIX-DU-FIL-COURANT"))) {
    currentSpoken = true;
    break;
  }
  await sleep(100);
}
const finalSpoken = await controlSpoken();
const spokenText = finalSpoken.spoken.join(" ⏎ ");
check(
  "le fil FOCALISÉ parle bien (la preuve n'est pas vide)",
  currentSpoken,
  spokenText.slice(0, 160),
);
check(
  "un fil de FOND (même s'il streame) n'a produit AUCUN segment audio",
  !finalSpoken.spoken.some((text) => text.includes("VOIX-DU-FOND")),
  spokenText.slice(0, 160),
);

/* ══════════ 4) E3 — l'ACTIVITÉ d'un fil de fond n'est PAS dessinée ═════ */
await clickConversation("sess-B");
await waitFor(`document.querySelector('.conv[data-id="sess-B"]').classList.contains('conv--active')`);

const ACTIVITE_FOND_A = "ACTIVITE-DU-FIL-A";
const ACTIVITE_FOCAL_B = "ACTIVITE-DU-FIL-B";
// Activité d'un fil de FOND (A) : elle doit être SUIVIE mais JAMAIS dessinée.
await fetch(
  `${control}/job-activity?sessionId=sess-A&jobId=act-A&stage=job_started&task=${encodeURIComponent("tâche du fil A")}`,
);
await fetch(
  `${control}/job-activity?sessionId=sess-A&jobId=act-A&stage=job_progress&detail=${encodeURIComponent(ACTIVITE_FOND_A)}`,
);
// Activité du fil FOCALISÉ (B) : elle doit apparaître.
await fetch(
  `${control}/job-activity?sessionId=sess-B&jobId=act-B&stage=job_started&task=${encodeURIComponent("tâche du fil B")}`,
);
await fetch(
  `${control}/job-activity?sessionId=sess-B&jobId=act-B&stage=job_progress&detail=${encodeURIComponent(ACTIVITE_FOCAL_B)}`,
);
await sleep(250);
const activityDom = await evaluate(`(() => {
  const blocks = [...document.querySelectorAll('#conversation .subagent-activity')];
  return {
    count: blocks.length,
    text: blocks.map((b) => b.textContent).join(' ⏎ '),
    thread: document.querySelector('#conversation').textContent,
  };
})()`);
check(
  "E3 : le bloc du fil FOCALISÉ (B) apparaît",
  activityDom.count === 1 && activityDom.text.includes("tâche du fil B"),
  JSON.stringify({ count: activityDom.count, text: activityDom.text.slice(0, 120) }),
);
check(
  "E3 : le bloc d'activité du fil de FOND (A) n'apparaît PAS dans B",
  !activityDom.thread.includes(ACTIVITE_FOND_A) &&
    !activityDom.thread.includes("tâche du fil A"),
  activityDom.thread.slice(-160),
);

/* ═══════════════════════ Bilan CSP / exceptions ══════════════════════════ */
await stopPage();
proc.kill("SIGTERM");
await sleep(300);

const { cspViolations, connectionErrors } = collectViolations(consoleMessages, logEntries);
check(
  "ZÉRO erreur de connexion réseau",
  connectionErrors.length === 0,
  connectionErrors.map((v) => v.text).join(" | ").slice(0, 300),
);
check("ZÉRO violation CSP", cspViolations.length === 0, cspViolations.map((v) => v.text).join(" | "));
check("ZÉRO exception JS non capturée", pageExceptions.length === 0, pageExceptions.join(" | ").slice(0, 300));

const failed = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`,
);

chrome.kill("SIGKILL");
process.exit(
  failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1,
);
