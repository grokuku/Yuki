#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — TRANSFERT DE FICHIERS DEPUIS UNE MACHINE (navigateur RÉEL).
 *
 * Vérifie, avec la CSP RÉELLE, un stockage RÉEL et un VRAI service de transfert
 * (faux agent qui sert un fichier) :
 *  1. `POST /e2e/fetch-file` récupère un fichier depuis la machine simulée :
 *     il est ÉCRIT SUR LE DISQUE de Yuki (métadonnées vérifiables) et le contenu
 *     est intact ;
 *  2. la trame de CONTRÔLE `file_received` fait apparaître une CARTE de fichier
 *     dans le fil, avec la machine d'origine, un bouton de téléchargement et le
 *     bouton « Inclure dans la discussion » ;
 *  3. le clic sur « Inclure dans la discussion » ajoute le fichier à la liste des
 *     pièces jointes (puce de la zone de saisie) et désactive le bouton ;
 *  4. `scrollTop` du fil est PRÉSERVÉ quand on est remonté (état sticky et
 *     position inchangés, PIÈGE ③) ;
 *  5. ZÉRO violation CSP, ZÉRO erreur réseau, ZÉRO exception JS.
 *
 * ⚠️ Aucune capture PNG n'est écrite dans le dépôt : tout va dans un dossier
 * temporaire.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-file-transfer.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-transfer-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

/* ─── Serveur ────────────────────────────────────────────────────────────── */
async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-file-transfer-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_FILES_DIR: STATE_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString()));
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("serveur non démarré :\n" + logs.join(""))),
      40_000,
    );
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
const REMOTE = await fetch(`${server.base}/e2e/state`).then((r) => r.json());
const PICKED = await fetch(
  `${server.base}/e2e/fetch-file?path=/home/user/rapport.txt`,
  { method: "POST" },
).then((r) => r.json());

check(
  "le transfert récupère le fichier depuis la machine simulée",
  PICKED.status === "completed",
  JSON.stringify(PICKED).slice(0, 200),
);
check(
  "le fichier est ÉCRIT sur le disque de Yuki avec son nom et sa taille",
  Boolean(PICKED.file?.id) &&
    PICKED.file.name === "rapport.txt" &&
    PICKED.file.bytes === Buffer.byteLength(REMOTE.remoteContent, "utf8"),
  JSON.stringify(PICKED.file),
);
const storedBytes = await fetch(`${server.base}${PICKED.file.url}`).then((r) =>
  r.arrayBuffer(),
);
check(
  "le contenu récupéré est INTACT (octets identiques à la machine)",
  Buffer.from(storedBytes).toString("utf8") === REMOTE.remoteContent,
);

/* ─── Chromium headless (CDP) ─────────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-transfer-chrome-"));
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
const pageTarget = listTargets.find((t) => t.type === "page");
if (!pageTarget) throw new Error("aucune cible page");
const ws = new WebSocket(pageTarget.webSocketDebuggerUrl, {
  maxPayload: 256 * 1024 * 1024,
});
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
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
  }
  return result.result.value;
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
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
}

async function mouseClick(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  await sleep(150);
}

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await send("Page.navigate", { url: `${server.base}/` });
await waitFor(`document.readyState === 'complete'`, 15_000);
await waitFor(`document.getElementById('input') !== null`, 8000);

/* ═══════════ 2) LA CARTE DE FICHIER RÉCUPÉRÉ apparaît dans le fil ════════ */
// ⚠️ On RECHARGE la page APRÈS le transfert : la trame `file_received` est une
// trame de CONTRÔLE (jamais bufferisée) — la carte n'est donc visible qu'en
// direct, elle n'est PAS restaurée par le snapshot. On déclenche donc un SECOND
// transfert alors que la page est ouverte.
const picked2 = await fetch(
  `${server.base}/e2e/fetch-file?path=/home/user/capture.txt`,
  { method: "POST" },
).then((r) => r.json());
check("second transfert réussi (page ouverte)", picked2.status === "completed");

const cardAppeared = await waitFor(
  `document.querySelector('.file-card--agent') !== null`,
  8000,
);
check("la CARTE de fichier récupéré apparaît dans le fil", cardAppeared);
const cardInfo = await evaluate(`(() => {
  const card = document.querySelector('.file-card--agent');
  if (!card) return null;
  return {
    hasOrigin: Boolean(card.querySelector('.file-card__origin')),
    originText: card.querySelector('.file-card__origin')?.textContent ?? '',
    hasDownload: Boolean(card.querySelector('.file-card__download')),
    hasInclude: Boolean(card.querySelector('.file-card__include')),
    includeText: card.querySelector('.file-card__include-label')?.textContent ?? '',
  };
})()`);
check(
  "la carte affiche la MACHINE d'origine",
  Boolean(cardInfo?.hasOrigin) && /machine/i.test(cardInfo?.originText ?? ""),
  JSON.stringify(cardInfo),
);
check("la carte propose le TÉLÉCHARGEMENT", Boolean(cardInfo?.hasDownload));
check(
  "la carte porte le bouton « Inclure dans la discussion »",
  Boolean(cardInfo?.hasInclude) && cardInfo?.includeText === "Inclure dans la discussion",
  JSON.stringify(cardInfo),
);
await shot("transfer-card");

/* ══════════ 3) Le clic « Inclure » ajoute le fichier aux pièces jointes ═══ */
// ⚠️ PIÈGE ③ : on remonte d'abord le fil (scroll) pour vérifier que `scrollTop`
// est PRÉSERVÉ après l'ajout.
await evaluate(`(() => {
  document.getElementById('conversation').scrollTop = 0;
})()`);
const beforeScroll = await evaluate(
  `document.getElementById('conversation').scrollTop`,
);
const box = await evaluate(`(() => {
  const b = document.querySelector('.file-card__include');
  const r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
await mouseClick(box.x, box.y);
await sleep(300);
const afterScroll = await evaluate(
  `document.getElementById('conversation').scrollTop`,
);
const included = await evaluate(`(() => {
  const chips = document.querySelectorAll('.pending-file:not(.pending-file--waiting) .pending-file__name');
  const names = Array.from(chips).map((c) => c.textContent);
  const btn = document.querySelector('.file-card__include');
  return { names, disabled: btn?.disabled ?? false, label: btn?.querySelector('.file-card__include-label')?.textContent ?? '' };
})()`);
check(
  "le clic ajoute le fichier à la liste des pièces jointes",
  (included.names ?? []).includes("capture.txt"),
  JSON.stringify(included),
);
check(
  "le bouton est DÉSACTIVÉ après inclusion (aucun double envoi)",
  included.disabled === true && included.label === "Ajouté à la discussion",
  JSON.stringify(included),
);
check(
  "le clic ne provoque AUCUN ajout au message sans action de l'utilisateur",
  await evaluate(`document.getElementById('input').value === ''`),
);
check(
  "scrollTop du fil est préservé (jamais remis en bas de force)",
  Math.abs(afterScroll - beforeScroll) < 4,
  JSON.stringify({ beforeScroll, afterScroll }),
);
await shot("transfer-included");

await send("Page.close").catch(() => undefined);

/* ═════════════════════== Bilan CSP / exceptions ═════════════════════════ */
const { cspViolations, connectionErrors } = collectViolations(
  consoleMessages,
  logEntries,
);
check(
  "ZÉRO erreur de connexion réseau (serveur indisponible)",
  connectionErrors.length === 0,
  connectionErrors.map((v) => v.text).join(" | ").slice(0, 300),
);
check(
  "ZÉRO violation CSP",
  cspViolations.length === 0,
  cspViolations.map((v) => v.text).join(" | "),
);
check(
  "ZÉRO exception JS non capturée",
  pageExceptions.length === 0,
  pageExceptions.join(" | ").slice(0, 300),
);

chrome.kill("SIGTERM");
server.proc.kill("SIGTERM");

console.log(`\nCaptures (temporaires, non suivies) : ${SHOTS}`);
const failed = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`,
);
process.exit(failed.length === 0 ? 0 : 1);
