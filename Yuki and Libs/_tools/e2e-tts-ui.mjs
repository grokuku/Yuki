#!/usr/bin/env node
/**
 * Harnais E2E JETABLE (hors dépôts) — UI TTS de Yuki (Lot C).
 *
 * Lance le gateway RÉEL avec l'API voix + config (`_tools/e2e-tts-serve.ts`),
 * puis rend les pages `/` et `/config` en Chromium headless via CDP avec la CSP
 * RÉELLE. Vérifie : contrôle voix de la topbar, panneau des voix (API réelle),
 * révélation des curseurs d'émotion, modale de clonage HolafModal, et
 * **zéro violation CSP**.
 *
 * ⚠️ La sortie audio n'est PAS vérifiable en headless (pas de périphérique) :
 * on vérifie que le CHEMIN Web Audio est câblé (aucune balise `<audio>`,
 * décodeur présent), pas le son réel.
 *
 * Usage : node "../Yuki and Libs/_tools/e2e-tts-ui.mjs"
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
const serverLog = [];
const server = spawn(TSX, [join(TOOLS, "e2e-tts-serve.ts")], {
  cwd: YUKI_DIR,
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => serverLog.push(d.toString()));
server.stderr.on("data", (d) => serverLog.push(d.toString()));

const BASE = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    reject(new Error("gateway de test non démarré :\n" + serverLog.join("")));
  }, 30_000);
  const onData = () => {
    const text = serverLog.join("");
    const match = text.match(/READY (http:\/\/\S+)/);
    if (match) {
      clearTimeout(timer);
      resolve(match[1].trim());
    }
  };
  server.stdout.on("data", onData);
  server.on("exit", (code) => {
    clearTimeout(timer);
    reject(new Error("gateway de test quitté (" + code + ") :\n" + serverLog.join("")));
  });
});
console.log(`Gateway de test : ${BASE}`);

/* ─── Chromium headless (CDP) ───────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-tts-chrome-"));
const chrome = spawn("/usr/bin/chromium", [
  "--headless",
  "--no-sandbox",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  `--user-data-dir=${profileDir}`,
  "--remote-debugging-port=0",
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const wsUrl = await new Promise((resolve, reject) => {
  let buf = "";
  const timer = setTimeout(() => reject(new Error("DevTools WS introuvable (timeout)")), 15000);
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

const list = await fetch(
  wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"),
).then((r) => r.json());
const page = list.find((t) => t.type === "page");
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
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method === "Runtime.consoleAPICalled") {
    const text = (msg.params.args || [])
      .map((a) => a.value ?? a.description ?? "")
      .join(" ");
    consoleMessages.push({ type: msg.params.type, text });
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
  return new Promise((resolve, reject) =>
    pending.set(id, { resolve, reject }),
  );
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
  });
  await send("Page.navigate", { url });
  await loaded;
  await sleep(500); // modules ES + fetch de config
}

async function evaluate(expression, awaitPromise = false) {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (res.exceptionDetails) {
    throw new Error(
      "eval: " +
        JSON.stringify(
          res.exceptionDetails.exception?.description || res.exceptionDetails,
        ),
    );
  }
  return res.result.value;
}

async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
  console.log(`📷 capture : _tools/shots/${name}.png`);
}

/* ═══════════════════════ Page chat `/` ═══════════════════════════════════ */
console.log("\n═══ PAGE / (chat) ═══");
await navigate(BASE + "/");
await evaluate("localStorage.clear()");
await navigate(BASE + "/");

const READ_CHAT = `(() => {
  const t = document.getElementById("tts-toggle");
  const s = document.getElementById("tts-status");
  let stored = null;
  try { stored = localStorage.getItem("yuki-tts-muted"); } catch {}
  return {
    hasToggle: !!t,
    pressed: t ? t.getAttribute("aria-pressed") : null,
    label: t ? t.getAttribute("aria-label") : null,
    icon: t ? t.textContent : null,
    title: t ? t.title : null,
    className: t ? t.className : null,
    statusHidden: s ? s.hidden : null,
    statusText: s ? s.textContent : null,
    stored,
    audioTags: document.querySelectorAll("audio").length,
    styleElems: document.querySelectorAll("style").length,
    styleAttrs: document.querySelectorAll("[style]").length,
  };
})()`;

let s = await evaluate(READ_CHAT);
check("[/] contrôle voix présent dans la topbar", s.hasToggle);
check(
  "[/] serveur TTS on + non sourd → bouton pressé, icône 🔊, libellé « couper »",
  s.pressed === "true" && s.icon === "🔊" && /couper/i.test(s.label),
  `pressed=${s.pressed} icon=${s.icon} label=${s.label}`,
);

await evaluate(`document.getElementById("tts-toggle").click()`);
await sleep(150);
s = await evaluate(READ_CHAT);
check(
  "[/] clic → sourdine locale persistée (localStorage) + bouton non pressé",
  s.pressed === "false" && s.stored === "1" && s.statusHidden === false,
  `pressed=${s.pressed} stored=${s.stored} status=${JSON.stringify(s.statusText)}`,
);

await evaluate(`document.getElementById("tts-toggle").click()`);
await sleep(150);
s = await evaluate(READ_CHAT);
check(
  "[/] second clic → voix réactivée (persistance écrite)",
  s.pressed === "true" && s.stored === "0",
  `pressed=${s.pressed} stored=${s.stored}`,
);

check("[/] aucune balise <audio> (Web Audio obligatoire)", s.audioTags === 0, `audio=${s.audioTags}`);
check("[/] zéro <style> injecté et zéro attribut style", s.styleElems === 0 && s.styleAttrs === 0,
  `style=${s.styleElems} attrs=${s.styleAttrs}`);
await shot("chat-tts-toggle");

/* ═══════════════════════ Page /config ════════════════════════════════════ */
console.log("\n═══ PAGE /config ═══");
await navigate(BASE + "/config");

const READ_CONFIG = `(() => {
  const root = document.getElementById("voices-root");
  const select = document.getElementById("voices-select");
  const rows = [...document.querySelectorAll(".voices-row")].map((r) => ({
    label: r.querySelector(".voices-row__label")?.textContent,
    badges: [...r.querySelectorAll(".badge")].map((b) => b.textContent),
    buttons: [...r.querySelectorAll("button")].map((b) => b.textContent),
  }));
  const options = select ? [...select.options].map((o) => ({ value: o.value, text: o.textContent })) : [];
  return {
    hasRoot: !!root,
    hasSelect: !!select,
    options,
    rows,
    audioTags: document.querySelectorAll("audio").length,
    styleElems: document.querySelectorAll("style").length,
    styleAttrs: document.querySelectorAll("[style]").length,
  };
})()`;

s = await evaluate(READ_CONFIG);
check("[/config] racine du panneau des voix présente", s.hasRoot && s.hasSelect);
check(
  "[/config] le sélecteur inclut la voix par défaut + le preset du registre",
  s.options.some((o) => o.value === "") && s.options.some((o) => o.value === "camille"),
  JSON.stringify(s.options),
);
check(
  "[/config] la liste montre le preset avec badge « prédéfinie » et bouton « Écouter »",
  s.rows.length >= 1 &&
    s.rows[0].label === "Camille (FR)" &&
    s.rows[0].badges.includes("prédéfinie") &&
    s.rows[0].buttons.includes("Écouter"),
  JSON.stringify(s.rows),
);
check("[/config] aucune balise <audio> (Web Audio obligatoire)", s.audioTags === 0);
check("[/config] zéro <style> injecté et zéro attribut style (avant modale)",
  s.styleElems === 0 && s.styleAttrs === 0, `style=${s.styleElems} attrs=${s.styleAttrs}`);

/* — Sélection de la voix active → PUT /api/config { tts.voice } — */
await evaluate(`(() => {
  const sel = document.getElementById("voices-select");
  sel.value = "camille";
  sel.dispatchEvent(new Event("change"));
})()`);
await sleep(600);
const savedVoice = await evaluate(
  `fetch("/api/config").then((r) => r.json()).then((b) => b.fields["tts.voice"].value)`,
  true,
);
check(
  "[/config] choisir une voix écrit tts.voice côté serveur (PUT /api/config)",
  savedVoice === "camille",
  `tts.voice=${JSON.stringify(savedVoice)}`,
);

/* — Révélation des curseurs d'émotion (« personnalisee ») — */
const emotionReveal = await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#groups .config-row")];
  const byLabel = (label) => rows.find((r) => r.querySelector(".config-label")?.textContent?.includes(label));
  const emotion = byLabel("Émotion")?.querySelector("select");
  const before = { exag: byLabel("Exagération")?.hidden, cfg: byLabel("CFG")?.hidden };
  if (emotion) {
    emotion.value = "personnalisee";
    emotion.dispatchEvent(new Event("input"));
    emotion.dispatchEvent(new Event("change"));
  }
  const after = { exag: byLabel("Exagération")?.hidden, cfg: byLabel("CFG")?.hidden };
  if (emotion) {
    emotion.value = "neutre";
    emotion.dispatchEvent(new Event("input"));
    emotion.dispatchEvent(new Event("change"));
  }
  const back = { exag: byLabel("Exagération")?.hidden, cfg: byLabel("CFG")?.hidden };
  return { before, after, back };
})()`);
check(
  "[/config] émotion=custom révèle les curseurs exaggeration/CFG, puis les masque",
  emotionReveal.before.exag === true &&
    emotionReveal.after.exag === false &&
    emotionReveal.after.cfg === false &&
    emotionReveal.back.exag === true,
  JSON.stringify(emotionReveal),
);

/* — Modale de clonage (HolafModal) — */
await evaluate(`(() => {
  const btn = [...document.querySelectorAll("#voices-root button")].find((b) => b.textContent === "Cloner une voix");
  btn?.click();
})()`);
await sleep(250);
let modal = await evaluate(`(() => ({
  open: !!document.querySelector(".holaf-modal-root"),
  hasFile: !!document.querySelector(".holaf-modal-root input[type=file]"),
  hasLabel: !!document.querySelector(".holaf-modal-root input[type=text]"),
  inlineStyles: document.querySelectorAll(".holaf-modal-root [style]").length,
}))()`);
check(
  "[/config] « Cloner une voix » ouvre une modale HolafModal avec champ fichier + libellé",
  modal.open && modal.hasFile && modal.hasLabel,
  JSON.stringify(modal),
);

/* Créer sans fichier → le guard refuse, la modale RESTE ouverte. */
await evaluate(`document.querySelector(".holaf-modal-btn-primary")?.click()`);
await sleep(300);
const afterGuard = await evaluate(`(() => ({
  open: !!document.querySelector(".holaf-modal-root"),
  message: document.querySelector(".holaf-modal-root .config-helper[role=status]")?.textContent ?? "",
}))()`);
check(
  "[/config] création sans fichier → refus explicite, modale maintenue ouverte",
  afterGuard.open && /Fichier WAV requis/.test(afterGuard.message),
  JSON.stringify(afterGuard),
);
await shot("config-clone-modal");

/* Fermer proprement. */
await evaluate(`document.querySelector(".holaf-modal-btn-cancel")?.click()`);
await sleep(200);
const closed = await evaluate(`!document.querySelector(".holaf-modal-root")`);
check("[/config] la modale se ferme (Annuler)", closed === true);

/* ═══════════════════════ Bilan CSP ═══════════════════════════════════════ */
const cspViolations = [
  ...consoleMessages.filter((m) => /refused|content security policy|csp/i.test(m.text)),
  ...logEntries.filter(
    (e) =>
      /refused|content security policy|csp/i.test(e.text) || e.source === "security",
  ),
];
console.log(
  `\nMessages console : ${consoleMessages.length} ; entrées Log : ${logEntries.length}`,
);
for (const m of consoleMessages.slice(0, 12)) {
  console.log("  console:", m.type, JSON.stringify(m.text.slice(0, 200)));
}
for (const e of logEntries.slice(0, 12)) {
  console.log("  log:", e.source, e.level, JSON.stringify(e.text.slice(0, 200)));
}
check(
  "ZÉRO violation CSP (aucun « Refused… » ni entrée security)",
  cspViolations.length === 0,
  cspViolations.map((v) => v.text).join(" | "),
);

const failed = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} vérifications OK ; ` +
    `violations CSP = ${cspViolations.length} ═══`,
);

chrome.kill("SIGKILL");
server.kill("SIGTERM");
process.exit(
  failed.length === 0 && cspViolations.length === 0 ? 0 : 1,
);
