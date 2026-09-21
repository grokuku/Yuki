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

/* ─── Fichier d'état du moteur TTS SIMULÉ (piloté entre les navigations) ─── */
const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-tts-state-"));
const TTS_STATE_FILE = join(STATE_DIR, "engine.json");
function writeTtsState(state) {
  writeFileSync(TTS_STATE_FILE, JSON.stringify(state));
}
writeTtsState({ kind: "ready", modelCount: 1 });

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
  env: { ...process.env, YUKI_E2E_TTS_STATE_FILE: TTS_STATE_FILE },
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
    // Garde-temps : une navigation même-document (seul le hash change) ne
    // déclenche pas `loadEventFired`.
    setTimeout(() => {
      ws.off("message", h);
      resolve();
    }, 8000);
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

/* — Honnêteté : « Débit (%) » suit la capacité réelle du moteur choisi — */
const speedByEngine = await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#groups .config-row")];
  const byLabel = (label) => rows.find((r) => r.querySelector('.config-label')?.textContent?.includes(label));
  const engine = byLabel("Moteur")?.querySelector("select");
  const speedRow = byLabel("Débit");
  const speedInput = speedRow?.querySelector("input");
  const noteText = () => {
    const note = speedRow?.querySelector(".config-engine-note");
    return note && !note.hidden ? note.textContent : "";
  };
  const setEngine = (value) => {
    engine.value = value;
    engine.dispatchEvent(new Event("input"));
    engine.dispatchEvent(new Event("change"));
  };
  const initial = engine.value;
  setEngine("chatterbox");
  const chatterbox = { disabled: speedInput.disabled, note: noteText() };
  setEngine("kokoro");
  const kokoro = { disabled: speedInput.disabled, note: noteText() };
  setEngine("qwen3-tts");
  const qwen = { disabled: speedInput.disabled, note: noteText() };
  setEngine(initial);
  return {
    initial,
    chatterbox,
    kokoro,
    qwen,
    restoredEngine: engine.value,
    restoredDisabled: speedInput.disabled,
  };
})()`);
check(
  "[/config] « Débit » grisé + note pour chatterbox/qwen3-tts, actif pour kokoro (suit le moteur)",
  speedByEngine.chatterbox.disabled === true &&
    /Sans effet/.test(speedByEngine.chatterbox.note) &&
    speedByEngine.kokoro.disabled === false &&
    speedByEngine.kokoro.note === "" &&
    speedByEngine.qwen.disabled === true &&
    /Sans effet/.test(speedByEngine.qwen.note) &&
    speedByEngine.restoredEngine === speedByEngine.initial &&
    speedByEngine.restoredDisabled === true,
  JSON.stringify(speedByEngine),
);

/* — Onglets : bascule au clic, navigation clavier, routage par hash — */
const tabClick = await evaluate(`(() => {
  const tabs = [...document.querySelectorAll('[role=tab]')];
  const active = () => tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.id;
  const visible = (id) => !document.getElementById(id)?.hidden;
  const before = { active: active(), modeles: visible('panel-modeles'), voix: visible('panel-voix'), hash: location.hash };
  document.getElementById('tab-voix').click();
  return {
    before,
    after: { active: active(), modeles: visible('panel-modeles'), voix: visible('panel-voix'), hash: location.hash },
  };
})()`);
check(
  "[/config] clic « Voix » → panneau Voix visible, Modèles masqué, hash = #voix",
  tabClick.before.active === "tab-modeles" && tabClick.before.modeles === true && tabClick.before.voix === false &&
    tabClick.after.active === "tab-voix" && tabClick.after.modeles === false && tabClick.after.voix === true &&
    tabClick.after.hash === "#voix",
  JSON.stringify(tabClick),
);

await evaluate(`document.getElementById("tab-voix").focus()`);
await evaluate(
  `document.getElementById("tab-voix").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }))`,
);
await sleep(80);
const tabKey = await evaluate(`(() => {
  const active = [...document.querySelectorAll('[role=tab]')].find((t) => t.getAttribute('aria-selected') === 'true')?.id;
  return {
    active,
    focus: document.activeElement?.id,
    voixVisible: !document.getElementById('panel-voix')?.hidden,
    convVisible: !document.getElementById('panel-conversation')?.hidden,
  };
})()`);
check(
  "[/config] flèche gauche change d'onglet (roving tabindex + activation au focus)",
  tabKey.active === "tab-conversation" && tabKey.focus === "tab-conversation" &&
    tabKey.convVisible === true && tabKey.voixVisible === false,
  JSON.stringify(tabKey),
);

/* — Routage par hash : ouverture directe de /config#voix. — */
// Passe par un autre document d'abord : /config → /config#voix serait une
// navigation même-document (pas de rechargement, donc pas de test du hash
// à l'init).
await navigate(BASE + "/");
await navigate(BASE + "/config#voix");
const deepLink = await evaluate(`(() => ({
  active: [...document.querySelectorAll('[role=tab]')].find((t) => t.getAttribute('aria-selected') === 'true')?.id,
  voixVisible: !document.getElementById('panel-voix')?.hidden,
  modelesVisible: !document.getElementById('panel-modeles')?.hidden,
}))()`);
check(
  "[/config#voix] ouverture directe sur l'onglet Voix",
  deepLink.active === "tab-voix" && deepLink.voixVisible === true && deepLink.modelesVisible === false,
  JSON.stringify(deepLink),
);

/* — Pastille/indicateur « non enregistré » sur un onglet MASQUÉ — */
const dirtyCheck = await evaluate(`(() => {
  const modelesTab = document.getElementById('tab-modeles');
  const indicator = document.getElementById('save-dirty');
  // Modèle actif : Voix. On modifie un champ de l'onglet Modèles (masqué).
  const rows = [...document.querySelectorAll('#groups .config-row')];
  const row = rows.find((r) => r.querySelector('.config-label')?.textContent?.includes('URL de base'));
  const input = row.querySelector('input');
  const read = () => ({ dot: modelesTab.classList.contains('config-tab--dirty'), indicator: !indicator.hidden });
  const before = read();
  const original = input.value;
  input.value = original + 'x';
  input.dispatchEvent(new Event('input'));
  const after = read();
  input.value = original;
  input.dispatchEvent(new Event('input'));
  const reverted = read();
  return { before, after, reverted };
})()`);
check(
  "[/config] champ modifié dans un onglet masqué → pastille + indicateur « non enregistré »",
  dirtyCheck.before.dot === false && dirtyCheck.before.indicator === false &&
    dirtyCheck.after.dot === true && dirtyCheck.after.indicator === true &&
    dirtyCheck.reverted.dot === false && dirtyCheck.reverted.indicator === false,
  JSON.stringify(dirtyCheck),
);

/* — Enregistrement d'un champ NUMÉRIQUE via le bouton « Enregistrer » — */
await evaluate(`(() => {
  const rows = [...document.querySelectorAll('#groups .config-row')];
  const row = rows.find((r) => r.querySelector('.config-label')?.textContent?.includes('Débit'));
  const input = row.querySelector('input');
  input.value = '133';
  input.dispatchEvent(new Event('input'));
  document.getElementById('save').click();
  return true;
})()`);
await sleep(900);
const numericSave = await evaluate(
  `fetch("/api/config").then((r) => r.json()).then((b) => ({
    speed: b.fields["tts.speed"].value,
    status: document.getElementById("save-status").textContent,
    globalError: document.getElementById("global-error").hidden
      ? "" : document.getElementById("global-error").textContent,
  }))`,
  true,
);
check(
  "[/config] « Enregistrer » d'un champ numérique (Débit) → persistance, aucun message d'erreur",
  numericSave.speed === 133 && /Enregistré/.test(numericSave.status) && numericSave.globalError === "",
  JSON.stringify(numericSave),
);

await shot("config-tabs-voix");

/* — Captures de lisibilité : 2 familles × 2 modes (onglet Voix). — */
async function shotPreset(preset) {
  await evaluate(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(preset)})`);
  await sleep(120);
  await shot(`config-tabs-${preset}`);
}
for (const preset of ["indigo-dark", "indigo-light", "emerald-dark", "emerald-light"]) {
  await shotPreset(preset);
}

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

/* ═══════════════════════ Assistant de mise en route (Lot 8) ══════════════ */
console.log("\n═══ ASSISTANT TTS (Lot 8) ═══");

const READ_ASSISTANT = `(() => {
  const root = document.getElementById("tts-assistant-root");
  if (!root) return { hasRoot: false };
  const details = [...root.querySelectorAll(".tts-details")].find(
    (d) => !d.classList.contains("tts-details--engine"),
  );
  return {
    hasRoot: true,
    badge: root.querySelector(".tts-badge")?.textContent ?? "",
    message: root.querySelector(".tts-card__message")?.textContent ?? "",
    hasEnable: [...root.querySelectorAll("button")].some((b) => b.textContent === "Activer la voix"),
    hasTest: [...root.querySelectorAll("button")].some((b) => b.textContent === "Tester la voix"),
    testDisabled: (() => {
      const b = [...root.querySelectorAll("button")].find((x) => x.textContent === "Tester la voix");
      return b ? b.disabled : null;
    })(),
    detailsBody: root.querySelector(".tts-details__body")?.textContent ?? "",
    hasRefresh: [...root.querySelectorAll("button")].some((b) => b.textContent === "Vérifier le moteur"),
    hasManual: !!root.querySelector(".tts-assistant__manual"),
    manualText: root.querySelector(".tts-assistant__manual")?.textContent ?? "",
    modelsDirText: root.querySelector(".tts-models-dir")?.textContent ?? "",
    engineSummary: root.querySelector(".tts-details--engine summary")?.textContent ?? "",
    detailsHidden: details ? details.hidden : null,
    styleElems: root.querySelectorAll("style").length,
    styleAttrs: root.querySelectorAll("[style]").length,
    audioTags: document.querySelectorAll("audio").length,
  };
})()`;

// Query-string pour forcer une NAVIGATION COMPLÈTE (un simple hash ne recharge pas).
async function gotoAssistant() {
  await navigate(BASE + "/config?t=" + Date.now() + "#voix");
  await sleep(300);
}

function setEnabled(value) {
  return fetch(BASE + "/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json", "x-yuki-config": "1" },
    body: JSON.stringify({ "tts.enabled": value }),
  });
}

/* — État 1/5 : prêt — */
writeTtsState({ kind: "ready", modelCount: 2 });
await setEnabled("on");
await gotoAssistant();
let a = await evaluate(READ_ASSISTANT);
check("[/config] assistant monté par id (racine + carte)", a.hasRoot && !!a.badge, JSON.stringify({ hasRoot: a.hasRoot, badge: a.badge }));
check(
  "[/config] état prêt → badge « Prêt » + « Moteur prêt (2 modèles) »",
  a.badge === "Prêt" && /Moteur prêt \(2 modèles\)/.test(a.message),
  `badge=${a.badge} message=${JSON.stringify(a.message)}`,
);
check(
  "[/config] modèle disque affiché (nom + taille)",
  /chatterbox-q8\.gguf/.test(a.modelsDirText),
  JSON.stringify(a.modelsDirText.slice(0, 120)),
);
check(
  "[/config] liste des modèles du moteur repliable",
  /Modèles du moteur/.test(a.engineSummary),
  JSON.stringify(a.engineSummary),
);
check(
  "[/config] bloc « à la main » présent, exact (bind mount, sans profil obsolète)",
  a.hasManual &&
    /Vérifier que le service/.test(a.manualText) &&
    /docker compose logs tts/.test(a.manualText) &&
    /\/models/.test(a.manualText) &&
    !/--profile/.test(a.manualText) &&
    !/yuki-models/.test(a.manualText),
  JSON.stringify(a.manualText.slice(0, 200)),
);
check("[/config] boutons « Tester la voix » + « Vérifier le moteur » présents", a.hasTest && a.hasRefresh);
check(
  "[/config] assistant : zéro <style> / attribut style / balise <audio>",
  a.styleElems === 0 && a.styleAttrs === 0 && a.audioTags === 0,
  `style=${a.styleElems} attrs=${a.styleAttrs} audio=${a.audioTags}`,
);
await shot("config-assistant-ready");

/* — État 2/5 : démarrage en cours — */
writeTtsState({ kind: "starting", modelCount: 0 });
await gotoAssistant();
a = await evaluate(READ_ASSISTANT);
check(
  "[/config] état démarrage → badge « Démarrage en cours »",
  a.badge === "Démarrage en cours",
  `badge=${a.badge}`,
);
await shot("config-assistant-starting");

/* — État 3/5 : erreur moteur (503 avec corps) — */
writeTtsState({ kind: "error", httpStatus: 503, body: '{"error":"Insufficient Memory"}' });
await gotoAssistant();
a = await evaluate(READ_ASSISTANT);
check(
  "[/config] état erreur → badge « Erreur » + détails techniques repliables",
  a.badge === "Erreur" && a.detailsHidden === false,
  `badge=${a.badge} detailsHidden=${a.detailsHidden}`,
);
await shot("config-assistant-error");

/* — État 4/5 : moteur non démarré (injoignable) — */
writeTtsState({ kind: "unreachable" });
await gotoAssistant();
a = await evaluate(READ_ASSISTANT);
check(
  "[/config] état injoignable → badge « Non démarré » + causes actionnables (logs, plus de « profil Compose »)",
  a.badge === "Non démarré" &&
    /Docker/.test(a.message) &&
    /main/.test(a.message) &&
    /logs/.test(a.message) &&
    !/profil/i.test(a.message),
  `badge=${a.badge} message=${JSON.stringify(a.message.slice(0, 200))}`,
);
await shot("config-assistant-unreachable");

/* — État 5/5 : désactivé (tts.enabled = off) — */
await setEnabled("off");
writeTtsState({ kind: "ready", modelCount: 1 });
await gotoAssistant();
a = await evaluate(READ_ASSISTANT);
check(
  "[/config] état désactivé → badge « Désactivé » + bouton « Activer la voix »",
  a.badge === "Désactivé" && a.hasEnable,
  `badge=${a.badge} hasEnable=${a.hasEnable}`,
);
await shot("config-assistant-off");

/* — « Activer la voix » : confirmation HolafModal, puis ANNULATION (pas de redémarrage) — */
await evaluate(
  `(() => { const b = [...document.querySelectorAll("#tts-assistant-root button")].find((x) => x.textContent === "Activer la voix"); b?.click(); })()`,
);
await sleep(300);
const enableModal = await evaluate(`(() => ({
  open: !!document.querySelector(".holaf-modal-root"),
  title: document.querySelector(".holaf-modal-title")?.textContent ?? "",
}))()`);
check(
  "[/config] « Activer la voix » ouvre une confirmation HolafModal",
  enableModal.open && /redémarrer/i.test(enableModal.title),
  JSON.stringify(enableModal),
);
await evaluate(`document.querySelector(".holaf-modal-btn-cancel")?.click()`);
await sleep(200);
const aliveAfterCancel = await evaluate(
  `fetch("/health/live").then((r) => r.ok).catch(() => false)`,
  true,
);
check(
  "[/config] annulation → aucun redémarrage enclenché (gateway vivant)",
  aliveAfterCancel === true,
);

/* — « Tester la voix » : texte libre → WAV lu par Web Audio, voix/moteur affichés — */
await setEnabled("on");
writeTtsState({ kind: "ready", modelCount: 1 });
await gotoAssistant();
await evaluate(
  `(() => { const t = document.getElementById("tts-test-text"); t.value = "Bonjour, ceci est un test."; t.dispatchEvent(new Event("input")); })()`,
);
await evaluate(
  `(() => { const b = [...document.querySelectorAll("#tts-assistant-root button")].find((x) => x.textContent === "Tester la voix"); b?.click(); })()`,
);
await sleep(1500);
const testResult = await evaluate(`(() => ({
  text: document.querySelector("#tts-assistant-root .tts-test__feedback")?.textContent ?? "",
  error: !!document.querySelector("#tts-assistant-root .tts-test__error"),
}))()`);
check(
  "[/config] « Tester la voix » → WAV reçu, voix/moteur/référence réellement utilisés affichés",
  !testResult.error &&
    /voix réellement utilisée/i.test(testResult.text) &&
    /chatterbox/.test(testResult.text) &&
    /\/voices\/presets\/camille\.wav/.test(testResult.text),
  JSON.stringify(testResult.text.slice(0, 240)),
);
await shot("config-assistant-test");

/* — Bornes : un texte > 500 caractères est refusé SANS appel moteur — */
await evaluate(
  `(() => { const t = document.getElementById("tts-test-text"); t.value = "x".repeat(600); t.dispatchEvent(new Event("input")); })()`,
);
await evaluate(
  `(() => { const b = [...document.querySelectorAll("#tts-assistant-root button")].find((x) => x.textContent === "Tester la voix"); b?.click(); })()`,
);
await sleep(300);
const tooLongMessage = await evaluate(
  `document.querySelector("#tts-assistant-root .tts-test__error")?.textContent ?? ""`,
);
check(
  "[/config] texte > 500 caractères → refus explicite côté client",
  /500/.test(tooLongMessage),
  JSON.stringify(tooLongMessage),
);

/* — État 6/6 : `/health` SANS champ `ready` (forme RÉELLE observée) — */
await setEnabled("on");
writeTtsState({ kind: "health_unknown" });
await gotoAssistant();
a = await evaluate(READ_ASSISTANT);
check(
  "[/config] /health SANS `ready` → état utilisable, JAMAIS « Erreur », bouton de test actif",
  a.badge !== "Erreur" && a.testDisabled === false,
  `badge=${a.badge} testDisabled=${a.testDisabled}`,
);
check(
  "[/config] /health SANS `ready` → déduction honnête exposée dans les détails",
  /déduite/i.test(a.detailsBody),
  JSON.stringify(a.detailsBody.slice(0, 200)),
);
await evaluate(
  `(() => { const t = document.getElementById("tts-test-text"); t.value = "Bonjour."; t.dispatchEvent(new Event("input")); })()`,
);
await evaluate(
  `(() => { const b = [...document.querySelectorAll("#tts-assistant-root button")].find((x) => x.textContent === "Tester la voix"); b?.click(); })()`,
);
await sleep(1500);
const unknownShapeTest = await evaluate(`(() => ({
  text: document.querySelector("#tts-assistant-root .tts-test__feedback")?.textContent ?? "",
  error: !!document.querySelector("#tts-assistant-root .tts-test__error"),
}))()`);
check(
  "[/config] /health SANS `ready` → le test de synthèse reste UTILISABLE (preuve réelle)",
  !unknownShapeTest.error && /voix réellement utilisée/i.test(unknownShapeTest.text),
  JSON.stringify(unknownShapeTest.text.slice(0, 200)),
);
await shot("config-assistant-health-unknown");

/* — Captures de lisibilité de l'assistant (2 familles × 2 modes, état prêt) — */
writeTtsState({ kind: "ready", modelCount: 2 });
await gotoAssistant();
async function shotAssistantPreset(preset) {
  await evaluate(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(preset)})`);
  await sleep(120);
  await shot(`config-assistant-${preset}`);
}
for (const preset of ["indigo-dark", "indigo-light", "emerald-dark", "emerald-light"]) {
  await shotAssistantPreset(preset);
}

/* — Responsive : barre d'onglets en défilement horizontal (petit écran). — */
await send("Emulation.setDeviceMetricsOverride", {
  width: 360,
  height: 720,
  deviceScaleFactor: 1,
  mobile: false,
});
await sleep(200);
const narrow = await evaluate(`(() => {
  const list = document.querySelector('.config-tablist');
  const cs = getComputedStyle(list);
  return {
    flexWrap: cs.flexWrap,
    overflowX: cs.overflowX,
    scrollable: list.scrollWidth > list.clientWidth,
    activeVisible: !document.getElementById('panel-voix')?.hidden,
  };
})()`);
check(
  "[/config] petit écran : tablist en défilement horizontal (nowrap + overflow-x:auto)",
  narrow.flexWrap === "nowrap" && narrow.overflowX === "auto" && narrow.scrollable === true,
  JSON.stringify(narrow),
);
await shot("config-tabs-mobile");

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
