#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — ① séparation VISUELLE de tours assistant CONSÉCUTIFS et
 * ② pied de stats EN DIRECT (provisoire → final), dans un VRAI navigateur
 * (Chromium headless + CDP, CSP réelle).
 *
 * Ce que l'on prouve PAR MESURE :
 *   1. le pied de stats est PRÉSENT pendant la génération et ses valeurs
 *      ÉVOLUENT (au moins deux échantillons distincts) → puis les valeurs FINALES
 *      de `run_summary` les remplacent ;
 *   2. le TTFT provient de la MESURE serveur (trame `phase`) et n'est affiché
 *      qu'au premier token ;
 *   3. deux tours assistant CONSÉCUTIFS (un accusé, puis un rapport synthétique
 *      SANS bulle utilisateur) sont séparés d'UNE LIGNE d'air MESURÉE (px) ;
 *   4. la mise à jour du pied ne DÉCALE pas le fil (positions mesurées) ;
 *   5. le TEXTE est INCHANGÉ : aucun séparateur inséré, copie/corps identiques,
 *      TTS identique (le pied n'est JAMAIS prononcé) ;
 *   6. accessibilité : le pied n'est PAS en `aria-live` ; le provisoire est
 *      retiré de l'arbre d'accessibilité.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-live-stats.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { collectViolations, waitForGateway } from "./browser-violations.mjs";
import { runMetricsText } from "../../public/ui/run-stats.js";

const TOOLS = import.meta.dirname;
const WORKSPACE = join(TOOLS, "..");
const YUKI_DIR = join(WORKSPACE, "Yuki");
const TSX = join(YUKI_DIR, "node_modules", ".bin", "tsx");

// Captures dans un dossier TEMPORAIRE : aucun artefact suivi n'est modifié.
const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-live-stats-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const USER_TEXT = "Peux-tu analyser le dépôt en tâche de fond ?";
const ACK_TEXT = "Je lance la tâche de fond, je reviens vers toi.";

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
const logs = [];
const proc = spawn(TSX, [join(TOOLS, "e2e-live-stats-serve.ts")], {
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
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-live-stats-chrome-"));
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
    await sleep(80);
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

const READ_LIVE = `(() => {
  const msgs = [...document.querySelectorAll('#conversation .message--assistant')];
  const last = msgs[msgs.length - 1];
  const body = last ? last.querySelector('.message__body.markdown') : null;
  const footer = last ? last.querySelector('.message__footer') : null;
  const stats = footer ? footer.querySelector('.message__stats') : null;
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  return {
    bubbles: msgs.length,
    footerPresent: !!footer,
    footerText: footer ? footer.textContent : null,
    statsAriaHidden: stats ? stats.getAttribute('aria-hidden') : null,
    statsAriaLive: stats ? stats.getAttribute('aria-live') : null,
    footerAriaLive: footer ? footer.getAttribute('aria-live') : null,
    bodyText: body ? body.textContent : null,
    bodyRect: body ? rect(body) : null,
    msgRect: last ? rect(last) : null,
    state: document.getElementById('session-state')?.textContent ?? null,
  };
})()`;

await navigate(`${base}/`);
check(
  "connexion au gateway établie",
  await waitFor(`document.querySelector('#connection')?.textContent === 'connecté'`),
);
await fetch(`${control}/spoken-reset`);

/* ══════════ 1) LE PIED EST LÀ PENDANT LA GÉNÉRATION ET SES VALEURS ÉVOLUENT ═ */
await evaluate(`(() => {
  const input = document.querySelector('#input');
  input.value = ${JSON.stringify(USER_TEXT)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#send').click();
  return true;
})()`);

const samples = [];
const deadline = Date.now() + 12_000;
let finalized = null;
while (Date.now() < deadline) {
  const s = await evaluate(READ_LIVE);
  samples.push({ t: Date.now(), ...s });
  if (s.state === 'idle' && s.footerPresent && /tok|total \d+ ms/.test(s.footerText ?? '')) {
    finalized = s;
    break;
  }
  await sleep(45);
}
// Un dernier échantillon après stabilisation (le `run_summary` suit le
// `run_finished` de quelques millisecondes).
await sleep(400);
const afterFinal = await evaluate(READ_LIVE);

// Échantillons PENDANT la génération : pied présent alors que le CONTENU est
// encore INCOMPLET (preuve que le pied ne dépend pas de la fin du run).
const partial = samples.filter(
  (s) => s.bubbles >= 1 && s.footerPresent && (s.bodyText ?? '').length < ACK_TEXT.length,
);
const distinctPartialFooter = [...new Set(partial.map((s) => s.footerText))];
const beforeFirstToken = samples.filter(
  (s) => s.bubbles >= 1 && s.footerPresent && (s.bodyText ?? '').length === 0,
);
// Évolution du temps écoulé : au moins deux valeurs « total N ms » STRICTEMENT
// croissantes parmi les échantillons partiels.
const totals = partial
  .map((s) => Number((s.footerText ?? '').match(/total (\d+) ms/)?.[1]))
  .filter((n) => Number.isFinite(n));
const strictlyIncreasing = totals.some((v, i) => i > 0 && v > totals[i - 1]);

check(
  "LIVE : le pied de stats est PRÉSENT pendant la génération (contenu encore incomplet)",
  partial.length >= 2,
  `${partial.length} échantillon(s) avec pied + contenu partiel`,
);
check(
  "LIVE : le pied apparaît DÈS LE LANCEMENT, avant le premier token (bulle vide)",
  beforeFirstToken.length >= 1,
  `${beforeFirstToken.length} échantillon(s) avec pied et bulle vide ; 1er=${JSON.stringify(beforeFirstToken[0]?.footerText ?? null)}`,
);
check(
  "LIVE : les valeurs ÉVOLUENT en direct (≥ 2 textes de pied distincts)",
  distinctPartialFooter.length >= 2,
  distinctPartialFooter.slice(0, 4).join("  |  "),
);
check(
  "LIVE : le temps écoulé AVANCE (deux « total » strictement croissants)",
  strictlyIncreasing,
  `totaux=[${totals.slice(0, 8).join(", ")}]`,
);
check(
  "LIVE : le TTFT (MESURE serveur) apparaît au premier token",
  partial.some((s) => /TTFT \d+ ms/.test(s.footerText ?? '')),
  JSON.stringify(distinctPartialFooter.find((t) => /TTFT/.test(t ?? '')) ?? null),
);
check(
  "LIVE : AUCUN « tok » provisoire (aucune valeur inventée pendant le run)",
  partial.every((s) => !/tok/.test(s.footerText ?? '')),
  JSON.stringify(distinctPartialFooter.slice(0, 4)),
);

/* ══════════ 2) LES VALEURS FINALES DE `run_summary` REMPLACENT LES PROVISOIRES ═ */
const summaryResp = await fetch(`${control}/last-summary`).then((r) => r.json());
const summary = summaryResp.summary;
const expectedFinal = runMetricsText(summary);
check(
  "FINAL : le pied affiché correspond EXACTEMENT à `run_summary` (TTFT + total + tok)",
  afterFinal.footerText === expectedFinal && expectedFinal !== null,
  `DOM=${JSON.stringify(afterFinal.footerText)} ; run_summary=${JSON.stringify(expectedFinal)}`,
);
check(
  "FINAL : le pied provisoire (aria-hidden) redevient annonçable",
  afterFinal.statsAriaHidden === null,
  `aria-hidden=${JSON.stringify(afterFinal.statsAriaHidden)}`,
);
check(
  "ACCESSIBILITÉ : le pied n'est JAMAIS en `aria-live` (ni footer, ni stats)",
  afterFinal.footerAriaLive === null && afterFinal.statsAriaLive === null,
  `footer=${JSON.stringify(afterFinal.footerAriaLive)} stats=${JSON.stringify(afterFinal.statsAriaLive)}`,
);

/* ══════════ 3) PIED NON PRONONCÉ (TTS) — le texte n'a pas changé ════════ */
await sleep(700); // laisse le pipeline synthétiser la fin
const spoken1 = await fetch(`${control}/spoken`).then((r) => r.json());
const spoken1Text = spoken1.spoken.join(" ⏎ ");
check(
  "TTS : le CONTENU de la réponse est bien synthétisé (preuve non vide)",
  spoken1.spoken.some((t) => t.includes("tâche de fond")),
  spoken1Text.slice(0, 160),
);
check(
  "TTS : le PIED de stats n'est JAMAIS prononcé (ni « total », ni « TTFT », ni « tok »)",
  !/TTFT|total \d|tok/.test(spoken1Text),
  spoken1Text.slice(0, 200),
);

/* ══════════ 4) DEUX TOURS ASSISTANT CONSÉCUTIFS (rapport sans bulle user) ═ */
const reportResp = await fetch(`${control}/report`).then((r) => r.json());
check("le tour de RAPPORT est lancé (origine `job_report`)", reportResp.ok === true);
await waitFor(`document.querySelectorAll('#conversation .message--assistant').length === 2`);
await waitFor(`document.getElementById('session-state')?.textContent === 'idle'`);
await sleep(300);

const layout = await evaluate(`(() => {
  const msgs = [...document.querySelectorAll('#conversation .message--assistant')];
  const users = [...document.querySelectorAll('#conversation .message--user')];
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  const gaps = [];
  for (let i = 1; i < msgs.length; i++) {
    gaps.push(Math.round(msgs[i].getBoundingClientRect().top - msgs[i - 1].getBoundingClientRect().bottom));
  }
  const conversationGap = getComputedStyle(document.querySelector('#conversation')).gap;
  const marginSecond = getComputedStyle(msgs[msgs.length - 1]).marginTop;
  // Corps MARKDOWN (contenu SEUL, sans en-tête d'heure ni pied).
  const bodies = msgs.map((m) => m.querySelector('.message__body.markdown')?.textContent ?? '');
  // Le pied est-il DANS le corps de contenu ? (il ne doit jamais y être)
  const footersInBody = document.querySelectorAll('.message--assistant .message__body.markdown .message__footer').length;
  return {
    assistantCount: msgs.length,
    userCount: users.length,
    gapBetweenAssistants: gaps[gaps.length - 1],
    conversationGap,
    marginSecond,
    bodies,
    footersInBody,
    msgRects: msgs.map(rect),
  };
})()`);

check(
  "SÉPARATION : le 2e tour assistant est CONSÉCUTIF et SANS bulle utilisateur intercalée",
  layout.assistantCount === 2 && layout.userCount === 1,
  `${layout.assistantCount} bulle(s) assistant, ${layout.userCount} bulle(s) utilisateur`,
);
check(
  "SÉPARATION MESURÉE : une ligne d'air s'ajoute aux 12 px du conteneur (≥ 30 px)",
  layout.gapBetweenAssistants >= 30,
  `écart mesuré = ${layout.gapBetweenAssistants} px (gap conteneur = ${layout.conversationGap} ; margin-top = ${layout.marginSecond})`,
);
check(
  "SÉPARATION : le 1er tour s'affiche AVANT le 2e (l'air est bien ENTRE les deux)",
  layout.msgRects[0].bottom < layout.msgRects[1].top,
  `bas(1)=${Math.round(layout.msgRects[0].bottom)} ; haut(2)=${Math.round(layout.msgRects[1].top)}`,
);

/* ══════════ 5) LE TEXTE EST INCHANGÉ (aucun séparateur inséré) ══════════ */
const transcript = await fetch(`${control}/transcript`).then((r) => r.json());
check(
  "TEXTE INCHANGÉ : le corps de chaque bulle = le contenu EXACT (aucun séparateur inséré)",
  layout.bodies[0] === ACK_TEXT &&
    layout.bodies[1] === "Voici le résultat de la tâche de fond." &&
    !layout.bodies.join("").includes("total") &&
    !layout.bodies.join("").includes("TTFT"),
  `corps=[${layout.bodies.map((b) => JSON.stringify(b.slice(0, 40))).join(", ")}]`,
);
check(
  "COPIE INCHANGÉE : le pied est HORS du corps de contenu (jamais copié avec le texte)",
  layout.footersInBody === 0,
  `${layout.footersInBody} pied(s) dans un corps markdown`,
);
check(
  "TRANSCRIPT SERVEUR : inchangé (1 utilisateur + 2 assistants, sans le rapport synthétique)",
  transcript.roles.join(",") === "user,assistant,assistant",
  `rôles = [${transcript.roles.join(", ")}] ; texte = ${JSON.stringify(transcript.text.slice(0, 80))}`,
);

/* ══════════ 6) PAS DE SAUT DE MISE EN PAGE PENDANT LA MISE À JOUR DU PIED ═ */
await fetch(`${control}/spoken-reset`);
// Nouveau tour utilisateur : on échantillonne pendant que le pied se met à jour.
await evaluate(`(() => {
  const input = document.querySelector('#input');
  input.value = 'Encore une question pour mesurer.';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#send').click();
  return true;
})()`);
await waitFor(`document.querySelectorAll('#conversation .message--assistant').length === 3`);
const jumpSamples = [];
const jumpDeadline = Date.now() + 4000;
while (Date.now() < jumpDeadline) {
  const s = await evaluate(`(() => {
    const conv = document.querySelector('#conversation');
    const base = conv.getBoundingClientRect().top - conv.scrollTop;
    const msgs = [...conv.querySelectorAll('.message--assistant')];
    // Position en ESPACE-CONTENU (indépendante du défilement qui suit le bas).
    const top = (el) => Math.round(el.getBoundingClientRect().top - base);
    const bottom = (el) => Math.round(el.getBoundingClientRect().bottom - base);
    const first = msgs[0] ? msgs[0] : null;
    const penult = msgs[msgs.length - 2] ? msgs[msgs.length - 2] : null;
    const last = msgs[msgs.length - 1];
    return {
      firstBottom: first ? bottom(first) : null,
      penultBottom: penult ? bottom(penult) : null,
      lastTop: last ? top(last) : null,
      footerText: last ? (last.querySelector('.message__footer')?.textContent ?? null) : null,
      state: document.getElementById('session-state')?.textContent ?? null,
    };
  })()`);
  jumpSamples.push(s);
  if (s.state === 'idle' && /total/.test(s.footerText ?? '')) break;
  await sleep(60);
}
const uniq = (arr) => [...new Set(arr.filter((v) => v !== null))];
const firstBottoms = uniq(jumpSamples.map((s) => s.firstBottom));
const lastTops = uniq(jumpSamples.map((s) => s.lastTop));
const penultBottoms = uniq(jumpSamples.map((s) => s.penultBottom));
check(
  "PAS DE SAUT : les messages PRÉCÉDENTS ne bougent pas pendant la mise à jour du pied",
  firstBottoms.length === 1 && penultBottoms.length <= 1,
  `bas(1er)=[${firstBottoms.join(", ")}] ; bas(avant-dernier)=[${penultBottoms.join(", ")}]`,
);
check(
  "PAS DE SAUT : le haut du message EN COURS reste FIXE pendant que le pied évolue",
  lastTops.length === 1,
  `haut(message en cours)=[${lastTops.join(", ")}] ; ${jumpSamples.length} échantillons`,
);
await sleep(500);
const finalJump = await evaluate(`(() => {
  const conv = document.querySelector('#conversation');
  const base = conv.getBoundingClientRect().top - conv.scrollTop;
  const msgs = [...conv.querySelectorAll('.message--assistant')];
  const last = msgs[msgs.length - 1];
  return {
    lastTop: last ? Math.round(last.getBoundingClientRect().top - base) : null,
    footerText: last ? (last.querySelector('.message__footer')?.textContent ?? null) : null,
  };
})()`);
check(
  "PAS DE SAUT : après remplacement par les valeurs finales, le haut du message est IDENTIQUE",
  finalJump.lastTop === lastTops[0],
  `haut avant=${lastTops[0]} ; haut après=${finalJump.lastTop} ; pied final=${JSON.stringify(finalJump.footerText)}`,
);

await send("Page.captureScreenshot", { format: "png" }).then((res) =>
  writeFileSync(join(SHOTS, "live-stats.png"), Buffer.from(res.data, "base64")),
);

await stopPage();
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

console.log(`\nCaptures (temporaires) : ${SHOTS}`);
const failed = results.filter((r) => !r.ok);
console.log(
  `\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; connexion = ${connectionErrors.length} ; exceptions = ${pageExceptions.length} ═══`,
);

chrome.kill("SIGKILL");
process.exit(
  failed.length === 0 &&
    cspViolations.length === 0 &&
    connectionErrors.length === 0 &&
    pageExceptions.length === 0
    ? 0
    : 1,
);
