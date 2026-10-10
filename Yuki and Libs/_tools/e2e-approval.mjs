#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — validation humaine en FENÊTRE FLOTTANTE (D118).
 *
 * Vérifie, avec la CSP RÉELLE et un hôte Pi RÉEL hors ligne :
 *   - la demande s'affiche dans une fenêtre FLOTTANTE AU-DESSUS de l'interface
 *     (pas dans le fil), NON bloquante, DÉPLAÇABLE ;
 *   - elle ne se ferme PAS au clic à côté ;
 *   - elle reste affichée en naviguant vers `/config` (le scénario demandé) ;
 *   - plusieurs demandes cohabitent (aucune n'écrase l'autre) ;
 *   - le compte à rebours résiste à une horloge cliente en AVANCE ;
 *   - décider fait disparaître la BONNE fenêtre et affiche le résultat.
 * ZÉRO violation CSP / exception JS.
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

async function startServer(extraEnv = {}) {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-approval-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_APPROVAL_DIR: STATE_DIR, ...extraEnv },
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

/** Clic SOURIS RÉEL (CDP) aux coordonnées viewport. */
async function mouseClick(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(120);
}

/** Glisser SOURIS RÉEL (CDP) de (x0,y0) à (x1,y1). */
async function mouseDrag(x0, y0, x1, y1) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x0, y: y0, button: "left", clickCount: 1 });
  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: x0 + ((x1 - x0) * i) / steps,
      y: y0 + ((y1 - y0) * i) / steps,
      button: "left",
    });
    await sleep(20);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x1, y: y1, button: "left", clickCount: 1 });
  await sleep(120);
}

/** État de la couche flottante + des fenêtres de demande. */
const layerState = () =>
  evaluate(`(() => {
    const layer = document.querySelector('.approval-layer');
    const wins = [...document.querySelectorAll('.approval-window:not(.approval--result)')];
    const conv = document.querySelector('#conversation');
    const first = wins[0] || null;
    const text = first ? first.textContent : '';
    return {
      hasLayer: !!layer,
      layerInBody: !!(layer && document.body.contains(layer)),
      count: wins.length,
      ids: wins.map((w) => w.getAttribute('data-approval-id')),
      inConversation: wins.some((w) => conv && conv.contains(w)),
      text,
      hasValider: !![...document.querySelectorAll('.approval__btn')].find((b) => b.textContent === 'Valider'),
      hasRefuser: !![...document.querySelectorAll('.approval__btn')].find((b) => b.textContent === 'Refuser'),
      role: first ? first.getAttribute('role') : null,
      ariaModal: first ? first.getAttribute('aria-modal') : null,
      style: first ? first.getAttribute('style') : null,
      resultText: document.querySelector('.approval--result')?.textContent ?? '',
    };
  })()`);

const rectOf = (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
      position: getComputedStyle(el).position, zIndex: getComputedStyle(el).zIndex };
  })()`);

const windowRect = () =>
  evaluate(`(() => {
    // Fenêtre au PREMIER PLAN (dernière du DOM) : c'est elle que reçoit un clic.
    const wins = [...document.querySelectorAll('.approval-window:not(.approval--result)')];
    const el = wins[wins.length - 1];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
      position: getComputedStyle(el).position, zIndex: getComputedStyle(el).zIndex };
  })()`);

/* ═══════════════ 1) Fenêtre FLOTTANTE au-dessus de l'interface ══════════ */
await navigate(`${server.base}/`);
const shown = await waitFor(`document.querySelectorAll('.approval-window:not(.approval--result)').length >= 2`);
check("deux fenêtres flottantes apparaissent (deux demandes en attente)", shown);
const state = await layerState();
check("la couche flottante est montée sur <body>", state.hasLayer && state.layerInBody === true);
check("les fenêtres ne sont PAS dans le fil (#conversation)", state.inConversation === false);
check("role=dialog + aria-modal=false (fenêtre NON modale)", state.role === "dialog" && state.ariaModal === "false");
check("machine : nom + identifiant", /nuc00/.test(state.text) && /agent-nuc00/.test(state.text), state.text.slice(0, 120));
check("commande EXACTE affichée", state.text.includes("rm -rf /srv/cache"));
check("motif destructeur expliqué", state.text.includes("suppression (rm)"), state.text.slice(0, 200));
check("expiration mentionnée (compte à rebours)", /Expire dans/i.test(state.text), state.text.slice(0, 200));
check("boutons Valider ET Refuser", state.hasValider && state.hasRefuser);
check(
  "positionnement par CSSOM (left/top), aucun autre style en ligne",
  /left:\s*-?\d+(\.\d+)?px/.test(state.style ?? "") &&
    /top:\s*-?\d+(\.\d+)?px/.test(state.style ?? "") &&
    !/background|color|padding|border/i.test(state.style ?? ""),
  String(state.style),
);
const geometry = await windowRect();
check("fenêtre position:fixed et dans le viewport", geometry?.position === "fixed" && geometry.left >= 0 && geometry.top >= 0 && geometry.bottom <= 901);
check("z-index élevé (au-dessus de l'interface)", Number(geometry?.zIndex) >= 1000, String(geometry?.zIndex));
await shot("approval-window");

/* ═══ 2) NON BLOQUANTE : un clic sur un élément du site DERRIÈRE passe ═══ */
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
const probeRect = await rectOf("#e2e-probe");
const probeX = Math.round(probeRect.left + probeRect.width / 2);
const probeY = Math.round(probeRect.top + probeRect.height / 2);
await evaluate(`window.__probeClicked = false`);
await mouseClick(probeX, probeY);
const probeClicked = await evaluate(`window.__probeClicked === true`);
check(
  "NON bloquante : un clic SOUS la couche atteint l'élément du site DERRIÈRE",
  probeClicked === true,
  `clic réel (${probeX},${probeY})`,
);
check("clic à côté : les fenêtres RESTENT affichées", (await layerState()).count >= 2);

/* ═══════════════ 3) DÉPLAÇABLE : glisser change la position ════════════ */
const before = await windowRect();
const barX = Math.round(before.left + before.width / 2);
const barY = Math.round(before.top + 16);
await mouseDrag(barX, barY, barX - 160, barY - 90);
const after = await windowRect();
check(
  "DÉPLAÇABLE : la position change au glisser réel",
  Math.abs(after.left - before.left) > 50 && Math.abs(after.top - before.top) > 30,
  `avant=(${Math.round(before.left)},${Math.round(before.top)}) après=(${Math.round(after.left)},${Math.round(after.top)})`,
);

/* ═══ 4) Horloge CLIENTE en avance de 10 min : la fenêtre ne disparaît pas ═ */
const skewScript = await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `(() => {
    const real = Date.now.bind(Date);
    const skew = 10 * 60 * 1000;
    Date.now = () => real() + skew;
  })();`,
});
await navigate(`${server.base}/`);
check(
  "horloge en avance de 10 min : les fenêtres apparaissent quand même",
  await waitFor(`document.querySelectorAll('.approval-window:not(.approval--result)').length >= 2`),
);
await sleep(1500);
const skew = await evaluate(`(() => ({
  count: document.querySelectorAll('.approval-window:not(.approval--result)').length,
  text: document.querySelector('.approval__expiry')?.textContent ?? '',
}))()`);
check("horloge en avance de 10 min : elles NE disparaissent PAS", skew.count >= 2, skew.text);
check("compte à rebours toujours positif (~5 min)", /Expire dans [1-5] min/.test(skew.text), skew.text);
await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: skewScript.identifier });

/* ═══ 5) NAVIGATION vers /config : la fenêtre reste affichée (LE SCÉNARIO) ═ */
await navigate(`${server.base}/config`);
const onConfig = await waitFor(`document.querySelectorAll('.approval-window:not(.approval--result)').length >= 2`);
check("navigation vers /config : les fenêtres SONT TOUJOURS LÀ", onConfig);
const configState = await layerState();
check("sur /config : la fenêtre montre bien la demande", /rm -rf \/srv\/cache/.test(configState.text), configState.text.slice(0, 120));
await shot("approval-on-config");

// Retour à la discussion : toujours là.
await navigate(`${server.base}/`);
check(
  "retour sur / : les fenêtres sont encore là",
  await waitFor(`document.querySelectorAll('.approval-window:not(.approval--result)').length >= 2`),
);

/* ═══════════════ 6) Valider UNE demande : la BONNE disparaît + résultat ═ */
await evaluate(`(() => {
  const win = document.querySelector('.approval-window[data-approval-id="apr-e2e-1"]');
  const btn = [...win.querySelectorAll('.approval__btn')].find((b) => b.textContent === 'Valider');
  btn.click();
})()`);
const decided = await waitFor(`!!document.querySelector('.approval--result')`);
check("valider : la fenêtre #1 disparaît et le résultat s'affiche", decided);
const afterDecision = await evaluate(`(() => ({
  ids: [...document.querySelectorAll('.approval-window:not(.approval--result)')].map((w) => w.getAttribute('data-approval-id')),
  resultText: document.querySelector('.approval--result')?.textContent ?? '',
}))()`);
check("valider : la demande #1 a disparu, la #2 reste en attente", JSON.stringify(afterDecision.ids) === JSON.stringify(["apr-e2e-2"]), JSON.stringify(afterDecision.ids));
check("valider : le résultat montre la sortie", /suppression effectuée/.test(afterDecision.resultText), afterDecision.resultText.slice(0, 160));
await shot("approval-result-window");

/* ═════ 7) Rechargement : seule la demande ENCORE en attente revient ════ */
await navigate(`${server.base}/`);
await sleep(800);
const afterReload = await evaluate(`(() => ({
  ids: [...document.querySelectorAll('.approval-window:not(.approval--result)')].map((w) => w.getAttribute('data-approval-id')),
  anyResult: !!document.querySelector('.approval--result'),
  thread: document.querySelector('#conversation')?.textContent ?? '',
}))()`);
check("rechargement APRÈS décision : la #1 (décidée) ne revient PAS", !afterReload.ids.includes("apr-e2e-1"), JSON.stringify(afterReload.ids));
check("rechargement : la #2 (en attente) revient", afterReload.ids.includes("apr-e2e-2"), JSON.stringify(afterReload.ids));
check("aucun résidu dans le fil (pas de « Validation requise »)", !/Validation requise/i.test(afterReload.thread), afterReload.thread.slice(0, 120));

/* ═══════════════ 8) Refuser la dernière ⇒ plus aucune fenêtre ══════════ */
await evaluate(`(() => {
  const win = document.querySelector('.approval-window[data-approval-id="apr-e2e-2"]');
  const btn = [...win.querySelectorAll('.approval__btn')].find((b) => b.textContent === 'Refuser');
  btn.click();
})()`);
const noneLeft = await waitFor(`document.querySelectorAll('.approval-window:not(.approval--result)').length === 0`);
check("refuser : la dernière fenêtre disparaît", noneLeft);
await navigate(`${server.base}/`);
await sleep(800);
const finalState = await evaluate(`document.querySelectorAll('.approval-window:not(.approval--result)').length`);
check("rechargement final : AUCUNE fenêtre ne revient (toutes décidées)", finalState === 0, String(finalState));
await shot("approval-after-reload");

/* ═══════════════════════════════════════════════════════════════════════
 * 9) FORME PAYSAGE (≈ 16/9) + DÉCISION TOUJOURS ATTEIGNABLE — commande de 120
 *    lignes. ⚠️ C'est LE test qui aurait dû exister : une fenêtre qui dépasse
 *    le viewport empêche de valider/refuser ⇒ défaut FONCTIONNEL, pas esthétique.
 * ═════════════════════════════════════════════════════════════════════ */
const SHAPE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-approval-shape-"));
const longServer = await startServer({
  YUKI_E2E_APPROVAL_DIR: SHAPE_DIR,
  YUKI_E2E_APPROVAL_LONG_LINES: "120",
  YUKI_E2E_APPROVAL_ONLY_LONG: "1",
});
const LONG_SELECTOR = '.approval-window:not(.approval--result)[data-approval-id="apr-e2e-1"]';

const shapeState = () =>
  evaluate(`(() => {
    const win = document.querySelector(${JSON.stringify(LONG_SELECTOR)});
    if (!win) return null;
    const r = win.getBoundingClientRect();
    const toggle = win.querySelector('.approval__fold-toggle');
    const cmd = win.querySelector('.approval__command');
    const valider = [...win.querySelectorAll('.approval__btn')].find((b) => b.textContent === 'Valider');
    const refuser = [...win.querySelectorAll('.approval__btn')].find((b) => b.textContent === 'Refuser');
    const inside = (el) => { const b = el.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight && b.left >= 0 && b.right <= innerWidth; };
    const body = win.querySelector('.approval-window__body');
    return {
      vw: innerWidth, vh: innerHeight,
      left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
      ratio: +(r.width / r.height).toFixed(3),
      validerVisible: !!valider && inside(valider), refuserVisible: !!refuser && inside(refuser),
      commandLines: (cmd.textContent || '').split('\\n').length,
      folded: cmd.className.split(/\\s+/).includes('is-folded'),
      toggleLabel: toggle ? toggle.textContent : null,
      toggleExpanded: toggle ? toggle.getAttribute('aria-expanded') : null,
      toggleControls: toggle ? toggle.getAttribute('aria-controls') : null,
      bodyOverflowY: body ? getComputedStyle(body).overflowY : null,
      bodyScrollTop: body ? body.scrollTop : null,
      reason: win.querySelector('.approval__reason')?.textContent ?? '',
      machine: win.querySelector('.approval__machine')?.textContent ?? '',
      expiry: win.querySelector('.approval__expiry')?.textContent ?? '',
      preview: cmd.textContent ?? '',
      style: win.getAttribute('style'),
    };
  })()`);

await navigate(`${longServer.base}/`);
check(
  "commande de 120 lignes : la fenêtre s'affiche",
  await waitFor(`!!document.querySelector(${JSON.stringify(LONG_SELECTOR)})`),
);
const shape = await shapeState();
check(
  "FORME PAYSAGE ≈ 16/9 (largeur > hauteur)",
  shape.ratio > 1 && Math.abs(shape.ratio - 16 / 9) <= 0.15,
  `${Math.round(shape.width)}×${Math.round(shape.height)} px ; ratio ${shape.ratio} ; 16/9 = ${(16 / 9).toFixed(3)} (tolérance ±0,15)`,
);
check(
  "la fenêtre NE DÉPASSE PAS le viewport (hauteur ET largeur)",
  shape.left >= 0 && shape.top >= 0 && shape.right <= shape.vw + 1 && shape.bottom <= shape.vh + 1,
  `fenêtre (${Math.round(shape.left)},${Math.round(shape.top)})→(${Math.round(shape.right)},${Math.round(shape.bottom)}) ; viewport ${shape.vw}×${shape.vh}`,
);
check(
  "⚠️ Valider ET Refuser TOUJOURS dans le viewport (commande 120 lignes)",
  shape.validerVisible && shape.refuserVisible,
  `bas des boutons ≤ ${shape.vh}`,
);
check(
  "commande longue REPLIÉE par défaut (contenu entier conservé dans le DOM)",
  shape.folded === true && shape.commandLines === 120,
  `${shape.commandLines} lignes`,
);
check(
  "repli ANNONCÉ explicitement (volume + compte de lignes masquées)",
  /Déplier la commande/.test(shape.toggleLabel ?? "") &&
    /\d+ lignes/.test(shape.toggleLabel ?? "") &&
    /masquées/.test(shape.toggleLabel ?? ""),
  String(shape.toggleLabel),
);
check(
  "repli accessible : vrai bouton aria-expanded=false + aria-controls",
  shape.toggleExpanded === "false" && !!shape.toggleControls,
  `aria-expanded=${shape.toggleExpanded} aria-controls=${shape.toggleControls}`,
);
check(
  "défilement INTERNE du contenu (le corps défile, la fenêtre non)",
  shape.bodyOverflowY === "auto",
  String(shape.bodyOverflowY),
);
check(
  "⚠️ l'ESSENTIEL reste visible : raison, machine, compte à rebours, aperçu de commande",
  /suppression \(rm\)/.test(shape.reason) &&
    /nuc00/.test(shape.machine) &&
    /agent-nuc00/.test(shape.machine) &&
    /Expire dans/.test(shape.expiry) &&
    /rm -rf \/srv\/cache/.test(shape.preview),
  `raison="${shape.reason.slice(0, 70)}" ; expiry="${shape.expiry.slice(0, 30)}"`,
);
check(
  "positionnement CSSOM seul (left/top), aucun style parasite",
  /left:\s*-?\d+(\.\d+)?px/.test(shape.style ?? "") && !/background|color|padding/i.test(shape.style ?? ""),
  String(shape.style),
);
await shot("approval-shape-long");

/* 9b) REPLI → DÉPLI par CLIC SOURIS RÉEL : le contenu se déplie, aria-expanded change. */
const toggleRect = await rectOf(`${LONG_SELECTOR} .approval__fold-toggle`);
await mouseClick(
  Math.round(toggleRect.left + toggleRect.width / 2),
  Math.round(toggleRect.top + toggleRect.height / 2),
);
const expanded = await shapeState();
check(
  "clic RÉEL sur « Déplier » : la commande se déplie (aria-expanded=true)",
  expanded.folded === false &&
    expanded.toggleExpanded === "true" &&
    /Replier la commande/.test(expanded.toggleLabel ?? ""),
  String(expanded.toggleLabel),
);
check(
  "⚠️ commande DÉPLIÉE : les boutons Valider/Refuser restent dans le viewport",
  expanded.validerVisible && expanded.refuserVisible,
  `fenêtre bas ${Math.round(expanded.bottom)} ≤ ${expanded.vh}`,
);
await shot("approval-shape-expanded");

/* 9c) NON-RÉGRESSION sur la fenêtre longue : défilement interne + drag. */
await evaluate(`(() => {
  const body = document.querySelector(${JSON.stringify(LONG_SELECTOR)} + ' .approval-window__body');
  body.scrollTop = 400;
  return body.scrollTop;
})()`);
const beforeDrag = await rectOf(LONG_SELECTOR);
const dbarX = Math.round(beforeDrag.left + beforeDrag.width / 2);
const dbarY = Math.round(beforeDrag.top + 16);
await mouseDrag(dbarX, dbarY, dbarX - 200, dbarY - 120);
const afterDrag = await rectOf(LONG_SELECTOR);
check(
  "DÉPLAÇABLE (fenêtre longue, contenu défilé) : la position change au glisser réel",
  Math.abs(afterDrag.left - beforeDrag.left) > 40 && Math.abs(afterDrag.top - beforeDrag.top) > 30,
  `avant=(${Math.round(beforeDrag.left)},${Math.round(beforeDrag.top)}) après=(${Math.round(afterDrag.left)},${Math.round(afterDrag.top)})`,
);
const scrollKept = await evaluate(
  `document.querySelector(${JSON.stringify(LONG_SELECTOR)} + ' .approval-window__body').scrollTop`,
);
check("le défilement interne est conservé après le drag", scrollKept > 0, `scrollTop=${scrollKept}`);

/* 9d) Clic à côté : la fenêtre longue RESTE affichée (non bloquante, non fermable). */
await mouseClick(60, 60);
check("clic à côté : la fenêtre longue RESTE affichée", !!(await shapeState()));

/* 9e) FENÊTRE ÉTROITE (≤ 640 px, barre latérale en rail) : forme encore utilisable. */
await send("Emulation.setDeviceMetricsOverride", { width: 600, height: 800, deviceScaleFactor: 1, mobile: false });
await navigate(`${longServer.base}/`);
await waitFor(`!!document.querySelector(${JSON.stringify(LONG_SELECTOR)})`);
const narrow = await shapeState();
check(
  "fenêtre étroite (600×800) : tient dans le viewport et reste en PAYSAGE",
  narrow.left >= 0 &&
    narrow.right <= narrow.vw + 1 &&
    narrow.bottom <= narrow.vh + 1 &&
    narrow.ratio > 1,
  `${Math.round(narrow.width)}×${Math.round(narrow.height)} px ; ratio ${narrow.ratio} ; viewport ${narrow.vw}×${narrow.vh}`,
);
check(
  "fenêtre étroite : Valider/Refuser toujours atteignables",
  narrow.validerVisible && narrow.refuserVisible,
);
await shot("approval-shape-narrow");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
longServer.proc.kill("SIGTERM");

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
