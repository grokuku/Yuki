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
 *  5. les CONSIGNES D'ÉCRITURE d'un workflow (documentation) sont servies par
 *     l'outil DÉDIÉ `consulter_workflow` — gratuit, instantané, SANS appel à
 *     ComfyUI — et ne partent JAMAIS dans le graphe posté (ni dans le prompt de
 *     chaque tour) ; une génération SANS consultation n'est JAMAIS refusée, et
 *     la mesure « consulté avant ? » est exposée ;
 *  6. un ÉCHEC RÉEL du serveur (500) produit un message honnête, et rien n'est
 *     affiché dans le fil ;
 *  7. ZÉRO violation CSP, ZÉRO exception JS, ZÉRO erreur de connexion.
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
 * CONSIGNES D'ÉCRITURE du workflow (pour Yuki, PAS pour ComfyUI).
 * ⚠️ Le marqueur `MARQUEUR-DOC` ne doit JAMAIS apparaître :
 *  - ni dans le JSON posté à `/prompt` (assertion sur le corps RÉEL) ;
 *  - ni dans le résultat de `generer_image`.
 */
const DOCUMENTATION =
  "MARQUEUR-DOC : commence par le SUJET et le cadrage en une phrase, puis le décor " +
  "et la lumière rasante. Deux phrases suffisent ; pas de listes ; n'écris jamais le " +
  "nom du style dans la scène.";

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
    documentation: DOCUMENTATION,
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
  "AUCUN bavardage technique : la carte ne parle pas de conservation ni de rechargement",
  !/conserv/i.test(state.text) &&
    !/rechargement/i.test(state.text) &&
    !/pièces jointes/i.test(state.text) &&
    !/servie par Yuki/i.test(state.text),
  state.text.slice(0, 260),
);
check(
  "la carte montre l'essentiel : dimensions, taille et fiche du prompt final",
  /64×64/.test(state.text) &&
    /Ko|octets/.test(state.text) &&
    /Prompt final \(\d+ caractères\)/.test(state.text),
  state.text.slice(0, 200),
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

/* ═══ 5 ter) L'ONGLET « IMAGES » de /config : SECTION DÉDIÉE, bouton
 *            « Éditer », CONSIGNES D'ÉCRITURE éditables et relues après
 *            rechargement. Mesures : visibilité réelle (opacité, display,
 *            géométrie), jamais un simple « le nœud existe ». ═══════════════ */
await navigate(`${server.base}/config`);
const imagesTabFound = await waitFor(`!!document.getElementById('tab-images')`, 10000);
check(
  "[/config] l'onglet « Images » existe (onglet DÉDIÉ, plus noyé dans « Système »)",
  imagesTabFound,
  await evaluate(
    `JSON.stringify([...document.querySelectorAll('[role="tab"]')].map((b) => b.textContent.trim()))`,
  ),
);

// ① La section est VISIBLE SANS DÉPLIAGE : un clic sur l'onglet, rien d'autre.
//    Les CHAMPS du serveur (URL, clé, largeur, hauteur, délai) sont dans le
//    même onglet que les workflows, et le panneau « Système » ne les porte plus.
const imagesView = await evaluate(`(() => {
  const tab = document.getElementById('tab-images');
  if (tab) tab.click();
  const panel = document.getElementById('panel-images');
  if (!panel) return null;
  const group = document.getElementById('group-images');
  const root = document.getElementById('images-root');
  const rect = panel.getBoundingClientRect();
  const labels = group ? [...group.querySelectorAll('.config-row .config-label')].map((el) => el.textContent.trim()) : [];
  const details = panel.querySelectorAll('details');
  const closedDetails = [...details].filter((d) => !d.open).length;
  const card = root ? root.querySelector('.image-workflow') : null;
  const importForm = root ? root.querySelector('.image-import') : null;
  // ⚠️ « toute la largeur » = la largeur UTILE du conteneur (contenu du groupe,
  // padding déduit) : on ne compare pas à un seuil arbitraire.
  const fills = (el) => {
    if (!el || !el.parentElement) return false;
    const ps = getComputedStyle(el.parentElement);
    const avail =
      el.parentElement.clientWidth -
      parseFloat(ps.paddingLeft || '0') -
      parseFloat(ps.paddingRight || '0');
    return Math.abs(el.getBoundingClientRect().width - avail) <= 2;
  };
  return {
    hidden: panel.hidden,
    height: Math.round(rect.height),
    width: Math.round(rect.width),
    scrollY: Math.round(window.scrollY),
    labels,
    testButton: group ? [...group.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Tester la connexion') : false,
    workflows: root ? root.querySelectorAll('.image-workflow').length : -1,
    rootInsidePanel: !!root && !!root.closest('#panel-images'),
    groupInsidePanel: !!group && !!group.closest('#panel-images'),
    systemeKeepsImages: !!document.getElementById('panel-systeme')?.querySelector('#group-images, #images-root'),
    closedDetails,
    rootWidth: root ? Math.round(root.getBoundingClientRect().width) : 0,
    cardWidth: card ? Math.round(card.getBoundingClientRect().width) : 0,
    importWidth: importForm ? Math.round(importForm.getBoundingClientRect().width) : 0,
    cardFills: fills(card),
    importFills: fills(importForm),
  };
})()`);
check(
  "[/config] la section « Images » est VISIBLE dès le clic sur l'onglet (aucun dépliage)",
  imagesView &&
    imagesView.hidden === false &&
    imagesView.height > 200 &&
    imagesView.width > 600 &&
    imagesView.closedDetails === 0,
  JSON.stringify(imagesView && { hidden: imagesView.hidden, height: imagesView.height, width: imagesView.width, closedDetails: imagesView.closedDetails }),
);
check(
  "[/config] l'onglet porte l'URL, la clé, le test, la largeur, la hauteur et le délai",
  Array.isArray(imagesView?.labels) &&
    imagesView.labels.some((l) => l.includes("URL du serveur ComfyUI")) &&
    imagesView.labels.some((l) => l.includes("Clé du serveur")) &&
    imagesView.labels.some((l) => l.includes("Largeur")) &&
    imagesView.labels.some((l) => l.includes("Hauteur")) &&
    imagesView.labels.some((l) => l.includes("Délai")) &&
    imagesView.testButton === true,
  JSON.stringify(imagesView?.labels),
);
check(
  "[/config] la section occupe TOUTE LA LARGEUR (carte et formulaire d'import)",
  imagesView &&
    imagesView.rootWidth > 600 &&
    imagesView.cardFills === true &&
    imagesView.importFills === true,
  JSON.stringify(imagesView && { rootWidth: imagesView.rootWidth, cardWidth: imagesView.cardWidth, importWidth: imagesView.importWidth, cardFills: imagesView.cardFills, importFills: imagesView.importFills }),
);
check(
  "[/config] les workflows sont dans le MÊME onglet, et plus dans « Système »",
  imagesView &&
    imagesView.workflows >= 1 &&
    imagesView.rootInsidePanel === true &&
    imagesView.groupInsidePanel === true &&
    imagesView.systemeKeepsImages === false,
  JSON.stringify(imagesView && { workflows: imagesView.workflows, rootInsidePanel: imagesView.rootInsidePanel, systemeKeepsImages: imagesView.systemeKeepsImages }),
);

// ② Le bouton « Éditer » est VISIBLE sans survol (opacité et géométrie MESURÉES).
const editButton = await evaluate(`(() => {
  const card = [...document.querySelectorAll('#images-root .image-workflow')]
    .find((el) => el.textContent.includes('manga'));
  if (!card) return null;
  const btn = card.querySelector('.image-workflow__edit');
  if (!btn) return { missing: true };
  const cs = getComputedStyle(btn);
  const rect = btn.getBoundingClientRect();
  const panel = document.getElementById('panel-images');
  return {
    label: btn.textContent.trim(),
    opacity: cs.opacity,
    display: cs.display,
    visibility: cs.visibility,
    pointerEvents: cs.pointerEvents,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    inVisiblePanel: !!panel && panel.hidden === false && panel.contains(btn),
  };
})()`);
check(
  "[/config] le bouton « Éditer » est VISIBLE sur la carte (opacité 1, hors survol)",
  editButton &&
    editButton.label === "Éditer" &&
    Number(editButton.opacity) === 1 &&
    editButton.display !== "none" &&
    editButton.visibility === "visible" &&
    editButton.pointerEvents !== "none" &&
    editButton.width > 50 &&
    editButton.height >= 32 &&
    editButton.inVisiblePanel === true,
  JSON.stringify(editButton),
);

// ③ La zone des CONSIGNES D'ÉCRITURE est VISIBLE dans le formulaire d'édition,
//    avec son compteur et le texte d'aide qui dit à quoi elle sert.
await evaluate(`(() => {
  const card = [...document.querySelectorAll('#images-root .image-workflow')]
    .find((el) => el.textContent.includes('manga'));
  card.querySelector('.image-workflow__edit').click();
})()`);
const editorOpened = await waitFor(`!!document.getElementById('image-workflow-edit')`, 5000);
const editorState = await evaluate(`(() => {
  const modal = document.getElementById('image-workflow-edit');
  if (!modal) return null;
  const zone = modal.querySelector('#image-edit-documentation');
  const description = modal.querySelector('#image-edit-description');
  const isDefault = modal.querySelector('#image-edit-default');
  const helpers = [...modal.querySelectorAll('.config-helper')].map((n) => n.textContent);
  const counter = helpers.find((t) => /[0-9]+ \\/ 8000/.test(t)) ?? null;
  const cs = zone ? getComputedStyle(zone) : null;
  const rect = zone ? zone.getBoundingClientRect() : { width: 0, height: 0, top: 0, bottom: 0 };
  return {
    visible:
      !!cs &&
      cs.display !== 'none' &&
      cs.visibility === 'visible' &&
      rect.width > 200 &&
      rect.height > 80 &&
      rect.top >= 0 &&
      rect.bottom <= window.innerHeight,
    value: zone ? zone.value : null,
    maxlength: zone ? zone.getAttribute('maxlength') : null,
    counter,
    description: description ? description.value : null,
    isDefault: isDefault ? isDefault.checked : null,
    text: modal.textContent,
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
})()`);
check(
  "[/config] « Éditer » ouvre le formulaire d'édition du workflow",
  editorOpened === true && editorState !== null,
  JSON.stringify(editorState && { visible: editorState.visible, counter: editorState.counter }),
);
check(
  "[/config] la zone des CONSIGNES est VISIBLE dans le formulaire (pré-remplie, bornée 8000)",
  editorState &&
    editorState.visible === true &&
    String(editorState.value).includes("MARQUEUR-DOC") &&
    editorState.maxlength === "8000",
  JSON.stringify(editorState && { visible: editorState.visible, maxlength: editorState.maxlength, width: editorState.width, height: editorState.height }),
);
check(
  "[/config] le compteur « x / 8000 » est affiché",
  /[0-9]+ \/ 8000/.test(String(editorState?.counter)),
  String(editorState?.counter),
);
check(
  "[/config] le formulaire édite AUSSI la description, le « par défaut » et dit que le nom est la CLÉ",
  typeof editorState?.description === "string" &&
    editorState.description.includes("Manga") &&
    editorState.isDefault === true &&
    /COMMENT ÉCRIRE la scène/.test(String(editorState?.text)) &&
    /consulter_workflow/.test(String(editorState?.text)) &&
    /jamais envoyées au serveur ComfyUI/.test(String(editorState?.text)) &&
    /n'est pas modifiable/.test(String(editorState?.text)),
  String(editorState?.text).slice(0, 240),
);

// ④ On ENREGISTRE une consigne, et on la RELIT après RECHARGEMENT.
const EDITED_DOC = await evaluate(`(() => {
  const modal = document.getElementById('image-workflow-edit');
  const zone = modal.querySelector('#image-edit-documentation');
  const value = zone.value + "\\n\\nAJOUT-EDITEUR : commence toujours par le décor et la lumière.";
  zone.value = value;
  zone.dispatchEvent(new Event('input', { bubbles: true }));
  const helpers = [...modal.querySelectorAll('.config-helper')].map((n) => n.textContent);
  return { value, counter: helpers.find((t) => /[0-9]+ \\/ 8000/.test(t)) ?? null };
})()`);
check(
  "[/config] le compteur suit la saisie (x / 8000)",
  String(EDITED_DOC?.counter).startsWith(String(String(EDITED_DOC?.value).length)),
  `${String(EDITED_DOC?.counter)} pour ${String(String(EDITED_DOC?.value).length)} caractères`,
);
await evaluate(`(() => {
  const modal = document.getElementById('image-workflow-edit');
  [...modal.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Enregistrer').click();
})()`);
const editorClosed = await waitFor(`!document.getElementById('image-workflow-edit')`, 8000);
const savedDoc = await fetch(`${server.base}/api/images/workflows`).then((r) => r.json());
const savedManga = (savedDoc.workflows ?? []).find((entry) => entry.name === "manga");
check(
  "[/config] les consignes ENREGISTRÉES depuis le formulaire sont persistées",
  editorClosed === true &&
    typeof savedManga?.documentation === "string" &&
    savedManga.documentation.includes("AJOUT-EDITEUR"),
  JSON.stringify(savedManga && { chars: savedManga.documentation.length, description: savedManga.description }),
);
// RECHARGEMENT : on relit la consigne dans le formulaire, depuis le serveur.
await navigate(`${server.base}/config#images`);
await waitFor(`!!document.getElementById('tab-images')`, 10000);
const reopened = await evaluate(`(() => {
  const tab = document.getElementById('tab-images');
  if (tab) tab.click();
  const card = [...document.querySelectorAll('#images-root .image-workflow')]
    .find((el) => el.textContent.includes('manga'));
  if (!card) return null;
  card.querySelector('.image-workflow__edit').click();
  return true;
})()`);
await waitFor(`!!document.getElementById('image-workflow-edit')`, 5000);
const reread = await evaluate(`(() => {
  const modal = document.getElementById('image-workflow-edit');
  const zone = modal ? modal.querySelector('#image-edit-documentation') : null;
  return zone ? zone.value : null;
})()`);
check(
  "[/config] la consigne est RELUE dans le formulaire après RECHARGEMENT",
  reopened === true && String(reread).includes("AJOUT-EDITEUR") && String(reread).includes("MARQUEUR-DOC"),
  String(reread).slice(0, 160),
);
// On referme sans enregistrer (Échap ne ferme que le sommet).
await evaluate(`document.querySelector('#image-workflow-edit .holaf-modal-close')?.click()`);
await waitFor(`!document.getElementById('image-workflow-edit')`, 5000);

// ⑤ Les étiquettes (YUKI_OUTPUT trouvée / absente) restent affichées sur la carte.
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
check("[/config] la fiche du workflow liste le workflow importé", firstCard !== null, JSON.stringify(firstCard));
check(
  "[/config] la fiche affiche YUKI_OUTPUT comme TROUVÉE",
  Array.isArray(firstCard?.labels) && firstCard.labels.includes("YUKI_OUTPUT"),
  JSON.stringify(firstCard?.labels),
);
check(
  "[/config] la fiche DIT que l'image finale vient du nœud étiqueté YUKI_OUTPUT",
  /Image finale/.test(String(firstCard?.text)) && /YUKI_OUTPUT/.test(String(firstCard?.text)),
  String(firstCard?.text).slice(0, 240),
);
check(
  "[/config] la fiche DIT que les consignes s'éditent par « Éditer »",
  /Consignes d'écriture/.test(String(firstCard?.text)) && /Éditer/.test(String(firstCard?.text)),
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
// ⚠️ `stopPage()` d'abord : naviguer vers la MÊME url (hash compris) ne
// recharge pas le document — on veut l'état SERVEUR, pas celui du DOM.
await stopPage();
await navigate(`${server.base}/config#images`);
await waitFor(`document.querySelectorAll('#images-root .image-workflow').length >= 2`, 10000);
const sansSortie = await evaluate(`(() => {
  const card = [...document.querySelectorAll('#images-root .image-workflow')]
    .find((el) => el.textContent.includes('sans-sortie'));
  return card
    ? {
        labels: [...card.querySelectorAll('.image-workflow__label')].map((el) => el.textContent),
        text: card.textContent,
        hasEdit: !!card.querySelector('.image-workflow__edit'),
      }
    : null;
})()`);
check(
  "la fiche affiche YUKI_OUTPUT (ABSENTE) pour un workflow qui n'en a pas",
  Array.isArray(sansSortie?.labels) && sansSortie.labels.includes("YUKI_OUTPUT (absente)"),
  JSON.stringify(sansSortie?.labels),
);
check(
  "la fiche DIT que la PREMIÈRE image produite sera retenue (repli annoncé)",
  /PREMIÈRE image produite/.test(String(sansSortie?.text)),
  String(sansSortie?.text).slice(0, 240),
);
check(
  "CHAQUE workflow porte son bouton « Éditer »",
  sansSortie?.hasEdit === true,
  JSON.stringify(sansSortie && { hasEdit: sansSortie.hasEdit }),
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

/* ═══ 6 quater) DOCUMENTATION PAR WORKFLOW — outil DÉDIÉ, gratuit ═══════ */
// ① `generer_image` SANS consultation : AUCUN refus (décision utilisateur).
const unconsulted = await fetch(
  `${server.base}/e2e/tool?scene=${encodeURIComponent("Un verger sous la pluie.")}&style=${encodeURIComponent(STYLE)}`,
).then((r) => r.json());
check(
  "generer_image fonctionne SANS avoir consulté les consignes (aucun refus)",
  unconsulted.ok === true && unconsulted.details?.status === "ok",
  JSON.stringify(unconsulted.details ?? unconsulted).slice(0, 200),
);
check(
  "la mesure DIT que ce style n'avait PAS été consulté avant",
  unconsulted.details?.workflow_consulted_before === false,
  JSON.stringify(unconsulted.details?.consultation ?? null),
);

// ② `consulter_workflow` : GRATUIT et INSTANTANÉ — aucun appel à ComfyUI.
const promptBeforeConsult = await fetch(`${server.base}/e2e/last-prompt`).then((r) => r.json());
const consulted = await fetch(
  `${server.base}/e2e/consult?style=${encodeURIComponent(STYLE)}`,
).then((r) => r.json());
const promptAfterConsult = await fetch(`${server.base}/e2e/last-prompt`).then((r) => r.json());
const consultText = String(consulted.text ?? "");
check(
  "consulter_workflow rend la DOCUMENTATION du workflow retenu (par proximité)",
  consulted.ok === true && consultText.includes("MARQUEUR-DOC") && consulted.details?.status === "ok",
  consultText.slice(0, 200),
);
check(
  "consulter_workflow est GRATUIT : aucun appel n'est parti vers ComfyUI",
  promptBeforeConsult.body === promptAfterConsult.body,
  `avant=${String(promptBeforeConsult.body).length}o après=${String(promptAfterConsult.body).length}o`,
);
check(
  "consulter_workflow rappelle la BORNE de la scène (3000 caractères)",
  consultText.includes("3000"),
  consultText.slice(-160),
);

// ③ Un workflow SANS documentation : réponse explicite, PAS une erreur.
const consultedEmpty = await fetch(
  `${server.base}/e2e/consult?style=${encodeURIComponent("sans sortie")}`,
).then((r) => r.json());
check(
  "workflow SANS consignes : réponse explicite (« aucune consigne particulière »)",
  consultedEmpty.details?.status === "empty" &&
    String(consultedEmpty.text).includes("Aucune consigne particulière"),
  String(consultedEmpty.text).slice(0, 160),
);

// ④ Après consultation, la génération suivante est COMPTÉE « consultée avant ».
const afterConsult = await fetch(
  `${server.base}/e2e/tool?scene=${encodeURIComponent("Un verger sous la pluie, ciel bas.")}&style=${encodeURIComponent(STYLE)}`,
).then((r) => r.json());
check(
  "après consultation, la génération est comptée comme précédée d'une consultation",
  afterConsult.details?.workflow_consulted_before === true,
  JSON.stringify(afterConsult.details?.consultation ?? null),
);

// ⑤ ⚠️ PIÈGE : la documentation ne doit JAMAIS partir dans le graphe posté…
const postedWithDoc = await fetch(`${server.base}/e2e/last-prompt`).then((r) => r.json());
const postedWithDocBody = String(postedWithDoc.body ?? "");
check(
  "⚠️ la documentation n'apparaît JAMAIS dans le JSON posté à ComfyUI",
  !postedWithDocBody.includes("MARQUEUR-DOC") && postedWithDocBody.length > 0,
  postedWithDocBody.slice(0, 120),
);
check(
  "…ni dans le résultat rendu au MODÈLE",
  !String(afterConsult.text ?? "").includes("MARQUEUR-DOC") &&
    !JSON.stringify(afterConsult.details ?? {}).includes("MARQUEUR-DOC"),
  String(afterConsult.text ?? "").slice(0, 160),
);
// …et la SCÈNE, elle, est bien celle demandée (rien n'a été remplacé par la doc).
const scenePosted = (() => {
  try {
    // `POST /prompt` reçoit `{ prompt: <graphe>, client_id }` (contrat ComfyUI).
    const body = JSON.parse(postedWithDocBody);
    return body?.prompt?.["enc-positif"]?.inputs?.text ?? null;
  } catch {
    return null;
  }
})();
check(
  "le graphe posté porte la SCÈNE exacte (la doc ne s'y substitue jamais)",
  scenePosted === "Un verger sous la pluie, ciel bas.",
  String(scenePosted),
);
// ⑥ La documentation n'est PAS dans le prompt système : la LISTE des styles
// (nom + description + défaut) n'en porte aucune trace, et rien d'autre ne
// l'injecte (elle n'arrive QUE par l'outil).
const listedStyles = await fetch(`${server.base}/api/images/workflows`).then((r) => r.json());
check(
  "l'API de configuration, elle, PORTE la documentation (éditeur du panneau)",
  Array.isArray(listedStyles.workflows) &&
    listedStyles.workflows.some((entry) => String(entry.documentation ?? "").includes("MARQUEUR-DOC")),
  JSON.stringify((listedStyles.workflows ?? []).map((entry) => entry.name)),
);

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

/* ═════════ 8) ÉTAT VIDE explicite, puis usage AU DOIGT (téléphone) ═════ */
// On supprime TOUS les workflows par la route réelle : l'état vide doit être
// DIT, avec le bouton d'import — pas une page muette.
const allWorkflows = await fetch(`${server.base}/api/images/workflows`).then((r) => r.json());
for (const entry of allWorkflows.workflows ?? []) {
  await fetch(`${server.base}/api/images/workflows/${encodeURIComponent(entry.name)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json", "x-yuki-config": "1" },
  });
}
await navigate(`${server.base}/config#images`);
await waitFor(`!!document.getElementById('images-root')`, 10000);
const empty = await evaluate(`(() => {
  document.getElementById('tab-images')?.click();
  const root = document.getElementById('images-root');
  const box = root ? root.querySelector('.image-empty') : null;
  const button = box ? [...box.querySelectorAll('button')][0] : null;
  const rect = button ? button.getBoundingClientRect() : { width: 0, height: 0 };
  const cs = button ? getComputedStyle(button) : null;
  return {
    text: box ? box.textContent : null,
    hasButton: !!button,
    buttonLabel: button ? button.textContent.trim() : null,
    buttonVisible: !!cs && cs.display !== 'none' && cs.visibility === 'visible' && Number(cs.opacity) === 1,
    buttonWidth: Math.round(rect.width),
    buttonHeight: Math.round(rect.height),
    cards: root ? root.querySelectorAll('.image-workflow').length : -1,
  };
})()`);
check(
  "état vide EXPLICITE : « Aucun workflow importé — importez-en un pour commencer »",
  /Aucun workflow importé — importez-en un pour commencer/.test(String(empty?.text)) && empty?.cards === 0,
  JSON.stringify(empty && { text: String(empty.text).slice(0, 120), cards: empty.cards }),
);
check(
  "état vide : le bouton d'import est VISIBLE et cliquable",
  empty?.hasButton === true &&
    empty.buttonLabel === "Importer un workflow" &&
    empty.buttonVisible === true &&
    empty.buttonWidth > 50 &&
    empty.buttonHeight >= 32,
  JSON.stringify(empty && { label: empty.buttonLabel, visible: empty.buttonVisible, h: empty.buttonHeight }),
);

// ⚠️ TÉLÉPHONE : la section doit être UTILISABLE AU DOIGT (onglet atteignable,
// plein largeur, bouton « Éditer » assez grand, formulaire d'édition dans
// l'écran). On réimporte un workflow pour pouvoir mesurer le bouton.
const reimported = await fetch(`${server.base}/api/images/workflows`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-yuki-config": "1" },
  body: JSON.stringify({
    name: "manga",
    description: "Manga / anime — traits marqués, trames",
    workflow: WORKFLOW,
  }),
});
const reimportedBody = await reimported.json();
check(
  "un workflow est réimporté pour les mesures TÉLÉPHONE",
  reimported.status === 200 && reimportedBody.ok === true,
  JSON.stringify({ status: reimported.status, body: String(JSON.stringify(reimportedBody)).slice(0, 240) }),
);
await send("Emulation.setDeviceMetricsOverride", {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
});
await stopPage();
await navigate(`${server.base}/config#images`);
await waitFor(`document.querySelectorAll('#images-root .image-workflow').length >= 1`, 10000);
const phone = await evaluate(`(() => {
  const tab = document.getElementById('tab-images');
  const tabRect = tab ? tab.getBoundingClientRect() : { width: 0, height: 0, right: 0 };
  tab?.click();
  const panel = document.getElementById('panel-images');
  const card = document.querySelector('#images-root .image-workflow');
  const button = card ? card.querySelector('.image-workflow__edit') : null;
  const buttonRect = button ? button.getBoundingClientRect() : { width: 0, height: 0, right: 0 };
  const cardRect = card ? card.getBoundingClientRect() : { width: 0, right: 0 };
  const rootRect = document.getElementById('images-root').getBoundingClientRect();
  // « toute la largeur » = largeur UTILE du conteneur (padding déduit).
  let cardFills = false;
  if (card && card.parentElement) {
    const ps = getComputedStyle(card.parentElement);
    const avail =
      card.parentElement.clientWidth -
      parseFloat(ps.paddingLeft || '0') -
      parseFloat(ps.paddingRight || '0');
    cardFills = Math.abs(cardRect.width - avail) <= 2;
  }
  return {
    viewport: window.innerWidth,
    rootWidth: Math.round(rootRect.width),
    cardFills,
    tabVisible: !!tab && tabRect.width > 0 && tabRect.height > 0,
    panelVisible: !!panel && panel.hidden === false,
    cardWidth: Math.round(cardRect.width),
    cardFits: Math.round(cardRect.right) <= window.innerWidth,
    editHeight: Math.round(buttonRect.height),
    editFits: Math.round(buttonRect.right) <= window.innerWidth,
    horizontalScroll: document.documentElement.scrollWidth > window.innerWidth,
  };
})()`);
check(
  "téléphone : l'onglet « Images » est atteignable et la section est utilisable",
  phone.viewport === 390 && phone.tabVisible === true && phone.panelVisible === true && phone.horizontalScroll === false,
  JSON.stringify(phone),
);
check(
  "téléphone : les cartes occupent la LARGEUR (pas de colonne étroite) et rien ne déborde",
  phone.rootWidth > 280 && phone.cardFills === true && phone.cardFits === true,
  JSON.stringify({ rootWidth: phone.rootWidth, cardWidth: phone.cardWidth, cardFills: phone.cardFills, cardFits: phone.cardFits }),
);
check(
  "téléphone : le bouton « Éditer » est assez grand pour le doigt (≥ 40 px de haut)",
  phone.editHeight >= 40 && phone.editFits === true,
  JSON.stringify({ editHeight: phone.editHeight, editFits: phone.editFits }),
);
await evaluate(`document.querySelector('#images-root .image-workflow .image-workflow__edit')?.click()`);
await waitFor(`!!document.getElementById('image-workflow-edit')`, 5000);
const phoneEditor = await evaluate(`(() => {
  const modal = document.getElementById('image-workflow-edit');
  if (!modal) return null;
  const zone = modal.querySelector('#image-edit-documentation');
  const rect = modal.getBoundingClientRect();
  const zoneRect = zone ? zone.getBoundingClientRect() : { width: 0, height: 0, right: 0 };
  return {
    width: Math.round(rect.width),
    fits: Math.round(rect.right) <= window.innerWidth && Math.round(rect.left) >= 0,
    zoneWidth: Math.round(zoneRect.width),
    zoneVisible: !!zone && zone.getBoundingClientRect().height > 60,
  };
})()`);
check(
  "téléphone : le formulaire d'édition tient dans l'écran et la zone des consignes est utilisable",
  phoneEditor &&
    phoneEditor.fits === true &&
    phoneEditor.width <= 390 &&
    phoneEditor.zoneVisible === true &&
    phoneEditor.zoneWidth > 200,
  JSON.stringify(phoneEditor),
);
await shot("config-images-panel-mobile");
await evaluate(`document.querySelector('#image-workflow-edit .holaf-modal-close')?.click()`);
await send("Emulation.setDeviceMetricsOverride", {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

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
