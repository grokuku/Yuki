#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — PWA + Web Push (notifications).
 *
 * Prouve, en Chromium headless avec la CSP RÉELLE :
 *   - le manifeste est SERVI (type MIME correct) et DÉCLARÉ par l'index ;
 *   - le service worker `/sw.js` est SERVI à la racine, en JavaScript (jamais
 *     la page HTML d'un forward-auth), et S'ENREGISTRE puis s'ACTIVE ;
 *   - le bouton « Notifications » de la topbar est présent (bouton d'activation
 *     par appareil) ;
 *   - ZÉRO violation CSP / erreur de connexion / exception JS.
 *
 * ⚠️ Ce harnais NE prouve PAS l'envoi réel vers un service de push (il faudrait
 * un navigateur réellement abonné) : ce maillon-là est déclaré NON testable.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-push.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { collectViolations } from "./browser-violations.mjs";

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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-push-"));

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-push-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_PUSH_DIR: STATE_DIR },
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

/* ─── Chromium headless (CDP) ───────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-push-chrome-"));
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
  await sleep(800);
}

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error("eval: " + (res.exceptionDetails.exception?.description || "exception"));
  }
  return res.result.value;
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

/* ═══════════════════════ 1) Index + manifeste déclaré ════════════════════ */
await navigate(`${server.base}/`);
const index = await evaluate(`(async () => ({
  manifestHref: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
  themeColor: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
  notifButton: !!document.getElementById('notif-toggle'),
  notifHidden: document.getElementById('notif-toggle')?.hidden ?? null,
  styleAttrs: document.body.querySelectorAll('[style]').length,
  markupSvg: ((await (await fetch('/')).text()).match(/<svg/g) ?? []).length,
}))()`);
check("[index] le manifeste est déclaré (/manifest.webmanifest)", index.manifestHref === "/manifest.webmanifest", String(index.manifestHref));
check("[index] couleur de thème déclarée (PWA)", typeof index.themeColor === "string" && index.themeColor.startsWith("#"), String(index.themeColor));
check("[index] bouton de notifications présent", index.notifButton === true);
check("[index] aucun style inline (CSP)", index.styleAttrs === 0, String(index.styleAttrs));
check("[index] markup servi sans SVG inline (icônes rendues par la brique)", index.markupSvg === 0, String(index.markupSvg));

/* ═══════════════════════ 2) Manifeste SERVI (type MIME) ═════════════════ */
const manifest = await evaluate(`(async () => {
  const r = await fetch('/manifest.webmanifest');
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, type: r.headers.get('content-type'), name: json?.name ?? null, display: json?.display ?? null, id: json?.id ?? null, icons: (json?.icons ?? []).map((i) => i.sizes) };
})()`);
check("[manifeste] servi 200", manifest.status === 200, String(manifest.status));
check("[manifeste] type `application/manifest+json`", String(manifest.type).includes("application/manifest+json"), String(manifest.type));
check("[manifeste] display=standalone, nom Yuki", manifest.display === "standalone" && manifest.name === "Yuki", `${manifest.display}/${manifest.name}`);
check("[manifeste] icônes 192 et 512 présentes", manifest.icons.includes("192x192") && manifest.icons.includes("512x512"), JSON.stringify(manifest.icons));
check("[manifeste] `id` déclaré (identité stable)", typeof manifest.id === "string" && manifest.id.length > 0, String(manifest.id));

// ⚠️ Tailles RÉELLES (décodage de l'image), pas la déclaration : une icône
// annoncée 512 mais réellement plus petite fait échouer l'installation Android
// SANS message clair. On décode donc l'image dans le navigateur.
const iconSizes = await evaluate(`(async () => {
  const out = {};
  for (const p of ['/ui/icons/icon-192.png', '/ui/icons/icon-512.png', '/ui/icons/icon-maskable-512.png']) {
    const bmp = await createImageBitmap(await (await fetch(p)).blob());
    out[p] = bmp.width + 'x' + bmp.height;
    bmp.close();
  }
  return out;
})()`);
check(
  "[icônes] tailles RÉELLES décodées = 192 et 512 (critère d'installation)",
  iconSizes["/ui/icons/icon-192.png"] === "192x192" &&
    iconSizes["/ui/icons/icon-512.png"] === "512x512" &&
    iconSizes["/ui/icons/icon-maskable-512.png"] === "512x512",
  JSON.stringify(iconSizes),
);

/* ═══════════════════════ 3) Service worker servi + enregistré ════════════ */
const swFetch = await evaluate(`(async () => {
  const r = await fetch('/sw.js');
  const text = await r.text();
  return { status: r.status, type: r.headers.get('content-type'), startsHtml: text.trimStart().startsWith('<'), hasPush: text.includes('addEventListener("push"'), hasFetch: text.includes('addEventListener("fetch"') };
})()`);
check("[sw] servi 200", swFetch.status === 200, String(swFetch.status));
check("[sw] type JavaScript (jamais du HTML de forward-auth)", String(swFetch.type).includes("javascript") && swFetch.startsHtml === false, `${swFetch.type} / html=${swFetch.startsHtml}`);
check("[sw] contient le gestionnaire push", swFetch.hasPush === true);
check("[sw] contient un gestionnaire `fetch` (installabilité Chrome)", swFetch.hasFetch === true);

const swState = await evaluate(`(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { registered: false };
  let active = reg.active;
  const deadline = Date.now() + 8000;
  while ((!active || active.state !== 'activated') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    active = reg.active;
  }
  return { registered: true, scope: reg.scope, state: active ? active.state : null, supported: 'serviceWorker' in navigator, pushSupported: 'PushManager' in window };
})()`);
check("[sw] enregistré (même origine)", swState.registered === true, JSON.stringify(swState));
check("[sw] portée = racine de l'origine", typeof swState.scope === "string" && swState.scope.replace(/\/$/, "") === server.base, String(swState.scope));
check("[sw] activé", swState.state === "activated", String(swState.state));
check("[sw] Web Push supporté par le navigateur", swState.pushSupported === true);

// Le worker ACTIF contrôle la page (clients.claim) : rechargement puis contrôle.
await navigate(`${server.base}/`);
const controlled = await evaluate(`(async () => {
  const deadline = Date.now() + 5000;
  while (!navigator.serviceWorker.controller && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return { controlled: !!navigator.serviceWorker.controller, notifButtonHidden: document.getElementById('notif-toggle')?.hidden ?? null };
})()`);
check("[sw] la page est CONTRÔLÉE par le service worker", controlled.controlled === true);
check("[index] le bouton de notifications est VISIBLE (Web Push supporté)", controlled.notifButtonHidden === false, String(controlled.notifButtonHidden));

await shot("push-e2e");

/* ═══════════════════════ Nettoyage ═══════════════════════════════════════ */
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
console.log(`\nMessages console : ${consoleMessages.length} ; entrées Log : ${logEntries.length}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; connexion = ${connectionErrors.length} ; exceptions = ${pageExceptions.length} ═══`);

chrome.kill("SIGKILL");
process.exit(failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1);
