#!/usr/bin/env node
/**
 * Harnais E2E JETABLE — section « NOTIFICATIONS » (sources) de la page `/`.
 *
 * Prouve PAR MESURE, avec la CSP RÉELLE et un gateway RÉEL :
 *   1) le COMPTEUR DE NON-LUS est dans l'en-tête et reflète la boîte ;
 *   2) une entrée APPARAÎT dans la section dédiée (jamais une bulle dans un fil) ;
 *   3) son CONTENU est REPLIÉ par défaut (`<details>` fermé) ;
 *   4) après un tour, l'état passe à « traité » et la RÉPONSE de Yuki s'affiche
 *      dans la MÊME entrée ;
 *   5) « Continuer dans une conversation » crée UNE SEULE conversation (deux
 *      clics ⇒ une seule création) ;
 *   6) en 390×844 (téléphone), la section reste utilisable ;
 *   7) ⚠️ une source configurée sur un FIL DÉSIGNÉ fait RÉELLEMENT démarrer un tour
 *      dans ce fil (pas un simple stockage), et la réponse reste dans l'entrée ;
 *   8) ce fil est VISIBLE dans la liste des conversations (aucun fil caché) ;
 *   9) `GET /api/sources` et `GET /api/sources/inbox` sont FERMÉS sans l'en-tête
 *      `X-Yuki-Config: 1` (la boîte n'est plus lisible par une page tierce) ;
 *  10) supprimer un fil qui reçoit une source ouvre la MODALE (sources listées,
 *      trois choix) ; « supprimer quand même » conserve la source (réaffectée) et
 *      écrit un avis dans la boîte ;
 *  11) ZÉRO violation CSP / connexion / exception.
 *
 * ⚠️ Ce que ce harnais ne peut PAS prouver : un vrai client externe (agrégateur,
 * client de messagerie), une livraison Web Push réelle sur téléphone, et le
 * comportement du modèle réellement configuré face à un contenu atypique.
 *
 * Usage : node "/projects/Yuki/Yuki and Libs/_tools/e2e-sources.mjs"
 * Les captures vont dans un dossier TEMPORAIRE : aucun PNG suivi n'est réécrit.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
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

const STATE_DIR = mkdtempSync(join(tmpdir(), "yuki-e2e-sources-"));
const SHOTS = join(STATE_DIR, "shots");
mkdirSync(SHOTS, { recursive: true });

/* ─── Gateway de test (sources câblées + host Pi réel) ───────────────────── */
async function startServer() {
  const logs = [];
  const proc = spawn(TSX, [join(TOOLS, "e2e-sources-serve.ts")], {
    cwd: YUKI_DIR,
    env: { ...process.env, YUKI_E2E_DIR: STATE_DIR },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => logs.push(d.toString()));
  proc.stderr.on("data", (d) => logs.push(d.toString()));
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("serveur non démarré :\n" + logs.join(""))),
      60_000,
    );
    const onData = () => {
      const match = logs.join("").match(/READY (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1].trim());
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

/** Pousse un message de source (le programme extérieur, simulé). */
async function push(source, body) {
  const response = await fetch(`${server.base}/api/sources/${source}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer jeton-${source}-e2e`,
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

/* ─── Chromium headless (CDP) ────────────────────────────────────────────── */
const profileDir = mkdtempSync(join(tmpdir(), "yuki-e2e-sources-chrome-"));
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
  let buffer = "";
  const timer = setTimeout(() => reject(new Error("DevTools WS introuvable")), 20_000);
  chrome.stderr.on("data", (d) => {
    buffer += d.toString();
    const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
    if (match) {
      clearTimeout(timer);
      resolve(match[1]);
    }
  });
  chrome.on("exit", (code) => reject(new Error("chromium a quitté : " + code)));
});

const listTargets = await fetch(
  wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "/json/list"),
).then((r) => r.json());
const page = listTargets.find((target) => target.type === "page");
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
  const message = JSON.parse(raw.toString());
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  } else if (message.method === "Runtime.consoleAPICalled") {
    consoleMessages.push({
      type: message.params.type,
      text: (message.params.args || []).map((a) => a.value ?? a.description ?? "").join(" "),
    });
  } else if (message.method === "Runtime.exceptionThrown") {
    const details = message.params.exceptionDetails || {};
    pageExceptions.push(details.exception?.description ?? details.text ?? "exception");
  } else if (message.method === "Log.entryAdded") {
    logEntries.push({
      source: message.params.entry.source,
      level: message.params.entry.level,
      text: message.params.entry.text,
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

async function setViewport(width, height, { mobile = false } = {}) {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  await send("Emulation.setTouchEmulationEnabled", {
    enabled: mobile,
    ...(mobile ? { maxTouchPoints: 1 } : {}),
  });
}

async function navigate(url) {
  const loaded = new Promise((resolve) => {
    const handler = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.method === "Page.loadEventFired") {
        ws.off("message", handler);
        resolve();
      }
    };
    ws.on("message", handler);
    setTimeout(() => {
      ws.off("message", handler);
      resolve();
    }, 10_000);
  });
  await send("Page.navigate", { url });
  await loaded;
  await sleep(900);
}

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    throw new Error(
      res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "erreur JS",
    );
  }
  return res.result?.value;
}

async function screenshot(name) {
  const res = await send("Page.captureScreenshot", { format: "png" });
  const path = join(SHOTS, `${name}.png`);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, Buffer.from(res.data, "base64"));
  return path;
}

/**
 * Clique un bouton dont le texte contient `text`, cherché dans `scope`
 * (expression JS désignant un élément ; défaut : `document`).
 *
 * ⚠️ Le libellé NE SUFFIT PAS à désigner un bouton : « Enregistrer » existe à la
 * fois dans le panneau `/config` (`#save`, `config.html:356`) et dans le pied de
 * la HolafModal ouverte par-dessus. Et `HolafModal` ajoute son overlay à la FIN de
 * `document.body` (`public/ui/vendor/holaf/holaf-modal.js:1005`) : le premier
 * bouton du DOM trouvé pour un même libellé est donc celui de la PAGE, pas celui
 * de la modale. D'où les deux options :
 *   - `overlay` : restreindre la recherche à la modale la PLUS RÉCENTE ;
 *   - `last` : prendre le DERNIER bouton correspondant au lieu du premier.
 */
async function clickButton(text, scope = "document", options = {}) {
  const { last = false, overlay = false } = options;
  const found = await evaluate(`(() => {
    let root = ${scope};
    if (${overlay}) {
      const overlays = document.querySelectorAll(".holaf-modal-overlay");
      if (overlays.length > 0) root = overlays[overlays.length - 1];
    }
    const buttons = [...root.querySelectorAll("button")].filter((b) =>
      (b.textContent || "").includes(${JSON.stringify(text)}),
    );
    const button = ${last} ? buttons[buttons.length - 1] : buttons[0];
    if (!button) return false;
    button.click();
    return true;
  })()`);
  return found === true;
}

try {
  /* ── 0) Un message AVANT l'ouverture de la page : 1 non-lu ─────────────── */
  const stored = await push("mail", {
    id: "e2e-mail-1",
    texte: "Nouveau message de M. Dupont : l'audit est bouclé.\nLigne 2 du contenu.",
    titre: "Audit bouclé",
  });
  check("message `stocker` accepté (202)", stored.status === 202, JSON.stringify(stored.data?.stored));

  /* ── 1) Téléphone 390×844 : compteur de non-lus dans l'en-tête ─────────── */
  await setViewport(390, 844, { mobile: true });
  await navigate(server.base + "/");

  const counter = await evaluate(`(() => {
    const button = document.getElementById("sources-notifs-toggle");
    const count = document.getElementById("sources-notifs-count");
    if (!button || !count) return null;
    return {
      visible: !button.hidden,
      count: count.textContent,
      countHidden: count.hidden,
      ariaLabel: button.getAttribute("aria-label"),
    };
  })()`);
  check(
    "compteur de non-lus visible dans l'en-tête (1)",
    Boolean(counter && counter.visible && counter.count === "1" && !counter.countHidden),
    JSON.stringify(counter),
  );
  check(
    "le compteur est annoncé (aria-label)",
    Boolean(counter && /1 non lue/.test(counter.ariaLabel ?? "")),
    counter?.ariaLabel ?? "",
  );

  /* ── 2) La section s'ouvre et affiche l'entrée ─────────────────────────── */
  const opened = await clickButton("Notifications", "document.querySelector('.topbar')");
  await sleep(600);
  const panel = await evaluate(`(() => {
    const layer = document.getElementById("sources-notifs-layer");
    const entries = [...document.querySelectorAll("#sources-notifs-list .notif")];
    const first = entries[0];
    const details = first?.querySelector("details");
    return {
      layerHidden: layer.hidden,
      entries: entries.length,
      state: first?.querySelector(".notif__state")?.textContent ?? "",
      text: first?.querySelector(".notif__content")?.textContent ?? "",
      detailsOpen: details ? details.hasAttribute("open") : null,
      // ⚠️ Aucune bulle dans le fil : la conversation ne contient pas le contenu.
      inThread: (document.getElementById("conversation")?.textContent ?? "").includes("Audit bouclé"),
    };
  })()`);
  check("la section Notifications est ouverte", opened === true && panel && panel.layerHidden === false);
  check("une entrée apparaît", panel?.entries === 1, `entrées=${panel?.entries}`);
  check("son état est « reçu »", panel?.state === "reçu", panel?.state ?? "");
  check(
    "son contenu est REPLIÉ par défaut",
    panel?.detailsOpen === false && /Audit bouclé|Nouveau message/.test(panel?.text ?? ""),
    `details.open=${panel?.detailsOpen}`,
  );
  check("⚠️ le message n'est PAS une bulle dans le fil", panel?.inThread === false);
  const mobileLayout = await evaluate(`(() => {
    const layer = document.getElementById("sources-notifs-layer");
    const rect = document.getElementById("sources-notifs-panel").getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      panelWidth: Math.round(rect.width),
      scrollWidth: document.documentElement.scrollWidth,
      layerPadding: getComputedStyle(layer).padding,
    };
  })()`);
  check(
    "en 390 px, la section occupe toute la largeur (aucun débordement horizontal)",
    mobileLayout?.innerWidth === 390 &&
      mobileLayout.panelWidth === 390 &&
      mobileLayout.scrollWidth <= 390,
    JSON.stringify(mobileLayout),
  );
  const shotPhone = await screenshot("sources-notifications-telephone");

  /* ── 3) Un tour de source : l'état passe à « traité », réponse dans l'entrée */
  // ⚠️ Le programme extérieur n'envoie QUE `tour: "lancer"` : la DESTINATION vit
  // dans la configuration de la source (fil désigné de la « Conversation de
  // travail »). Aucun identifiant de fil ne circule côté client.
  const launched = await push("veille", {
    id: "e2e-veille-1",
    texte: "Trois articles ce matin : rien de grave.",
    titre: "Veille du matin",
    tour: "lancer",
  });
  check(
    "message `lancer` ⇒ un tour démarre RÉELLEMENT (202 started)",
    launched.status === 202 && launched.data?.started === true,
    JSON.stringify(launched.data?.started),
  );
  const runState = await fetch(`${server.base}/api/e2e/sources-state`).then((r) => r.json());
  check(
    "⚠️ le tour a été lancé DANS LE FIL DÉSIGNÉ (aucun stockage passif)",
    runState.sends.length === 1 && runState.sends[0].sessionId === runState.workSession,
    JSON.stringify(runState.sends),
  );
  await sleep(1200);
  // On referme puis rouvre la section : c'est le geste d'un utilisateur qui
  // revient voir ses notifications (et cela force une relecture de la boîte).
  await clickButton("Fermer");
  await sleep(200);
  await clickButton("Notifications", "document.querySelector('.topbar')");
  await sleep(800);
  const afterRun = await evaluate(`(() => {
    const entries = [...document.querySelectorAll("#sources-notifs-list .notif")];
    const traite = entries.find((entry) => (entry.querySelector(".notif__state")?.textContent ?? "") === "traité");
    return {
      entries: entries.length,
      states: entries.map((entry) => entry.querySelector(".notif__state")?.textContent ?? ""),
      reply: traite?.querySelector(".notif__reply-text")?.textContent ?? "",
      replyLabel: traite?.querySelector(".notif__reply-label")?.textContent ?? "",
    };
  })()`);
  check("la seconde entrée apparaît", afterRun?.entries === 2, JSON.stringify(afterRun?.states));
  check(
    "après le tour, l'état passe à « traité »",
    (afterRun?.states ?? []).includes("traité"),
    JSON.stringify(afterRun?.states),
  );
  check(
    "la RÉPONSE de Yuki est dans la MÊME entrée",
    /rien d'anormal/i.test(afterRun?.reply ?? "") && afterRun?.replyLabel === "Réponse de Yuki",
    afterRun?.reply ?? "",
  );
  const shotReply = await screenshot("sources-notifications-traite");

  /* ── 4) « Continuer dans une conversation » : UNE seule conversation ───── */
  const before = await fetch(`${server.base}/api/e2e/sources-state`).then((r) => r.json());
  const clicked = await clickButton("Continuer dans une conversation");
  await sleep(1200);
  const afterFirst = await fetch(`${server.base}/api/e2e/sources-state`).then((r) => r.json());
  check(
    "« Continuer » ouvre une conversation (1 seule créée)",
    clicked === true && afterFirst.created === before.created + 1,
    `créées ${before.created} → ${afterFirst.created}`,
  );
  const panelClosed = await evaluate(
    'document.getElementById("sources-notifs-layer").hidden',
  );
  check("la section se referme après le clic (on bascule sur la conversation)", panelClosed === true);

  // Second clic sur la MÊME entrée : aucune NOUVELLE conversation.
  await clickButton("Notifications", "document.querySelector('.topbar')");
  await sleep(700);
  const reopened = await clickButton("Rouvrir la conversation");
  await sleep(1200);
  const afterSecond = await fetch(`${server.base}/api/e2e/sources-state`).then((r) => r.json());
  check(
    "un second clic ne crée PAS une seconde conversation",
    reopened === true && afterSecond.created === afterFirst.created,
    `créées ${afterFirst.created} → ${afterSecond.created}`,
  );

  /* ── 5) Bureau : la section reste utilisable ───────────────────────────── */
  await setViewport(1280, 900);
  await navigate(server.base + "/");
  await clickButton("Notifications", "document.querySelector('.topbar')");
  await sleep(700);
  const desktop = await evaluate(`(() => {
    const panel = document.getElementById("sources-notifs-panel");
    const rect = panel.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height), visible: !panel.hidden && rect.width > 0 };
  })()`);
  check(
    "en 1280 px, la section s'affiche dans une largeur lisible",
    desktop?.visible === true && desktop.width > 300 && desktop.width <= 800,
    JSON.stringify(desktop),
  );
  const shotDesktop = await screenshot("sources-notifications-bureau");

  /* ── 6) /config : section « Sources » (tableau + jeton + borne) ─────────── */
  await setViewport(1280, 1000);
  await navigate(server.base + "/config#conversation");
  const configPanel = await evaluate(`(() => {
    const root = document.getElementById("sources-root");
    if (!root) return null;
    root.scrollIntoView({ block: "center" });
    const rows = [...root.querySelectorAll("tbody tr")].map((r) =>
      (r.textContent || "").replace(/\\s+/g, " ").trim(),
    );
    const buttons = [...root.querySelectorAll("button")].map((b) => (b.textContent || "").trim());
    // La borne d'injection du bloc <sources> est réglable dans le même onglet.
    const tab = document.getElementById("panel-conversation");
    const bound = (tab?.textContent ?? "").includes("Notifications transmises au modèle en un tour");
    // ⚠️ Périmètre = LA SECTION DES SOURCES : la brique vendorisee tokens pose
    // des variables de thème sur <html> (comportement préexistant, hors sujet).
    const styled = [...root.querySelectorAll("[style]")].map(
      (el) => el.tagName + "." + el.className,
    );
    return { rows, buttons, bound, styleAttrs: styled.length, styled };
  })()`);
  check(
    "/config : le tableau des sources liste les deux sources",
    Boolean(
      configPanel &&
        configPanel.rows.length === 2 &&
        configPanel.rows.some((row) => row.includes("veille")) &&
        configPanel.rows.some((row) => row.includes("mail")),
    ),
    JSON.stringify(configPanel?.rows),
  );
  check(
    "/config : les actions attendues sont là (réglages, jeton, suppression)",
    Boolean(
      configPanel &&
        configPanel.buttons.some((label) => label.includes("Réglages")) &&
        configPanel.buttons.some((label) => label.includes("jeton")) &&
        configPanel.buttons.some((label) => label.includes("Supprimer")) &&
        configPanel.buttons.some((label) => label.includes("Nouvelle source")),
    ),
    JSON.stringify(configPanel?.buttons),
  );
  check(
    "/config : la borne d'injection des notifications est réglable dans l'onglet Conversation",
    configPanel?.bound === true,
  );
  check(
    "/config : aucun attribut style dans la section des sources (CSP)",
    configPanel?.styleAttrs === 0,
    JSON.stringify(configPanel?.styled),
  );
  const shotConfig = await screenshot("sources-config");

  /* ── 6bis) ⚠️ « Envoyer dans : » — l'utilisateur désigne un FIL PRÉCIS ──── */
  const stateConfig = await fetch(`${server.base}/api/e2e/sources-state`).then((r) => r.json());
  const openedSettings = await evaluate(`(() => {
    const row = [...document.querySelectorAll("#sources-root tbody tr")].find((r) =>
      (r.textContent || "").includes("mail"),
    );
    const button = [...(row?.querySelectorAll("button") ?? [])].find((b) =>
      (b.textContent || "").includes("Réglages"),
    );
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(500);
  const destinationUi = await evaluate(`(() => {
    const select = document.getElementById("source-conversation");
    if (!select) return null;
    return {
      label: document.querySelector('label[for="source-conversation"]')?.textContent ?? "",
      groups: [...select.querySelectorAll("optgroup")].map((g) => g.label),
      values: [...select.options].map((o) => o.value),
      texts: [...select.options].map((o) => o.textContent),
    };
  })()`);
  check(
    "⚠️ /config → Sources : le sélecteur « Envoyer dans : » propose les CONVERSATIONS",
    Boolean(
      destinationUi &&
        destinationUi.label.includes("Envoyer dans") &&
        destinationUi.values.includes(stateConfig.workSession) &&
        destinationUi.texts.some((text) => text.includes("Conversation de travail")) &&
        destinationUi.values.includes("source") &&
        destinationUi.values.includes("nouvelle") &&
        destinationUi.values.includes("aucune"),
    ),
    JSON.stringify(destinationUi),
  );
  // On CHOISIT le fil, puis on enregistre.
  const picked = await evaluate(`(() => {
    const select = document.getElementById("source-conversation");
    if (!select) return false;
    if (![...select.options].some((o) => o.value === ${JSON.stringify(stateConfig.workSession)})) {
      return false;
    }
    select.value = ${JSON.stringify(stateConfig.workSession)};
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  // ⚠️ Le bouton de la MODALE (« Enregistrer » du pied), pas `#save` de
  // `config.html:356` qui porte le même libellé et vient AVANT dans le DOM.
  const saved = await clickButton("Enregistrer", "document", { overlay: true, last: true });
  await sleep(1200);
  const stateSaved = await fetch(`${server.base}/api/e2e/sources-state`).then((r) => r.json());
  const mailSaved = stateSaved.sources.find((source) => source.nom === "mail");
  check(
    "⚠️ le fil choisi est ENREGISTRÉ côté serveur (jamais envoyé par le programme)",
    picked === true && saved === true && mailSaved?.conversation === stateConfig.workSession,
    JSON.stringify(mailSaved),
  );

  /* ── 7) ⚠️ La lecture des sources est FERMÉE (en-tête X-Yuki-Config exigé) ── */
  // Une page tierce ne doit ni lire la boîte (contenu des messages de sources), ni
  // la liste des sources (consignes + destinations).
  for (const path of ["/api/sources", "/api/sources/inbox"]) {
    const anonymous = await fetch(server.base + path);
    check(
      `GET ${path} sans X-Yuki-Config ⇒ refusé (403)`,
      anonymous.status === 403,
      `HTTP ${anonymous.status}`,
    );
    const guarded = await fetch(server.base + path, { headers: { "x-yuki-config": "1" } });
    check(`GET ${path} avec X-Yuki-Config ⇒ 200`, guarded.status === 200, `HTTP ${guarded.status}`);
  }

  /* ── 8) Le fil de la source est VISIBLE dans la liste des conversations ── */
  await setViewport(1280, 900);
  await navigate(server.base + "/");
  const stateBefore = await fetch(`${server.base}/api/e2e/sources-state`).then((r) => r.json());
  const rail = await evaluate(`(() => {
    const items = [...document.querySelectorAll("#sessions-sidebar .conv")];
    return {
      ids: items.map((item) => item.getAttribute("data-id")),
      titles: items.map((item) => (item.textContent || "").replace(/\\s+/g, " ").trim()),
    };
  })()`);
  check(
    "⚠️ le fil qui reçoit la source est VISIBLE dans la liste (aucun fil caché)",
    Boolean(
      rail &&
        rail.ids.includes(stateBefore.workSession) &&
        rail.titles.some((title) => title.includes("Conversation de travail")),
    ),
    JSON.stringify(rail?.titles),
  );

  /* ── 9) Suppression d'un fil qui reçoit une source : MODALE + 3 choix ──── */
  // Clic droit sur la conversation de travail ⇒ menu du titre ⇒ « Supprimer ».
  const menuOpened = await evaluate(`(() => {
    const item = document.querySelector('#sessions-sidebar .conv[data-id="' + ${JSON.stringify(
      stateBefore.workSession,
    )} + '"]');
    if (!item) return false;
    item.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 160, clientY: 200 }));
    return true;
  })()`);
  await sleep(300);
  const deleteClicked = await clickButton("Supprimer", "document.querySelector('.ctx-menu') || document");
  await sleep(500);
  const modal = await evaluate(`(() => {
    const dialog = document.querySelector(".holaf-modal-root");
    if (!dialog) return null;
    const form = document.getElementById("sources-delete-form");
    const choice = document.getElementById("sources-delete-choice");
    return {
      title: (dialog.querySelector(".holaf-modal-title") || dialog).textContent || "",
      sources: [...(form?.querySelectorAll(".dialog-list li") || [])].map((li) => li.textContent),
      choices: [...(choice?.querySelectorAll("option") || [])].map((o) => o.textContent),
      note: (form?.querySelector(".dialog-note") || {}).textContent || "",
      // ⚠️ Le texte dit que les sources ne sont PAS supprimées.
      keepsSources: /ne seront PAS supprimées/.test(form?.textContent || ""),
    };
  })()`);
  check(
    "⚠️ supprimer un fil qui reçoit une source ouvre la MODALE (aucun `window.confirm`)",
    menuOpened === true && deleteClicked === true && Boolean(modal),
    JSON.stringify({ menuOpened, deleteClicked, modal: Boolean(modal) }),
  );
  check(
    "la modale LISTE la source concernée",
    Boolean(modal && modal.sources.some((nom) => nom === "veille")),
    JSON.stringify(modal?.sources),
  );
  check(
    "la modale propose les TROIS choix (rattacher / nouvelle conversation / quand même)",
    Boolean(
      modal &&
        modal.choices.length === 3 &&
        modal.choices.some((label) => label.includes("Rattacher")) &&
        modal.choices.some((label) => label.includes("nouvelle conversation")) &&
        modal.choices.some((label) => label.includes("Supprimer quand même")),
    ),
    JSON.stringify(modal?.choices),
  );
  check(
    "la modale dit que les sources ne sont PAS supprimées",
    modal?.keepsSources === true,
  );

  // Choix explicite « Supprimer quand même » ⇒ le fil part, la SOURCE RESTE.
  const chosen = await evaluate(`(() => {
    const choice = document.getElementById("sources-delete-choice");
    if (!choice) return false;
    const option = [...choice.options].find((o) => o.textContent.includes("Supprimer quand même"));
    if (!option) return false;
    choice.value = option.value;
    choice.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  // Le bouton « Continuer » de la MODALE (la boîte de notifications, elle, porte
  // « Continuer dans une conversation » : sans portée, on cliquerait le mauvais).
  const submitted = await clickButton("Continuer", "document", { overlay: true });
  await sleep(1500);
  const stateAfter = await fetch(`${server.base}/api/e2e/sources-state`).then((r) => r.json());
  const veille = stateAfter.sources.find((source) => source.nom === "veille");
  const alertEntry = (stateAfter.inbox || []).find((entry) => entry.etat === "alerte");
  check(
    "⚠️ « supprimer quand même » : le fil disparaît, la SOURCE est CONSERVÉE",
    chosen === true && submitted === true && Boolean(veille) && veille.conversation === "nouvelle",
    JSON.stringify(veille),
  );
  check(
    "⚠️ …et un AVIS l'écrit dans la boîte de notifications",
    Boolean(alertEntry && /n'a PAS été supprimée/.test(alertEntry.texte ?? "")),
    JSON.stringify({ etat: alertEntry?.etat, titre: alertEntry?.titre }),
  );
  const railAfter = await evaluate(`(() => {
    const items = [...document.querySelectorAll("#sessions-sidebar .conv")];
    return items.map((item) => item.getAttribute("data-id"));
  })()`);
  check(
    "le fil supprimé a bien quitté la liste",
    Boolean(railAfter && !railAfter.includes(stateBefore.workSession)),
    JSON.stringify(railAfter),
  );

  /* ── 10) La source survit : son message suivant part dans un fil NEUF ─── */
  const relance = await push("veille", {
    id: "e2e-veille-2",
    texte: "Deuxième veille du matin.",
    titre: "Veille (après suppression)",
    tour: "lancer",
  });
  await sleep(1200);
  const stateRelance = await fetch(`${server.base}/api/e2e/sources-state`).then((r) => r.json());
  const veilleAfter = stateRelance.sources.find((source) => source.nom === "veille");
  const lastSend = stateRelance.sends[stateRelance.sends.length - 1];
  check(
    "⚠️ après la suppression, la source envoie quand même (fil NEUF, visible)",
    relance.status === 202 &&
      relance.data?.started === true &&
      Boolean(lastSend) &&
      lastSend.sessionId !== stateBefore.workSession &&
      stateRelance.sends.length === stateBefore.sends.length + 1,
    JSON.stringify({ status: relance.status, lastSend, conversation: veilleAfter?.conversation }),
  );
  // L'AVIS est VISIBLE dans la boîte (état « alerte », texte déplié : ce n'est pas
  // un message reçu, il n'a rien à cacher).
  await clickButton("Notifications", "document.querySelector('.topbar')");
  await sleep(800);
  const alertRendered = await evaluate(`(() => {
    const entries = [...document.querySelectorAll("#sources-notifs-list .notif")];
    const alert = entries.find(
      (entry) => (entry.querySelector(".notif__state")?.textContent ?? "") === "alerte",
    );
    return {
      states: entries.map((e) => e.querySelector(".notif__state")?.textContent ?? ""),
      note: alert?.querySelector(".notif__note")?.textContent ?? "",
      folded: Boolean(alert?.querySelector("details")),
      canOpen: [...(alert?.querySelectorAll("button") ?? [])].some((b) =>
        (b.textContent || "").includes("Continuer"),
      ),
    };
  })()`);
  check(
    "⚠️ l'avis apparaît dans la boîte, texte LISIBLE et sans bouton « Continuer »",
    alertRendered?.states.includes("alerte") === true &&
      /n'a PAS été supprimée/.test(alertRendered?.note ?? "") &&
      alertRendered?.folded === false &&
      alertRendered?.canOpen === false,
    JSON.stringify(alertRendered),
  );
  const shotDelete = await screenshot("sources-suppression-fil");

  /* ── 11) CSP / connexions / exceptions ──────────────────────────────────── */
  const { cspViolations, connectionErrors } = collectViolations(consoleMessages, logEntries);
  check("aucune violation CSP", cspViolations.length === 0, JSON.stringify(cspViolations.slice(0, 3)));
  check(
    "aucune erreur de connexion",
    connectionErrors.length === 0,
    JSON.stringify(connectionErrors.slice(0, 3)),
  );
  check("aucune exception de page", pageExceptions.length === 0, JSON.stringify(pageExceptions.slice(0, 3)));

  console.log("\nCaptures (dossier temporaire, aucun PNG suivi réécrit) :");
  for (const path of [shotPhone, shotReply, shotDesktop, shotConfig, shotDelete]) {
    console.log("  " + path);
  }
} finally {
  const failures = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failures.length}/${results.length} vérifications OK` +
      (failures.length > 0 ? ` — ${failures.length} ÉCHEC(S)` : ""),
  );
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  chrome.kill("SIGKILL");
  server.proc.kill("SIGKILL");
  process.exitCode = failures.length === 0 ? 0 : 1;
}
