#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — BOUTON « REVENIR EN BAS DE LA CONVERSATION ».
 *
 * Prouve, par MESURE (Chromium headless + CDP), avec la CSP RÉELLE :
 *   - EN BAS ⇒ le bouton est INVISIBLE (aucun déclenchement à 5 px) ;
 *   - REMONTÉ ⇒ le bouton est VISIBLE, sans décaler le fil (hors flux) ;
 *   - CLIC RÉEL ⇒ `scrollTop` atteint le MAXIMUM, le fil redevient ÉPINGLÉ ;
 *   - pendant une réponse qui STREAME : AUCUN clignotement (échantillonnage) ;
 *   - « on ne tire pas l'écran de quelqu'un qui lit » : un message qui arrive
 *     quand on est remonté NE ramène PAS le fil en bas ;
 *   - le bouton ne RECOUVRE PAS la fenêtre de validation (rectangles), même en
 *     écran étroit (600×800, barre latérale en rail) ;
 *   - le libellé est FRANÇAIS (aria-label + title).
 *   - ENVOI D'UN MESSAGE (long comme court) : on revient EN BAS et la RÉPONSE
 *     qui suit est SUIVIE, même quand la zone de saisie a grandi (message long)
 *     ou qu'on lisait plus haut — sans clignotement du bouton.
 * ZÉRO violation CSP / connexion / exception JS.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-scroll-button.mjs"
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

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-scroll-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-scroll-button-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString()));
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  const urls = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("serveur non démarré :\n" + logs.join(""))),
      40_000,
    );
    const onData = () => {
      const text = logs.join("");
      const ready = text.match(/READY (http:\/\/\S+)/);
      const control = text.match(/CONTROL (http:\/\/\S+)/);
      if (ready && control) {
        clearTimeout(timer);
        resolve({ base: ready[1].trim(), control: control[1].trim() });
      }
    };
    proc.stdout.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serveur quitté (${code}) :\n` + logs.join("")));
    });
  });
  return { proc, ...urls };
}

const server = await startServer();

/* ─── Chromium headless (CDP) ────────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-scroll-chrome-"));
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
  await sleep(700);
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

async function waitFor(expression, timeout = 10_000) {
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

async function mouseClick(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await sleep(120);
}

const control = (path) => fetch(server.control + path).then((r) => r.json());

/** État mesuré : fil, bouton, fenêtre de validation, zone de saisie. */
const state = () =>
  evaluate(`(() => {
    const conv = document.querySelector('#conversation');
    const btn = document.querySelector('.scroll-bottom');
    const win = document.querySelector('.approval-window:not(.approval--result)');
    const composer = document.querySelector('.composer');
    const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect();
      return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; };
    return {
      scrollTop: conv.scrollTop,
      scrollHeight: conv.scrollHeight,
      clientHeight: conv.clientHeight,
      distance: conv.scrollHeight - conv.scrollTop - conv.clientHeight,
      btnPresent: !!btn,
      btnInConversation: !!(btn && conv.contains(btn)),
      btnHidden: btn ? btn.hidden : null,
      btnRect: rect(btn),
      btnSlot: btn ? btn.dataset.slot : null,
      ariaLabel: btn ? btn.getAttribute('aria-label') : null,
      title: btn ? btn.getAttribute('title') : null,
      winRect: rect(win),
      composerRect: rect(composer),
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  })()`);

const overlaps = (a, b) =>
  !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/* ═══════════════ 1) Chargement : fil long + fenêtre de validation ═══════ */
await navigate(`${server.base}/`);
const ready = await waitFor(
  `document.querySelectorAll('#conversation .message').length >= 8 && !!document.querySelector('.approval-window')`,
);
check("le fil est chargé (messages) et la fenêtre de validation est affichée", ready);
await shot("scroll-01-bottom-hidden");

const atBottom = await state();
check(
  "le bouton est monté (hors du fil ⇒ aucun décalage possible)",
  atBottom.btnPresent === true && atBottom.btnInConversation === false,
  `présent=${atBottom.btnPresent} dans le fil=${atBottom.btnInConversation}`,
);
check(
  "libellé FRANÇAIS porté par aria-label ET title",
  atBottom.ariaLabel === "Revenir en bas de la conversation" &&
    atBottom.title === "Revenir en bas de la conversation",
  `aria-label="${atBottom.ariaLabel}"`,
);
check(
  "EN BAS : le fil est épinglé et le bouton est INVISIBLE",
  atBottom.distance <= 24 && atBottom.btnHidden === true,
  `distance=${Math.round(atBottom.distance)} px ; hidden=${atBottom.btnHidden}`,
);

/* ═══════════════ 2) Remonté : le bouton apparaît (sans décaler le fil) ═══ */
const scrollHeightBefore = atBottom.scrollHeight;
const lastContentTopBefore = await evaluate(`(() => {
  const conv = document.querySelector('#conversation');
  const els = conv.querySelectorAll('.message');
  const b = els[els.length - 1].getBoundingClientRect();
  return b.top + conv.scrollTop;
})()`);
await evaluate(`document.querySelector('#conversation').scrollTop = 0`);
await sleep(200);
const remonte = await state();
check(
  "REMONTÉ : le bouton est VISIBLE",
  remonte.btnHidden === false,
  `hidden=${remonte.btnHidden} ; distance=${Math.round(remonte.distance)} px`,
);
const lastContentTopAfter = await evaluate(`(() => {
  const conv = document.querySelector('#conversation');
  const els = conv.querySelectorAll('.message');
  const b = els[els.length - 1].getBoundingClientRect();
  return b.top + conv.scrollTop;
})()`);
check(
  "le bouton ne rejoue PAS la mise en page (hors flux : hauteur et contenu du fil inchangés)",
  Math.abs(remonte.scrollHeight - scrollHeightBefore) <= 1 &&
    Math.abs(lastContentTopAfter - lastContentTopBefore) <= 1,
  `scrollHeight ${scrollHeightBefore} → ${remonte.scrollHeight} ; position contenu ${Math.round(lastContentTopBefore)} → ${Math.round(lastContentTopAfter)}`,
);
check(
  "le bouton prend le coin BAS-GAUCHE (entièrement à GAUCHE de la fenêtre, en BAS-DROITE)",
  remonte.btnSlot === "bottom" &&
    remonte.btnRect.right < remonte.winRect.left &&
    remonte.btnRect.bottom <= remonte.vh,
  `slot=${remonte.btnSlot} ; bouton droite=${Math.round(remonte.btnRect.right)} px ; fenêtre gauche=${Math.round(remonte.winRect.left)} px`,
);
check(
  "le bouton ne RECOUVRE PAS la fenêtre de validation (rectangles disjoints)",
  !overlaps(remonte.btnRect, remonte.winRect),
  `bouton=${JSON.stringify(remonte.btnRect)} fenêtre=${JSON.stringify(remonte.winRect)}`,
);
check(
  "le bouton ne chevauche PAS la zone de saisie (au-dessus d'elle)",
  remonte.btnRect.bottom <= remonte.composerRect.top + 1,
  `bouton bas=${Math.round(remonte.btnRect.bottom)} ; saisie haut=${Math.round(remonte.composerRect.top)}`,
);
await shot("scroll-02-up-visible");

/* ═══════════════ 3) CLIC RÉEL : retour en bas, fil ré-épinglé ════════════ */
const clickX = Math.round(remonte.btnRect.left + remonte.btnRect.width / 2);
const clickY = Math.round(remonte.btnRect.top + remonte.btnRect.height / 2);
await mouseClick(clickX, clickY);
const settled = await waitFor(
  `(() => { const c = document.querySelector('#conversation');
    return c.scrollHeight - c.scrollTop - c.clientHeight <= 2; })()`,
  5000,
);
const afterClick = await state();
check(
  "CLIC : le défilement atteint le MAXIMUM (`scrollTop` = hauteur − hauteur visible)",
  settled && Math.abs(afterClick.scrollTop - (afterClick.scrollHeight - afterClick.clientHeight)) <= 2,
  `scrollTop=${Math.round(afterClick.scrollTop)} ; max=${Math.round(afterClick.scrollHeight - afterClick.clientHeight)}`,
);
check(
  "le fil redevient ÉPINGLÉ et le bouton DISPARAÎT",
  afterClick.distance <= 24 && afterClick.btnHidden === true,
  `distance=${Math.round(afterClick.distance)} px ; hidden=${afterClick.btnHidden}`,
);
await shot("scroll-03-after-click");

/* ═══════════════ 4) Pendant un FLUX : AUCUN clignotement ════════════════ */
await evaluate(`document.querySelector('#conversation').scrollTop = document.querySelector('#conversation').scrollHeight`);
await sleep(120);
const stream1 = await control("/stream?chars=4000&delayMs=5");
const samples = [];
const t0 = Date.now();
while (Date.now() - t0 < 2000) {
  const s = await state();
  samples.push({ hidden: s.btnHidden, distance: s.distance });
  await sleep(50);
}
const transitions = samples.filter((s, i) => i > 0 && s.hidden !== samples[i - 1].hidden).length;
const maxDistance = Math.max(...samples.map((s) => s.distance));
check(
  "FLUX en bas : le bouton reste INVISIBLE, sans AUCUN clignotement",
  samples.length >= 20 && transitions === 0 && samples.every((s) => s.hidden === true),
  `${samples.length} mesures ; ${transitions} transition(s) ; distance max=${Math.round(maxDistance)} px`,
);
check(
  "FLUX en bas : le fil reste ÉPINGLÉ (le défilement automatique suit)",
  maxDistance <= 24,
  `distance max=${Math.round(maxDistance)} px`,
);
await waitFor(`document.querySelector('#session-state').textContent === 'idle'`, 8000);

/* ═ 5) Remonté + message qui arrive : l'écran N'EST PAS tiré en bas ═════ */
await evaluate(`document.querySelector('#conversation').scrollTop = 0`);
await sleep(150);
const reading = await state();
const stream2 = await control("/stream?chars=4000&delayMs=5");
await sleep(900);
const whileReading = await state();
check(
  "« on ne tire pas l'écran de quelqu'un qui lit » : le défilement NE SAUTE PAS en bas",
  Math.abs(whileReading.scrollTop - reading.scrollTop) <= 3,
  `scrollTop ${Math.round(reading.scrollTop)} → ${Math.round(whileReading.scrollTop)}`,
);
check(
  "… et le bouton est VISIBLE (c'est justement son rôle pendant qu'un message arrive)",
  whileReading.btnHidden === false,
  `hidden=${whileReading.btnHidden}`,
);
await shot("scroll-04-reading-not-pulled");
await waitFor(`document.querySelector('#session-state').textContent === 'idle'`, 8000);

/* ═══════════════ 6) ÉCRAN ÉTROIT (600×800, rail) : pas de recouvrement ══ */
await send("Emulation.setDeviceMetricsOverride", {
  width: 600,
  height: 800,
  deviceScaleFactor: 1,
  mobile: false,
});
await navigate(`${server.base}/`);
await waitFor(
  `document.querySelectorAll('#conversation .message').length >= 8 && !!document.querySelector('.approval-window')`,
);
await evaluate(`document.querySelector('#conversation').scrollTop = 0`);
await sleep(200);
const narrow = await state();
check(
  "écran étroit : le bouton est VISIBLE et NE recouvre PAS la fenêtre de validation",
  narrow.btnHidden === false && !overlaps(narrow.btnRect, narrow.winRect),
  `slot=${narrow.btnSlot} ; bouton=${JSON.stringify(narrow.btnRect)} fenêtre=${JSON.stringify(narrow.winRect)}`,
);
check(
  "écran étroit : la fenêtre occupe le bas ⇒ le bouton BASCULE dans le coin HAUT-GAUCHE",
  narrow.btnSlot === "top" && narrow.btnRect.top < narrow.winRect.top,
  `slot=${narrow.btnSlot} ; bouton haut=${Math.round(narrow.btnRect.top)} ; fenêtre haut=${Math.round(narrow.winRect.top)}`,
);
check(
  "écran étroit : le bouton reste à DROITE du rail (atteignable au pouce)",
  narrow.btnRect.left >= 56,
  `left=${Math.round(narrow.btnRect.left)} px`,
);
check(
  "écran étroit : le bouton ne chevauche PAS la zone de saisie",
  narrow.btnRect.bottom <= narrow.composerRect.top + 1,
  `bouton bas=${Math.round(narrow.btnRect.bottom)} ; saisie haut=${Math.round(narrow.composerRect.top)}`,
);
await shot("scroll-05-narrow");

/* Le clic fonctionne aussi en écran étroit. */
const nClickX = Math.round(narrow.btnRect.left + narrow.btnRect.width / 2);
const nClickY = Math.round(narrow.btnRect.top + narrow.btnRect.height / 2);
await mouseClick(nClickX, nClickY);
const narrowSettled = await waitFor(
  `(() => { const c = document.querySelector('#conversation');
    return c.scrollHeight - c.scrollTop - c.clientHeight <= 2; })()`,
  5000,
);
check(
  "écran étroit : le clic ramène bien en bas",
  narrowSettled,
  `scrollTop=${Math.round((await state()).scrollTop)}`,
);

/* ═ 7) ENVOI UTILISATEUR : on reste EN BAS (message LONG comme COURT) ═══
 * Reproduction du bug signalé : un message LONG fait grandir la ZONE DE SAISIE.
 * #conversation RÉTRÉCIT alors sans qu'aucun `scroll` n'ait lieu : la distance au
 * fond dépasse le seuil (24 px) alors que l'utilisateur n'a JAMAIS remonté.
 * L'envoi doit donc ramener en bas et ré-épingler SANS dépendre du seuil, et la
 * réponse qui suit doit être SUIVIE. Cas ① uniquement : le cas ② (« il lit plus
 * haut, un message arrive ») reste couvert par l'étape 5. */
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('#conversation .message').length >= 8`);

/** Saisit `text` dans #input comme un vrai utilisateur (déclenche la croissance). */
const typeIntoInput = (text) =>
  evaluate(`(() => {
    const i = document.querySelector('#input');
    i.focus();
    i.value = ${JSON.stringify(text)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
/** Envoie par Entrée (le vrai chemin de `sendMessage`, pas un clic simulé). */
const pressEnter = () =>
  evaluate(`(() => {
    const i = document.querySelector('#input');
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  })()`);

await evaluate(`(() => { const c = document.querySelector('#conversation'); c.scrollTop = c.scrollHeight; })()`);
await sleep(200);
const beforeType = await state();
check(
  "ENVOI : on part bien du FOND avant de taper",
  beforeType.distance <= 2,
  `distance=${Math.round(beforeType.distance)} px`,
);

const LONG_MESSAGE =
  "Bonjour, je voudrais que tu m'expliques en détail comment fonctionne le défilement automatique du fil de discussion. ".repeat(6);
await typeIntoInput(LONG_MESSAGE);
await sleep(180);
const typedLong = await state();
check(
  "message LONG : la zone de saisie grandit et gonfle la distance au fond (cause du bug)",
  typedLong.distance > 24,
  `distance=${Math.round(typedLong.distance)} px ; hauteur saisie=${Math.round(typedLong.composerRect.height)} px`,
);

await control("/arm?chars=3000&delayMs=4");
await pressEnter();
await sleep(150);
const afterLongSend = await state();
check(
  "ENVOI (message LONG) : le fil est ramené EN BAS (distance ≈ 0, indépendant du seuil)",
  afterLongSend.distance <= 2,
  `distance=${Math.round(afterLongSend.distance)} px (avant l'envoi : ${Math.round(typedLong.distance)} px)`,
);
check(
  "ENVOI : le bouton « revenir en bas » reste INVISIBLE (on est au fond)",
  afterLongSend.btnHidden === true,
  `hidden=${afterLongSend.btnHidden}`,
);

/* Échantillonnage pendant la RÉPONSE : le fil doit SUIVRE et le bouton ne doit
 * pas clignoter. */
const sendSamples = [];
const sendT0 = Date.now();
while (Date.now() - sendT0 < 2500) {
  sendSamples.push(await state());
  await sleep(60);
}
const sendTransitions = sendSamples.filter(
  (s, i) => i > 0 && s.btnHidden !== sendSamples[i - 1].btnHidden,
).length;
const maxSendDistance = Math.max(...sendSamples.map((s) => s.distance));
check(
  "la RÉPONSE qui arrive est SUIVIE : le fil reste EN BAS (distance ≈ 0 tout du long)",
  maxSendDistance <= 2,
  `${sendSamples.length} mesures ; distance max=${Math.round(maxSendDistance)} px`,
);
check(
  "le bouton ne CLIGNOTE pas pendant la réponse qui suit l'envoi",
  sendTransitions === 0 && sendSamples.every((s) => s.btnHidden === true),
  `${sendTransitions} transition(s) ; hidden=${sendSamples[sendSamples.length - 1].btnHidden}`,
);
await shot("scroll-06-after-long-send");
await waitFor(`document.querySelector('#session-state').textContent === 'idle'`, 8000);

/* Message COURT : même garantie. */
await evaluate(`(() => { const c = document.querySelector('#conversation'); c.scrollTop = c.scrollHeight; })()`);
await sleep(120);
await typeIntoInput("Merci, c'est court.");
await control("/arm-text?text=Réponse à un message court.");
await pressEnter();
await sleep(150);
const afterShortSend = await state();
check(
  "ENVOI (message COURT) : même garantie (distance ≈ 0, bouton invisible)",
  afterShortSend.distance <= 2 && afterShortSend.btnHidden === true,
  `distance=${Math.round(afterShortSend.distance)} px ; hidden=${afterShortSend.btnHidden}`,
);
await waitFor(`document.querySelector('#session-state').textContent === 'idle'`, 8000);

/* Cas ① même quand l'utilisateur lisait PLUS HAUT : il vient d'AGIR ⇒ en bas. */
await evaluate(`(() => { const c = document.querySelector('#conversation'); c.scrollTop = 0; })()`);
await sleep(150);
const readingUp = await state();
check(
  "remonté : le fil n'est plus épinglé (distance > seuil)",
  readingUp.distance > 24,
  `distance=${Math.round(readingUp.distance)} px`,
);
await typeIntoInput("Je reprends la main.");
await control("/arm-text?text=Réponse après une remontée.");
await pressEnter();
await sleep(150);
const sendWhileReading = await state();
check(
  "ENVOI alors qu'on lisait PLUS HAUT : on REVIENT en bas (un envoi ⇒ on va en bas)",
  sendWhileReading.distance <= 2 && sendWhileReading.btnHidden === true,
  `distance=${Math.round(sendWhileReading.distance)} px ; hidden=${sendWhileReading.btnHidden}`,
);
await waitFor(`document.querySelector('#session-state').textContent === 'idle'`, 8000);

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

console.log(`\nFlux lancés : ${stream1.runId} / ${stream2.runId}`);
console.log(`Captures (non suivies) : ${SHOTS}`);
const failed = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; connexion = ${connectionErrors.length} ; exceptions = ${pageExceptions.length} ═══`,
);

ws.close();
chrome.kill("SIGTERM");
await sleep(200);
process.exit(failed.length === 0 ? 0 : 1);
