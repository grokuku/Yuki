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
 *  4. l'image est CONSERVÉE (même rétention que les pièces jointes) : elle
 *     SURVIT au RECHARGEMENT et à la PURGE du temporaire de ComfyUI, et la FICHE
 *     (prompt final) s'affiche SOUS elle sans jamais la déplacer ;
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
  // ⚠️ Nœuds RÉELS de la suite maison de l'utilisateur : l'enhancer produit le
  // prompt final, `AIHToText` l'AFFICHE (il publie `ui.text`, même si son champ
  // `display_text` est vide). L'étiquette `YUKI_FINAL_PROMPT` est ici.
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

/**
 * MÊME graphe, avec `YUKI_FINAL_PROMPT` sur un nœud qui N'AFFICHE PAS de texte
 * (`CLIPTextEncode`) : c'est l'erreur à diagnostiquer. L'historique ne portera
 * aucun `ui.text` ⇒ message EXPLICITE attendu (jamais un silence).
 */
const WORKFLOW_SANS_TEXTE = { ...WORKFLOW };
WORKFLOW_SANS_TEXTE["affichage-1858"] = {
  class_type: "CLIPTextEncode",
  inputs: { text: "" },
  _meta: { title: "YUKI_FINAL_PROMPT" },
};

/**
 * MÊME graphe, SANS `YUKI_OUTPUT` NI `YUKI_FINAL_PROMPT` : le cas « workflow d'avant », qui
 * doit continuer à fonctionner à l'identique (aucune étiquette obligatoire ajoutée).
 */
const WORKFLOW_SANS_PROMPT_FINAL = { ...WORKFLOW };
delete WORKFLOW_SANS_PROMPT_FINAL["preview-final"];
delete WORKFLOW_SANS_PROMPT_FINAL["affichage-1858"];

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
  "étiquettes trouvées annoncées à l'import (sept, dont YUKI_OUTPUT et YUKI_FINAL_PROMPT)",
  Array.isArray(importedBody.workflow?.found) && importedBody.workflow.found.length === 7,
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
check(
  "la fiche DIT la conservation RÉELLE (même durée que les pièces jointes)",
  /conserv/i.test(state.text) && /rechargement/i.test(state.text),
  state.text.slice(0, 260),
);
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

/* ═══ 5) RECHARGEMENT : l'image et sa fiche REVIENNENT (conservation) ═════ */
const generatedSrc = String(generated.imageSrc ?? "");
check(
  "la génération renvoie un chemin same-origin `/images/<id>.png`",
  /^\/images\/[a-f0-9]{32}\.png$/.test(generatedSrc),
  generatedSrc,
);
const storedBefore = await fetch(`${server.base}/e2e/images`).then((r) => r.json());
check(
  "l'image est ÉCRITE sur le disque de Yuki (copie immédiate, avant toute purge)",
  Array.isArray(storedBefore.images) &&
    storedBefore.images.some((item) => item.imageSrc === generatedSrc),
  JSON.stringify(storedBefore.images ?? []).slice(0, 200),
);
check(
  "la copie porte une date d'expiration (même règle que les pièces jointes)",
  Array.isArray(storedBefore.images) &&
    typeof storedBefore.images[0]?.expiresAt === "string" &&
    Number.isFinite(Date.parse(storedBefore.images[0].expiresAt)),
  String(storedBefore.images?.[0]?.expiresAt),
);

await navigate(`${server.base}/`);
await waitFor(`!!document.querySelector('.generated-image__image')`, 10000);
await waitForImageDecoded(5000);
const afterReload = await evaluate(`(() => {
  const block = document.querySelector('.generated-image');
  const img = document.querySelector('.generated-image__image');
  const fiche = document.querySelector('.generated-image__prompt');
  return {
    count: document.querySelectorAll('.generated-image').length,
    src: img ? img.getAttribute('src') : null,
    loaded: img ? img.complete && img.naturalWidth > 0 : false,
    naturalWidth: img ? img.naturalWidth : 0,
    fiche: Boolean(fiche),
    inImageBlock: Boolean(fiche && block && block.contains(fiche)),
    thread: document.querySelector('#conversation')?.textContent ?? '',
  };
})()`);
check("RECHARGEMENT : l'image générée est TOUJOURS affichée", afterReload.count === 1, String(afterReload.count));
check("RECHARGEMENT : c'est la MÊME image (même chemin same-origin)", afterReload.src === generatedSrc, String(afterReload.src));
check("RECHARGEMENT : image réellement DÉCODÉE par le navigateur", afterReload.loaded === true, String(afterReload.naturalWidth));
check("RECHARGEMENT : la FICHE (prompt final) revient avec l'image", afterReload.fiche === true && afterReload.inImageBlock === true, JSON.stringify(afterReload).slice(0, 200));
await shot("image-after-reload");

/* ═══ 5 bis) PURGE du temporaire de ComfyUI : l'image vient de YUKI ═══════ */
// Le faux serveur ComfyUI « purge » son répertoire temporaire : `/history` et
// `/view` répondent 404. Si l'image affichée dépendait encore de ComfyUI, elle
// serait cassée. ⚠️ C'est la COPIE de Yuki qui est servie.
await fetch(`${server.base}/e2e/purge-comfy`);
const comfyView = await fetch(`${server.base}/e2e/comfy-url`).then((r) => r.json());
const comfyPurged = await fetch(`${comfyView.url}/view?filename=Vuki_preview-final_00001_.png&type=temp`).then((r) => r.status);
check("le faux ComfyUI est bien PURGÉ (son /view répond 404)", comfyPurged === 404, String(comfyPurged));

const served = await fetch(`${server.base}${generatedSrc}`);
const servedBytes = served.ok ? (await served.arrayBuffer()).byteLength : 0;
check("l'image est toujours SERVIE par Yuki après la purge de ComfyUI", served.status === 200, String(served.status));
check("elle est servie en `image/png` (same-origin, CSP inchangée)", served.headers.get("content-type") === "image/png", String(served.headers.get("content-type")));
check("le corps servi n'est pas vide (vraie copie, pas une redirection)", servedBytes > 0, String(servedBytes));

await navigate(`${server.base}/`);
await waitFor(`!!document.querySelector('.generated-image__image')`, 10000);
await waitForImageDecoded(5000);
const afterPurge = await evaluate(`(() => {
  const img = document.querySelector('.generated-image__image');
  return {
    count: document.querySelectorAll('.generated-image').length,
    src: img ? img.getAttribute('src') : null,
    loaded: img ? img.complete && img.naturalWidth > 0 : false,
  };
})()`);
check("après la purge de ComfyUI : l'image est TOUJOURS affichée", afterPurge.count === 1, String(afterPurge.count));
check("après la purge : c'est toujours la MÊME image", afterPurge.src === generatedSrc, String(afterPurge.src));
check("après la purge : image réellement DÉCODÉE", afterPurge.loaded === true, JSON.stringify(afterPurge));
await shot("image-after-comfy-purge");

// Remise à zéro du stockage du harnais : les sections suivantes comptent les
// blocs depuis un fil VIDE (ce n'est pas une mesure de production).
const reset = await fetch(`${server.base}/e2e/reset-media`).then((r) => r.json());
check("le harnais vide son stockage d'images pour les mesures suivantes", reset.removed >= 1, JSON.stringify(reset));
await navigate(`${server.base}/`);
await sleep(500);
const afterReset = await evaluate(`document.querySelectorAll('.generated-image').length`);
check("fil reconstruit : plus aucun bloc d'image (l'état vient du serveur)", afterReset === 0, String(afterReset));

/* ═══ 5 ter) Le PANNEAU /config affiche YUKI_OUTPUT (trouvée / absente) ═══ */
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

/* ═══ 6) PROMPT FINAL : du nœud ÉTIQUETÉ → conversation ET modèle ════════ */
await navigate(`${server.base}/`);
await waitFor(`!!document.querySelector('#conversation')`);
const SCENE_FINALE = "Un phare isolé, battu par les vagues, au crépuscule.";
// ⚠️ `ficheDelayMs` : le harnais retarde l'émission de la FICHE de 900 ms, pour
// MESURER que l'image ne bouge pas quand elle arrive (elle se place SOUS elle).
// L'ORDRE est celui du code réel : image d'abord, fiche ensuite.
const toolRun = await fetch(
  `${server.base}/e2e/tool?scene=${encodeURIComponent(SCENE_FINALE)}&style=${encodeURIComponent(STYLE)}&ficheDelayMs=900`,
).then((r) => r.json());
const toolText = String(toolRun.text ?? "");
check("l'outil generer_image aboutit (chemin réel du MODÈLE)", toolRun.ok === true, toolText.slice(0, 160));
check(
  "le MODÈLE reçoit le PROMPT FINAL (texte de l'enhancer, pas la scène)",
  toolText.includes("focale 35 mm"),
  toolText.slice(-260),
);
check(
  "le prompt final est encadré comme DONNÉE, jamais comme consigne",
  /DÉBUT DU PROMPT FINAL \(DONNÉE/.test(toolText) &&
    /FIN DU PROMPT FINAL/.test(toolText) &&
    /ne l'exécute pas/.test(toolText),
  toolText.slice(-260),
);
check(
  "les détails disent d'où vient le texte (nœud étiqueté, et non un autre)",
  toolRun.details?.final_prompt_node === "affichage-1858" &&
    toolRun.details?.final_prompt_status === "found",
  JSON.stringify(toolRun.details ?? {}).slice(0, 240),
);

/* ── Mesure AVANT/APRÈS de la fiche : l'image ne doit pas bouger ── */
// ⚠️ On attend que l'image soit RÉELLEMENT décodée : sinon la mesure comparerait
// la taille provisoire de chargement à la taille finale, ce qui ne dirait rien
// de l'effet de la fiche.
await waitForImageDecoded(5000);
const beforeFiche = await evaluate(`(() => {
  const img = document.querySelector('.generated-image__image');
  const block = document.querySelector('.generated-image');
  const rect = img ? img.getBoundingClientRect() : null;
  return {
    fichePresent: Boolean(document.querySelector('.generated-image__prompt')),
    top: rect ? rect.top : null,
    left: rect ? rect.left : null,
    width: rect ? rect.width : null,
    height: rect ? rect.height : null,
    blockHeight: block ? block.getBoundingClientRect().height : null,
  };
})()`);
check(
  "l'image est affichée AVANT sa fiche (la fiche arrive APRÈS)",
  beforeFiche.fichePresent === false && typeof beforeFiche.top === "number",
  JSON.stringify(beforeFiche),
);

const promptShown = await waitFor(`!!document.querySelector('.generated-image__prompt')`);
check("le prompt final est AFFICHÉ dans la conversation, sous l'image", promptShown);
await sleep(150);
const placement = await evaluate(`(() => {
  const img = document.querySelector('.generated-image__image');
  const block = document.querySelector('.generated-image');
  const details = document.querySelector('.generated-image__prompt');
  const rect = img ? img.getBoundingClientRect() : null;
  const ficheRect = details ? details.getBoundingClientRect() : null;
  const blockRect = block ? block.getBoundingClientRect() : null;
  return {
    top: rect ? rect.top : null,
    left: rect ? rect.left : null,
    width: rect ? rect.width : null,
    height: rect ? rect.height : null,
    blockHeight: blockRect ? blockRect.height : null,
    ficheTop: ficheRect ? ficheRect.top : null,
    imageBottom: rect ? rect.bottom : null,
    // Ordre dans le DOM : DOCUMENT_POSITION_FOLLOWING = la fiche VIENT APRÈS.
    ficheAfterImage: Boolean(img && details) && Boolean(img.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING),
    imgStillFirstImage: block ? block.querySelector('.generated-image__image') === img : false,
  };
})()`);
check(
  "la fiche est SOUS l'image (mesure : son haut ≥ le bas de l'image)",
  typeof placement.ficheTop === "number" &&
    typeof placement.imageBottom === "number" &&
    placement.ficheTop >= placement.imageBottom - 0.5,
  JSON.stringify({ ficheTop: placement.ficheTop, imageBottom: placement.imageBottom }),
);
check(
  "la fiche vient APRÈS l'image dans le DOM (jamais avant)",
  placement.ficheAfterImage === true && placement.imgStillFirstImage === true,
  JSON.stringify(placement),
);
check(
  "l'image n'a PAS BOUGÉ quand la fiche est arrivée (position et taille identiques)",
  placement.top === beforeFiche.top &&
    placement.left === beforeFiche.left &&
    placement.width === beforeFiche.width &&
    placement.height === beforeFiche.height,
  JSON.stringify({ avant: beforeFiche, apres: placement }),
);
check(
  "le bloc a seulement GRANDI vers le bas (la fiche ajoute sa hauteur)",
  typeof placement.blockHeight === "number" &&
    typeof beforeFiche.blockHeight === "number" &&
    placement.blockHeight > beforeFiche.blockHeight,
  JSON.stringify({ avant: beforeFiche.blockHeight, apres: placement.blockHeight }),
);
const promptState = await evaluate(`(() => {
  const details = document.querySelector('.generated-image__prompt');
  const block = document.querySelector('.generated-image');
  const code = details ? details.querySelector('code') : null;
  const button = details ? details.querySelector('.md-copy-btn') : null;
  return {
    open: details ? details.open : null,
    inImageBlock: Boolean(details && block && block.contains(details)),
    text: code ? code.textContent : '',
    pwned: typeof window.__pwned !== 'undefined',
    injectedNodes: details ? details.querySelectorAll('img, b').length : -1,
    fields: details ? details.querySelectorAll('input, textarea').length : -1,
    copyLabel: button ? button.getAttribute('aria-label') : null,
    note: details ? details.textContent : '',
    styled: details
      ? details.getAttribute('style') !== null ||
        [...details.querySelectorAll('*')].some((el) => el.getAttribute('style') !== null)
      : null,
  };
})()`);
check("il est REPLIÉ par défaut (lisible sans encombrer le fil)", promptState.open === false);
check("il est DANS le bloc de l'image (sous/avec elle)", promptState.inImageBlock === true);
check(
  "le texte affiché est celui du NŒUD ÉTIQUETÉ (aucun autre nœud lu)",
  String(promptState.text).includes("focale 35 mm"),
  String(promptState.text).slice(0, 140),
);
check(
  "texte inséré comme NŒUD TEXTE : la charge d'injection n'est PAS interprétée",
  promptState.pwned === false && promptState.injectedNodes === 0,
  `pwned=${String(promptState.pwned)} nœuds=${String(promptState.injectedNodes)}`,
);
check("aucun champ de saisie : c'est de la LECTURE", promptState.fields === 0, String(promptState.fields));
check(
  "bouton « copier » RÉUTILISÉ (le même que les blocs de code)",
  /prompt final/i.test(String(promptState.copyLabel)),
  String(promptState.copyLabel),
);
check(
  "le bloc DIT qu'il est en lecture seule",
  /LECTURE seule/.test(String(promptState.note)),
  String(promptState.note).slice(-160),
);
check("aucun attribut de style en ligne (CSP)", promptState.styled === false, JSON.stringify(promptState.styled));
await shot("image-final-prompt");

/* ═══ 6 bis) Nœud étiqueté SANS texte ⇒ message EXPLICITE ═══════════════ */
const importedNoText = await fetch(`${server.base}/api/images/workflows`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-yuki-config": "1" },
  body: JSON.stringify({
    name: "sans-texte",
    description: "Sans texte — nœud étiqueté qui n'affiche aucun texte",
    workflow: WORKFLOW_SANS_TEXTE,
    isDefault: true,
  }),
});
check(
  "un workflow dont le nœud YUKI_FINAL_PROMPT n'affiche rien reste IMPORTABLE (le diagnostic est à la génération)",
  importedNoText.status === 200,
  String(importedNoText.status),
);
const noTextRun = await fetch(`${server.base}/e2e/tool?scene=zzz%20qqq&style=zzz%20qqq`).then((r) => r.json());
const noTextMessage = String(noTextRun.text ?? "");
check(
  "nœud étiqueté SANS texte ⇒ message EXPLICITE (pas un silence)",
  /AUCUN texte/.test(noTextMessage) && /YUKI_FINAL_PROMPT/.test(noTextMessage),
  noTextMessage.slice(-300),
);
check(
  "le message dit ce que le nœud publie RÉELLEMENT et comment corriger",
  /sorties publiées par ce nœud/.test(noTextMessage) && /ui\.text/.test(noTextMessage),
  noTextMessage.slice(-300),
);
check(
  "l'image reste produite malgré le texte manquant (ce n'est pas un échec)",
  noTextRun.details?.status === "ok" && noTextRun.details?.final_prompt_status === "empty",
  JSON.stringify(noTextRun.details ?? {}).slice(0, 200),
);
await sleep(300);
const noTextBlocks = await evaluate(`(() => ({
  images: document.querySelectorAll('.generated-image').length,
  prompts: document.querySelectorAll('.generated-image__prompt').length,
}))()`);
check(
  "aucun bloc de prompt final n'est ajouté quand il n'y a rien à montrer",
  noTextBlocks.images === 2 && noTextBlocks.prompts === 1,
  JSON.stringify(noTextBlocks),
);

/* ═══ 6 ter) Workflow SANS l'étiquette ⇒ marche TOUJOURS ════════════════ */
const importedNoLabel = await fetch(`${server.base}/api/images/workflows`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-yuki-config": "1" },
  body: JSON.stringify({
    name: "sans-prompt-final",
    description: "Sans prompt final — workflow d'avant, aucune étiquette de lecture",
    workflow: WORKFLOW_SANS_PROMPT_FINAL,
    isDefault: false,
  }),
});
check(
  "un workflow SANS YUKI_FINAL_PROMPT reste importable (étiquette facultative)",
  importedNoLabel.status === 200,
  String(importedNoLabel.status),
);
await fetch(`${server.base}/api/images/workflows/sans-prompt-final/defaut`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-yuki-config": "1" },
});
const noLabelRun = await fetch(`${server.base}/e2e/tool?scene=zzz%20qqq&style=zzz%20qqq`).then((r) => r.json());
const noLabelText = String(noLabelRun.text ?? "");
check("workflow SANS YUKI_FINAL_PROMPT : la génération marche toujours", noLabelRun.details?.status === "ok", noLabelText.slice(0, 160));
check("workflow SANS l'étiquette : aucun prompt final n'est inventé", !/PROMPT FINAL/.test(noLabelText), noLabelText.slice(0, 200));
check(
  "workflow SANS l'étiquette : rien n'est ajouté sous l'image",
  noLabelRun.details?.final_prompt_labeled === false,
  JSON.stringify(noLabelRun.details ?? {}).slice(0, 200),
);
await sleep(300);
const noLabelBlocks = await evaluate(`(() => ({
  images: document.querySelectorAll('.generated-image').length,
  prompts: document.querySelectorAll('.generated-image__prompt').length,
}))()`);
check(
  "l'image du workflow non étiqueté s'affiche sans bloc de prompt",
  noLabelBlocks.images === 3 && noLabelBlocks.prompts === 1,
  JSON.stringify(noLabelBlocks),
);
await shot("image-sans-etiquette");
// Fil reconstruit : la section suivante compare le nombre de blocs AVANT/APRÈS
// l'échec (les images CONSERVÉES reviennent, c'est normal : on ne compte que ce
// que l'échec ajoute ou n'ajoute pas).
await navigate(`${server.base}/`);
await sleep(500);
const blocksBeforeFailure = await evaluate(`document.querySelectorAll('.generated-image').length`);
const storedBeforeFailure = await fetch(`${server.base}/e2e/images`).then((r) => r.json());

/* ═════════ 7) ÉCHEC RÉEL du serveur ⇒ message honnête, rien dans le fil ═ */
await fetch(`${server.base}/e2e/fail`);
const failed = await fetch(
  `${server.base}/e2e/generate?scene=${encodeURIComponent("Un phare battu par les vagues.")}`,
).then((r) => r.json());
check("échec serveur : la génération échoue (500 réel)", failed.ok === false, JSON.stringify(failed));
check("échec serveur : le message dit ce que le serveur a répondu", /500/.test(String(failed.message)), String(failed.message).slice(0, 200));
check("échec serveur : le message est en français et actionnable", /ComfyUI/.test(String(failed.message)), String(failed.message).slice(0, 200));
await sleep(400);
const afterFailure = await evaluate(`document.querySelectorAll('.generated-image').length`);
check(
  "échec serveur : RIEN de NOUVEAU n'est affiché dans le fil",
  afterFailure === blocksBeforeFailure,
  `${String(blocksBeforeFailure)} → ${String(afterFailure)}`,
);
const storedAfterFailure = await fetch(`${server.base}/e2e/images`).then((r) => r.json());
check(
  "échec serveur : aucune image n'est écrite sur le disque",
  Array.isArray(storedAfterFailure.images) &&
    storedAfterFailure.images.length === (storedBeforeFailure.images?.length ?? -1),
  `${String(storedBeforeFailure.images?.length)} → ${String(storedAfterFailure.images?.length)}`,
);

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
