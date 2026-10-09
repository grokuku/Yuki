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

const chatState = () =>
  evaluate(`(() => {
    const sidebar = document.querySelector('.sidebar');
    return {
      railWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0,
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

await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 28, y: 320 });
await sleep(500); // déplie la barre pour voir l'indicateur
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
await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 28, y: 320 });
await sleep(500);
const reloaded = await chatState();
check(
  "persistance : l'épinglage survit au redémarrage/rechargement",
  reloaded.convs[0]?.title === secondTitle && reloaded.convs[0]?.pinned === true,
);

/* ─── Désépingler --------------------------------------------------------- */
await evaluate(`document.querySelector('.sidebar__pin').click()`); // épingle la barre dépliée
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
