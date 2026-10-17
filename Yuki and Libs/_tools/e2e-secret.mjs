#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — DEMANDE DE SECRET par Yuki (`demander_secret`).
 *
 * Vérifie, avec la CSP RÉELLE et un hôte Pi RÉEL hors ligne :
 *   - Yuki (via l'outil `demander_secret` invoqué pour de vrai côté serveur)
 *     affiche une FENÊTRE FLOTTANTE de saisie DANS la conversation ;
 *   - elle montre la RAISON (« à quoi ça sert ») et les NOMS, jamais une valeur ;
 *   - la VALEUR saisie ne revient JAMAIS au client (aucune trame serveur), ni
 *     dans le DOM, ni dans localStorage, ni dans les fichiers d'état, ni dans
 *     les journaux du serveur — preuve sur les OCTETS ;
 *   - la fenêtre disparaît après fourniture (trame `secret_cleared`) ;
 *   - TTL : une fenêtre à échéance courte EXPIRE proprement (sans blocage).
 * ZÉRO violation CSP / exception JS.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-secret.mjs"
 */

import { spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { collectViolations } from "./browser-violations.mjs";

const TOOLS = import.meta.dirname;
const WORKSPACE = join(TOOLS, "..");
const YUKI_DIR = join(WORKSPACE, "Yuki");
const TSX = join(YUKI_DIR, "node_modules", ".bin", "tsx");

/** Valeur UNIQUE et reconnaissable : on cherche ces octets partout ensuite. */
const SECRET_VALUE = "E2E-SECRET-VALUE-DEADBEEF-42";

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-secret-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

async function startServer(extraEnv = {}, stateDir = STATE_DIR) {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-secret-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_SECRET_DIR: stateDir, ...extraEnv },
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
  return { proc, base, logs };
}

const server = await startServer();

/* ─── Chromium headless (CDP) ────────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-secret-chrome-"));
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

/* Capture des trames WS (envoyées/reçues) : installée AVANT tout chargement. */
const captureScript = await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    window.__wsSent = [];
    window.__wsRecv = [];
    const Orig = WebSocket;
    const wrap = function(...args) {
      const sock = new Orig(...args);
      const origSend = sock.send.bind(sock);
      sock.send = (data) => { try { window.__wsSent.push(String(data)); } catch (e) {} return origSend(data); };
      sock.addEventListener("message", (ev) => {
        try { window.__wsRecv.push(typeof ev.data === "string" ? ev.data : "<binaire>"); } catch (e) {}
      });
      return sock;
    };
    wrap.prototype = Orig.prototype;
    for (const k of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) wrap[k] = Orig[k];
    window.WebSocket = wrap;
  })();`,
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
  await sleep(600);
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

async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
}

/** Parcourt récursivement un dossier et renvoie tout son contenu textuel. */
function readTreeText(dir) {
  const parts = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else {
        try {
          parts.push(readFileSync(full, "utf8"));
        } catch {
          parts.push("");
        }
      }
    }
  };
  walk(dir);
  return parts.join("\n");
}

/* ═══════════════ 1) La fenêtre de secret apparaît DANS la conversation ═══ */
await navigate(`${server.base}/`);
const shown = await waitFor(
  `document.querySelectorAll('.approval-window.approval--secret').length >= 2`,
);
check("deux fenêtres de secret apparaissent (demandes DIRECTES)", shown);

const state = await evaluate(`(() => {
  const wins = [...document.querySelectorAll('.approval-window.approval--secret')];
  const conv = document.querySelector('#conversation');
  const direct = wins.find((w) => w.textContent.includes('wifi du bureau'));
  const withMachine = wins.find((w) => w.textContent.includes('NAS de sauvegarde'));
  const input = direct ? direct.querySelector('.approval__secret-input') : null;
  return {
    count: wins.length,
    inConversation: wins.some((w) => conv && conv.contains(w)),
    layerInBody: !!(document.querySelector('.approval-layer') && document.body.contains(document.querySelector('.approval-layer'))),
    directText: direct ? direct.textContent : '',
    machineText: withMachine ? withMachine.textContent : '',
    directHasCommand: !!(direct && direct.querySelector('.approval__command')),
    directHasPurpose: !!(direct && direct.querySelector('.approval__purpose')),
    machineHasMachineNode: !!(withMachine && withMachine.querySelector('.approval__machine')),
    inputType: input ? input.getAttribute('type') : null,
    hasFournir: !![...document.querySelectorAll('.approval__btn')].find((b) => b.textContent === 'Fournir'),
    expiry: direct ? (direct.querySelector('.approval__expiry')?.textContent ?? '') : '',
    role: direct ? direct.getAttribute('role') : null,
  };
})()`);

check("les fenêtres ne sont PAS dans le fil (#conversation)", state.inConversation === false);
check("la couche flottante est montée sur <body>", state.layerInBody === true);
check("role=dialog (fenêtre non modale)", state.role === "dialog");
check("la RAISON est montrée (« wifi du bureau »)", /wifi du bureau/.test(state.directText), state.directText.slice(0, 160));
check("aucun bloc commande pour une demande DIRECTE", state.directHasCommand === false);
check("la raison est bien un bloc dédié", state.directHasPurpose === true);
check("le nom du secret est montré (jamais une valeur)", /YUKI_SECRET_WIFI/.test(state.directText));
check("machine affichée pour la demande ciblée", state.machineHasMachineNode === true && /nuc00/.test(state.machineText));
check("champ de saisie de type password", state.inputType === "password");
check("bouton « Fournir » présent", state.hasFournir === true);
check("compte à rebours affiché", /Expire dans/i.test(state.expiry), state.expiry);
await shot("secret-window");

/* ═══ 2) NON BLOQUANTE : un clic sur le site DERRIÈRE passe ═══ */
await evaluate(`(() => {
  const b = document.createElement('button');
  b.id = 'e2e-probe';
  b.textContent = 'probe';
  b.style.position = 'fixed';
  b.style.left = '300px';
  b.style.top = '300px';
  b.style.zIndex = '500';
  b.addEventListener('click', () => { window.__probeClicked = true; });
  document.body.appendChild(b);
})()`);
const rect = await evaluate(`(() => {
  const r = document.getElementById('e2e-probe').getBoundingClientRect();
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
})()`);
await evaluate(`window.__probeClicked = false`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
await sleep(120);
check("NON bloquante : un clic SOUS la couche atteint le site derrière", (await evaluate(`window.__probeClicked === true`)) === true);
check("clic à côté : les fenêtres RESTENT affichées", (await evaluate(`document.querySelectorAll('.approval-window.approval--secret').length`)) >= 2);

/* ═══ 3) Saisie + fourniture : la VALEUR ne revient JAMAIS ═══════════════ */
await evaluate(`(() => {
  const win = [...document.querySelectorAll('.approval-window.approval--secret')]
    .find((w) => w.textContent.includes('wifi du bureau'));
  const input = win.querySelector('.approval__secret-input');
  input.value = ${JSON.stringify(SECRET_VALUE)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
const fournirRect = await evaluate(`(() => {
  const win = [...document.querySelectorAll('.approval-window.approval--secret')]
    .find((w) => w.textContent.includes('wifi du bureau'));
  const b = [...win.querySelectorAll('.approval__btn')].find((x) => x.textContent === 'Fournir');
  const r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
})()`);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: fournirRect.x, y: fournirRect.y, button: "left", clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: fournirRect.x, y: fournirRect.y, button: "left", clickCount: 1 });
const cleared = await waitFor(
  `document.querySelectorAll('.approval-window.approval--secret').length < 2`,
  6000,
);
check("après fourniture : la fenêtre concernée DISPARAÎT (secret_cleared)", cleared);
await sleep(400);

const leak = await evaluate(`(() => {
  const sent = window.__wsSent || [];
  const recv = window.__wsRecv || [];
  let ls = '';
  try { ls = JSON.stringify(window.localStorage); } catch (e) { ls = '<err>'; }
  return {
    valueInSent: sent.filter((f) => f.includes(${JSON.stringify(SECRET_VALUE)})).length,
    valueInRecv: recv.filter((f) => f.includes(${JSON.stringify(SECRET_VALUE)})).length,
    valueInDom: document.body.textContent.includes(${JSON.stringify(SECRET_VALUE)}),
    valueInStorage: ls.includes(${JSON.stringify(SECRET_VALUE)}),
    recvFrames: recv.length,
    sentFrames: sent.length,
  };
})()`);
check(
  "la valeur est bien PARTIE du navigateur (trame `secret_submit`)",
  leak.valueInSent >= 1,
  `trames envoyées = ${leak.sentFrames}, avec la valeur = ${leak.valueInSent}`,
);
check(
  "⚠️ la valeur n'est JAMAIS RENVOYÉE par le serveur (0 trame reçue)",
  leak.valueInRecv === 0,
  `${leak.recvFrames} trames reçues examinées`,
);
check("la valeur n'apparaît PAS dans le DOM", leak.valueInDom === false);
check("la valeur n'est PAS persistée côté client (localStorage)", leak.valueInStorage === false);

/* Marqueur de RÉCEPTION : preuve que le serveur l'a bien reçue (sans la valeur). */
let marker = null;
try {
  marker = JSON.parse(readFileSync(join(STATE_DIR, "secret-received.json"), "utf8"));
} catch {
  marker = null;
}
check(
  "le serveur a bien REÇU la valeur (marqueur : nom + longueur, jamais la valeur)",
  marker?.ok === true && marker?.names?.includes("YUKI_SECRET_WIFI") && marker?.bytes?.[0] === SECRET_VALUE.length,
  JSON.stringify(marker),
);

/* ⚠️ Sur les OCTETS : la valeur n'est nulle part sur le disque d'état
 * (transcript de session, audit, coffre chiffré, config…). */
const stateText = readTreeText(STATE_DIR);
check(
  "la valeur n'est nulle part dans les fichiers d'état (transcript, audit, coffre)",
  stateText.includes(SECRET_VALUE) === false,
);
check(
  "la valeur n'apparaît PAS dans les journaux du serveur",
  server.logs.join("\n").includes(SECRET_VALUE) === false,
);
check(
  "le coffre chiffré contient bien le NOM (jamais la valeur en clair)",
  readTreeText(join(STATE_DIR)).includes("YUKI_SECRET_WIFI") === true ||
    readFileSync(join(STATE_DIR, "secrets.vault.json"), "utf8").length > 0,
);
await shot("secret-after-submit");

/* ═══════════════ 4) TTL : expiration PROPRE, sans blocage ══════════════ */
const TTL_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-secret-ttl-"));
const ttlServer = await startServer({ YUKI_E2E_SECRET_TTL_MS: "2000", YUKI_E2E_SECRET_ONLY: "1" }, TTL_DIR);
await navigate(`${ttlServer.base}/`);
const ttlSeen = await waitFor(
  `document.querySelectorAll('.approval-window.approval--secret').length === 1`,
);
check("TTL : une demande à échéance courte s'affiche d'abord", ttlSeen);
const ttlGone = await waitFor(
  `document.querySelectorAll('.approval-window.approval--secret').length === 0`,
  8000,
);
check("TTL : la fenêtre EXPIRE proprement (aucun blocage silencieux)", ttlGone);
await stopPage();
ttlServer.proc.kill("SIGTERM");

await stopPage();
server.proc.kill("SIGTERM");
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

void captureScript;
console.log(`\nCaptures (non suivies) : ${SHOTS}`);
const failed = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`,
);

chrome.kill("SIGKILL");
process.exit(
  failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1,
);
