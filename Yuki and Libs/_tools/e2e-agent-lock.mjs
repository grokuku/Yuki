#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — VERROU « MATÉRIEL SENSIBLE » (page `/config` ET chat
 * `/`, bureau ET téléphone).
 *
 * Prouve PAR MESURE, avec la CSP RÉELLE :
 *   ① `/config` : la section « Mot de passe d'instance » existe, ne réaffiche
 *      JAMAIS la valeur, et l'API ne la renvoie pas (octets) ;
 *   ② la case « Matériel sensible » est cochée pour l'agent sensible, pas pour
 *      l'agent ordinaire ; l'état VERROUILLÉ est affiché (badge + bouton) ;
 *   ③ « Déverrouiller » ouvre une `HolafModal` avec un champ `type=password` :
 *      mauvais mot de passe ⇒ refus (agent TOUJOURS verrouillé) ; bon ⇒
 *      déverrouillé, avec le temps restant affiché ;
 *   ④ le NIVEAU de garde-fou n'a PAS changé (API + sélecteur) ;
 *   ⑤ page de discussion (BUREAU) : CADENAS + libellé « verrouillé » sur
 *      l'entrée de l'agent, action « Déverrouiller l'agent… » dans le menu
 *      contextuel (clic droit) — et RIEN de tout ça sur l'agent ordinaire ;
 *   ⑥ TÉLÉPHONE (360×640) : le menu « Agents » montre le CADENAS, et l'appui
 *      long ouvre la MÊME action ; le déverrouillage aboutit ;
 *   ⑦ ZÉRO violation CSP / connexion / exception ; le mot de passe n'apparaît
 *      jamais dans le DOM.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-agent-lock.mjs"
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

/** Mot de passe d'instance du harnais (haché sur disque côté serveur). */
const PASSWORD = "motdepasse-e2e-42";
const WRONG_PASSWORD = "mauvais-mot-de-passe";

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-lock-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

/* ─── Gateway de test ───────────────────────────────────────────────────── */
async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-agent-lock-serve.ts")], {
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
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-lock-chrome-"));
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
  await sleep(800);
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
  await send("Runtime.evaluate", {
    expression: "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))",
    awaitPromise: true,
  });
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
}

/**
 * Centre d'un élément, APRÈS l'avoir amené dans la fenêtre : la page `/config`
 * est longue, un clic sur un bouton hors écran ne déclencherait rien.
 */
const centerOf = (selector) =>
  evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);

/** Clic RÉEL (CDP) — traverse la couche de rendu (utilisé sur téléphone). */
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

/** HTML complet de la page (preuve d'absence de la valeur dans le DOM). */
const pageBytes = (secret) =>
  evaluate(
    `(() => {
      const html = document.documentElement.outerHTML;
      const values = [...document.querySelectorAll('input')]
        .map((i) => i.value)
        .filter((v) => v !== '');
      const secret = ${JSON.stringify(secret)};
      return {
        html,
        values: values.length,
        leaked: values.filter((v) => v === secret).length,
      };
    })()`,
  );

/* ══════════════════ 1) `/config` — section mot de passe ═══════════════════ */
await setViewport(1280, 900);
await navigate(`${server.base}/config`);

const passwordSection = await waitFor(
  `!!document.querySelector('#instance-password-root .config-password')`,
);
check("`/config` : la section « Mot de passe d'instance » est rendue", passwordSection);

const passwordState = await evaluate(`(() => {
  const root = document.querySelector('#instance-password-root');
  if (!root) return null;
  const inputs = [...root.querySelectorAll('input')];
  return {
    text: root.textContent.replace(/\\s+/g, ' ').trim(),
    inputs: inputs.length,
    passwordTypes: inputs.filter((i) => i.type === 'password').length,
    values: inputs.map((i) => i.value),
    heading: root.querySelector('h2')?.textContent ?? '',
  };
})()`);
check(
  "`/config` : la section annonce un mot de passe DÉFINI et explique le reverrouillage",
  /Mot de passe défini le/.test(passwordState.text) && /reverrouille/.test(passwordState.text),
  passwordState.text.slice(0, 140),
);
check(
  "`/config` : trois champs (ancien / nouveau / confirmation), tous de type password et VIDES",
  passwordState.inputs === 3 &&
    passwordState.passwordTypes === 3 &&
    passwordState.values.every((v) => v === ""),
  `champs=${passwordState.inputs} password=${passwordState.passwordTypes}`,
);

const apiPassword = await evaluate(
  `fetch('/api/config/password').then((r) => r.text())`,
);
check(
  "API : `GET /api/config/password` ne renvoie NI le mot de passe NI son haché (octets)",
  !apiPassword.includes(PASSWORD) && !apiPassword.includes("hash"),
  apiPassword.slice(0, 160),
);
const domBytes = await pageBytes(PASSWORD);
check(
  "DOM : le mot de passe n'apparaît nulle part (octets du document)",
  !domBytes.html.includes(PASSWORD) && domBytes.leaked === 0,
  `champs remplis=${domBytes.values} ; fuites=${domBytes.leaked}`,
);

/* ══════════════════ 2) `/config` — agent SENSIBLE verrouillé ══════════════ */
await clickAt(...Object.values(await centerOf('#tab-agents')));
const agentsLoaded = await waitFor(
  `document.querySelectorAll('#agents-root .agent-card').length >= 2`,
);
check("`/config` : deux fiches d'agents (sensible + ordinaire) affichées", agentsLoaded);

const cards = await evaluate(`(() => {
  const read = (id) => {
    const card = document.querySelector('[data-agent-id="' + id + '"], #agents-root .agent-card');
    return null;
  };
  const list = [...document.querySelectorAll('#agents-root .agent-card')].map((card) => {
    const box = card.querySelector('.agent-sensitive__input');
    const levelSelect = card.querySelector('select');
    return {
      title: card.querySelector('.agent-id')?.textContent ?? '',
      sensitive: box ? box.checked : null,
      lockedBadge: [...card.querySelectorAll('.agent-badge')].map((b) => b.textContent.trim()),
      lockText: card.querySelector('.agent-lock')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      unlockButton: [...card.querySelectorAll('button')].map((b) => b.textContent.trim()).includes('Déverrouiller'),
      levelValue: levelSelect ? levelSelect.value : null,
    };
  });
  return list;
})()`);
const sensitiveCard = cards.find((c) => c.title.includes("nuc00"));
const ordinaryCard = cards.find((c) => c.title.includes("nuc01"));
check(
  "case « Matériel sensible » COCHÉE pour nuc00, DÉCOCHÉE pour nuc01",
  sensitiveCard?.sensitive === true && ordinaryCard?.sensitive === false,
  `nuc00=${sensitiveCard?.sensitive} nuc01=${ordinaryCard?.sensitive}`,
);
check(
  "nuc00 : état VERROUILLÉ affiché (badge + bouton « Déverrouiller »)",
  sensitiveCard?.lockedBadge.includes("Verrouillé") && sensitiveCard?.unlockButton === true,
  `badges=${(sensitiveCard?.lockedBadge ?? []).join("|")}`,
);
check(
  "nuc01 : AUCUN état de verrou (agent ordinaire non affecté)",
  ordinaryCard?.lockText === "" && ordinaryCard?.unlockButton === false,
  ordinaryCard?.lockText ?? "",
);
await shot("lock-01-config-verrouille");

/* ══════════════════ 3) Déverrouillage : mauvais puis bon mot de passe ════ */
async function openUnlockModal(triggerSelector) {
  const center = await centerOf(triggerSelector);
  if (!center) throw new Error(`bouton introuvable : ${triggerSelector}`);
  await clickAt(center.x, center.y);
  return waitFor(`!!document.querySelector('.holaf-modal-root .secret-prompt input')`);
}

const modalOpened = await openUnlockModal(
  `#agents-root .agent-card button[type="button"]:not(.button--ghost)`,
);
check("« Déverrouiller » ouvre une HolafModal (jamais window.prompt)", modalOpened === true);
const modalField = await evaluate(`(() => {
  const modal = document.querySelector('.holaf-modal-root');
  const input = modal?.querySelector('.secret-prompt input');
  return {
    type: input ? input.type : '',
    title: modal?.querySelector('.holaf-modal-title')?.textContent ?? '',
    buttons: [...(modal?.querySelectorAll('.holaf-modal-btn') ?? [])].map((b) => b.textContent.trim()),
    value: input ? input.value : null,
  };
})()`);
check(
  "la fenêtre de mot de passe utilise un champ `type=password` (valeur masquée)",
  modalField.type === "password" && modalField.value === "",
  `type=${modalField.type} boutons=${modalField.buttons.join("|")}`,
);

/** Saisit un mot de passe puis valide (bouton primaire de la modale). */
async function submitPassword(value) {
  await evaluate(`(() => {
    const input = document.querySelector('.holaf-modal-root .secret-prompt input');
    input.focus();
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await evaluate(`(() => {
    const modal = document.querySelector('.holaf-modal-root');
    const btn = [...modal.querySelectorAll('.holaf-modal-btn')].find((b) => b.textContent.trim() === 'Déverrouiller');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await sleep(400);
}

await submitPassword(WRONG_PASSWORD);
const refusal = await waitFor(
  `[...document.querySelectorAll('.holaf-modal-title')].some((t) => t.textContent.includes('Déverrouillage refusé'))`,
);
check("mauvais mot de passe ⇒ REFUS explicite (fenêtre d'erreur)", refusal === true);
const refusalText = await evaluate(`(() => {
  const titles = [...document.querySelectorAll('.holaf-modal-title')].map((t) => t.textContent);
  const bodies = [...document.querySelectorAll('.holaf-modal-body')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim());
  return { titles, bodies };
})()`);
check(
  "le message de refus dit la vraie cause (« incorrect ») et que l'agent reste verrouillé",
  refusalText.bodies.some((b) => /incorrect/i.test(b) && /reste verrouillé/i.test(b)),
  refusalText.bodies.join(" | ").slice(0, 160),
);
// Ferme la fenêtre d'erreur.
await evaluate(`(() => {
  const modal = [...document.querySelectorAll('.holaf-modal-root')].pop();
  const ok = [...modal.querySelectorAll('.holaf-modal-btn')][0];
  ok.click();
  return true;
})()`);
await sleep(300);
const stillLocked = await evaluate(`fetch('/api/agents').then((r) => r.json()).then((d) => d.agents.find((a) => a.agentId === 'agent-nuc00').locked)`);
check("après un mauvais mot de passe, l'agent est TOUJOURS verrouillé", stillLocked === true);

// Deuxième essai : bon mot de passe.
await openUnlockModal(
  `#agents-root .agent-card button[type="button"]:not(.button--ghost)`,
);
await submitPassword(PASSWORD);
// Succès : la fenêtre se referme d'elle-même et la FICHE passe à « Déverrouillé »
// (visible immédiatement, pas seulement dans une alerte).
const modalClosed = await waitFor(`!document.querySelector('.holaf-modal-root .secret-prompt input')`);
check("bon mot de passe ⇒ la fenêtre de saisie se referme", modalClosed === true);
const afterUnlock = await waitFor(
  `[...document.querySelectorAll('#agents-root .agent-card')].some((c) => c.textContent.includes('Déverrouillé') && c.textContent.includes('nuc00'))`,
);
check("la fiche passe à « Déverrouillé » (état SÉPARÉ, pas le niveau)", afterUnlock === true);
const unlockedCard = await evaluate(`(() => {
  const card = [...document.querySelectorAll('#agents-root .agent-card')].find((c) => c.textContent.includes('nuc00'));
  const select = card.querySelector('select');
  return {
    text: card.querySelector('.agent-lock')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    level: select ? select.value : null,
    relock: [...card.querySelectorAll('button')].map((b) => b.textContent.trim()).includes('Reverrouiller maintenant'),
  };
})()`);
check(
  "le TEMPS RESTANT avant reverrouillage est affiché (confort)",
  /Reverrouillage automatique dans ~15 min/.test(unlockedCard.text),
  unlockedCard.text,
);
check(
  "le NIVEAU de garde-fou n'a pas changé (nuc00 reste « never » = Pas de validation)",
  unlockedCard.level === "never",
  `niveau=${unlockedCard.level}`,
);
check(
  "l'action « Reverrouiller maintenant » est proposée quand l'agent est déverrouillé",
  unlockedCard.relock === true,
);

// Reverrouillage explicite : le niveau ne doit PAS bouger.
await evaluate(`(() => {
  const card = [...document.querySelectorAll('#agents-root .agent-card')].find((c) => c.textContent.includes('nuc00'));
  const btn = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Reverrouiller maintenant');
  btn.click();
  return true;
})()`);
const relocked = await waitFor(
  `[...document.querySelectorAll('#agents-root .agent-card')].some((c) => c.textContent.includes('nuc00') && c.textContent.includes('Verrouillé'))`,
);
const levelAfterRelock = await evaluate(`fetch('/api/agents').then((r) => r.json()).then((d) => { const a = d.agents.find((x) => x.agentId === 'agent-nuc00'); return { level: a.level, locked: a.locked }; })`);
check(
  "reverrouillage ⇒ agent VERROUILLÉ de nouveau, NIVEAU INCHANGÉ (« never »)",
  relocked === true && levelAfterRelock.locked === true && levelAfterRelock.level === "never",
  `locked=${levelAfterRelock.locked} niveau=${levelAfterRelock.level}`,
);
await shot("lock-02-config-reverrouille");

/* ══════════════════ 4) Page de discussion — BUREAU ═════════════════════ */
// Un agent CONNECTÉ rend la pastille réaliste (le verrou, lui, est indépendant).
await evaluate(`fetch('/api/e2e/agent-connect?agentId=agent-nuc00')`);
await evaluate(`fetch('/api/e2e/agent-connect?agentId=agent-nuc01')`);
await navigate(`${server.base}/`);
const sidebarReady = await waitFor(`document.querySelectorAll('.side-agent').length >= 2`);
check("chat : les deux agents apparaissent dans l'encart de la barre latérale", sidebarReady);

const desktopRows = await evaluate(`(() => [...document.querySelectorAll('.side-agent')].map((row) => ({
  id: row.getAttribute('data-agent-id'),
  locked: row.getAttribute('data-locked'),
  sensitive: row.getAttribute('data-sensitive'),
  lockGlyph: row.querySelector('.side-agent__lock')?.textContent ?? '',
  state: row.querySelector('.side-agent__state')?.textContent ?? '',
  aria: row.querySelector('.side-agent__badge')?.getAttribute('aria-label') ?? '',
})))()`);
const nuc00Desktop = desktopRows.find((r) => r.id === "agent-nuc00");
const nuc01Desktop = desktopRows.find((r) => r.id === "agent-nuc01");
check(
  "BUREAU : CADENAS visible sur l'agent sensible verrouillé (glyphe + libellé + aria)",
  nuc00Desktop?.locked === "true" &&
    nuc00Desktop?.lockGlyph === "🔒" &&
    /verrouillé/.test(nuc00Desktop?.state ?? "") &&
    /verrouillé/.test(nuc00Desktop?.aria ?? ""),
  `état="${nuc00Desktop?.state}" aria="${nuc00Desktop?.aria}"`,
);
check(
  "BUREAU : l'agent ordinaire n'a NI cadenas NI mention de verrou",
  nuc01Desktop?.locked === null &&
    nuc01Desktop?.lockGlyph === "" &&
    !/verrouillé/.test(nuc01Desktop?.state ?? ""),
  `état="${nuc01Desktop?.state}"`,
);
await shot("lock-03-chat-bureau-verrouille");

/** Menu contextuel de l'agent (clic droit) : état des entrées + action de verrou. */
const agentContextMenu = (agentId) =>
  evaluate(`(() => {
    const row = document.querySelector('.side-agent[data-agent-id="${agentId}"]');
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 10), clientY: Math.round(r.top + 10) }));
    const m = document.querySelector('.ctx-menu--levels');
    const action = m ? m.querySelector('.ctx-menu__item--action') : null;
    return {
      open: !!m && !m.hidden,
      radios: m ? [...m.querySelectorAll('.ctx-menu__item--radio')].length : 0,
      actionHidden: action ? action.hidden : null,
      actionText: action ? action.textContent.replace(/\\s+/g, ' ').trim() : '',
    };
  })()`);

const menuLocked = await agentContextMenu("agent-nuc00");
check(
  "BUREAU : clic droit sur l'agent VERROUILLÉ ⇒ action « Déverrouiller l'agent… » proposée",
  menuLocked.open === true &&
    menuLocked.radios === 4 &&
    menuLocked.actionHidden === false &&
    menuLocked.actionText.includes("Déverrouiller l'agent"),
  menuLocked.actionText,
);
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
const menuOrdinary = await agentContextMenu("agent-nuc01");
check(
  "BUREAU : clic droit sur l'agent ordinaire ⇒ action de déverrouillage MASQUÉE",
  menuOrdinary.open === true && menuOrdinary.actionHidden === true,
  `masquée=${menuOrdinary.actionHidden}`,
);

/* Déverrouillage depuis le menu contextuel du chat → l'encart se met à jour. */
await agentContextMenu("agent-nuc00");
await evaluate(`(() => {
  const m = document.querySelector('.ctx-menu--levels');
  const action = m.querySelector('.ctx-menu__item--action');
  action.click();
  return true;
})()`);
const chatModal = await waitFor(`!!document.querySelector('.holaf-modal-root .secret-prompt input')`);
check("BUREAU : l'action du menu ouvre la fenêtre de mot de passe", chatModal === true);
await submitPassword(PASSWORD);
await evaluate(`(() => {
  const modal = [...document.querySelectorAll('.holaf-modal-root')].pop();
  modal.querySelector('.holaf-modal-btn').click();
  return true;
})()`);
const badgeCleared = await waitFor(
  `document.querySelector('.side-agent[data-agent-id="agent-nuc00"]')?.getAttribute('data-locked') === null`,
);
check(
  "BUREAU : après déverrouillage, le CADENAS disparaît (trame `agents` du serveur)",
  badgeCleared === true,
);
const unlockedRowState = await evaluate(`document.querySelector('.side-agent[data-agent-id="agent-nuc00"] .side-agent__state')?.textContent ?? ''`);
check(
  "BUREAU : le libellé indique « déverrouillé » + le délai de reverrouillage",
  /déverrouillé/.test(unlockedRowState) && /reverrouille dans \d+ min/.test(unlockedRowState),
  unlockedRowState,
);
await shot("lock-04-chat-bureau-deverrouille");

/* On remet le verrou pour la partie TÉLÉPHONE. */
await evaluate(`fetch('/api/agents/agent-nuc00/lock', { method: 'POST', headers: { 'x-yuki-agents': '1' } })`);
await waitFor(`document.querySelector('.side-agent[data-agent-id="agent-nuc00"]')?.getAttribute('data-locked') === 'true'`);

/* ══════════════════ 5) TÉLÉPHONE 360×640 ═══════════════════════════════ */
await setViewport(360, 640, { mobile: true });
await navigate(`${server.base}/`);
check("téléphone : la liste des conversations est chargée", await waitFor(`document.querySelectorAll('.conv').length >= 1`));

let center = await centerOf('[data-nav="agents"]');
await clickAt(center.x, center.y);
const phoneRows = await evaluate(`(() => [...document.querySelectorAll('.mnav-agent')].map((row) => ({
  id: row.getAttribute('data-agent-id'),
  locked: row.getAttribute('data-locked'),
  lockLabel: row.querySelector('.mnav-agent__lock')?.textContent ?? '',
  lockAttr: row.querySelector('.mnav-agent__lock')?.getAttribute('data-locked') ?? null,
  state: row.querySelector('.side-agent__state')?.textContent ?? '',
  glyph: row.querySelector('.side-agent__lock')?.textContent ?? '',
})))()`);
const nuc00Phone = phoneRows.find((r) => r.id === "agent-nuc00");
const nuc01Phone = phoneRows.find((r) => r.id === "agent-nuc01");
check(
  "TÉLÉPHONE : le menu « Agents » montre le CADENAS et le libellé « verrouillé »",
  nuc00Phone?.locked === "true" &&
    nuc00Phone?.lockLabel === "verrouillé" &&
    nuc00Phone?.lockAttr === "true" &&
    nuc00Phone?.glyph === "🔒",
  `libellé="${nuc00Phone?.lockLabel}" glyphe="${nuc00Phone?.glyph}"`,
);
check(
  "TÉLÉPHONE : l'agent ordinaire n'affiche AUCUN verrou",
  nuc01Phone?.locked === null && (nuc01Phone?.lockLabel ?? "") === "",
  `libellé="${nuc01Phone?.lockLabel}"`,
);
await shot("lock-05-telephone-menu-agents");

/* Appui long sur la ligne d'agent : le MÊME menu, avec l'action de déverrouillage. */
const longPressMenu = await evaluate(`(async () => {
  const row = document.querySelector('.mnav-agent[data-agent-id="agent-nuc00"]');
  if (!row) return { ok: false, reason: 'ligne absente' };
  const r = row.getBoundingClientRect();
  const x = Math.round(r.left + 20);
  const y = Math.round(r.top + r.height / 2);
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, button: 0 }));
  await new Promise((res) => setTimeout(res, 650));
  const m = document.querySelector('.ctx-menu--levels');
  const action = m ? m.querySelector('.ctx-menu__item--action') : null;
  const out = {
    ok: !!m && !m.hidden,
    radios: m ? [...m.querySelectorAll('.ctx-menu__item--radio')].length : 0,
    actionHidden: action ? action.hidden : null,
    actionText: action ? action.textContent.replace(/\\s+/g, ' ').trim() : '',
  };
  row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch' }));
  // Comme un vrai doigt : le CLIC qui suit le relâchement est ABSORBÉ par
  // l'appui long (sinon la pastille basculerait l'agent par accident). On le
  // consomme ici pour que le clic SUIVANT (l'action du menu) aboutisse.
  row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  await new Promise((res) => setTimeout(res, 150));
  return out;
})()`);
check(
  "TÉLÉPHONE : APPUI LONG ⇒ menu de niveau (4) + action « Déverrouiller l'agent… »",
  longPressMenu.ok === true &&
    longPressMenu.radios === 4 &&
    longPressMenu.actionHidden === false &&
    longPressMenu.actionText.includes("Déverrouiller l'agent"),
  longPressMenu.actionText ?? longPressMenu.reason ?? "",
);

await evaluate(`(() => {
  const m = document.querySelector('.ctx-menu--levels');
  m.querySelector('.ctx-menu__item--action').click();
  return true;
})()`);
const phoneModal = await waitFor(`!!document.querySelector('.holaf-modal-root .secret-prompt input')`);
check(
  "TÉLÉPHONE : le déverrouillage est ACCESSIBLE (fenêtre + champ mot de passe)",
  phoneModal === true,
);
await submitPassword(PASSWORD);
await evaluate(`(() => {
  const modal = [...document.querySelectorAll('.holaf-modal-root')].pop();
  modal.querySelector('.holaf-modal-btn').click();
  return true;
})()`);
const phoneUnlocked = await waitFor(
  `document.querySelector('.mnav-agent[data-agent-id="agent-nuc00"]')?.getAttribute('data-locked') === null`,
);
const phoneRowAfter = await evaluate(`(() => {
  const row = document.querySelector('.mnav-agent[data-agent-id="agent-nuc00"]');
  return {
    lockLabel: row.querySelector('.mnav-agent__lock')?.textContent ?? '',
    state: row.querySelector('.side-agent__state')?.textContent ?? '',
  };
})()`);
check(
  "TÉLÉPHONE : après déverrouillage, le libellé passe à « déverrouillé » (temps restant)",
  phoneUnlocked === true && /déverrouillé/.test(phoneRowAfter.lockLabel) && /min/.test(phoneRowAfter.lockLabel),
  phoneRowAfter.lockLabel,
);
await shot("lock-06-telephone-deverrouille");

/* Les DEUX pages n'exposent jamais le mot de passe dans leur DOM. */
const phoneBytes = await pageBytes(PASSWORD);
check(
  "TÉLÉPHONE : le mot de passe n'est JAMAIS présent dans le DOM (octets)",
  !phoneBytes.html.includes(PASSWORD) &&
    !phoneBytes.html.includes(WRONG_PASSWORD) &&
    phoneBytes.leaked === 0,
  `champs remplis=${phoneBytes.values} ; fuites=${phoneBytes.leaked}`,
);

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
const failed = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; connexion = ${connectionErrors.length} ; exceptions = ${pageExceptions.length} ═══`,
);

chrome.kill("SIGKILL");
process.exit(
  failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1,
);
