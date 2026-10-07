#!/usr/bin/env node
/**
 * Harnais E2E JETABLE (hors dépôts) — captures des ICÔNES INTÉGRÉES à la
 * brique `icons` (v0.1.5) : flèche retour (topbar /config), haut-parleur /
 * barré (topbar /), bascule soleil/lune — sur plusieurs familles × modes.
 *
 * Preuve visuelle « après intégration » (complément du comparatif
 * icons-compare-feather-vs-lucide.png qui documente LE DELTA de tracé).
 *
 * Usage : node "../Yuki and Libs/_tools/icons-integrated-shots.mjs" <baseUrl>
 * Prérequis : gateway lancé par _tools/e2e-serve.ts.
 * Sortie : _tools/shots/icons-integrated-<page>-<famille>-<mode>.png
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const BASE = process.argv[2] || "http://127.0.0.1:4173";
const SHOTS = join(import.meta.dirname, "shots");
mkdirSync(SHOTS, { recursive: true });

const COMBOS = ["amethyste-dark", "amethyste-light", "emeraude-dark", "emeraude-light"];

const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-icons-"));
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
async function shotClip(name, clip) {
  const res = await send("Page.captureScreenshot", { format: "png", clip });
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
  console.log(`📷 ${name}.png`);
}

await navigate(BASE + "/");
for (const path of ["/", "/config"]) {
  const pageName = path === "/" ? "index" : "config";
  for (const preset of COMBOS) {
    await evaluate(`localStorage.setItem("yuki-theme", ${JSON.stringify(preset)})`);
    await navigate(BASE + path);
    // Vérifie que les icônes sont bien rendues (SVG présents) avant capture.
    const counts = await evaluate(`({
      svgs: document.querySelectorAll("svg.icon").length,
      volume: !!document.querySelector(".icon--volume"),
      volumeOff: !!document.querySelector(".icon--volume-off"),
      arrow: !!document.querySelector(".icon--arrow-left"),
      sun: !!document.querySelector(".icon--sun"),
    })`);
    console.log(`   ${pageName} ${preset} →`, JSON.stringify(counts));
    await shotClip(`icons-integrated-${pageName}-${preset}`, {
      x: 0, y: 0, width: 1280, height: 58, scale: 2,
    });
  }
}

chrome.kill("SIGKILL");
process.exit(0);
