#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — RÉACTIONS aux messages de Yuki.
 *
 * Prouve, de bout en bout sur le gateway RÉEL (hôte Pi simulé, pipeline TTS réel,
 * store de réactions réel sur disque, CSP réelle) :
 *  1. un petit bouton existe sur CHAQUE message assistant, et sur AUCUN message
 *     utilisateur ;
 *  2. il est DISCRET au bureau (invisible au repos, visible au survol — Chromium
 *     est lancé en « pointeur fin avec survol ») et TOUJOURS visible au toucher
 *     (second navigateur en `(hover: none)`, comme un téléphone) ;
 *  3. il déploie UN menu à TROIS SECTIONS TITRÉES, chaque entrée avec son libellé
 *     ET sa mini-explication ;
 *  4. le menu ne pousse RIEN (flottant) et ne sort pas de l'écran — sur le DERNIER
 *     message il s'ouvre VERS LE HAUT ;
 *  5. la réaction choisie RESTE affichée, et peut être CHANGÉE ou RETIRÉE ;
 *  6. une réaction ne déclenche AUCUN tour (compteur `run_started`) et n'est
 *     JAMAIS prononcée (le synthétiseur n'est pas appelé) ;
 *  7. elle SURVIT au RECHARGEMENT et à la RECONNEXION, sur LE BON message
 *     (corrélation par l'identifiant d'entrée de session) ;
 *  8. le modèle reçoit le bloc avec le SENS du groupe (jugement / émotion / humeur)
 *     au tour SUIVANT, sans qu'aucun tour n'ait été ouvert par la réaction ;
 *  9. ZÉRO violation CSP, ZÉRO erreur de connexion, ZÉRO exception JS.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-reactions.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { collectViolations, waitForGateway } from "./browser-violations.mjs";

const TOOLS = import.meta.dirname;
const WORKSPACE = join(TOOLS, "..");
const YUKI_DIR = join(WORKSPACE, "Yuki");
const TSX = join(YUKI_DIR, "node_modules", ".bin", "tsx");

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-reactions-"));

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-reactions-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_REACTIONS_DIR: STATE_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (data) => logs.push(data.toString()));
  proc.stderr.on("data", (data) => logs.push(data.toString()));
  const urls = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("serveur non démarré :\n" + logs.join(""))),
      60_000,
    );
    proc.stdout.on("data", () => {
      const text = logs.join("");
      const ready = text.match(/READY (http:\/\/\S+)/);
      const control = text.match(/CONTROL (http:\/\/\S+)/);
      if (ready && control) {
        clearTimeout(timer);
        resolve({ base: ready[1].trim(), control: control[1].trim() });
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serveur quitté (${code}) :\n${logs.join("")}`));
    });
  });
  await waitForGateway(urls.base);
  return { proc, ...urls, logs };
}

const server = await startServer();
const api = async (path) => (await fetch(`${server.control}${path}`)).json();

/* ─── Navigateur headless (CDP) — une session par « appareil » ───────────── */

/**
 * Chromium se déclare `(hover: none)` par défaut en headless : pour prouver le
 * comportement BUREAU (révélé au survol) il faut le lancer avec un pointeur fin
 * et un survol disponibles ; pour prouver le TÉLÉPHONE, on garde le défaut
 * (`hover: none`, `pointer: coarse`), exactement ce que voit un doigt.
 */
const HOVER_CAPABLE = [
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];

const sessions = [];

async function openBrowser({ hoverCapable = false } = {}) {
  const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-reactions-chrome-"));
  const chrome = spawn(
    "/usr/bin/chromium",
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      ...(hoverCapable ? HOVER_CAPABLE : []),
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );

  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("DevTools WS introuvable")), 15_000);
    chrome.stderr.on("data", (data) => {
      buffer += data.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    chrome.on("exit", (code) => reject(new Error("chromium a quitté : " + code)));
  });

  const targets = await fetch(
    wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"),
  ).then((response) => response.json());
  const page = targets.find((target) => target.type === "page");
  if (!page) throw new Error("aucune cible page");
  const ws = new WebSocket(page.webSocketDebuggerUrl, {
    maxPayload: 256 * 1024 * 1024,
  });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  let seq = 0;
  const pending = new Map();
  const consoleMessages = [];
  const logEntries = [];
  const pageExceptions = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    } else if (message.method === "Runtime.consoleAPICalled") {
      consoleMessages.push({
        type: message.params.type,
        text: (message.params.args || [])
          .map((arg) => arg.value ?? arg.description ?? "")
          .join(" "),
      });
    } else if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails || {};
      pageExceptions.push(details.exception?.description ?? details.text ?? "exception");
    } else if (message.method === "Log.entryAdded") {
      logEntries.push({
        source: message.params.entry.source,
        level: message.params.entry.level,
        text: message.params.entry.text,
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

  async function evaluate(expression) {
    const result = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        "eval: " + (result.exceptionDetails.exception?.description || "exception"),
      );
    }
    return result.result.value;
  }

  async function waitFor(expression, timeout = 12_000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await evaluate(expression)) return true;
      await sleep(60);
    }
    return false;
  }

  async function navigate(url) {
    const loaded = new Promise((resolve) => {
      const handler = (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.method === "Page.loadEventFired") {
          ws.off("message", handler);
          resolve();
        }
      };
      ws.on("message", handler);
      setTimeout(() => {
        ws.off("message", handler);
        resolve();
      }, 8000);
    });
    await send("Page.navigate", { url });
    await loaded;
    await sleep(600);
  }

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

  /** Déplace la souris (survol réel : c'est le CSS `:hover` qui décide). */
  async function moveMouse(x, y) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    // L'apparition est une transition CSS (0,12 s) : on la laisse s'achever, sinon
    // on mesurerait une opacité intermédiaire (0,9995…) au lieu de l'état voulu.
    await sleep(300);
  }

  /** Clic réel (souris) au centre d'un point calculé dans la page. */
  async function clickAt(centerExpression) {
    const point = await evaluate(centerExpression);
    if (!point) throw new Error("élément introuvable pour le clic");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "left",
      clickCount: 1,
    });
    await sleep(250);
  }

  /** Tape au doigt (téléphone). */
  async function tapAt(centerExpression) {
    const point = await evaluate(centerExpression);
    if (!point) throw new Error("élément introuvable pour le tap");
    await send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: point.x, y: point.y }],
    });
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(350);
  }

  async function close() {
    try {
      ws.close();
    } catch {
      // ignore
    }
    chrome.kill("SIGKILL");
    // Le profil Chromium est encore en cours d'écriture : on réessaie (jamais
    // laisser d'artefact dans /tmp).
    await sleep(200);
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  const session = {
    send,
    evaluate,
    waitFor,
    navigate,
    setViewport,
    moveMouse,
    clickAt,
    tapAt,
    close,
    consoleMessages,
    logEntries,
    pageExceptions,
  };
  sessions.push(session);
  return session;
}

const centerOf = (selector, index = 0) => `(() => {
  const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
  const node = nodes[${index}];
  if (!node) return null;
  // Le menu peut DÉFILER : on amène l'entrée visée dans la zone visible avant
  // de la cliquer (jamais de clic « dans le vide »).
  if (typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
  const rect = node.getBoundingClientRect();
  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
})()`;

const reactionState = () => `(() => [...document.querySelectorAll('.message--assistant')].map((node) => ({
  text: (node.querySelector('.message__body')?.textContent ?? '').slice(0, 30),
  reaction: node.querySelector('.message__react-btn')?.classList.contains('message__react-btn--set')
    ? (node.querySelector('.message__react-btn')?.textContent ?? '').trim()
    : null,
  hasButton: Boolean(node.querySelector('.message__react-btn')),
})))()`;

const opacityOf = (index) => `(() => {
  const node = document.querySelectorAll('.message--assistant .message__react-btn')[${index}];
  return node ? Number(getComputedStyle(node).opacity) : -1;
})()`;

/** Ouvre le menu d'un message et clique une entrée du catalogue. */
async function reactWith(session, messageIndex, reactionId) {
  await session.clickAt(centerOf(".message--assistant .message__react-btn", messageIndex));
  await session.clickAt(
    centerOf(`.ctx-menu--reactions .reaction-item[data-reaction="${reactionId}"]`, 0),
  );
  await sleep(300);
}

/* ═══════════════════════ PHASE 1 — BUREAU (survol) ═══════════════════════ */
const desktop = await openBrowser({ hoverCapable: true });
await desktop.setViewport(1280, 900);
await desktop.navigate(server.base);
const hoverCapable = await desktop.evaluate(
  `({ hover: matchMedia('(hover: hover)').matches, none: matchMedia('(hover: none)').matches })`,
);
check(
  "navigateur de bureau : survol disponible (condition de la preuve)",
  hoverCapable.hover === true,
  JSON.stringify(hoverCapable),
);

for (let index = 0; index < 3; index += 1) {
  await api(`/send?text=${encodeURIComponent("Question " + (index + 1))}`);
  await desktop.waitFor(
    `document.querySelectorAll('.message--assistant').length >= ${index + 1}`,
    12_000,
  );
}
await sleep(400);
const runsAfterTours = (await api("/runs")).runs;
check(
  "trois tours utilisateur ⇒ trois messages assistant",
  (await desktop.evaluate(`document.querySelectorAll('.message--assistant').length`)) === 3,
);

const states = await desktop.evaluate(reactionState());
check(
  "un bouton de réaction existe sur CHAQUE message assistant",
  states.length === 3 && states.every((entry) => entry.hasButton),
  JSON.stringify(states.map((entry) => entry.hasButton)),
);
check(
  "AUCUN bouton sur les messages utilisateur",
  (await desktop.evaluate(`document.querySelectorAll('.message--user .message__react-btn').length`)) === 0,
);
check(
  "aucun message assistant ne porte de réaction au départ",
  states.every((entry) => entry.reaction === null),
);

/* ─── Discrétion au bureau ───────────────────────────────────────────────── */
check(
  "bouton INVISIBLE au repos sur bureau",
  (await desktop.evaluate(opacityOf(0))) === 0,
  `opacité ${await desktop.evaluate(opacityOf(0))}`,
);
const messageBox = await desktop.evaluate(`(() => {
  const rect = document.querySelectorAll('.message--assistant')[0].getBoundingClientRect();
  return { x: Math.round(rect.left + 30), y: Math.round(rect.top + rect.height / 2) };
})()`);
await desktop.moveMouse(messageBox.x, messageBox.y);
check(
  "bouton VISIBLE au survol du message",
  (await desktop.evaluate(opacityOf(0))) === 1,
  `opacité ${await desktop.evaluate(opacityOf(0))}`,
);

/* ─── Le menu : trois sections titrées ───────────────────────────────────── */
await desktop.clickAt(centerOf(".message--assistant .message__react-btn", 0));
const menuInfo = await desktop.evaluate(`(() => {
  const menu = document.querySelector('.ctx-menu--reactions');
  if (!menu || menu.hidden) return null;
  const rect = menu.getBoundingClientRect();
  return {
    titles: [...menu.querySelectorAll('.ctx-menu__label')].map((node) => node.textContent),
    items: [...menu.querySelectorAll('.reaction-item[data-reaction]')].map((node) => ({
      label: node.querySelector('.ctx-menu__text')?.textContent ?? '',
      hint: node.querySelector('.ctx-menu__hint')?.textContent ?? '',
      emoji: node.querySelector('.reaction-item__emoji')?.textContent ?? '',
    })),
    inside: rect.left >= 0 && rect.top >= 0
      && rect.right <= window.innerWidth + 0.5 && rect.bottom <= window.innerHeight + 0.5,
    position: getComputedStyle(menu).position,
  };
})()`);
check("le menu s'ouvre au clic sur le bouton", menuInfo !== null);
check(
  "TROIS sections titrées (jugement technique / émotion / humeur)",
  menuInfo !== null &&
    menuInfo.titles.length === 3 &&
    menuInfo.titles[0].includes("Jugement technique") &&
    menuInfo.titles[1].includes("Réaction émotionnelle") &&
    menuInfo.titles[2].includes("Humeur"),
  JSON.stringify(menuInfo?.titles),
);
check(
  "quatorze possibilités, chacune avec son LIBELLÉ et sa MINI-EXPLICATION",
  menuInfo !== null &&
    menuInfo.items.length === 14 &&
    menuInfo.items.every(
      (item) => item.label.length > 0 && item.hint.length > 0 && item.emoji.length > 0,
    ),
  `${menuInfo?.items.length} entrée(s)`,
);
check(
  "le menu est FLOTTANT (il ne pousse pas le texte)",
  menuInfo !== null && menuInfo.position === "fixed",
  menuInfo?.position,
);
check("le menu reste DANS l'écran", menuInfo !== null && menuInfo.inside === true);

/* ─── Menu du DERNIER message : ouverture VERS LE HAUT ───────────────────── */
await desktop.evaluate(`document.querySelector('.ctx-menu--reactions').hidden = true`);
await desktop.evaluate(`document.querySelector('#conversation').scrollTop = 1e6`);
await sleep(200);
await desktop.clickAt(centerOf(".message--assistant .message__react-btn", 2));
const lastMenu = await desktop.evaluate(`(() => {
  const menu = document.querySelector('.ctx-menu--reactions');
  const button = document.querySelectorAll('.message--assistant .message__react-btn')[2];
  if (!menu || menu.hidden || !button) return null;
  const rect = menu.getBoundingClientRect();
  const btn = button.getBoundingClientRect();
  return {
    flippedUp: rect.bottom <= btn.top + 1,
    inside: rect.top >= 0 && rect.bottom <= window.innerHeight + 0.5,
    top: Math.round(rect.top),
    bottom: Math.round(rect.bottom),
    buttonTop: Math.round(btn.top),
    viewport: window.innerHeight,
  };
})()`);
check(
  "sur le DERNIER message, le menu s'ouvre VERS LE HAUT (jamais coupé)",
  lastMenu !== null && lastMenu.flippedUp && lastMenu.inside,
  JSON.stringify(lastMenu),
);

/* ─── Choisir : la réaction reste affichée ───────────────────────────────── */
const runsBeforeReaction = (await api("/runs")).runs;
const spokenBefore = (await api("/spoken")).spoken.length;
await desktop.clickAt(
  centerOf(`.ctx-menu--reactions .reaction-item[data-reaction="trop-long"]`, 0),
);
await sleep(300);
const afterPick = await desktop.evaluate(reactionState());
check(
  "la réaction choisie reste affichée sur LE message visé (🐢), et sur lui seul",
  afterPick[2].reaction === "🐢" &&
    afterPick[0].reaction === null &&
    afterPick[1].reaction === null,
  JSON.stringify(afterPick.map((entry) => entry.reaction)),
);
await desktop.moveMouse(messageBox.x, messageBox.y);
check(
  "elle reste visible SANS survol (discrète mais persistante)",
  (await desktop.evaluate(opacityOf(2))) === 1,
  `opacité ${await desktop.evaluate(opacityOf(2))}`,
);

/* ─── Aucun tour, aucune voix ────────────────────────────────────────────── */
const stored = await api("/reactions");
check(
  "la réaction est persistée À PART, corrélée au message",
  stored.state.length === 1 && stored.file.endsWith("reactions.jsonl"),
  JSON.stringify(stored),
);
check(
  "aucun tour déclenché par la réaction (`run_started` inchangé)",
  (await api("/runs")).runs === runsBeforeReaction,
  `${(await api("/runs")).runs} (avant : ${runsBeforeReaction})`,
);
check(
  "jamais prononcée par la synthèse vocale (aucun nouveau segment)",
  (await api("/spoken")).spoken.length === spokenBefore &&
    !(await api("/spoken")).spoken.join(" ").includes("Trop long"),
  JSON.stringify((await api("/spoken")).spoken),
);

/* ─── Le modèle reçoit le SENS du groupe au tour suivant ─────────────────── */
const block = (await api("/prompt-block")).prompt;
check(
  "le bloc injecté au tour SUIVANT explique les trois registres",
  block.includes("<reactions_utilisateur>") &&
    block.includes("corrige ton COMPORTEMENT") &&
    block.includes("informe sur le REGISTRE") &&
    block.includes("MODULE TON TON"),
);
check(
  "il porte le registre ET le libellé de la réaction (sens explicite)",
  block.includes("[judgement · 🐢 Trop long]"),
  block.split("\n").find((line) => line.startsWith("- [judgement")) ?? "(absent)",
);
check(
  "il cite l'extrait du message VISÉ (le dernier), pas un autre",
  block.includes("Troisième réponse"),
  block.split("\n").find((line) => line.startsWith("- [judgement")) ?? "(absent)",
);

/* ─── Changer puis retirer ───────────────────────────────────────────────── */
await reactWith(desktop, 2, "utile");
const afterChange = await desktop.evaluate(reactionState());
check(
  "CHANGER fonctionne : une seule réaction par message (👍 remplace 🐢)",
  afterChange[2].reaction === "👍" &&
    afterChange.filter((entry) => entry.reaction !== null).length === 1,
  JSON.stringify(afterChange.map((entry) => entry.reaction)),
);
await desktop.clickAt(centerOf(".message--assistant .message__react-btn", 2));
await desktop.clickAt(centerOf(".ctx-menu--reactions .reaction-item--remove", 0));
await sleep(300);
const afterRemove = await desktop.evaluate(reactionState());
check(
  "RETIRER fonctionne : plus aucune réaction affichée",
  afterRemove.every((entry) => entry.reaction === null),
  JSON.stringify(afterRemove.map((entry) => entry.reaction)),
);
check("le retrait est persisté (store vide)", (await api("/reactions")).state.length === 0);

/* ─── Corrélation APRÈS RECHARGEMENT et RECONNEXION ──────────────────────── */
await reactWith(desktop, 0, "faux");
const transcript = (await api("/transcript")).entries;
const assistantEntries = transcript.filter((entry) => entry.role === "assistant");
const storedAfter = await api("/reactions");
check(
  "réaction posée sur le PREMIER message (identifiant d'entrée de session)",
  Boolean(assistantEntries[0].id) && storedAfter.state[0][0] === assistantEntries[0].id,
  `entryId=${assistantEntries[0].id}`,
);
// RECHARGEMENT COMPLET de la page : nouvelle connexion WS + snapshot.
await desktop.navigate(server.base);
await desktop.waitFor(
  `document.querySelectorAll('.message--assistant').length === 3`,
  12_000,
);
await sleep(400);
const afterReload = await desktop.evaluate(reactionState());
check(
  "APRÈS RECHARGEMENT, la réaction est toujours sur LE MÊME message (⚠️) et un seul",
  afterReload[0].reaction === "⚠️" &&
    afterReload[1].reaction === null &&
    afterReload[2].reaction === null,
  JSON.stringify(afterReload.map((entry) => entry.reaction)),
);
check(
  "aucun tour n'a été déclenché par le rechargement",
  (await api("/runs")).runs === runsAfterTours,
  `${(await api("/runs")).runs} (attendu ${runsAfterTours})`,
);
const scrollState = await desktop.evaluate(`(() => {
  const chat = document.querySelector('#conversation');
  return { atBottom: chat.scrollHeight - chat.scrollTop - chat.clientHeight <= 40 };
})()`);
check(
  "le fil est resté collé en bas (état STICKY préservé après rechargement)",
  scrollState.atBottom === true,
  JSON.stringify(scrollState),
);

/* ══════════════════ PHASE 2 — TÉLÉPHONE (toucher) ══════════════════ */
await desktop.close();
const mobile = await openBrowser({ hoverCapable: false });
await mobile.setViewport(390, 780, { mobile: true });
const touchMedia = await mobile.evaluate(
  `({ none: matchMedia('(hover: none)').matches, coarse: matchMedia('(pointer: coarse)').matches })`,
);
check(
  "téléphone : aucun survol disponible (condition de la preuve)",
  touchMedia.none === true && touchMedia.coarse === true,
  JSON.stringify(touchMedia),
);
await mobile.navigate(server.base);
await mobile.waitFor(
  `document.querySelectorAll('.message--assistant').length === 3`,
  12_000,
);
await sleep(400);

check(
  "TÉLÉPHONE : le bouton est TOUJOURS visible (aucun survol au doigt)",
  (await mobile.evaluate(opacityOf(0))) === 1,
  `opacité ${await mobile.evaluate(opacityOf(0))}`,
);
const reachable = await mobile.evaluate(`(() => {
  const node = document.querySelectorAll('.message--assistant .message__react-btn')[0];
  if (!node) return false;
  const rect = node.getBoundingClientRect();
  if (rect.width < 20 || rect.height < 20) return false;
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  return Boolean(hit && (hit === node || node.contains(hit)));
})()`);
check(
  "TÉLÉPHONE : le bouton est ATTEIGNABLE au toucher (zone réelle ≥ 20 px)",
  reachable === true,
);
await mobile.tapAt(centerOf(".message--assistant .message__react-btn", 0));
const mobileMenu = await mobile.evaluate(`(() => {
  const menu = document.querySelector('.ctx-menu--reactions');
  if (!menu || menu.hidden) return null;
  const rect = menu.getBoundingClientRect();
  return {
    inside: rect.left >= 0 && rect.top >= 0
      && rect.right <= window.innerWidth + 0.5 && rect.bottom <= window.innerHeight + 0.5,
    sections: menu.querySelectorAll('.ctx-menu__label').length,
  };
})()`);
check(
  "TÉLÉPHONE : le menu s'ouvre au toucher, entier, trois sections",
  mobileMenu !== null && mobileMenu.inside === true && mobileMenu.sections === 3,
  JSON.stringify(mobileMenu),
);
await mobile.tapAt(centerOf(`.ctx-menu--reactions .reaction-item[data-reaction="fatigue"]`, 0));
await sleep(300);
const mobileReaction = await mobile.evaluate(reactionState());
check(
  "TÉLÉPHONE : une réaction posée au doigt s'affiche (😴) sur le bon message",
  mobileReaction[0].reaction === "😴" && mobileReaction[1].reaction === null,
  JSON.stringify(mobileReaction.map((entry) => entry.reaction)),
);

/* ─── CSP, connexion, exceptions ─────────────────────────────────────────── */
const consoleMessages = sessions.flatMap((session) => session.consoleMessages);
const logEntries = sessions.flatMap((session) => session.logEntries);
const pageExceptions = sessions.flatMap((session) => session.pageExceptions);
const violations = collectViolations(consoleMessages, logEntries);
check(
  "ZÉRO violation CSP",
  violations.cspViolations.length === 0,
  JSON.stringify(violations.cspViolations),
);
check(
  "ZÉRO erreur de connexion",
  violations.connectionErrors.length === 0,
  JSON.stringify(violations.connectionErrors),
);
check("ZÉRO exception JS", pageExceptions.length === 0, pageExceptions.join(" | "));

/* ─── Bilan ──────────────────────────────────────────────────────────────── */
const failed = results.filter((result) => !result.ok);
console.log("");
console.log(
  `${results.length - failed.length}/${results.length} vérifications OK` +
    (failed.length > 0 ? ` — ${failed.length} ÉCHEC(S)` : ""),
);

await mobile.close();
server.proc.kill("SIGINT");
rmSync(STATE_DIR, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
