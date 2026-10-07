#!/usr/bin/env node
/**
 * MAQUETTE JETABLE (hors production) — comparaison de règles/palettes de thème.
 *
 * But : montrer à l'utilisateur, sur UN MÊME mini-écran factice (bout de Yuki),
 * plusieurs directions de thème côte à côte, pour qu'il puisse se positionner.
 *
 * Contraintes respectées :
 *   - fichier HTML AUTONOME (un seul .html, aucune dépendance, aucun réseau) ;
 *   - thème par VARIABLES CSS + `data-theme` (comme Yuki), AUCUN attribut
 *     `style=` sur les éléments (esprit CSP `style-src 'self'`) ;
 *   - la maquette ne touche AUCUN fichier de production de Yuki ni de holaf-lib.
 *
 * Variantes (toutes sur le même markup, seules les couleurs changent) :
 *   0. ACTUEL       — valeurs réelles projetées par generate-yuki-themes.mjs ;
 *   A. GRIS+ACCENT  — surfaces quasi achromatiques, seule la pointe change ;
 *   B. AMBIANCES    — valeurs EXACTES de palettes réelles (Nord, Gruvbox,
 *                     Catppuccin Mocha, Rosé Pine Dawn) ;
 *   C. NEUTRE TEINTÉ MAÎTRISÉ + profondeur — correction du défaut : chroma de
 *      surface très faible (ordre de grandeur Material), 3 niveaux de surface
 *      réels (surface / surface-elev / surface-raised) + surface-hover.
 *
 * Conversion OKLCH→sRGB implémentée ici (Björn Ottosson, 2020) pour définir la
 * variante C de façon perceptuellement régulière, et calcul WCAG (sRGB/relative
 * luminance) pour VÉRIFIER les contrastes de chaque variante.
 *
 * Usage :  node _tools/theme-proposal.mjs
 * Sortie : _tools/theme-proposal.html  + table de contrastes sur stdout.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  contrast, grayPalette, mix, oklch, readableOn, tintedPalette,
} from "./theme-lib.mjs";

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. Variantes de thème
 * ═════════════════════════════════════════════════════════════════════════ */


/* -- 0. ACTUEL : valeurs réellement projetées par generate-yuki-themes.mjs
 *    (holaf-tokens 0.3.0). 2 niveaux de surface seulement : --raised et
 *    --hover n'existent pas côté Yuki ⇒ repliés sur surface-elev (aplat). */
const ACTUEL = {
  "actuel-emerald-dark": {
    label: "0 · ACTUEL — Émeraude sombre",
    note: "surface teintée par l'accent, 2 niveaux de surface (panel-2 = surface-elev ; raised/hover absents).",
    mode: "dark",
    colors: {
      bg: "#0b1512", panel: "#0b1512", elev: "#12201a", raised: "#12201a", hover: "#12201a",
      border: "#143f30", text: "#f4f4f5", muted: "#929696",
      accent: "#34d399", danger: "#ef4444", ok: "#4cc38a",
      user: "#12372a", assistant: "#0d201a",
    },
  },
  "actuel-indigo-dark": {
    label: "0 · ACTUEL — Indigo sombre",
    note: "même modèle, accent différent : le fond reste « neutre chaud » (≈ slate-dark, Δ≈1,5,13).",
    mode: "dark",
    colors: {
      bg: "#1e1e1e", panel: "#1e1e1e", elev: "#27272a", raised: "#27272a", hover: "#27272a",
      border: "#3f3f46", text: "#e4e4e7", muted: "#a1a1aa",
      accent: "#6366f1", danger: "#ef4444", ok: "#4cc38a",
      user: "#2a2b44", assistant: "#22222b",
    },
  },

  /* -- A. GRIS + ACCENT : base quasi achromatique (chroma OKLCH 0), seule la
   *    couleur d'accent change. Reproduction assumée de la plainte actuelle. */
  "A-gris-indigo": {
    label: "A · GRIS + ACCENT — Indigo",
    note: "surfaces 100 % achromatiques ; l'accent est la SEULE couleur. Fonds identiques entre familles.",
    mode: "dark",
    colors: grayPalette("#6366f1", "dark"),
  },
  "A-gris-emerald": {
    label: "A · GRIS + ACCENT — Émeraude",
    note: "même base grise que A-indigo : fond STRICTEMENT identique, seul l'accent diffère.",
    mode: "dark",
    colors: grayPalette("#10b981", "dark"),
  },
  "A-gris-indigo-light": {
    label: "A · GRIS + ACCENT — Indigo clair",
    note: "version claire de A : gris purs + accent.",
    mode: "light",
    colors: grayPalette("#6366f1", "light"),
  },

  /* -- B. AMBIANCES COMPLÈTES : valeurs EXACTES des palettes sources. */
  "B-nord-dark": {
    label: "B · NORD (sombre)",
    note: "valeurs officielles Nord : bg=#2e3440, surfaces #3b4252/#434c5e/#4c566a, accent #88c0d0.",
    mode: "dark",
    colors: {
      bg: "#2e3440", panel: "#2e3440", elev: "#3b4252", raised: "#434c5e", hover: "#4c566a",
      border: "#4c566a", text: "#eceff4", muted: "#81a1c1",
      accent: "#88c0d0", danger: "#bf616a", ok: "#a3be8c",
      user: "#434c5e", assistant: "#3b4252",
    },
  },
  "B-gruvbox-dark": {
    label: "B · GRUVBOX (sombre, chaude)",
    note: "valeurs officielles Gruvbox : bg=#282828, surfaces #3c3836/#504945/#665c54, accent #fabd2f.",
    mode: "dark",
    colors: {
      bg: "#282828", panel: "#282828", elev: "#3c3836", raised: "#504945", hover: "#665c54",
      border: "#665c54", text: "#ebdbb2", muted: "#a89984",
      accent: "#fabd2f", danger: "#fb4934", ok: "#b8bb26",
      user: "#504945", assistant: "#32302f",
    },
  },
  "B-catppuccin-dark": {
    label: "B · CATPPUCCIN Mocha (pastel multi-teintes)",
    note: "valeurs officielles Catppuccin : base #1e1e2e, surfaces #313244/#45475a/#585b70, accents pastel.",
    mode: "dark",
    colors: {
      bg: "#1e1e2e", panel: "#181825", elev: "#313244", raised: "#45475a", hover: "#585b70",
      border: "#45475a", text: "#cdd6f4", muted: "#a6adc8",
      accent: "#89b4fa", danger: "#f38ba8", ok: "#a6e3a1",
      user: "#45475a", assistant: "#313244",
    },
  },
  "B-rosepine-dawn-light": {
    label: "B · ROSÉ PINE Dawn (claire)",
    note: "valeurs officielles Rosé Pine Dawn : base #faf4ed, surface #fffaf3, accent #286983.",
    mode: "light",
    colors: {
      bg: "#faf4ed", panel: "#faf4ed", elev: "#fffaf3", raised: "#f2e9e1", hover: "#dfdad9",
      border: "#dfdad9", text: "#464261", muted: "#797593",
      accent: "#286983", danger: "#b4637a", ok: "#56949f",
      user: "#f2e9e1", assistant: "#fffaf3",
    },
  },

  /* -- C. NEUTRE TEINTÉ MAÎTRISÉ + profondeur : accent = graine Yuki INCHANGÉE,
   *    mais surfaces à chroma très faible et 3 niveaux de surface + hover. */
  "C-emerald-dark": {
    label: "C · NEUTRE TEINTÉ MAÎTRISÉ — Émeraude sombre",
    note: "même accent que 0, mais surface chroma OKLCH 0,010–0,018 (≪ actuel) et 3 niveaux de surface.",
    mode: "dark",
    colors: tintedPalette("#10b981", "dark"),
  },
  "C-indigo-dark": {
    label: "C · NEUTRE TEINTÉ MAÎTRISÉ — Indigo sombre",
    note: "surface très légèrement teintée (teinte de l'accent), clarté/hauteur distinctes de C-émeraude.",
    mode: "dark",
    colors: tintedPalette("#6366f1", "dark", { L: 0.225 }),
  },
  "C-amber-dark": {
    label: "C · NEUTRE TEINTÉ MAÎTRISÉ — Ambre sombre",
    note: "surface très légèrement teintée (chaude), clarté distincte ⇒ famille immédiatement reconnaissable.",
    mode: "dark",
    colors: tintedPalette("#f59e0b", "dark", { L: 0.175 }),
  },
  "C-slate-light": {
    label: "C · NEUTRE TEINTÉ MAÎTRISÉ — Ardoise claire",
    note: "mode clair : surface quasi neutre, léger décalage de teinte, 3 niveaux de surface.",
    mode: "light",
    colors: tintedPalette("#475569", "light"),
  },
};

/* -- Texte sur accent : l'ACTUEL garde #fff (comme Yuki, `color:#fff` sur
 *    `--accent`) pour rester fidèle ; les autres variantes prennent un
 *    `--on-accent` calcule lisible (>= 4.5:1). */
for (const [k, v] of Object.entries(ACTUEL)) {
  v.colors.onAccent = k.startsWith("actuel-") ? "#ffffff" : readableOn(v.colors.accent);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. Vérification WCAG (rapportée sur stdout + inscrite dans la maquette)
 * ═════════════════════════════════════════════════════════════════════════ */

function audit(v, key) {
  const c = v.colors;
  const surf = [["carte", c.elev], ["surélevé", c.raised]];
  const lines = [];
  const r = (label, a, b) => {
    const x = contrast(a, b);
    lines.push(`${x.toFixed(2)}:1  ${label}`);
    return x;
  };
  const textBg = r("texte / fond", c.text, c.bg);
  const textElev = r("texte / carte", c.text, c.elev);
  const mutedBg = r("atténué / fond", c.muted, c.bg);
  const accentBtn = r("texte bouton / accent", c.onAccent, c.accent);
  const borderBg = r("bordure / fond", c.border, c.bg);
  const okBg = r("badge ok / fond", c.ok, c.bg);
  const dangerBg = r("badge danger / fond", c.danger, c.bg);
  return { key, label: v.label, mode: v.mode, bgHex: c.bg, accentHex: c.accent, elevHex: c.elev, textBg, textElev, mutedBg, accentBtn, borderBg, okBg, dangerBg, lines };
}

const audits = Object.entries(ACTUEL).map(([k, v]) => audit(v, k));

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. Rendu HTML autonome
 * ═════════════════════════════════════════════════════════════════════════ */

const cssVarsRule = (id, c) =>
  [
    `.tile[data-theme="${id}"] {`,
    `  --bg: ${c.bg}; --panel: ${c.panel};`,
    `  --elev: ${c.elev}; --raised: ${c.raised}; --hover: ${c.hover};`,
    `  --border: ${c.border}; --text: ${c.text}; --muted: ${c.muted};`,
    `  --accent: ${c.accent}; --on-accent: ${c.onAccent}; --danger: ${c.danger}; --ok: ${c.ok};`,
    `  --user: ${c.user}; --assistant: ${c.assistant};`,
    `}`,
  ].join("\n");

/* Mini-écran = un vrai bout de Yuki (topbar, conversation, carte + niveaux de
 * surface, bulles user/assistant, composer, badge, lien, texte normal/atténué). */
function mini(id, v, a) {
  const swatches = ["bg", "elev", "raised", "hover", "border", "accent", "user", "assistant", "ok", "danger"]
    .map((k) => `<i class="sw sw--${k}"></i>`)
    .join("");
  const warn = Object.entries({
    "texte/fond": a.textBg, "texte/carte": a.textElev, "atténué/fond": a.mutedBg,
    "texte bouton/accent": a.accentBtn, "badge ok/fond": a.okBg,
  }).filter(([, x]) => x < 4.5).map(([k, x]) => `${k} ${x.toFixed(2)}`).join(" · ");
  return `
<figure class="tile" data-theme="${id}" data-mode="${v.mode}">
  <figcaption class="tile__cap">
    <span class="tile__title">${v.label}</span>
    <span class="tile__note">${v.note}</span>
    <span class="swatches">${swatches}</span>
  </figcaption>
  <div class="mini">
    <div class="app">
      <header class="topbar">
        <span class="brand">Yuki</span>
        <span class="status">
          <a class="pill">Configuration</a>
          <span class="pill pill--accent">En ligne</span>
          <span class="badge badge--ok">ok</span>
        </span>
      </header>
      <main class="conversation">
        <div class="card">
          <div class="card__head">
            <h3 class="card__title">Panneau</h3>
            <span class="badge badge--warn">en file</span>
          </div>
          <p class="normal">Texte normal lisible sur la carte.</p>
          <p class="muted">Texte atténué (secondaire).</p>
          <div class="chips">
            <span class="chip chip--raised">surélevé</span>
            <span class="chip chip--hover">survol</span>
            <span class="chip chip--border">bordure</span>
          </div>
          <p><a class="link">Voir la configuration →</a></p>
        </div>
        <div class="msg msg--assistant">
          <span class="msg__who">Assistant</span>
          <p>Voici la réponse du modèle, sur la surface assistant.</p>
        </div>
        <div class="msg msg--user">
          <span class="msg__who">Vous</span>
          <p>Message de l'utilisateur, sur la surface user.</p>
        </div>
      </main>
      <footer class="composer">
        <div class="field">Écrivez un message…</div>
        <button class="button">Envoyer</button>
      </footer>
    </div>
  </div>
  <div class="audit">
    <span class="hexes">fond ${a.bgHex} · accent ${a.accentHex} · surface ${a.elevHex}</span>
    <span class="${a.textBg >= 4.5 ? "ok" : "ko"}">texte/fond ${a.textBg.toFixed(2)}:1</span>
    <span class="${a.textElev >= 4.5 ? "ok" : "ko"}">texte/carte ${a.textElev.toFixed(2)}:1</span>
    <span class="${a.mutedBg >= 4.5 ? "ok" : "ko"}">atténué/fond ${a.mutedBg.toFixed(2)}:1</span>
    <span class="${a.borderBg >= 3 ? "ok" : "ko"}">bordure/fond ${a.borderBg.toFixed(2)}:1</span>
    <span class="${a.okBg >= 4.5 ? "ok" : "ko"}">ok/fond ${a.okBg.toFixed(2)}:1</span>
    ${warn ? `<span class="ko">⚠ ${warn}</span>` : ""}
  </div>
</figure>`;
}

const order = [
  "actuel-emerald-dark", "actuel-indigo-dark",
  "A-gris-indigo", "A-gris-emerald", "A-gris-indigo-light",
  "B-nord-dark", "B-gruvbox-dark", "B-catppuccin-dark", "B-rosepine-dawn-light",
  "C-emerald-dark", "C-indigo-dark", "C-amber-dark", "C-slate-light",
];
const tiles = order.map((k) => mini(k, ACTUEL[k], audits.find((a) => a.key === k))).join("\n");

const styleBlock = order.map((k) => cssVarsRule(k, ACTUEL[k].colors)).join("\n");

const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Yuki — proposition de thèmes (maquette, hors production)</title>
<style>
/* ═══ Page de la maquette (neutre, volontairement SANS couleur) ═══════════ */
* { box-sizing: border-box; }
body {
  margin: 0; padding: 28px 32px 60px;
  background: #14161a; color: #e7eaf0;
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
h1 { font-size: 22px; margin: 0 0 6px; }
h2 { font-size: 16px; margin: 34px 0 4px; border-top: 1px solid #2b2f36; padding-top: 18px; }
p.lead { color: #a4acba; max-width: 110ch; margin: 6px 0 0; }
p.lead b { color: #e7eaf0; }
code { background: #22262d; border: 1px solid #2f3540; border-radius: 4px; padding: 0 4px; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 20px; margin-top: 16px; }
.grid--pair { grid-template-columns: repeat(auto-fill, minmax(430px, 1fr)); }

.tile { margin: 0; border: 1px solid #2b2f36; border-radius: 12px; padding: 12px; background: #191c21; }
.tile__cap { display: flex; flex-direction: column; gap: 3px; margin-bottom: 10px; }
.tile__title { font-weight: 700; font-size: 13px; }
.tile__note { color: #9aa2af; font-size: 11.5px; }
.swatches { display: flex; gap: 4px; margin-top: 5px; }
.sw { display: inline-block; width: 16px; height: 16px; border-radius: 3px; border: 1px solid rgba(255,255,255,.18); }
.sw--bg { background: var(--s-bg); } .sw--elev { background: var(--s-elev); }
.sw--raised { background: var(--s-raised); } .sw--hover { background: var(--s-hover); }
.sw--border { background: var(--s-border); } .sw--accent { background: var(--s-accent); }
.sw--user { background: var(--s-user); } .sw--assistant { background: var(--s-assistant); }
.sw--ok { background: var(--s-ok); } .sw--danger { background: var(--s-danger); }
.tile[data-theme] {
  --s-bg: var(--bg); --s-elev: var(--elev); --s-raised: var(--raised); --s-hover: var(--hover);
  --s-border: var(--border); --s-accent: var(--accent); --s-user: var(--user); --s-assistant: var(--assistant);
  --s-ok: var(--ok); --s-danger: var(--danger);
}
.tile[data-mode] .sw { border-color: rgba(0,0,0,.25); }

/* ═══ Thèmes : variables CSS par variante (data-theme) — AUCUN style inline ═══ */
${styleBlock}

/* ═══ Mini-écran — STRICTEMENT les mêmes règles pour TOUTES les variantes ;
 *    seules les variables CSS changent (via .mini[data-theme="…"]). ═══════ */
.mini { border-radius: 10px; overflow: hidden; border: 1px solid var(--border); }
.app { display: flex; flex-direction: column; background: var(--bg); color: var(--text); font-size: 12.5px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; background: var(--panel); border-bottom: 1px solid var(--border); }
.brand { font-weight: 700; letter-spacing: .02em; }
.status { display: flex; gap: 6px; align-items: center; }
.pill { font-size: 10.5px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--border); background: var(--elev); color: var(--muted); text-decoration: none; }
.pill--accent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.badge { font-size: 10px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border); }
.badge--ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
.badge--warn { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.conversation { display: flex; flex-direction: column; gap: 9px; padding: 13px; background: var(--bg); }
.card { background: var(--elev); border: 1px solid var(--border); border-radius: 10px; padding: 11px 12px; }
.card__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card__title { margin: 0 0 4px; font-size: 13px; }
.normal { margin: 6px 0 2px; }
.muted { margin: 2px 0 8px; color: var(--muted); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.chip { font-size: 10.5px; padding: 3px 9px; border-radius: 6px; border: 1px solid var(--border); }
.chip--raised { background: var(--raised); }
.chip--hover { background: var(--hover); }
.chip--border { background: transparent; }
.link { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.msg { max-width: 82%; padding: 8px 11px; border-radius: 12px; border: 1px solid var(--border); }
.msg p { margin: 3px 0 0; }
.msg__who { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.msg--assistant { align-self: flex-start; background: var(--assistant); }
.msg--user { align-self: flex-end; background: var(--user); }
.composer { display: flex; gap: 8px; align-items: center; padding: 10px 12px; background: var(--panel); border-top: 1px solid var(--border); }
.field { flex: 1; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--elev); color: var(--muted); }
.button { padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; cursor: pointer; }

/* Audit WCAG sous chaque tuile */
.audit { display: flex; flex-wrap: wrap; gap: 5px 10px; margin-top: 8px; font-size: 10.5px; color: #9aa2af; }
.audit .ok { color: #7fd6a3; }
.audit .ko { color: #ff9d9d; }
.audit .hexes { color: #7f8794; font-family: ui-monospace, Menlo, Consolas, monospace; }
</style>
</head>
<body>
  <h1>Yuki — proposition de thèmes (maquette hors production)</h1>
  <p class="lead">
    Un <b>seul mini-écran factice</b> (barre supérieure, carte + 3 niveaux de surface, bulles
    utilisateur/assistant, bouton d'accent, champ, badges, lien, texte normal/atténué), répété
    <b>à l'identique</b>. Seules les couleurs changent, par variables CSS et <code>data-theme</code>
    (aucun style en ligne). Les valeurs des variantes <b>B</b> sont reprises <b>telles quelles</b>
    des palettes sources (Nord, Gruvbox, Catppuccin, Rosé Pine).
  </p>

  <h2>Démonstration ciblée — « neutre trop teinté » (actuel) vs « neutre légèrement teinté »</h2>
  <p class="lead">
    À gauche, la surface actuelle est fortement dérivée de l'accent : <b>toute la page prend la
    teinte de l'accent</b>. À droite, correction <b>C</b> : <b>même accent</b>, mais surface à
    chroma OKLCH très faible ⇒ le fond redevient quasi neutre et l'accent <b>ressort</b>.
  </p>
  <div class="grid grid--pair">
    ${["actuel-emerald-dark", "C-emerald-dark"].map((k) => mini(k, ACTUEL[k], audits.find((a) => a.key === k))).join("\n")}
  </div>

  <h2>Toutes les variantes</h2>
  <div class="grid">
    ${tiles}
  </div>
</body>
</html>
`;

const OUT = join(import.meta.dirname, "theme-proposal.html");
writeFileSync(OUT, html, "utf8");

/* ─── Rapport stdout ───────────────────────────────────────────────────── */
const pad = (s, n) => String(s).padEnd(n);
console.log("Contrastes WCAG (AA : texte >= 4.5, non-texte/bordure >= 3) :");
console.log(pad("variante", 32), pad("mode", 6), pad("txt/bg", 8), pad("txt/carte", 9), pad("atten/bg", 9), pad("btn/accent", 10), pad("bord/bg", 8), pad("ok/bg", 8), "danger/bg");
for (const a of audits) {
  console.log(
    pad(a.key, 32), pad(a.mode, 6),
    pad(a.textBg.toFixed(2), 8), pad(a.textElev.toFixed(2), 9), pad(a.mutedBg.toFixed(2), 9),
    pad(a.accentBtn.toFixed(2), 10), pad(a.borderBg.toFixed(2), 8), pad(a.okBg.toFixed(2), 8),
    a.dangerBg.toFixed(2),
  );
}
console.log(`\nÉcrit : ${OUT} (${html.length} caractères)`);
