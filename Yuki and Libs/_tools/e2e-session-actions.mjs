#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — ACTIONS DU MENU DU TITRE : « Supprimer » (DÉFINITIF) et
 * « Compacter… » (passe de mémoire AVANT compaction), sur le gateway RÉEL, avec
 * un hôte Pi RÉEL, le VRAI SDK (compaction réelle) et la CSP réelle.
 *
 * Prouve, de bout en bout (aucune confiance aux commentaires) :
 *  1. « Supprimer » n'est PLUS grisé ; il ouvre une confirmation qui NOMME la
 *     conversation et dit « DÉFINITIF / aucune récupération possible » ;
 *  2. ANNULER ne supprime rien (le fil et son fichier sont toujours là) ;
 *  3. CONFIRMER supprime : la conversation quitte la liste ET son fichier JSONL
 *     disparaît du disque ;
 *  4. la MÉMOIRE DURABLE est INTACTE octet pour octet (SHA-256 identique) ;
 *  5. supprimer la conversation OUVERTE ramène à l'état vide (cohérent) ;
 *  6. « Compacter… » ouvre une attente VISIBLE, puis le compte rendu réel ; le
 *     JSONL porte une entrée `compaction` (le fil EST compacté) ;
 *  7. la PASSE DE MÉMOIRE tourne AVANT la compaction (ordre prouvé par les
 *     journaux du serveur) et le fait durable est écrit ;
 *  8. sur une conversation VIDE, compacter refuse avec un message CLAIR ;
 *  9. sur TÉLÉPHONE (appui long), les DEUX actions sont présentes et la
 *     confirmation nomme la conversation ;
 * 10. ZÉRO violation CSP, ZÉRO erreur de connexion, ZÉRO exception JS.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-session-actions.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-actions-"));

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-session-actions-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_ACTIONS_DIR: STATE_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString()));
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  const urls = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("serveur non démarré :\n" + logs.join(""))),
      60_000,
    );
    const onData = () => {
      const m = logs.join("").match(/READY (http:\/\/\S+) PROBE (http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ base: m[1].trim(), probe: m[2].trim() });
      }
    };
    proc.stdout.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serveur quitté (${code}) :\n${logs.join("")}`));
    });
  });
  await waitForGateway(urls.base);
  return { proc, ...urls, logs };
}

const server = await startServer();
const probe = async (path) => (await fetch(`${server.probe}${path}`)).json();

/* ─── Chromium headless (CDP) ────────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-actions-chrome-"));
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
await setViewport(1280, 900);

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
    await sleep(60);
  }
  return false;
}

/** Attend qu'une condition soit vraie (bornée) en JS. */
async function waitForValue(expression, predicate, timeout = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await evaluate(expression);
    if (predicate(value)) return value;
    await sleep(100);
  }
  return null;
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

const conversations = () =>
  evaluate(`(() => [...document.querySelectorAll('.conv')].map((c) => ({
    title: (c.querySelector('.conv__title')?.textContent ?? '').trim(),
    active: c.classList.contains('conv--active'),
  })))()`);

/** Ouvre le MENU DU TITRE d'une conversation par CLIC DROIT (bureau). */
async function openTitleMenu(title, selector = ".conv") {
  const ok = await evaluate(`(() => {
    const row = [...document.querySelectorAll(${JSON.stringify(selector)})].find(
      (x) => (x.querySelector('.conv__title')?.textContent ?? '').trim() === ${JSON.stringify(title)},
    );
    if (!row) return false;
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 12, clientY: r.top + 12 }));
    return true;
  })()`);
  if (!ok) throw new Error(`conversation introuvable : ${title}`);
  await sleep(200);
}

/** État du menu du titre ouvert. */
const menuState = () =>
  evaluate(`(() => ({
    open: !document.querySelector('.ctx-menu')?.hidden,
    items: [...document.querySelectorAll('.ctx-menu__item')].map((b) => ({ text: (b.textContent ?? '').trim(), disabled: b.disabled })),
  }))()`);

/** État de la DERNIÈRE fenêtre de la brique (attente OU compte rendu). */
const modalState = () =>
  evaluate(`(() => {
    const roots = [...document.querySelectorAll('.holaf-modal-root')];
    if (roots.length === 0) return { open: false, busy: false, title: '', message: '', buttons: [], busyLabel: '' };
    const last = roots[roots.length - 1];
    // L'écran d'attente de la brique est un noeud AVEC spinner (et sans titre) ;
    // un compte rendu (alert) est un noeud AVEC titre.
    const busy = Boolean(last.querySelector('.holaf-modal-spinner'));
    const message = (last.querySelector('.holaf-modal-message')?.textContent ?? '').trim();
    return {
      open: true,
      busy,
      title: (last.querySelector('.holaf-modal-title')?.textContent ?? '').trim(),
      message,
      buttons: [...last.querySelectorAll('.holaf-modal-btn')].map((b) => (b.textContent ?? '').trim()),
      busyLabel: busy ? message : '',
    };
  })()`);

/** Attend le COMPTE RENDU (fenêtre titrée) d'une opération longue. */
async function waitForReport(timeout = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const state = await modalState();
    if (state.open && !state.busy && state.title.length > 0) return state;
    await sleep(120);
  }
  return null;
}

/** Clique un bouton de la DERNIÈRE fenêtre ; renvoie `false` s'il n'existe pas. */
async function clickModalButton(text) {
  const ok = await evaluate(`(() => {
    const roots = [...document.querySelectorAll('.holaf-modal-root')];
    const modal = roots[roots.length - 1];
    if (!modal) return false;
    const b = [...modal.querySelectorAll('.holaf-modal-btn')].find((x) => (x.textContent ?? '').trim() === ${JSON.stringify(text)});
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(250);
  return ok;
}

/* ═══════════════════════ 1) État initial ════════════════════════════════ */
await navigate(`${server.base}/`);
check(
  "liste : les TROIS conversations de test sont présentes",
  await waitFor(`document.querySelectorAll('.conv').length === 3`),
);
const seeds = await probe("/seeds");
const memoryBefore = await probe("/memory-bytes");
const potagerFile = await probe(`/file-exists?id=${encodeURIComponent(seeds.potager)}`);
const jeterFile = await probe(`/file-exists?id=${encodeURIComponent(seeds.jeter)}`);
check(
  "départ : les fichiers des conversations existent sur le disque",
  potagerFile.exists === true && jeterFile.exists === true,
);
check("départ : aucune entrée `compaction` dans le fil POTAGER", (await probe(`/entries?id=${encodeURIComponent(seeds.potager)}`)).compactions.length === 0);

/* ═════ 2) « Supprimer » n'est PAS grisé et la confirmation NOMME le fil ══ */
await openTitleMenu("Conversation JETER");
const menu = await menuState();
const deleteItem = menu.items.find((item) => item.text === "Supprimer");
check(
  "menu du titre : « Supprimer » est PRÉSENT et ACTIVÉ (plus de bouton inerte)",
  Boolean(deleteItem) && deleteItem.disabled === false,
  menu.items.map((i) => `${i.text}${i.disabled ? " (désactivé)" : ""}`).join(" | "),
);
check(
  "menu du titre : « Compacter… » est présent",
  menu.items.some((item) => item.text === "Compacter…"),
);

await evaluate(`(() => {
  const b = [...document.querySelectorAll('.ctx-menu__item')].find((x) => (x.textContent ?? '').trim() === 'Supprimer');
  b.click();
})()`);
await sleep(250);
const confirmState = await modalState();
check(
  "confirmation : la fenêtre NOMME la conversation",
  confirmState.open === true && confirmState.title.includes("Conversation JETER"),
  `titre = ${confirmState.title}`,
);
check(
  "confirmation : « DÉFINITIF » ET « aucune récupération possible » sont DITS",
  /DÉFINITIF/i.test(confirmState.message) && /aucune récupération possible/i.test(confirmState.message),
  confirmState.message.slice(0, 160),
);
check(
  "confirmation : la MÉMOIRE est explicitement épargnée (pas d'ambiguïté)",
  /mémoire durable n'est PAS touchée/i.test(confirmState.message),
);
check(
  "confirmation : boutons explicites (aucun « OK / Annuler » générique)",
  confirmState.buttons.includes("Supprimer définitivement") && confirmState.buttons.includes("Annuler"),
  confirmState.buttons.join(" | "),
);

/* ═════ 3) ANNULER ne supprime RIEN (pas de retour en arrière, mais pas de
        destruction accidentelle non plus : rien n'est fait) ═══════════════ */
await clickModalButton("Annuler");
await sleep(400);
const afterCancel = await conversations();
const jeterAfterCancel = await probe(`/file-exists?id=${encodeURIComponent(seeds.jeter)}`);
check(
  "annuler : la conversation est TOUJOURS dans la liste et son fichier existe",
  afterCancel.length === 3 && jeterAfterCancel.exists === true,
  `${afterCancel.length} conversation(s) ; fichier=${jeterAfterCancel.exists}`,
);

/* ═════ 4) CONFIRMER supprime : liste + FICHIER, MÉMOIRE INTACTE ═════════ */
await openTitleMenu("Conversation JETER");
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.ctx-menu__item')].find((x) => (x.textContent ?? '').trim() === 'Supprimer');
  b.click();
})()`);
await sleep(200);
await clickModalButton("Supprimer définitivement");
const removed = await waitFor(`document.querySelectorAll('.conv').length === 2`, 5000);
check("suppression : la conversation DISPARAÎT de la liste", removed === true);
const jeterAfterDelete = await probe(`/file-exists?id=${encodeURIComponent(seeds.jeter)}`);
check(
  "suppression : le FICHIER de la conversation est SUPPRIMÉ du disque",
  jeterAfterDelete.exists === false,
  String(jeterAfterDelete.file),
);
const afterDeleteTitles = (await conversations()).map((c) => c.title);
check(
  "suppression : les AUTRES conversations restent (aucune suppression collatérale)",
  afterDeleteTitles.includes("Conversation POTAGER") && afterDeleteTitles.includes("Conversation TEMOIN"),
  afterDeleteTitles.join(" | "),
);
const memoryAfter = await probe("/memory-bytes");
check(
  "MÉMOIRE INTACTE après suppression : fichier IDENTIQUE octet pour octet (SHA-256)",
  memoryAfter.exists === memoryBefore.exists &&
    memoryAfter.bytes === memoryBefore.bytes &&
    memoryAfter.sha === memoryBefore.sha,
  `avant=${memoryBefore.bytes} o / ${memoryBefore.sha.slice(0, 12)} ; après=${memoryAfter.bytes} o / ${memoryAfter.sha.slice(0, 12)}`,
);
const hostSessions = await probe("/sessions");
check(
  "côté hôte : la conversation supprimée n'est plus listée",
  !hostSessions.sessions.some((s) => s.id === seeds.jeter),
  hostSessions.sessions.map((s) => s.title).join(" | "),
);

/* ═════ 5) Supprimer la conversation OUVERTE ⇒ état vide ═════════════════ */
// On OUVRE d'abord une conversation (l'active dépend de la date des fichiers) :
// c'est elle que l'on supprimera, pour prouver le retour à l'état vide.
await evaluate(`(() => {
  const row = [...document.querySelectorAll('.conv')].find(
    (x) => (x.querySelector('.conv__title')?.textContent ?? '').trim() === 'Conversation TEMOIN',
  );
  row.click();
})()`);
const opened = await waitFor(
  `(() => {
    const active = document.querySelector('.conv--active');
    return (active?.querySelector('.conv__title')?.textContent ?? '').trim() === 'Conversation TEMOIN';
  })()`,
  6000,
);
check("une conversation est bien OUVERTE avant de la supprimer", opened === true, "Conversation TEMOIN");
const activeTitle = "Conversation TEMOIN";
await openTitleMenu(activeTitle);
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.ctx-menu__item')].find((x) => (x.textContent ?? '').trim() === 'Supprimer');
  b.click();
})()`);
await sleep(250);
const activeConfirm = await modalState();
check(
  "supprimer la conversation OUVERTE : la confirmation le DIT",
  /conversation ouverte/i.test(activeConfirm.message) && activeConfirm.title.includes(activeTitle),
  activeConfirm.title,
);
await clickModalButton("Supprimer définitivement");
const emptyState = await waitFor(
  `!document.getElementById('empty-state')?.hidden && document.querySelectorAll('.conv').length === 1`,
  6000,
);
check(
  "supprimer la conversation OUVERTE : l'écran revient à l'ÉTAT VIDE (cohérent)",
  emptyState === true,
);

/* ═════ 6) COMPACTER : passe de mémoire AVANT, puis compaction RÉELLE ═══ */
await openTitleMenu("Conversation POTAGER");
const preCompactRequests = await probe("/requests");
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.ctx-menu__item')].find((x) => (x.textContent ?? '').trim() === 'Compacter…');
  b.click();
})()`);
await sleep(250);
const busyState = await modalState();
check(
  "compacter : une ATTENTE VISIBLE s'affiche (la passe de mémoire commence)",
  busyState.open === true && busyState.busy === true && /mémoire/i.test(busyState.busyLabel),
  `attente = ${busyState.busyLabel}`,
);
const compactResult = await waitForReport(90_000);
check(
  "compacter : le compte rendu s'affiche (l'attente se ferme)",
  compactResult !== null && compactResult.title.includes("Compacter"),
  compactResult ? compactResult.title : "aucun compte rendu",
);
const resultText = compactResult?.message ?? "";
check(
  "compacter : le compte rendu donne les MESURES (tokens avant/après)",
  /tokens/.test(resultText) && /avant/.test(resultText) && /après/.test(resultText),
  resultText.slice(0, 220),
);
check(
  "compacter : les chiffres ne MENTENT pas (réduction constatée OU absence d'économie dite)",
  /avant → /.test(resultText) || /aucune économie constatée/.test(resultText),
  /aucune économie constatée/.test(resultText) ? "aucune économie constatée" : "réduction constatée",
);
check(
  "compacter : le compte rendu dit ce qu'a fait la PASSE DE MÉMOIRE",
  /Passe de mémoire/i.test(resultText),
  resultText.split("\n").slice(0, 2).join(" / ").slice(0, 160),
);

/* Le fil est RÉELLEMENT compacté (écrit par le SDK) + ordre prouvé par les logs. */
const entriesAfter = await probe(`/entries?id=${encodeURIComponent(seeds.potager)}`);
check(
  "compacter : le JSONL porte une entrée `compaction` (fil RÉELLEMENT compacté)",
  entriesAfter.compactions.length === 1 && entriesAfter.compactions[0].summaryChars > 0,
  JSON.stringify(entriesAfter.compactions),
);
check(
  "compacter : le moteur a mesuré un contexte AVANT non nul",
  entriesAfter.compactions[0]?.tokensBefore > 0,
  String(entriesAfter.compactions[0]?.tokensBefore),
);
const compactLogs = await probe("/logs?pattern=compact");
const messages = compactLogs.lines.map((line) => line.msg);
const memoryDoneAt = messages.indexOf("pi.session.compact.memory.done");
const compactBeginAt = messages.indexOf("pi.session.compact.begin");
check(
  "compacter : la PASSE DE MÉMOIRE se TERMINE AVANT la compaction (ordre PROUVÉ)",
  memoryDoneAt >= 0 && compactBeginAt > memoryDoneAt,
  `memory.done@${memoryDoneAt} < compact.begin@${compactBeginAt}`,
);
check(
  "compacter : le moteur a reçu une requête de summarisation (compaction réelle)",
  (await probe("/requests")).requests > preCompactRequests.requests,
);
const memoriesAfterCompact = await probe("/memories");
check(
  "compacter : le fait durable de la conversation est ÉCRIT en mémoire",
  memoriesAfterCompact.entries.some((entry) => /potager/i.test(entry.text)),
  memoriesAfterCompact.entries.map((entry) => entry.text).join(" | ").slice(0, 160),
);
const recalled = await probe("/recall?q=potager");
check(
  "compacter : le fait est RETROUVÉ par le rappel mémoire",
  typeof recalled.block === "string" && /potager/i.test(recalled.block),
);

await clickModalButton("Compris");
await sleep(200);

/* ═════ 7) Conversation VIDE : compacter refuse avec un message CLAIR ════ */
await evaluate(`document.querySelector('.sidebar__new')?.click()`);
check(
  "nouvelle conversation : une conversation VIDE devient ouverte",
  await waitFor(`document.querySelectorAll('.conv').length === 2`, 6000),
);
const newTitle = (await conversations()).find((c) => c.active)?.title ?? "";
await openTitleMenu(newTitle);
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.ctx-menu__item')].find((x) => (x.textContent ?? '').trim() === 'Compacter…');
  b.click();
})()`);
const emptyReport = await waitForReport(30_000);
const emptyRefusal = emptyReport ? emptyReport.message : null;
check(
  "conversation VIDE : message CLAIR (pas un succès vide)",
  typeof emptyRefusal === "string" && /vide|trop courte/i.test(emptyRefusal),
  String(emptyRefusal).slice(0, 160),
);
const currentSession = (await probe("/sessions")).current;
const emptyEntries = currentSession
  ? await probe(`/entries?id=${encodeURIComponent(currentSession)}`)
  : { compactions: [] };
check(
  "conversation VIDE : AUCUN résumé écrit (rien n'a été compacté)",
  emptyEntries.compactions.length === 0 &&
    (await probe(`/entries?id=${encodeURIComponent(seeds.potager)}`)).compactions.length === 1,
  `compactions de la conversation vide = ${emptyEntries.compactions.length}`,
);
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.holaf-modal-btn')].find((x) => (x.textContent ?? '').trim() === 'Compris');
  if (b) b.click();
})()`);
await sleep(200);

/* ═════ 8) TÉLÉPHONE : les DEUX actions accessibles (appui long) ═════════ */
await setViewport(390, 844, { mobile: true });
await navigate(`${server.base}/`);
check(
  "téléphone : les conversations sont dans le menu « Conversations »",
  await waitFor(`document.querySelectorAll('.mnav-conv').length >= 2`, 8000),
);
await evaluate(`document.querySelector('[data-nav="conversations"]')?.click()`);
await sleep(300);
const phoneLongPress = await evaluate(`(async () => {
  const row = document.querySelector('.mnav-conv');
  if (!row) return { ok: false, reason: 'aucune ligne' };
  const r = row.getBoundingClientRect();
  const x = Math.round(r.left + 20);
  const y = Math.round(r.top + r.height / 2);
  row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y, button: 0 }));
  await new Promise((res) => setTimeout(res, 700));
  const menu = document.querySelector('.ctx-menu');
  const items = [...document.querySelectorAll('.ctx-menu__item')].map((b) => ({ text: (b.textContent ?? '').trim(), disabled: b.disabled }));
  row.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'touch', clientX: x, clientY: y }));
  return { ok: Boolean(menu) && !menu.hidden, items };
})()`);
check(
  "téléphone : l'APPUI LONG ouvre le menu du titre",
  phoneLongPress.ok === true,
  JSON.stringify(phoneLongPress.items ?? null),
);
check(
  "téléphone : « Supprimer » (ACTIVÉ) et « Compacter… » sont accessibles",
  (phoneLongPress.items ?? []).some((i) => i.text === "Supprimer" && !i.disabled) &&
    (phoneLongPress.items ?? []).some((i) => i.text === "Compacter…"),
  (phoneLongPress.items ?? []).map((i) => `${i.text}${i.disabled ? " (désactivé)" : ""}`).join(" | "),
);
const phoneTargetTitle = await evaluate(`(() => {
  const row = document.querySelector('.mnav-conv');
  return (row?.querySelector('.conv__title')?.textContent ?? '').trim();
})()`);
// ⚠️ PIÈGE CONNU : le PREMIER clic qui suit un appui long est ABSORBÉ
// (capture sur le document, voir `long-press.js`). On consomme ce clic de garde
// avant d'activer réellement l'entrée du menu.
await evaluate(`document.body.click()`);
await sleep(150);
await evaluate(`(() => {
  const b = [...document.querySelectorAll('.ctx-menu__item')].find((x) => (x.textContent ?? '').trim() === 'Supprimer');
  b.click();
})()`);
await sleep(350);
const phoneConfirm = await modalState();
check(
  "téléphone : la confirmation NOMME la conversation et reste sans ambiguïté",
  phoneConfirm.open === true &&
    phoneConfirm.title.includes(phoneTargetTitle) &&
    /DÉFINITIF/i.test(phoneConfirm.message),
  `titre = ${phoneConfirm.title}`,
);
await clickModalButton("Annuler");
await sleep(300);
check(
  "téléphone : annuler laisse la conversation en place (aucune destruction)",
  (await evaluate(`document.querySelectorAll('.mnav-conv').length >= 2`)) === true,
);

/* ═════════════════════ Bilan ═══════════════════════════════════════════ */
await setViewport(1280, 900);
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

console.log(`Messages console : ${consoleMessages.length} ; entrées Log : ${logEntries.length}`);

const failed = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; connexion = ${connectionErrors.length} ; exceptions = ${pageExceptions.length} ═══`,
);

chrome.kill("SIGKILL");
process.exit(
  failed.length === 0 &&
    cspViolations.length === 0 &&
    connectionErrors.length === 0 &&
    pageExceptions.length === 0
    ? 0
    : 1,
);
