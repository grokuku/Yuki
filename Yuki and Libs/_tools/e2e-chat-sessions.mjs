#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — page de discussion `/` : conversations multiples,
 * layout (barre latérale repliée/dépliée/épinglée), menu contextuel (clic
 * droit), état vide, avec la CSP RÉELLE et un hôte Pi RÉEL hors ligne.
 *
 * Vérifie : la liste s'affiche, le SURVOL N'OUVRE PLUS la barre (elle reste le
 * rail de 56 px), le BOUTON déplier/replier la déplie à 280 px puis la replie,
 * l'état déplié PERSISTE après rechargement, la PUNAISE a disparu, le CLIC
 * DROIT ouvre le menu (renommer / supprimer + place réservée pour le titre IA),
 * la BASCULE change bien de fil, l'ÉTAT VIDE s'affiche après suppression de la
 * conversation ouverte, et ZÉRO violation CSP / exception JS.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-chat-sessions.mjs"
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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-chat-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-chat-sessions-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_CHAT_DIR: STATE_DIR },
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
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-chat-chrome-"));
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

/** Centre (client) du bouton déplier/replier de la barre latérale. */
const toggleCenter = () =>
  evaluate(`(() => {
    const b = document.querySelector('.sidebar__toggle');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);

/** Clic GAUCHE RÉEL (CDP) sur le bouton déplier/replier. */
async function clickToggle() {
  const pos = await toggleCenter();
  if (!pos) throw new Error('bouton .sidebar__toggle introuvable');
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y, button: "none", buttons: 0 });
  await sleep(20);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: pos.x, y: pos.y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(20);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", buttons: 1, clickCount: 1 });
}

const chatState = () =>
  evaluate(`(() => {
    const sidebar = document.querySelector('.sidebar');
    const empty = document.querySelector('#empty-state');
    return {
      railWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0,
      expanded: sidebar ? sidebar.getAttribute('data-expanded') : null,
      toggleExpanded: document.querySelector('.sidebar__toggle')?.getAttribute('aria-expanded') ?? null,
      convs: [...document.querySelectorAll('.conv')].map((c) => ({
        title: c.querySelector('.conv__title')?.textContent ?? '',
        meta: c.querySelector('.conv__meta')?.textContent ?? '',
        active: c.classList.contains('conv--active'),
      })),
      menuOpen: (() => { const m = document.querySelector('.ctx-menu'); return m ? !m.hidden : false; })(),
      menuItems: [...document.querySelectorAll('.ctx-menu__item')].map((b) => ({ text: b.textContent, disabled: b.disabled })),
      emptyVisible: empty ? getComputedStyle(empty).display !== 'none' : false,
      threadText: document.querySelector('#conversation')?.textContent ?? '',
      styleAttrs: document.querySelectorAll('[style]').length,
    };
  })()`);

/* ═══════════════════════ 1) Liste + repli par défaut ═════════════════════ */
await navigate(`${server.base}/`);
check("la liste s'affiche (2 conversations)", await waitFor(`document.querySelectorAll('.conv').length === 2`));
const initial = await chatState();
check("barre latérale REPLIÉE par défaut (56 px)", initial.railWidth === 56, `${initial.railWidth} px`);
check("une conversation est active", initial.convs.some((c) => c.active));
check("titre + compteur jamais vides", initial.convs.every((c) => c.title.length > 0 && /message/.test(c.meta)));
const activeTitle = initial.convs.find((c) => c.active)?.title ?? "";
await shot("chat-sessions-rail");

/* ═════════ 2) SURVOL SANS CLIC ⇒ la barre NE S'OUVRE PAS (test clé) ═════ */
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 28, y: 320 });
await sleep(550);
const hovered = await chatState();
check("SURVOL SANS CLIC : la barre RESTE repliée (56 px)", hovered.railWidth === 56, `${hovered.railWidth} px`);
await shot("chat-sessions-hover");

/* ═════════ 3) CLIC RÉEL sur le bouton ⇒ dépliée à 280 px ═════════════════ */
await clickToggle();
await sleep(550);
const expanded = await chatState();
check("BOUTON : un clic déplie la barre à 280 px", Math.abs(expanded.railWidth - 280) <= 2, `${expanded.railWidth} px`);
check("BOUTON : aria-expanded=true", expanded.toggleExpanded === "true", String(expanded.toggleExpanded));
check("BOUTON : data-expanded=true sur l'aside", expanded.expanded === "true", String(expanded.expanded));
await shot("chat-sessions-expanded");

/* ═════════ 3bis) PERSISTANCE : reste dépliée au rechargement ════════════ */
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('.conv').length === 2`);
const reloaded = await chatState();
check("PERSISTANCE : reste dépliée après rechargement (280 px)", Math.abs(reloaded.railWidth - 280) <= 2, `${reloaded.railWidth} px`);
check("PERSISTANCE : aria-expanded=true après rechargement", reloaded.toggleExpanded === "true", String(reloaded.toggleExpanded));

/* ═════════ 3ter) RE-CLIC ⇒ repliée (56 px), repli persisté ══════════════ */
await clickToggle();
await sleep(550);
const collapsed = await chatState();
check("BOUTON (re-clic) : la barre se replie (56 px)", collapsed.railWidth === 56, `${collapsed.railWidth} px`);
check("BOUTON (re-clic) : aria-expanded=false", collapsed.toggleExpanded === "false", String(collapsed.toggleExpanded));
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('.conv').length === 2`);
const collapsedReload = await chatState();
check("PERSISTANCE : le repli survit au rechargement (56 px)", collapsedReload.railWidth === 56, `${collapsedReload.railWidth} px`);

/* ═════════ 3quater) PUNAISE SUPPRIMÉE (aucun nœud résiduel) ════════════ */
const hasPin = await evaluate(`!!document.querySelector('.sidebar__pin')`);
check("PUNAISE SUPPRIMÉE : aucun nœud `.sidebar__pin` résiduel", hasPin === false, String(hasPin));

/* ═══════════════════════ 4) Bascule de fil ═══════════════════════════════ */
await evaluate(`(() => {
  const target = [...document.querySelectorAll('.conv')].find((c) => !c.classList.contains('conv--active'));
  target.click();
})()`);
await sleep(800);
const switched = await chatState();
const newTitle = switched.convs.find((c) => c.active)?.title ?? "";
check("BASCULE : la conversation active change", newTitle !== activeTitle && newTitle.length > 0, `${activeTitle} → ${newTitle}`);
const expected = /PREMIER/.test(newTitle) ? "PREMIERE" : "SECONDE";
check("BASCULE : le fil affiché correspond au nouveau", switched.threadText.includes(expected), expected);
// Mesure RÉELLE du layout : fil pleine largeur, assistant 100 %, utilisateur ~85 %.
const widths = await evaluate(`(() => {
  const conv = document.querySelector('#conversation');
  const assistant = document.querySelector('.message--assistant');
  const user = document.querySelector('.message--user');
  if (!conv || !assistant || !user) return null;
  const cs = getComputedStyle(conv);
  const inner = conv.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const aw = assistant.getBoundingClientRect().width;
  const uw = user.getBoundingClientRect().width;
  return { inner: Math.round(inner), aw: Math.round(aw), ratio: uw / aw };
})()`);
check("layout : bulle assistant = 100 % de la largeur du fil", widths && Math.abs(widths.aw - widths.inner) <= 2, JSON.stringify(widths));
check("layout : bulle utilisateur ≈ 85 % (alignée à droite)", widths && Math.abs(widths.ratio - 0.85) <= 0.03, widths ? widths.ratio.toFixed(3) : "n/a");
await shot("chat-sessions-switched");

// Aller-retour B → A → B : le fil ne doit PAS grossir (aucun doublon).
for (let i = 0; i < 2; i += 1) {
  await evaluate(`(() => {
    const target = [...document.querySelectorAll('.conv')].find((c) => !c.classList.contains('conv--active'));
    target.click();
  })()`);
  await sleep(800);
}
const roundTrip = await chatState();
const occurrences = (roundTrip.threadText.match(/Réponse (PREMIERE|SECONDE)/g) || []).length;
check("aller-retour : AUCUN doublon (une seule réponse affichée)", occurrences === 1, `${occurrences} occurrence(s)`);

/* ═══════════════════════ 5) Menu contextuel (clic droit) ═════════════════ */
await evaluate(`(() => {
  const c = document.querySelectorAll('.conv')[0];
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 12, clientY: r.top + 12 }));
})()`);
await sleep(200);
const menu = await chatState();
check("CLIC DROIT : le menu contextuel s'ouvre", menu.menuOpen === true);
check("menu : « Renommer » présent", menu.menuItems.some((i) => i.text === "Renommer"));
check("menu : « Supprimer » présent", menu.menuItems.some((i) => i.text === "Supprimer"));
check(
  "menu : « Titre généré par le modèle » réservé (désactivé)",
  menu.menuItems.some((i) => /modèle/i.test(i.text) && i.disabled === true),
);
await shot("chat-sessions-menu");
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await sleep(150);

/* ═══════════════════════ 6) Suppression ⇒ état vide ══════════════════════ */
await evaluate(`(() => {
  const c = document.querySelector('.conv--active');
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 12, clientY: r.top + 12 }));
})()`);
await sleep(200);
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.ctx-menu__item')].find((x) => x.textContent === 'Supprimer');
  b.click();
})()`);
await sleep(350);
const modal = await evaluate(`(() => ({
  title: document.querySelector('.holaf-modal-title')?.textContent ?? '',
  hasConfirm: !![...document.querySelectorAll('.holaf-modal-btn')].find((b) => b.textContent === 'Mettre de côté'),
  message: document.querySelector('.holaf-modal-message')?.textContent ?? '',
}))()`);
check("suppression : confirmation via HolafModal (pas window.confirm)", modal.title.length > 0, modal.title);
check("suppression : libellé explicite (mise de côté, récupérable)", modal.hasConfirm && /horodatage/i.test(modal.message), modal.message.slice(0, 120));
await shot("chat-sessions-modal");
await evaluate(`[...document.querySelectorAll('.holaf-modal-btn')].find((b) => b.textContent === 'Mettre de côté')?.click()`);
check("suppression : l'état vide s'affiche", await waitFor(`document.querySelector('#empty-state') && getComputedStyle(document.querySelector('#empty-state')).display !== 'none'`));
const afterDelete = await chatState();
check("suppression : la liste perd une conversation", afterDelete.convs.length === 1, `${afterDelete.convs.length}`);
const honest = await evaluate(`document.querySelector('.empty-state__honest')?.textContent ?? ''`);
check("état vide : message honnête (« ce n'est pas une erreur »)", /pas une erreur/i.test(honest), honest.slice(0, 120));
check("état vide : aucune conversation active", !afterDelete.convs.some((c) => c.active));
await shot("chat-sessions-empty");

/* ═══════════ 7) Fenêtre ÉTROITE : rail 56 px, aucun débordement ══════════ */
await send("Emulation.setDeviceMetricsOverride", { width: 480, height: 720, deviceScaleFactor: 1, mobile: false });
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('.conv').length >= 1`);
const narrow = await evaluate(`(() => {
  const sb = document.querySelector('.sidebar');
  return {
    railWidth: Math.round(sb.getBoundingClientRect().width),
    overflow: document.documentElement.scrollWidth - window.innerWidth,
  };
})()`);
check("fenêtre étroite : rail de 56 px", narrow.railWidth === 56, `${narrow.railWidth} px`);
check("fenêtre étroite : aucun débordement horizontal du fil", narrow.overflow <= 1, `débordement ${narrow.overflow} px`);
await shot("chat-sessions-narrow");

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
console.log(`Messages console : ${consoleMessages.length} ; entrées Log : ${logEntries.length}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`);

chrome.kill("SIGKILL");
process.exit(failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1);
