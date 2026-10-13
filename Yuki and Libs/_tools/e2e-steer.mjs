#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — MESSAGE UTILISATEUR PENDANT UNE SORTIE ASSISTANT.
 *
 * Reproduit fidèlement le scénario signalé : l'utilisateur envoie un message
 * ALORS QUE l'assistant diffuse un bloc de code (fence ouverte). Le message doit
 * apparaître à sa place, le message assistant EN COURS doit garder SON UNIQUE
 * bloc et le markdown doit rester INTACT (le bloc de code reste un `<pre>`).
 *
 * Ce que l'on prouve PAR MESURE (VRAI navigateur, CSP réelle) :
 *   1. pendant le flux : UN SEUL bloc assistant (jamais coupé), la bulle
 *      utilisateur est VISIBLE et placée AVANT ce bloc ;
 *   2. après la fin : UN SEUL bloc assistant, corps EXACT (segment A + B), la
 *      fence de code est intacte (un `<pre>` contient le code complet) ;
 *   3. le message utilisateur est un VRAI message (transcript serveur :
 *      `user,user,assistant` ; le steer n'ouvre PAS de nouveau run) ;
 *   4. APRÈS RECHARGEMENT : le rendu correspond au transcript (même bloc unique,
 *      même ordre, même `<pre>`).
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-steer.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

import { collectViolations, waitForGateway } from "./browser-violations.mjs";

const TOOLS = import.meta.dirname;
const WORKSPACE = join(TOOLS, "..");
const YUKI_DIR = join(WORKSPACE, "Yuki");
const TSX = join(YUKI_DIR, "node_modules", ".bin", "tsx");

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-steer-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "✓" : "✗ ÉCHEC"}  ${label}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Miroir des constantes du harnais serveur.
const CODE_LINES = Array.from({ length: 12 }, (_, i) => `  ligne${i}();`).join("\n");

/* ─── Démarrage du gateway de test ──────────────────────────────────────── */
const logs = [];
const proc = spawn(TSX, [join(TOOLS, "e2e-steer-serve.ts")], {
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
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-steer-chrome-"));
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

/** Envoie un message comme le ferait l'utilisateur (remplit l'input puis clic). */
const SEND_MESSAGE = (text) => `(() => {
  const input = document.querySelector('#input');
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#send').click();
  return true;
})()`;

/** Photo de l'état du fil : blocs, ordre, texte, présence de `<pre>`. */
const READ_THREAD = `(() => {
  const nodes = [...document.querySelectorAll('#conversation > .message')];
  const assistants = nodes.filter((n) => n.classList.contains('message--assistant'));
  const users = nodes.filter((n) => n.classList.contains('message--user'));
  const bodyOf = (el) => el.querySelector('.message__body.markdown')?.textContent ?? null;
  const bodies = assistants.map(bodyOf);
  const pres = document.querySelectorAll('#conversation .message--assistant .message__body.markdown pre');
  const codeTexts = [...pres].map((p) => p.textContent);
  const order = nodes.map((n) => (n.classList.contains('message--assistant') ? 'assistant' : 'user'));
  // Bulle utilisateur AVANT le bloc assistant ? (position en DOM)
  const userBeforeAssistant = users.length > 0 && assistants.length > 0
    ? (users[0].compareDocumentPosition(assistants[0]) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    : null;
  return {
    assistantCount: assistants.length,
    userCount: users.length,
    order,
    bodies,
    preCount: pres.length,
    codeTexts,
    userBeforeAssistant,
    state: document.getElementById('session-state')?.textContent ?? null,
  };
})()`;

/* ══════════════ 1) MESSAGE PENDANT QUE LE CODE STREAME ══════════════════ */
await navigate(`${base}/`);
check(
  "connexion au gateway établie",
  await waitFor(`document.querySelector('#connection')?.textContent === 'connecté'`),
);

await evaluate(SEND_MESSAGE("Montre-moi un exemple de code."));
// Attendre que le flux ait COMMENCÉ (du contenu est présent) mais que la fence
// soit encore OUVERTE (segment A en cours).
const streaming = await waitFor(
  `(() => {
    const a = document.querySelector('#conversation .message--assistant .message__body.markdown');
    const t = a ? a.textContent : '';
    return t.includes('ligne3') && !t.includes('Voilà');
  })()`,
  6000,
);
check("le code stream (fence encore ouverte, contenu partiel présent)", streaming);

// ⚠️ Message envoyé EN PLEIN FLUX.
await evaluate(SEND_MESSAGE("Continue, et rends-le plus lisible."));

// État du fil JUSTE APRÈS le steer, pendant que le flux continue.
await sleep(300);
const during = await evaluate(READ_THREAD);
check(
  "PENDANT LE FLUX : UN SEUL bloc assistant (le flux n'est pas coupé)",
  during.assistantCount === 1,
  `${during.assistantCount} bloc(s) assistant ; ordre=[${during.order.join(", ")}]`,
);
check(
  "PENDANT LE FLUX : les DEUX bulles utilisateur sont visibles",
  during.userCount === 2,
  `${during.userCount} bulle(s) utilisateur`,
);
check(
  "PENDANT LE FLUX : la 1re bulle utilisateur est placée AVANT le bloc assistant",
  during.userBeforeAssistant === true,
  `userBeforeAssistant=${JSON.stringify(during.userBeforeAssistant)}`,
);

/* ══════════════ 2) APRÈS LA FIN : UN SEUL BLOC, MARKDOWN INTACT ══════════ */
await waitFor(`document.getElementById('session-state')?.textContent === 'idle'`, 10_000);
await sleep(300);
const done = await evaluate(READ_THREAD);
check(
  "FIN : UN SEUL bloc assistant (pas deux réponses distinctes)",
  done.assistantCount === 1,
  `${done.assistantCount} bloc(s) ; ordre=[${done.order.join(", ")}]`,
);
check(
  "FIN : le corps assistant contient l'intro, TOUTES les lignes et la conclusion",
  done.bodies.length === 1 &&
    done.bodies[0]?.includes("Voici le code demandé") === true &&
    done.bodies[0]?.includes("Voilà, le code est complet") === true &&
    CODE_LINES.split("\n").every((line) => done.bodies[0].includes(line)),
  `corps[0].length=${done.bodies[0]?.length}`,
);
check(
  "FIN : la fence de code est INTACTE (un <pre> contient le code complet)",
  done.preCount === 1 && done.codeTexts.length === 1 && done.codeTexts[0].trim() === CODE_LINES.trim(),
  `pre=${done.preCount} ; code=${JSON.stringify(done.codeTexts[0]?.slice(0, 40))}`,
);
check(
  "FIN : ordre du fil = utilisateur, utilisateur, assistant",
  done.order.join(",") === "user,user,assistant",
  `ordre=[${done.order.join(", ")}]`,
);

/* ══════════════ 3) LE MESSAGE EST UN VRAI MESSAGE (transcript serveur) ════ */
const tResp = await fetch(`${control}/transcript`).then((r) => r.json());
const sResp = await fetch(`${control}/state`).then((r) => r.json());
check(
  "TRANSCRIPT SERVEUR : user, user, assistant (le message reste un VRAI échange)",
  tResp.roles.join(",") === "user,user,assistant",
  `rôles=[${tResp.roles.join(", ")}]`,
);
check(
  "TRANSCRIPT SERVEUR : UNE SEULE entrée assistant (fusion du run)",
  tResp.roles.filter((r) => r === "assistant").length === 1,
  `${tResp.roles.filter((r) => r === "assistant").length} entrée(s) assistant`,
);
check(
  "LE STEER N'OUVRE PAS DE NOUVEAU RUN (1 seul run_started, 1 steer)",
  sResp.runStartedCount === 1 && sResp.steerCount === 1,
  `run_started=${sResp.runStartedCount} ; steers=${sResp.steerCount}`,
);

await send("Page.captureScreenshot", { format: "png" }).then((res) =>
  writeFileSync(join(SHOTS, "steer-before-reload.png"), Buffer.from(res.data, "base64")),
);

/* ══════════════ 4) APRÈS RECHARGEMENT : le rendu = le transcript ════════ */
await navigate(`${base}/`);
await waitFor(`document.querySelectorAll('#conversation > .message').length >= 3`, 8000);
await sleep(400);
const reloaded = await evaluate(READ_THREAD);
check(
  "RECHARGEMENT : UN SEUL bloc assistant (identique au direct)",
  reloaded.assistantCount === 1,
  `${reloaded.assistantCount} bloc(s) ; ordre=[${reloaded.order.join(", ")}]`,
);
check(
  "RECHARGEMENT : le corps assistant est IDENTIQUE (même texte)",
  reloaded.bodies.length === 1 && reloaded.bodies[0] === done.bodies[0],
  `corps rechargé = ${JSON.stringify(reloaded.bodies[0]?.slice(0, 45))}`,
);
check(
  "RECHARGEMENT : la fence de code reste INTACTE (un <pre>)",
  reloaded.preCount === 1 && reloaded.codeTexts[0]?.trim() === CODE_LINES.trim(),
  `pre=${reloaded.preCount}`,
);
check(
  "RECHARGEMENT : même ORDRE (user, user, assistant)",
  reloaded.order.join(",") === "user,user,assistant" && reloaded.userCount === 2,
  `ordre=[${reloaded.order.join(", ")}] ; users=${reloaded.userCount}`,
);

await send("Page.captureScreenshot", { format: "png" }).then((res) =>
  writeFileSync(join(SHOTS, "steer-after-reload.png"), Buffer.from(res.data, "base64")),
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
