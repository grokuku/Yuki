#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — horodatage du fil : heure discrète sous chaque bulle +
 * séparateurs de jour (trait interrompu, date française complète), avec la CSP
 * RÉELLE et un hôte Pi RÉEL hors ligne (deux fils, deux jours).
 *
 * Vérifie : les heures « juste HH:mm » s'affichent (jamais de date sur les
 * bulles), les séparateurs de jour apparaissent UNE fois par jour (pas entre
 * deux messages d'un même jour), le préfixe `[horodatage]` reste MASQUÉ, le
 * rendu survit à un rechargement ET à une bascule, ZÉRO violation CSP /
 * exception JS. Le rognage du fil en fenêtre étroite (défaut PRÉEXISTANT) n'est
 * PAS traité ici : on vérifie seulement qu'aucun débordement NOUVEAU n'apparaît.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-timestamp.mjs"
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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-time-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-timestamp-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_TIME_DIR: STATE_DIR },
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

const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-time-chrome-"));
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

/** Sonde du fil : séparateurs, heures, préfixe masqué, styles calculés. */
const threadState = () =>
  evaluate(`(() => {
    const conv = document.querySelector('#conversation');
    const seps = [...document.querySelectorAll('.daysep')].map((s) => {
      const label = s.querySelector('.daysep__label');
      const sr = s.getBoundingClientRect();
      const lr = label.getBoundingClientRect();
      return {
        text: label ? label.textContent : '',
        leftGap: Math.round(lr.left - sr.left),
        rightGap: Math.round(sr.right - lr.right),
      };
    });
    const userMsgs = [...document.querySelectorAll('.message--user')].map((m) => ({
      time: m.querySelector('.message__meta__time')?.textContent ?? null,
      end: m.querySelector('.message__meta--end') !== null,
    }));
    const asstMsgs = [...document.querySelectorAll('.message--assistant')].map((m) => ({
      time: m.querySelector('.message__meta__time')?.textContent ?? null,
    }));
    const usermeta = document.querySelector('.message--user .message__meta');
    return {
      seps,
      userTimes: userMsgs.map((m) => m.time),
      userEnd: userMsgs.every((m) => m.end),
      asstTimes: asstMsgs.map((m) => m.time).filter((t) => t !== null),
      hasPrefix: (conv ? conv.textContent : '').includes('horodatage'),
      textAlign: usermeta ? getComputedStyle(usermeta).textAlign : null,
      tabular: usermeta ? getComputedStyle(usermeta).fontVariantNumeric : null,
      styleAttrs: document.querySelectorAll('[style]').length,
      styles: [...document.querySelectorAll('[style]')].map(
        (e) => e.tagName + (e.className ? '.' + String(e.className).split(' ').join('.') : '') + ' → ' + (e.getAttribute('style') || ''),
      ),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  })()`);

/* ═══════════ 1) Fil A restauré : 2 séparateurs, heures masquant le préfixe ═══════════ */
await navigate(`${server.base}/`);
check("le fil s'affiche (3 messages utilisateur)", await waitFor(`document.querySelectorAll('.message--user').length === 3`));
const a = await threadState();

check("2 séparateurs de jour (changement de jour)", a.seps.length === 2, JSON.stringify(a.seps.map((s) => s.text)));
check(
  "séparateur du premier jour CONSERVÉ (mercredi 7 octobre 2026)",
  a.seps[0]?.text === "mercredi 7 octobre 2026",
  String(a.seps[0]?.text),
);
check(
  "second séparateur = lendemain (jeudi 8 octobre 2026)",
  a.seps[1]?.text === "jeudi 8 octobre 2026",
  String(a.seps[1]?.text),
);
check(
  "AUCUN séparateur entre les deux messages du MÊME jour",
  a.seps.length === 2,
  `${a.seps.length} séparateur(s) pour 2 jours`,
);
check(
  "le trait est RÉELLEMENT interrompu (jours des deux côtés du libellé)",
  a.seps.every((s) => s.leftGap > 5 && s.rightGap > 5),
  JSON.stringify(a.seps.map((s) => [s.leftGap, s.rightGap])),
);

check(
  "heures utilisateur « juste HH:mm » (15:39, 16:12, 09:05)",
  JSON.stringify(a.userTimes) === JSON.stringify(["15:39", "16:12", "09:05"]),
  JSON.stringify(a.userTimes),
);
check("heure utilisateur alignée à droite (bord extérieur)", a.userEnd && a.textAlign === "right", `${a.textAlign}`);
check("chiffres à largeur fixe (tabular-nums)", a.tabular === "tabular-nums", String(a.tabular));
check(
  "heures assistant (15:41, 16:14, 09:07)",
  JSON.stringify(a.asstTimes) === JSON.stringify(["15:41", "16:14", "09:07"]),
  JSON.stringify(a.asstTimes),
);
check("AUCUNE date sur les bulles (seulement l'heure)", a.userTimes.every((t) => /^\d{2}:\d{2}$/.test(t)));
check("le préfixe [horodatage] est MASQUÉ à l'affichage", a.hasPrefix === false);
// Le seul `[style]` attendu est le <html> racine : les variables de thème y
// sont posées par CSSOM (`element.style.setProperty`), PRÉEXISTANT et sans
// violation CSP (aucun `<style>` ni `style=` de balisage). L'UI du fil n'ajoute
// AUCUN style en ligne.
const nonRootStyles = a.styles.filter((s) => !s.startsWith("HTML"));
check(
  "0 style= hors racine de thème (UI du fil : aucun style en ligne)",
  nonRootStyles.length === 0,
  JSON.stringify(nonRootStyles),
);
await shot("timestamp-thread");

/* ═══════════ 2) Rechargement : le rendu survit ═══════════ */
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('.message--user').length === 3`);
const reloaded = await threadState();
check("RELOAD : 2 séparateurs conservés", reloaded.seps.length === 2);
check(
  "RELOAD : heures identiques après restauration",
  JSON.stringify(reloaded.userTimes) === JSON.stringify(a.userTimes) &&
    JSON.stringify(reloaded.asstTimes) === JSON.stringify(a.asstTimes),
  JSON.stringify(reloaded.userTimes),
);

/* ═══════════ 3) Bascule de fil : séparateur du fil B ═══════════ */
await evaluate(`(() => {
  const target = [...document.querySelectorAll('.conv')].find((c) => !c.classList.contains('conv--active'));
  target.click();
})()`);
await waitFor(`document.querySelectorAll('.message--user').length === 1`);
await sleep(400);
const b = await threadState();
check("BASCULE : le fil B affiche 1 séparateur (jeudi 1 octobre 2026)", b.seps.length === 1 && b.seps[0]?.text === "jeudi 1 octobre 2026", JSON.stringify(b.seps.map((s) => s.text)));
check("BASCULE : heures du fil B (10:30 / 10:31)", JSON.stringify(b.userTimes) === JSON.stringify(["10:30"]) && JSON.stringify(b.asstTimes) === JSON.stringify(["10:31"]), JSON.stringify([b.userTimes, b.asstTimes]));
check("BASCULE : préfixe toujours masqué", b.hasPrefix === false);

// Retour au fil A : le rendu est reconstruit (snapshot), aucun doublon.
await evaluate(`(() => {
  const target = [...document.querySelectorAll('.conv')].find((c) => !c.classList.contains('conv--active'));
  target.click();
})()`);
await waitFor(`document.querySelectorAll('.message--user').length === 3`);
const back = await threadState();
check("RETOUR au fil A : 2 séparateurs, 3 heures (aucun doublon)", back.seps.length === 2 && back.userTimes.length === 3, JSON.stringify(back.userTimes));

/* ═══════════ 4) Envoi LIVE : l'heure apparaît sous la bulle utilisateur ═══════════ */
await evaluate(`(() => {
  const input = document.querySelector('#input');
  input.value = 'Message live pour tester l horodatage';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#send').click();
})()`);
await sleep(500);
const live = await evaluate(`(() => {
  const msgs = [...document.querySelectorAll('.message--user')];
  const last = msgs[msgs.length - 1];
  return {
    count: msgs.length,
    time: last?.querySelector('.message__meta__time')?.textContent ?? null,
  };
})()`);
check("LIVE : un nouveau message utilisateur horodaté apparaît immédiatement", live.count === 4 && /^\d{2}:\d{2}$/.test(live.time ?? ""), `${live.count} message(s), heure ${live.time}`);
await evaluate(`document.querySelector('#stop')?.click()`);

/* ═══════════ 5) Fenêtre ÉTROITE : aucun débordement NOUVEAU ═══════════ */
await send("Emulation.setDeviceMetricsOverride", { width: 480, height: 720, deviceScaleFactor: 1, mobile: false });
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('.message--user').length >= 3`);
const narrow = await threadState();
check("étroit : séparateurs toujours affichés", narrow.seps.length === 2, `${narrow.seps.length}`);
check("étroit : aucun débordement horizontal NOUVEAU", narrow.overflow <= 1, `débordement ${narrow.overflow} px`);
await shot("timestamp-narrow");

server.proc.kill("SIGTERM");
await sleep(300);

/* ═══════════ Bilan CSP / exceptions ═══════════ */
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
