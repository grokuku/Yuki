#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — IMAGE GÉNÉRÉE par ComfyUI, DANS la conversation.
 *
 * Vérifie, avec un FAUX SERVEUR COMFYUI RÉEL, la CSP RÉELLE et un navigateur RÉEL :
 *  1. un workflow importé par la route réelle (`POST /api/images/workflows`) est
 *     exécuté : l'image REVIENT et s'affiche DANS le fil
 *     (`<img src="/images/…">` DÉCODÉE par le navigateur — donc `img-src 'self'`
 *     suffit : AUCUN élargissement de CSP) ;
 *  2. le JSON RÉELLEMENT POSTÉ à ComfyUI porte la SCÈNE, et JAMAIS le STYLE
 *     (PIÈGE ①) ;
 *  3. les étiquettes sont retrouvées PAR TITRE malgré des identifiants de nœuds
 *     NON NUMÉRIQUES (PIÈGE ②) : la graine/largeur/hauteur sont écrites aux bons
 *     champs, le style a choisi le workflow `manga` ;
 *  4. l'image est ÉPHÉMÈRE : elle disparaît au rechargement (jamais dans le
 *     snapshot, jamais dans le transcript) ;
 *  5. un ÉCHEC RÉEL du serveur (500) produit un message honnête, et rien n'est
 *     affiché dans le fil ;
 *  6. ZÉRO violation CSP, ZÉRO exception JS, ZÉRO erreur de connexion.
 *
 * ⚠️ Aucune capture PNG suivie : tout va dans un dossier TEMPORAIRE.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-image.mjs"
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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-image-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

/**
 * Workflow au FORMAT API, étiqueté, avec des identifiants de nœuds VOLONTAIREMENT
 * non numériques et dans le désordre : la résolution doit se faire PAR TITRE.
 */
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
  // ⚠️ APERÇU INTERMÉDIAIRE : `SaveImage` (type `output`), que l'ancienne règle
  // « première image produite » préférait — il ne doit JAMAIS être servi quand
  // `YUKI_OUTPUT` est étiqueté.
  "save-inter": { class_type: "SaveImage", inputs: { filename_prefix: "Apercu" } },
  // ⚠️ L'IMAGE FINALE : un `PreviewImage` (type `temp`, aucun fichier permanent
  // dans `output/`), étiqueté `YUKI_OUTPUT`.
  "preview-final": {
    class_type: "PreviewImage",
    inputs: { images: ["save-inter", 0] },
    _meta: { title: "YUKI_OUTPUT" },
  },
};

const SCENE = "Une femme âgée arrose des tomates au soleil couchant, arrosoir en zinc.";
const STYLE = "un truc style dessin animé japonais";

/**
 * MÊME graphe, SANS l'étiquette `YUKI_OUTPUT` : prouve que les workflows
 * existants restent valides (l'étiquette est facultative) et que le panneau
 * affiche alors « YUKI_OUTPUT (absente) » + le repli annoncé.
 */
const WORKFLOW_SANS_OUTPUT = { ...WORKFLOW };
delete WORKFLOW_SANS_OUTPUT["preview-final"];

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
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-image-chrome-"));
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

async function waitFor(expression, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await evaluate(expression)) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Attend le DÉCODAGE RÉEL de l'image (`img.decode()`), pas seulement la présence
 * du nœud : le décodage est ASYNCHRONE et `loading="lazy"` peut le différer.
 */
async function waitForImageDecoded(timeout = 5000) {
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

/* ═════════ 1) IMPORT du workflow par la route RÉELLE (format API) ════════ */
const imported = await fetch(`${server.base}/api/images/workflows`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-yuki-config": "1" },
  body: JSON.stringify({
    name: "manga",
    description: "Manga / anime — traits marqués, trames",
    workflow: WORKFLOW,
    isDefault: true,
  }),
});
const importedBody = await imported.json();
check("import du workflow accepté (route réelle)", imported.status === 200 && importedBody.ok === true);
check(
  "étiquettes trouvées annoncées à l'import (six, dont YUKI_OUTPUT)",
  Array.isArray(importedBody.workflow?.found) && importedBody.workflow.found.length === 6,
  JSON.stringify(importedBody.workflow?.found),
);
check(
  "l'import annonce la présence de YUKI_OUTPUT (nœud de l'image finale)",
  Array.isArray(importedBody.workflow?.found) && importedBody.workflow.found.includes("YUKI_OUTPUT"),
  JSON.stringify(importedBody.workflow?.found),
);
check(
  "l'API ne renvoie JAMAIS le graphe",
  !JSON.stringify(importedBody).includes("class_type"),
);

/* ═════════ 2) GÉNÉRATION RÉELLE : l'image revient et s'affiche ══════════ */
await navigate(`${server.base}/`);
await waitFor(`!!document.querySelector('#conversation')`);
const generated = await fetch(
  `${server.base}/e2e/generate?scene=${encodeURIComponent(SCENE)}&style=${encodeURIComponent(STYLE)}`,
).then((r) => r.json());
check("la génération aboutit (faux ComfyUI réellement appelé)", generated.ok === true, JSON.stringify(generated));
check("workflow choisi par proximité : « dessin animé japonais » ⇒ manga", generated.workflow === "manga", String(generated.workflow));

const shown = await waitFor(`!!document.querySelector('.generated-image__image')`);
check("l'image générée s'affiche DANS le fil", shown);
await waitForImageDecoded(5000);

const state = await evaluate(`(() => {
  const conv = document.querySelector('#conversation');
  const block = document.querySelector('.generated-image');
  const img = document.querySelector('.generated-image__image');
  return {
    inConversation: Boolean(block && conv && conv.contains(block)),
    isMessage: block ? block.classList.contains('message') : false,
    text: block ? block.textContent : '',
    imgSrc: img ? img.getAttribute('src') : null,
    imgClass: img ? img.className : null,
    imgLoaded: img ? (img.complete && img.naturalWidth > 0) : false,
    imgNaturalWidth: img ? img.naturalWidth : 0,
    blockStyle: block ? block.getAttribute('style') : null,
    imgStyle: img ? img.getAttribute('style') : null,
  };
})()`);
check("le bloc est DANS la conversation (#conversation)", state.inConversation === true);
check("ce n'est PAS un message (état temporaire)", state.isMessage === false);
check(
  "métadonnées affichées (dimensions réelles × taille)",
  /64×64/.test(state.text) && /Ko|octets/.test(state.text),
  state.text.slice(0, 200),
);
check("mention « pas conservée dans l'historique »", /pas conservée dans l'historique/i.test(state.text), state.text.slice(0, 220));
check(
  "source SAME-ORIGIN `/images/…` (CSP `img-src 'self'` inchangée)",
  typeof state.imgSrc === "string" && /^\/images\/[a-f0-9]{32}\.png$/.test(state.imgSrc),
  String(state.imgSrc),
);
check("le nom de fichier du serveur ComfyUI n'est PAS exposé", !/Yuki_(preview-final|save-inter|save-99|00001)_/.test(JSON.stringify(state)));
check("image RÉELLEMENT décodée par le navigateur", state.imgLoaded === true, String(state.imgNaturalWidth));
check("classe `.md-image` (chemin image du markdown réutilisé)", String(state.imgClass).includes("md-image"), String(state.imgClass));
check("aucun attribut de style (CSP `style-src 'self'`)", state.blockStyle === null && state.imgStyle === null);
await shot("image-block");

/* ═════════ 3) Le JSON POSTÉ : scène OUI, style JAMAIS ════════════════════ */
const posted = await fetch(`${server.base}/e2e/last-prompt`).then((r) => r.json());
const postedBody = String(posted.body ?? "");
check("le JSON posté porte la SCÈNE", postedBody.includes("arrosoir en zinc"), postedBody.slice(0, 120));
for (const forbidden of ["dessin", "animé", "anime", "japonais", "manga", "infographie"]) {
  check(`le JSON posté ne contient PAS « ${forbidden} »`, !postedBody.toLowerCase().includes(forbidden));
}

/* ═════════ 4) Étiquettes écrites aux BONS champs (par TITRE) ════════════ */
const graph = (() => {
  try {
    // `postedBody` = `{ prompt: <graphe>, client_id: … }` (contrat de `POST /prompt`).
    const parsed = JSON.parse(postedBody);
    return parsed && typeof parsed.prompt === "object" && parsed.prompt !== null
      ? parsed.prompt
      : {};
  } catch {
    return {};
  }
})();
check("prompt positif écrit dans le nœud titré YUKI_PROMPT", String(graph["enc-positif"]?.inputs?.text ?? "").includes("arrosoir en zinc"));
check("prompt négatif NEUTRE écrit dans YUKI_NEGATIVE", /flou, basse résolution/.test(String(graph["enc-negatif"]?.inputs?.text ?? "")), String(graph["enc-negatif"]?.inputs?.text ?? "").slice(0, 60));
check("graine écrite dans le nœud titré YUKI_SEED (id non numérique)", Number.isInteger(graph["ks-42"]?.inputs?.seed) && graph["ks-42"].inputs.seed > 0, String(graph["ks-42"]?.inputs?.seed));
check("largeur écrite dans YUKI_WIDTH", graph["latent-7"]?.inputs?.width === 1024, String(graph["latent-7"]?.inputs?.width));
check("hauteur écrite dans YUKI_HEIGHT", graph["latent-h9"]?.inputs?.height === 1024, String(graph["latent-h9"]?.inputs?.height));
check("nœud non étiqueté laissé INTACT (SaveImage)", graph["save-99"]?.inputs?.filename_prefix === "Yuki");

/* ═════════ 4 bis) L'IMAGE FINALE est celle du nœud YUKI_OUTPUT ═══════════ */
// ⚠️ LE point qui compte : le graphe contient un APERÇU intermédiaire
// (`save-inter`, type `output`) ET l'image finale (`preview-final`, `temp`).
// L'ancienne règle préférait `output` ; la preuve est la requête RÉELLE `/view`.
const lastView = await fetch(`${server.base}/e2e/last-view`).then((r) => r.json());
check(
  "c'est l'image du nœud YUKI_OUTPUT qui est récupérée (PreviewImage)",
  lastView.filename === "Yuki_preview-final_00001_.png",
  JSON.stringify(lastView),
);
check(
  "l'aperçu intermédiaire (SaveImage) n'est PAS servi",
  lastView.filename !== "Yuki_save-inter_00001_.png",
  JSON.stringify(lastView),
);
check(
  "type `temp` respecté tel que publié par l'historique (PreviewImage)",
  lastView.type === "temp",
  JSON.stringify(lastView),
);

/* ═════════ 5) Rechargement : l'image NE revient PAS (éphémère) ═══════════ */
await navigate(`${server.base}/`);
await sleep(800);
const afterReload = await evaluate(`(() => ({
  count: document.querySelectorAll('.generated-image').length,
  thread: document.querySelector('#conversation')?.textContent ?? '',
  images: [...document.querySelectorAll('img')].map((img) => img.getAttribute('src')).filter((src) => String(src).startsWith('/images/')).length,
}))()`);
check("rechargement : plus AUCUN bloc d'image générée", afterReload.count === 0, String(afterReload.count));
check("rechargement : aucune image /images/ dans le fil", afterReload.images === 0, String(afterReload.images));
check("rechargement : aucun résidu textuel", !/Image générée/i.test(afterReload.thread), afterReload.thread.slice(0, 120));
await shot("image-after-reload");

/* ═══ 5 bis) Le PANNEAU /config affiche YUKI_OUTPUT (trouvée / absente) ═══ */
await navigate(`${server.base}/config`);
const panelReady = await waitFor(`!!document.querySelector('#images-root .image-workflow')`, 10000);
check("le panneau des workflows est monté sur /config", panelReady, await evaluate(`JSON.stringify({ root: document.querySelector('#images-root')?.textContent?.slice(0,200) ?? null, cards: document.querySelectorAll('#images-root .image-workflow').length, err: document.querySelector('.config-error')?.textContent ?? null })`));
const firstCard = await evaluate(`(() => {
  const card = [...document.querySelectorAll('#images-root .image-workflow')]
    .find((el) => el.textContent.includes('manga'));
  return card
    ? {
        labels: [...card.querySelectorAll('.image-workflow__label')].map((el) => el.textContent),
        text: card.textContent,
      }
    : null;
})()`);
check("le panneau des workflows liste le workflow importé", firstCard !== null, JSON.stringify(firstCard));
check(
  "le panneau affiche YUKI_OUTPUT comme TROUVÉE",
  Array.isArray(firstCard?.labels) && firstCard.labels.includes("YUKI_OUTPUT"),
  JSON.stringify(firstCard?.labels),
);
check(
  "le panneau DIT que l'image finale vient du nœud étiqueté YUKI_OUTPUT",
  /Image finale/.test(String(firstCard?.text)) && /YUKI_OUTPUT/.test(String(firstCard?.text)),
  String(firstCard?.text).slice(0, 240),
);

// Workflow SANS l'étiquette : accepté (facultative) et le repli est annoncé.
const withoutOutput = await fetch(`${server.base}/api/images/workflows`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-yuki-config": "1" },
  body: JSON.stringify({
    name: "sans-sortie",
    description: "Sans étiquette de sortie — aperçu intermédiaire possible",
    workflow: WORKFLOW_SANS_OUTPUT,
  }),
});
check(
  "un workflow SANS YUKI_OUTPUT reste importable (étiquette facultative)",
  withoutOutput.status === 200,
  String(withoutOutput.status),
);
await navigate(`${server.base}/config`);
await waitFor(`document.querySelectorAll('#images-root .image-workflow').length >= 2`, 10000);
const sansSortie = await evaluate(`(() => {
  const card = [...document.querySelectorAll('#images-root .image-workflow')]
    .find((el) => el.textContent.includes('sans-sortie'));
  return card
    ? {
        labels: [...card.querySelectorAll('.image-workflow__label')].map((el) => el.textContent),
        text: card.textContent,
      }
    : null;
})()`);
check(
  "le panneau affiche YUKI_OUTPUT (ABSENTE) pour un workflow qui n'en a pas",
  Array.isArray(sansSortie?.labels) && sansSortie.labels.includes("YUKI_OUTPUT (absente)"),
  JSON.stringify(sansSortie?.labels),
);
check(
  "la fiche DIT que la PREMIÈRE image produite sera retenue (repli annoncé)",
  /PREMIÈRE image produite/.test(String(sansSortie?.text)),
  String(sansSortie?.text).slice(0, 240),
);
await shot("config-images-panel");

/* ═════════ 6) ÉCHEC RÉEL du serveur ⇒ message honnête, rien dans le fil ═ */
await fetch(`${server.base}/e2e/fail`);
const failed = await fetch(
  `${server.base}/e2e/generate?scene=${encodeURIComponent("Un phare battu par les vagues.")}`,
).then((r) => r.json());
check("échec serveur : la génération échoue (500 réel)", failed.ok === false, JSON.stringify(failed));
check("échec serveur : le message dit ce que le serveur a répondu", /500/.test(String(failed.message)), String(failed.message).slice(0, 200));
check("échec serveur : le message est en français et actionnable", /ComfyUI/.test(String(failed.message)), String(failed.message).slice(0, 200));
await sleep(400);
const afterFailure = await evaluate(`document.querySelectorAll('.generated-image').length`);
check("échec serveur : RIEN n'est affiché dans le fil", afterFailure === 0, String(afterFailure));

await stopPage();
server.proc.kill("SIGTERM");await sleep(300);

/* ═══════════════════════ Bilan CSP / exceptions ══════════════════════════ */
const { cspViolations, connectionErrors } = collectViolations(consoleMessages, logEntries);
check(
  "ZÉRO erreur de connexion réseau (serveur indisponible)",
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
