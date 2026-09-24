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
// Dossier de configuration du moteur (contrôlé par l'E2E) : on y écrit
// directement `server.json` pour simuler un état DÉJÀ incohérent (hérité, comme
// celui de l'utilisateur) et prouver que l'éditeur le signale puis le répare.
const ENGINE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-tts-config-"));
const ENGINE_SERVER_JSON = join(ENGINE_CONFIG_DIR, "server.json");
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
  env: {
    ...process.env,
    YUKI_E2E_TTS_STATE_FILE: TTS_STATE_FILE,
    YUKI_E2E_TTS_CONFIG_DIR: ENGINE_CONFIG_DIR,
  },
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
/**
 * Exceptions JS NON capturées côté page (erreur de chargement de module,
 * symbole utilisé mais non défini, exception dans un listener…). Ces erreurs
 * n'apparaissent NI dans `consoleAPICalled` NI dans `Log.entryAdded` : sans ce
 * canal `Runtime.exceptionThrown`, elles passeraient inaperçues.
 */
const pageExceptions = [];
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
  } else if (msg.method === "Runtime.exceptionThrown") {
    const d = msg.params.exceptionDetails || {};
    pageExceptions.push({
      text: d.exception?.description ?? d.text ?? "exception",
      url: d.url ?? "",
      line: d.lineNumber ?? null,
    });
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

/* ══════════════════ Onglet Voix simplifié — 5 zones (refonte UX) ═══════════ */
console.log("\n═══ ONGLET VOIX SIMPLIFIÉ ═══");
await gotoAssistant();

const VOICE_ZONES = `(() => {
  const panel = document.getElementById("panel-voix");
  const rows = [...document.querySelectorAll("#group-voix .config-row")];
  const rowByLabel = (label) => rows.find((r) => r.querySelector(".config-label")?.textContent?.includes(label));
  const visibleWithoutClick = (label) => {
    const row = rowByLabel(label);
    if (!row || row.hidden) return false;
    const wrap = row.closest("details.config-advanced");
    return !wrap || wrap.open;
  };
  const engineZone = panel.querySelector(":scope > #tts-engine-root > details.config-advanced");
  const advanced = panel.querySelector("#group-voix details.config-advanced");
  return {
    hasMounts: !!document.getElementById("tts-assistant-root") &&
      !!document.getElementById("voices-root") &&
      !!document.getElementById("group-voix") &&
      !!document.getElementById("tts-engine-root"),
    engineClosed: engineZone ? engineZone.open === false : null,
    advancedClosed: advanced ? advanced.open === false : null,
    advancedSummary: advanced?.querySelector("summary")?.textContent ?? "",
    essentials: ["Activer la voix", "Moteur de synthèse", "Langue", "Émotion", "Débit de parole", "Volume de lecture"]
      .map((label) => ({ label, visible: visibleWithoutClick(label) })),
    voiceTextField: !!rowByLabel("Voix (identifiant du registre)"),
    voiceSelect: !!document.getElementById("voices-select"),
    downloads: (() => {
      const el = document.getElementById("tts-downloads-root");
      return el
        ? { present: true, empty: el.childNodes.length === 0, rows: el.querySelectorAll(".tts-dl__item").length }
        : { present: false, empty: false, rows: 0 };
    })(),
    styleElems: panel.querySelectorAll("style").length,
    styleAttrs: panel.querySelectorAll("[style]").length,
  };
})()`;

const z = await evaluate(VOICE_ZONES);
check("[/config] zone Voix : les 4 points de montage existent (① ② ③④ ⑤)", z.hasMounts, JSON.stringify({ hasMounts: z.hasMounts }));
check(
  "[/config] zone ③ : les 6 réglages essentiels sont VISIBLES sans clic",
  z.essentials.every((e) => e.visible),
  JSON.stringify(z.essentials),
);
check(
  "[/config] zone ④ : repli « Avancé » replié par défaut (classe DISTINCTE `config-advanced`)",
  z.advancedClosed === true && /Avancé/.test(z.advancedSummary),
  JSON.stringify({ closed: z.advancedClosed, summary: z.advancedSummary }),
);
check(
  "[/config] zone ⑤ : « Moteur TTS et modèles » est replié par défaut",
  z.engineClosed === true,
  JSON.stringify({ engineClosed: z.engineClosed }),
);
check(
  "[/config] doublon supprimé : plus de champ texte `tts.voice`, le select de la bibliothèque subsiste",
  z.voiceTextField === false && z.voiceSelect === true,
  JSON.stringify({ voiceTextField: z.voiceTextField, voiceSelect: z.voiceSelect }),
);
check(
  "[/config] UI de téléchargement LIVRÉE : #tts-downloads-root présent et peuplé (catalogue)",
  z.downloads.present === true && z.downloads.empty === false && z.downloads.rows === 4,
  JSON.stringify(z.downloads),
);
check(
  "[/config] onglet Voix : zéro <style> / attribut style",
  z.styleElems === 0 && z.styleAttrs === 0,
  `style=${z.styleElems} attrs=${z.styleAttrs}`,
);
await shot("config-voix-zones-visible");
await evaluate(`document.getElementById("group-voix").scrollIntoView({ block: "start" })`);
await sleep(150);
await shot("config-voix-reglages-essentiels");

/* — Le repli ④ « Avancé » ouvert révèle les champs techniques (zone ④). — */
const openedAdvanced = await evaluate(`(() => {
  const details = document.querySelector("#group-voix details.config-advanced");
  details.open = true;
  const rows = [...details.querySelectorAll(".config-row")];
  return {
    open: details.open,
    rowCount: rows.length,
    labels: rows.map((r) => r.querySelector(".config-label")?.textContent ?? ""),
  };
})()`);
check(
  "[/config] zone ④ dépliée → champs techniques présents (adresse, préchargement, découpe, délai)",
  openedAdvanced.open &&
    openedAdvanced.rowCount >= 5 &&
    openedAdvanced.labels.some((l) => /Adresse du moteur/.test(l)) &&
    openedAdvanced.labels.some((l) => /Préchargement/.test(l)) &&
    openedAdvanced.labels.some((l) => /Découpe/.test(l)) &&
    openedAdvanced.labels.some((l) => /Délai maximal/.test(l)),
  JSON.stringify(openedAdvanced),
);
await sleep(150);
await evaluate(`document.querySelector("#group-voix details.config-advanced").scrollIntoView({ block: "start" })`);
await sleep(150);
await shot("config-voix-zones-avance");
await evaluate(`document.querySelector("#group-voix details.config-advanced").open = false`);

/* — Le repli ⑤ ouvert révèle bien son contenu (masqué, jamais retiré). — */
const openedEngine = await evaluate(`(() => {
  const details = document.querySelector("#tts-engine-root > details.config-advanced");
  details.open = true;
  return {
    open: details.open,
    hasDownloads: !!document.getElementById("tts-downloads-root"),
    hasEngineConfig: !!document.querySelector("#panel-voix .tts-engine-config"),
    hasManual: !!document.querySelector("#panel-voix .tts-assistant__manual"),
    hasModelsDir: !!document.querySelector("#panel-voix .tts-models-dir"),
  };
})()`);
check(
  "[/config] zone ⑤ dépliée → disque + config moteur + manuel + place téléchargement présents",
  openedEngine.open && openedEngine.hasDownloads && openedEngine.hasEngineConfig && openedEngine.hasManual && openedEngine.hasModelsDir,
  JSON.stringify(openedEngine),
);
await sleep(150);
await evaluate(`document.querySelector("#tts-engine-root > details.config-advanced").scrollIntoView({ block: "start" })`);
await sleep(150);
await shot("config-voix-zones-technique");

/* ═══════════════ Téléchargement des modèles (Lot 9, étape 3) ══════════════ */
console.log("\n═══ TÉLÉCHARGEMENT DES MODÈLES ═══");
writeTtsState({ kind: "ready", modelCount: 2 });
await setEnabled("on");
await gotoAssistant();
await sleep(400);

const READ_DOWNLOADS = `(() => {
  const root = document.getElementById("tts-downloads-root");
  if (!root) return { present: false };
  const rows = [...root.querySelectorAll(".tts-dl__item")];
  const rowOf = (label) => rows.find((r) => new RegExp(label).test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
  return {
    present: true,
    rows: rows.length,
    labels: rows.map((r) => r.querySelector(".tts-dl__label")?.textContent ?? ""),
    states: rows.map((r) => r.querySelector(".tts-dl__state")?.textContent ?? ""),
    metas: rows.map((r) => r.querySelector(".tts-dl__meta")?.textContent ?? ""),
    buttons: rows.map((r) => [...r.querySelectorAll("button")].map((b) => ({ text: b.textContent, disabled: b.disabled }))),
    hasProgress: !!root.querySelector(".tts-dl__progress-bar"),
    progressTag: root.querySelector(".tts-dl__progress-bar")?.tagName ?? null,
    progressMeta: root.querySelector(".tts-dl__progress-meta")?.textContent ?? "",
    excludedText: root.querySelector(".tts-dl__excluded")?.textContent ?? "",
    excludedButtons: root.querySelectorAll(".tts-dl__excluded button").length,
    kokoroButton: rowOf("Kokoro") ? [...rowOf("Kokoro").querySelectorAll("button")].map((b) => b.textContent) : [],
    styleAttrs: root.querySelectorAll("[style]").length,
    styleElems: root.querySelectorAll("style").length,
  };
})()`;

let dl = await evaluate(READ_DOWNLOADS);
check(
  "[/config] téléchargement : catalogue affiché (4 modèles + taille/licence)",
  dl.present && dl.rows === 4 && dl.labels.some((l) => /Chatterbox/.test(l)) && dl.metas.some((m) => /licence MIT/.test(m)),
  JSON.stringify({ rows: dl.rows, labels: dl.labels }),
);
check(
  "[/config] téléchargement : badge « À télécharger » avant tout transfert",
  dl.states.every((s) => s === "À télécharger") && dl.buttons.every((bs) => bs.some((b) => b.text === "Télécharger")),
  JSON.stringify({ states: dl.states, buttons: dl.buttons }),
);
check(
  "[/config] téléchargement : modèles écartés visibles AVEC leur raison, SANS bouton",
  /sanoTTS/.test(dl.excludedText) && /GPL-3\.0/.test(dl.excludedText) && dl.excludedButtons === 0,
  JSON.stringify({ excluded: dl.excludedText.slice(0, 160), buttons: dl.excludedButtons }),
);
check(
  "[/config] téléchargement : zéro <style> / attribut style dans le bloc",
  dl.styleAttrs === 0 && dl.styleElems === 0,
  `style=${dl.styleElems} attrs=${dl.styleAttrs}`,
);

/* — Démarrer le téléchargement SIMULÉ (≈ 2 s) depuis le bouton de la ligne. — */
const startClicked = await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
  const row = rows.find((r) => /Kokoro/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
  const btn = row?.querySelector("button");
  if (!btn) return { clicked: false };
  btn.click();
  return { clicked: true, text: btn.textContent };
})()`);
check(
  "[/config] téléchargement : le bouton « Télécharger » démarre le transfert (202)",
  startClicked.clicked === true && startClicked.text === "Télécharger",
  JSON.stringify(startClicked),
);

await sleep(700);
dl = await evaluate(READ_DOWNLOADS);
check(
  "[/config] téléchargement : progression affichée (barre native + octets/total)",
  dl.hasProgress && dl.progressTag === "PROGRESS" && /o \/ /.test(dl.progressMeta),
  JSON.stringify({ hasProgress: dl.hasProgress, tag: dl.progressTag, meta: dl.progressMeta }),
);
check(
  "[/config] téléchargement : pendant le transfert, les autres sont désactivés",
  dl.buttons.some((bs) => bs.some((b) => b.text === "Télécharger" && b.disabled === true)),
  JSON.stringify(dl.buttons),
);

/* — Survie au rechargement : la progression se REPREND depuis l'état serveur. — */
await gotoAssistant();
dl = await evaluate(READ_DOWNLOADS);
check(
  "[/config] téléchargement : progression REPRISE après rechargement de page",
  dl.hasProgress === true,
  JSON.stringify({ hasProgress: dl.hasProgress, meta: dl.progressMeta }),
);
await evaluate(`document.getElementById("tts-engine-root").querySelector("details.config-advanced").open = true`);
await evaluate(`document.getElementById("tts-downloads-root").scrollIntoView({ block: "start" })`);
await sleep(200);
await shot("config-voix-downloads-progress");

/* — Attendre la fin, puis « Déclarer ce modèle ». — */
let declared = null;
for (let i = 0; i < 40; i += 1) {
  await sleep(300);
  dl = await evaluate(READ_DOWNLOADS);
  if (dl.kokoroButton.includes("Déclarer ce modèle")) {
    declared = dl;
    break;
  }
}
check(
  "[/config] téléchargement : état `done` → badge « Téléchargé » + bouton « Déclarer ce modèle »",
  declared !== null && declared.states.includes("Téléchargé"),
  JSON.stringify({ states: dl.states, kokoroButton: dl.kokoroButton }),
);

await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
  const row = rows.find((r) => /Kokoro/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
  [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Déclarer ce modèle")?.click();
})()`);
await sleep(250);
const declareModal = await evaluate(`(() => ({
  open: !!document.querySelector(".holaf-modal-root"),
  hasPrimary: !!document.querySelector(".holaf-modal-btn-primary"),
}))()`);
check(
  "[/config] téléchargement : « Déclarer ce modèle » ouvre la confirmation HolafModal (pas window.confirm)",
  declareModal.open && declareModal.hasPrimary,
  JSON.stringify(declareModal),
);
await evaluate(`document.querySelector(".holaf-modal-btn-primary")?.click()`);
await sleep(900);
check(
  "[/config] téléchargement : confirmation → modèle DÉCLARÉ (badge + bouton « Choisir comme moteur »)",
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
    const row = rows.find((r) => /Kokoro/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
    return (row?.querySelector(".tts-dl__state")?.textContent ?? "") === "Déclaré" &&
      [...(row?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Choisir comme moteur");
  })()`),
);

/* — « Choisir comme moteur » : écrit `tts.engine` via l'enregistrement global. — */
await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
  const row = rows.find((r) => /Kokoro/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
  [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Choisir comme moteur")?.click();
})()`);
await sleep(1000);
const engineAfterActivate = await evaluate(
  `fetch("/api/config").then((r) => r.json()).then((b) => b.fields["tts.engine"].value)`,
  true,
);
check(
  "[/config] téléchargement : « Choisir comme moteur » écrit tts.engine (chemin d'écriture global)",
  engineAfterActivate === "kokoro",
  `engine=${engineAfterActivate}`,
);
await evaluate(`document.getElementById("tts-downloads-root").scrollIntoView({ block: "start" })`);
await sleep(200);
await shot("config-voix-downloads-declare");

/* — Cohérence : un téléchargement actif REFUSE le redémarrage (409, pas une panne). — */
await gotoAssistant();
await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
  const row = rows.find((r) => /Qwen3/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
  [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Télécharger")?.click();
})()`);
await sleep(600);
const restartRefused = await evaluate(
  `fetch("/api/admin/restart", { method: "POST", headers: { "x-yuki-config": "1" } })
     .then((r) => r.json().then((b) => ({ status: r.status, code: b.code })))`,
  true,
);
check(
  "[/config] redémarrage pendant un téléchargement → 409 download_in_progress (protection, pas panne)",
  restartRefused.status === 409 && restartRefused.code === "download_in_progress",
  JSON.stringify(restartRefused),
);

/* — Propre : annuler le transfert en cours. — */
await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
  const row = rows.find((r) => /Qwen3/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
  [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Annuler")?.click();
})()`);
await sleep(250);
await evaluate(`document.querySelector(".holaf-modal-btn-primary")?.click()`);
await sleep(600);
const cancelled = await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
  const row = rows.find((r) => /Qwen3/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
  return {
    state: row?.querySelector(".tts-dl__state")?.textContent ?? "",
    button: [...(row?.querySelectorAll("button") ?? [])].map((b) => b.textContent),
    note: row?.querySelector(".tts-dl__task-note")?.textContent ?? "",
  };
})()`);
check(
  "[/config] téléchargement : « Annuler » (confirmation) → état annulé + proposition de reprise",
  /annul/i.test(cancelled.note) && cancelled.button.includes("Réessayer"),
  JSON.stringify(cancelled),
);

/* ═══ RÉGRESSION : « Déclarer » n'altère pas les entrées existantes ══════
 * Rapport production : une entrée existante a vu sa `family` écrasée par celle
 * du modèle déclaré (« chatterbox » → `qwen3_tts`). On fige ici deux entrées
 * (cosyvoice3 + kokoro), on télécharge + déclare CHATTERBOX via l'UI, puis on
 * prouve que les deux entrées existantes sont INCHANGÉES côté serveur. */
console.log("\n═══ RÉGRESSION : isolation des entrées models[] ═══");
const BASE_MODELS = [
  { id: "cosyvoice3", family: "cosyvoice3", task: "clon", mode: "offline", path: "/models/cosyvoice3.gguf" },
  { id: "kokoro", family: "kokoro_tts", task: "tts", mode: "offline", path: "/models/kokoro.gguf" },
];
const baseStatus = await evaluate(
  `fetch("/api/tts/engine-config", { method: "PUT", headers: { "content-type": "application/json", "x-yuki-config": "1" }, body: JSON.stringify({ models: ${JSON.stringify(BASE_MODELS)} }) }).then((r) => r.status)`,
  true,
);
await gotoAssistant();
const editorBefore = await evaluate(`(() => {
  const cards = [...document.querySelectorAll("#panel-voix .tts-engine-config .tts-engine-config__model")];
  return cards.map((c) => {
    const s = [...c.querySelectorAll("select")];
    return { id: c.querySelector("input")?.value, family: s[0]?.value, task: s[1]?.value, mode: s[2]?.value, path: s[3]?.value };
  });
})()`);
check(
  "[/config] RÉGRESSION : les 2 entrées existantes sont rendues fidèlement avant de déclarer",
  baseStatus === 200 && editorBefore.length === 2 && editorBefore[0].family === "cosyvoice3" &&
    editorBefore[1].family === "kokoro_tts",
  JSON.stringify({ baseStatus, editorBefore }),
);
await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
  const row = rows.find((r) => /Chatterbox/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
  [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Télécharger")?.click();
})()`);
let chatterDeclarable = false;
for (let i = 0; i < 40; i += 1) {
  await sleep(300);
  chatterDeclarable = await evaluate(`(() => {
    const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
    const row = rows.find((r) => /Chatterbox/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
    return [...(row?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Déclarer ce modèle");
  })()`);
  if (chatterDeclarable) break;
}
await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
  const row = rows.find((r) => /Chatterbox/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
  [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Déclarer ce modèle")?.click();
})()`);
await sleep(250);
await evaluate(`document.querySelector(".holaf-modal-btn-primary")?.click()`);
await sleep(1200);
const afterRegression = await evaluate(
  `fetch("/api/tts/engine-config").then((r) => r.json()).then((b) => b.models.map((m) => ({ id: m.id, family: m.family, task: m.task, mode: m.mode, path: m.path })))`,
  true,
);
const byId = (id) => afterRegression.find((m) => m.id === id);
const chatterEntry = byId("chatterbox");
check(
  "[/config] RÉGRESSION : déclarer Chatterbox n'altère PAS cosyvoice3/kokoro (family/task/mode/path)",
  chatterDeclarable &&
    JSON.stringify(byId("cosyvoice3")) === JSON.stringify(BASE_MODELS[0]) &&
    JSON.stringify(byId("kokoro")) === JSON.stringify(BASE_MODELS[1]) &&
    chatterEntry?.family === "chatterbox" &&
    chatterEntry?.task === "clon" &&
    chatterEntry?.mode === "offline" &&
    chatterEntry?.path === "/models/downloads/chatterbox/model.gguf",
  JSON.stringify(afterRegression),
);
const guardRejected = await evaluate(
  `fetch("/api/tts/engine-config", { method: "PUT", headers: { "content-type": "application/json", "x-yuki-config": "1" }, body: JSON.stringify({ models: [{ id: "chatterbox", family: "qwen3_tts", task: "clon", mode: "offline", path: "/models/downloads/chatterbox/model.gguf" }] }) }).then(async (r) => ({ status: r.status, body: await r.json() }))`,
  true,
);
check(
  "[/config] garde-fou serveur : famille incohérente pour un chemin du catalogue → 400 nommant chemin/attendue/reçue",
  guardRejected.status === 400 &&
    /chatterbox/.test(guardRejected.body?.message ?? "") &&
    /qwen3_tts/.test(guardRejected.body?.message ?? "") &&
    /downloads\/chatterbox\/model\.gguf/.test(guardRejected.body?.message ?? ""),
  JSON.stringify(guardRejected).slice(0, 320),
);

/* ═══ RÉGRESSION D86 : PARCOURS COMPLET — AUCUNE famille croisée ══════════
 * Parcours exact du rapport : 3 entrées déclarées (dont `chatterbox`), on
 * TÉLÉCHARGE Qwen, on le DÉCLARE, on le CHOISIT COMME MOTEUR, puis on
 * ENREGISTRE la configuration du moteur. Après CHAQUE étape, la famille, la
 * tâche, le mode et le chemin de CHAQUE entrée sont vérifiés (écran ET serveur) :
 * aucun geste de l'UI ne peut écrire la valeur d'une ligne dans une autre. */
console.log("\n═══ RÉGRESSION D86 : parcours complet (aucune famille croisée) ═══");
const THREE_MODELS = [
  { id: "chatterbox", family: "chatterbox", task: "clon", mode: "offline", path: "/models/chatterbox-q8_0.gguf" },
  { id: "cosyvoice3", family: "cosyvoice3", task: "clon", mode: "offline", path: "/models/cosyvoice3-q8_0.gguf" },
  { id: "kokoro", family: "kokoro_tts", task: "tts", mode: "offline", path: "/models/kokoro-82m-q8_0.gguf" },
];
await evaluate(
  `fetch("/api/tts/engine-config", { method: "PUT", headers: { "content-type": "application/json", "x-yuki-config": "1" }, body: JSON.stringify({ models: ${JSON.stringify(THREE_MODELS)} }) }).then((r) => r.status)`,
  true,
);
await gotoAssistant();
const READ_EDITOR_MODELS = `(() => {
  const cards = [...document.querySelectorAll("#panel-voix .tts-engine-config .tts-engine-config__model")];
  return cards.map((c) => {
    const s = [...c.querySelectorAll("select")];
    return { id: c.querySelector("input")?.value, family: s[0]?.value, task: s[1]?.value, mode: s[2]?.value, path: s[3]?.value };
  });
})()`;
const READ_SERVER_MODELS = `fetch("/api/tts/engine-config").then((r) => r.json()).then((b) => b.models.map((m) => ({ id: m.id, family: m.family, task: m.task, mode: m.mode, path: m.path })))`;
/** Les 3 entrées NON concernées sont-elles EXACTEMENT intactes ? */
const threeUntouched = (entries) =>
  entries.length >= 3 &&
  THREE_MODELS.every(
    (expected) => JSON.stringify(entries.find((e) => e.id === expected.id)) === JSON.stringify(expected),
  );
const qwenEntryOf = (entries) => entries.find((e) => e.id === "qwen3-tts") ?? null;

let editorModels = await evaluate(READ_EDITOR_MODELS);
let serverModels = await evaluate(READ_SERVER_MODELS, true);
check(
  "[/config] D86.0 : 3 entrées déclarées rendues fidèlement (écran + serveur)",
  threeUntouched(editorModels) && threeUntouched(serverModels),
  JSON.stringify({ editorModels, serverModels }),
);

/* — 1) TÉLÉCHARGER Qwen (ou reprendre un transfert déjà terminé). — */
await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
  const row = rows.find((r) => /Qwen3/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
  if ([...(row?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Déclarer ce modèle")) return;
  const start = [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Télécharger" || b.textContent === "Réessayer");
  start?.click();
})()`);
for (let i = 0; i < 60; i += 1) {
  await sleep(300);
  const ready = await evaluate(`(() => {
    const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
    const row = rows.find((r) => /Qwen3/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
    return [...(row?.querySelectorAll("button") ?? [])].some((b) => b.textContent === "Déclarer ce modèle");
  })()`);
  if (ready) break;
}
editorModels = await evaluate(READ_EDITOR_MODELS);
serverModels = await evaluate(READ_SERVER_MODELS, true);
check(
  "[/config] D86.1 : après TÉLÉCHARGEMENT de Qwen, les 3 entrées restent intactes",
  threeUntouched(editorModels) && threeUntouched(serverModels),
  JSON.stringify({ editorModels, serverModels }),
);

/* — 2) DÉCLARER Qwen. — */
await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
  const row = rows.find((r) => /Qwen3/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
  [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Déclarer ce modèle")?.click();
})()`);
await sleep(250);
await evaluate(`document.querySelector(".holaf-modal-btn-primary")?.click()`);
await sleep(1400);
editorModels = await evaluate(READ_EDITOR_MODELS);
serverModels = await evaluate(READ_SERVER_MODELS, true);
check(
  "[/config] D86.2 : après DÉCLARATION de Qwen, les 3 entrées restent intactes (écran + serveur)",
  threeUntouched(editorModels) &&
    threeUntouched(serverModels) &&
    qwenEntryOf(serverModels)?.family === "qwen3_tts" &&
    qwenEntryOf(serverModels)?.task === "tts",
  JSON.stringify({ editorModels, serverModels }),
);

/* — 3) CHOISIR Qwen comme moteur actif. — */
await evaluate(`(() => {
  const rows = [...document.querySelectorAll("#tts-downloads-root .tts-dl__item")];
  const row = rows.find((r) => /Qwen3/.test(r.querySelector(".tts-dl__label")?.textContent ?? ""));
  [...(row?.querySelectorAll("button") ?? [])].find((b) => b.textContent === "Choisir comme moteur")?.click();
})()`);
await sleep(1400);
editorModels = await evaluate(READ_EDITOR_MODELS);
serverModels = await evaluate(READ_SERVER_MODELS, true);
check(
  "[/config] D86.3 : après « Choisir comme moteur » (Qwen), les 3 entrées restent intactes",
  threeUntouched(editorModels) && threeUntouched(serverModels),
  JSON.stringify({ editorModels, serverModels }),
);

/* — 4) ENREGISTRER la configuration du moteur. — */
await evaluate(`(() => {
  const save = [...document.querySelectorAll("#panel-voix .tts-engine-config button")].find((b) => b.textContent.includes("Enregistrer la configuration du moteur"));
  save?.click();
})()`);
await sleep(250);
await evaluate(`document.querySelector(".holaf-modal-btn-primary")?.click()`);
await sleep(1200);
editorModels = await evaluate(READ_EDITOR_MODELS);
serverModels = await evaluate(READ_SERVER_MODELS, true);
check(
  "[/config] D86.4 : après ENREGISTREMENT, les 3 entrées restent intactes (aucune famille croisée persistée)",
  threeUntouched(editorModels) && threeUntouched(serverModels),
  JSON.stringify({ editorModels, serverModels }),
);

/* — Garde-fou ÉLARGI : chemin MANUEL reconnu par le BASENAME du catalogue — */
const manualRejected = await evaluate(
  `fetch("/api/tts/engine-config", { method: "PUT", headers: { "content-type": "application/json", "x-yuki-config": "1" }, body: JSON.stringify({ models: [{ id: "chatterbox", family: "qwen3_tts", task: "tts", mode: "offline", path: "/models/chatterbox-q8_0.gguf" }] }) }).then(async (r) => ({ status: r.status, body: await r.json() }))`,
  true,
);
check(
  "[/config] garde-fou ÉLARGI : chemin MANUEL reconnu (basename) + famille incohérente → 400 nommant fichier/attendue/reçue",
  manualRejected.status === 400 &&
    /chatterbox-q8_0\.gguf/.test(manualRejected.body?.message ?? "") &&
    /qwen3_tts/.test(manualRejected.body?.message ?? "") &&
    /Corrigez la famille/.test(manualRejected.body?.message ?? ""),
  JSON.stringify(manualRejected).slice(0, 320),
);
const unknownAccepted = await evaluate(
  `fetch("/api/tts/engine-config", { method: "PUT", headers: { "content-type": "application/json", "x-yuki-config": "1" }, body: JSON.stringify({ models: [{ id: "perso", family: "kokoro_tts", task: "tts", mode: "streaming", path: "/models/mon-gguf-inconnu.gguf" }] }) }).then(async (r) => ({ status: r.status }))`,
  true,
);
check(
  "[/config] garde-fou ÉLARGI : chemin INCONNU (GGUF personnel) → accepté (200)",
  unknownAccepted.status === 200,
  JSON.stringify(unknownAccepted),
);

/* — Config DÉJÀ incohérente (héritée) : SIGNALÉE dans l'éditeur ET RÉPARABLE —
 * On écrit `server.json` DIRECTEMENT (état hérité d'avant le garde-fou, comme
 * chez l'utilisateur), puis on vérifie que l'éditeur l'affiche AVANT tout
 * enregistrement et que la correction est acceptée. */
writeFileSync(
  ENGINE_SERVER_JSON,
  `${JSON.stringify(
    {
      models: [
        {
          id: "chatterbox",
          family: "qwen3_tts",
          task: "clon",
          mode: "offline",
          path: "/models/chatterbox-q8_0.gguf",
        },
      ],
    },
    null,
    2,
  )}\n`,
);
await gotoAssistant();
const incoherentView = await evaluate(`(() => {
  const warn = document.querySelector("#panel-voix .tts-engine-config__coherence");
  const card = document.querySelector("#panel-voix .tts-engine-config__model");
  const selects = card ? [...card.querySelectorAll("select")] : [];
  return {
    hasWarn: !!warn,
    warnText: warn?.textContent ?? "",
    family: selects[0]?.value ?? null,
    path: selects[3]?.value ?? null,
  };
})()`);
check(
  "[/config] config DÉJÀ incohérente → SIGNALÉE dans l'éditeur avant enregistrement (famille incohérente affichée)",
  incoherentView.hasWarn &&
    /chatterbox/.test(incoherentView.warnText) &&
    incoherentView.family === "qwen3_tts",
  JSON.stringify(incoherentView).slice(0, 320),
);
await shot("config-engine-incoherent");
// Réparation : on corrige la famille dans l'éditeur puis on enregistre.
await evaluate(`(() => {
  const card = document.querySelector("#panel-voix .tts-engine-config__model");
  const select = card?.querySelectorAll("select")[0];
  if (select) {
    select.value = "chatterbox";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
})()`);
await sleep(150);
await evaluate(`(() => {
  const save = [...document.querySelectorAll("#panel-voix .tts-engine-config button")].find(
    (b) => b.textContent.includes("Enregistrer la configuration du moteur"),
  );
  save?.click();
})()`);
await sleep(200);
await evaluate(`document.querySelector(".holaf-modal-btn-primary")?.click()`);
await sleep(900);
const repaired = await evaluate(
  `fetch("/api/tts/engine-config").then((r) => r.json()).then((b) => ({ family: b.models[0]?.family, issues: b.models[0]?.coherenceIssues?.length ?? 0 }))`,
  true,
);
check(
  "[/config] config DÉJÀ incohérente → RÉPARABLE (enregistrement accepté, famille corrigée)",
  repaired.family === "chatterbox" && repaired.issues === 0,
  JSON.stringify(repaired),
);

/* — Nettoyage : l'état serveur persiste. On retire le modèle déclaré et on
 *   remet `tts.engine` par défaut pour ne pas polluer les vérifications
 *   suivantes (l'activation a déjà été PROUVÉE ci-dessus). — */
await evaluate(
  `fetch("/api/tts/engine-config", { method: "PUT", headers: { "content-type": "application/json", "x-yuki-config": "1" }, body: JSON.stringify({ models: [] }) }).then((r) => r.status)`,
  true,
);
await evaluate(
  `fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json", "x-yuki-config": "1" }, body: JSON.stringify({ "tts.engine": "chatterbox" }) }).then((r) => r.status)`,
  true,
);

console.log("\n═══ ASSISTANT TTS (Lot 8) ═══");

const READ_ASSISTANT = `(() => {
  const mount = document.getElementById("tts-assistant-root");
  // La zone ⑤ (technique) vit dans #tts-engine-root, dans le même #panel-voix :
  // on interroge le panneau ENTIER pour couvrir les deux points de montage.
  const root = document.getElementById("panel-voix");
  if (!mount || !root) return { hasRoot: false };
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

/* — « Activer la voix » : chemin d'écriture UNIQUE (enregistrement global),
 *   AUCUN redémarrage silencieux, guidage explicite vers Maintenance. — */
await evaluate(
  `(() => { const b = [...document.querySelectorAll("#panel-voix button")].find((x) => x.textContent === "Activer la voix"); b?.click(); })()`,
);
await sleep(1200);
const enableResult = await evaluate(`(() => ({
  modal: !!document.querySelector(".holaf-modal-root"),
  cardStatus: document.querySelector("#panel-voix .tts-card__action-status")?.textContent ?? "",
  selectValue: (() => {
    const rows = [...document.querySelectorAll("#group-voix .config-row")];
    const row = rows.find((r) => r.querySelector(".config-label")?.textContent?.includes("Activer la voix"));
    return row?.querySelector("select")?.value ?? null;
  })(),
  saveStatus: document.getElementById("save-status")?.textContent ?? "",
}))()`);
const enabledServer = await evaluate(
  `fetch("/api/config").then((r) => r.json()).then((b) => b.fields["tts.enabled"].value)`,
  true,
);
const aliveAfterEnable = await evaluate(
  `fetch("/health/live").then((r) => r.ok).catch(() => false)`,
  true,
);
check(
  "[/config] « Activer la voix » : AUCUNE modale, écrit via l'enregistrement global (tts.enabled=on)",
  enableResult.modal === false &&
    enableResult.selectValue === "on" &&
    enabledServer === "on" &&
    /Enregistré/.test(enableResult.saveStatus),
  JSON.stringify({ ...enableResult, enabledServer }),
);
check(
  "[/config] « Activer la voix » : aucun redémarrage silencieux + guide explicite vers Maintenance",
  aliveAfterEnable === true &&
    /Maintenance/.test(enableResult.cardStatus) &&
    /[Rr]ed[ée]marr/.test(enableResult.cardStatus),
  `alive=${aliveAfterEnable} cardStatus=${JSON.stringify(enableResult.cardStatus)}`,
);

/* — « Tester la voix » : texte libre → WAV lu par Web Audio, voix/moteur affichés — */
await setEnabled("on");
writeTtsState({ kind: "ready", modelCount: 1 });
await gotoAssistant();
await evaluate(
  `(() => { const t = document.getElementById("tts-test-text"); t.value = "Bonjour, ceci est un test."; t.dispatchEvent(new Event("input")); })()`,
);
await evaluate(
  `(() => { const b = [...document.querySelectorAll("#panel-voix button")].find((x) => x.textContent === "Tester la voix"); b?.click(); })()`,
);
await sleep(1500);
const testResult = await evaluate(`(() => ({
  text: document.querySelector("#panel-voix .tts-test__feedback")?.textContent ?? "",
  error: !!document.querySelector("#panel-voix .tts-test__error"),
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
  `(() => { const b = [...document.querySelectorAll("#panel-voix button")].find((x) => x.textContent === "Tester la voix"); b?.click(); })()`,
);
await sleep(300);
const tooLongMessage = await evaluate(
  `document.querySelector("#panel-voix .tts-test__error")?.textContent ?? ""`,
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
  `(() => { const b = [...document.querySelectorAll("#panel-voix button")].find((x) => x.textContent === "Tester la voix"); b?.click(); })()`,
);
await sleep(1500);
const unknownShapeTest = await evaluate(`(() => ({
  text: document.querySelector("#panel-voix .tts-test__feedback")?.textContent ?? "",
  error: !!document.querySelector("#panel-voix .tts-test__error"),
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

/* ═══════════════ Éditeur STRUCTURÉ du moteur (Lot 9) ═════════════════════
 * Exerce réellement le formulaire : ajout d'un modèle, bascule de famille et
 * auto-correction du mode. C'est exactement le code qui plantait quand
 * `ENGINE_FORCE_OFFLINE_FAMILIES` n'était pas importé : une famille « forcée
 * offline » (chatterbox/cosyvoice3) qui repasse en `offline` prouve que le
 * listener s'exécute sans lever d'exception. */
writeTtsState({ kind: "ready", modelCount: 2 });
await gotoAssistant();
const engineEditor = await evaluate(`(() => {
  const body = document.querySelector("#panel-voix .tts-engine-config");
  if (!body) return { hasSection: false };
  const add = [...body.querySelectorAll("button")].find((b) => b.textContent === "Ajouter un modèle");
  if (!add) return { hasSection: true, hasAdd: false };
  add.click();
  const card = body.querySelector(".tts-engine-config__model");
  if (!card) return { hasSection: true, hasAdd: true, hasCard: false };
  const selectsOf = () => [...body.querySelector(".tts-engine-config__model").querySelectorAll("select")];
  // 1) famille NON forcée (kokoro) → autoriser un mode streaming
  selectsOf()[0].value = "kokoro";
  selectsOf()[0].dispatchEvent(new Event("change", { bubbles: true }));
  selectsOf()[2].value = "streaming";
  selectsOf()[2].dispatchEvent(new Event("change", { bubbles: true }));
  const streamingMode = selectsOf()[2].value;
  // 2) famille forcée (chatterbox) → le mode DOIT redevenir offline
  selectsOf()[0].value = "chatterbox";
  selectsOf()[0].dispatchEvent(new Event("change", { bubbles: true }));
  const after = selectsOf();
  return {
    hasSection: true,
    hasAdd: true,
    hasCard: true,
    streamingMode,
    family: after[0].value,
    task: after[1].value,
    mode: after[2].value,
    hasSave: [...body.querySelectorAll("button")].some((b) =>
      b.textContent.includes("Enregistrer la configuration du moteur")),
  };
})()`);
check(
  "[/config] éditeur moteur (Lot 9) : ajout d'un modèle + listes fermées présentes",
  engineEditor.hasSection &&
    engineEditor.hasAdd &&
    engineEditor.hasCard &&
    engineEditor.hasSave &&
    engineEditor.task === "clon",
  JSON.stringify(engineEditor),
);
check(
  "[/config] éditeur moteur : chatterbox force le mode « offline » (code du bug historique)",
  engineEditor.streamingMode === "streaming" &&
    engineEditor.family === "chatterbox" &&
    engineEditor.mode === "offline",
  JSON.stringify({
    streamingMode: engineEditor.streamingMode,
    family: engineEditor.family,
    mode: engineEditor.mode,
  }),
);

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

check(
  "ZÉRO exception JS non capturée (erreur de module, symbole non défini, listener)",
  pageExceptions.length === 0,
  pageExceptions.map((e) => `${e.text} (${e.url}:${e.line})`).join(" | ").slice(0, 400),
);

const failed = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} vérifications OK ; ` +
    `violations CSP = ${cspViolations.length} ; exceptions JS = ${pageExceptions.length} ═══`,
);

chrome.kill("SIGKILL");
server.kill("SIGTERM");
process.exit(
  failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1,
);
