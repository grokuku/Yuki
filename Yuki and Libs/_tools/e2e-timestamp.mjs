#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — horodatage du fil : heure discrète sous chaque bulle +
 * séparateurs de jour (trait interrompu, date française complète), avec la CSP
 * RÉELLE et un hôte Pi RÉEL hors ligne (deux fils, deux jours).
 *
 * Vérifie : les heures « juste HH:mm » s'affichent (jamais de date sur les
 * bulles), les séparateurs de jour apparaissent UNE fois par jour (pas entre
 * deux messages d'un même jour), le préfixe `[horodatage]` reste MASQUÉ, le
 * rendu survit à un rechargement ET à une bascule, ZÉRO violation CSP /
 * exception JS. Le rognage du fil en fenêtre étroite (défaut PRÉEXISTANT) n'est
 * PAS traité ici : on vérifie seulement qu'aucun débordement NOUVEAU n'apparaît.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-timestamp.mjs"
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-time-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-timestamp-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_TIME_DIR: STATE_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString()));
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("serveur non démarré :\n" + logs.join(""))), 40_000);
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

const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-time-chrome-"));
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
    logEntries.push({ source: msg.params.entry.source, level: msg.params.entry.level, text: msg.params.entry.text });
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
await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

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
  const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
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

async function shot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, name + ".png"), Buffer.from(res.data, "base64"));
}

/** Sonde du fil : séparateurs, heures, positions MESURÉES, préfixe masqué, styles calculés. */
const threadState = () =>
  evaluate(`(() => {
    const conv = document.querySelector('#conversation');
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
        cx: Math.round((r.left + r.right) / 2),
      };
    };
    const seps = [...document.querySelectorAll('.daysep')].map((s) => {
      const label = s.querySelector('.daysep__label');
      const sr = s.getBoundingClientRect();
      const lr = label.getBoundingClientRect();
      return {
        text: label ? label.textContent : '',
        leftGap: Math.round(lr.left - sr.left),
        rightGap: Math.round(sr.right - lr.right),
      };
    });
    const measure = (m) => {
      const head = m.querySelector('.message__head');
      const time = m.querySelector('.message__time');
      const body = m.querySelector('.message__body');
      const footer = m.querySelector('.message__footer');
      return {
        msg: rect(m),
        time: time ? time.textContent : null,
        end: head ? head.classList.contains('message__head--end') : false,
        timeRect: time ? rect(time) : null,
        body: body ? rect(body) : null,
        footer: footer ? rect(footer) : null,
        footerText: footer ? footer.textContent : null,
        // true si l'en-tête précède le corps DANS LE DOM (heure au-dessus).
        headBeforeBody:
          head && body
            ? (head.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
            : null,
      };
    };
    const userMsgs = [...document.querySelectorAll('.message--user')].map(measure);
    const asstMsgs = [...document.querySelectorAll('.message--assistant')].map(measure);
    const usermeta = document.querySelector('.message--user .message__head');
    // Référence de la BOÎTE DE CONTENU du fil : un séparateur de jour est un
    // élément pleine largeur (aucune marge horizontale) ⇒ ses bords gauche et
    // droit SONT ceux du contenu du fil. Valeurs BRUTES (non arrondies).
    const sepEl = document.querySelector('.daysep');
    const sepRaw = sepEl ? sepEl.getBoundingClientRect() : null;
    const userRaw = [...document.querySelectorAll('.message--user')].map((m) => m.getBoundingClientRect());
    const asstRaw = [...document.querySelectorAll('.message--assistant')].map((m) => m.getBoundingClientRect());
    const footerRaw = [...document.querySelectorAll('.message--assistant .message__footer')].map((f) => {
      const fr = f.getBoundingClientRect();
      const mr = f.closest('.message').getBoundingClientRect();
      return { blockRight: mr.right, footerRight: fr.right, blockLeft: mr.left };
    });
    return {
      seps,
      userMsgs,
      asstMsgs,
      // Marges latérales BRUTES (px) : gauche de l'utilisateur / droite de Yuki.
      contentLeft: sepRaw ? sepRaw.left : null,
      contentRight: sepRaw ? sepRaw.right : null,
      userLeftMargins: sepRaw ? userRaw.map((r) => r.left - sepRaw.left) : [],
      asstRightMargins: sepRaw ? asstRaw.map((r) => sepRaw.right - r.right) : [],
      asstFooterRightOffsets: footerRaw.map((f) => f.blockRight - f.footerRight),
      userTimes: userMsgs.map((m) => m.time),
      userEnd: userMsgs.every((m) => m.end),
      asstTimes: asstMsgs.map((m) => m.time).filter((t) => t !== null),
      hasPrefix: (conv ? conv.textContent : '').includes('horodatage'),
      textAlign: usermeta ? getComputedStyle(usermeta).textAlign : null,
      tabular: usermeta ? getComputedStyle(usermeta).fontVariantNumeric : null,
      userFooters: userMsgs.filter((m) => m.footer !== null).length,
      asstFooters: asstMsgs.filter((m) => m.footer !== null).length,
      styleAttrs: document.querySelectorAll('[style]').length,
      styles: [...document.querySelectorAll('[style]')].map(
        (e) => e.tagName + (e.className ? '.' + String(e.className).split(' ').join('.') : '') + ' → ' + (e.getAttribute('style') || ''),
      ),
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  })()`);

/* ═══════════ 1) Fil A restauré : 2 séparateurs, heures masquant le préfixe ═══════════ */
await navigate(`${server.base}/`);
check("le fil s'affiche (3 messages utilisateur)", await waitFor(`document.querySelectorAll('.message--user').length === 3`));
const a = await threadState();

check("2 séparateurs de jour (changement de jour)", a.seps.length === 2, JSON.stringify(a.seps.map((s) => s.text)));
check(
  "séparateur du premier jour CONSERVÉ (mercredi 7 octobre 2026)",
  a.seps[0]?.text === "mercredi 7 octobre 2026",
  String(a.seps[0]?.text),
);
check(
  "second séparateur = lendemain (jeudi 8 octobre 2026)",
  a.seps[1]?.text === "jeudi 8 octobre 2026",
  String(a.seps[1]?.text),
);
check(
  "AUCUN séparateur entre les deux messages du MÊME jour",
  a.seps.length === 2,
  `${a.seps.length} séparateur(s) pour 2 jours`,
);
check(
  "le trait est RÉELLEMENT interrompu (jours des deux côtés du libellé)",
  a.seps.every((s) => s.leftGap > 5 && s.rightGap > 5),
  JSON.stringify(a.seps.map((s) => [s.leftGap, s.rightGap])),
);

check(
  "heures utilisateur « juste HH:mm » (15:39, 16:12, 09:05)",
  JSON.stringify(a.userTimes) === JSON.stringify(["15:39", "16:12", "09:05"]),
  JSON.stringify(a.userTimes),
);
check("heure utilisateur alignée à droite (bord extérieur)", a.userEnd && a.textAlign === "right", `${a.textAlign}`);
check("chiffres à largeur fixe (tabular-nums)", a.tabular === "tabular-nums", String(a.tabular));
check(
  "heures assistant (15:41, 16:14, 09:07)",
  JSON.stringify(a.asstTimes) === JSON.stringify(["15:41", "16:14", "09:07"]),
  JSON.stringify(a.asstTimes),
);

/* — Géométrie MESURÉE (valeurs brutes en px) : l'heure est AU-DESSUS du texte,
 *   alignée par rôle ; rien en bas pour l'utilisateur ; l'en-tête précède le
 *   corps dans le DOM. Ces mesures constituent la preuve géométrique. */
const geometry = (msgs) =>
  msgs.map((m) => ({
    time: m.timeRect ? `${m.timeRect.top}–${m.timeRect.bottom}` : null,
    body: m.body ? `${m.body.top}–${m.body.bottom}` : null,
    timeCx: m.timeRect?.cx ?? null,
    msgCx: m.msg?.cx ?? null,
  }));
check(
  "ASSISTANT : heure AU-DESSUS du texte (heure.bottom <= texte.top)",
  a.asstMsgs.length > 0 && a.asstMsgs.every((m) => m.timeRect && m.body && m.timeRect.bottom <= m.body.top),
  JSON.stringify(geometry(a.asstMsgs)),
);
check(
  "ASSISTANT : heure À GAUCHE (centre heure < centre bulle)",
  a.asstMsgs.length > 0 && a.asstMsgs.every((m) => m.timeRect && m.timeRect.cx < m.msg.cx),
  JSON.stringify(a.asstMsgs.map((m) => [m.timeRect?.cx, m.msg?.cx])),
);
check(
  "ASSISTANT : en-tête AVANT le corps dans le DOM",
  a.asstMsgs.every((m) => m.headBeforeBody === true),
  JSON.stringify(a.asstMsgs.map((m) => m.headBeforeBody)),
);
check(
  "UTILISATEUR : heure AU-DESSUS du texte (heure.bottom <= texte.top)",
  a.userMsgs.length > 0 && a.userMsgs.every((m) => m.timeRect && m.body && m.timeRect.bottom <= m.body.top),
  JSON.stringify(geometry(a.userMsgs)),
);
check(
  "UTILISATEUR : heure À DROITE (centre heure > centre bulle)",
  a.userMsgs.length > 0 && a.userMsgs.every((m) => m.timeRect && m.timeRect.cx > m.msg.cx),
  JSON.stringify(a.userMsgs.map((m) => [m.timeRect?.cx, m.msg?.cx])),
);
check(
  "UTILISATEUR : RIEN en bas (aucun pied technique)",
  a.userFooters === 0,
  `${a.userFooters} pied(s)`,
);
check(
  "ASSISTANT restauré : aucun pied technique (pas de ligne fantôme)",
  a.asstFooters === 0,
  `${a.asstFooters} pied(s)`,
);

/* — ⚖️ MARGES LATÉRALES (preuve au pixel près) : la bulle UTILISATEUR est poussée
 *   à droite (donc marge à GAUCHE) et le message de Yuki est poussé à gauche
 *   (donc marge à DROITE). Les deux marges doivent être ÉGALES (≤ 1 px). On
 *   compare les valeurs BRUTES mesurées depuis la boîte de contenu du fil. */
const margins = [...a.userLeftMargins, ...a.asstRightMargins];
const spread = margins.length >= 4 ? Math.max(...margins) - Math.min(...margins) : null;
check(
  "marges latérales ÉGALES : gauche (utilisateur) = droite (Yuki), ≤ 1 px",
  margins.length >= 4 && spread !== null && spread <= 1,
  `gauche=[${a.userLeftMargins.map((v) => v.toFixed(1)).join(", ")}] ; droite=[${a.asstRightMargins.map((v) => v.toFixed(1)).join(", ")}] ; écart=${spread === null ? "n/a" : spread.toFixed(2)} px`,
);
check(
  "marge à droite de Yuki RÉELLEMENT > 0 (pas d'ancien plein-bord)",
  a.asstRightMargins.length > 0 && a.asstRightMargins.every((v) => v > 1),
  `droite=[${a.asstRightMargins.map((v) => v.toFixed(1)).join(", ")}] px`,
);

check("AUCUNE date sur les bulles (seulement l'heure)", a.userTimes.every((t) => /^\d{2}:\d{2}$/.test(t)));
check("le préfixe [horodatage] est MASQUÉ à l'affichage", a.hasPrefix === false);
// Le seul `[style]` attendu est le <html> racine : les variables de thème y
// sont posées par CSSOM (`element.style.setProperty`), PRÉEXISTANT et sans
// violation CSP (aucun `<style>` ni `style=` de balisage). L'UI du fil n'ajoute
// AUCUN style en ligne.
const nonRootStyles = a.styles.filter((s) => !s.startsWith("HTML"));
check(
  "0 style= hors racine de thème (UI du fil : aucun style en ligne)",
  nonRootStyles.length === 0,
  JSON.stringify(nonRootStyles),
);
await shot("timestamp-thread");

/* ═══════════ 2) Rechargement : le rendu survit ═══════════ */
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('.message--user').length === 3`);
const reloaded = await threadState();
check("RELOAD : 2 séparateurs conservés", reloaded.seps.length === 2);
check(
  "RELOAD : heures identiques après restauration",
  JSON.stringify(reloaded.userTimes) === JSON.stringify(a.userTimes) &&
    JSON.stringify(reloaded.asstTimes) === JSON.stringify(a.asstTimes),
  JSON.stringify(reloaded.userTimes),
);

/* ═══════════ 3) Bascule de fil : séparateur du fil B ═══════════ */
await evaluate(`(() => {
  const target = [...document.querySelectorAll('.conv')].find((c) => !c.classList.contains('conv--active'));
  target.click();
})()`);
await waitFor(`document.querySelectorAll('.message--user').length === 1`);
await sleep(400);
const b = await threadState();
check("BASCULE : le fil B affiche 1 séparateur (jeudi 1 octobre 2026)", b.seps.length === 1 && b.seps[0]?.text === "jeudi 1 octobre 2026", JSON.stringify(b.seps.map((s) => s.text)));
check("BASCULE : heures du fil B (10:30 / 10:31)", JSON.stringify(b.userTimes) === JSON.stringify(["10:30"]) && JSON.stringify(b.asstTimes) === JSON.stringify(["10:31"]), JSON.stringify([b.userTimes, b.asstTimes]));
check("BASCULE : préfixe toujours masqué", b.hasPrefix === false);

// Retour au fil A : le rendu est reconstruit (snapshot), aucun doublon.
await evaluate(`(() => {
  const target = [...document.querySelectorAll('.conv')].find((c) => !c.classList.contains('conv--active'));
  target.click();
})()`);
await waitFor(`document.querySelectorAll('.message--user').length === 3`);
const back = await threadState();
check("RETOUR au fil A : 2 séparateurs, 3 heures (aucun doublon)", back.seps.length === 2 && back.userTimes.length === 3, JSON.stringify(back.userTimes));

/* ═══════════ 4) Envoi LIVE : heure au-dessus, infos techniques en bas à droite ═══════════ */
await evaluate(`(() => {
  const input = document.querySelector('#input');
  input.value = 'Message live pour tester l horodatage';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.querySelector('#send').click();
})()`);
await sleep(500);
const live = await evaluate(`(() => {
  const msgs = [...document.querySelectorAll('.message--user')];
  const last = msgs[msgs.length - 1];
  return {
    count: msgs.length,
    time: last?.querySelector('.message__time')?.textContent ?? null,
  };
})()`);
check("LIVE : un nouveau message utilisateur horodaté apparaît immédiatement", live.count === 4 && /^\d{2}:\d{2}$/.test(live.time ?? ""), `${live.count} message(s), heure ${live.time}`);

// Le run live se termine et pose un pied TECHNIQUE au message assistant
// (« total … ms » au minimum, TTFT/tok selon la réponse). On l'attend, puis on
// MESURE sa géométrie : EN BAS (sous le texte) et À DROITE (plus à droite que
// l'heure).
await waitFor(`document.querySelectorAll('.message--assistant .message__footer').length > 0`, 8000);
const liveGeo = await evaluate(`(() => {
  const m = [...document.querySelectorAll('.message--assistant')].pop();
  if (!m) return null;
  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), cx: Math.round((r.left + r.right) / 2) }; };
  const time = m.querySelector('.message__time');
  const body = m.querySelector('.message__body');
  const footer = m.querySelector('.message__footer');
  const stats = footer ? footer.querySelector('.message__stats') : null;
  const sep = document.querySelector('.daysep');
  const sepRight = sep ? sep.getBoundingClientRect().right : null;
  return {
    msg: rect(m),
    time: time ? rect(time) : null,
    body: body ? rect(body) : null,
    footer: footer ? rect(footer) : null,
    stats: stats ? rect(stats) : null,
    footerText: footer ? footer.textContent : null,
    // Écart (px) entre le bord DROIT du bloc Yuki et le bord droit du pied,
    // et position du bord droit du bloc par rapport au contenu du fil.
    footerRightOffset: footer ? Math.round(m.getBoundingClientRect().right - footer.getBoundingClientRect().right) : null,
    blockRightMargin: sepRight !== null ? Math.round(sepRight - m.getBoundingClientRect().right) : null,
  };
})()`);
check(
  "LIVE : le message assistant porte un pied TECHNIQUE (infos non perdues)",
  liveGeo?.footer != null && /total/.test(liveGeo.footerText ?? ""),
  JSON.stringify({ footer: liveGeo?.footer ?? null, text: liveGeo?.footerText ?? null }),
);
check(
  "LIVE : le pied technique est EN BAS (sous le texte : pied.top >= corps.bottom)",
  liveGeo?.footer != null && liveGeo.body != null && liveGeo.footer.top >= liveGeo.body.bottom,
  JSON.stringify({ corps: liveGeo?.body ?? null, pied: liveGeo?.footer ?? null }),
);
check(
  "LIVE : le pied technique est À DROITE de l'heure (centre stats > centre heure)",
  liveGeo?.stats != null && liveGeo.time != null && liveGeo.stats.cx > liveGeo.time.cx,
  JSON.stringify({ heureCx: liveGeo?.time?.cx ?? null, statsCx: liveGeo?.stats?.cx ?? null, stats: liveGeo?.stats ?? null }),
);
check(
  "LIVE : le pied technique reste AU BORD DROIT du bloc Yuki (≈ padding), pas du fil",
  liveGeo?.footerRightOffset != null &&
    liveGeo.footerRightOffset >= 0 &&
    liveGeo.footerRightOffset <= 16 &&
    liveGeo.blockRightMargin != null &&
    liveGeo.blockRightMargin > 1,
  `écart pied↔bloc=${liveGeo?.footerRightOffset} px ; marge droite du bloc=${liveGeo?.blockRightMargin} px`,
);
await shot("timestamp-live-footer");
await evaluate(`document.querySelector('#stop')?.click()`);

/* ═══════════ 5) Fenêtre ÉTROITE : aucun débordement NOUVEAU ═══════════ */
await send("Emulation.setDeviceMetricsOverride", { width: 480, height: 720, deviceScaleFactor: 1, mobile: false });
await navigate(`${server.base}/`);
await waitFor(`document.querySelectorAll('.message--user').length >= 3`);
const narrow = await threadState();
check("étroit : séparateurs toujours affichés (jours seedés présents en tête)", narrow.seps.length >= 2 && narrow.seps[0]?.text === "mercredi 7 octobre 2026" && narrow.seps[1]?.text === "jeudi 8 octobre 2026", narrow.seps.map((s) => s.text).join(" | "));
check("étroit : aucun débordement horizontal NOUVEAU", narrow.overflow <= 1, `débordement ${narrow.overflow} px`);
const narrowMargins = [...narrow.userLeftMargins, ...narrow.asstRightMargins];
const narrowSpread =
  narrowMargins.length >= 4 ? Math.max(...narrowMargins) - Math.min(...narrowMargins) : null;
check(
  "étroit (≤ 640 px) : marges latérales TOUJOURS égales (≤ 1 px)",
  narrowMargins.length >= 4 && narrowSpread !== null && narrowSpread <= 1,
  `gauche=[${narrow.userLeftMargins.map((v) => v.toFixed(1)).join(", ")}] ; droite=[${narrow.asstRightMargins.map((v) => v.toFixed(1)).join(", ")}] ; écart=${narrowSpread === null ? "n/a" : narrowSpread.toFixed(2)} px`,
);
await shot("timestamp-narrow");

server.proc.kill("SIGTERM");
await sleep(300);

/* ═══════════ Bilan CSP / exceptions ═══════════ */
const cspViolations = [
  ...consoleMessages.filter((m) => /refused|content security policy|csp/i.test(m.text)),
  ...logEntries.filter((e) => /refused|content security policy|csp/i.test(e.text) || e.source === "security"),
];
check("ZÉRO violation CSP", cspViolations.length === 0, cspViolations.map((v) => v.text).join(" | "));
check("ZÉRO exception JS non capturée", pageExceptions.length === 0, pageExceptions.join(" | ").slice(0, 300));

console.log(`\nCaptures (non suivies) : ${SHOTS}`);
console.log(`Messages console : ${consoleMessages.length} ; entrées Log : ${logEntries.length}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n═══ BILAN : ${results.length - failed.length}/${results.length} OK ; CSP = ${cspViolations.length} ; exceptions = ${pageExceptions.length} ═══`);

chrome.kill("SIGKILL");
process.exit(failed.length === 0 && cspViolations.length === 0 && pageExceptions.length === 0 ? 0 : 1);
