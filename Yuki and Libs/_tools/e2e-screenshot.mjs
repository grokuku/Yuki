#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — capture d'écran DANS la conversation.
 *
 * Vérifie, avec la CSP RÉELLE et un hôte Pi RÉEL hors ligne : l'`<img data:>`
 * s'affiche DANS le fil (donc `img-src 'self' data:` suffit — AUCUN
 * élargissement), le bloc porte les métadonnées (machine, dimensions, taille),
 * il DISPARAÎT au rechargement (état ÉPHÉMÈRE, jamais dans le snapshot) et
 * ZÉRO violation CSP / exception JS.
 *
 * ⚠️ Les captures d'écran du navigateur vont dans un dossier TEMPORAIRE : aucune
 * PNG suivie n'est régénérée.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-screenshot.mjs"
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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-shot-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-screenshot-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_SHOT_DIR: STATE_DIR },
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
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-shot-chrome-"));
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
  await sleep(800);
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

/**
 * Attend le DÉCODAGE RÉEL de l'image `data:` de capture.
 *
 * ⚠️ La PRÉSENCE du nœud dans le DOM ne prouve PAS que l'image est décodée : le
 * décodage d'une image est ASYNCHRONE (et `loading="lazy"` peut en plus différer
 * le chargement jusqu'au viewport). Lire `img.complete`/`naturalWidth` juste
 * après l'insertion du nœud était donc une COURSE — d'où l'instabilité.
 *
 * On s'appuie sur `img.decode()` : la promesse se résout EXACTEMENT quand
 * l'image est décodée et prête à être peinte (garantie plus forte qu'un simple
 * `complete`). Pour une image CASSÉE `decode()` REJETTE : on rend `false` sans
 * attendre le timeout, ce qui laisse l'assertion échouer. La boucle n'est qu'un
 * filet borné si le décodage n'aboutit jamais.
 */
async function waitForImageDecoded(timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const status = await evaluate(`(async () => {
      const img = document.querySelector('.screenshot__image');
      if (!img) return 'absent';
      try { await img.decode(); } catch { return 'broken'; }
      return (img.complete && img.naturalWidth > 0) ? 'ready' : 'pending';
    })()`);
    if (status === "ready") return true;
    if (status === "broken" || status === "absent") return false;
    await sleep(50);
  }
  return false;
}

async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
}

const shotState = () =>
  evaluate(`(() => {
    const conv = document.querySelector('#conversation');
    const block = document.querySelector('.screenshot');
    const img = document.querySelector('.screenshot__image');
    return {
      inConversation: Boolean(block && conv && conv.contains(block)),
      isMessage: block ? block.classList.contains('message') : false,
      text: block ? block.textContent : '',
      imgSrcPrefix: img ? img.getAttribute('src').slice(0, 22) : null,
      imgClass: img ? img.className : null,
      imgLoaded: img ? (img.complete && img.naturalWidth > 0) : false,
      blockStyle: block ? block.getAttribute('style') : null,
      imgStyle: img ? img.getAttribute('style') : null,
    };
  })()`);

/* ═══════════════ 1) La capture s'affiche DANS la conversation ═══════════ */
await navigate(`${server.base}/`);
// Le client WS doit être branché avant l'émission : on attend un marqueur du fil.
await waitFor(`!!document.querySelector('#conversation')`);
await fetch(`${server.base}/e2e/shot`);
const shown = await waitFor(`!!document.querySelector('.screenshot__image')`);
check("l'image de capture s'affiche dans le fil", shown);
// ⚠️ Attendre le DÉCODAGE (pas seulement la présence du nœud) : c'est ce qui
// supprime la course. L'assertion « image RÉELLEMENT rendue » reste INCHANGÉE.
await waitForImageDecoded(5000);
const state = await shotState();
check("le bloc est DANS la conversation (#conversation)", state.inConversation === true);
check("ce n'est PAS un message (état temporaire)", state.isMessage === false);
check("machine : nom + identifiant", /nuc00/.test(state.text) && /agent-nuc00/.test(state.text), state.text.slice(0, 120));
check("métadonnées affichées (dimensions × taille)", /1280×720/.test(state.text) && /~140 Ko/.test(state.text), state.text.slice(0, 200));
check("mention « temporaire » (jamais conservée)", /temporaire/i.test(state.text), state.text.slice(0, 200));
check("source = data:image/ (CSP `img-src 'self' data:`)", state.imgSrcPrefix === "data:image/jpeg;base64", String(state.imgSrcPrefix));
check("image RÉELLEMENT rendue par le navigateur", state.imgLoaded === true);
check("classe `.md-image` (chemin markdown réutilisé)", String(state.imgClass).includes("md-image"), String(state.imgClass));
check("aucun attribut de style (CSP `style-src 'self'`)", state.blockStyle === null && state.imgStyle === null);
await shot("screenshot-block");

/* ═══════════════ 2) Rechargement : la capture NE revient PAS ════════════ */
await navigate(`${server.base}/`);
await sleep(800);
const afterReload = await evaluate(`(() => ({
  count: document.querySelectorAll('.screenshot').length,
  imgs: document.querySelectorAll('img[src^="data:"]').length,
  thread: document.querySelector('#conversation')?.textContent ?? '',
}))()`);
check("rechargement : plus AUCUN bloc de capture", afterReload.count === 0, String(afterReload.count));
check("rechargement : aucune image data: dans le fil", afterReload.imgs === 0, String(afterReload.imgs));
check("rechargement : aucun résidu textuel", !/Capture temporaire/i.test(afterReload.thread), afterReload.thread.slice(0, 120));
await shot("screenshot-after-reload");

/* ═══════════════ 3) Un second rechargement : toujours rien ══════════════ */
await navigate(`${server.base}/`);
await sleep(600);
const afterReload2 = await evaluate(`document.querySelectorAll('.screenshot').length`);
check("second rechargement : toujours rien (état éphémère)", afterReload2 === 0, String(afterReload2));

server.proc.kill("SIGTERM");
await sleep(300);

/* ═══════════════════════ Bilan CSP / exceptions ══════════════════════════ */
const cspViolations = [
  ...consoleMessages.filter((m) => /refused|content security policy|csp/i.test(m.text)),
  ...logEntries.filter(
    (e) => /refused|content security policy|csp/i.test(e.text) || e.source === "security",
  ),
];
check("ZÉRO violation CSP", cspViolations.length === 0, cspViolations.map((v) => v.text).join(" | "));
check(
  "ZÉRO exception JS non capturée",
  pageExceptions.length === 0,
  pageExceptions.join(" | ").slice(0, 300),
);

chrome.kill("SIGTERM");

console.log(`\nCaptures (temporaires, non suivies) : ${SHOTS}`);
const failed = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`,
);
process.exit(failed.length === 0 ? 0 : 1);
