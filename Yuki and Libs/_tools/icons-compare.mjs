#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
 * icons-compare.mjs — comparatif visuel « brique HolafIcons (Feather) »
 *                    vs « tracés actuellement inline dans Yuki (Lucide) »
 * ─────────────────────────────────────────────────────────────────────────────
 * Lot : ajout de arrow-left / volume / volume-off à la brique `icons` de
 * holaf-lib (v0.1.5). Ce comparatif permet à l'utilisateur de VOIR le delta de
 * tracé avant d'intégrer les icônes de la brique dans Yuki.
 *
 * Les DEUX variantes sont RÉELLES, jamais redessinées :
 *   • colonne « Brique (Feather) » = sortie EXACTE de HolafIcons.render(...)
 *     (import du fichier réel /projects/holaf-lib/js/holaf-icons.js) ;
 *   • colonne « Yuki (Lucide) »    = tracés EXTRAITS des fichiers de Yuki
 *     (public/ui/index.html, public/ui/config.html).
 *
 * Sortie : _tools/icons-compare.html (rendu par navigateur headless).
 * Usage  : node "Yuki and Libs/_tools/icons-compare.mjs"
 * ═════════════════════════════════════════════════════════════════════════ */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { HolafIcons } from "file:///projects/holaf-lib/js/holaf-icons.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const YUKI_UI = "/projects/Yuki/public/ui";

const ICONS = ["arrow-left", "volume", "volume-off"];

/** Extrait le corps (tracés internes) du SVG réellement inline dans Yuki. */
function extractInline(html, className) {
    const re = new RegExp(
        '<svg class="icon ' + className + '"[^>]*>([\\s\\S]*?)</svg>'
    );
    const m = html.match(re);
    if (!m) throw new Error("tracé inline introuvable : " + className);
    return m[1].trim();
}

const indexHtml = readFileSync(join(YUKI_UI, "index.html"), "utf8");
const configHtml = readFileSync(join(YUKI_UI, "config.html"), "utf8");

const yuki = {
    "arrow-left": extractInline(configHtml, "icon--arrow-left"),
    volume: extractInline(indexHtml, "icon--volume"),
    "volume-off": extractInline(indexHtml, "icon--volume-off"),
};
const brique = {};
for (const n of ICONS) brique[n] = HolafIcons.render(n, { size: 96 });

// Les tracés Lucide extraits sont des <path> bruts : on les enveloppe dans un
// <svg> aux MÊMES attributs que la brique (24×24, stroke currentColor,
// stroke-width 2, extrémités arrondies) pour un rendu comparable.
const wrapLucide = (body) =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="96" ' +
    'height="96" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + body + "</svg>";
for (const n of ICONS) yuki[n] = wrapLucide(yuki[n]);

const cell = (svg, label) =>
    `<figure class="cell"><div class="glyph">${svg}</div><figcaption>${label}</figcaption></figure>`;

const row = (name) => `
    <div class="row">
      <div class="rowhead"><code>${name}</code></div>
      ${cell(brique[name], "brique · Feather")}
      ${cell(yuki[name], "Yuki actuel · Lucide")}
    </div>`;

const panel = (theme) => `
  <section class="panel ${theme}">
    <h2>${theme === "dark" ? "Fond sombre" : "Fond clair"}</h2>
    <div class="grid">
      <div class="row head">
        <div class="rowhead">icône</div>
        <div class="colhead">Brique holaf-lib (Feather)</div>
        <div class="colhead">Yuki inline actuel (Lucide)</div>
      </div>
      ${ICONS.map(row).join("\n")}
    </div>
  </section>`;

const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<title>HolafIcons 0.1.5 — comparatif Feather (brique) vs Lucide (Yuki)</title>
<style>
  :root { --gap: 28px; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; background: #0b1020; color: #e5e7eb; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .intro { color: #9aa4b2; max-width: 900px; margin: 0 0 28px; }
  .intro code { color: #cbd5e1; }
  .panel { border-radius: 14px; padding: 20px 24px 24px; margin-bottom: 28px; border: 1px solid #1f2937; }
  .panel.dark  { background: #111827; color: #e5e7eb; }
  .panel.light { background: #f8fafc; color: #1f2937; border-color: #e2e8f0; }
  .panel h2 { font-size: 15px; margin: 0 0 18px; letter-spacing: .04em; text-transform: uppercase; opacity: .75; }
  .grid { display: grid; grid-template-columns: 150px 1fr 1fr; align-items: center; }
  .row { display: contents; }
  .head .rowhead, .head .colhead { font-size: 12px; letter-spacing: .05em; text-transform: uppercase; opacity: .6; padding-bottom: 10px; }
  .rowhead { padding: 22px 0; font-weight: 600; }
  .cell { margin: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; padding: 12px 0; }
  .glyph { display: flex; align-items: center; justify-content: flex-start; }
  .cell svg { color: currentColor; }
  figcaption { font-size: 12px; opacity: .65; }
  .panel.dark  .cell svg { color: #e5e7eb; }
  .panel.light .cell svg { color: #111827; }
  .row { border-top: 1px solid rgba(148,163,184,.18); }
  .grid > .head { border-top: 0; }
</style>
</head>
<body>
  <h1>HolafIcons v${HolafIcons.version} — comparatif de tracé</h1>
  <p class="intro">
    Pour chaque icône : colonne gauche = tracé <strong>de la brique</strong>
    (<code>HolafIcons.render()</code>, style Feather), colonne droite = tracé
    <strong>actuellement inline dans Yuki</strong> (collection Lucide, extrait de
    <code>public/ui/*.html</code>). Même taille (96 px) et même épaisseur
    (<code>stroke-width="2"</code>, viewBox 24×24). Les tracés des deux colonnes
    sont extraits des sources réelles, jamais redessinés.
  </p>
  ${panel("dark")}
  ${panel("light")}
</body>
</html>`;

const out = join(HERE, "icons-compare.html");
writeFileSync(out, html, "utf8");
console.log("écrit :", out);
console.log("brique v" + HolafIcons.version + " — icônes comparées :", ICONS.join(", "));
