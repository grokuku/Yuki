#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — VIGNETTE D'IMAGE BORNÉE + VISIONNEUSE PLEIN ÉCRAN.
 *
 * Prouve, par MESURE (Chromium headless + CDP), avec la CSP RÉELLE :
 *   - la VIGNETTE est bornée : hauteur ≤ 320 px sur BUREAU, ≤ 220 px sur
 *     TÉLÉPHONE (mesure réelle des `getBoundingClientRect()`), et le rapport
 *     largeur/hauteur affiché est CELUI DE L'IMAGE (aucune déformation) ;
 *   - le CLIC sur la vignette ouvre une SURCOUCHE PLEIN ÉCRAN, l'image y est
 *     ENTIÈRE et non déformée ;
 *   - ⚠️ PIÈGE ① : `scrollTop` du fil IDENTIQUE avant/après ouverture ET
 *     fermeture (aucun décalage, l'état STICKY et le bouton « revenir en bas »
 *     ne peuvent pas être cassés : le calque est hors du fil) ;
 *   - Échap, clic à côté et bouton « Fermer » ferment tous les trois ;
 *   - ZOOM : clic sur l'image (contain ↔ taille réelle), molette, et PINCEment à
 *     deux doigts (téléphone simulé : `Input.dispatchTouchEvent`) ;
 *   - DÉPLACEMENT : glisser déplace l'image zoomée, BORNÉ (elle ne sort jamais de
 *     la vue) ;
 *   - NAVIGATION entre plusieurs images : boutons ‹ › et flèches du clavier ;
 *   - la FICHE (prompt final) reste SOUS l'image, vignette comprise ;
 *   - au RECHARGEMENT, c'est TOUJOURS une vignette bornée ;
 *   - ZÉRO violation CSP, ZÉRO exception JS, ZÉRO erreur de connexion.
 *
 * ⚠️ L'image du faux ComfyUI fait 64×64 : elle ne prouverait RIEN sur la borne
 * de hauteur (une image de 6 Mpx, elle, écrasait le fil). Le harnais REMPLACE donc
 * la source de l'image affichée par un `data:image/png` de 1600×1200 produit par
 * un `<canvas>` DANS LA PAGE — même élément `<img>`, même vignette, mais une
 * taille NATURELLE réaliste (autorisée par `img-src 'self' data:`).
 *
 * ⚠️ Aucune capture PNG suivie : tout va dans un dossier TEMPORAIRE.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-lightbox.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { collectViolations } from "./browser-violations.mjs";

const TOOLS = import.meta.dirname;
const WORKSPACE = join(TOOLS, "..");
const YUKI_DIR = join(WORKSPACE, "Yuki");
const TSX = join(YUKI_DIR, "node_modules", ".bin", "tsx");

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-lightbox-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

/** Workflow au FORMAT API : `YUKI_OUTPUT` (l'image) et `YUKI_FINAL_PROMPT` (la fiche). */
const WORKFLOW = {
  "enc-positif": {
    class_type: "CLIPTextEncode",
    inputs: { text: "text" },
    _meta: { title: "YUKI_PROMPT" },
  },
  "enc-negatif": {
    class_type: "CLIPTextEncode",
    inputs: { text: "" },
    _meta: { title: "YUKI_NEGATIVE" },
  },
  "ks-42": {
    class_type: "KSampler",
    inputs: { seed: 0, steps: 20 },
    _meta: { title: "YUKI_SEED" },
  },
  "latent-7": {
    class_type: "EmptyLatentImage",
    inputs: { width: 512, height: 512 },
    _meta: { title: "YUKI_WIDTH" },
  },
  "latent-h9": {
    class_type: "EmptyLatentImage",
    inputs: { height: 512 },
    _meta: { title: "YUKI_HEIGHT" },
  },
  "save-99": { class_type: "SaveImage", inputs: { filename_prefix: "Yuki" } },
  "enhancer-1709": {
    class_type: "AIHPromptEnhancer",
    inputs: { prompt: "text" },
    _meta: { title: "enhancer" },
  },
  "affichage-1858": {
    class_type: "AIHToText",
    inputs: { display_mode: "Auto", display_text: "", any_input: ["enhancer-1709", 0] },
    _meta: { title: "YUKI_FINAL_PROMPT" },
  },
  "save-inter": { class_type: "SaveImage", inputs: { filename_prefix: "Apercu" } },
  "preview-final": {
    class_type: "PreviewImage",
    inputs: { images: ["save-inter", 0] },
    _meta: { title: "YUKI_OUTPUT" },
  },
};

const SCENE = "Un chat noir sur un toit mouillé, lune basse, lumière froide.";
const SCENE2 = "Un phare isolé dans la brume, vagues lentes, aube grise.";

async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-image-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_IMAGE_DIR: STATE_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString()));
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("serveur non démarré :\n" + logs.join(""))), 60_000);
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
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-lightbox-chrome-"));
const chrome = spawn(
  "/usr/bin/chromium",
  [
    "--headless",
    "--no-sandbox",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    // ⚠️ TAILLE de la fenêtre ET capacités du pointeur RÉELLES du bureau :
    // Chromium headless se déclare sinon SANS souris (`hover: none`), et l'on ne
    // pourrait pas prouver que l'indice de clic n'apparaît qu'au survol sur
    // bureau (alors qu'il reste visible au doigt).
    "--window-size=1280,900",
    "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
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

/**
 * Bascule la fenêtre en TÉLÉPHONE (même seuil que le CSS : 767 px).
 *
 * ⚠️ Le BUREAU n'utilise AUCUNE émulation de métriques : il garde la fenêtre
 * réelle (1280 px) et donc les capacités RÉELLES d'un bureau (`hover: hover`,
 * `pointer: fine`). `Emulation.setDeviceMetricsOverride` rendrait la page
 * « sans souris » (`hover: none`) et fausserait la mesure de l'indice de clic.
 */
async function setMobileViewport({ width = 390, height = 844 } = {}) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await sleep(200);
}
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
  await sleep(700);
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
    await sleep(100);
  }
  return false;
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
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
}

/* ─── Entrées RÉELLES (souris, doigt, clavier) ───────────────────────────── */
async function mouseClick(x, y) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(150);
}

async function mouseDrag(from, to, steps = 6) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= steps; i += 1) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1 });
    await sleep(16);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
  await sleep(150);
}

/** Un TAP (doigt) : `touchStart` puis `touchEnd`. */
async function tap(x, y) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: 1 }] });
  await sleep(40);
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(200);
}

/**
 * PINCEMENT à deux doigts : les deux points s'écartent (ou se rapprochent) de
 * `from` à `to` px de part et d'autre du centre, en `steps` étapes.
 */
async function pinch(center, from, to, steps = 8) {
  const point = (dx, id) => ({ x: center.x + dx, y: center.y, id });
  await send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point(-from, 1), point(from, 2)],
  });
  await sleep(40);
  for (let i = 1; i <= steps; i += 1) {
    const d = from + ((to - from) * i) / steps;
    await send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [point(-d, 1), point(d, 2)],
    });
    await sleep(24);
  }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await sleep(200);
}

async function pressKey(key, code, keyCode) {
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  });
  await sleep(150);
}

/* ─── Aides de mesure ────────────────────────────────────────────────────── */

/** Attend le DÉCODAGE RÉEL de l'image de la vignette. */
async function waitForThumbDecoded(timeout = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const status = await evaluate(`(async () => {
      const img = document.querySelector('.generated-image__image');
      if (!img) return 'absent';
      try { await img.decode(); } catch { return 'broken'; }
      return (img.complete && img.naturalWidth > 0) ? 'ready' : 'pending';
    })()`);
    if (status === "ready") return true;
    if (status === "broken" || status === "absent") return false;
    await sleep(50);
  }
  return false;
}

/**
 * Remplace la source de la vignette par une image 1600×1200 produite par un
 * `<canvas>` : c'est la taille NATURELLE qui compte (celle des images générées),
 * pas la 64×64 du faux ComfyUI.
 */
async function useBigImage(width = 1600, height = 1200) {
  return evaluate(`(async () => {
    const img = document.querySelector('.generated-image__image');
    if (!img) return { ok: false, reason: 'image absente' };
    const canvas = document.createElement('canvas');
    canvas.width = ${width};
    canvas.height = ${height};
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, ${width}, ${height});
    grad.addColorStop(0, '#22304a');
    grad.addColorStop(1, '#e0c070');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, ${width}, ${height});
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(${width}, ${height});
    ctx.stroke();
    const url = canvas.toDataURL('image/png');
    await new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true });
      img.src = url;
    });
    try { await img.decode(); } catch {}
    return { ok: true, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight };
  })()`);
}

/** Mesure la vignette (première image générée) : taille, ratio, curseur, indice. */
async function measureThumb() {
  return evaluate(`(() => {
    const wrap = document.querySelector('.md-image-zoom');
    const img = document.querySelector('.generated-image__image');
    if (!wrap || !img) return { present: false };
    const r = img.getBoundingClientRect();
    const block = document.querySelector('.generated-image');
    const blockRect = block ? block.getBoundingClientRect() : null;
    const style = getComputedStyle(img);
    const hint = wrap.querySelector('.md-image-zoom__hint');
    return {
      present: true,
      height: r.height,
      width: r.width,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      insideBlock: blockRect ? r.right <= blockRect.right + 0.5 : false,
      cursor: getComputedStyle(wrap).cursor,
      objectFit: style.objectFit,
      inlineStyle: img.getAttribute('style'),
      hintSvg: Boolean(hint && hint.querySelector('svg')),
      hintOpacity: hint ? Number(getComputedStyle(hint).opacity) : null,
      wrapTag: wrap.tagName,
      wrapRole: wrap.getAttribute('type'),
      wrapLabel: wrap.getAttribute('aria-label'),
      center: { x: r.left + r.width / 2, y: r.top + r.height / 2 },
    };
  })()`);
}

/** Mesure le calque : présence, image entière, ratio, échelle, géométrie. */
async function measureLightbox() {
  return evaluate(`(() => {
    const overlay = document.querySelector('.lightbox');
    if (!overlay) return { open: false, count: document.querySelectorAll('.lightbox').length };
    const stage = overlay.querySelector('.lightbox__stage');
    const img = overlay.querySelector('.lightbox__img');
    const close = overlay.querySelector('.lightbox__close');
    const prev = overlay.querySelector('.lightbox__nav--prev');
    const next = overlay.querySelector('.lightbox__nav--next');
    const count = overlay.querySelector('.lightbox__count');
    const st = stage ? stage.getBoundingClientRect() : null;
    const r = img ? img.getBoundingClientRect() : null;
    const cr = close ? close.getBoundingClientRect() : null;
    const matrix = img ? getComputedStyle(img).transform : '';
    const scale = matrix && matrix !== 'none' ? Number(matrix.split('(')[1].split(',')[0]) : 1;
    return {
      open: true,
      count: document.querySelectorAll('.lightbox').length,
      role: overlay.getAttribute('role'),
      ariaModal: overlay.getAttribute('aria-modal'),
      imgLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
      naturalWidth: img ? img.naturalWidth : 0,
      naturalHeight: img ? img.naturalHeight : 0,
      rect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null,
      stage: st ? { left: st.left, top: st.top, right: st.right, bottom: st.bottom, width: st.width, height: st.height } : null,
      entire: Boolean(r && st) && r.left >= st.left - 0.5 && r.top >= st.top - 0.5 && r.right <= st.right + 0.5 && r.bottom <= st.bottom + 0.5,
      scale,
      objectFit: img ? getComputedStyle(img).objectFit : null,
      closeVisible: Boolean(cr && cr.width >= 40 && srInViewport(cr)),
      prevHidden: prev ? prev.hidden : null,
      nextHidden: next ? next.hidden : null,
      counter: count ? count.textContent : null,
      src: img ? (img.getAttribute('src') || '').slice(0, 40) : null,
      activeTag: document.activeElement ? document.activeElement.className : null,
    };
    function srInViewport(box) {
      return box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth + 0.5 && box.bottom <= window.innerHeight + 0.5;
    }
  })()`);
}

const ratio = (w, h) => (Number(h) > 0 ? w / h : 0);
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

/* ═════════ 1) Import du workflow par la route RÉELLE ═════════════════════ */
const imported = await fetch(`${server.base}/api/images/workflows`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-yuki-config": "1" },
  body: JSON.stringify({
    name: "manga",
    description: "Manga / anime",
    workflow: WORKFLOW,
    isDefault: true,
  }),
});
const importedBody = await imported.json();
check(
  "workflow importé (route réelle) avec ses sept étiquettes",
  imported.status === 200 && importedBody.workflow?.found?.length === 7,
  JSON.stringify(importedBody.workflow?.found),
);

/* ═════════ 2) Deux images DANS le fil ════════════════════════════════════ */
await navigate(`${server.base}/`);
await waitFor(`!!document.querySelector('#conversation')`);
for (const scene of [SCENE, SCENE2]) {
  const generated = await fetch(
    `${server.base}/e2e/generate?scene=${encodeURIComponent(scene)}&style=${encodeURIComponent("manga")}`,
  ).then((r) => r.json());
  check(`génération réelle (${scene.slice(0, 18)}…)`, generated.ok === true, JSON.stringify(generated).slice(0, 160));
}
const twoBlocks = await waitFor(`document.querySelectorAll('.generated-image').length === 2`, 15_000);
check("DEUX images générées sont affichées dans le fil", twoBlocks);
check("les deux images sont vraiment DÉCODÉES", await waitForThumbDecoded());

/* ═════════ 3) La VIGNETTE (bureau) ═══════════════════════════════════════ */
const big = await useBigImage(1600, 1200);
check(
  "image de test à taille RÉALISTE (1600×1200, comme une génération ~6 Mpx)",
  big.ok === true && big.naturalWidth === 1600 && big.naturalHeight === 1200,
  JSON.stringify(big),
);

const thumb = await measureThumb();
check("la vignette est un BOUTON (`.md-image-zoom`) qui enveloppe l'image", thumb.present && thumb.wrapTag === "BUTTON" && thumb.wrapRole === "button", String(thumb.wrapTag));
check(
  "vignette BUREAU : hauteur ≤ 320 px (mesure réelle)",
  thumb.present && thumb.height <= 320.5,
  `${thumb.height?.toFixed(1)} px`,
);
check(
  "vignette : largeur ≤ largeur du bloc (jamais de débordement du fil)",
  thumb.present && thumb.insideBlock === true,
  String(thumb.insideBlock),
);
check(
  "vignette : AUCUNE DÉFORMATION (ratio affiché === ratio d'origine)",
  thumb.present && near(ratio(thumb.width, thumb.height), ratio(thumb.naturalWidth, thumb.naturalHeight), 0.01),
  `${ratio(thumb.width, thumb.height).toFixed(4)} vs ${ratio(thumb.naturalWidth, thumb.naturalHeight).toFixed(4)}`,
);
check("vignette : `object-fit: contain` (jamais `fill`)", thumb.objectFit === "contain", String(thumb.objectFit));
check("vignette : curseur `zoom-in` sur bureau", thumb.cursor === "zoom-in", String(thumb.cursor));
check("vignette : l'image du fil n'a AUCUN attribut de style (CSP)", thumb.inlineStyle === null, String(thumb.inlineStyle));
check(
  "indice de clic DISCRET : pastille avec icône, invisible sans survol sur bureau",
  thumb.hintSvg === true && thumb.hintOpacity === 0,
  `svg=${String(thumb.hintSvg)} opacity=${String(thumb.hintOpacity)}`,
);
check(
  "bureau : le média `(hover: hover)` est bien celui qu'on mesure (sinon le test mentirait)",
  (await evaluate(`matchMedia('(hover: hover)').matches && window.innerWidth >= 1000`)) === true,
  await evaluate(`window.innerWidth + 'px / hover=' + matchMedia('(hover: hover)').matches`),
);
await send("Input.dispatchMouseEvent", {
  type: "mouseMoved",
  x: Math.round(thumb.center.x),
  y: Math.round(thumb.center.y),
  button: "none",
  buttons: 0,
});
await sleep(300);
const hovered = await evaluate(
  `Number(getComputedStyle(document.querySelector('.md-image-zoom__hint')).opacity)`,
);
check("indice de clic : il APPARAÎT au survol (on comprend qu'on peut cliquer)", hovered > 0.5, String(hovered));

const ficheUnder = await evaluate(`(() => {
  const img = document.querySelector('.generated-image__image');
  const fiche = document.querySelector('.generated-image__prompt');
  if (!img || !fiche) return { ok: false };
  const r = img.getBoundingClientRect();
  const f = fiche.getBoundingClientRect();
  return { ok: true, ficheTop: f.top, imageBottom: r.bottom, after: Boolean(img.compareDocumentPosition(fiche) & Node.DOCUMENT_POSITION_FOLLOWING) };
})()`);
check(
  "la FICHE (prompt final) reste SOUS l'image, vignette comprise",
  ficheUnder.ok === true && ficheUnder.ficheTop >= ficheUnder.imageBottom - 0.5 && ficheUnder.after === true,
  JSON.stringify({ ficheTop: ficheUnder.ficheTop, imageBottom: ficheUnder.imageBottom }),
);
await shot("lightbox-thumb-desktop");

/* ═════════ 4) Ouverture par un CLIC RÉEL, `scrollTop` mesuré ═════════════ */
// On rend le fil DÉFILABLE (comme une vraie conversation) en amont des blocs.
await evaluate(`(() => {
  const conv = document.querySelector('#conversation');
  for (let i = 0; i < 8; i += 1) {
    const filler = document.createElement('div');
    filler.className = 'message';
    filler.textContent = 'Remplissage ' + i + ' : ' + 'une phrase assez longue pour occuper de la place. '.repeat(4);
    conv.prepend(filler);
  }
  // On se place au MILIEU du fil : ni en haut, ni épinglé en bas.
  conv.scrollTop = Math.round((conv.scrollHeight - conv.clientHeight) * 0.45);
  return { scrollTop: conv.scrollTop, max: conv.scrollHeight - conv.clientHeight };
})()`);
await sleep(150);
// On amène la vignette à l'écran sans toucher au reste, puis on relève la position.
await evaluate(`(() => {
  const conv = document.querySelector('#conversation');
  const img = document.querySelector('.generated-image__image').getBoundingClientRect();
  const box = conv.getBoundingClientRect();
  conv.scrollTop += img.top - box.top - 120;
  return conv.scrollTop;
})()`);
await sleep(200);

const beforeOpen = await evaluate(`(() => {
  const conv = document.querySelector('#conversation');
  const r = document.querySelector('.generated-image__image').getBoundingClientRect();
  return { scrollTop: conv.scrollTop, x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
check(
  "fil RÉELLEMENT défilable avant la mesure (sinon le test ne prouverait rien)",
  beforeOpen.scrollTop > 0,
  `scrollTop=${beforeOpen.scrollTop}`,
);

await mouseClick(beforeOpen.x, beforeOpen.y);
const opened = await waitFor(`!!document.querySelector('.lightbox')`, 3000);
check("CLIC sur la vignette ⇒ la visionneuse s'ouvre (surcouche)", opened);
await waitFor(`(() => { const i = document.querySelector('.lightbox__img'); return Boolean(i && i.complete && i.naturalWidth > 0); })()`, 5000);

const lb = await measureLightbox();
check(
  "le calque est une SURCOUCHE de dialogue (`role=dialog`, `aria-modal=true`), une seule",
  lb.open === true && lb.count === 1 && lb.role === "dialog" && lb.ariaModal === "true",
  `role=${String(lb.role)} modal=${String(lb.ariaModal)}`,
);
check("l'image agrandie est réellement DÉCODÉE", lb.imgLoaded === true, `${lb.naturalWidth}×${lb.naturalHeight}`);
check(
  "l'image agrandie est ENTIÈRE dans la zone (aucun bord coupé)",
  lb.entire === true,
  JSON.stringify(lb.rect) + " dans " + JSON.stringify(lb.stage),
);
check(
  "l'image agrandie n'est PAS déformée (ratio conservé)",
  near(ratio(lb.rect.width, lb.rect.height), ratio(lb.naturalWidth, lb.naturalHeight), 0.01),
  `${ratio(lb.rect.width, lb.rect.height).toFixed(4)} vs ${ratio(lb.naturalWidth, lb.naturalHeight).toFixed(4)}`,
);
check("l'image agrandie est en `object-fit: contain` (jamais `fill`)", lb.objectFit === "contain", String(lb.objectFit));
check("le focus entre dans le calque (bouton de fermeture)", String(lb.activeTag).includes("lightbox__close"), String(lb.activeTag));

const afterOpen = await evaluate(`document.querySelector('#conversation').scrollTop`);
check(
  "⚠️ PIÈGE ① : `scrollTop` du fil IDENTIQUE après l'ouverture",
  afterOpen === beforeOpen.scrollTop,
  `${beforeOpen.scrollTop} → ${afterOpen}`,
);
await shot("lightbox-desktop-open");

/* ═════════ 5) ZOOM : clic ⇒ taille réelle, puis glisser ══════════════════ */
await mouseClick(lb.rect.left + lb.rect.width / 2, lb.rect.top + lb.rect.height / 2);
const zoomed = await measureLightbox();
check(
  "CLIC sur l'image ⇒ zoom « taille réelle » (l'échelle augmente vraiment)",
  zoomed.scale > 1.1,
  `scale=${zoomed.scale.toFixed(3)} (${zoomed.rect.width.toFixed(0)} px de large)`,
);
check(
  "au zoom, l'image n'est TOUJOURS pas déformée (ratio conservé)",
  near(ratio(zoomed.rect.width, zoomed.rect.height), ratio(zoomed.naturalWidth, zoomed.naturalHeight), 0.01),
  `${ratio(zoomed.rect.width, zoomed.rect.height).toFixed(4)}`,
);

const beforeDrag = await evaluate(`(() => {
  const r = document.querySelector('.lightbox__img').getBoundingClientRect();
  const s = document.querySelector('.lightbox__stage').getBoundingClientRect();
  return { left: r.left, top: r.top, stageLeft: s.left, stageTop: s.top, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
})()`);
const stageBox = zoomed.stage;
await mouseDrag(
  { x: Math.round(stageBox.left + stageBox.width / 2), y: Math.round(stageBox.top + stageBox.height / 2) },
  { x: Math.round(stageBox.left + stageBox.width / 2) + 120, y: Math.round(stageBox.top + stageBox.height / 2) + 60 },
);
const afterDrag = await evaluate(`(() => {
  const r = document.querySelector('.lightbox__img').getBoundingClientRect();
  return { left: r.left, top: r.top, open: Boolean(document.querySelector('.lightbox')) };
})()`);
check(
  "GLISSER déplace l'image zoomée (le déplacement est réel)",
  afterDrag.left > beforeDrag.left + 40 && afterDrag.top > beforeDrag.top + 20,
  `Δ=(${(afterDrag.left - beforeDrag.left).toFixed(0)}, ${(afterDrag.top - beforeDrag.top).toFixed(0)})`,
);
check("un glisser ne FERME pas le calque (le relâchement n'est pas un clic)", afterDrag.open === true);

// Déplacement EXCESSIF : l'image ne doit jamais quitter la zone.
await mouseDrag(
  { x: Math.round(stageBox.left + stageBox.width / 2), y: Math.round(stageBox.top + stageBox.height / 2) },
  { x: Math.round(stageBox.left + stageBox.width / 2) + 4000, y: Math.round(stageBox.top + stageBox.height / 2) + 4000 },
);
const clamped = await evaluate(`(() => {
  const r = document.querySelector('.lightbox__img').getBoundingClientRect();
  const s = document.querySelector('.lightbox__stage').getBoundingClientRect();
  return { left: r.left, top: r.top, stageLeft: s.left, stageTop: s.top };
})()`);
check(
  "déplacement BORNÉ : l'image ne laisse jamais de vide sur un bord",
  near(clamped.left, clamped.stageLeft, 1) && near(clamped.top, clamped.stageTop, 1),
  `image=(${clamped.left.toFixed(0)}, ${clamped.top.toFixed(0)}) zone=(${clamped.stageLeft.toFixed(0)}, ${clamped.stageTop.toFixed(0)})`,
);

/* ═════════ 6) Fermetures : Échap, clic à côté, bouton ════════════════════ */
await pressKey("Escape", "Escape", 27);
const afterEscape = await evaluate(`document.querySelectorAll('.lightbox').length`);
const scrollAfterEscape = await evaluate(`document.querySelector('#conversation').scrollTop`);
check("ÉCHAP ferme le calque", afterEscape === 0, `calques=${afterEscape}`);
check(
  "⚠️ PIÈGE ① : `scrollTop` du fil IDENTIQUE après FERMETURE",
  scrollAfterEscape === beforeOpen.scrollTop,
  `${beforeOpen.scrollTop} → ${scrollAfterEscape}`,
);
check(
  "⚠️ PIÈGE ④ : aucun nœud orphelin après fermeture",
  await evaluate(`!document.querySelector('.lightbox') && !document.querySelector('.lightbox__stage')`),
);

// Réouverture : clic à CÔTÉ (dans la bande haute, hors de l'image).
const thumb2 = await measureThumb();
await mouseClick(thumb2.center.x, thumb2.center.y);
await waitFor(`!!document.querySelector('.lightbox')`, 3000);
await mouseClick(Math.round((await evaluate(`window.innerWidth`)) / 2), 18);
const afterBackdrop = await evaluate(`document.querySelectorAll('.lightbox').length`);
check("CLIC À CÔTÉ (fond) ferme le calque", afterBackdrop === 0, `calques=${afterBackdrop}`);

// Réouverture : bouton de fermeture (il existe sans Échap, donc sur téléphone).
await mouseClick(thumb2.center.x, thumb2.center.y);
await waitFor(`!!document.querySelector('.lightbox')`, 3000);
const closeBox = await evaluate(`(() => {
  const b = document.querySelector('.lightbox__close').getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
})()`);
check("le bouton de fermeture est visible et atteignable (≥ 44 px)", closeBox.w >= 44 && closeBox.h >= 44, `${closeBox.w}×${closeBox.h}`);
await mouseClick(closeBox.x, closeBox.y);
const afterButton = await evaluate(`document.querySelectorAll('.lightbox').length`);
check("le BOUTON visible ferme le calque (indispensable sur téléphone)", afterButton === 0, `calques=${afterButton}`);

/* ═════════ 7) NAVIGATION entre images (boutons + clavier) ════════════════ */
await mouseClick(thumb2.center.x, thumb2.center.y);
await waitFor(`!!document.querySelector('.lightbox')`, 3000);
const nav = await measureLightbox();
check(
  "avec DEUX images, la navigation est proposée (compteur « 1 / 2 »)",
  nav.prevHidden === false && nav.nextHidden === false && nav.counter === "1 / 2",
  `compteur=${String(nav.counter)}`,
);
const nextBox = await evaluate(`(() => {
  const b = document.querySelector('.lightbox__nav--next').getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
})()`);
await mouseClick(nextBox.x, nextBox.y);
const second = await measureLightbox();
check(
  "le bouton « image suivante » affiche l'AUTRE image (compteur « 2 / 2 »)",
  second.counter === "2 / 2" && second.src !== nav.src,
  `compteur=${String(second.counter)}`,
);
await pressKey("ArrowLeft", "ArrowLeft", 37);
const backFirst = await measureLightbox();
check(
  "la flèche GAUCHE du clavier revient à la première image",
  backFirst.counter === "1 / 2" && backFirst.src === nav.src,
  `compteur=${String(backFirst.counter)}`,
);
await pressKey("Escape", "Escape", 27);
check("ÉCHAP ferme après navigation", (await evaluate(`document.querySelectorAll('.lightbox').length`)) === 0);

/* ═════════ 8) RECHARGEMENT : toujours une vignette bornée ════════════════ */
await navigate(`${server.base}/`);
const restored = await waitFortumbRestored();
check("RECHARGEMENT : les images du fil reviennent (même source same-origin)", restored);

async function waitFortumbRestored(timeout = 15_000) {
  return waitFor(`document.querySelectorAll('.generated-image').length === 2`, timeout);
}

await waitForThumbDecoded();
const bigAgain = await useBigImage(1600, 1200);
check("RECHARGEMENT : image de test remise à 1600×1200", bigAgain.ok === true);
const thumbAfterReload = await measureThumb();
check(
  "RECHARGEMENT : c'est TOUJOURS une vignette bornée (≤ 320 px) et non déformée",
  thumbAfterReload.present === true &&
    thumbAfterReload.height <= 320.5 &&
    near(
      ratio(thumbAfterReload.width, thumbAfterReload.height),
      ratio(thumbAfterReload.naturalWidth, thumbAfterReload.naturalHeight),
      0.01,
    ),
  `${thumbAfterReload.height?.toFixed(1)} px`,
);

/* ═════════ 9) TÉLÉPHONE : vignette plus petite, TAP, PINCE ═══════════════ */
await setMobileViewport();
await sleep(400);
await evaluate(`(() => {
  const conv = document.querySelector('#conversation');
  const img = document.querySelector('.generated-image__image').getBoundingClientRect();
  const box = conv.getBoundingClientRect();
  conv.scrollTop += img.top - box.top - 200;
  return conv.scrollTop;
})()`);
await sleep(250);

const mobileThumb = await measureThumb();
check(
  "TÉLÉPHONE : vignette ≤ 220 px de haut (l'image ne mange plus l'écran)",
  mobileThumb.present === true && mobileThumb.height <= 220.5,
  `${mobileThumb.height?.toFixed(1)} px`,
);
check(
  "TÉLÉPHONE : aucune déformation non plus",
  near(ratio(mobileThumb.width, mobileThumb.height), ratio(mobileThumb.naturalWidth, mobileThumb.naturalHeight), 0.01),
  `${ratio(mobileThumb.width, mobileThumb.height).toFixed(4)}`,
);
check(
  "TÉLÉPHONE : l'indice de clic est TOUJOURS visible (pas de survol)",
  mobileThumb.hintOpacity > 0.5 && (await evaluate(`matchMedia('(hover: none)').matches`)) === true,
  String(mobileThumb.hintOpacity),
);
check(
  "TÉLÉPHONE : le fil ne déborde pas horizontalement",
  await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 1`),
  String(await evaluate(`document.documentElement.scrollWidth + '/' + window.innerWidth`)),
);

const mobileBeforeOpen = await evaluate(`document.querySelector('#conversation').scrollTop`);
await tap(mobileThumb.center.x, mobileThumb.center.y);
const mobileOpened = await waitFor(`!!document.querySelector('.lightbox')`, 3000);
check("TÉLÉPHONE : un TAP sur la vignette ouvre la visionneuse", mobileOpened);
await waitFor(`(() => { const i = document.querySelector('.lightbox__img'); return Boolean(i && i.complete && i.naturalWidth > 0); })()`, 5000);

const mobileLb = await measureLightbox();
check(
  "TÉLÉPHONE : l'image est ENTIÈRE dans l'écran",
  mobileLb.entire === true,
  JSON.stringify(mobileLb.rect) + " dans " + JSON.stringify(mobileLb.stage),
);
check(
  "TÉLÉPHONE : le bouton de fermeture est DANS l'écran (pas d'Échap sur un téléphone)",
  mobileLb.closeVisible === true,
  String(mobileLb.closeVisible),
);
const mobileScrollAfter = await evaluate(`document.querySelector('#conversation').scrollTop`);
check(
  "TÉLÉPHONE : `scrollTop` du fil IDENTIQUE après ouverture",
  mobileScrollAfter === mobileBeforeOpen,
  `${mobileBeforeOpen} → ${mobileScrollAfter}`,
);

// TAP sur l'image ⇒ zoom.
await tap(
  mobileLb.stage.left + mobileLb.stage.width / 2,
  mobileLb.stage.top + mobileLb.stage.height / 2,
);
const mobileZoomed = await measureLightbox();
check(
  "TÉLÉPHONE : un TAP sur l'image agrandie zoome (échelle > 1)",
  mobileZoomed.scale > 1.05,
  `scale=${mobileZoomed.scale.toFixed(3)}`,
);

// PINCEMENT à deux doigts : il doit RÉAGIR dans les deux sens. On resserre
// d'abord les doigts (zoom arrière), puis on les écarte (zoom avant).
const pinchCenter = {
  x: Math.round(mobileZoomed.stage.left + mobileZoomed.stage.width / 2),
  y: Math.round(mobileZoomed.stage.top + mobileZoomed.stage.height / 2),
};
await pinch(pinchCenter, 130, 45);
const mobilePinchedIn = await measureLightbox();
check(
  "TÉLÉPHONE : le PINCEMENT à deux doigts RESSERRE le zoom (les doigts se rapprochent)",
  mobilePinchedIn.scale < mobileZoomed.scale - 0.2,
  `${mobileZoomed.scale.toFixed(2)} → ${mobilePinchedIn.scale.toFixed(2)}`,
);
await pinch(pinchCenter, 45, 130);
const mobilePinched = await measureLightbox();
check(
  "TÉLÉPHONE : le PINCEMENT à deux doigts AGRANDIT le zoom (les doigts s'écartent)",
  mobilePinched.scale > mobilePinchedIn.scale + 0.2,
  `${mobilePinchedIn.scale.toFixed(2)} → ${mobilePinched.scale.toFixed(2)}`,
);
check(
  "TÉLÉPHONE : après pincement, l'image n'est pas déformée et reste ouverte",
  mobilePinched.open === true &&
    near(ratio(mobilePinched.rect.width, mobilePinched.rect.height), ratio(mobilePinched.naturalWidth, mobilePinched.naturalHeight), 0.02),
  ratio(mobilePinched.rect.width, mobilePinched.rect.height).toFixed(4),
);
check(
  "TÉLÉPHONE : la navigation est proposée et ATTEIGNABLE (barre du bas)",
  mobilePinched.nextHidden === false &&
    (await evaluate(`(() => {
      const b = document.querySelector('.lightbox__nav--next').getBoundingClientRect();
      return b.bottom <= window.innerHeight + 0.5 && b.top >= window.innerHeight * 0.5;
    })()`)),
);
await shot("lightbox-mobile-pinched");

// Fermeture au doigt, sur le bouton visible.
const mobileCloseBox = await evaluate(`(() => {
  const b = document.querySelector('.lightbox__close').getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
})()`);
await tap(mobileCloseBox.x, mobileCloseBox.y);
check(
  "TÉLÉPHONE : le TAP sur le bouton ferme le calque (aucun orphelin)",
  (await evaluate(`document.querySelectorAll('.lightbox').length`)) === 0,
);
check(
  "TÉLÉPHONE : `scrollTop` du fil IDENTIQUE après fermeture",
  (await evaluate(`document.querySelector('#conversation').scrollTop`)) === mobileBeforeOpen,
);

await stopPage();
server.proc.kill("SIGTERM");
await sleep(300);

/* ═══════════════════════ Bilan CSP / exceptions ══════════════════════════ */
const { cspViolations, connectionErrors } = collectViolations(consoleMessages, logEntries);
check(
  "ZÉRO erreur de connexion réseau",
  connectionErrors.length === 0,
  connectionErrors.map((v) => v.text).join(" | ").slice(0, 300),
);
check("ZÉRO violation CSP", cspViolations.length === 0, cspViolations.map((v) => v.text).join(" | "));
check("ZÉRO exception JS non capturée", pageExceptions.length === 0, pageExceptions.join(" | ").slice(0, 300));

chrome.kill("SIGTERM");

console.log(`\nCaptures (temporaires, non suivies) : ${SHOTS}`);
const failedChecks = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failedChecks.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`,
);
process.exit(failedChecks.length === 0 ? 0 : 1);
