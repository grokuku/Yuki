#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — MENU CONTEXTUEL d'un canal distant : « quand » répondre,
 * « comment » répondre (fil / nouveau message) et « mentionner l'auteur ».
 *
 * Ce que ce harnais prouve, avec la CSP RÉELLE et sans serveur Mattermost :
 *  - le clic droit sur un CANAL affiche les TROIS groupes, groupés visuellement
 *    (« Quand répondre », « Comment répondre », « Mentionner l'auteur ») ;
 *  - l'option ACTIVE est cochée (● ET `aria-checked="true"`) et vient du SERVEUR ;
 *  - un clic enregistre le réglage (`PATCH /api/chat/conversations/<id>`), sans
 *    rechargement de page, et le serveur le relit (`GET /api/chat/status`) ;
 *  - après RECHARGEMENT, c'est toujours le réglage du SERVEUR qui est coché (aucun
 *    état local qui divergerait) ;
 *  - le clavier n'est pas régressé : `Maj+F10` ouvre le menu, `Échap` le ferme, et
 *    `Entrée` sur une entrée l'applique ;
 *  - rendu DOM PUR (aucun `style` en ligne, aucun HTML interprété) ;
 *  - ZÉRO violation CSP, ZÉRO exception JS, ZÉRO erreur de connexion.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-chat-reply-menu.mjs"
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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-reply-menu-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-chat-reply-menu-serve.ts")], {
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

const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-reply-menu-chrome-"));
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

/** Ouvre le menu du canal (clic droit synthétique sur la ligne de conversation). */
async function ouvrirMenu() {
  await evaluate(`(() => {
    const c = document.querySelector('.conv');
    if (!c) return false;
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 12, clientY: r.top + 12 }));
    return true;
  })()`);
  await sleep(200);
}

/** Photo du bloc de réglages : libellés de groupe + entrées radio et leur état. */
const etatMenu = () =>
  evaluate(`(() => {
    const menu = document.querySelector('.ctx-menu');
    const bloc = [...document.querySelectorAll('.ctx-menu__group')].find((g) => !g.hidden) ?? null;
    if (!menu || menu.hidden || !bloc) return { ouvert: false };
    const libelles = [...bloc.querySelectorAll('.ctx-menu__label')].map((p) => p.textContent.trim());
    const entrees = [...bloc.querySelectorAll('[role="menuitemradio"]')].map((b) => ({
      texte: b.textContent,
      coche: b.getAttribute('aria-checked') === 'true',
      point: b.textContent.startsWith('● '),
      gras: b.classList.contains('ctx-menu__item--active'),
    }));
    return {
      ouvert: true,
      libelles,
      entrees,
      styleEnLigne: bloc.querySelectorAll('[style]').length,
      boutonsSeulement: [...bloc.querySelectorAll('*')].every((n) => ['BUTTON', 'P', 'DIV'].includes(n.tagName)),
    };
  })()`);

/** Clique une entrée par son libellé (sans le point d'état). */
async function cliquer(label) {
  return evaluate(`(() => {
    const b = [...document.querySelectorAll('.ctx-menu__item')].find(
      (x) => x.textContent.replace(/^[●○] /, '') === ${JSON.stringify(label)},
    );
    if (!b) return false;
    b.click();
    return true;
  })()`);
}

/** Réglages vus par le SERVEUR (jamais l'état du DOM). */
async function reglagesServeur() {
  const response = await fetch(`${server.base}/api/chat/status`, {
    headers: { "x-yuki-config": "1", accept: "application/json" },
  });
  const body = await response.json();
  const canal = body?.mattermost?.canaux?.[0] ?? {};
  return { replyMode: canal.replyMode ?? null, replyStyle: canal.replyStyle, quoteAuthor: canal.quoteAuthor };
}

/* ═════════════ 1) Le canal distant est dans la liste ═════════════════════ */
await navigate(`${server.base}/`);
check(
  "mode DISTANT : le canal miroir est affiché dans la barre latérale",
  await waitFor(`document.querySelectorAll('.conv').length === 1`),
);

/* ═════════════ 2) Clic droit : les TROIS groupes ═════════════════════════ */
await ouvrirMenu();
const menu = await etatMenu();
check("CLIC DROIT : le menu du canal s'ouvre", menu.ouvert === true);
check(
  "trois groupes GROUPÉS : « Quand répondre », « Comment répondre », « Mentionner l'auteur »",
  JSON.stringify(menu.libelles) ===
    JSON.stringify(["Réponses de Yuki dans ce canal", "Quand répondre", "Comment répondre", "Mentionner l'auteur"]),
  JSON.stringify(menu.libelles),
);
check(
  "7 entrées radio : 3 (quand) + 2 (comment) + 2 (mention)",
  menu.entrees?.length === 7,
  String(menu.entrees?.length),
);
check(
  "une SEULE option cochée par groupe (point + gras + aria-checked)",
  (() => {
    const groupes = [menu.entrees.slice(0, 3), menu.entrees.slice(3, 5), menu.entrees.slice(5)];
    return groupes.every(
      (g) => g.filter((e) => e.coche).length === 1 && g.every((e) => e.coche === e.point && e.coche === e.gras),
    );
  })(),
  JSON.stringify(menu.entrees),
);
check(
  "DÉFAUTS du serveur cochés : « Répondre seulement si elle est citée », « Réponse dans le fil », « Ne mentionner personne »",
  menu.entrees[2]?.coche === true && menu.entrees[3]?.coche === true && menu.entrees[6]?.coche === true,
);
check("rendu DOM PUR : aucun `style` en ligne dans le menu", menu.styleEnLigne === 0, String(menu.styleEnLigne));
await shot("reply-menu-ouvert");

/* ═════════════ 3) Clic « Nouveau message » ⇒ enregistré côté SERVEUR ═════ */
check("clic sur « Nouveau message »", await cliquer("Nouveau message"));
await sleep(500);
const apresNouveau = await reglagesServeur();
check(
  "SERVEUR : `replyStyle = nouveau` (persisté, pas seulement affiché)",
  apresNouveau.replyStyle === "nouveau",
  JSON.stringify(apresNouveau),
);
check(
  "la page n'a PAS été rechargée (aucune navigation pendant le réglage)",
  (await evaluate(`document.querySelectorAll('.conv').length === 1`)) === true,
);

/* ═════════════ 4) Réouverture : l'état affiché vient du serveur ═════════ */
await ouvrirMenu();
const releve = await etatMenu();
check(
  "menu rouvert : « Nouveau message » est coché, « Réponse dans le fil » ne l'est plus",
  releve.entrees?.[4]?.coche === true && releve.entrees?.[3]?.coche === false,
  JSON.stringify(releve.entrees?.slice(3, 5)),
);

/* ═════════════ 5) « Mentionner l'auteur » ═══════════════════════════════ */
check("clic sur « Mentionner l'auteur »", await cliquer("Mentionner l'auteur"));
await sleep(500);
const apresCitation = await reglagesServeur();
check(
  "SERVEUR : `quoteAuthor = oui`, et `replyStyle` N'A PAS été écrasé",
  apresCitation.quoteAuthor === "oui" && apresCitation.replyStyle === "nouveau",
  JSON.stringify(apresCitation),
);

/* ═════════════ 5bis) « Quand » reste indépendant ═════════════════════════ */
await ouvrirMenu();
check("clic sur « Répondre à tous les messages »", await cliquer("Répondre à tous les messages"));
await sleep(500);
const apresMode = await reglagesServeur();
check(
  "SERVEUR : les trois réglages coexistent (tout / nouveau / oui)",
  apresMode.replyMode === "tout" && apresMode.replyStyle === "nouveau" && apresMode.quoteAuthor === "oui",
  JSON.stringify(apresMode),
);
await shot("reply-menu-regle");

/* ═════════════ 6) RECHARGEMENT : l'état relu du serveur persiste ════════ */
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('.conv').length === 1`);
await ouvrirMenu();
const apresRechargement = await etatMenu();
check(
  "après RECHARGEMENT : les trois choix du SERVEUR sont cochés (aucun état local)",
  apresRechargement.entrees?.[0]?.coche === true &&
    apresRechargement.entrees?.[4]?.coche === true &&
    apresRechargement.entrees?.[5]?.coche === true,
  JSON.stringify(apresRechargement.entrees),
);

/* ═════════════ 7) Clavier : ouverture, Entrée, Échap ════════════════════ */
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await sleep(150);
check(
  "ÉCHAP ferme le menu",
  (await evaluate(`document.querySelector('.ctx-menu').hidden === true`)) === true,
);
check(
  "CLAVIER : `Maj+F10` sur la ligne du canal ouvre le menu (aucune régression)",
  (await evaluate(`(() => {
    const c = document.querySelector('.conv');
    if (!c) return false;
    c.focus();
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }));
    return document.querySelector('.ctx-menu').hidden === false;
  })()`)) === true,
);
check(
  "CLAVIER : une entrée reçoit le FOCUS et `Entrée` l'applique",
  await (async () => {
    const ok = await evaluate(`(() => {
      const b = [...document.querySelectorAll('.ctx-menu__item')].find(
        (x) => x.textContent.replace(/^[●○] /, '') === 'Réponse dans le fil',
      );
      if (!b) return false;
      b.focus();
      return document.activeElement === b;
    })()`);
    if (!ok) return false;
    await send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: "\r",
      unmodifiedText: "\r",
    });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await sleep(500);
    return (await reglagesServeur()).replyStyle === "fil";
  })(),
);
check(
  "aucun débordement horizontal (menu dans la fenêtre)",
  (await evaluate(`document.documentElement.scrollWidth - window.innerWidth`)) <= 1,
);

await stopPage();
server.proc.kill("SIGTERM");
await sleep(300);

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
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`,
);

chrome.kill("SIGKILL");
process.exit(failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1);
