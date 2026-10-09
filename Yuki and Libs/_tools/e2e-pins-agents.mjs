#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — trois volets : épinglage des conversations (clic droit),
 * encart agents en bas de la barre latérale du chat (on/off), suppression
 * définitive d'un agent sur /config (section des révoqués).
 *
 * Vérifie aussi ZÉRO violation CSP et ZÉRO exception JS.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-pins-agents.mjs"
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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-pins-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

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
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-pins-chrome-"));
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

/** Ouvre le menu contextuel d'une conversation ciblée par index. */
async function openMenuOn(index) {
  await evaluate(`(() => {
    const c = document.querySelectorAll('.conv')[${index}];
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 12, clientY: r.top + 12 }));
  })()`);
  await sleep(150);
}

async function clickMenuItem(text) {
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.ctx-menu__item')].find((x) => x.textContent === ${JSON.stringify(text)});
    if (!b) throw new Error('item absent : ' + ${JSON.stringify(text)});
    b.click();
  })()`);
  await sleep(400);
}

/** Déplie/replie la barre via le BOUTON (le survol ne l'ouvre PLUS). */
const toggleBar = () => evaluate(`document.querySelector('.sidebar__toggle').click()`);

/** Ramène la barre au rail (repliée) si elle est actuellement dépliée. */
const ensureCollapsed = () =>
  evaluate(`(() => {
    const s = document.querySelector('.sidebar');
    if (s?.getAttribute('data-expanded') === 'true') document.querySelector('.sidebar__toggle').click();
  })()`);

const chatState = () =>
  evaluate(`(() => {
    const sidebar = document.querySelector('.sidebar');
    return {
      railWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0,
      expanded: sidebar ? sidebar.getAttribute('data-expanded') : null,
      convs: [...document.querySelectorAll('.conv')].map((c) => ({
        title: c.querySelector('.conv__title')?.textContent ?? '',
        pinned: c.classList.contains('conv--pinned'),
        hasMark: !!c.querySelector('.conv__pin'),
      })),
      sideAgents: (() => {
        const s = document.querySelector('.side-agents');
        if (!s) return null;
        return {
          hidden: s.hidden,
          rows: [...s.querySelectorAll('.side-agent')].map((r) => ({
            id: r.getAttribute('data-agent-id'),
            name: r.querySelector('.side-agent__name')?.textContent ?? '',
            enabled: r.querySelector('.side-agent__badge')?.getAttribute('data-enabled') === 'true',
          })),
          empty: s.querySelector('.side-agents__empty')?.hidden === false,
        };
      })(),
    };
  })()`);

/* ═══════════════════════ 1) Épinglage via clic droit ════════════════════ */
await navigate(`${server.base}/`);
check("liste : 2 conversations", await waitFor(`document.querySelectorAll('.conv').length === 2`));
const before = await chatState();
const secondTitle = before.convs[1]?.title ?? "";
check("l'encart agents est monté et visible", before.sideAgents && !before.sideAgents.hidden);
check(
  "encart agents : nuc00 actif + nuc01 désactivé, le révoqué est masqué",
  before.sideAgents?.rows.length === 2 &&
    before.sideAgents.rows.find((r) => r.name === "nuc00")?.enabled === true &&
    before.sideAgents.rows.find((r) => r.name === "nuc01")?.enabled === false,
  JSON.stringify(before.sideAgents?.rows),
);
await shot("pins-agents-chat-rail");

// Épingler la DEUXIÈME conversation (non active).
await openMenuOn(1);
const menu = await evaluate(`(() => [...document.querySelectorAll('.ctx-menu__item')].map((b) => b.textContent))()`);
check("menu contextuel : « Épingler » présent", menu.includes("Épingler"), menu.join(" | "));
check("menu contextuel : pas de label « Désépingler » sur une non épinglée", !menu.includes("Désépingler"));
await clickMenuItem("Épingler");

await toggleBar(); // déplie la barre (le BOUTON remplace le survol)
await sleep(500); // pour voir l'indicateur de conversation épinglée
const pinned = await chatState();
check("épinglage : la conversation remonte en TÊTE", pinned.convs[0]?.title === secondTitle, `${pinned.convs.map((c) => c.title).join(" > ")}`);
check("épinglage : indicateur visuel présent (📌)", pinned.convs[0]?.pinned === true && pinned.convs[0]?.hasMark === true);
await shot("pins-agents-pinned");

// Le libellé bascule en « Désépingler ».
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await openMenuOn(0);
const menu2 = await evaluate(`(() => [...document.querySelectorAll('.ctx-menu__item')].map((b) => b.textContent))()`);
check("menu contextuel : « Désépingler » sur l'épinglée", menu2.includes("Désépingler"), menu2.join(" | "));
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);

/* ─── Persistance : rechargement ------------------------------------------- */
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('.conv').length === 2`);
// Le dépliage de la barre est PERSISTÉ : reste dépliée sans recliquer.
await sleep(500);
const reloaded = await chatState();
check(
  "persistance : l'épinglage survit au redémarrage/rechargement",
  reloaded.convs[0]?.title === secondTitle && reloaded.convs[0]?.pinned === true,
);
check(
  "persistance : la barre reste DÉPLIÉE après rechargement (pas de survol)",
  reloaded.railWidth >= 278 && reloaded.expanded === "true",
  `largeur=${reloaded.railWidth} data-expanded=${reloaded.expanded}`,
);

/* ─── Désépingler --------------------------------------------------------- */
// (La barre est déjà dépliée : son état est persisté, aucun clic de punaise.)
await sleep(200);
await openMenuOn(0);
await clickMenuItem("Désépingler");
await sleep(400);
const unpinned = await chatState();
check("désépinglage : plus aucun `conv--pinned`", unpinned.convs.every((c) => !c.pinned));

/* ═══════════════════════ 2) Encart agents : on/off ═══════════════════════ */
const levelOf = (id) =>
  evaluate(`(async () => {
    const r = await fetch('/api/agents');
    const b = await r.json();
    return b.agents.find((a) => a.agentId === ${JSON.stringify(id)})?.level ?? null;
  })()`);

const clickAgentBadge = (name) =>
  evaluate(`(() => {
    const row = [...document.querySelectorAll('.side-agent')].find((r) => r.querySelector('.side-agent__name')?.textContent === ${JSON.stringify(name)});
    if (!row) throw new Error('agent absent : ' + ${JSON.stringify(name)});
    row.querySelector('.side-agent__badge').click();
  })()`);

check("état initial : nuc00 = destructive", (await levelOf("agent-nuc00")) === "destructive");
await clickAgentBadge("nuc00");
check(
  "on/off OFF : le niveau passe à `disabled`",
  await waitFor(`(() => {
    const row = [...document.querySelectorAll('.side-agent')].find((r) => r.querySelector('.side-agent__name')?.textContent === 'nuc00');
    return row && row.querySelector('.side-agent__badge').getAttribute('data-enabled') !== 'true';
  })()`),
);
check("on/off OFF : le store confirme `disabled`", (await levelOf("agent-nuc00")) === "disabled");
await shot("pins-agents-off");

await clickAgentBadge("nuc00");
check(
  "on/off ON : restaure le niveau PRÉCÉDENT (`destructive`)",
  await waitFor(`(async () => {
    const r = await fetch('/api/agents');
    const b = await r.json();
    return b.agents.find((a) => a.agentId === 'agent-nuc00')?.level === 'destructive';
  })()`),
);
const restored = await chatState();
check(
  "on/off ON : la pastille redevient active (data-enabled)",
  restored.sideAgents?.rows.find((r) => r.name === "nuc00")?.enabled === true,
);

/* ═════════════════ 2bis) Encart agents : menu contextuel (clic droit) ════ */
// En RAIL (barre repliée), l'entrée est réduite à la pastille : on cible donc
// la PASTILLE elle-même (le clic droit remonte jusqu'à l'entrée `<li>`).
// La barre a été ÉPINGLÉE plus haut : on la dé-épingle pour revenir au rail.
await ensureCollapsed(); // revient au rail via le BOUTON (plus de punaise)
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 720, y: 480 });
await sleep(400);
const railBefore = await chatState();
check("menu : la barre est repliée en rail (56 px)", railBefore.railWidth === 56, `largeur=${railBefore.railWidth}`);

const openAgentMenu = (name) =>
  evaluate(`(() => {
    const row = [...document.querySelectorAll('.side-agent')].find((r) => r.querySelector('.side-agent__name')?.textContent === ${JSON.stringify(name)});
    if (!row) throw new Error('agent absent : ' + ${JSON.stringify(name)});
    const b = row.querySelector('.side-agent__badge');
    const r = b.getBoundingClientRect();
    b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 6, clientY: r.top + 6 }));
  })()`);

const agentMenuState = () =>
  evaluate(`(() => {
    const m = document.querySelector('.ctx-menu--levels');
    if (!m || m.hidden) return null;
    return {
      label: m.querySelector('.ctx-menu__label')?.textContent ?? '',
      items: [...m.querySelectorAll('.ctx-menu__item--radio')].map((b) => ({
        text: b.querySelector('.ctx-menu__text')?.textContent ?? '',
        hint: b.querySelector('.ctx-menu__hint')?.textContent ?? '',
        checked: b.getAttribute('aria-checked') === 'true',
        role: b.getAttribute('role'),
      })),
      left: m.style.left,
      top: m.style.top,
    };
  })()`);

const clickAgentLevel = (label) =>
  evaluate(`(() => {
    const m = document.querySelector('.ctx-menu--levels');
    const b = [...m.querySelectorAll('.ctx-menu__item--radio')].find((x) => x.querySelector('.ctx-menu__text')?.textContent === ${JSON.stringify(label)});
    if (!b) throw new Error('niveau absent : ' + ${JSON.stringify(label)});
    b.click();
  })()`);

await openAgentMenu("nuc00");
const agentMenu = await agentMenuState();
check("clic droit sur la pastille (rail) : le menu s'ouvre", agentMenu !== null);
check(
  "menu agent : titre + les 4 niveaux (D118)",
  agentMenu?.label === "Niveau de confirmation" && agentMenu?.items.length === 4,
  JSON.stringify(agentMenu?.items.map((i) => i.text)),
);
check(
  "menu agent : libellés EXPLICITES en français",
  JSON.stringify(agentMenu?.items.map((i) => i.text)) ===
    JSON.stringify([
      "Désactivé",
      "Validation à chaque commande",
      "Validation des commandes destructrices",
      "Pas de validation",
    ]),
  JSON.stringify(agentMenu?.items.map((i) => i.text)),
);
check(
  "menu agent : chaque niveau dit sa CONSÉQUENCE (acte de sécurité lisible sans /config)",
  JSON.stringify(agentMenu?.items.map((i) => i.hint)) ===
    JSON.stringify([
      "Commandes REFUSÉES : l'agent ne peut plus rien exécuter.",
      "Chaque commande vous demande validation avant de s'exécuter.",
      "Seules les commandes destructrices vous demandent validation.",
      "Aucune validation : les commandes s'exécutent directement.",
    ]),
  JSON.stringify(agentMenu?.items.map((i) => i.hint)),
);
check(
  "menu agent : « Désactivé » dit REFUSÉES ; « Pas de validation » dit aucune validation",
  /REFUS/i.test(agentMenu?.items[0]?.hint ?? "") &&
    /Aucune validation/i.test(agentMenu?.items[3]?.hint ?? ""),
);
check(
  "menu agent : le niveau COURANT est marqué (rôle radio + aria-checked)",
  agentMenu?.items.every((i) => i.role === "menuitemradio") &&
    agentMenu?.items.filter((i) => i.checked).length === 1 &&
    agentMenu?.items.find((i) => i.checked)?.text === "Validation des commandes destructrices",
  JSON.stringify(agentMenu?.items),
);
check(
  "menu agent : positionné au curseur via le CSSOM (aucun style en ligne)",
  /^\d+px$/.test(agentMenu?.left ?? "") && /^\d+px$/.test(agentMenu?.top ?? ""),
  `${agentMenu?.left} / ${agentMenu?.top}`,
);
await shot("pins-agents-menu-rail");

// Choisir « Pas de validation » ⇒ le niveau change (partagé avec le on/off).
await clickAgentLevel("Pas de validation");
check(
  "menu agent : régler le niveau change le store (`never`)",
  await waitFor(`(async () => {
    const r = await fetch('/api/agents');
    const b = await r.json();
    return b.agents.find((a) => a.agentId === 'agent-nuc00')?.level === 'never';
  })()`),
);

// Ré-ouvrir : le marquage suit le nouvel état.
await openAgentMenu("nuc00");
const agentMenu2 = await agentMenuState();
check(
  "menu agent : le marquage suit le nouveau niveau",
  agentMenu2?.items.find((i) => i.checked)?.text === "Pas de validation",
  JSON.stringify(agentMenu2?.items),
);

// « Désactivé » = l'« off » : la pastille passe inactive, sans second état.
await clickAgentLevel("Désactivé");
check(
  "menu agent : « Désactivé » EST l'état off (pas de second état)",
  await waitFor(`(() => {
    const row = [...document.querySelectorAll('.side-agent')].find((r) => r.querySelector('.side-agent__name')?.textContent === 'nuc00');
    return row && row.querySelector('.side-agent__badge').getAttribute('data-enabled') !== 'true';
  })()`),
);
check("menu agent : le store confirme `disabled`", (await levelOf("agent-nuc00")) === "disabled");

// Rétablir la validation des destructrices (via le menu) pour la suite.
await openAgentMenu("nuc00");
await clickAgentLevel("Validation des commandes destructrices");
check(
  "menu agent : un niveau ≠ Désactivé REMET l'agent en marche",
  await waitFor(`(async () => {
    const r = await fetch('/api/agents');
    const b = await r.json();
    return b.agents.find((a) => a.agentId === 'agent-nuc00')?.level === 'destructive';
  })()`),
);

// Accessibilité clavier : touche « Menu contextuel » depuis la pastille.
await evaluate(`(() => {
  const row = [...document.querySelectorAll('.side-agent')].find((r) => r.querySelector('.side-agent__name')?.textContent === 'nuc00');
  row.querySelector('.side-agent__badge').dispatchEvent(new KeyboardEvent('keydown', { key: 'ContextMenu', bubbles: true, cancelable: true }));
})()`);
check("menu agent : ouvrable au CLAVIER (touche Menu contextuel)", (await agentMenuState()) !== null);
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await sleep(150);
check("menu agent : Échap referme le menu", (await agentMenuState()) === null);

/* ═══════ 2ter) Menu agent : interaction RÉELLE (souris CDP) ═══════════════
 * ⚠️ Les contrôles ci-dessus dispatchent un `contextmenu` SYNTHÉTIQUE : ils
 * prouvent que le menu s'OUVRE, pas qu'il RESTE utilisable. On reproduit ici
 * l'usage réel (clic droit + sélection à la SOURIS via CDP) et on vérifie la
 * PERSISTANCE : le menu ne doit être refermé NI par le défilement du fil (qui
 * défile en CONTINU pendant une réponse) NI par un rafraîchissement du registre
 * d'agents (trame `agents`). */
const agentMenuVisible = () =>
  evaluate(`(() => {
    const m = document.querySelector('.ctx-menu--levels');
    if (!m || m.hidden) return false;
    const r = m.getBoundingClientRect();
    return m.isConnected && r.width > 0 && r.height > 0 && getComputedStyle(m).display !== 'none';
  })()`);

const agentBadgeCenter = () =>
  evaluate(`(() => {
    const b = [...document.querySelectorAll('.side-agent')].find((r) => r.querySelector('.side-agent__name')?.textContent === 'nuc00')?.querySelector('.side-agent__badge');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);

async function realRightClick(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  const common = { x, y, button: "right", buttons: 2, clickCount: 1 };
  await send("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
  await sleep(40);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...common });
}

async function realLeftClick(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await sleep(20);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(20);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 1, clickCount: 1 });
}

/** Centre (client) d'un item du menu agent, par son libellé. */
const agentLevelItemCenter = (label) =>
  evaluate(`(() => {
    const m = document.querySelector('.ctx-menu--levels');
    const b = [...m.querySelectorAll('.ctx-menu__item--radio')].find((x) => x.querySelector('.ctx-menu__text')?.textContent === ${JSON.stringify(label)});
    if (!b) throw new Error('niveau absent : ' + ${JSON.stringify(label)});
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);

// 1) clic droit RÉEL sur la pastille (rail) → menu ouvert, TOUJOURS là après attente.
let badgePos = await agentBadgeCenter();
await realRightClick(badgePos.x, badgePos.y);
await sleep(400);
check("menu agent (clic droit RÉEL) : ouvert ET encore là après attente", await agentMenuVisible());

// 2) le FIL de discussion défile (cas réel : une réponse est en cours) → le menu RESTE.
await evaluate(`(() => {
  const el = document.querySelector('#conversation');
  el.scrollTop = 0;
  el.scrollTop = 1;
  el.dispatchEvent(new Event('scroll'));
})()`);
await sleep(250);
check("menu agent : reste affiché quand le FIL défile (réponse en cours)", await agentMenuVisible());

// 3) rafraîchissement du registre : une 2e connexion WS pousse une trame `agents`.
const helper = new WebSocket(`${server.base.replace("http", "ws")}/ws`);
await new Promise((res, rej) => {
  helper.on("open", res);
  helper.on("error", rej);
});
helper.send(JSON.stringify({ type: "hello" }));
await sleep(400);
helper.send(JSON.stringify({ type: "agent_enabled", agentId: "agent-nuc01", enabled: true }));
await sleep(500);
check("menu agent : reste affiché après une trame `agents` (re-rendu du panneau)", await agentMenuVisible());
helper.close();

// 4) sélection RÉELLE d'un niveau à la souris → réglage appliqué + menu refermé.
const neverPos = await agentLevelItemCenter("Pas de validation");
await realLeftClick(neverPos.x, neverPos.y);
check(
  "menu agent (clic réel) : le niveau choisi est APPLIQUÉ (`never`)",
  await waitFor(`(async () => {
    const r = await fetch('/api/agents');
    const b = await r.json();
    return b.agents.find((a) => a.agentId === 'agent-nuc00')?.level === 'never';
  })()`),
);
check("menu agent (clic réel) : le menu se referme après sélection", !(await agentMenuVisible()));

// 5) Échap puis clic ailleurs referment le menu (après ouverture réelle).
badgePos = await agentBadgeCenter();
await realRightClick(badgePos.x, badgePos.y);
await sleep(300);
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
await sleep(150);
check("menu agent : Échap referme (ouverture réelle)", !(await agentMenuVisible()));
badgePos = await agentBadgeCenter();
await realRightClick(badgePos.x, badgePos.y);
await sleep(300);
await realLeftClick(760, 380);
await sleep(200);
check("menu agent : clic ailleurs referme (ouverture réelle)", !(await agentMenuVisible()));

// 6) défilement de la BARRE LATÉRALE → referme (parité avec les conversations).
badgePos = await agentBadgeCenter();
await realRightClick(badgePos.x, badgePos.y);
await sleep(300);
await evaluate(`document.querySelector('.sidebar__list').dispatchEvent(new Event('scroll'))`);
await sleep(200);
check("menu agent : un défilement de la BARRE referme (parité conversations)", !(await agentMenuVisible()));

// Rétablir `destructive` (via le menu, clic réel) pour la suite.
badgePos = await agentBadgeCenter();
await realRightClick(badgePos.x, badgePos.y);
await sleep(300);
const restorePos = await agentLevelItemCenter("Validation des commandes destructrices");
await realLeftClick(restorePos.x, restorePos.y);
check(
  "menu agent (clic réel) : rétablissement de `destructive`",
  await waitFor(`(async () => {
    const r = await fetch('/api/agents');
    const b = await r.json();
    return b.agents.find((a) => a.agentId === 'agent-nuc00')?.level === 'destructive';
  })()`),
);

/* ═══════════════════════ 3) /config : agents révoqués ═══════════════════ */
await navigate(`${server.base}/config#agents`);
check(
  "config : l'onglet Agents liste 2 agents actifs",
  await waitFor(`document.querySelectorAll('.agent-list:not(.agent-list--revoked) .agent-card').length === 2`),
);
const configState = await evaluate(`(() => ({
  active: document.querySelectorAll('.agent-list:not(.agent-list--revoked) .agent-card').length,
  revokedSection: !!document.querySelector('.agent-revoked'),
  revoked: document.querySelectorAll('.agent-list--revoked .agent-card').length,
  revokedNames: [...document.querySelectorAll('.agent-revoked .agent-card .agent-id')].map((n) => n.textContent),
}))()`);
check("config : le révoqué n'est PAS dans la liste principale", configState.active === 2, `actifs=${configState.active}`);
check(
  "config : le révoqué est dans une section distincte « Agents révoqués »",
  configState.revokedSection && configState.revoked === 1 && configState.revokedNames.includes("vieux"),
  JSON.stringify(configState),
);
await shot("pins-agents-config-revoked");

// Suppression définitive.
await evaluate(`(() => {
  const card = document.querySelector('.agent-revoked .agent-card');
  const b = [...card.querySelectorAll('button')].find((x) => x.textContent === 'Supprimer définitivement');
  b.click();
})()`);
await sleep(350);
const modal = await evaluate(`(() => ({
  title: document.querySelector('.holaf-modal-title')?.textContent ?? '',
  message: document.querySelector('.holaf-modal-message')?.textContent ?? '',
  hasConfirm: !![...document.querySelectorAll('.holaf-modal-btn')].find((b) => b.textContent === 'Supprimer définitivement'),
}))()`);
check("suppression : confirmation HolafModal (jamais window.confirm)", modal.title.length > 0 && modal.hasConfirm, modal.title);
check(
  "suppression : le texte dit ce qui disparaît + ré-appairage requis",
  /définitivement|IRRÉVERSIBLE/i.test(modal.message) && /ré-?appari/i.test(modal.message),
  modal.message.slice(0, 160),
);
await shot("pins-agents-delete-modal");
await evaluate(`[...document.querySelectorAll('.holaf-modal-btn')].find((b) => b.textContent === 'Supprimer définitivement')?.click()`);

check(
  "suppression définitive : la fiche disparaît de l'API",
  await waitFor(`(async () => {
    const r = await fetch('/api/agents');
    const b = await r.json();
    return !b.agents.some((a) => a.agentId === 'agent-vieux');
  })()`),
);
check(
  "suppression définitive : la section révoqués disparaît",
  await waitFor(`!document.querySelector('.agent-revoked')`),
);
await shot("pins-agents-config-after");

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
