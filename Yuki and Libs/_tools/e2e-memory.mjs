#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — bloc « Réinitialiser la mémoire » de l'onglet
 * Personnalité (/config), rendu en Chromium headless via CDP avec la CSP RÉELLE.
 *
 * Vérifie : le bloc s'affiche (distinct), le texte d'avertissement, l'ouverture
 * de la modale HolafModal de confirmation, le libellé explicite, l'archivage
 * RÉEL (le fichier d'origine ne contient plus les souvenirs, l'archive les
 * contient), le retour visuel (chemin d'archive), l'état mémoire à zéro, et
 * ZÉRO violation CSP / exception JS.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-memory.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const TOOLS = import.meta.dirname;
const WORKSPACE = join(TOOLS, "..");
const YUKI_DIR = join(WORKSPACE, "Yuki");
const TSX = join(YUKI_DIR, "node_modules", ".bin", "tsx");
const SHOTS = join(TOOLS, "shots");
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-memory-"));
const SEED_A = "L'utilisateur aime les crêpes bretonnes";
const SEED_B = "L'utilisateur habite à Rennes";

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-memory-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_MEMORY_DIR: STATE_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString()));
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("serveur non démarré :\n" + logs.join(""))), 30_000);
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
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-memory-chrome-"));
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
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1100, deviceScaleFactor: 1, mobile: false });

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
  await sleep(800);
}

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error("eval: " + (res.exceptionDetails.exception?.description || "exception"));
  }
  return res.result.value;
}

async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
  console.log(`📷 capture : _tools/shots/${name}.png`);
}

/* ═══════════════════════ 1) Bloc affiché, distinct ═══════════════════════ */
await navigate(`${server.base}/config#personnalite`);
const block = await evaluate(`(() => {
  const active = [...document.querySelectorAll('[role=tab]')].find((t) => t.getAttribute('aria-selected') === 'true')?.id;
  const panel = document.getElementById('panel-personnalite');
  const mem = document.querySelector('.personality-memory');
  return {
    active,
    visible: panel ? !panel.hidden : false,
    hasBlock: !!mem,
    title: mem?.querySelector('.personality-memory__title')?.textContent ?? '',
    warning: mem?.querySelector('.personality-memory__warning')?.textContent ?? '',
    button: [...(mem?.querySelectorAll('button') ?? [])].map((b) => b.textContent),
    count: mem?.querySelector('.config-helper')?.textContent ?? '',
    styleAttrs: document.body.querySelectorAll('[style]').length,
  };
})()`);
check("[/config#personnalite] onglet actif et panneau visible", block.active === "tab-personnalite" && block.visible === true, JSON.stringify(block).slice(0, 200));
check("[/config#personnalite] bloc mémoire présent et distinct", block.hasBlock === true);
check("[/config#personnalite] titre « Mémoire durable »", block.title === "Mémoire durable", block.title);
check("[/config#personnalite] avertissement : personnalité NON touchée", /personnalit/i.test(block.warning) && /vie antérieure/i.test(block.warning), block.warning.slice(0, 180));
check("[/config#personnalite] bouton « Réinitialiser la mémoire »", block.button.includes("Réinitialiser la mémoire"), JSON.stringify(block.button));
check("[/config#personnalite] 2 souvenirs annoncés", /2 souvenir/.test(block.count), block.count);
check("[/config#personnalite] aucune style= inline (CSP)", block.styleAttrs === 0, String(block.styleAttrs));
await shot("memory-e2e-block");

/* ═══════════════ 2) Modale HolafModal + libellé explicite ═══════════════ */
await evaluate(`(() => { [...document.querySelectorAll('.personality-memory button')].find((b) => b.textContent === 'Réinitialiser la mémoire')?.click(); })()`);
await sleep(500);
const modal = await evaluate(`(() => {
  const title = document.querySelector('.holaf-modal-title')?.textContent ?? '';
  const message = document.querySelector('.holaf-modal-message')?.textContent ?? '';
  const danger = [...document.querySelectorAll('.holaf-modal-btn')].find((b) => b.textContent === 'Archiver et réinitialiser');
  return { title, message, hasDanger: !!danger, dangerClass: danger?.className ?? '' };
})()`);
check("[/config#personnalite] confirmation via HolafModal (pas window.confirm)", modal.title.length > 0, modal.title);
check("[/config#personnalite] libellé de modale explicite (archivage)", /archiv/i.test(modal.title + " " + modal.message), modal.title);
check("[/config#personnalite] la modale dit OÙ (dossier memory-archive)", /memory-archive/.test(modal.message), modal.message.slice(0, 200));
check("[/config#personnalite] bouton de danger « Archiver et réinitialiser »", modal.hasDanger === true && /danger/.test(modal.dangerClass), modal.dangerClass);
await shot("memory-e2e-modal");

/* ═══════════════════ 3) Confirmation ⇒ archivage réel ═══════════════════ */
await evaluate(`(() => { [...document.querySelectorAll('.holaf-modal-btn')].find((b) => b.textContent === 'Archiver et réinitialiser')?.click(); })()`);
await sleep(1500);
const after = await evaluate(`(() => {
  const mem = document.querySelector('.personality-memory');
  return {
    status: mem?.querySelector('.config-save-status')?.textContent ?? '',
    buttonDisabled: [...(mem?.querySelectorAll('button') ?? [])].some((b) => b.disabled),
    styleAttrs: document.body.querySelectorAll('[style]').length,
  };
})()`);
check("[/config#personnalite] retour visuel : archive + destination", /archiv/i.test(after.status) && /memory-archive/.test(after.status), after.status.slice(0, 200));
check("[/config#personnalite] bouton désactivé (mémoire vide)", after.buttonDisabled === true);
check("[/config#personnalite] aucune style= inline après archivage", after.styleAttrs === 0, String(after.styleAttrs));
await shot("memory-e2e-after");

const apiState = await fetch(`${server.base}/api/memory`).then((r) => r.json());
check("[API] l'état mémoire repart à zéro", apiState.entries === 0, JSON.stringify(apiState));

/* ─── Preuves DISQUE : archive présente, mémoire repartie propre ─────────── */
const archiveDir = join(STATE_DIR, "memory-archive");
const archives = readdirSync(archiveDir);
check("[disque] une archive horodatée a été créée", archives.length === 1 && /^memory-.*\.jsonl$/.test(archives[0] ?? ""), archives.join(","));
const archivedContent = readFileSync(join(archiveDir, archives[0]), "utf8");
check("[disque] l'archive contient les souvenirs", archivedContent.includes(SEED_A) && archivedContent.includes(SEED_B));
const memoryContent = readFileSync(join(STATE_DIR, "memory.jsonl"), "utf8");
check("[disque] le fichier de mémoire ne contient PLUS les souvenirs", !memoryContent.includes(SEED_A) && !memoryContent.includes(SEED_B));

/* ─── Intactude : personnalité et archive « vie antérieure » ─────────────── */
const personality = readFileSync(join(STATE_DIR, "personality.md"), "utf8");
check("[disque] la personnalité est INTACTE", personality.includes("Je suis Yuki"));
check("[disque] l'archive « vie antérieure » n'existe pas / n'est pas touchée", !readdirSync(STATE_DIR).includes("memory-heritage"), readdirSync(STATE_DIR).join(","));

server.proc.kill("SIGTERM");
await sleep(300);

/* ═══════════════════════ Bilan CSP / exceptions ═══════════════════════════ */
const cspViolations = [
  ...consoleMessages.filter((m) => /refused|content security policy|csp/i.test(m.text)),
  ...logEntries.filter((e) => /refused|content security policy|csp/i.test(e.text) || e.source === "security"),
];
check("ZÉRO violation CSP", cspViolations.length === 0, cspViolations.map((v) => v.text).join(" | "));
check("ZÉRO exception JS non capturée", pageExceptions.length === 0, pageExceptions.join(" | ").slice(0, 300));
console.log(`\nMessages console : ${consoleMessages.length} ; entrées Log : ${logEntries.length}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`);

chrome.kill("SIGKILL");
process.exit(failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1);
