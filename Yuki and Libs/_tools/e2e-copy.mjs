#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — bouton « copier » des blocs de code du fil.
 *
 * Prouve, avec Chromium headless + CDP et la CSP RÉELLE :
 *  - un bloc de code (et un bloc muet) porte un PETIT bouton-ICÔNE (holaf-icons
 *    `copy`) en HAUT À DROITE, VRAI `<button>` avec `aria-label` + `title` ;
 *  - le presse-papiers RÉEL contient EXACTEMENT le contenu du bloc après un CLIC
 *    RÉEL (indentation, tabulation, espaces de fin, `& < > '`, Unicode) ;
 *  - les TROIS cas du presse-papiers : API moderne, API refusée (repli), API
 *    absente/refusée + repli refusé (échec VISIBLE, jamais un silence) ;
 *  - le bouton est atteignable au CLAVIER (tabulation + Entrée ⇒ copie) et
 *    visible au focus ; il reste visible en l'absence de survol (tactile) ;
 *  - la sélection manuelle ne ramasse PAS le libellé du bouton ;
 *  - les marges des bulles restent SYMÉTRIQUES et l'apparition du bouton / du
 *    retour visuel ne décale AUCUNE mise en page ;
 *  - ZÉRO violation CSP / exception JS.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-copy.mjs"
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

/* Contenu attendu — DOIT être identique à `e2e-copy-serve.ts`. */
const CODE_TEXT = [
  "  # accentué : héllo & <monde>",
  "\techo \"a & b < c > d 'e'\"   ",
  "func f() {",
  "    return 1;",
  "}",
].join("\n");
const MUTE_TEXT = "secret brut 42";

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-copy-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-copy-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_COPY_DIR: STATE_DIR },
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
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-copy-chrome-"));
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
await send("Emulation.setFocusEmulationEnabled", { enabled: true });
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
// Permissions presse-papiers pour l'origine du gateway (lecture ET écriture).
await send("Browser.grantPermissions", {
  origin: server.base,
  permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
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
  await sleep(700);
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

/** Clic GAUCHE RÉEL (CDP) à une position. */
async function clickAt(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await sleep(30);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(20);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 1, clickCount: 1 });
}

/** Centre du bouton « copier » du N-ième bloc de code. */
async function buttonCenter(index) {
  return evaluate(`(() => {
    const block = document.querySelectorAll('.md-code-block')[${index}];
    const b = block && block.querySelector('.md-copy-btn');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
}

/** Lit le presse-papiers (retente jusqu'à obtenir `expected`, ou timeout). */
async function readClipboard(expected) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < 2500) {
    const v = await evaluate(`navigator.clipboard.readText().then(t => t, () => null)`);
    if (typeof v === "string") {
      last = v;
      if (expected === undefined || v === expected) return v;
    }
    await sleep(100);
  }
  return last;
}

/* ═══════════════════════ 1) Présence + forme du bouton ═══════════════════ */
await navigate(`${server.base}/`);
check("le fil contient deux blocs de code", await waitFor(`document.querySelectorAll('.md-code-block').length === 2`));

const shape = await evaluate(`(() => {
  const blocks = [...document.querySelectorAll('.md-code-block')];
  const btn = blocks[0]?.querySelector('.md-copy-btn');
  return {
    tag: btn ? btn.tagName : null,
    type: btn ? btn.getAttribute('type') : null,
    ariaLabel: btn ? btn.getAttribute('aria-label') : null,
    title: btn ? btn.getAttribute('title') : null,
    hasIcon: !!(btn && btn.querySelector('svg')),
    iconPaths: btn ? btn.querySelectorAll('svg *').length : 0,
    buttons: blocks.map((b) => !!b.querySelector('.md-copy-btn')),
    inlineCodeButtons: document.querySelectorAll('.md-code .md-copy-btn').length,
    tableButtons: document.querySelectorAll('.md-table-wrap .md-copy-btn').length,
  };
})()`);
check("bloc de code ET bloc muet portent un bouton", shape.buttons.length === 2 && shape.buttons.every(Boolean), JSON.stringify(shape.buttons));
check("le bouton est un VRAI <button type=button>", shape.tag === "BUTTON" && shape.type === "button", `${shape.tag}/${shape.type}`);
check("aria-label et title explicites (icône seule)", shape.ariaLabel === "Copier le code" && shape.title === "Copier le code", `${shape.ariaLabel} | ${shape.title}`);
check("l'icône vient de holaf-icons (SVG rendu, tracé présent)", shape.hasIcon && shape.iconPaths > 0, `${shape.iconPaths} nœuds SVG`);
check("AUCUN bouton sur le code en ligne", shape.inlineCodeButtons === 0, String(shape.inlineCodeButtons));
check("AUCUN bouton sur les tableaux", shape.tableButtons === 0, String(shape.tableButtons));
await shot("copy-bouton");

/* ═══════════════════ 2) Position : HAUT À DROITE du bloc ═════════════════ */
const geom = await evaluate(`(() => {
  const block = document.querySelectorAll('.md-code-block')[0];
  const btn = block.querySelector('.md-copy-btn');
  const br = block.getBoundingClientRect();
  const rr = btn.getBoundingClientRect();
  return {
    rightHalf: rr.left >= br.left + br.width / 2,
    topHalf: rr.top <= br.top + br.height / 2,
    insideBlock: rr.right <= br.right + 0.5 && rr.bottom <= br.bottom + 0.5,
    gapTop: Math.round((rr.top - br.top) * 10) / 10,
    gapRight: Math.round((br.right - rr.right) * 10) / 10,
  };
})()`);
check("le bouton est dans la MOITIÉ DROITE et la MOITIÉ HAUTE du bloc", geom.rightHalf && geom.topHalf, JSON.stringify(geom));
check("le bouton reste DANS le bloc (coin supérieur droit)", geom.insideBlock, JSON.stringify(geom));

/* ══════════ 3) Discrétion : masqué au repos (survol), visible au survol ══ */
const hoverNone = await evaluate(`window.matchMedia('(hover: none)').matches`);
const restOpacity = await evaluate(`getComputedStyle(document.querySelector('.md-copy-btn')).opacity`);
if (hoverNone) {
  check("appareil SANS survol (tactile) : le bouton reste VISIBLE", restOpacity === "1", `opacity=${restOpacity}`);
} else {
  check("appareil à survol : le bouton est masqué AU REPOS (ne masque pas le code)", restOpacity === "0", `opacity=${restOpacity}`);
}
// Survol réel du bloc ⇒ le bouton apparaît (sans clic).
{
  const pos = await buttonCenter(0);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pos.x, y: pos.y, button: "none", buttons: 0 });
  await sleep(200);
  const hoveredOpacity = await evaluate(`getComputedStyle(document.querySelector('.md-copy-btn')).opacity`);
  check("au SURVOL, le bouton devient visible", hoveredOpacity === "1", `opacity=${hoveredOpacity}`);
}

/* ═══════════ 4) Aucun décalage de mise en page (bouton superposé) ════════ */
const layoutBefore = await evaluate(`(() => {
  const bubble = document.querySelector('.message--assistant').getBoundingClientRect();
  const block = document.querySelectorAll('.md-code-block')[0].getBoundingClientRect();
  return { bw: Math.round(bubble.width), bh: Math.round(bubble.height), bt: Math.round(bubble.top), bl: Math.round(bubble.left), blockW: Math.round(block.width) };
})()`);
await sleep(150);
const layoutAfterHover = await evaluate(`(() => {
  const bubble = document.querySelector('.message--assistant').getBoundingClientRect();
  const block = document.querySelectorAll('.md-code-block')[0].getBoundingClientRect();
  return { bw: Math.round(bubble.width), bh: Math.round(bubble.height), bt: Math.round(bubble.top), bl: Math.round(bubble.left), blockW: Math.round(block.width) };
})()`);
check("l'apparition du bouton AU SURVOL ne décale RIEN", JSON.stringify(layoutBefore) === JSON.stringify(layoutAfterHover), `${JSON.stringify(layoutBefore)} vs ${JSON.stringify(layoutAfterHover)}`);

/* ═══════════ 5) COPIE EXACTE après un CLIC RÉEL (API moderne) ════════════ */
{
  const pos = await buttonCenter(0);
  await clickAt(pos.x, pos.y);
  const got = await readClipboard(CODE_TEXT);
  check("PRESSE-PAPIERS : le bloc de code est copié À L'IDENTIQUE", got === CODE_TEXT, JSON.stringify(got));
  const isDone = await evaluate(`document.querySelectorAll('.md-code-block')[0].querySelector('.md-copy-btn').classList.contains('md-copy-btn--done')`);
  check("retour visuel : l'icône passe à l'état « copié »", isDone === true, String(isDone));
  await shot("copy-bouton-copie");
  // Retour à l'état normal après le délai (aucun saut de mise en page).
  await sleep(1700);
  const reverted = await evaluate(`(() => {
    const b = document.querySelectorAll('.md-code-block')[0].querySelector('.md-copy-btn');
    const bubble = document.querySelector('.message--assistant').getBoundingClientRect();
    return { done: b.classList.contains('md-copy-btn--done'), label: b.getAttribute('aria-label'), bt: Math.round(bubble.top), bh: Math.round(bubble.height) };
  })()`);
  check("le bouton REVIENT à l'état normal (libellé d'origine)", reverted.done === false && reverted.label === "Copier le code", JSON.stringify(reverted));
  check("aucun décalage après le retour visuel", reverted.bt === layoutBefore.bt && reverted.bh === layoutBefore.bh, JSON.stringify(reverted));
}

/* ═══════════ 6) Bloc MUET : copie exacte (sans la marque « muet ») ════════ */
{
  const pos = await buttonCenter(1);
  await clickAt(pos.x, pos.y);
  const got = await readClipboard(MUTE_TEXT);
  check("bloc muet : copie EXACTE (ni marque « muet », ni bouton)", got === MUTE_TEXT, JSON.stringify(got));
}

/* ═══════ 7) API moderne REFUSÉE ⇒ repli execCommand et copie réussie ═════ */
{
  await evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', { value: () => Promise.reject(new Error('refus')), configurable: true })`);
  const pos = await buttonCenter(0);
  await clickAt(pos.x, pos.y);
  const got = await readClipboard(CODE_TEXT);
  check("API refusée : le REPLI execCommand copie quand même (exact)", got === CODE_TEXT, JSON.stringify(got));
  const isDone = await evaluate(`document.querySelectorAll('.md-code-block')[0].querySelector('.md-copy-btn').classList.contains('md-copy-btn--done')`);
  check("API refusée : le bouton annonce la réussite du repli", isDone === true, String(isDone));
}

/* ═ 8) API + repli REFUSÉS ⇒ ÉCHEC VISIBLE (jamais un silence) ════════════ */
{
  await evaluate(`document.execCommand = () => false`);
  const pos = await buttonCenter(0);
  await clickAt(pos.x, pos.y);
  await sleep(300);
  const failed = await evaluate(`(() => {
    const b = document.querySelectorAll('.md-code-block')[0].querySelector('.md-copy-btn');
    return { failedClass: b.classList.contains('md-copy-btn--failed'), label: b.getAttribute('aria-label'), title: b.getAttribute('title') };
  })()`);
  check("copie impossible : l'ÉCHEC est ANNONCÉ (état visible + libellé)", failed.failedClass === true && /impossible/i.test(failed.label), JSON.stringify(failed));
  await shot("copy-bouton-echec");
}

/* ═══════ 9) Accessibilité : atteignable au CLAVIER, visible au focus ══════ */
await navigate(`${server.base}/`);
check("(clavier) rechargement : bouton présent", await waitFor(`document.querySelector('.md-copy-btn') !== null`));
// Neutralise un éventuel focus précédent : on part du corps.
await evaluate(`document.getElementById('input')?.blur(); document.activeElement?.blur?.()`);
let reached = false;
for (let i = 0; i < 80 && !reached; i += 1) {
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await sleep(30);
  reached = await evaluate(`!!(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('md-copy-btn'))`);
}
check("le bouton est ATTEIGNABLE par TABULATION", reached === true, `au bout de ${reached ? "≤80" : "80+"} tabulations`);
if (reached) {
  const focusOpacity = await evaluate(`getComputedStyle(document.activeElement).opacity`);
  check("au FOCUS, le bouton est VISIBLE", focusOpacity === "1", `opacity=${focusOpacity}`);
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  const got = await readClipboard(CODE_TEXT);
  check("TABULATION + ENTRÉE ⇒ le contenu est copié", got === CODE_TEXT, JSON.stringify(got));
}

/* ═══════ 10) Sélection manuelle : pas le libellé du bouton ═══════════════ */
{
  const userSelect = await evaluate(`getComputedStyle(document.querySelector('.md-copy-btn')).userSelect`);
  check("le libellé du bouton est hors sélection (user-select: none)", userSelect === "none", userSelect);
  const selected = await evaluate(`(() => {
    const code = document.querySelectorAll('.md-code-block')[0].querySelector('code');
    const range = document.createRange();
    range.selectNodeContents(code);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);
    const txt = s.toString();
    s.removeAllRanges();
    return txt;
  })()`);
  check("sélection manuelle du bloc = EXACTEMENT le contenu (pas de « Copier »)", selected === CODE_TEXT, JSON.stringify(selected));
}

/* ═══════ 11) Marges SYMÉTRIQUES des bulles (intactes) ════════════════════ */
const layout = await evaluate(`(() => {
  const conv = document.querySelector('#conversation');
  const assistant = document.querySelector('.message--assistant');
  const user = document.querySelector('.message--user');
  const cs = getComputedStyle(conv);
  const convRect = conv.getBoundingClientRect();
  const contentLeft = convRect.left + parseFloat(cs.paddingLeft);
  const inner = conv.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const contentRight = contentLeft + inner;
  const ar = assistant.getBoundingClientRect();
  const ur = user.getBoundingClientRect();
  return {
    inner: Math.round(inner),
    aw: Math.round(ar.width),
    uw: Math.round(ur.width),
    userLeftMargin: Math.round((ur.left - contentLeft) * 10) / 10,
    asstRightMargin: Math.round((contentRight - ar.right) * 10) / 10,
  };
})()`);
check(
  "marges LATÉRALES égales (gauche utilisateur = droite Yuki, ≤ 1 px)",
  Math.abs(layout.userLeftMargin - layout.asstRightMargin) <= 1,
  `gauche=${layout.userLeftMargin} px ; droite=${layout.asstRightMargin} px ; largeur fil=${layout.inner} px`,
);
check(
  "les deux bulles gardent 85 % de la largeur du fil",
  Math.abs(layout.aw - 0.85 * layout.inner) <= 3 && Math.abs(layout.uw - 0.85 * layout.inner) <= 3,
  JSON.stringify(layout),
);

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
