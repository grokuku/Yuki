#!/usr/bin/env node
/**
 * Harnais E2E JETABLE (hors dépôts) — RELEVÉ EXHAUSTIF des variables de thème.
 *
 * Pour les 10 combinaisons (5 familles × 2 modes), sur les DEUX pages du
 * gateway (/ et /config), relève par `getComputedStyle(documentElement)` :
 *   --bg --panel --panel-2 --border --text --muted --accent --danger
 *   --user --assistant --ok  +  color-scheme
 * et écrit le résultat en JSON. Sert à PROUVER le zéro-changement visuel :
 * on exécute ce harnais AVANT puis APRÈS la migration, et on diffe les deux
 * relevés.
 *
 * Usage : node "../Yuki and Libs/_tools/e2e-theme-snapshot.mjs" <baseUrl> <out.json>
 * Prérequis : gateway lancé par _tools/e2e-serve.ts.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const BASE = process.argv[2] || "http://127.0.0.1:4173";
const OUT = process.argv[3] || join(import.meta.dirname, "theme-snapshot.json");

const FAMILIES = ["indigo", "midnight", "slate", "emerald", "amber"];
const MODES = ["light", "dark"];
const PRESETS = FAMILIES.flatMap((f) => MODES.map((m) => `${f}-${m}`));

const VARS = [
  "--bg", "--panel", "--panel-2", "--border", "--text", "--muted",
  "--accent", "--danger", "--user", "--assistant", "--ok",
];

/* ─── Chromium headless + CDP ───────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-snap-"));
const chrome = spawn("/usr/bin/chromium", [
  "--headless", "--no-sandbox", "--disable-gpu", "--no-first-run",
  "--no-default-browser-check", `--user-data-dir=${profileDir}`,
  "--remote-debugging-port=0", "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const timer = setTimeout(() => reject(new Error("DevTools WS introuvable (timeout)")), 15000);
  chrome.stderr.on("data", (d) => {
    buf += d.toString();
    const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
    if (m) { clearTimeout(timer); resolve(m[1]); }
  });
  chrome.on("exit", (code) => reject(new Error("chromium a quitté : " + code)));
});

const list = await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list")).then((r) => r.json());
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("aucune cible page");
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

let seq = 0;
const pending = new Map();
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

async function navigate(url) {
  const loaded = new Promise((resolve) => {
    const h = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.method === "Page.loadEventFired") { ws.off("message", h); resolve(); }
    };
    ws.on("message", h);
  });
  await send("Page.navigate", { url });
  await loaded;
  await new Promise((r) => setTimeout(r, 250));
}
async function evaluate(expression) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (res.exceptionDetails) throw new Error("eval: " + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails));
  return res.result.value;
}

const READ = `(() => {
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const v of ${JSON.stringify(VARS)}) out[v] = cs.getPropertyValue(v).trim().toLowerCase();
  out["color-scheme"] = cs.getPropertyValue("color-scheme").trim();
  return out;
})()`;

const snapshot = { base: BASE, pages: {} };
for (const path of ["/", "/config"]) {
  const key = path === "/" ? "index" : "config";
  snapshot.pages[key] = {};
  // Charge une fois pour pouvoir écrire localStorage sur la bonne origine.
  await navigate(BASE + path);
  for (const preset of PRESETS) {
    await evaluate(`localStorage.setItem("yuki-theme", ${JSON.stringify(preset)})`);
    await navigate(BASE + path);
    const state = await evaluate(`({ dataTheme: document.documentElement.getAttribute("data-theme"), vars: ${READ} })`);
    snapshot.pages[key][preset] = { dataTheme: state.dataTheme, vars: state.vars };
  }
}

writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
console.log(`Relevé écrit : ${OUT} (${PRESETS.length} presets × ${Object.keys(snapshot.pages).length} pages)`);
chrome.kill("SIGKILL");
process.exit(0);
