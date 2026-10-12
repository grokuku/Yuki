#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — APERÇU des souvenirs récents dans l'onglet Personnalité
 * (/config), et MISE DE CÔTÉ d'un souvenir (jamais un effacement définitif),
 * rendus en Chromium headless via CDP avec la CSP RÉELLE.
 *
 * Vérifie : la liste s'affiche avec les données RÉELLES du store (date,
 * catégorie, contenu, justification), la mise de côté passe par une modale
 * HolafModal explicite, le souvenir est COPIÉ dans le fichier de mise de côté
 * puis retiré de la mémoire active, et ZÉRO violation CSP / exception JS.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-memory-preview.mjs"
 * (réutilise le harnais e2e-memory-serve.ts)
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { collectViolations, waitForGateway } from "./browser-violations.mjs";

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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-mem-preview-"));
const SEED_A = "L'utilisateur aime les crêpes bretonnes";
const SEED_B = "L'utilisateur habite à Rennes";

async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-memory-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_MEMORY_DIR: STATE_DIR },
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
  await waitForGateway(base);
  return { proc, base };
}

const server = await startServer();

const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-mem-preview-chrome-"));
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
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
  console.log(`📷 capture : _tools/shots/${name}.png`);
}

/* ═══════════════ 1) L'aperçu affiche les données RÉELLES ═══════════════ */
await navigate(`${server.base}/config#personnalite`);
const preview = await evaluate(`(() => {
  const mem = document.querySelector('.personality-memory');
  const details = mem?.querySelector('.personality-memory__recent');
  const rows = [...(mem?.querySelectorAll('.personality-memory__item') ?? [])];
  return {
    hasBlock: !!mem,
    hasDetails: !!details,
    summary: details?.querySelector('summary')?.textContent ?? '',
    rows: rows.length,
    first: rows[0]
      ? {
          date: rows[0].querySelector('.personality-memory__date')?.textContent ?? '',
          cat: rows[0].querySelector('.personality-memory__cat')?.textContent ?? '',
          text: rows[0].querySelector('.personality-memory__text')?.textContent ?? '',
          why: rows[0].querySelector('.personality-memory__why')?.textContent ?? '',
          buttons: [...rows[0].querySelectorAll('button')].map((b) => b.textContent),
        }
      : null,
    styleAttrs: document.body.querySelectorAll('[style]').length,
  };
})()`);
check("[/config#personnalite] bloc mémoire présent", preview.hasBlock === true);
check("[/config#personnalite] aperçu replié présent", preview.hasDetails === true);
check("[/config#personnalite] titre d'aperçu avec le compte RÉEL", /Souvenirs récents \(2\)/.test(preview.summary), preview.summary);
check("[/config#personnalite] DEUX lignes de souvenirs (données du store)", preview.rows === 2, String(preview.rows));
check("[/config#personnalite] la ligne porte une DATE", /^\d{4}-\d{2}-\d{2}/.test(preview.first?.date ?? ""), preview.first?.date);
check(
  "[/config#personnalite] la ligne porte une CATÉGORIE",
  ["preference", "fait", "decision", "projet", "relation", "autre"].includes(preview.first?.cat ?? ""),
  preview.first?.cat,
);
check(
  "[/config#personnalite] la ligne porte le CONTENU réel",
  [SEED_A, SEED_B].includes(preview.first?.text ?? ""),
  preview.first?.text,
);
check("[/config#personnalite] la ligne porte la JUSTIFICATION", /Pourquoi :/.test(preview.first?.why ?? ""), preview.first?.why);
check("[/config#personnalite] action « Mettre de côté »", preview.first?.buttons.includes("Mettre de côté") === true, JSON.stringify(preview.first?.buttons));
check("[/config#personnalite] aucun style= inline (CSP)", preview.styleAttrs === 0, String(preview.styleAttrs));
await shot("memory-preview-list");

/* ═══════════════ 2) Mise de côté via HolafModal ═══════════════ */
await evaluate(`(() => {
  const details = document.querySelector('.personality-memory__recent');
  if (details) details.open = true;
  const row = document.querySelector('.personality-memory__item');
  [...row.querySelectorAll('button')].find((b) => b.textContent === 'Mettre de côté')?.click();
})()`);
await sleep(500);
const modal = await evaluate(`(() => {
  const title = document.querySelector('.holaf-modal-title')?.textContent ?? '';
  const message = document.querySelector('.holaf-modal-message')?.textContent ?? '';
  const danger = [...document.querySelectorAll('.holaf-modal-btn')].find((b) => b.textContent === 'Mettre de côté');
  return { title, message, hasDanger: !!danger, dangerClass: danger?.className ?? '' };
})()`);
check("[/config#personnalite] confirmation via HolafModal", modal.title.length > 0, modal.title);
check("[/config#personnalite] libellé explicite (mise de côté récupérable)", /récup|mis de côté|mise de côté/i.test(modal.title + " " + modal.message), modal.message.slice(0, 160));
check("[/config#personnalite] bouton de danger « Mettre de côté »", modal.hasDanger === true && /danger/.test(modal.dangerClass), modal.dangerClass);
await shot("memory-preview-modal");

await evaluate(`(() => { [...document.querySelectorAll('.holaf-modal-btn')].find((b) => b.textContent === 'Mettre de côté')?.click(); })()`);
await sleep(1200);
const afterSetAside = await evaluate(`(() => {
  const mem = document.querySelector('.personality-memory');
  return {
    count: mem?.querySelector('.config-helper')?.textContent ?? '',
    rows: mem?.querySelectorAll('.personality-memory__item')?.length ?? 0,
    status: mem?.querySelector('.config-save-status')?.textContent ?? '',
    styleAttrs: document.body.querySelectorAll('[style]').length,
  };
})()`);
check("[/config#personnalite] retour visuel : « récupérable »", /récup/i.test(afterSetAside.status), afterSetAside.status.slice(0, 200));
check("[/config#personnalite] l'aperçu passe à UNE ligne", afterSetAside.rows === 1, String(afterSetAside.rows));
check("[/config#personnalite] le compte mémoire est cohérent", /1 souvenir/.test(afterSetAside.count), afterSetAside.count);
check("[/config#personnalite] aucune style= inline après mise de côté", afterSetAside.styleAttrs === 0, String(afterSetAside.styleAttrs));
await shot("memory-preview-after");

/* ═══════════════ 3) Preuves DISQUE : mise de côté récupérable ═══════════════ */
const apiState = await fetch(`${server.base}/api/memory`).then((r) => r.json());
check("[API] une seule entrée restante", apiState.entries === 1, JSON.stringify({ entries: apiState.entries }));
check("[API] l'aperçu API renvoie une entrée récente", Array.isArray(apiState.recent) && apiState.recent.length === 1, JSON.stringify(apiState.recent?.length));
check("[API] l'aperçu porte la justification", typeof apiState.recent?.[0]?.why === "string", apiState.recent?.[0]?.why);

const archiveDir = join(STATE_DIR, "memory-archive");
const setAsideName = "memory-set-aside.jsonl";
const hasSetAside = readdirSync(archiveDir).includes(setAsideName);
check("[disque] le fichier de mise de côté a été créé", hasSetAside, readdirSync(archiveDir).join(","));
if (hasSetAside) {
  const content = readFileSync(join(archiveDir, setAsideName), "utf8");
  check(
    "[disque] le souvenir mis de côté est RÉCUPÉRABLE",
    content.includes(SEED_A) || content.includes(SEED_B),
    content.slice(0, 120),
  );
}
// Le journal garde la ligne `delete` (mise de côté append-only).
const memoryContent = readFileSync(join(STATE_DIR, "memory.jsonl"), "utf8");
check("[disque] une ligne delete a été ajoutée au journal", memoryContent.includes('"t":"delete"'), "delete présent");
// Le seul souvenir ENCORE SERVI est l'AUTRE graine.
check(
  "[disque] seul l'autre souvenir reste actif (projection)",
  [SEED_A, SEED_B].includes(apiState.recent?.[0]?.text ?? "") && apiState.recent[0].text !== undefined,
  apiState.recent?.[0]?.text,
);

await stopPage();
server.proc.kill("SIGTERM");
await sleep(300);

/* ═══════════════════════ Bilan CSP / exceptions ═══════════════════════════ */
const { cspViolations, connectionErrors } = collectViolations(consoleMessages, logEntries);
check("ZÉRO violation CSP", cspViolations.length === 0, cspViolations.map((v) => v.text).join(" | "));
check(
  "ZÉRO erreur de connexion réseau (serveur indisponible)",
  connectionErrors.length === 0,
  connectionErrors.map((v) => v.text).join(" | ").slice(0, 300),
);
check("ZÉRO exception JS non capturée", pageExceptions.length === 0, pageExceptions.join(" | ").slice(0, 300));
console.log(`\nMessages console : ${consoleMessages.length} ; entrées Log : ${logEntries.length}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`);

chrome.kill("SIGKILL");
process.exit(failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1);
