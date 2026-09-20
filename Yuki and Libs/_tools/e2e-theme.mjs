#!/usr/bin/env node
/**
 * Harnais E2E JETABLE (hors dépôts) — rendu headless Chromium via CDP.
 * Vérifie le comportement RÉEL du thème à deux axes sur les deux pages du
 * gateway : application des 10 combinaisons, indépendance famille/mode des
 * deux contrôles, persistance, migration de l'ancienne clé, zéro violation
 * CSP. Produit aussi des captures d'écran.
 *
 * Usage : node "../Yuki and Libs/_tools/e2e-theme.mjs" <baseUrl>
 * Prérequis : gateway lancé par _tools/e2e-serve.ts.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const BASE = process.argv[2] || "http://127.0.0.1:4173";
const SHOTS = join(import.meta.dirname, "shots");
mkdirSync(SHOTS, { recursive: true });

/* ─── Valeurs attendues (issues de _tools/generate-yuki-themes.mjs) ────── */
const EXPECT_BG = {
  "indigo-light": "#ffffff", "indigo-dark": "#1e1e1e",
  "midnight-light": "#f6f7fc", "midnight-dark": "#10111d",
  "slate-light": "#f4f6f8", "slate-dark": "#1f232b",
  "emerald-light": "#ffffff", "emerald-dark": "#0b1512",
  "amber-light": "#ffffff", "amber-dark": "#1a1408",
};
const FAMILIES = ["indigo", "midnight", "slate", "emerald", "amber"];
/** Migration : valeur stockée brute → preset attendu. */
const MIGRATIONS = [
  ["midnight", "midnight-dark"],
  ["dark", "indigo-dark"],
  ["light", "indigo-light"],
  ["slate", "slate-dark"],
  ["", "indigo-dark"],
  ["valeur-inconnue", "indigo-dark"],
];

/* ─── Résultats ─────────────────────────────────────────────────────────── */
const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const consoleMessages = [];
const logEntries = [];

/* ─── Lancement de Chromium (headless, débogage CDP) ────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-chrome-"));
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
    if (m) { clearTimeout(timer); resolve(m[1]); }
  });
  chrome.on("exit", (code) => reject(new Error("chromium a quitté : " + code)));
});

/* ─── Cible page + connexion CDP ────────────────────────────────────────── */
const list = await fetch(wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list")).then((r) => r.json());
const page = list.find((t) => t.type === "page");
if (!page) throw new Error("aucune cible page");
const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });

let seq = 0;
const pending = new Map();
const events = [];
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method) {
    if (process.env.CDP_TRACE) console.log("[evt]", msg.method);
    events.push(msg);
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = (msg.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      consoleMessages.push({ type: msg.params.type, text });
    } else if (msg.method === "Log.entryAdded") {
      logEntries.push({ source: msg.params.entry.source, level: msg.params.entry.level, text: msg.params.entry.text });
    }
  }
});

function send(method, params = {}) {
  const id = ++seq;
  if (process.env.CDP_TRACE) console.log("[cdp →]", method);
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, {
    resolve: (v) => { if (process.env.CDP_TRACE) console.log("[cdp ←]", method); resolve(v); },
    reject,
  }));
}

await send("Page.enable");
await send("Runtime.enable");
await send("Log.enable");
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
  await new Promise((r) => setTimeout(r, 250)); // laisser les modules tourner
}

async function evaluate(expression, awaitPromise = false) {
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (res.exceptionDetails) {
    throw new Error("eval: " + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails));
  }
  return res.result.value;
}

/** Lit l'état thème courant dans la page. */
const READ_STATE = `(() => {
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  const select = document.getElementById("theme-family");
  const toggle = document.getElementById("theme-toggle");
  let stored = null;
  try { stored = localStorage.getItem("yuki-theme"); } catch {}
  return {
    dataTheme: root.getAttribute("data-theme"),
    bg: cs.getPropertyValue("--bg").trim().toLowerCase(),
    panel2: cs.getPropertyValue("--panel-2").trim().toLowerCase(),
    accent: cs.getPropertyValue("--accent").trim().toLowerCase(),
    ok: cs.getPropertyValue("--ok").trim().toLowerCase(),
    colorScheme: cs.getPropertyValue("color-scheme").trim(),
    selectValue: select ? select.value : null,
    toggleIcon: toggle ? toggle.textContent : null,
    togglePressed: toggle ? toggle.getAttribute("aria-pressed") : null,
    toggleLabel: toggle ? toggle.getAttribute("aria-label") : null,
    stored,
    styleElems: document.querySelectorAll("style").length,
    styleAttrs: document.querySelectorAll("[style]").length,
  };
})()`;

async function setFamily(page, family) {
  await evaluate(`(() => {
    const sel = document.getElementById("theme-family");
    sel.value = ${JSON.stringify(family)};
    sel.dispatchEvent(new Event("change"));
  })()`);
}

async function clickToggle() {
  await evaluate(`document.getElementById("theme-toggle").click()`);
}

async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
  console.log(`📷 capture : _tools/shots/${name}.png`);
}

/* ═══════════════════════ Scénario par page ═══════════════════════════════ */
for (const path of ["/", "/config"]) {
  const url = BASE + path;
  const page = path === "/" ? "index" : "config";
  console.log(`\n═══ PAGE ${path} ═══`);

  // — État initial propre (localStorage vidé puis rechargement).
  await navigate(url);
  await evaluate("localStorage.clear()");
  await navigate(url);

  let s = await evaluate(READ_STATE);
  check(`[${page}] défaut sans stockage : data-theme=indigo-dark`, s.dataTheme === "indigo-dark" && s.stored === null, `dataTheme=${s.dataTheme} stored=${s.stored}`);
  check(`[${page}] défaut : --bg calculé = #1e1e1e`, s.bg === "#1e1e1e", s.bg);

  // — Les 5 familles × les 2 modes, VIA LES CONTRÔLES.
  // Départ : indigo-dark (mode courant « dark »).
  let mode = "dark";
  for (const family of FAMILIES) {
    await setFamily(page, family);
    s = await evaluate(READ_STATE);
    const expected = `${family}-${mode}`;
    check(`[${page}] select famille=${family} (mode conservé ${mode}) → ${expected}`,
      s.dataTheme === expected && s.stored === expected && s.bg === EXPECT_BG[expected] && s.selectValue === family,
      `dataTheme=${s.dataTheme} stored=${s.stored} --bg=${s.bg} select=${s.selectValue}`);
    // Bascule du mode (famille conservée) — visite ainsi les 10 combinaisons.
    await clickToggle();
    mode = mode === "dark" ? "light" : "dark";
    s = await evaluate(READ_STATE);
    const expected2 = `${family}-${mode}`;
    check(`[${page}] bouton → mode ${mode} (famille conservée ${family}) → ${expected2}`,
      s.dataTheme === expected2 && s.stored === expected2 && s.bg === EXPECT_BG[expected2],
      `dataTheme=${s.dataTheme} stored=${s.stored} --bg=${s.bg}`);
    // Retour au mode de départ (garde l'invariant pour la famille suivante).
    await clickToggle();
    mode = mode === "dark" ? "light" : "dark";
    s = await evaluate(READ_STATE);
    check(`[${page}] aller-retour bouton → toujours ${family}-${mode}`,
      s.dataTheme === `${family}-${mode}` && s.stored === `${family}-${mode}`, s.dataTheme);
  }

  // — Icône / aria du bouton selon le mode (état final de la boucle : amber-dark).
  check(`[${page}] bouton en mode sombre : ☾ + aria-pressed=true + libellé`,
    s.toggleIcon === "☾" && s.togglePressed === "true" && s.toggleLabel === "Passer en mode clair",
    `icon=${s.toggleIcon} pressed=${s.togglePressed} label=${s.toggleLabel}`);
  await clickToggle();
  s = await evaluate(READ_STATE);
  check(`[${page}] bouton en mode clair : ☀ + aria-pressed=false + libellé`,
    s.toggleIcon === "☀" && s.togglePressed === "false" && s.toggleLabel === "Passer en mode sombre",
    `icon=${s.toggleIcon} pressed=${s.togglePressed} label=${s.toggleLabel}`);

  // — Persistance : slate-light puis rechargement.
  await setFamily(page, "slate"); // mode courant = light après le clic ci-dessus
  s = await evaluate(READ_STATE);
  check(`[${page}] préparation persistance : slate-light`, s.dataTheme === "slate-light", s.dataTheme);
  await navigate(url);
  s = await evaluate(READ_STATE);
  check(`[${page}] PERSISTANCE : après rechargement data-theme=slate-light`,
    s.dataTheme === "slate-light" && s.stored === "slate-light" && s.bg === "#f4f6f8",
    `dataTheme=${s.dataTheme} stored=${s.stored} --bg=${s.bg}`);

  // — color-scheme effectif par mode.
  check(`[${page}] color-scheme calculé = light en mode clair`, s.colorScheme.includes("light"), s.colorScheme);
  await clickToggle();
  s = await evaluate(READ_STATE);
  check(`[${page}] color-scheme calculé = dark en mode sombre`, s.colorScheme.includes("dark"), s.colorScheme);
  check(`[${page}] --ok = #4cc38a (slate-dark)`, s.ok === "#4cc38a", s.ok);

  // — Migration de l'ancienne préférence (même clé, réécriture).
  for (const [raw, expected] of MIGRATIONS) {
    await evaluate(`localStorage.setItem("yuki-theme", ${JSON.stringify(raw)})`);
    await navigate(url);
    s = await evaluate(READ_STATE);
    check(`[${page}] MIGRATION ${JSON.stringify(raw)} → ${expected}`,
      s.dataTheme === expected && s.stored === expected && s.bg === EXPECT_BG[expected],
      `dataTheme=${s.dataTheme} stored=${JSON.stringify(s.stored)} --bg=${s.bg}`);
  }

  // — DOM : aucun <style> injecté, aucun attribut style (CSP style-src 'self').
  await evaluate("localStorage.clear()");
  await navigate(url);
  s = await evaluate(READ_STATE);
  check(`[${page}] zéro <style> injecté et zéro attribut style`, s.styleElems === 0 && s.styleAttrs === 0,
    `style=${s.styleElems} attrs=${s.styleAttrs}`);

  // — Pont holaf (page /config seulement) : le nom EXACT est transmis.
  if (page === "config") {
    const bridge = await evaluate(`(() => {
      const calls = [];
      const original = window.HolafModal.setTheme.bind(window.HolafModal);
      window.HolafModal.setTheme = (p) => { calls.push(String(p)); return original(p); };
      const sel = document.getElementById("theme-family");
      sel.value = "emerald";
      sel.dispatchEvent(new Event("change"));
      document.getElementById("theme-toggle").click();
      window.HolafModal.setTheme = original;
      return calls;
    })()`);
    check(`[config] pont HolafModal.setTheme appelé avec les noms exacts`,
      Array.isArray(bridge) && bridge.includes("emerald-dark") && bridge.includes("emerald-light"),
      JSON.stringify(bridge));
  }

  // — Captures (état courant de la page, laissé par le scénario).
  // Reset d'abord vers indigo-dark pour que les étiquettes soient exactes.
  await evaluate("localStorage.clear()");
  await navigate(url);
  await shot(`${page}-indigo-dark`);
  await setFamily(page, "emerald");
  if ((await evaluate(READ_STATE)).dataTheme !== "emerald-light") await clickToggle();
  s = await evaluate(READ_STATE);
  check(`[${page}] capture emerald-light prête`, s.dataTheme === "emerald-light", s.dataTheme);
  await shot(`${page}-emerald-light`);
}

/* ═══════════════════════ Bilan CSP ═══════════════════════════════════════ */
const cspViolations = [
  ...consoleMessages.filter((m) => /refused|content security policy|csp/i.test(m.text)),
  ...logEntries.filter((e) => /refused|content security policy|csp/i.test(e.text) || e.source === "security"),
];
console.log(`\nMessages console collectés : ${consoleMessages.length} ; entrées Log : ${logEntries.length}`);
for (const m of consoleMessages.slice(0, 10)) console.log("  console:", m.type, JSON.stringify(m.text.slice(0, 200)));
for (const e of logEntries.slice(0, 10)) console.log("  log:", e.source, e.level, JSON.stringify(e.text.slice(0, 200)));
check("ZÉRO violation CSP (aucun « Refused… » ni entrée security)", cspViolations.length === 0,
  cspViolations.map((v) => v.text).join(" | "));

const failed = results.filter((r) => !r.ok);
console.log(`\n═══ BILAN : ${results.length - failed.length}/${results.length} vérifications OK ═══`);
chrome.kill("SIGKILL");
process.exit(failed.length === 0 && cspViolations.length === 0 ? 0 : 1);