#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — INTERFACE TÉLÉPHONE (page `/`).
 *
 * Prouve PAR MESURE, avec la CSP RÉELLE et un hôte Pi RÉEL hors ligne :
 *   1) en 360×640 : la barre latérale est ABSENTE et le fil occupe TOUTE la
 *      largeur (sa demande n°1) ;
 *   2) les TROIS boutons (Conversations / Agents / Config) sont visibles, de
 *      largeur ÉGALE, à 34 px de haut, et leur libellé n'est jamais coupé ;
 *   3) chaque menu s'ouvre, affiche son contenu, et se referme au toucher à
 *      côté ; l'état ouvert est accentué + chevron retourné ;
 *   4) « Conversation dédiée » n'est PLUS près du bouton stop et EST dans le
 *      menu du titre ; l'appui long (tactile) ouvre ce menu, le clic droit
 *      (bureau) aussi ;
 *   5) le bouton stop est CARRÉ (36×36) avec une icône, l'envoi reste séparé ;
 *   6) en 1280 px : la barre latérale est TOUJOURS LÀ (56 px → 280 px → 56 px),
 *      le menu du titre reste au clic droit, et la barre téléphone est masquée ;
 *   7) en PAYSAGE de téléphone (844×390, doigt) : même dessin téléphone ;
 *   8) ZÉRO violation CSP / connexion / exception.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-mobile-ui.mjs"
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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-mobile-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

/* ─── Démarrage du gateway de test (conversations + agents) ─────────────── */
async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-pins-agents-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_DIR: STATE_DIR },
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

/* ─── Chromium headless (CDP) ────────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-mobile-chrome-"));
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
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
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

/** Applique une taille de fenêtre (et l'émulation tactile si demandée). */
async function setViewport(width, height, { mobile = false } = {}) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  await send("Emulation.setTouchEmulationEnabled", {
    enabled: mobile,
    ...(mobile ? { maxTouchPoints: 1 } : {}),
  });
}

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
  // Force une frame à jour (le compositeur headless peut sinon rendre la
  // dernière frame soumise avant une mutation DOM/CSS).
  await send("Runtime.evaluate", {
    expression: "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
    awaitPromise: true,
  });
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
}

/** Clic RÉEL (CDP) au point (x, y) — traverse la couche de rendu. */
async function clickAt(x, y) {
  await send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: 0,
  });
  await sleep(20);
  await send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(20);
  await send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(250);
}

/** Centre d'un élément (coordonnées viewport) ou `null`. */
const centerOf = (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);

/** État complet de l'interface téléphone, en une évaluation. */
const phoneState = () =>
  evaluate(`(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), bottom: Math.round(r.bottom) };
    };
    const sidebar = document.querySelector('.sidebar');
    const chat = document.querySelector('#chat');
    const conversation = document.querySelector('#conversation');
    const mnav = document.querySelector('.mnav');
    const layer = document.querySelector('.mnav-layer');
    const buttons = [...document.querySelectorAll('.mnav__btn')].map((b) => {
      const label = b.querySelector('.mnav__label');
      const cs = getComputedStyle(b);
      const chevron = b.querySelector('.mnav__chevron');
      return {
        nav: b.getAttribute('data-nav'),
        expanded: b.getAttribute('aria-expanded'),
        width: Math.round(b.getBoundingClientRect().width),
        height: Math.round(b.getBoundingClientRect().height),
        overflow: b.scrollWidth - b.clientWidth,
        labelOverflow: label ? label.scrollWidth - label.clientWidth : null,
        labelFits: label ? label.scrollWidth <= label.clientWidth + 1 : null,
        labelClient: label ? label.clientWidth : null,
        labelScroll: label ? label.scrollWidth : null,
        labelText: label ? label.textContent : '',
        textOverflow: label ? getComputedStyle(label).textOverflow : null,
        radius: cs.borderTopLeftRadius,
        chevronTransform: chevron ? getComputedStyle(chevron).transform : null,
        icon: !!b.querySelector('svg'),
      };
    });
    const panels = [...document.querySelectorAll('.mnav-panel')].map((p) => ({
      panel: p.getAttribute('data-panel'),
      hidden: p.hidden,
      rect: rect(p),
    }));
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      sidebarDisplay: sidebar ? getComputedStyle(sidebar).display : null,
      sidebarRect: rect(sidebar),
      chatRect: rect(chat),
      conversationRect: rect(conversation),
      conversationHeight: conversation ? conversation.clientHeight : 0,
      mnavDisplay: mnav ? getComputedStyle(mnav).display : null,
      mnavRect: rect(mnav),
      layer: layer ? { hidden: layer.hidden, rect: rect(layer), style: layer.getAttribute('style') } : null,
      buttons,
      panels,
      composerRect: rect(document.querySelector('.composer')),
      stopRect: rect(document.querySelector('#stop')),
      sendRect: rect(document.querySelector('#send')),
      stopIcon: !!document.querySelector('#stop svg'),
      stopDisabled: document.querySelector('#stop')?.disabled ?? null,
      convCount: document.querySelectorAll('.conv').length,
      menuConvCount: document.querySelectorAll('.mnav-conv').length,
      menuConvTitles: [...document.querySelectorAll('.mnav-conv')].map((c) => c.querySelector('.conv__title')?.textContent ?? ''),
      menuConvActive: [...document.querySelectorAll('.mnav-conv')].filter((c) => c.classList.contains('mnav-conv--active')).length,
      menuConvHasUnread: document.querySelectorAll('.mnav-conv .conv__unread').length,
      menuConvHasBusy: document.querySelectorAll('.mnav-conv .conv__busy').length,
      menuConvExcerpts: [...document.querySelectorAll('.mnav-conv .conv__excerpt')].map((e) => e.textContent),
      menuConvMetas: [...document.querySelectorAll('.mnav-conv .conv__meta')].map((e) => e.textContent),
      menuConvTimes: [...document.querySelectorAll('.mnav-conv .mnav-conv__time')].map((e) => e.textContent),
      menuConvPinned: [...document.querySelectorAll('.mnav-conv')].filter((c) => c.classList.contains('mnav-conv--pinned')).length,
      ctxMenu: (() => {
        const m = document.querySelector('.ctx-menu');
        return m ? {
          open: !m.hidden,
          items: [...m.querySelectorAll('.ctx-menu__item')].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled })),
        } : null;
      })(),
      theme: document.documentElement.getAttribute('data-theme'),
      placeholder: document.querySelector('#input')?.getAttribute('placeholder') ?? null,
      mobileMedia: window.matchMedia('(max-width: 767px), (max-height: 480px) and (pointer: coarse)').matches,
      recapNearStop: !!document.querySelector('.composer #recap-dedicated'),
      configItems: [...document.querySelectorAll('#mnav-panel-config .mnav-item')].map((a) => a.textContent.replace(/\\s+/g, ' ').trim()),
      agentRows: [...document.querySelectorAll('.mnav-agent')].map((r) => ({
        name: r.querySelector('.side-agent__name')?.textContent ?? '',
        state: r.querySelector('.side-agent__state')?.textContent ?? '',
        level: r.querySelector('.mnav-agent__level')?.textContent ?? '',
        levelAttr: r.querySelector('.mnav-agent__level')?.getAttribute('data-level') ?? '',
        online: r.querySelector('.side-agent__badge')?.getAttribute('data-online') ?? '',
        dotColor: (() => {
          const dot = r.querySelector('.side-agent__dot');
          return dot ? getComputedStyle(dot).backgroundColor : '';
        })(),
      })),
      agentLinks: [...document.querySelectorAll('#mnav-panel-agents a')].map((a) => a.textContent.trim()),
    };
  })()`);

/* ══════════════════ 1) TÉLÉPHONE 360×640 ═════════════════════════════════ */
await setViewport(360, 640, { mobile: true });
await navigate(`${server.base}/`);
check("la liste des conversations est chargée (2 fils)", await waitFor(`document.querySelectorAll('.conv').length === 2`));

const phone = await phoneState();
check(
  "360×640 : barre latérale ABSENTE (display:none, largeur 0)",
  phone.sidebarDisplay === "none" && phone.sidebarRect.width === 0,
  `display=${phone.sidebarDisplay} largeur=${phone.sidebarRect?.width}`,
);
check(
  "360×640 : le FIL occupe TOUTE la largeur (chat = 360 px, fil = 360 px)",
  Math.abs(phone.chatRect.width - 360) <= 1 && Math.abs(phone.conversationRect.width - 360) <= 1,
  `chat=${phone.chatRect.width} px ; fil=${phone.conversationRect.width} px ; gauche=${phone.conversationRect.left}`,
);
check(
  "360×640 : hauteur du fil MESURÉE (toute la place restante)",
  phone.conversationHeight >= 380,
  `${phone.conversationHeight} px de haut (barre téléphone ${phone.mnavRect?.height} px + composeur ${phone.composerRect?.height} px)`,
);
check(
  "360×640 : les TROIS boutons sont visibles, de largeur ÉGALE",
  phone.buttons.length === 3 &&
    phone.buttons.every((b) => Math.abs(b.width - phone.buttons[0].width) <= 1) &&
    phone.mnavDisplay === "flex",
  phone.buttons.map((b) => `${b.nav}=${b.width}px`).join(" | "),
);
check(
  "360×640 : boutons de 34 px de haut, rayon 10 px, icône de la brique",
  phone.buttons.every((b) => b.height === 34 && b.radius === "10px" && b.icon === true),
  phone.buttons.map((b) => `${b.nav}: ${b.height}px, ${b.radius}, icône=${b.icon}`).join(" | "),
);
check(
  "360×640 : les libellés TIENNENT en entier (aucune troncature), ellipse prête",
  phone.buttons.every(
    (b) =>
      b.overflow <= 1 &&
      b.textOverflow === "ellipsis" &&
      b.labelFits === true &&
      b.labelScroll <= b.labelClient,
  ),
  phone.buttons.map((b) => `${b.nav}: « ${b.labelText} » débordement=${b.labelOverflow}px`).join(" | "),
);
await shot("mobile-01-phone");

/* ── 1bis) 320 px : ça tient encore (ellipse attendue, aucun débordement) ── */
await setViewport(320, 640, { mobile: true });
await sleep(300);
const narrow320 = await phoneState();
check(
  "320×640 : les trois boutons tiennent (ellipse propre, aucun débordement)",
  narrow320.buttons.length === 3 &&
    narrow320.buttons.every((b) => b.overflow <= 1 && b.textOverflow === "ellipsis"),
  narrow320.buttons
    .map((b) => `${b.nav}: ${b.width}px, ellipse=${b.textOverflow}, débordement=${b.overflow}px`)
    .join(" | "),
);
await shot("mobile-02-phone-320");
await setViewport(360, 640, { mobile: true });
await sleep(300);

/* ══════════════ 2) CONVERSATIONS : ouverture, contenu, fermeture ════════ */
let center = await centerOf('[data-nav="conversations"]');
await clickAt(center.x, center.y);
const convOpen = await phoneState();
check(
  "menu Conversations : ouvert sous la barre (aria-expanded + chevron retourné)",
  convOpen.buttons[0].expanded === "true" &&
    convOpen.buttons[0].chevronTransform !== "none" &&
    convOpen.panels.find((p) => p.panel === "conversations")?.hidden === false,
  `transform=${convOpen.buttons[0].chevronTransform}`,
);
check(
  "menu Conversations : 2 conversations, active mise en évidence",
  convOpen.menuConvCount === 2 && convOpen.menuConvActive === 1,
  `${convOpen.menuConvCount} ligne(s), ${convOpen.menuConvActive} active(s)`,
);
check(
  "menu Conversations : titre + compteur + heure + indicateurs (non lu / en cours)",
  convOpen.menuConvTitles.every((t) => t.length > 0) &&
    convOpen.menuConvMetas.length === 2 &&
    convOpen.menuConvMetas.every((m) => /message/.test(m)) &&
    convOpen.menuConvTimes.length === 2 &&
    convOpen.menuConvHasUnread === 2 &&
    convOpen.menuConvHasBusy === 2,
  `titres=${JSON.stringify(convOpen.menuConvTitles)} ; compteurs=${JSON.stringify(convOpen.menuConvMetas)} ; heures=${JSON.stringify(convOpen.menuConvTimes)}`,
);
check(
  "menu Conversations : la barre reste au-dessus du panneau (aucun recouvrement)",
  convOpen.panels.find((p) => p.panel === "conversations").rect.top >= convOpen.mnavRect.bottom - 1,
  `panneau haut=${convOpen.panels.find((p) => p.panel === "conversations").rect.top} ; barre bas=${convOpen.mnavRect.bottom}`,
);
await shot("mobile-03-conversations");

/* Fermeture au toucher À CÔTÉ (dans la marge gauche du calque, hors panneau). */
const convPanel = convOpen.panels.find((p) => p.panel === "conversations").rect;
await clickAt(4, convPanel.top + 20);
const convClosed = await phoneState();
check(
  "menu Conversations : un toucher À CÔTÉ le ferme",
  convClosed.panels.every((p) => p.hidden) && convClosed.buttons[0].expanded === "false",
  `calque masqué=${convClosed.layer?.hidden}`,
);
await shot("mobile-04-conversations-closed");

/* ═══════════════════ 3) APPUI LONG ⇒ menu du TITRE ══════════════════════ */
center = await centerOf('[data-nav="conversations"]');
await clickAt(center.x, center.y);
// Appui long TACTILE sur la ligne ACTIVE (événements PointerEvent « touch »).
const longPress = await evaluate(`(async () => {
  const row = document.querySelector('.mnav-conv--active');
  if (!row) return { ok: false, reason: 'ligne active absente' };
  const r = row.getBoundingClientRect();
  const x = Math.round(r.left + 20);
  const y = Math.round(r.top + r.height / 2);
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, button: 0 }));
  await new Promise((res) => setTimeout(res, 650));
  const opened = (() => {
    const m = document.querySelector('.ctx-menu');
    return !!m && !m.hidden;
  })();
  // Relâchement : le clic qui suit ne doit PAS changer de conversation.
  row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y }));
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  await new Promise((res) => setTimeout(res, 150));
  return { ok: opened };
})()`);
check("APPUI LONG sur le titre (tactile) : le menu du titre s'ouvre", longPress.ok === true, JSON.stringify(longPress));

const titleMenu = await phoneState();
const items = titleMenu.ctxMenu?.items ?? [];
check(
  "menu du titre : Renommer, Épingler, Mettre de côté, Supprimer, Conversation dédiée…",
  ["Renommer", "Épingler", "Mettre de côté", "Supprimer"].every((label) =>
    items.some((i) => i.text === label),
  ) && items.some((i) => i.text.startsWith("Conversation dédiée")),
  items.map((i) => `${i.text}${i.disabled ? " (désactivé)" : ""}`).join(" | "),
);
check(
  "menu du titre : « Conversation dédiée… » ACTIVE sur la conversation ouverte",
  items.some((i) => i.text.startsWith("Conversation dédiée") && !i.disabled),
);
check(
  "« Conversation dédiée » n'est PLUS près du bouton stop (composeur)",
  titleMenu.recapNearStop === false && titleMenu.stopRect !== null,
);
await shot("mobile-05-title-menu");

/* Épingler depuis le MENU DU TITRE : la liste du menu remonte l'épinglée en TÊTE
 * (même ordre que la barre latérale, poussé par le serveur). */
const activeTitle = await evaluate(`document.querySelector('.mnav-conv--active .conv__title')?.textContent ?? ''`);
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.ctx-menu__item')].find((x) => x.textContent === 'Épingler');
  b.click();
})()`);
await sleep(700);
const afterPin = await phoneState();
check(
  "menu Conversations : la conversation ÉPINGLÉE depuis le menu du titre remonte en TÊTE",
  afterPin.menuConvPinned === 1 && afterPin.menuConvTitles[0] === activeTitle,
  `épinglées=${afterPin.menuConvPinned} ; ordre=${JSON.stringify(afterPin.menuConvTitles)}`,
);
await shot("mobile-05b-pinned");
// Désépingler (menu du titre, appui long sur la ligne épinglée) : état remis.
await evaluate(`(async () => {
  const row = document.querySelector('.mnav-conv--pinned');
  const r = row.getBoundingClientRect();
  const x = Math.round(r.left + 20);
  const y = Math.round(r.top + r.height / 2);
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, button: 0 }));
  await new Promise((res) => setTimeout(res, 650));
  // Relâchement du doigt AVANT de choisir l'entrée : le clic de relâchement est
  // absorbé (voir long-press.js), puis le toucher suivant choisit l'entrée.
  row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y }));
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  await new Promise((res) => setTimeout(res, 150));
  const b = [...document.querySelectorAll('.ctx-menu__item')].find((el) => el.textContent === 'Désépingler');
  if (b) b.click();
})()`);
await sleep(700);
const afterUnpin = await phoneState();
check(
  "menu Conversations : « Désépingler » remet la liste dans l'ordre du serveur",
  afterUnpin.menuConvPinned === 0,
  `épinglées=${afterUnpin.menuConvPinned}`,
);

/* Le parcours « conversation dédiée » démarre depuis le menu. */
// Le menu du titre a été refermé par « Désépingler » : on le rouvre par un
// APPUI LONG sur la conversation ouverte, puis on choisit l'entrée.
await evaluate(`(async () => {
  const row = document.querySelector('.mnav-conv--active');
  const r = row.getBoundingClientRect();
  const x = Math.round(r.left + 20);
  const y = Math.round(r.top + r.height / 2);
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, button: 0 }));
  await new Promise((res) => setTimeout(res, 650));
  row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y }));
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  await new Promise((res) => setTimeout(res, 150));
})()`);
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.ctx-menu__item')].find((x) => x.textContent.startsWith('Conversation dédiée'));
  b.click();
})()`);
check(
  "« Conversation dédiée… » ouvre la saisie du SUJET (parcours existant)",
  await waitFor(`!!document.querySelector('.holaf-modal-input')`),
);
await evaluate(`document.querySelector('.holaf-modal-btn--cancel')?.click() ?? [...document.querySelectorAll('.holaf-modal-btn')].find((b) => /Annuler/.test(b.textContent))?.click()`);
await sleep(400);

/* Sur une AUTRE conversation : l'entrée OUVRE d'abord le fil, puis déclenche.
 * (Le parcours ne récapitule que le fil FOCALISÉ : on ne promet pas l'inverse.) */
center = await centerOf('[data-nav="conversations"]');
await clickAt(center.x, center.y);
const targetOther = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.mnav-conv')].find((r) => !r.classList.contains('mnav-conv--active'));
  if (!row) return '';
  const title = row.querySelector('.conv__title')?.textContent ?? '';
  const r = row.getBoundingClientRect();
  const x = Math.round(r.left + 20);
  const y = Math.round(r.top + r.height / 2);
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, button: 0 }));
  return title;
})()`);
await sleep(650);
await evaluate(`(async (title) => {
  const rows = [...document.querySelectorAll('.mnav-conv')];
  const row = rows.find((r) => r.querySelector('.conv__title')?.textContent === title);
  if (row) {
    row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch' }));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  await new Promise((res) => setTimeout(res, 150));
  const b = [...document.querySelectorAll('.ctx-menu__item')].find((x) => x.textContent.startsWith('Conversation dédiée'));
  b?.click();
})(${JSON.stringify("__TITLE__")})`.replace('"__TITLE__"', JSON.stringify(targetOther)));
check(
  "« Conversation dédiée… » sur un AUTRE fil : il est d'abord OUVERT, puis la saisie s'ouvre",
  (await waitFor(`!!document.querySelector('.holaf-modal-input')`, 8000)) &&
    (await evaluate(`document.querySelector('.mnav-conv--active .conv__title')?.textContent ?? ''`)) ===
      targetOther,
  `cible=${targetOther}`,
);
await shot("mobile-05c-recap-other");
await evaluate(`[...document.querySelectorAll('.holaf-modal-btn')].find((b) => /Annuler/.test(b.textContent))?.click()`);
await sleep(300);

/* ═════════════════════ 4) MENU AGENTS ══════════════════════════════════ */
center = await centerOf('[data-nav="agents"]');
await clickAt(center.x, center.y);
const agents = await phoneState();
check(
  "menu Agents : une ligne par agent appairé (hors révoqués)",
  agents.agentRows.length === 2,
  agents.agentRows.map((r) => r.name).join(", "),
);
check(
  "menu Agents : connexion (pastille), niveau de garde-fou visible, dernière activité",
  agents.agentRows.some((r) => r.name === "nuc00" && r.level === "Destructrices" && /vu (à|le)/.test(r.state)) &&
    agents.agentRows.every((r) => r.level.length > 0 && /Connecté|Déconnecté/.test(r.state)),
  agents.agentRows.map((r) => `${r.name}: ${r.state} / ${r.level}`).join(" | "),
);
check(
  "menu Agents : « + Appairer » et le lien « Gérer les agents et les niveaux… »",
  agents.agentLinks.some((t) => /Appairer/.test(t)) &&
    agents.agentLinks.some((t) => /Gérer les agents et les niveaux/.test(t)),
  agents.agentLinks.join(" | "),
);
await shot("mobile-06-agents");

/* Appui long sur une ligne d'agent : MÊME menu de niveau (4 niveaux + conséquences). */
const agentLongPress = await evaluate(`(async () => {
  const row = document.querySelector('.mnav-agent');
  if (!row) return { ok: false };
  const r = row.getBoundingClientRect();
  const x = Math.round(r.left + 20);
  const y = Math.round(r.top + r.height / 2);
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, button: 0 }));
  await new Promise((res) => setTimeout(res, 650));
  // ⚠️ Deux menus cohabitent : celui des CONVERSATIONS (toujours monté) et
  // celui des AGENTS (monté à la demande, classe ctx-menu--levels).
  const m = document.querySelector('.ctx-menu--levels');
  const ok = !!m && !m.hidden;
  const radios = m ? [...m.querySelectorAll('.ctx-menu__item--radio')].map((b) => b.querySelector('.ctx-menu__text')?.textContent ?? '') : [];
  row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch' }));
  // Comme un vrai doigt : un clic suit le relâchement (il est absorbé par
  // l'appui long — sinon il basculerait l'agent par accident).
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  await new Promise((res) => setTimeout(res, 150));
  return { ok, radios };
})()`);
check(
  "APPUI LONG sur un agent : le MÊME menu de niveau (4 niveaux)",
  agentLongPress.ok === true && agentLongPress.radios.length === 4,
  (agentLongPress.radios ?? []).join(" | "),
);
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

/* ═════════════════════ 5) MENU CONFIG ══════════════════════════════════ */
center = await centerOf('[data-nav="config"]');
await clickAt(center.x, center.y);
const config = await phoneState();
check(
  "menu Config : les 7 entrées attendues (personnalité → système & modèles)",
  ["Personnalité & règles", "Mémoire durable", "Coffre de secrets", "Voix (TTS)", "Thème", "Notifications", "Système & modèles"].every(
    (label) => config.configItems.some((t) => t.startsWith(label)),
  ),
  config.configItems.join(" | "),
);
check("menu Config : le thème courant est affiché à côté de « Thème »", config.configItems.some((t) => /Thème (Corail|Ambre|Émeraude|Turquoise|Améthyste|Neutre)/.test(t)), config.configItems.find((t) => t.startsWith("Thème")));
await shot("mobile-07-config");

/* Bascule de thème depuis le menu (le THÈME vient des variables, pas du mockup). */
const beforeTheme = config.theme;
await evaluate(`[...document.querySelectorAll('#mnav-panel-config .mnav-item')].find((b) => b.textContent.trim().startsWith('Thème')).click()`);
await sleep(250);
const afterTheme = await evaluate(`document.documentElement.getAttribute('data-theme')`);
check(
  "menu Config : « Thème » bascule le MODE en conservant la famille",
  beforeTheme !== afterTheme && String(afterTheme).startsWith("neutre-"),
  `${beforeTheme} → ${afterTheme}`,
);
await evaluate(`[...document.querySelectorAll('#mnav-panel-config .mnav-item')].find((b) => b.textContent.trim().startsWith('Thème')).click()`);
await sleep(200);

/* Fermeture au toucher à côté (marge gauche du calque). */
const configPanel = (await phoneState()).panels.find((p) => p.panel === "config").rect;
await clickAt(4, configPanel.top + 40);
const configClosed = await phoneState();
check(
  "menu Config : un toucher À CÔTÉ le ferme",
  configClosed.panels.every((p) => p.hidden),
  `calque masqué=${configClosed.layer?.hidden}`,
);

/* ═══════════ 6) STOP CARRÉ + bascule de conversation depuis le menu ═════ */
check(
  "bouton stop : CARRÉ 36×36, icône de stop, bouton d'envoi SÉPARÉ",
  Math.abs(phone.stopRect.width - 36) <= 1 &&
    Math.abs(phone.stopRect.height - 36) <= 1 &&
    phone.stopIcon === true &&
    phone.sendRect !== null &&
    phone.stopRect.left >= phone.sendRect.left + phone.sendRect.width - 1,
  `stop=${phone.stopRect.width}×${phone.stopRect.height} ; envoi=${phone.sendRect.width}×${phone.sendRect.height} ; icône=${phone.stopIcon}`,
);
await shot("mobile-08-stop-square");

center = await centerOf('[data-nav="conversations"]');
await clickAt(center.x, center.y);
const beforeSwitch = await phoneState();
const targetTitle = beforeSwitch.menuConvTitles.find((t) => t !== beforeSwitch.menuConvTitles[beforeSwitch.menuConvTitles.length - 1]);
await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.mnav-conv')];
  const target = rows.find((r) => !r.classList.contains('mnav-conv--active'));
  if (target) target.click();
})()`);
await sleep(900);
const afterSwitch = await phoneState();
check(
  "menu Conversations : un toucher sur un fil bascule ET referme le menu",
  afterSwitch.menuConvActive === 1 &&
    afterSwitch.buttons[0].expanded === "false" &&
    afterSwitch.panels.every((p) => p.hidden),
  `actifs=${afterSwitch.menuConvActive} ; menu fermé=${afterSwitch.panels.every((p) => p.hidden)}`,
);

/* ══════════════════ 7) PAYSAGE DE TÉLÉPHONE (844×390) ══════════════════ */
await setViewport(844, 390, { mobile: true });
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('.conv').length === 2`);
const landscape = await phoneState();
check(
  "paysage de téléphone (844×390, doigt) : même dessin téléphone (pas de barre latérale)",
  landscape.sidebarDisplay === "none" && landscape.mnavDisplay === "flex",
  `barre latérale=${landscape.sidebarDisplay} ; barre téléphone=${landscape.mnavDisplay}`,
);
await shot("mobile-09-landscape");

/* ═════════════════════════ 8) BUREAU 1280 px ═══════════════════════════ */
await setViewport(1280, 900, { mobile: false });
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('.conv').length === 2`);
const desktop = await evaluate(`(() => {
  const sidebar = document.querySelector('.sidebar');
  const mnav = document.querySelector('.mnav');
  const toggle = document.querySelector('.sidebar__toggle');
  const r = sidebar.getBoundingClientRect();
  const t = toggle.getBoundingClientRect();
  return {
    display: getComputedStyle(sidebar).display,
    width: Math.round(r.width),
    expanded: sidebar.getAttribute('data-expanded'),
    mnavDisplay: mnav ? getComputedStyle(mnav).display : null,
    toggle: { x: Math.round(t.left + t.width / 2), y: Math.round(t.top + t.height / 2) },
    chatWidth: Math.round(document.querySelector('#chat').getBoundingClientRect().width),
  };
})()`);
check(
  "1280 px : la barre latérale est TOUJOURS LÀ (rail 56 px) et la barre téléphone masquée",
  desktop.display !== "none" && desktop.width === 56 && desktop.mnavDisplay === "none",
  `largeur=${desktop.width} px ; display=${desktop.display} ; mnav=${desktop.mnavDisplay}`,
);
await clickAt(desktop.toggle.x, desktop.toggle.y);
await sleep(600);
const expandedDesk = await evaluate(`(() => {
  const sb = document.querySelector('.sidebar');
  return { width: Math.round(sb.getBoundingClientRect().width), expanded: sb.getAttribute('data-expanded'), chat: Math.round(document.querySelector('#chat').getBoundingClientRect().width) };
})()`);
check(
  "1280 px : le bouton de repli déplie à 280 px (le fil se rétrécit, comme avant)",
  Math.abs(expandedDesk.width - 280) <= 2 && expandedDesk.expanded === "true" && expandedDesk.chat === 1000,
  `largeur=${expandedDesk.width} px ; fil=${expandedDesk.chat} px`,
);
await shot("mobile-10-desktop-expanded");
const toggle2 = await centerOf(".sidebar__toggle");
await clickAt(toggle2.x, toggle2.y);
await sleep(600);
const collapsedDesk = await evaluate(`(() => {
  const sb = document.querySelector('.sidebar');
  return { width: Math.round(sb.getBoundingClientRect().width), expanded: sb.getAttribute('data-expanded') };
})()`);
check(
  "1280 px : le re-clic replie à 56 px (préférence mémorisée, comportement inchangé)",
  collapsedDesk.width === 56 && collapsedDesk.expanded === null,
  `largeur=${collapsedDesk.width} px ; data-expanded=${collapsedDesk.expanded}`,
);

/* Clic droit BUREAU : le menu du titre s'ouvre toujours (comportement conservé). */
const rightClick = await evaluate(`(() => {
  const c = document.querySelector('.conv');
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 12, clientY: r.top + 12 }));
  const m = document.querySelector('.ctx-menu');
  return { open: !!m && !m.hidden, items: m ? [...m.querySelectorAll('.ctx-menu__item')].map((b) => b.textContent.trim()) : [] };
})()`);
check(
  "1280 px : CLIC DROIT ouvre le menu du titre (et il contient « Conversation dédiée… »)",
  rightClick.open === true && rightClick.items.some((t) => t.startsWith("Conversation dédiée")),
  rightClick.items.join(" | "),
);
/* Un appui long À LA SOURIS ne doit PAS ouvrir le menu (comportement bureau). */
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
const mouseLongPress = await evaluate(`(async () => {
  const c = document.querySelectorAll('.conv')[1];
  const r = c.getBoundingClientRect();
  c.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, clientX: r.left + 10, clientY: r.top + 10 }));
  await new Promise((res) => setTimeout(res, 650));
  const m = document.querySelector('.ctx-menu');
  return { open: !!m && !m.hidden };
})()`);
check(
  "1280 px : un appui long À LA SOURIS n'ouvre rien (clic droit seul)",
  mouseLongPress.open === false,
  `menu ouvert=${mouseLongPress.open}`,
);
await shot("mobile-11-desktop-menu");
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

await stopPage();
server.proc.kill("SIGTERM");
await sleep(300);

/* ═══════════════════════ Bilan CSP / exceptions ══════════════════════════ */
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

console.log(`\nCaptures (non suivies) : ${SHOTS}`);
console.log(`Messages console : ${consoleMessages.length} ; entrées Log : ${logEntries.length}`);

const failed = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; connexion = ${connectionErrors.length} ; exceptions = ${pageExceptions.length} ═══`,
);

chrome.kill("SIGKILL");
process.exit(
  failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0
    ? 0
    : 1,
);
