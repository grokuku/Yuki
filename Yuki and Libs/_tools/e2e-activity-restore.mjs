#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — BUG « au retour sur une conversation qui tourne,
 * l'indicateur d'activité DANS LE FIL a disparu ».
 *
 * Prouve, dans un VRAI navigateur (Chromium headless + CDP, CSP réelle) :
 *   1. un run lancé sur A pendant qu'on regarde B CONTINUE, et RIEN de A ne
 *      s'affiche dans B (multiplexage intact) ;
 *   2. en REVENANT sur A, l'indicateur d'attente (« Yuki réfléchit… ») est LÀ —
 *      il vient de l'état AUTORITAIRE du serveur, pas d'un état local ;
 *   3. le bloc d'activité d'un sous-agent de A est restauré DANS le fil de A au
 *      retour (un job encore ouvert, lu dans le JobStore) ;
 *   4. cas INVERSE : un run / un job qui se termine pendant qu'on regarde
 *      ailleurs ne laisse AUCUN faux « en cours » au retour ;
 *   5. aucun son n'est émis par un fil de fond (TTS muette).
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-activity-restore.mjs"
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

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
const logs = [];
const proc = spawn(TSX, [join(TOOLS, "e2e-activity-restore-serve.ts")], {
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

const q = (params) =>
  Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("&");
const controlRunHeld = (sessionId, text, chunks = 6, delayMs = 60) =>
  fetch(`${control}/run-held?${q({ sessionId, text, chunks, delayMs })}`).then((r) => r.json());
const controlRelease = (sessionId) =>
  fetch(`${control}/release?${q({ sessionId })}`).then((r) => r.json());
const controlJobStart = (sessionId, jobId, task) =>
  fetch(`${control}/job-start?${q({ sessionId, jobId, task })}`).then((r) => r.json());
const controlJobFinish = (sessionId, jobId) =>
  fetch(`${control}/job-finish?${q({ sessionId, jobId })}`).then((r) => r.json());
const controlTranscript = (sessionId) =>
  fetch(`${control}/transcript?${q({ sessionId })}`).then((r) => r.json());
const controlSpoken = () => fetch(`${control}/spoken`).then((r) => r.json());

/* ─── Chromium headless (CDP) ───────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-restore-chrome-"));
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

/**
 * MESURE de ce qui est AFFICHÉ dans le fil : indicateur d'attente, indicateur
 * d'activité de fond, blocs d'activité de sous-agents, texte du fil.
 */
const readThread = () =>
  evaluate(`(() => {
    const thinking = document.querySelector('#thinking');
    const jobActivity = document.querySelector('#job-activity');
    const blocks = [...document.querySelectorAll('#conversation .subagent-activity')];
    return {
      thinkingHidden: thinking ? thinking.hidden : null,
      thinkingVisible: thinking ? thinking.offsetParent !== null : null,
      thinkingText: thinking ? thinking.textContent.trim() : null,
      jobActivityHidden: jobActivity ? jobActivity.hidden : null,
      jobActivityText: jobActivity ? jobActivity.textContent.trim() : null,
      blocks: blocks.length,
      blockTexts: blocks.map((b) => b.textContent),
      blockExpanded: blocks.map((b) =>
        b.querySelector('.subagent-activity__toggle')?.getAttribute('aria-expanded'),
      ),
      blockStepsHidden: blocks.map(
        (b) => b.querySelector('.subagent-activity__steps')?.hidden ?? null,
      ),
      blockSteps: blocks.map(
        (b) => b.querySelectorAll('.subagent-activity__step').length,
      ),
      blockStatus: blocks.map(
        (b) => b.querySelector('.subagent-activity__status')?.textContent ?? null,
      ),
      thread: document.querySelector('#conversation')?.textContent ?? '',
      busyA: !!document.querySelector('.conv[data-id="sess-A"]')?.classList.contains('conv--busy'),
      active: document.querySelector('.conv.conv--active')?.getAttribute('data-id') ?? null,
    };
  })()`);

const clickConversation = (id) =>
  evaluate(`(() => {
    const item = document.querySelector('.conv[data-id="' + ${JSON.stringify(id)} + '"]');
    if (!item) return false;
    item.click();
    return true;
  })()`);

const switchTo = async (id) => {
  const clicked = await clickConversation(id);
  const active = await waitFor(
    `document.querySelector('.conv.conv--active')?.getAttribute('data-id') === ${JSON.stringify(id)}`,
  );
  await sleep(150);
  return clicked && active;
};

/** Attend qu'un texte soit présent dans le transcript SERVEUR d'une session. */
async function waitForTranscript(sessionId, text, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const state = await controlTranscript(sessionId);
    if (String(state.text || "").includes(text)) return true;
    await sleep(80);
  }
  return false;
}

await navigate(`${base}/`);
check(
  "connexion au gateway établie",
  await waitFor(`document.querySelector('#connection')?.textContent === 'connecté'`),
);
check(
  "la barre latérale liste les DEUX conversations (A et B)",
  await waitFor(`document.querySelectorAll('.conv').length === 2`),
);

/* ══════════ 1) A TOURNE (SANS CONTENU) PENDANT QU'ON REGARDE B ══════════ */

check("bascule initiale vers B", await switchTo("sess-B"));
const startB = await readThread();
check(
  "B s'affiche : son historique, RIEN de A",
  startB.thread.includes("Réponse historique B.") && !startB.thread.includes("Réponse historique A."),
  startB.thread.slice(0, 120),
);
check(
  "état de départ PROPRE : aucun indicateur d'activité affiché sur B",
  startB.thinkingHidden === true && startB.jobActivityHidden === true && startB.blocks === 0,
  JSON.stringify({
    thinkingHidden: startB.thinkingHidden,
    jobActivityHidden: startB.jobActivityHidden,
    blocks: startB.blocks,
  }),
);

// Run de A démarré SANS contenu (contenu retenu côté serveur) : la fenêtre
// « run en cours, rien d'affiché encore » est STABLE, donc mesurable.
const held = await controlRunHeld("sess-A", "REPONSE-DU-FIL-A", 6, 60);
check("run SUSPENDU lancé sur A (aucun contenu émis)", held.ok === true, JSON.stringify(held));
check(
  "le run de A EST en cours côté serveur et n'a produit AUCUN contenu",
  !(await controlTranscript("sess-A")).text.includes("REPONSE-DU-FIL-A"),
);
check(
  "depuis B, l'utilisateur VOIT que A travaille (point « en cours »)",
  await waitFor(
    `!!document.querySelector('.conv[data-id="sess-A"]')?.classList.contains('conv--busy')`,
    4000,
  ),
);
const onB = await readThread();
check(
  "MULTIPLEXAGE INTACT : le fil B ne contient AUCUN élément de A",
  !onB.thread.includes("REPONSE-DU-FIL-A") && !onB.thread.includes("Réponse historique A.") &&
    onB.blocks === 0,
  JSON.stringify({ blocks: onB.blocks, thread: onB.thread.slice(0, 120) }),
);
check(
  "B n'affiche AUCUN indicateur d'attente (ce n'est pas SON run)",
  onB.thinkingHidden === true && onB.active === "sess-B",
  JSON.stringify({ thinkingHidden: onB.thinkingHidden, active: onB.active }),
);

/* ══════════ 2) RETOUR SUR A : L'INDICATEUR D'ATTENTE EST RESTAURÉ ═══════ */

check("retour sur A (le run tourne toujours)", await switchTo("sess-A"));
const backOnA = await readThread();
check(
  "★ RETOUR SUR A : l'indicateur « Yuki réfléchit… » EST LÀ (DANS le fil)",
  backOnA.thinkingHidden === false && backOnA.thinkingVisible === true,
  JSON.stringify({ hidden: backOnA.thinkingHidden, visible: backOnA.thinkingVisible }),
);
check(
  "★ l'indicateur porte bien le libellé d'attente",
  backOnA.thinkingText === "Yuki réfléchit…",
  String(backOnA.thinkingText),
);
check(
  "le fil A ne contient RIEN de B (aucun mélange au retour)",
  !backOnA.thread.includes("Réponse historique B.") && !backOnA.thread.includes("Question du fil B"),
  backOnA.thread.slice(0, 160),
);
check(
  "le bouton Arrêter est actif (l'état serveur est bien « streaming »)",
  await evaluate(`document.querySelector('#stop').disabled === false`),
);
check(
  "le run n'a TOUJOURS pas de contenu (rien n'a été inventé à l'écran)",
  !backOnA.thread.includes("REPONSE-DU-FIL-A"),
  backOnA.thread.slice(-160),
);

// Le contenu arrive : le comportement VIVANT est préservé (l'attente s'efface).
await controlRelease("sess-A");
check(
  "premier contenu reçu ⇒ l'indicateur d'attente s'éteint (comportement vivant)",
  await waitFor(`document.querySelector('#thinking')?.hidden === true`, 5000),
);
check(
  "la réponse de A s'affiche entièrement",
  await waitFor(
    `document.querySelector('#conversation')?.textContent.includes('REPONSE-DU-FIL-A')`,
    5000,
  ),
);

/* ══════════ 3) LE BLOC D'ACTIVITÉ D'UN SOUS-AGENT EST RESTAURÉ ══════════ */

check("bascule vers B", await switchTo("sess-B"));
const TACHE_A = "TACHE-DU-SOUS-AGENT-A";
check(
  "un job d'arrière-plan est ouvert sur A (fil NON focalisé)",
  (await controlJobStart("sess-A", "job-A1", TACHE_A)).ok === true,
);
check(
  "A est marquée « en cours » dans la barre (vu depuis B)",
  await waitFor(`!!document.querySelector('.conv[data-id="sess-A"]')?.classList.contains('conv--busy')`),
);
const withJobOnB = await readThread();
check(
  "le bloc d'activité du job de A n'est PAS dessiné dans le fil B",
  withJobOnB.blocks === 0 && !withJobOnB.thread.includes(TACHE_A),
  JSON.stringify({ blocks: withJobOnB.blocks }),
);

check("retour sur A (un job y tourne)", await switchTo("sess-A"));
const jobOnA = await readThread();
check(
  "★ le bloc d'activité du sous-agent EST RESTAURÉ dans le fil A",
  jobOnA.blocks === 1 && jobOnA.blockTexts.join(" ").includes(TACHE_A),
  JSON.stringify({ blocks: jobOnA.blocks, text: jobOnA.blockTexts.join(" ").slice(0, 160) }),
);
check(
  "★ le bloc est REPLIÉ par défaut (ses étapes ne sont pas déversées)",
  jobOnA.blockExpanded[0] === "false" && jobOnA.blockStepsHidden[0] === true && jobOnA.blockSteps[0] === 1,
  JSON.stringify({
    expanded: jobOnA.blockExpanded,
    stepsHidden: jobOnA.blockStepsHidden,
    steps: jobOnA.blockSteps,
  }),
);
check(
  "★ le bloc restauré dit honnêtement « en cours » (job non terminal)",
  String(jobOnA.blockStatus[0] || "").includes("en cours"),
  JSON.stringify(jobOnA.blockStatus),
);
check(
  "★ l'indicateur d'activité de fond est restauré lui aussi (« Tâche de fond en cours… »)",
  jobOnA.jobActivityHidden === false && jobOnA.jobActivityText.includes("Tâche de fond en cours"),
  JSON.stringify({ hidden: jobOnA.jobActivityHidden, text: jobOnA.jobActivityText }),
);
check(
  "aucun indicateur d'attente parasite : l'état serveur n'est PAS « streaming »",
  jobOnA.thinkingHidden === true,
  JSON.stringify({ thinkingHidden: jobOnA.thinkingHidden }),
);

// Un 2e aller-retour ne DOIT PAS dupliquer le bloc (idempotence).
check("aller-retour supplémentaire (B puis A)", (await switchTo("sess-B")) && (await switchTo("sess-A")));
const jobOnA2 = await readThread();
check(
  "★ après un 2e retour, EXACTEMENT un bloc (aucun doublon)",
  jobOnA2.blocks === 1,
  JSON.stringify({ blocks: jobOnA2.blocks }),
);

/* ══════════ 4) CAS INVERSE : TOUT FINIT PENDANT QU'ON EST AILLEURS ══════ */

check("bascule vers B", await switchTo("sess-B"));
check(
  "le job de A se termine, et un run de A se termine, PENDANT qu'on regarde B",
  (await controlJobFinish("sess-A", "job-A1")).ok === true,
);
const held2 = await controlRunHeld("sess-A", "REPONSE-TARDIVE-A", 4, 40);
await sleep(120);
check("run de A lancé puis relâché depuis B", held2.ok === true && (await controlRelease("sess-A")).ok === true);
check(
  "le run de A s'est TERMINÉ côté serveur (sa réponse est persistée)",
  await waitForTranscript("sess-A", "REPONSE-TARDIVE-A"),
);
check(
  "une fois tout fini, A n'est plus marquée « en cours » dans la barre",
  await waitFor(
    `!document.querySelector('.conv[data-id="sess-A"]')?.classList.contains('conv--busy')`,
    4000,
  ),
  JSON.stringify({ busyA: (await readThread()).busyA }),
);

check("★ retour sur A après la fin de TOUT", await switchTo("sess-A"));
await sleep(300);
const afterAllDone = await readThread();
check(
  "★ PAS de faux « en cours » : l'indicateur d'attente est ÉTEINT",
  afterAllDone.thinkingHidden === true,
  JSON.stringify({ thinkingHidden: afterAllDone.thinkingHidden }),
);
check(
  "★ PAS de faux « en cours » : l'indicateur d'activité de fond est ÉTEINT",
  afterAllDone.jobActivityHidden === true,
  JSON.stringify({ hidden: afterAllDone.jobActivityHidden, text: afterAllDone.jobActivityText }),
);
check(
  "★ PAS de bloc d'activité ressuscité (le job est TERMINÉ)",
  afterAllDone.blocks === 0,
  JSON.stringify({ blocks: afterAllDone.blocks }),
);
check(
  "la réponse tardive est bien affichée dans le fil A",
  afterAllDone.thread.includes("REPONSE-TARDIVE-A"),
  afterAllDone.thread.slice(-160),
);

/* ══════════ 5) AUCUN SON D'UN FIL DE FOND (TTS muette) ══════════════════ */
await fetch(`${control}/spoken-reset`);
check("bascule vers B", await switchTo("sess-B"));
// Run de FOND (A) entièrement relâché : il streame pendant qu'on regarde B.
await controlRunHeld("sess-A", "VOIX-DU-FOND-INTERDITE", 4, 40);
await controlRelease("sess-A");
await waitForTranscript("sess-A", "VOIX-DU-FOND-INTERDITE");
await sleep(400);
const spokenAfterBg = await controlSpoken();
check(
  "le run de FOND n'a produit AUCUN segment audio",
  !spokenAfterBg.spoken.some((text) => text.includes("VOIX-DU-FOND-INTERDITE")),
  spokenAfterBg.spoken.join(" | ").slice(0, 200),
);
// Run du fil FOCALISÉ : la preuve n'est pas vide.
await controlRunHeld("sess-B", "VOIX-DU-FIL-COURANT", 4, 40);
await controlRelease("sess-B");
let currentSpoken = false;
for (let i = 0; i < 60; i += 1) {
  const spoken = await controlSpoken();
  if (spoken.spoken.some((text) => text.includes("VOIX-DU-FIL-COURANT"))) {
    currentSpoken = true;
    break;
  }
  await sleep(100);
}
check(
  "le fil FOCALISÉ parle bien (la preuve n'est pas vide)",
  currentSpoken,
  (await controlSpoken()).spoken.join(" ⏎ ").slice(0, 200),
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
