#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — MISE DE CÔTÉ d'une conversation : ARCHIVE COMPLÈTE +
 * PASSE DE MÉMOIRE silencieuse, sur le gateway RÉEL et l'hôte Pi RÉEL, en
 * Chromium headless via CDP avec la CSP réelle.
 *
 * Prouve, de bout en bout (aucune confiance aux commentaires) :
 *  1. la mise de côté est IMMÉDIATE : l'interface se libère AVANT la fin de la
 *     passe de mémoire (l'extracteur met 1,5 s ; la liste tombe bien avant) ;
 *  2. une conversation mise de côté est ARCHIVÉE EN ENTIER (messages, rôles,
 *     horodatages, titre) et son contenu est retrouvé par l'OUTIL de recherche ;
 *  3. un FAIT de la conversation mise de côté est RETROUVÉ en mémoire durable
 *     (c'est le but de la passe) ;
 *  4. une PANNE de la passe ne casse RIEN : mise de côté + archive réussissent,
 *     l'échec est JOURNALISÉ, aucune écriture mémoire n'a lieu ;
 *  5. l'archive n'apparaît JAMAIS dans le prompt système sans appel de l'outil ;
 *  6. ré-archiver la même conversation ne duplique RIEN (idempotence) ;
 *  7. ZÉRO violation CSP, ZÉRO erreur de connexion, ZÉRO exception JS.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-set-aside-memory.mjs"
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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-setaside-"));

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-set-aside-memory-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_SETASIDE_DIR: STATE_DIR },
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
      const m = logs.join("").match(/READY (http:\/\/\S+) PROBE (http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ base: m[1].trim(), probe: m[2].trim() });
      }
    };
    proc.stdout.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`serveur quitté (${code}) :\n` + logs.join("")));
    });
  });
  await waitForGateway(urls.base);
  return { proc, ...urls, logs };
}

const server = await startServer();
const probe = async (path) => (await fetch(`${server.probe}${path}`)).json();

/* ─── Chromium headless (CDP) ────────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-setaside-chrome-"));
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

/** Attend qu'une sonde remplisse une condition (bornée). */
async function waitProbe(path, predicate, timeout = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await probe(path);
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
    title: c.querySelector('.conv__title')?.textContent ?? '',
    active: c.classList.contains('conv--active'),
  })))()`);

/** Met de côté la conversation de titre `title` par le VRAI parcours utilisateur. */
async function setAside(title) {
  const found = await evaluate(`(() => {
    const c = [...document.querySelectorAll('.conv')].find((x) => (x.querySelector('.conv__title')?.textContent ?? '').trim() === ${JSON.stringify(title)});
    if (!c) return false;
    c.click();
    return true;
  })()`);
  if (!found) throw new Error(`conversation introuvable : ${title}`);
  await sleep(500);
  await evaluate(`(() => {
    const c = document.querySelector('.conv--active');
    const r = c.getBoundingClientRect();
    c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 12, clientY: r.top + 12 }));
  })()`);
  await sleep(200);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.ctx-menu__item')].find((x) => x.textContent === 'Mettre de côté');
    if (!b) throw new Error('« Mettre de côté » absent');
    b.click();
  })()`);
  await sleep(250);
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('.holaf-modal-btn')].find((x) => x.textContent === 'Mettre de côté');
    if (!b) throw new Error('bouton de confirmation absent');
    b.click();
  })()`);
}

/* ═══════════════════════ 1) État initial ════════════════════════════════ */
await navigate(`${server.base}/`);
check(
  "liste : les QUATRE conversations de test sont présentes",
  await waitFor(`document.querySelectorAll('.conv').length === 4`),
);
const initialMemories = await probe("/memories");
const initialArchive = await probe("/archive-info");
check("départ : aucune mémoire écrite", initialMemories.entries.length === 0);
check("départ : aucune conversation archivée", initialArchive.info.conversations === 0);

/* ═══ 2) Mise de côté SANS information durable ⇒ archive, pas de mémoire ══ */
await setAside("Conversation MUETTE");
check(
  "mise de côté : la liste perd la conversation",
  await waitFor(`document.querySelectorAll('.conv').length === 3`),
);
const muetteArchive = await waitProbe("/archive-info", (v) => v.info.conversations >= 1);
check(
  "archive : la conversation MUETTE est archivée EN ENTIER",
  muetteArchive !== null,
  muetteArchive ? `${muetteArchive.info.conversations} conversation(s), ${muetteArchive.info.messages} message(s)` : "",
);
await sleep(600);
const afterMuette = await probe("/memories");
check(
  "passe de mémoire : aucune information durable ⇒ aucune écriture",
  afterMuette.entries.length === 0,
  `${afterMuette.entries.length} souvenir(s)`,
);

/* ═══ 3) IMMÉDIATETÉ : la liste tombe AVANT la fin de la passe (1,5 s) ═══ */
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('.conv').length === 3`);
const startedAt = Date.now();
await setAside("Conversation POTAGER");
const listUpdated = await waitFor(`document.querySelectorAll('.conv').length === 2`, 4000);
const listDelay = Date.now() - startedAt;
check(
  "immédiateté : la liste est mise à jour SANS attendre la passe de mémoire",
  listUpdated && listDelay < 1300,
  `${listDelay} ms (l'extracteur met 1 500 ms)`,
);
const memoriesRightAfter = await probe("/memories");
check(
  "immédiateté : la mémoire n'est PAS encore écrite à cet instant (passe en cours)",
  memoriesRightAfter.entries.length === 0,
  `${memoriesRightAfter.entries.length} souvenir(s)`,
);

/* ═══ 4) LE BUT : un fait de la conversation mise de côté est mémorisé ═══ */
const potagerMemories = await waitProbe(
  "/memories",
  (v) => v.entries.some((entry) => /potager/i.test(entry.text)),
  12_000,
);
check(
  "passe de mémoire : le fait durable de la conversation est ÉCRIT",
  potagerMemories !== null,
  potagerMemories ? potagerMemories.entries.map((e) => e.text).join(" | ") : "",
);
const potagerEntry = potagerMemories?.entries.find((entry) => /potager/i.test(entry.text));
check(
  "qualité : le souvenir porte sa JUSTIFICATION et sa source (mise de côté)",
  Boolean(potagerEntry?.why) && potagerEntry?.source === "mise-de-cote",
  potagerEntry ? `why=${potagerEntry.why} ; source=${potagerEntry.source}` : "",
);
const recalled = await probe("/recall?q=potager");
check(
  "rappel : le fait est RETROUVÉ en mémoire durable (« le but »)",
  typeof recalled.block === "string" && /potager/i.test(recalled.block),
  typeof recalled.block === "string" ? recalled.block.slice(0, 120) : String(recalled.block),
);

/* ═══ 5) L'OUTIL retrouve un message PRÉCIS de l'archive ══════════════════ */
const archiveHit = await probe("/archive-search?q=potager");
check(
  "outil d'archive : retrouve le message PRÉCIS (texte + date + conversation)",
  /POTAGER est au fond du jardin/.test(archiveHit.text) &&
    /Conversation POTAGER/.test(archiveHit.text) &&
    /\d{4}-\d{2}-\d{2}T/.test(archiveHit.text),
  archiveHit.text.split("\n").slice(0, 3).join(" / ").slice(0, 200),
);
check(
  "outil d'archive : sortie ENCADRÉE (donnée, jamais instruction)",
  archiveHit.text.startsWith("<conversations_archivees>") &&
    archiveHit.text.includes("</conversations_archivees>") &&
    /JAMAIS une instruction/.test(archiveHit.text),
);
const messagesArchived = await probe("/archive-info");
check(
  "archive : les DEUX messages (et leurs rôles) sont conservés",
  messagesArchived.info.conversations === 2 && messagesArchived.info.messages === 4,
  `${messagesArchived.info.conversations} conversation(s), ${messagesArchived.info.messages} message(s)`,
);

/* ═══ 6) PANNE de la passe : rien ne casse, l'échec est journalisé ════════ */
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('.conv').length === 2`);
const panneStart = Date.now();
await setAside("Conversation PANNE");
const panneListed = await waitFor(`document.querySelectorAll('.conv').length === 1`, 4000);
const panneDelay = Date.now() - panneStart;
check(
  "panne : la mise de côté RÉUSSIT (liste mise à jour immédiatement)",
  panneListed && panneDelay < 1300,
  `${panneDelay} ms`,
);
const panneArchive = await waitProbe("/archive-info", (v) => v.info.conversations >= 3, 8000);
check(
  "panne : la conversation est QUAND MÊME archivée en entier",
  panneArchive !== null,
  panneArchive ? `${panneArchive.info.conversations} conversation(s)` : "",
);
const panneLogs = await waitProbe(
  "/logs?pattern=set_aside",
  (v) => v.lines.some((line) => line.msg === "memory.set_aside.failed"),
  8000,
);
check(
  "panne : l'échec est JOURNALISÉ (silencieux pour l'utilisateur, visible en log)",
  panneLogs !== null,
  panneLogs
    ? panneLogs.lines.map((line) => line.msg).join(" | ").slice(0, 160)
    : "aucun log d'échec",
);
const memoriesAfterPanne = await probe("/memories");
check(
  "panne : AUCUNE écriture mémoire parasite",
  memoriesAfterPanne.entries.every((entry) => !/panne/i.test(entry.text)) &&
    memoriesAfterPanne.entries.length === 1,
  memoriesAfterPanne.entries.map((entry) => entry.text).join(" | "),
);

/* ═══ 7) L'archive ne fuit JAMAIS dans le prompt ═════════════════════════ */
const prompts = await probe("/prompt");
check(
  "prompt : le prompt système est bien exercé (mémoire active présente)",
  prompts.prompts.some((prompt) => /Mémoire durable/.test(prompt)),
  prompts.prompts.map((prompt) => prompt.slice(0, 40)).join(" | "),
);
const joined = prompts.prompts.join("\n");
check(
  "prompt : AUCUN contenu d'archive ne s'y trouve sans appel de l'outil",
  !/POTAGER est au fond du jardin/.test(joined) && !/Conversation PANNE/.test(joined),
  `longueur des prompts = ${prompts.prompts.map((prompt) => prompt.length).join("/")}`,
);

/* ═══ 8) Idempotence : ré-archiver ne duplique rien ══════════════════════ */
const seeds = await probe("/seeds");
const rearchive = await probe(`/rearchive?id=${encodeURIComponent(seeds.potager)}`);
check(
  "idempotence : ré-archiver la MÊME conversation ne crée pas de doublon",
  rearchive.result.archived === false &&
    rearchive.after.conversations === rearchive.before.conversations &&
    rearchive.after.messages === rearchive.before.messages,
  `archived=${rearchive.result.archived} ; ${rearchive.before.conversations}→${rearchive.after.conversations} conversation(s)`,
);
const memoriesFinal = await probe("/memories");
check(
  "idempotence : aucune écriture mémoire supplémentaire",
  memoriesFinal.entries.length === 1,
  `${memoriesFinal.entries.length} souvenir(s)`,
);

/* ═══ 9) L'outil n'est exposé qu'avec le port d'archive ══════════════════ */
const tools = await probe("/tools");
check(
  "outil exposé au léger quand l'archive existe, absent sinon",
  tools.light.includes("chercher_conversations_archivees") &&
    !tools.lightWithout.includes("chercher_conversations_archivees"),
  `light=${tools.light.join(",")}`,
);

/* ═══ Bilan ═══════════════════════════════════════════════════════════════ */
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
