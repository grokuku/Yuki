#!/usr/bin/env node
/**
 * Harnais E2E JETABLE (hors dépôts) — rendu headless Chromium via CDP.
 * Vérifie le comportement RÉEL du thème à deux axes sur les deux pages du
 * gateway : application des 12 combinaisons (6 familles × 2 modes),
 * indépendance famille/mode des deux contrôles, persistance, migration des
 * anciennes préférences V1, zéro violation CSP. Produit aussi des captures.
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
  "corail-light": "#ffe3ed", "corail-dark": "#36252c",
  "ambre-light": "#dcc8b5", "ambre-dark": "#0c0400",
  "emeraude-light": "#c9dac4", "emeraude-dark": "#081005",
  "turquoise-light": "#c3e2e8", "turquoise-dark": "#051a1e",
  "amethyste-light": "#dfe1fa", "amethyste-dark": "#1e1f2e",
  "neutre-light": "#f2f4f5", "neutre-dark": "#343537",
};
const FAMILIES = ["corail", "ambre", "emeraude", "turquoise", "amethyste", "neutre"];
const MODES = ["light", "dark"];
/** Migration : valeur stockée brute (V1 ou inconnue) → preset V2 attendu. */
const MIGRATIONS = [
  ["indigo-dark", "amethyste-dark"],
  ["midnight", "amethyste-dark"],
  ["emerald-light", "emeraude-light"],
  ["dark", "amethyste-dark"],
  ["light", "amethyste-light"],
  ["slate", "neutre-dark"],
  ["slate-dark", "neutre-dark"],
  ["", "neutre-dark"],
  ["valeur-inconnue", "neutre-dark"],
];

/* ─── Résultats ─────────────────────────────────────────────────────────── */
const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const consoleMessages = [];
const logEntries = [];
const jsExceptions = [];

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
    } else if (msg.method === "Runtime.exceptionThrown") {
      jsExceptions.push(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || "(exception)");
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
    toggleHasSun: !!toggle && !!toggle.querySelector(".icon--sun"),
    toggleHasMoon: !!toggle && !!toggle.querySelector(".icon--moon"),
    togglePressed: toggle ? toggle.getAttribute("aria-pressed") : null,
    toggleLabel: toggle ? toggle.getAttribute("aria-label") : null,
    stored,
    styleElems: document.querySelectorAll("style").length,
    styleAttrs: document.querySelectorAll("[style]").length,
    holafVersion: window.HolafTokens && window.HolafTokens.VERSION,
    holafPacks: window.HolafTokens
      ? window.HolafTokens.listPresets().filter((n) => n.startsWith("yuki-")).length
      : 0,
    holafCurrent: window.HolafTokens && window.HolafTokens.getTheme()
      ? window.HolafTokens.getTheme().name
      : null,
    holafSurface: cs.getPropertyValue("--holaf-surface").trim().toLowerCase(),
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
  check(`[${page}] défaut sans stockage : data-theme=neutre-dark`, s.dataTheme === "neutre-dark" && s.stored === null, `dataTheme=${s.dataTheme} stored=${s.stored}`);
  check(`[${page}] défaut : --bg calculé = #343537`, s.bg === "#343537", s.bg);

  // — Les 6 familles × les 2 modes, VIA LES CONTRÔLES.
  // Départ : neutre-dark (mode courant « dark »).
  // On relève aussi (bg, accent) pour PROUVER la distinction entre familles
  // dans les DEUX modes (pas seulement la conformité aux valeurs attendues).
  const seen = new Map();
  let mode = "dark";
  for (const family of FAMILIES) {
    await setFamily(page, family);
    s = await evaluate(READ_STATE);
    const expected = `${family}-${mode}`;
    seen.set(expected, { bg: s.bg, accent: s.accent });
    check(`[${page}] select famille=${family} (mode conservé ${mode}) → ${expected}`,
      s.dataTheme === expected && s.stored === expected && s.bg === EXPECT_BG[expected] && s.selectValue === family,
      `dataTheme=${s.dataTheme} stored=${s.stored} --bg=${s.bg} select=${s.selectValue}`);
    // Bascule du mode (famille conservée) — visite ainsi les 12 combinaisons.
    await clickToggle();
    mode = mode === "dark" ? "light" : "dark";
    s = await evaluate(READ_STATE);
    const expected2 = `${family}-${mode}`;
    seen.set(expected2, { bg: s.bg, accent: s.accent });
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
  // Distinction VISIBLE : les fonds ET les accents des 12 combinaisons sont
  // deux à deux différents (aucune famille ne se confond, dans aucun mode).
  const bgs = [...seen.values()].map((v) => v.bg);
  const accents = [...seen.values()].map((v) => v.accent);
  for (const m of MODES) {
    const famBgs = FAMILIES.map((f) => seen.get(`${f}-${m}`)?.bg);
    const famAccents = FAMILIES.map((f) => seen.get(`${f}-${m}`)?.accent);
    check(`[${page}] mode ${m} : 6 fonds de famille deux à deux distincts`,
      new Set(famBgs).size === FAMILIES.length, famBgs.join(" "));
    check(`[${page}] mode ${m} : 6 accents de famille deux à deux distincts`,
      new Set(famAccents).size === FAMILIES.length, famAccents.join(" "));
  }
  check(`[${page}] les 12 combinaisons sont deux à deux distinctes (bg + accent)`,
    seen.size === 12 && new Set(bgs).size === 12 && new Set(accents).size === 12,
    `presets=${seen.size} bgs=${new Set(bgs).size} accents=${new Set(accents).size}`);

  // — Icône / aria du bouton selon le mode (état final de la boucle : neutre-dark).
  check(`[${page}] bouton en mode sombre : icône lune + aria-pressed=true + libellé`,
    s.toggleHasMoon && s.togglePressed === "true" && s.toggleLabel === "Passer en mode clair",
    `moon=${s.toggleHasMoon} pressed=${s.togglePressed} label=${s.toggleLabel}`);
  await clickToggle();
  s = await evaluate(READ_STATE);
  check(`[${page}] bouton en mode clair : icône soleil + aria-pressed=false + libellé`,
    s.toggleHasSun && s.togglePressed === "false" && s.toggleLabel === "Passer en mode sombre",
    `sun=${s.toggleHasSun} pressed=${s.togglePressed} label=${s.toggleLabel}`);

  // — Persistance : turquoise-light puis rechargement.
  await setFamily(page, "turquoise"); // mode courant = light après le clic ci-dessus
  s = await evaluate(READ_STATE);
  check(`[${page}] préparation persistance : turquoise-light`, s.dataTheme === "turquoise-light", s.dataTheme);
  await navigate(url);
  s = await evaluate(READ_STATE);
  check(`[${page}] PERSISTANCE : après rechargement data-theme=turquoise-light`,
    s.dataTheme === "turquoise-light" && s.stored === "turquoise-light" && s.bg === "#c3e2e8",
    `dataTheme=${s.dataTheme} stored=${s.stored} --bg=${s.bg}`);

  // — color-scheme effectif par mode.
  check(`[${page}] color-scheme calculé = light en mode clair`, s.colorScheme.includes("light"), s.colorScheme);
  await clickToggle();
  s = await evaluate(READ_STATE);
  check(`[${page}] color-scheme calculé = dark en mode sombre`, s.colorScheme.includes("dark"), s.colorScheme);
  check(`[${page}] --ok = #4cc38a (turquoise-dark)`, s.ok === "#4cc38a", s.ok);

  // — Migration de l'ancienne préférence (même clé, réécriture).
  for (const [raw, expected] of MIGRATIONS) {
    await evaluate(`localStorage.setItem("yuki-theme", ${JSON.stringify(raw)})`);
    await navigate(url);
    s = await evaluate(READ_STATE);
    check(`[${page}] MIGRATION ${JSON.stringify(raw)} → ${expected}`,
      s.dataTheme === expected && s.stored === expected && s.bg === EXPECT_BG[expected],
      `dataTheme=${s.dataTheme} stored=${JSON.stringify(s.stored)} --bg=${s.bg}`);
  }

  // — DOM : aucun <style> injecté (CSP style-src 'self') ; les tokens sont
  //   posés par CSSOM sur <html> (autorisé par CSP, non régi par style-src).
  await evaluate("localStorage.clear()");
  await navigate(url);
  s = await evaluate(READ_STATE);
  check(`[${page}] zéro <style> injecté (marqueur neutralisé), CSSOM --holaf-* actif`,
    s.styleElems === 0 && s.styleAttrs === 1 && s.holafSurface !== "",
    `style=${s.styleElems} attrs=${s.styleAttrs} holaf-surface=${s.holafSurface}`);
  check(`[${page}] brique tokens active (v0.4.1) + 12 packs hôte yuki-*`,
    s.holafVersion === "0.4.1" && s.holafPacks === 12 && (s.holafCurrent || "").startsWith("yuki-"),
    `version=${s.holafVersion} packs=${s.holafPacks} courant=${s.holafCurrent}`);

  // — Pont holaf (page /config seulement) : le nom EXACT est transmis.
  if (page === "config") {
    const bridge = await evaluate(`(() => {
      const calls = [];
      const original = window.HolafModal.setTheme.bind(window.HolafModal);
      window.HolafModal.setTheme = (p) => { calls.push(String(p)); return original(p); };
      const sel = document.getElementById("theme-family");
      sel.value = "emeraude";
      sel.dispatchEvent(new Event("change"));
      document.getElementById("theme-toggle").click();
      window.HolafModal.setTheme = original;
      return calls;
    })()`);
    check(`[config] pont HolafModal.setTheme appelé avec les noms exacts`,
      Array.isArray(bridge) && bridge.includes("emeraude-dark") && bridge.includes("emeraude-light"),
      JSON.stringify(bridge));
  }

  // — Captures (état courant de la page, laissé par le scénario).
  // Reset d'abord vers neutre-dark pour que les étiquettes soient exactes.
  await evaluate("localStorage.clear()");
  await navigate(url);
  await shot(`${page}-neutre-dark`);
  await setFamily(page, "amethyste");
  if ((await evaluate(READ_STATE)).dataTheme !== "amethyste-light") await clickToggle();
  s = await evaluate(READ_STATE);
  check(`[${page}] capture amethyste-light prête`, s.dataTheme === "amethyste-light", s.dataTheme);
  await shot(`${page}-amethyste-light`);
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
check("ZÉRO exception JavaScript", jsExceptions.length === 0, jsExceptions.join(" | "));

const failed = results.filter((r) => !r.ok);
console.log(`\n═══ BILAN : ${results.length - failed.length}/${results.length} vérifications OK ═══`);
chrome.kill("SIGKILL");
process.exit(failed.length === 0 && cspViolations.length === 0 ? 0 : 1);