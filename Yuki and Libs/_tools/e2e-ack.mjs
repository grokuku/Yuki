#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — ACCUSÉ DE RÉCEPTION, mesuré dans un VRAI navigateur
 * (Chromium headless + CDP, CSP réelle).
 *
 * Ce que l'on prouve PAR MESURE (et non par lecture du code) :
 *   1. une QUESTION SIMPLE ne produit AUCUN accusé (et sa réponse est intacte) ;
 *   2. une ACTION qui démarre produit un accusé COURT et HUMAIN (« Je m'en
 *      occupe. »), qui n'est PAS une bulle de réponse ;
 *   3. l'accusé est le DÉBUT DE LA RÉPONSE : il est un ENFANT de la bulle
 *      assistant (mesure DOM : parent, ordre, rectangles), jamais un bloc posé
 *      à côté au-dessus d'une bulle vide ;
 *   3bis. AUCUNE bulle vide : un run qui ne produit aucun texte mais accuse
 *      réception affiche l'accusé SEUL dans la bulle ;
 *   3ter. l'accusé SURVIT au RECHARGEMENT (persisté avec le message) et il est
 *      présent dans le texte du message (copie / sélection) ;
 *   4. AUCUN surcoût au TTFT : le `run_summary` du tour « action » porte le MÊME
 *      TTFT que celui du tour « question » (même délai de premier token) ;
 *   5. l'accusé n'est JAMAIS prononcé (texte réellement synthétisé), alors que la
 *      réponse, elle, l'est ;
 *   6. ZÉRO violation CSP, ZÉRO exception JS, ZÉRO erreur de connexion.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-ack.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { collectViolations, waitForGateway } from "./browser-violations.mjs";

const TOOLS = import.meta.dirname;
const WORKSPACE = join(TOOLS, "..");
const YUKI_DIR = join(WORKSPACE, "Yuki");
const TSX = join(YUKI_DIR, "node_modules", ".bin", "tsx");

// Captures dans un dossier TEMPORAIRE : aucun artefact suivi n'est créé.
const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-ack-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
const logs = [];
const proc = spawn(TSX, [join(TOOLS, "e2e-ack-serve.ts")], {
  cwd: YUKI_DIR,
  env: { ...process.env, YUKI_LOG_LEVEL: "error" },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stdout.on("data", (d) => logs.push(d.toString()));
proc.stderr.on("data", (d) => logs.push(d.toString()));

const { base, control } = await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error("serveur non démarré :\n" + logs.join(""))),
    40_000,
  );
  let baseUrl;
  const onData = () => {
    const text = logs.join("");
    const b = text.match(/READY (http:\/\/\S+)/);
    const c = text.match(/CONTROL (http:\/\/\S+)/);
    if (b) baseUrl = b[1].trim();
    if (baseUrl && c) {
      clearTimeout(timer);
      resolve({ base: baseUrl, control: c[1].trim() });
    }
  };
  proc.stdout.on("data", onData);
  proc.on("exit", (code) => {
    clearTimeout(timer);
    reject(new Error(`serveur quitté (${code}) :\n` + logs.join("")));
  });
});
await waitForGateway(base);

/* ─── Chromium headless (CDP) ───────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-ack-chrome-"));
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
  await sleep(500);
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
    await sleep(60);
  }
  return false;
}

/**
 * Attend la FIN RÉELLE du tour : la trame `run_summary` (valeurs finales) est
 * arrivée côté serveur. ⚠️ C'est la seule preuve que le flux est terminé — un
 * libellé d'état peut changer avant que le dernier delta soit rendu.
 */
async function waitForSummary(timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const body = await fetch(`${control}/last-summary`).then((r) => r.json());
    if (body.summary && typeof body.summary.totalMs === "number") return body.summary;
    await sleep(80);
  }
  throw new Error("run_summary non reçu");
}

async function shot(label) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(SHOTS, `${label}.png`), Buffer.from(data, "base64"));
}

await navigate(`${base}/`);
check(
  "connexion au gateway établie",
  await waitFor(`document.querySelector('#connection')?.textContent === 'connecté'`),
);

/**
 * Observateur d'ORDRE : il horodate (performance.now) l'apparition de l'accusé et
 * le PREMIER TEXTE de la bulle assistant. ⚠️ C'est la mesure de l'ordre, pas une
 * simple présence.
 */
const INSTALL_ORDER_PROBE = `(() => {
  window.__order = [];
  const conv = document.querySelector('#conversation');
  const assistantText = () => {
    const bubbles = [...document.querySelectorAll('#conversation .message--assistant')];
    const last = bubbles[bubbles.length - 1];
    const body = last ? last.querySelector('.message__body') : null;
    return body ? body.textContent : '';
  };
  let sawAck = false;
  let sawText = false;
  window.__orderObserver = new MutationObserver(() => {
    if (!sawAck) {
      const ack = conv.querySelector('.ack-block');
      if (ack) {
        sawAck = true;
        window.__order.push({ kind: 'ack', t: performance.now(), text: ack.textContent });
      }
    }
    if (!sawText) {
      const text = assistantText();
      if (text && text.trim().length > 0) {
        sawText = true;
        window.__order.push({ kind: 'text', t: performance.now() });
      }
    }
  });
  window.__orderObserver.observe(conv, { childList: true, subtree: true, characterData: true });
  return true;
})()`;

/* ═════════ 1) QUESTION SIMPLE : AUCUN accusé ═════════════════════════════ */
await fetch(`${control}/spoken-reset`);
await evaluate(INSTALL_ORDER_PROBE);
await fetch(`${control}/send?script=question`);
const simpleSummary = await waitForSummary();
check("question simple : le tour se termine (run_summary reçu)", true, JSON.stringify(simpleSummary).slice(0, 120));
await sleep(300);
const simple = await evaluate(`(() => {
  const acks = document.querySelectorAll('.ack-block').length;
  const bubbles = [...document.querySelectorAll('#conversation .message--assistant')];
  const last = bubbles[bubbles.length - 1];
  return {
    acks,
    bubbles: bubbles.length,
    text: last ? (last.querySelector('.message__body')?.textContent ?? '') : '',
    order: window.__order ?? [],
  };
})()`);
check("question simple : AUCUN accusé dans le fil", simple.acks === 0, String(simple.acks));
check(
  "question simple : la réponse est là, entière",
  /Voici la réponse, courte et directe/.test(simple.text),
  simple.text.slice(0, 120),
);
check(
  "question simple : AUCUNE trame d'accusé n'a ouvert le tour",
  simple.order.every((item) => item.kind !== "ack"),
  JSON.stringify(simple.order),
);
check(
  "question simple : le TTFT est mesuré (valeur réelle, non nulle)",
  typeof simpleSummary?.ttftMs === "number" && simpleSummary.ttftMs >= 100,
  JSON.stringify(simpleSummary ?? {}).slice(0, 160),
);
await shot("ack-question-simple");

/* ═════════ 2) ACTION QUI DÉMARRE : accusé AVANT le contenu ══════════════ */
await fetch(`${control}/spoken-reset`);
await evaluate(`window.__orderObserver?.disconnect(); window.__order = []; true`);
await evaluate(INSTALL_ORDER_PROBE);
await fetch(`${control}/send?script=action`);
const actionSummary = await waitForSummary();
check("action : le tour se termine (run_summary reçu)", true, JSON.stringify(actionSummary).slice(0, 120));
await sleep(400);
const action = await evaluate(`(() => {
  const acks = [...document.querySelectorAll('#conversation .ack-block')];
  const ack = acks[acks.length - 1] ?? null;
  const bubbles = [...document.querySelectorAll('#conversation .message--assistant')];
  const last = bubbles[bubbles.length - 1] ?? null;
  const body = last ? last.querySelector('.message__body') : null;
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  // ⚠️ TEXTES SÉLECTIONNÉS / COPIÉS : c'est ce que l'utilisateur récupère quand
  // il sélectionne la bulle (aucun bouton « copier le message » n'existe).
  let selected = '';
  if (last) {
    const range = document.createRange();
    range.selectNodeContents(last);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    selected = sel.toString();
    sel.removeAllRanges();
  }
  return {
    acks: acks.length,
    ackText: ack ? ack.textContent : null,
    ackIsMessage: ack ? ack.classList.contains('message') : null,
    ackRole: ack ? ack.getAttribute('role') : null,
    ackInlineHtml: ack ? ack.querySelectorAll('*').length : -1,
    ackStyled: ack ? ack.getAttribute('style') : null,
    ackRect: ack ? rect(ack) : null,
    bubbleRect: last ? rect(last) : null,
    bubbleText: body ? body.textContent : '',
    // ⚠️ MESURE DE STRUCTURE : l'accusé est-il un ENFANT de la bulle ?
    ackParentIsBubble: Boolean(ack && last && ack.parentElement === last),
    ackInsideBubble: Boolean(ack && last && last.contains(ack)),
    ackInThreadOnly: Boolean(ack && !ack.closest('.message--assistant')),
    // Ordre DANS la bulle : l'accusé PRÉCÈDE le corps de la réponse.
    ackBeforeBody: Boolean(ack && body && (ack.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING)),
    // Le texte complet de la bulle (heure + accusé + réponse) : l'accusé en tête.
    fullText: last ? last.textContent : '',
    selected,
    pending: document.querySelectorAll('#conversation .message__pending').length,
    order: window.__order ?? [],
  };
})()`);
check("action : UN accusé est affiché", action.acks === 1, String(action.acks));
check(
  "l'accusé est COURT et HUMAIN (« Je m'en occupe. »)",
  action.ackText === "Je m'en occupe.",
  String(action.ackText),
);
check(
  "ce n'est PAS une bulle de réponse (pas de classe `message`)",
  action.ackIsMessage === false,
  String(action.ackIsMessage),
);
check(
  "il est annoncé comme un STATUT (`role=status`), rendu en NŒUD TEXTE",
  action.ackRole === "status" && action.ackInlineHtml === 0,
  JSON.stringify({ role: action.ackRole, children: action.ackInlineHtml }),
);
check("aucun attribut de style en ligne (CSP)", action.ackStyled === null, String(action.ackStyled));
check(
  "ORDRE MESURÉ : l'accusé apparaît AVANT le premier texte de la réponse",
  action.order.length === 2 &&
    action.order[0].kind === "ack" &&
    action.order[1].kind === "text" &&
    action.order[0].t < action.order[1].t,
  JSON.stringify(action.order),
);
check(
  "STRUCTURE : l'accusé est un ENFANT de la bulle de réponse (même nœud)",
  action.ackParentIsBubble === true && action.ackInsideBubble === true && action.ackInThreadOnly === false,
  JSON.stringify({
    parent_est_bulle: action.ackParentIsBubble,
    dans_bulle: action.ackInsideBubble,
    hors_bulle: action.ackInThreadOnly,
  }),
);
check(
  "ORDRE DANS LA BULLE : l'accusé est AVANT le corps de la réponse",
  action.ackBeforeBody === true &&
    typeof action.ackRect?.top === "number" &&
    typeof action.bubbleRect?.top === "number" &&
    action.ackRect.top >= action.bubbleRect.top &&
    action.ackRect.bottom <= action.bubbleRect.bottom,
  JSON.stringify({ ack: action.ackRect, bulle: action.bubbleRect }),
);
check(
  "le fond arrive ensuite : la réponse est complète APRÈS l'accusé (pas un remplacement)",
  /Voici la réponse, courte et directe/.test(action.bubbleText),
  action.bubbleText.slice(0, 120),
);
check(
  "la bulle n'est JAMAIS vide : elle porte l'accusé et/ou le texte",
  (action.fullText ?? "").trim().length > 0 && action.pending === 0,
  JSON.stringify({ texte: (action.fullText ?? "").slice(0, 80), attente: action.pending }),
);
check(
  "COPIE DU MESSAGE : l'accusé est dans le texte sélectionné, AVANT la réponse",
  /Je m'en occupe\./.test(action.selected) &&
    /Voici la réponse, courte et directe/.test(action.selected) &&
    action.selected.indexOf("Je m'en occupe.") < action.selected.indexOf("Voici la réponse"),
  JSON.stringify(action.selected.slice(0, 160)),
);
check(
  "AUCUN doublon d'accusé (une seule ligne, même après le texte)",
  (action.fullText.match(/Je m'en occupe\./g) ?? []).length === 1,
  String((action.fullText.match(/Je m'en occupe\./g) ?? []).length),
);
await shot("ack-action");

/* ═════════ 2bis) ACTION SANS CONTENU : l'accusé SEUL dans la bulle ══════ */
await evaluate(`window.__orderObserver?.disconnect(); window.__order = []; true`);
await fetch(`${control}/send?script=action_only`);
await waitForSummary();
await sleep(400);
const onlyAck = await evaluate(`(() => {
  const bubbles = [...document.querySelectorAll('#conversation .message--assistant')];
  const last = bubbles[bubbles.length - 1] ?? null;
  const ack = last ? last.querySelector('.ack-block') : null;
  const body = last ? last.querySelector('.message__body') : null;
  return {
    bubbles: bubbles.length,
    ackText: ack ? ack.textContent : null,
    ackInBubble: Boolean(ack && last && ack.parentElement === last),
    bodyText: body ? body.textContent : null,
    fullText: last ? last.textContent.trim() : '',
    pending: document.querySelectorAll('#conversation .message__pending').length,
  };
})()`);
check(
  "action SANS texte : la bulle affiche l'ACCUSÉ seul (jamais une bulle vide)",
  onlyAck.ackInBubble === true &&
    onlyAck.ackText === "C'est parti." &&
    (onlyAck.fullText ?? "").replace(/\d{2}:\d{2}/, "").trim().length > 0,
  JSON.stringify(onlyAck),
);
check(
  "action SANS texte : aucune parenthèse technique contradictoire dans le corps",
  (onlyAck.bodyText ?? "") === "" && onlyAck.pending === 0,
  JSON.stringify({ corps: onlyAck.bodyText, attente: onlyAck.pending }),
);
await shot("ack-action-sans-texte");

/* ═════════ 2ter) RECHARGEMENT : l'accusé est PERSISTÉ avec le message ═══ */
await navigate(`${base}/`);
check(
  "rechargement : connexion rétablie",
  await waitFor(`document.querySelector('#connection')?.textContent === 'connecté'`),
);
const afterReload = await evaluate(`(() => {
  const bubbles = [...document.querySelectorAll('#conversation .message--assistant')];
  const withAck = bubbles.filter((b) => b.querySelector('.ack-block'));
  return {
    bubbles: bubbles.length,
    withAck: withAck.length,
    acks: [...document.querySelectorAll('#conversation .ack-block')].map((a) => a.textContent),
    acksInBubbles: [...document.querySelectorAll('#conversation .ack-block')].every(
      (a) => a.parentElement && a.parentElement.classList.contains('message--assistant'),
    ),
    emptyBubbles: bubbles.filter((b) => {
      const body = b.querySelector('.message__body');
      return (body ? body.textContent : '').trim() === '' && !b.querySelector('.ack-block');
    }).length,
  };
})()`);
check(
  "RECHARGEMENT : les accusés sont TOUJOURS là (persistés avec le message)",
  afterReload.withAck === 2 && afterReload.acks.includes("Je m'en occupe.") && afterReload.acks.includes("C'est parti."),
  JSON.stringify(afterReload),
);
check(
  "RECHARGEMENT : les accusés sont DANS les bulles (aucun bloc hors bulle)",
  afterReload.acksInBubbles === true,
  JSON.stringify(afterReload.acks),
);
check(
  "RECHARGEMENT : AUCUNE bulle vide",
  afterReload.emptyBubbles === 0,
  String(afterReload.emptyBubbles),
);
await shot("ack-apres-rechargement");

/* ═════════ 3) AUCUN surcoût au TTFT (même délai de premier token) ═══════ */
const ttftQuestion = simpleSummary?.ttftMs;
const ttftAction = actionSummary?.ttftMs;
const delta = Math.abs((ttftAction ?? 0) - (ttftQuestion ?? 0));
check(
  "TTFT du tour AVEC accusé : mesuré, comparable au tour SANS accusé",
  typeof ttftQuestion === "number" &&
    typeof ttftAction === "number" &&
    ttftAction >= 100 &&
    delta <= 60,
  JSON.stringify({ sans_accuse: ttftQuestion, avec_accuse: ttftAction, ecart_ms: delta }),
);

/* ═════════ 4) L'accusé n'est JAMAIS prononcé ════════════════════════════ */
await sleep(700);
const spoken = (await fetch(`${control}/spoken`).then((r) => r.json())).spoken ?? [];
const spokenText = spoken.join(" ").replace(/\s+/g, "");
check(
  "la synthèse vocale a bien PRONONCÉ la réponse (témoin)",
  spokenText.length > 0 && /courteetdirecte/i.test(spokenText),
  String(spokenText).slice(0, 120),
);
check(
  "l'accusé n'est JAMAIS prononcé par la TTS",
  !/occupe/i.test(spokenText),
  String(spokenText).slice(0, 160),
);

await navigate("about:blank");
proc.kill("SIGTERM");
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
