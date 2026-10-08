#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — section « Vie antérieure » de l'onglet Personnalité
 * (/config), rendue en Chromium headless via CDP avec la CSP RÉELLE.
 *
 * Vérifie : la section s'affiche (distincte), le rappel visible, l'AJOUT d'une
 * entrée, l'ÉDITION + enregistrement, la MISE DE CÔTÉ (modale HolafModal explicite,
 * récupérable dans deleted/), l'étiquette réappliquée sur disque, la mémoire
 * courante JAMAIS touchée, et ZÉRO violation CSP / exception JS.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-heritage.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-heritage-"));
const HERITAGE_DIR = join(STATE_DIR, "memory-heritage");
const SEED_MEMORY = "L'utilisateur aime les crêpes bretonnes";
const ADD_TITRE = "Rêves d'Islande";
const ADD_SLUG = "reves-d-islande";

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-heritage-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_HERITAGE_DIR: STATE_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString()));
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("serveur non démarré :\n" + logs.join(""))), 30_000);
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
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-heritage-chrome-"));
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
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1400, deviceScaleFactor: 1, mobile: false });

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
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error("eval: " + (res.exceptionDetails.exception?.description || "exception"));
  }
  return res.result.value;
}

async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
  console.log(`📷 capture : _tools/shots/${name}.png`);
}

const heritageState = () =>
  evaluate(`(() => {
    const s = document.querySelector('.personality-heritage');
    const rows = [...(s?.querySelectorAll('.personality-heritage__item') ?? [])];
    return {
      hasSection: !!s,
      title: s?.querySelector('.personality-heritage__title')?.textContent ?? '',
      help: s?.querySelector('.personality-heritage__help')?.textContent ?? '',
      hasEditor: !!s?.querySelector('.personality-heritage__editor'),
      titles: rows.map((r) => r.querySelector('.personality-heritage__titre')?.textContent ?? ''),
      counts: s?.querySelector('.config-helper')?.textContent ?? '',
      status: s?.querySelector('.config-save-status')?.textContent ?? '',
      styleAttrs: document.body.querySelectorAll('[style]').length,
    };
  })()`);

function clickHeritage(text) {
  return evaluate(
    `(() => { const b = [...document.querySelectorAll('.personality-heritage button')].find((x) => x.textContent === ${JSON.stringify(text)}); if (!b) throw new Error('bouton introuvable: ' + ${JSON.stringify(text)}); b.click(); })()`,
  );
}

function clickRow(title, text) {
  return evaluate(`(() => {
    const rows = [...document.querySelectorAll('.personality-heritage__item')];
    const row = rows.find((r) => r.querySelector('.personality-heritage__titre')?.textContent === ${JSON.stringify(title)});
    if (!row) throw new Error('ligne introuvable: ' + ${JSON.stringify(title)});
    const b = [...row.querySelectorAll('button')].find((x) => x.textContent === ${JSON.stringify(text)});
    if (!b) throw new Error('bouton introuvable dans la ligne');
    b.click();
  })()`);
}

function fillEditor(titre, categorie, texte) {
  return evaluate(`(() => {
    const editor = document.querySelector('.personality-heritage__editor');
    if (!editor) throw new Error('éditeur introuvable');
    const inputs = editor.querySelectorAll('input');
    inputs[0].value = ${JSON.stringify(titre)};
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1].value = ${JSON.stringify(categorie)};
    inputs[1].dispatchEvent(new Event('input', { bubbles: true }));
    const ta = editor.querySelector('textarea');
    ta.value = ${JSON.stringify(texte)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

/* ═══════════════════════ 1) Section affichée, distincte ══════════════════ */
await navigate(`${server.base}/config#personnalite`);
const initial = await heritageState();
check("[/config#personnalite] section « Vie antérieure » présente", initial.hasSection === true);
check("[/config#personnalite] titre « Vie antérieure »", initial.title === "Vie antérieure", initial.title);
check("[/config#personnalite] rappel : archive jamais fusionnée", /JAMAIS fusionnée/i.test(initial.help) && /vie antérieure/i.test(initial.help), initial.help.slice(0, 160));
check("[/config#personnalite] rappel : lecture seule du modèle", /lecture seule/i.test(initial.help), initial.help.slice(0, 200));
check("[/config#personnalite] une entrée de départ listée", initial.titles.includes("Identité (SOUL.md)"), JSON.stringify(initial.titles));
check("[/config#personnalite] aucune style= inline (CSP)", initial.styleAttrs === 0, String(initial.styleAttrs));
await shot("heritage-e2e-block");

/* ═══════════════════════════ 2) AJOUT d'une entrée ═══════════════════════ */
await clickHeritage("Ajouter une entrée");
await sleep(300);
const addOpen = await heritageState();
check("[/config#personnalite] l'éditeur d'ajout s'ouvre", addOpen.hasEditor === true);
await fillEditor(ADD_TITRE, "reves", "Voir les aurores boréales.");
await clickHeritage("Ajouter à l'archive");
await sleep(900);
const afterAdd = await heritageState();
check("[/config#personnalite] l'entrée ajoutée apparaît", afterAdd.titles.includes(ADD_TITRE), JSON.stringify(afterAdd.titles));
const addedFile = join(HERITAGE_DIR, "entries", `${ADD_SLUG}.json`);
const addedRaw = readFileSync(addedFile, "utf8");
check("[disque] l'entrée ajoutée porte l'étiquette « ne pas fusionner »", addedRaw.includes("vie antérieure — ne pas fusionner"));
check("[disque] l'entrée ajoutée porte la provenance Yuki-old/OpenClaw", addedRaw.includes("Yuki-old") && addedRaw.includes("OpenClaw"));
await shot("heritage-e2e-add");

/* ═══════════════════════ 3) ÉDITION + enregistrement ═════════════════════ */
await clickRow("Identité (SOUL.md)", "Éditer");
await sleep(800);
const editOpen = await heritageState();
check("[/config#personnalite] l'éditeur s'ouvre sur l'entrée", editOpen.hasEditor === true);
await fillEditor("Identité (SOUL.md)", "identite", "SOUL modifié via l'interface.");
await clickHeritage("Enregistrer");
await sleep(900);
const entriesDir = join(HERITAGE_DIR, "entries");
const entryContents = readdirSync(entriesDir).map((name) => readFileSync(join(entriesDir, name), "utf8"));
const edited = entryContents.find((content) => content.includes("SOUL modifié via l'interface."));
check("[disque] l'édition est écrite", Boolean(edited));
check("[disque] l'étiquette est RÉAPPLIQUÉE à l'édition", Boolean(edited) && edited.includes("vie antérieure — ne pas fusionner"));
await shot("heritage-e2e-edit");

/* ═══════════════════════ 4) MISE DE CÔTÉ (modale) ════════════════════════ */
await clickRow(ADD_TITRE, "Mettre de côté");
await sleep(500);
const modal = await evaluate(`(() => {
  const title = document.querySelector('.holaf-modal-title')?.textContent ?? '';
  const message = document.querySelector('.holaf-modal-message')?.textContent ?? '';
  const confirm = [...document.querySelectorAll('.holaf-modal-btn')].find((b) => b.textContent === 'Mettre de côté');
  return { title, message, hasConfirm: !!confirm, cls: confirm?.className ?? '' };
})()`);
check("[/config#personnalite] confirmation via HolafModal (pas window.confirm)", modal.title.length > 0, modal.title);
check("[/config#personnalite] libellé explicite (récupérable, deleted/)", /deleted/.test(modal.message) && /récupérable/i.test(modal.message), modal.message.slice(0, 200));
check("[/config#personnalite] bouton de danger « Mettre de côté »", modal.hasConfirm && /danger/.test(modal.cls), modal.cls);
await shot("heritage-e2e-modal");
await evaluate(`(() => { [...document.querySelectorAll('.holaf-modal-btn')].find((b) => b.textContent === 'Mettre de côté')?.click(); })()`);
await sleep(1200);
const afterDelete = await heritageState();
check("[/config#personnalite] l'entrée retirée n'est plus listée", !afterDelete.titles.includes(ADD_TITRE), JSON.stringify(afterDelete.titles));
check("[disque] l'entrée est MISE DE CÔTÉ (deleted/), pas détruite", readdirSync(join(HERITAGE_DIR, "deleted")).length === 1);
await shot("heritage-e2e-after");

/* ═══════════ 5) RÈGLE CARDINALE : mémoire courante INTOUCHÉE ══════════════ */
const memory = readFileSync(join(STATE_DIR, "memory.jsonl"), "utf8");
check("[disque] la mémoire courante contient toujours son souvenir", memory.includes(SEED_MEMORY));
check("[disque] la mémoire courante ne contient RIEN de l'archive", !memory.includes("SOUL") && !memory.includes(ADD_TITRE) && !memory.includes("aurores"));
check("[disque] aucun fichier d'archive dans memory.jsonl (isolé)", readdirSync(STATE_DIR).includes("memory.jsonl") && readdirSync(STATE_DIR).includes("memory-heritage"));

server.proc.kill("SIGTERM");
await sleep(300);

/* ═══════════════════════ Bilan CSP / exceptions ═══════════════════════════ */
const cspViolations = [
  ...consoleMessages.filter((m) => /refused|content security policy|csp/i.test(m.text)),
  ...logEntries.filter((e) => /refused|content security policy|csp/i.test(e.text) || e.source === "security"),
];
check("ZÉRO violation CSP", cspViolations.length === 0, cspViolations.map((v) => v.text).join(" | "));
check("ZÉRO exception JS non capturée", pageExceptions.length === 0, pageExceptions.join(" | ").slice(0, 300));
console.log(`\nMessages console : ${consoleMessages.length} ; entrées Log : ${logEntries.length}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`);

chrome.kill("SIGKILL");
process.exit(failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1);
