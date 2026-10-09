#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — page « Agents » de /config (Lot 4, B5).
 *
 * Lance le gateway RÉEL avec l'API agents (`_tools/e2e-agents-serve.ts`) et rend
 * `/config#agents` en Chromium headless via CDP, avec la CSP RÉELLE. Vérifie :
 * onglet Agents, état vide, champ de saisie + bouton « Appairer » (D119 : le code
 * vient de la console de l'agent), appairage réussi (l'agent apparaît), message
 * d'erreur véridique sur code invalide, affichage d'un agent appairé (état,
 * dernière connexion, historique, niveau, privilège), validations en attente,
 * modale HolafModal de suppression, et **zéro violation CSP / exception JS**.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-agents.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const TOOLS = import.meta.dirname;
const WORKSPACE = join(TOOLS, "..");
const YUKI_DIR = join(WORKSPACE, "Yuki");
const TSX = join(YUKI_DIR, "node_modules", ".bin", "tsx");
const SHOTS = join(TOOLS, "shots");
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─── Démarrage d'un gateway de test (agents câblés) ────────────────────── */
async function startServer(extraEnv = {}) {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-agents-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString()));
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("serveur non démarré :\n" + logs.join(""))),
      30_000,
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

/* ─── Chromium headless (CDP) ───────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-agents-chrome-"));
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

async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
  console.log(`📷 capture : _tools/shots/${name}.png`);
}

/* ═══════════════════ 1) Aucun agent appairé ═══════════════════════════ */
const empty = await startServer();
await navigate(`${empty.base}/config#agents`);
const emptyState = await evaluate(`(() => {
  const active = [...document.querySelectorAll('[role=tab]')].find((t) => t.getAttribute('aria-selected') === 'true')?.id;
  const panel = document.getElementById('panel-agents');
  const root = document.getElementById('agents-root');
  return {
    active,
    visible: panel ? !panel.hidden : false,
    text: root?.textContent ?? '',
    styleAttrs: document.body.querySelectorAll('[style]').length,
    hasInput: !!document.getElementById('agent-pair-code'),
    hasButton: [...(root?.querySelectorAll('button') ?? [])].some((b) => b.textContent === 'Appairer'),
  };
})()`);
check(
  "[/config#agents] onglet Agents actif et panneau visible",
  emptyState.active === "tab-agents" && emptyState.visible === true,
  JSON.stringify(emptyState).slice(0, 200),
);
check(
  "[/config#agents] état vide : « Aucun agent appairé »",
  emptyState.text.includes("Aucun agent appairé"),
);
check("[/config#agents] champ de saisie du code présent", emptyState.hasInput === true);
check("[/config#agents] bouton « Appairer » présent", emptyState.hasButton === true);
check("[/config#agents] aucun style= inline (CSP)", emptyState.styleAttrs === 0);
await shot("agents-e2e-empty");
empty.proc.kill("SIGTERM");
await sleep(300);

/* ═══════════════════ 2) Un agent appairé + validation ═════════════════ */
const seeded = await startServer({
  YUKI_E2E_AGENTS: "agent-demo-01",
  YUKI_E2E_NAMES: "nuc00",
  YUKI_E2E_APPROVALS: "1",
});
await navigate(`${seeded.base}/config?t=${Date.now()}#agents`);
const withAgent = await evaluate(`(() => {
  const root = document.getElementById('agents-root');
  const card = root?.querySelector('.agent-card');
  const selects = [...(card?.querySelectorAll('select') ?? [])];
  const approve = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Approuver');
  const nameInput = card?.querySelector('.agent-name__input');
  const approval = root?.querySelector('.agent-approval .agent-identity .agent-id');
  return {
    hasCard: !!card,
    agentId: card?.querySelector('.agent-identity .agent-id')?.textContent ?? '',
    idNote: card?.querySelector('.agent-id-sub')?.textContent ?? '',
    nameValue: nameInput?.value ?? '',
    approvalName: approval?.textContent ?? '',
    badge: card?.querySelector('.agent-badge')?.textContent ?? '',
    lastSeen: [...root.querySelectorAll('.config-helper')].map((p) => p.textContent).find((t) => t.startsWith('Dernière connexion')) ?? '',
    levelOptions: selects[0]?.querySelectorAll('option').length ?? 0,
    privOptions: selects[1]?.querySelectorAll('option').length ?? 0,
    hasDelete: [...root.querySelectorAll('button')].some((b) => b.textContent === "Révoquer"),
    history: root?.textContent.includes('ls -la /srv') ?? false,
    approvals: !!approve,
    help: root?.textContent.includes('Comment appairer un agent') ?? false,
  };
})()`);
check("[/config#agents] une carte agent s'affiche", withAgent.hasCard && withAgent.agentId === "nuc00", JSON.stringify(withAgent));
check("[/config#agents] nom personnalisé affiché (alias), ID technique en repli", withAgent.agentId === "nuc00" && withAgent.idNote.includes("agent-demo-01"), JSON.stringify(withAgent));
check("[/config#agents] champ de nom pré-rempli", withAgent.nameValue === "nuc00");
check("[/config#agents] validations en attente : nom affiché", withAgent.approvalName === "nuc00", withAgent.approvalName);
check("[/config#agents] état « Hors ligne »", withAgent.badge.includes("Hors ligne"));
check("[/config#agents] dernière connexion affichée", withAgent.lastSeen.includes("Dernière connexion"), withAgent.lastSeen);
check("[/config#agents] niveau : 4 choix ; privilège : 2 choix", withAgent.levelOptions === 4 && withAgent.privOptions === 2, `level=${withAgent.levelOptions} priv=${withAgent.privOptions}`);
check("[/config#agents] historique visible (jamais la sortie)", withAgent.history);
check("[/config#agents] validation en attente + bouton Approuver", withAgent.approvals);
await shot("agents-e2e-agent");

/* Renommage : saisie puis sauvegarde `hot` par la mécanique existante. */
await evaluate(`(() => {
  const input = document.querySelector('#agents-root .agent-name__input');
  input.value = 'nas-01';
  input.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(900);
const renamed = await evaluate(`(() => ({
  label: document.querySelector('#agents-root .agent-card .agent-identity .agent-id')?.textContent ?? '',
  value: document.querySelector('#agents-root .agent-name__input')?.value ?? '',
  styleAttrs: document.body.querySelectorAll('[style]').length,
}))()`);
check(
  "[/config#agents] renommage effectif (affiché et enregistré à chaud)",
  renamed.label === "nas-01" && renamed.value === "nas-01",
  JSON.stringify(renamed),
);
check("[/config#agents] toujours aucun style= inline après renommage", renamed.styleAttrs === 0, String(renamed.styleAttrs));

/* Modale HolafModal de révocation (réversible). */
await evaluate(`(() => {
  const b = [...document.querySelectorAll('#agents-root button')].find((x) => x.textContent === "Révoquer");
  b?.click();
})()`);
await sleep(400);
const modal = await evaluate(`(() => {
  const title = document.querySelector('.holaf-modal-title')?.textContent ?? '';
  const cancel = [...document.querySelectorAll('.holaf-modal-btn')].find((b) => b.textContent === 'Annuler');
  return { title, hasCancel: !!cancel };
})()`);
check("[/config#agents] révocation : confirmation HolafModal (pas window.confirm)", modal.title.includes("Révoquer cet agent"), JSON.stringify(modal));
await evaluate(`(() => { [...document.querySelectorAll('.holaf-modal-btn')].find((b) => b.textContent === 'Annuler')?.click(); })()`);
await sleep(200);

/* Approbation : la demande disparaît de la liste (seules les « pending » s'affichent). */
await evaluate(`(() => { [...document.querySelectorAll('#agents-root button')].find((b) => b.textContent === 'Approuver')?.click(); })()`);
await sleep(800);
const afterApprove = await evaluate(`(() => ({
  approvals: [...document.querySelectorAll('#agents-root button')].some((b) => b.textContent === 'Approuver'),
}))()`);
check("[/config#agents] après approbation, la demande disparaît", afterApprove.approvals === false);
seeded.proc.kill("SIGTERM");
await sleep(300);

/* ═══════════ 3) Formulaire d'appairage (D119) ═════════════════════ */
const PENDING_CODE = "ABCD-2345-6789";
const pairing = await startServer({ YUKI_E2E_PENDING_CODE: PENDING_CODE });
await navigate(`${pairing.base}/config?t=${Date.now()}#agents`);

// 3a) Code invalide : le message EXACT du serveur est affiché (véridique).
await evaluate(`(() => {
  const input = document.getElementById('agent-pair-code');
  input.value = 'nope';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('#agents-root button')].find((b) => b.textContent === 'Appairer')?.click();
})()`);
await sleep(600);
const invalidMsg = await evaluate(`document.getElementById('agent-pair-status')?.textContent ?? ''`);
check("[/config#agents] code invalide ⇒ message du serveur", /invalide|attendu 12/.test(invalidMsg), invalidMsg);

// 3b) Code en attente : l'agent est apparié et apparaît dans la liste.
await evaluate(`(() => {
  const input = document.getElementById('agent-pair-code');
  input.value = '${PENDING_CODE}';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  [...document.querySelectorAll('#agents-root button')].find((b) => b.textContent === 'Appairer')?.click();
})()`);
await sleep(700);
const accepted = await evaluate(`document.getElementById('agent-pair-status')?.textContent ?? ''`);
check("[/config#agents] code en attente ⇒ « Code accepté »", accepted.includes('Code accepté'), accepted);
await sleep(1900); // rafraîchissement différé : l'agent doit apparaître
const afterPair = await evaluate(`(() => ({
  cards: document.querySelectorAll('#agents-root .agent-card').length,
  styleAttrs: document.body.querySelectorAll('[style]').length,
}))()`);
check("[/config#agents] l'agent apparié apparaît dans la liste", afterPair.cards >= 1, JSON.stringify(afterPair));
check("[/config#agents] toujours aucun style= inline après appairage", afterPair.styleAttrs === 0, String(afterPair.styleAttrs));
await shot("agents-e2e-pairing");
pairing.proc.kill("SIGTERM");

/* ═══════════════════════ Bilan CSP / exceptions ═══════════════════════ */
const cspViolations = [
  ...consoleMessages.filter((m) => /refused|content security policy|csp/i.test(m.text)),
  ...logEntries.filter((e) => /refused|content security policy|csp/i.test(e.text) || e.source === "security"),
];
check("ZÉRO violation CSP", cspViolations.length === 0, cspViolations.map((v) => v.text).join(" | "));
check("ZÉRO exception JS non capturée", pageExceptions.length === 0, pageExceptions.join(" | ").slice(0, 300));
console.log(`\nMessages console : ${consoleMessages.length} ; entrées Log : ${logEntries.length}`);

const failed = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`,
);

chrome.kill("SIGKILL");
process.exit(failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1);
