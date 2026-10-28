#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — ACCUSÉ DE RÉCEPTION écrit par le MODÈLE, mesuré dans un
 * VRAI navigateur (Chromium headless + CDP, CSP réelle).
 *
 * Ce que l'on prouve PAR MESURE (et non par lecture du code) :
 *   1. une QUESTION SIMPLE ne produit AUCUN accusé (et sa réponse est intacte) ;
 *   2. une ACTION qui démarre produit un accusé dont le TEXTE VIENT DU MODÈLE
 *      (`data-ack-source="model"`), et ce texte ARRIVE AVANT la réponse ;
 *   3. DEUX tours d'action différents donnent DEUX formulations DIFFÉRENTES ⇒
 *      le texte n'est pas figé dans le code (c'était le défaut signalé) ;
 *   3bis. un run qui n'écrit QUE l'accusé affiche l'accusé SEUL (jamais une bulle vide) ;
 *   3ter. les accusés SURVIVENT au RECHARGEMENT, à l'identique (persistés avec le message) ;
 *   3quater. MODÈLE MUET ⇒ repli en dur, avec des VARIATIONS (deux phrases différentes)
 *      et une origine ANNONCÉE (`data-ack-source="fallback"`) ⇒ le taux de repli est
 *      mesurable : c'est ce compteur qu'il faut surveiller en production ;
 *   4. l'accusé arrive au PREMIER TEXTE du modèle : même TTFT qu'un tour ordinaire ;
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

/** Réponse identique à tous les tours : seul l'accusé change. */
const ANSWER = "Voici la réponse, courte et directe : deux lignes suffisent.";

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

/**
 * Observateur d'ORDRE : il horodate (performance.now) l'apparition de l'accusé et
 * le PREMIER TEXTE de la bulle de réponse. ⚠️ C'est la mesure de l'ordre, pas une
 * simple présence.
 */
const INSTALL_ORDER_PROBE = `(() => {
  window.__order = [];
  const conv = document.querySelector('#conversation');
  const bubbles = () => [...document.querySelectorAll('#conversation .message--assistant')];
  /** La bulle qui porte l'ACCUSÉ (elle n'a que lui), ou null. */
  const ackBubble = () => bubbles().find((b) => b.querySelector('.ack-block')) ?? null;
  /** Texte de la dernière bulle de RÉPONSE (jamais celle de l'accusé). */
  const replyText = () => {
    const list = bubbles();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i].querySelector('.ack-block')) continue;
      const body = list[i].querySelector('.message__body');
      return body ? body.textContent : '';
    }
    return '';
  };
  let sawAck = false;
  let sawText = false;
  window.__orderObserver = new MutationObserver(() => {
    if (!sawAck) {
      const bubble = ackBubble();
      const ack = bubble ? bubble.querySelector('.ack-block') : null;
      if (ack) {
        sawAck = true;
        window.__order.push({ kind: 'ack', t: performance.now(), text: ack.textContent });
      }
    }
    if (!sawText) {
      const text = replyText();
      if (text && text.trim().length > 0) {
        sawText = true;
        window.__order.push({ kind: 'text', t: performance.now() });
      }
    }
  });
  window.__orderObserver.observe(conv, { childList: true, subtree: true, characterData: true });
  return true;
})()`;

/**
 * Relève le dernier TOUR d'accusé : la bulle d'ACCUSÉ et, séparément, la bulle de
 * RÉPONSE. ⚠️ On mesure AUSSI le style calculé de l'accusé : c'est la preuve qu'il
 * a le rendu d'un message ordinaire (ni italique, ni grisé, ni plus petit).
 */
const READ_LAST_ACK = `(() => {
  const bubbles = [...document.querySelectorAll('#conversation .message--assistant')];
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
  let ackIndex = -1;
  for (let i = bubbles.length - 1; i >= 0; i -= 1) {
    if (bubbles[i].querySelector('.ack-block')) { ackIndex = i; break; }
  }
  const ackBubble = ackIndex >= 0 ? bubbles[ackIndex] : null;
  const ack = ackBubble ? ackBubble.querySelector('.ack-block') : null;
  const reply = bubbles.length > 0 ? bubbles[bubbles.length - 1] : null;
  const replyBody = reply && reply !== ackBubble ? reply.querySelector('.message__body') : null;
  const ackStyle = ack ? getComputedStyle(ack) : null;
  const bodyStyle = replyBody ? getComputedStyle(replyBody) : null;
  const select = (el) => {
    if (!el) return '';
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    const text = sel.toString();
    sel.removeAllRanges();
    return text;
  };
  return {
    bubbles: bubbles.length,
    acks: document.querySelectorAll('#conversation .ack-block').length,
    ackText: ack ? ack.textContent : null,
    ackSource: ack ? (ack.dataset.ackSource ?? null) : null,
    ackRole: ack ? ack.getAttribute('role') : null,
    ackInlineHtml: ack ? ack.querySelectorAll('*').length : -1,
    ackStyled: ack ? ack.getAttribute('style') : null,
    // ⚠️ STRUCTURE : l'accusé ouvre SA PROPRE bulle (distincte de la réponse).
    ackHasOwnBubble: Boolean(ack && ackBubble && ackBubble !== reply),
    ackBubbleBodyText: ackBubble ? (ackBubble.querySelector('.message__body')?.textContent ?? '') : null,
    ackBubbleOnlyAck: Boolean(ackBubble && (ackBubble.querySelector('.message__body')?.textContent ?? '').trim() === ''),
    ackBubbleBeforeReply: Boolean(
      ackBubble && reply && ackBubble !== reply &&
      (ackBubble.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING),
    ),
    ackHasTime: Boolean(ackBubble && ackBubble.querySelector('.message__time')),
    replyHasTime: Boolean(reply && reply !== ackBubble && reply.querySelector('.message__time')),
    ackFontStyle: ackStyle ? ackStyle.fontStyle : null,
    ackFontSize: ackStyle ? ackStyle.fontSize : null,
    bodyFontSize: bodyStyle ? bodyStyle.fontSize : null,
    ackColor: ackStyle ? ackStyle.color : null,
    bodyColor: bodyStyle ? bodyStyle.color : null,
    ackRect: ack ? rect(ack) : null,
    ackBubbleRect: ackBubble ? rect(ackBubble) : null,
    // ⚠️ Deux messages d'assistant CONSÉCUTIFS gardent un séparateur visuel (règle
    // de voisin immédiat) : la bulle d'accusé et celle de la réponse ne se
    // confondent pas.
    replyMarginTop: reply && reply !== ackBubble ? getComputedStyle(reply).marginTop : null,
    ackToReplyGap: ackBubble && reply && reply !== ackBubble
      ? Math.round(rect(reply).top - rect(ackBubble).bottom)
      : null,
    bodyText: replyBody ? replyBody.textContent : '',
    fullText: document.querySelector('#conversation').textContent,
    selectedAck: select(ackBubble),
    selectedReply: select(replyBody),
    pending: document.querySelectorAll('#conversation .message__pending').length,
    order: window.__order ?? [],
  };
})()`;

/**
 * ORDRE DU FIL : la suite des nœuds de `#conversation` avec leur nature. C'est la
 * mesure qui prouve ACCUSÉ → IMAGE → TEXTE (en direct ET après rechargement), et
 * que les médias ne sont pas regroupés en bas.
 */
const READ_THREAD_ORDER = `(() => {
  const kindOf = (n) => {
    if (n.classList.contains('message--user')) return 'user';
    if (n.classList.contains('message--assistant')) {
      return n.querySelector('.ack-block') ? 'ack' : 'text';
    }
    if (n.classList.contains('generated-image')) return 'image';
    if (n.classList.contains('screenshot')) return 'capture';
    if (n.classList.contains('daysep')) return 'daysep';
    return n.className || n.tagName.toLowerCase();
  };
  return [...document.querySelector('#conversation').children].map((n) => ({
    kind: kindOf(n),
    at: n.dataset.ts ?? null,
    empty: (n.textContent ?? '').trim() === '' && !n.querySelector('img'),
  }));
})()`;

/**
 * Le SEUL dernier tour : à partir du dernier message utilisateur s'il est affiché
 * (après rechargement), sinon du dernier accusé (en direct, le message utilisateur
 * n'est pas encore rendu). Le message utilisateur et les séparateurs de jour sont
 * écartés : on compare la même chose des deux côtés.
 */
function lastTurnOrder(order) {
  const kinds = order.map((n) => n.kind);
  const userAt = kinds.lastIndexOf('user');
  const ackAt = kinds.lastIndexOf('ack');
  const start = Math.max(userAt, ackAt);
  return (start >= 0 ? kinds.slice(start) : kinds).filter(
    (kind) => kind !== 'user' && kind !== 'daysep',
  );
}

async function runScript(script) {
  await fetch(`${control}/spoken-reset`);
  await evaluate(`window.__orderObserver?.disconnect(); window.__order = []; true`);
  await evaluate(INSTALL_ORDER_PROBE);
  await fetch(`${control}/send?script=${script}`);
  const summary = await waitForSummary();
  await sleep(400);
  return summary;
}

await navigate(`${base}/`);
check(
  "connexion au gateway établie",
  await waitFor(`document.querySelector('#connection')?.textContent === 'connecté'`),
);

/* ═════════ 1) QUESTION SIMPLE : AUCUN accusé ═════════════════════════════ */
const simpleSummary = await runScript("question");
check(
  "question simple : le tour se termine (run_summary reçu)",
  true,
  JSON.stringify(simpleSummary).slice(0, 120),
);
const simple = await evaluate(READ_LAST_ACK);
check("question simple : AUCUN accusé dans le fil", simple.acks === 0, String(simple.acks));
check(
  "question simple : la réponse est là, entière",
  /Voici la réponse, courte et directe/.test(simple.bodyText),
  simple.bodyText.slice(0, 120),
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

/* ═════════ 2) ACTION : l'accusé vient du MODÈLE, avant la réponse ════════ */
const actionSummary = await runScript("action");
const action = await evaluate(READ_LAST_ACK);
check("action : UN seul accusé est affiché", action.acks === 1, String(action.acks));
check(
  "action : le texte de l'accusé est CELUI DU MODÈLE (« Je m'en occupe. »)",
  action.ackText === "Je m'en occupe." && action.ackSource === "model",
  JSON.stringify({ texte: action.ackText, origine: action.ackSource }),
);
check(
  "ce n'est PAS une bulle de réponse (pas de classe `message`)",
  await evaluate(`document.querySelectorAll('#conversation .ack-block.message').length === 0`),
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
    action.order[0].t <= action.order[1].t,
  JSON.stringify(action.order),
);
check(
  "STRUCTURE : l'accusé ouvre SA PROPRE bulle, AVANT celle de la réponse",
  action.ackHasOwnBubble === true &&
    action.ackBubbleOnlyAck === true &&
    action.ackBubbleBeforeReply === true &&
    typeof action.ackRect?.top === "number" &&
    action.ackRect.top >= action.ackBubbleRect.top &&
    action.ackRect.bottom <= action.ackBubbleRect.bottom,
  JSON.stringify({
    bulle_propre: action.ackHasOwnBubble,
    bulle_avant_reponse: action.ackBubbleBeforeReply,
    bulle_sans_corps: action.ackBubbleOnlyAck,
  }),
);
check(
  "RENDU D'UN MESSAGE NORMAL : pas d'italique, même taille et même couleur que la réponse",
  action.ackFontStyle === "normal" &&
    action.ackFontSize === action.bodyFontSize &&
    action.ackColor === action.bodyColor,
  JSON.stringify({
    font_style: action.ackFontStyle,
    taille_accuse: action.ackFontSize,
    taille_reponse: action.bodyFontSize,
    meme_couleur: action.ackColor === action.bodyColor,
  }),
);
check(
  "SÉPARATEUR : deux messages d'assistant consécutifs restent DISTINCTS (marge de 22 px)",
  action.replyMarginTop === "22px" && (action.ackToReplyGap ?? 0) >= 30,
  JSON.stringify({ marge: action.replyMarginTop, ecart_px: action.ackToReplyGap }),
);
check(
  "RENDU D'UN MESSAGE NORMAL : il porte son HORODATAGE, comme une réponse",
  action.ackHasTime === true && action.replyHasTime === true,
  JSON.stringify({ accuse: action.ackHasTime, reponse: action.replyHasTime }),
);
check(
  "le fond arrive ensuite : la réponse est complète APRÈS l'accusé",
  /Voici la réponse, courte et directe/.test(action.bodyText),
  action.bodyText.slice(0, 120),
);
check(
  "la bulle n'est JAMAIS vide : elle porte l'accusé et/ou le texte",
  (action.fullText ?? "").trim().length > 0 && action.pending === 0,
  JSON.stringify({ texte: (action.fullText ?? "").slice(0, 80), attente: action.pending }),
);
check(
  "COPIE : l'accusé est un texte à part, la réponse ne le contient PAS (aucun doublon)",
  /Je m'en occupe\./.test(action.selectedAck) &&
    /Voici la réponse, courte et directe/.test(action.selectedReply) &&
    !/Je m'en occupe\./.test(action.selectedReply),
  JSON.stringify({
    accuse: action.selectedAck.slice(0, 60),
    reponse: action.selectedReply.slice(0, 60),
  }),
);
check(
  "AUCUN doublon d'accusé (une seule ligne, même après le texte)",
  (action.fullText.match(/Je m'en occupe\./g) ?? []).length === 1,
  String((action.fullText.match(/Je m'en occupe\./g) ?? []).length),
);
await shot("ack-action");

/* ═════════ 2bis) AUTRE CONTEXTE ⇒ AUTRE FORMULATION (texte du modèle) ════ */
await runScript("action_variant");
const variant = await evaluate(READ_LAST_ACK);
check(
  "2ᵉ tour d'action : le modèle a écrit une AUTRE phrase (« Deux secondes, je m'en occupe. »)",
  variant.ackText === "Deux secondes, je m'en occupe." && variant.ackSource === "model",
  JSON.stringify({ texte: variant.ackText, origine: variant.ackSource }),
);
check(
  "⚠️ le texte VARIE : deux formulations DIFFÉRENTES observées (plus de libellé figé)",
  typeof action.ackText === "string" &&
    typeof variant.ackText === "string" &&
    action.ackText !== variant.ackText,
  JSON.stringify({ tour1: action.ackText, tour2: variant.ackText }),
);
check(
  "2ᵉ tour d'action : l'accusé précède encore le premier texte",
  variant.order.length === 2 && variant.order[0].kind === "ack" && variant.order[1].kind === "text",
  JSON.stringify(variant.order),
);
await shot("ack-action-variante");

/* ═════════ 2ter) ACTION SANS RÉPONSE : l'accusé SEUL dans la bulle ═══════ */
await runScript("action_only");
const onlyAck = await evaluate(READ_LAST_ACK);
check(
  "action SANS texte : la bulle d'accusé EST tout le message (jamais une bulle vide)",
  onlyAck.ackText === "C'est parti." &&
    onlyAck.ackBubbleOnlyAck === true &&
    onlyAck.bodyText === "" &&
    onlyAck.pending === 0,
  JSON.stringify({
    texte: onlyAck.ackText,
    corps: onlyAck.bodyText,
    attente: onlyAck.pending,
    bulle_sans_corps: onlyAck.ackBubbleOnlyAck,
    corps_de_la_bulle: onlyAck.ackBubbleBodyText,
  }),
);
await shot("ack-action-sans-texte");

/* ═════════ 2quater) MODÈLE MUET ⇒ REPLI EN DUR, AVEC VARIATIONS ═════════ */
await runScript("silent");
const silent1 = await evaluate(READ_LAST_ACK);
await runScript("silent");
const silent2 = await evaluate(READ_LAST_ACK);
check(
  "modèle MUET : le repli parle et son ORIGINE est annoncée (`model` / `fallback`)",
  silent1.ackSource === "fallback" && silent1.ackText === "Je m'en occupe.",
  JSON.stringify({ texte: silent1.ackText, origine: silent1.ackSource }),
);
check(
  "⚠️ le REPLI VARIE : deux replis consécutifs ne disent PAS la même phrase",
  typeof silent1.ackText === "string" &&
    typeof silent2.ackText === "string" &&
    silent1.ackText !== silent2.ackText,
  JSON.stringify({ repli1: silent1.ackText, repli2: silent2.ackText }),
);
check(
  "les deux replis restent COURTS (une ligne, borne serveur respectée)",
  [silent1.ackText, silent2.ackText].every(
    (text) => typeof text === "string" && text.length <= 90 && !text.includes("\n"),
  ),
  JSON.stringify([silent1.ackText, silent2.ackText]),
);
await shot("ack-repli");

/* TAUX DE REPLI de la série : replis observés / tours d'action observés. */
const actionTurns = 5; // action, action_variant, action_only, silent, silent
const fallbackTurns = 2;
const fallbackRate = Math.round((fallbackTurns / actionTurns) * 100);
console.log(
  `\nℹ️  TAUX DE REPLI observé sur cette série : ${fallbackTurns}/${actionTurns} = ${fallbackRate} % ` +
    "(tours dont le modèle est un SCÉNARIO muet — mesure du MÉCANISME, pas de l'obéissance du vrai modèle).",
);

/* ═════════ 2sexies) ORDRE DU FIL : ACCUSÉ → MÉDIAS → RÉPONSE ════════════
 * ⚠️ C'est la mesure centrale : un tour qui lance une action LONGUE doit produire
 *   ① la bulle d'accusé, ② les cartes des médias produits par l'action, ③ la bulle
 *   de réponse — et le MÊME ordre après un RECHARGEMENT (les médias sont ré-émis
 *   APRÈS le snapshot : ils doivent retrouver leur place, pas finir en bas).
 */
await fetch(`${control}/spoken-reset`);
await evaluate(`window.__orderObserver?.disconnect(); window.__order = []; true`);
const acksBefore = await evaluate(`document.querySelectorAll('#conversation .ack-block').length`);
await fetch(`${control}/send?script=media`);
check(
  "ordre : l'ACCUSÉ de CE tour apparaît en premier (bulle à lui)",
  await waitFor(
    `document.querySelectorAll('#conversation .ack-block').length > ${acksBefore}`,
    8000,
  ),
  `accusés avant = ${acksBefore}`,
);
// L'action est EN COURS (pause mesurée côté serveur) : les médias sont créés
// MAINTENANT, donc APRÈS l'accusé et AVANT la réponse — comme une vraie génération.
const mediaA = Date.now();
await fetch(`${control}/emit-media?kind=image&label=a&at=${new Date(mediaA).toISOString()}`).then((r) => r.json());
await fetch(`${control}/emit-media?kind=image&label=b&at=${new Date(mediaA + 1).toISOString()}`).then((r) => r.json());
await fetch(`${control}/emit-media?kind=screenshot&label=c&at=${new Date(mediaA + 2).toISOString()}`).then((r) => r.json());
await waitForSummary();
await sleep(500);
const liveOrder = lastTurnOrder(await evaluate(READ_THREAD_ORDER));
check(
  "ORDRE EN DIRECT : ACCUSÉ → IMAGE → IMAGE → CAPTURE → RÉPONSE",
  JSON.stringify(liveOrder) === JSON.stringify(["ack", "image", "image", "capture", "text"]),
  JSON.stringify(liveOrder),
);
const liveMedia = await evaluate(`document.querySelectorAll('#conversation img.md-image').length`);
check(
  "les trois médias sont AFFICHÉS dans le fil (deux images + une capture)",
  liveMedia >= 3,
  String(liveMedia),
);
await shot("ack-ordre-direct");

/* ═════════ 2quinquies) RECHARGEMENT : accusés ET ordre des médias ════════ */
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
    // ⚠️ Aucun CORPS de réponse ne recopie une phrase d'accusé (aucun doublon) :
    // l'accusé est un message à part, jamais la première ligne de la réponse.
    duplicated: bubbles.filter((b) => {
      const body = b.querySelector('.message__body');
      if (!body) return false;
      const text = body.textContent;
      return [...document.querySelectorAll('#conversation .ack-block')].some(
        (ack) => ack.textContent.trim().length > 0 && text.includes(ack.textContent.trim()),
      );
    }).length,
  };
})()`);
check(
  "RECHARGEMENT : les SIX accusés sont TOUJOURS là (persistés comme des messages)",
  afterReload.withAck === 6 &&
    afterReload.acks.includes("Je m'en occupe.") &&
    afterReload.acks.includes("Deux secondes, je m'en occupe.") &&
    afterReload.acks.includes("C'est parti."),
  JSON.stringify(afterReload.acks),
);
check(
  "RECHARGEMENT : les accusés sont DANS les bulles (aucun bloc hors bulle)",
  afterReload.acksInBubbles === true,
  JSON.stringify(afterReload.acks),
);
check(
  "RECHARGEMENT : l'accusé n'est JAMAIS répété dans le corps de la réponse",
  afterReload.duplicated === 0,
  String(afterReload.duplicated),
);
check(
  "RECHARGEMENT : AUCUNE bulle vide",
  afterReload.emptyBubbles === 0,
  String(afterReload.emptyBubbles),
);
const reloadOrder = lastTurnOrder(await evaluate(READ_THREAD_ORDER));
check(
  "RECHARGEMENT : MÊME ordre qu'en direct — ACCUSÉ → IMAGE → IMAGE → CAPTURE → RÉPONSE",
  JSON.stringify(reloadOrder) === JSON.stringify(["ack", "image", "image", "capture", "text"]),
  JSON.stringify(reloadOrder),
);
check(
  "RECHARGEMENT : les médias ne sont PAS regroupés en bas (aucun après la réponse)",
  reloadOrder.indexOf("text") === reloadOrder.length - 1,
  JSON.stringify(reloadOrder),
);
const restoredMedia = await evaluate(`document.querySelectorAll('#conversation img.md-image').length`);
check(
  "RECHARGEMENT : aucun média en DOUBLE (trois médias, trois images)",
  restoredMedia === liveMedia,
  `${liveMedia} → ${restoredMedia}`,
);
await shot("ack-apres-rechargement");

/* ═════════ 3) AUCUN surcoût au TTFT (même délai de premier texte) ═══════ */
const ttftQuestion = simpleSummary?.ttftMs;
const ttftAction = actionSummary?.ttftMs;
const delta = Math.abs((ttftAction ?? 0) - (ttftQuestion ?? 0));
check(
  "TTFT du tour AVEC accusé : le PREMIER TEXTE du modèle, comme un tour ordinaire",
  typeof ttftQuestion === "number" &&
    typeof ttftAction === "number" &&
    ttftAction >= 100 &&
    delta <= 60,
  JSON.stringify({ sans_accuse: ttftQuestion, avec_accuse: ttftAction, ecart_ms: delta }),
);

/* ═════════ 4) L'accusé n'est JAMAIS prononcé ════════════════════════════ */
await runScript("action");
await sleep(700);
const spoken = (await fetch(`${control}/spoken`).then((r) => r.json())).spoken ?? [];
const spokenText = spoken.join(" ").replace(/\s+/g, "");
check(
  "la synthèse vocale a bien PRONONCÉ la réponse (témoin)",
  spokenText.length > 0 && /courteetdirecte/i.test(spokenText),
  String(spokenText).slice(0, 120),
);
check(
  "l'accusé n'est JAMAIS prononcé par la TTS (ni le repli)",
  !/occupe/i.test(spokenText) &&
    !/c'est parti/i.test(spokenText) &&
    !/deux secondes/i.test(spokenText),
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
