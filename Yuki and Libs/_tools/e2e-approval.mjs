#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — validation humaine DANS la conversation (D118).
 *
 * Vérifie, avec la CSP RÉELLE et un hôte Pi RÉEL hors ligne : le bloc de
 * validation apparaît DANS le fil (machine + ID + commande exacte + motif
 * destructeur + compte à rebours), il RÉAPPARAÎT au rechargement tant qu'il est
 * en attente, VALIDER le fait disparaître et affiche le résultat, et une fois
 * décidé il ne revient PLUS (ni bloc ni résidu dans l'historique). ZÉRO violation
 * CSP / exception JS.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-approval.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const TOOLS = import.meta.dirname;
const WORKSPACE = join(TOOLS, "..");
const YUKI_DIR = join(WORKSPACE, "Yuki");
const TSX = join(YUKI_DIR, "node_modules", ".bin", "tsx");

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-approval-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-approval-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_APPROVAL_DIR: STATE_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString()));
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("serveur non démarré :\n" + logs.join(""))), 40_000);
    const onData = () => {
      const m = logs.join("").match(/READY (http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1].trim());
      }
    };
    proc.stdout.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serveur quitté (${code}) :\n` + logs.join("")));
    });
  });
  return { proc, base };
}

const server = await startServer();

/* ─── Chromium headless (CDP) ────────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-approval-chrome-"));
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
    logEntries.push({ source: msg.params.entry.source, level: msg.params.entry.level, text: msg.params.entry.text });
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
  await sleep(600);
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

async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
}

const blockState = () =>
  evaluate(`(() => {
    const conv = document.querySelector('#conversation');
    const block = document.querySelector('.approval:not(.approval--result)');
    const result = document.querySelector('.approval--result');
    return {
      inConversation: Boolean(block && conv && conv.contains(block)),
      isMessage: block ? block.classList.contains('message') : false,
      text: block ? block.textContent : '',
      hasValider: !![...document.querySelectorAll('.approval__btn')].find((b) => b.textContent === 'Valider'),
      hasRefuser: !![...document.querySelectorAll('.approval__btn')].find((b) => b.textContent === 'Refuser'),
      resultText: result ? result.textContent : '',
      blockStyle: block ? block.getAttribute('style') : null,
    };
  })()`);

/* ═══════════════ 1) Le bloc apparaît DANS la conversation ═══════════════ */
await navigate(`${server.base}/`);
const shown = await waitFor(`!!document.querySelector('.approval:not(.approval--result)')`);
check("le bloc de validation apparaît", shown);
const state = await blockState();
check("il est DANS la conversation (#conversation)", state.inConversation === true);
check("ce n'est PAS un message (état temporaire)", state.isMessage === false);
check("machine : nom + identifiant", /nuc00/.test(state.text) && /agent-nuc00/.test(state.text), state.text.slice(0, 120));
check("commande EXACTE affichée", state.text.includes("rm -rf /srv/cache"));
check("motif destructeur expliqué", state.text.includes("suppression (rm)"), state.text.slice(0, 200));
check("expiration mentionnée (compte à rebours)", /Expire dans/i.test(state.text), state.text.slice(0, 200));
check("boutons Valider ET Refuser", state.hasValider && state.hasRefuser);
check("aucun attribut de style sur le bloc (CSP)", state.blockStyle === null, String(state.blockStyle));
await shot("approval-block");

/* ═══════════════ 2) Rechargement : réapparaît tant qu'en attente ═════════ */
await navigate(`${server.base}/`);
check("rechargement : le bloc réapparaît (demande encore en attente)", await waitFor(`!!document.querySelector('.approval:not(.approval--result)')`));

/* ═══════════════ 3) Valider ⇒ bloc disparaît + résultat affiché ═════════ */
await evaluate(`[...document.querySelectorAll('.approval__btn')].find((b) => b.textContent === 'Valider').click()`);
const decided = await waitFor(`!!document.querySelector('.approval--result')`);
check("valider : le bloc de validation disparaît et le résultat s'affiche", decided);
const afterDecision = await evaluate(`(() => ({
  validation: document.querySelectorAll('.approval:not(.approval--result)').length,
  resultText: document.querySelector('.approval--result')?.textContent ?? '',
}))()`);
check("valider : plus AUCUN bloc de validation", afterDecision.validation === 0, String(afterDecision.validation));
check("valider : le résultat montre la sortie", /suppression effectuée/.test(afterDecision.resultText), afterDecision.resultText.slice(0, 160));
await shot("approval-result");

/* ═══════════════ 4) Rechargement après décision : plus rien ══════════════ */
await navigate(`${server.base}/`);
await sleep(800);
const afterReload = await evaluate(`(() => ({
  any: document.querySelectorAll('.approval').length,
  thread: document.querySelector('#conversation')?.textContent ?? '',
}))()`);
check("rechargement APRÈS décision : aucun bloc ne revient", afterReload.any === 0, String(afterReload.any));
check(
  "aucun résidu dans l'historique (pas de « Validation requise »)",
  !/Validation requise/i.test(afterReload.thread),
  afterReload.thread.slice(0, 120),
);
await shot("approval-after-reload");

server.proc.kill("SIGTERM");
await sleep(300);

/* ═══════════════════════ Bilan CSP / exceptions ══════════════════════════ */
const cspViolations = [
  ...consoleMessages.filter((m) => /refused|content security policy|csp/i.test(m.text)),
  ...logEntries.filter((e) => /refused|content security policy|csp/i.test(e.text) || e.source === "security"),
];
check("ZÉRO violation CSP", cspViolations.length === 0, cspViolations.map((v) => v.text).join(" | "));
check("ZÉRO exception JS non capturée", pageExceptions.length === 0, pageExceptions.join(" | ").slice(0, 300));

console.log(`\nCaptures (non suivies) : ${SHOTS}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`);

chrome.kill("SIGKILL");
process.exit(failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1);
