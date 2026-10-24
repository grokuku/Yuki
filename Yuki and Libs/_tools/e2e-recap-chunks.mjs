#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — « Récapitulatif d'une conversation VOLUMINEUSE ».
 *
 * Prouve, avec la CSP RÉELLE, un hôte Pi RÉEL et un générateur de récapitulatif
 * FACTICE, que la découpe fonctionne de bout en bout sur une conversation PLUS
 * LONGUE QUE LA LIMITE :
 *   - la PROGRESSION est VISIBLE pendant la génération (l'attente annonce la
 *     partie en cours : plusieurs appels modèle) ;
 *   - l'APERÇU montre le récapitulatif COMPLET, assemblé en parties SIGNALÉES ;
 *   - un fait de la PREMIÈRE tranche ET un fait de la DERNIÈRE sont TOUS DEUX
 *     présents (rien n'est perdu aux joints) ;
 *   - l'ORDRE des parties est respecté ;
 *   - la création ouvre une conversation portant le récapitulatif complet ;
 *   - ZÉRO violation CSP / exception JS / erreur de connexion.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-recap-chunks.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { collectViolations } from "./browser-violations.mjs";

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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-recap-chunks-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });
const SESSIONS_DIR = join(STATE_DIR, "agent", "sessions");

/* ─── Démarrage du gateway de test (mode « conversation longue ») ───────── */
async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-recap-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_RECAP_DIR: STATE_DIR, YUKI_E2E_RECAP_LONG: "1" },
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

/** Contenu des sessions persistées (fichiers `.jsonl`), pour comparer l'origine. */
function snapshotSessions() {
  const map = {};
  for (const name of readdirSync(SESSIONS_DIR)) {
    if (!name.endsWith(".jsonl")) continue;
    map[name] = readFileSync(join(SESSIONS_DIR, name), "utf8");
  }
  return map;
}

/* ─── Chromium headless (CDP) ────────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-recap-chunks-chrome-"));
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
  await sleep(700);
}

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error("eval: " + (res.exceptionDetails.exception?.description || "exception"));
  }
  return res.result.value;
}

async function waitFor(expression, timeout = 15000) {
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

async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
}

const clickByText = (selector, text) =>
  evaluate(`(() => {
    const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.includes(${JSON.stringify(text)}));
    if (!b) return false;
    b.click();
    return true;
  })()`);

/* ═══════════════════════ 1) Page chargée ═════════════════════════════════ */
await navigate(`${server.base}/`);
check("la conversation volumineuse s'affiche", await waitFor(`document.querySelectorAll('.conv').length >= 1`));
const originBefore = snapshotSessions();
check("la session volumineuse est persistée", Object.keys(originBefore).length >= 1, `${Object.keys(originBefore).length} fichier(s)`);

/* ═══════════════════ 2) Déclencheur + sujet (VIDE) ═══════════════════════ */
check(
  "« Conversation dédiée… » est dans le MENU DU TITRE (plus près du bouton stop), via le clic droit",
  (await evaluate(`(() => {
    const item = document.querySelector('.conv--active') || document.querySelector('.conv');
    if (!item) return false;
    const r = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 12, clientY: r.top + 12 }));
    const b = [...document.querySelectorAll('.ctx-menu__item')].find((x) => x.textContent.trim().startsWith('Conversation dédiée'));
    const nearStop = !!document.querySelector('.composer #recap-dedicated');
    return Boolean(b) && !b.disabled && !nearStop;
  })()`)) === true,
);
await clickByText(".ctx-menu__item", "Conversation dédiée");
check("la saisie du SUJET s'ouvre (HolafModal)", await waitFor(`!!document.querySelector('.holaf-modal-input')`));
// Sujet VIDE : on récapitule TOUTE la conversation (le cas de l'utilisateur).
await clickByText(".holaf-modal-btn", "Générer le récapitulatif");

/* ═══════════════ 3) PROGRESSION VISIBLE (plusieurs appels) ═══════════════ */
const sawProgress = await waitFor(
  `(() => {
    const el = document.querySelector('.holaf-modal-message');
    return !!el && /partie\\s+\\d+\\/\\d+/.test(el.textContent);
  })()`,
  8000,
);
const progressText = await evaluate(
  `(document.querySelector('.holaf-modal-message')?.textContent ?? '')`,
);
check("l'attente annonce la PARTIE en cours (progression visible)", sawProgress, progressText);
await shot("recap-chunks-progress");

/* ═══════════════════ 4) APERÇU : récapitulatif COMPLET ═══════════════════ */
check("l'APERÇU s'affiche", await waitFor(`!!document.querySelector('.recap-modal__body')`, 20000));
const preview = await evaluate(`(() => {
  const body = document.querySelector('.recap-modal__body')?.value ?? '';
  const info = document.querySelector('.recap-modal__info')?.textContent ?? '';
  const p1 = body.indexOf('— Partie 1/2 —');
  const p2 = body.indexOf('— Partie 2/2 —');
  return { body, info, p1, p2 };
})()`);
check(
  "aperçu : le fait de la PREMIÈRE tranche est présent",
  preview.body.includes("FAIT-PREMIER-TRANCHE"),
);
check(
  "aperçu : le fait de la DERNIÈRE tranche est présent (rien perdu au joint)",
  preview.body.includes("FAIT-DERNIER-TRANCHE"),
);
check(
  "aperçu : les parties sont SIGNALÉES et DANS L'ORDRE",
  preview.p1 >= 0 && preview.p2 > preview.p1,
  `p1=${preview.p1} p2=${preview.p2}`,
);
check("aperçu : l'info annonce l'assemblage en parties", /parties/i.test(preview.info), preview.info);
await shot("recap-chunks-preview");

/* ═══════════════════ 5) Création de la conversation ══════════════════════ */
await clickByText(".holaf-modal-btn", "Créer la conversation");
check("le bloc de récapitulatif apparaît dans le fil", await waitFor(`!!document.querySelector('#conversation .message--recap')`, 20000));
const created = await evaluate(`(() => {
  const block = document.querySelector('#conversation .message--recap');
  return {
    text: block ? block.textContent : '',
    inUserBubble: [...document.querySelectorAll('.message--user')].some((m) => m.textContent.includes('FAIT-PREMIER-TRANCHE')),
  };
})()`);
check(
  "le bloc créé contient les DEUX faits (première ET dernière tranche)",
  created.text.includes("FAIT-PREMIER-TRANCHE") && created.text.includes("FAIT-DERNIER-TRANCHE"),
);
check("il n'est PAS dans une bulle utilisateur", created.inUserBubble === false);
await shot("recap-chunks-created");

/* ═══════════════════ 6) L'origine n'est PAS modifiée ═════════════════════ */
const originAfter = snapshotSessions();
const changed = Object.keys(originBefore).filter((name) => originAfter[name] !== originBefore[name]);
check("le fichier de la conversation d'ORIGINE est INCHANGÉ", changed.length === 0, changed.join(", "));

await stopPage();
server.proc.kill("SIGTERM");
await sleep(300);

/* ═══════════════════════ Bilan CSP / exceptions ══════════════════════════ */
const { cspViolations, connectionErrors } = collectViolations(consoleMessages, logEntries);
check(
  "ZÉRO erreur de connexion réseau (serveur indisponible)",
  connectionErrors.length === 0,
  connectionErrors.map((v) => v.text).join(" | ").slice(0, 300),
);
check("ZÉRO violation CSP", cspViolations.length === 0, cspViolations.map((v) => v.text).join(" | "));
check("ZÉRO exception JS non capturée", pageExceptions.length === 0, pageExceptions.join(" | ").slice(0, 300));

console.log(`\nCaptures (non suivies) : ${SHOTS}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`);

chrome.kill("SIGKILL");
process.exit(failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1);
