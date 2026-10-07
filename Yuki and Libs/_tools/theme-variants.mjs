#!/usr/bin/env node
/**
 * MAQUETTE JETABLE (hors production) — VARIANTES DE SURFACES pour supprimer
 * l'effet « monotone » signalé après le déploiement V2.
 *
 * Constat utilisateur (après V2) : « c'est lisible, pas de souci, mais c'est
 * quand même encore très monotone ». Deux causes supposées :
 *   (1) LAVIS D'UNE SEULE TEINTE — la page entière (fond, cartes, bulles,
 *       bordures) porte le même chroma : on baigne dans une teinte unique ;
 *   (2) PROFONDEUR FAIBLE — fond de page et bulles d'assistant presque à la
 *       même hauteur ⇒ rien ne se détache.
 *
 * Ce script MESURE d'abord ces deux causes sur les valeurs RÉELLES de
 * `Yuki/public/ui/themes.css` (3 familles montrées par l'utilisateur :
 * Turquoise, Corail, Ambre — les deux modes), puis propose TROIS variantes de
 * surfaces, déclinées pour les 3 familles × 2 modes, et les mesure.
 *
 * ⚠️ AUCUNE production n'est touchée : les accents restent les graines V2
 * VALIDÉES (lues telles quelles dans themes.css), le sujet est la SURFACE
 * (chroma) et la PROFONDEUR (écarts de clarté entre paliers).
 *
 * Variantes :
 *   A — « Neutres désaturés + accent fort » : surfaces quasi neutres (une
 *       TRACE de teinte, chroma ≈ 0,005), accent franc, identité portée par
 *       l'accent (bouton, liens, sélection, états actifs). Clarté de fond
 *       PROPRE À CHAQUE FAMILLE conservée (distinction par la clarté).
 *   B — « Teinte réduite + profondeur accrue » : teinte encore visible mais
 *       deux fois plus discrète qu'en production (chroma ≈ 0,014 au lieu de
 *       0,028), et ÉCARTS DE PROFONDEUR nettement augmentés (pas ≈ 0,066 au
 *       lieu de 0,045).
 *   C — « Neutres purs + accent » : surfaces totalement grises (chroma 0,
 *       rampe NEUTRE UNIQUE partagée par les 3 familles), l'accent fait TOUT
 *       le travail d'identité. Point de comparaison extrême « système de
 *       design classique ».
 *
 * Contraintes :
 *   - HTML AUTONOME : un seul .html, aucune image, aucun <link>, aucun
 *     <script>, aucune URL réseau (immunisé au sandbox d'origine opaque) ;
 *   - thème par `data-theme` + variables CSS (aucun attribut style= en ligne,
 *     esprit CSP `style-src 'self'`) ;
 *   - IDEMPOTENT : deux exécutions ⇒ sortie identique octet pour octet ;
 *   - tout en français.
 *
 * Usage :  node _tools/theme-variants.mjs   (depuis /projects/Yuki)
 * Sortie : _tools/theme-variants.html + rapport de mesures sur stdout.
 *
 * Primitives couleur : ./theme-lib.mjs (aucune dépendance, aucun réseau).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  contrast, hexToRgb, mix, oklch, readableOn, rgbToOklab, toOklch,
} from "./theme-lib.mjs";

/* ═══════════════════════════════════════════════════════════════════════════
 * 0. Seuils (mesurés, jamais affirmés)
 * ═════════════════════════════════════════════════════════════════════════ */

const AA_TEXT = 4.5;      // WCAG 1.4.3 AA — texte
const AA_NONTEXT = 3.0;   // WCAG 1.4.11 — élément non textuel porteur de sens
const JND = 0.020;        // seuil « juste perceptible » en OKLab (ΔEok)

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. Valeurs RÉELLES de production (lues dans themes.css, jamais modifiées)
 * ═════════════════════════════════════════════════════════════════════════ */

const THEMES_CSS = join(import.meta.dirname, "..", "Yuki", "public", "ui", "themes.css");

/** Extrait { --var: hex } d'un bloc `:root[data-theme="<nom>"]`. */
function readPreset(css, name) {
  const re = new RegExp(`:root\\[data-theme="${name}"\\]\\s*\\{([\\s\\S]*?)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`preset « ${name} » introuvable dans themes.css`);
  const out = {};
  for (const line of m[1].split("\n")) {
    const g = line.match(/--([\w-]+):\s*var\([^,]+,\s*(#[0-9a-fA-F]{3,6})\)/);
    if (g) out[g[1]] = g[2].toLowerCase();
  }
  for (const k of ["bg", "panel-2", "panel-3", "panel-hover", "border", "text", "muted", "accent", "user", "assistant", "ok", "danger"]) {
    if (!out[k]) throw new Error(`preset ${name} : variable --${k} absente`);
  }
  return out;
}

const css = readFileSync(THEMES_CSS, "utf8");

/* Les 3 familles montrées par l'utilisateur (captures Turquoise / Corail / Ambre). */
const FAMILIES = [
  { id: "turquoise", label: "Turquoise" },
  { id: "corail", label: "Corail" },
  { id: "ambre", label: "Ambre" },
];
const MODES = ["dark", "light"];
const MODE_FR = { dark: "sombre", light: "clair" };

/** Valeurs de production : PRESET[fam][mode] = { bg, elev, raised, hover, … }. */
const PRESET = {};
for (const f of FAMILIES) {
  PRESET[f.id] = {};
  for (const mode of MODES) {
    const v = readPreset(css, `${f.id}-${mode}`);
    PRESET[f.id][mode] = {
      surface: v.bg, elev: v["panel-2"], raised: v["panel-3"], hover: v["panel-hover"],
      border: v.border, text: v.text, muted: v.muted, accent: v.accent,
      user: v.user, assistant: v.assistant, ok: v.ok, danger: v.danger,
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. Primitives de mesure
 * ═════════════════════════════════════════════════════════════════════════ */

const deltaEok = (a, b) => {
  const A = rgbToOklab(hexToRgb(a)), B = rgbToOklab(hexToRgb(b));
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
};
const dL = (a, b) => toOklch(b).L - toOklch(a).L;

/* Ajuste une graine (ok/danger) par pas de 5 % jusqu'à ≥ 4.5:1 sur la surface. */
function adjust(base, surface, mode) {
  if (contrast(base, surface) >= AA_TEXT) return base;
  for (let a = 0.05; a <= 1.0001; a += 0.05) {
    const c = mode === "light" ? mix(base, "#000000", a) : mix(base, "#ffffff", a);
    if (contrast(c, surface) >= AA_TEXT) return c;
  }
  return base;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. Les trois variantes — fabriques de palettes
 * ═════════════════════════════════════════════════════════════════════════ */

/* Paramètres par variante × mode. `tint` = chroma OKLCH des surfaces ;
 * `steps` = pas de clarté entre paliers successifs (sombre : fond→carte→
 * imbriqué→survol ; clair : carte→imbriqué→survol) ; `uniformL` (C seulement) =
 * clarté d'une rampe neutre UNIQUE partagée par les familles.
 *
 * ⚠️ BORNE DE CONTRASTE : le texte ATTÉNUÉ doit tenir AA (4,5:1) sur LES QUATRE
 * paliers — règle de la garde V2. En mode sombre, cela plafonne la clarté du
 * palier le plus clair (le survol) : au-delà d'environ L 0,42, un `--muted`
 * distinct du texte principal passe sous 4,5:1. La production est DÉJÀ à cette
 * limite (corail sombre : survol 4,52:1). Les rampes ci-dessous respectent donc
 * cette borne : la profondeur gagnée est reportée sur les écarts les plus
 * visibles (fond→carte, fond→bulle), et le survol reste modeste. */
const PARAMS = {
  A: {
    label: "Variante A — Neutres désaturés + accent fort",
    tag: "surfaces quasi neutres (trace de teinte) · accent franc · identité par l'accent",
    dark:  { tint: 0.005, steps: [0.050, 0.040, 0.030], uniformL: null },
    light: { tint: 0.006, steps: [0.038, 0.030], uniformL: null },
  },
  B: {
    label: "Variante B — Teinte réduite + profondeur accrue",
    tag: "teinte visible mais 2× plus discrète · écarts de profondeur augmentés",
    dark:  { tint: 0.014, steps: [0.058, 0.045, 0.029], uniformL: null },
    light: { tint: 0.016, steps: [0.052, 0.040], uniformL: null },
  },
  C: {
    label: "Variante C — Neutres purs + accent",
    tag: "surfaces totalement grises (chroma 0) · rampe neutre unique · l'accent fait tout",
    dark:  { tint: 0.000, steps: [0.062, 0.048, 0.030], uniformL: 0.205 },
    light: { tint: 0.000, steps: [0.046, 0.038], uniformL: 0.950 },
  },
};
const VARIANT_IDS = ["A", "B", "C"];

/**
 * Palette d'une variante pour une famille × un mode.
 * L'accent est la graine V2 de production, INCHANGÉE. Seules les surfaces sont
 * recalculées (chroma + profondeur). La clarté de fond est celle de la famille
 * (sauf C qui partage une rampe neutre unique).
 */
function variantPalette(variantId, fam, mode) {
  const p = PARAMS[variantId][mode];
  const cur = PRESET[fam.id][mode];
  const accent = cur.accent;                    // graine V2 validée — jamais touchée
  const H = toOklch(accent).H;
  const familyL = toOklch(cur.surface).L;
  const onAccent = readableOn(accent);

  if (mode === "dark") {
    const L = p.uniformL != null ? p.uniformL : familyL;
    const [s1, s2, s3] = p.steps;
    const surface = oklch(L, p.tint, H);
    return {
      surface,
      elev: oklch(L + s1, p.tint + 0.001, H),
      raised: oklch(L + s1 + s2, p.tint + 0.002, H),
      hover: oklch(L + s1 + s2 + s3, p.tint + 0.003, H),
      border: oklch(L + s1 + s2 + s3 + 0.065, p.tint + 0.005, H),
      text: oklch(0.960, 0.006, H),
      muted: oklch(0.800, 0.010, H),
      accent, onAccent,
      // Bulle d'assistant : détachée de la page (≈ niveau carte) — c'est le
      // correctif du défaut « bulle quasi à la hauteur du fond ».
      assistant: oklch(L + s1, p.tint + 0.006, H),
      user: mix(surface, accent, 0.18),
      ok: adjust("#4cc38a", surface, "dark"),
      danger: adjust("#f87171", surface, "dark"),
    };
  }
  // Mode clair : la page est légèrement teintée, la carte (elev) reste blanche
  // et « pop » dessus ; le bloc imbriqué et le survol redescendent.
  const L = p.uniformL != null ? p.uniformL : familyL;
  const [e1, e2] = p.steps;
  const surface = oklch(L, p.tint, H);
  return {
    surface,
    elev: "#ffffff",
    raised: oklch(L - e1, p.tint + 0.001, H),
    hover: oklch(L - e1 - e2, p.tint + 0.002, H),
    border: oklch(L - e1 - e2 - 0.055, p.tint + 0.005, H),
    text: oklch(0.265, 0.014, H),
    muted: oklch(0.380, 0.018, H),
    accent, onAccent,
    assistant: oklch(0.992, p.tint * 0.4, H),
    user: mix(surface, accent, 0.18),
    ok: adjust("#317f5a", surface, "light"),
    danger: adjust("#dc2626", surface, "light"),
  };
}

/* Une entrée par (variante × famille × mode). */
const THEMES = [];
for (const vid of VARIANT_IDS) {
  for (const f of FAMILIES) {
    for (const mode of MODES) {
      THEMES.push({
        id: `v${vid}-${f.id}-${mode}`,
        variant: vid, family: f.id, familyLabel: f.label, mode,
        colors: variantPalette(vid, f, mode),
      });
    }
  }
}
const THEME = Object.fromEntries(THEMES.map((t) => [t.id, t]));

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. Mesure — AVANT (production) : quantifier la monotonie
 * ═════════════════════════════════════════════════════════════════════════ */

const DEPTH_STEPS = [
  ["fond→carte", "surface", "elev"],
  ["carte→imbriqué", "elev", "raised"],
  ["imbriqué→survol", "raised", "hover"],
];

/** Métriques d'un jeu de couleurs (production ou variante). */
function measure(c) {
  const chromas = ["surface", "elev", "raised", "hover"].map((k) => toOklch(c[k]).C);
  return {
    textBg: contrast(c.text, c.surface),
    mutedBg: contrast(c.muted, c.surface),
    textElev: contrast(c.text, c.elev),
    mutedElev: contrast(c.muted, c.elev),
    mutedRaised: contrast(c.muted, c.raised),
    mutedHover: contrast(c.muted, c.hover),
    onAccent: contrast(c.onAccent ?? readableOn(c.accent), c.accent),
    accentSurface: contrast(c.accent, c.surface),
    okBg: contrast(c.ok, c.surface),
    dangerBg: contrast(c.danger, c.surface),
    depth: DEPTH_STEPS.map(([name, ka, kb]) => ({
      name, dE: deltaEok(c[ka], c[kb]), dL: dL(c[ka], c[kb]),
    })),
    depthMin: Math.min(...DEPTH_STEPS.map(([, ka, kb]) => deltaEok(c[ka], c[kb]))),
    chroma: { surface: chromas[0], elev: chromas[1], raised: chromas[2], hover: chromas[3], spread: Math.max(...chromas) - Math.min(...chromas) },
    assistantOnSurface: deltaEok(c.assistant, c.surface),
    userOnSurface: deltaEok(c.user, c.surface),
  };
}

const PROD_MEASURE = [];
for (const f of FAMILIES) {
  for (const mode of MODES) {
    const c = PRESET[f.id][mode];
    PROD_MEASURE.push({ family: f.id, familyLabel: f.label, mode, colors: c, m: measure(c) });
  }
}
const VARIANT_MEASURE = THEMES.map((t) => ({ ...t, m: measure(t.colors) }));

/** Écarts entre familles (mêmes mode & variante) sur le fond et l'accent. */
function accentSeparation(rows) {
  let minAcc = Infinity, minAccPair = "";
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const d = deltaEok(rows[i].colors.accent, rows[j].colors.accent);
      if (d < minAcc) { minAcc = d; minAccPair = `${rows[i].familyLabel}↔${rows[j].familyLabel}`; }
    }
  }
  return { minAcc, minAccPair };
}

/* Verdict de lisibilité d'une variante (tous thèmes confondus). */
function verdict(rows) {
  const fails = [];
  for (const r of rows) {
    const m = r.m;
    if (m.textBg < AA_TEXT) fails.push(`${r.familyLabel}-${MODE_FR[r.mode]} texte/fond ${m.textBg.toFixed(2)}`);
    if (m.mutedBg < AA_TEXT) fails.push(`${r.familyLabel}-${MODE_FR[r.mode]} atténué/fond ${m.mutedBg.toFixed(2)}`);
    if (m.mutedElev < AA_TEXT) fails.push(`${r.familyLabel}-${MODE_FR[r.mode]} atténué/carte ${m.mutedElev.toFixed(2)}`);
    if (m.mutedRaised < AA_TEXT) fails.push(`${r.familyLabel}-${MODE_FR[r.mode]} atténué/imbriqué ${m.mutedRaised.toFixed(2)}`);
    if (m.mutedHover < AA_TEXT) fails.push(`${r.familyLabel}-${MODE_FR[r.mode]} atténué/survol ${m.mutedHover.toFixed(2)}`);
    if (m.onAccent < AA_TEXT) fails.push(`${r.familyLabel}-${MODE_FR[r.mode]} texte/accent ${m.onAccent.toFixed(2)}`);
    if (m.accentSurface < AA_TEXT) fails.push(`${r.familyLabel}-${MODE_FR[r.mode]} accent/fond ${m.accentSurface.toFixed(2)}`);
    for (const d of m.depth) if (d.dE < JND) fails.push(`${r.familyLabel}-${MODE_FR[r.mode]} profondeur ${d.name} ΔEok ${d.dE.toFixed(3)}`);
  }
  return fails;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. Rendu HTML autonome
 * ═════════════════════════════════════════════════════════════════════════ */

const VARS = [
  ["--surface", "surface"], ["--elev", "elev"], ["--raised", "raised"], ["--hover", "hover"],
  ["--border", "border"], ["--text", "text"], ["--muted", "muted"],
  ["--accent", "accent"], ["--on-accent", "onAccent"], ["--danger", "danger"], ["--ok", "ok"],
  ["--user", "user"], ["--assistant", "assistant"],
];

const varsRule = (t) => [
  `[data-theme="${t.id}"] {`,
  `  color-scheme: ${t.mode};`,
  ...VARS.map(([cssVar, key]) => `  ${cssVar}: ${t.colors[key]};`),
  `}`,
].join("\n");

const styleVars = THEMES.map(varsRule).join("\n");

/** Variables pour la référence de production (famille × mode). */
const prodVarsRule = (f, mode) => {
  const c = PRESET[f.id][mode];
  const map = { surface: c.surface, elev: c.elev, raised: c.raised, hover: c.hover, border: c.border, text: c.text, muted: c.muted, accent: c.accent, onAccent: readableOn(c.accent), danger: c.danger, ok: c.ok, user: c.user, assistant: c.assistant };
  return [
    `[data-theme="p-${f.id}-${mode}"] {`,
    `  color-scheme: ${mode};`,
    ...VARS.map(([cssVar, key]) => `  ${cssVar}: ${map[key]};`),
    `}`,
  ].join("\n");
};
const prodStyleVars = FAMILIES.flatMap((f) => MODES.map((m) => prodVarsRule(f, m))).join("\n");

/**
 * L'écran réaliste — MARKUP IDENTIQUE pour tous les thèmes ; seules les
 * variables CSS changent. Reprend la barre de l'UI réelle (Yuki / onglets
 * Chat-Configuration-Voix / connecté / idle / sélecteur de thème / bascule) et
 * un fil de conversation avec bulles, bloc de code, tableau, liste, états
 * interactifs.
 */
function screen(themeId, familyLabel) {
  return `
    <div class="screen" data-theme="${themeId}">
      <div class="app">
        <header class="topbar">
          <span class="brand">Yuki</span>
          <nav class="tabs">
            <span class="tab tab--active">Chat</span>
            <span class="tab">Configuration</span>
            <span class="tab">Voix</span>
          </nav>
          <span class="status">
            <span class="pill">connecté</span>
            <span class="pill">idle</span>
            <span class="select">${familyLabel} ▾</span>
            <span class="iconbtn" title="mode">☾</span>
          </span>
        </header>
        <main class="conversation">
          <div class="msg msg--user"><p>Explique-moi le calcul des paliers de profondeur.</p></div>
          <div class="msg msg--assistant">
            <p>Chaque palier est une clarté OKLCH distincte ; on mesure l'écart en ΔEok.</p>
            <pre class="code"><code>const d = deltaEok(surface, elev);
// seuil juste-perceptible : 0.020</code></pre>
            <table class="md-table">
              <thead><tr><th>Palier</th><th>Rôle</th></tr></thead>
              <tbody>
                <tr><td>surface</td><td>fond de page</td></tr>
                <tr><td>elev</td><td>carte</td></tr>
                <tr><td>raised</td><td>bloc imbriqué</td></tr>
              </tbody>
            </table>
            <ul class="md-list"><li>Réduire le chroma des surfaces</li><li>Augmenter les écarts de clarté</li></ul>
            <div class="msg-actions">
              <span class="link">copier</span>
              <span class="chip chip--hover">survol</span>
              <span class="chip chip--sel">sélection</span>
              <button class="button" type="button">Continuer</button>
            </div>
          </div>
          <div class="card">
            <div class="card__head"><b>Réglages rapides</b><span class="badge badge--ok">à jour</span></div>
            <div class="kv">
              <span class="row row--sel">Modèle <b>mistral</b></span>
              <span class="row">Voix <b>fr-FR</b></span>
              <span class="row row--hover">Langue <b>Français</b></span>
            </div>
          </div>
        </main>
        <footer class="composer">
          <span class="field">Écrivez un message…</span>
          <button class="button" type="button">Envoyer</button>
          <button class="button button--stop" type="button">Stop</button>
        </footer>
      </div>
    </div>`;
}

const num = (v, n = 2) => v.toFixed(n);
const cls = (v, min) => (v >= min ? "ok" : "ko");

/** Carte d'audit sous un écran. */
function auditLine(m) {
  const dmin = m.depthMin;
  return `<div class="audit">
    <span>texte/fond <b class="${cls(m.textBg, AA_TEXT)}">${num(m.textBg)}:1</b></span>
    <span>atténué/fond <b class="${cls(m.mutedBg, AA_TEXT)}">${num(m.mutedBg)}:1</b></span>
    <span>texte/accent <b class="${cls(m.onAccent, AA_TEXT)}">${num(m.onAccent)}:1</b></span>
    <span>accent/fond <b class="${cls(m.accentSurface, AA_TEXT)}">${num(m.accentSurface)}:1</b></span>
    <span>profondeur min <b class="${cls(dmin, JND)}">Δ ${num(dmin, 3)}</b></span>
    <span>chroma fond <b>${num(m.chroma.surface, 3)}</b></span>
  </div>`;
}

/** Écran + légende + audit, pour un thème donné. */
function screenCard(t, caption) {
  return `
  <figure class="fig">
    <figcaption class="fig__cap">
      <span class="fig__name">${caption}</span>
      <span class="fig__hex">fond ${t.colors.surface} · carte ${t.colors.elev} · accent ${t.colors.accent}</span>
    </figcaption>
    ${screen(t.id, t.familyLabel)}
    ${auditLine(t.m ?? measure(t.colors))}
  </figure>`;
}

/** Écran de production (référence AVANT). */
function prodScreenCard(f, mode) {
  const c = PRESET[f.id][mode];
  const t = { id: `p-${f.id}-${mode}`, familyLabel: f.label, colors: c, m: measure(c) };
  return screenCard(t, `${f.label} · ${MODE_FR[mode]} — PRODUCTION`);
}

/* Matrice de mesure : une ligne par (famille × mode) d'une variante. */
function matrixRows(rows) {
  return rows.map((r) => {
    const m = r.m;
    return `<tr>
      <th scope="row">${r.familyLabel}</th>
      <td>${MODE_FR[r.mode]}</td>
      <td><span class="sw" data-theme="${r.id}"></span></td>
      <td class="${cls(m.textBg, AA_TEXT)}">${num(m.textBg)}:1</td>
      <td class="${cls(m.mutedBg, AA_TEXT)}">${num(m.mutedBg)}:1</td>
      <td class="${cls(m.onAccent, AA_TEXT)}">${num(m.onAccent)}:1</td>
      <td class="${cls(m.accentSurface, AA_TEXT)}">${num(m.accentSurface)}:1</td>
      <td class="${cls(m.depthMin, JND)}">Δ ${num(m.depthMin, 3)}</td>
      <td>${num(m.chroma.surface, 3)}</td>
      <td>${num(m.chroma.spread, 3)}</td>
    </tr>`;
  }).join("");
}

function matrix(rows) {
  return `<table class="mt">
    <thead><tr>
      <th>Famille</th><th>Mode</th><th>Fond</th>
      <th>texte/fond</th><th>atténué/fond</th><th>texte/accent</th><th>accent/fond</th>
      <th>profondeur min</th><th>chroma fond</th><th>écart chroma</th>
    </tr></thead>
    <tbody>${matrixRows(rows)}</tbody>
  </table>`;
}

/* Section d'une variante : 2 modes × 3 familles + matrice. */
function variantSection(vid) {
  const rows = VARIANT_MEASURE.filter((r) => r.variant === vid);
  const fails = verdict(rows);
  const sepDark = accentSeparation(rows.filter((r) => r.mode === "dark"));
  const sepLight = accentSeparation(rows.filter((r) => r.mode === "light"));
  const badge = fails.length === 0
    ? `<span class="badge-pass">lisibilité OK</span>`
    : `<span class="badge-fail">${fails.length} point(s) sous seuil</span>`;
  const modeBlock = (mode) => `
    <div class="mode-block">
      <h4 class="mode-title">${MODE_FR[mode] === "sombre" ? "Mode sombre" : "Mode clair"}</h4>
      <div class="screens">
        ${FAMILIES.map((f) => screenCard(THEME[`v${vid}-${f.id}-${mode}`], f.label)).join("")}
      </div>
    </div>`;
  return `
  <section class="vblock" id="variante-${vid}">
    <div class="vhead">
      <h3>${PARAMS[vid].label}</h3>
      ${badge}
      <span class="vtag">${PARAMS[vid].tag}</span>
    </div>
    <p class="vnote">
      Paramètres mesurés — surfaces : chroma ${num(PARAMS[vid].dark.tint, 3)} (sombre) /
      ${num(PARAMS[vid].light.tint, 3)} (clair) ; pas de profondeur
      ${PARAMS[vid].dark.steps.map((s) => num(s, 3)).join(" · ")} (sombre) /
      ${PARAMS[vid].light.steps.map((s) => num(s, 3)).join(" · ")} (clair). Écart d'accent entre familles : min
      <b>${num(sepDark.minAcc, 3)}</b> (sombre, ${sepDark.minAccPair}) · <b>${num(sepLight.minAcc, 3)}</b> (clair).
    </p>
    ${modeBlock("dark")}
    ${modeBlock("light")}
    <h4 class="mode-title">Mesure par famille × mode</h4>
    ${matrix(rows)}
    ${fails.length ? `<p class="fail-list"><b>Points sous seuil :</b> ${fails.join(" · ")}</p>` : ""}
  </section>`;
}

/* Bloc « AVANT » : production, + tableau de monotonie. */
function beforeBlock() {
  const rows = PROD_MEASURE;
  const mode = "dark";
  return `
  <section class="vblock vblock--before" id="avant-prod">
    <div class="vhead">
      <h3>Référence — thèmes EN PRODUCTION (V2)</h3>
      <span class="badge-fail">monotone (signalé)</span>
      <span class="vtag">ce que l'utilisateur voit aujourd'hui</span>
    </div>
    <p class="vnote">
      Valeurs lues dans <code>Yuki/public/ui/themes.css</code> (jamais modifiées). Les accents
      sont les graines V2 validées, conservées telles quelles dans toutes les variantes.
    </p>
    <div class="mode-block">
      <h4 class="mode-title">Mode sombre</h4>
      <div class="screens">${FAMILIES.map((f) => prodScreenCard(f, "dark")).join("")}</div>
    </div>
    <div class="mode-block">
      <h4 class="mode-title">Mode clair</h4>
      <div class="screens">${FAMILIES.map((f) => prodScreenCard(f, "light")).join("")}</div>
    </div>
    <h4 class="mode-title">Mesure par famille × mode</h4>
    ${matrix(rows.map((r) => ({ ...r, id: `p-${r.family}-${r.mode}` })))}
  </section>`;
}

/* Tableau « quantification de la monotonie » (mode sombre, production). */
function monotonyTable() {
  const rows = PROD_MEASURE.filter((r) => r.mode === "dark").map((r) => {
    const c = r.colors, m = r.m;
    const surfC = toOklch(c.surface).C;
    return `<tr>
      <th scope="row">${r.familyLabel}</th>
      <td><span class="sw" data-theme="p-${r.family}-dark"></span> ${c.surface}</td>
      <td>${num(surfC, 3)}</td>
      <td>${num(m.chroma.surface, 3)} / ${num(m.chroma.hover, 3)}</td>
      <td>${num(m.chroma.spread, 3)}</td>
      <td>${m.depth.map((d) => `${num(d.dL, 3)} (ΔEok ${num(d.dE, 3)})`).join(" · ")}</td>
      <td class="${cls(m.assistantOnSurface, JND)}">Δ ${num(m.assistantOnSurface, 3)}</td>
    </tr>`;
  }).join("");
  return `<table class="mt" id="monotonie">
    <thead><tr>
      <th>Famille (sombre)</th><th>Fond</th><th>chroma OKLCH du fond</th>
      <th>chroma paliers (fond → survol)</th><th>écart de chroma</th>
      <th>ΔL des paliers (fond→carte→imbriqué→survol)</th>
      <th>écart bulle assistant / fond</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Yuki — variantes de surfaces contre la monotonie (maquette hors production)</title>
<style>
/* ═══ Page de la maquette (neutre, sans couleur de marque) ═════════════════ */
* { box-sizing: border-box; }
body {
  margin: 0; padding: 28px 30px 90px; max-width: 2340px;
  background: #101216; color: #e7eaf0;
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
h1 { font-size: 23px; margin: 0 0 8px; }
h2 { font-size: 18px; margin: 44px 0 12px; border-top: 1px solid #2b2f36; padding-top: 22px; }
h4.mode-title { font-size: 12px; text-transform: uppercase; letter-spacing: .07em; color: #8b93a1; margin: 16px 0 8px; }
p.lead { color: #a4acba; max-width: 120ch; margin: 8px 0 0; }
p.lead b { color: #e7eaf0; }
code { background: #22262d; border: 1px solid #2f3540; border-radius: 4px; padding: 0 4px;
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .85em; }
.note { color: #8b93a1; font-size: 12.5px; }

/* Sommaire. */
nav.toc { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 0; }
nav.toc a { color: #cfd6e2; text-decoration: none; border: 1px solid #2f3540; border-radius: 999px;
  padding: 5px 12px; font-size: 12.5px; background: #191c21; }
nav.toc a:hover { border-color: #4a5364; }

/* Bandeau « principe ». */
.principe { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; margin-top: 16px; }
.principe > div { border: 1px solid #2b2f36; border-radius: 12px; padding: 13px 15px; background: #191c21; }
.principe h3 { margin: 0 0 6px; font-size: 14px; }
.principe p { margin: 6px 0 0; color: #a4acba; }
.principe b { color: #e7eaf0; }

/* ═══ Variables de thème par data-theme — aucun style inline ═════════════ */
${styleVars}
${prodStyleVars}

/* ═══ L'écran — mêmes règles pour TOUS les thèmes ═════════════════════════ */
.fig { margin: 0; border: 1px solid #2b2f36; border-radius: 14px; padding: 11px; background: #191c21; }
.fig__cap { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 9px; }
.fig__name { font-weight: 700; font-size: 13.5px; }
.fig__hex { color: #7f8794; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; margin-left: auto; }

.screen { border-radius: 11px; overflow: hidden; border: 1px solid var(--border); }
.app { display: flex; flex-direction: column; background: var(--surface); color: var(--text); font-size: 13px; }

/* Barre du haut : marque · onglets (dont actif) · état · sélecteur · bascule. */
.topbar { display: flex; align-items: center; gap: 12px; padding: 9px 13px;
  background: var(--surface); border-bottom: 1px solid var(--border); }
.brand { font-weight: 800; letter-spacing: .02em; }
.tabs { display: flex; gap: 4px; }
.tab { font-size: 12px; padding: 4px 10px; border-radius: 7px; color: var(--muted); }
.tab--active { color: var(--accent); background: var(--elev); border-bottom: 2px solid var(--accent); border-radius: 7px 7px 0 0; }
.status { display: flex; gap: 6px; align-items: center; margin-left: auto; }
.pill { font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--border);
  background: var(--elev); color: var(--muted); }
.select { font-size: 11.5px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--border);
  background: var(--elev); color: var(--text); }
.iconbtn { width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%; border: 1px solid var(--border); background: var(--elev); color: var(--accent); font-size: 12px; }

/* Conversation. */
.conversation { display: flex; flex-direction: column; gap: 10px; padding: 13px; background: var(--surface); }
.msg { max-width: 90%; padding: 9px 12px; border-radius: 12px; border: 1px solid var(--border); }
.msg p { margin: 0 0 6px; }
.msg--user { align-self: flex-end; background: var(--user); }
.msg--assistant { align-self: flex-start; background: var(--assistant); }

.code { margin: 8px 0; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--border);
  background: var(--raised); color: var(--text); overflow: auto;
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; line-height: 1.5; }
.code code { background: transparent; border: none; padding: 0; font-size: inherit; }

.md-table { border-collapse: collapse; margin: 8px 0; width: 100%; font-size: 12px; }
.md-table th, .md-table td { border: 1px solid var(--border); padding: 4px 9px; text-align: left; }
.md-table thead th { background: var(--raised); color: var(--muted); font-weight: 600; }

.md-list { margin: 8px 0; padding-left: 18px; color: var(--muted); }
.md-list li { margin: 2px 0; }

.msg-actions { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; margin-top: 8px; }
.link { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.chip { font-size: 11px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border); }
.chip--hover { background: var(--hover); }
.chip--sel { background: color-mix(in srgb, var(--accent) 22%, var(--elev)); border-color: var(--accent); color: var(--accent); }
.button { padding: 8px 15px; border-radius: 9px; border: 1px solid var(--border);
  background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; cursor: pointer; }
.button--stop { background: transparent; color: var(--danger); border-color: color-mix(in srgb, var(--danger) 50%, var(--border)); }

/* Carte de réglages (niveau carte) avec rangées sélectionnée / survolée. */
.card { background: var(--elev); border: 1px solid var(--border); border-radius: 11px; padding: 11px 13px; }
.card__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.badge { font-size: 10.5px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border); }
.badge--ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
.kv { display: flex; flex-direction: column; gap: 4px; }
.row { display: flex; justify-content: space-between; padding: 5px 9px; border-radius: 7px;
  border: 1px solid transparent; color: var(--muted); }
.row b { color: var(--text); }
.row--sel { background: color-mix(in srgb, var(--accent) 20%, var(--elev)); border-color: var(--accent); }
.row--sel b { color: var(--accent); }
.row--hover { background: var(--hover); }

/* Zone de saisie. */
.composer { display: flex; gap: 8px; align-items: center; padding: 11px 13px;
  background: var(--surface); border-top: 1px solid var(--border); }
.field { flex: 1; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--border);
  background: var(--elev); color: var(--muted); }

/* Audit sous chaque écran. */
.audit { display: flex; flex-wrap: wrap; gap: 5px 13px; margin-top: 9px; font-size: 11px; color: #9aa2af; }
.audit b.ok { color: #7fd6a3; }
.audit b.ko { color: #ff9d9d; }

/* Grilles. */
.screens { display: grid; grid-template-columns: repeat(auto-fit, minmax(430px, 1fr)); gap: 18px; margin-top: 8px; align-items: start; }
.mode-block { margin-top: 8px; }

/* Bloc de variante. */
.vblock { border: 1px solid #2b2f36; border-radius: 14px; padding: 15px 17px; margin-top: 18px; background: #16191e; }
.vblock--before { border-color: #4a3a2b; background: #1b1712; }
.vhead { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.vhead h3 { margin: 0; font-size: 17px; }
.vtag { color: #8b93a1; font-size: 12.5px; }
.badge-pass { font-size: 11px; font-weight: 700; color: #0b0b12; background: #7fd6a3; border-radius: 999px; padding: 1px 9px; }
.badge-fail { font-size: 11px; font-weight: 700; color: #101014; background: #ffb4b4; border-radius: 999px; padding: 1px 9px; }
.vnote { color: #a4acba; margin: 9px 0 6px; max-width: 160ch; }
.vnote b { color: #e7eaf0; }
.fail-list { color: #ffb4b4; font-size: 12.5px; margin: 8px 0 0; }

/* Tableaux de mesure. */
.mt { border-collapse: collapse; margin: 8px 0 4px; font-size: 12px; width: 100%; }
.mt th, .mt td { border: 1px solid #2f3540; padding: 4px 9px; text-align: left; }
.mt thead th { color: #8b93a1; font-weight: 600; background: #191c21; }
.mt tbody th { color: #c3cad6; font-weight: 500; }
.mt td.ok { color: #7fd6a3; }
.mt td.ko { color: #ff9d9d; }
.sw { display: inline-block; width: 30px; height: 16px; border-radius: 5px; border: 1px solid #3a4150;
  background: var(--surface); vertical-align: middle; box-shadow: inset 0 0 0 8px var(--elev); }

footer { margin-top: 46px; border-top: 1px solid #2b2f36; padding-top: 16px; color: #8b93a1; font-size: 12.5px; }
</style>
</head>
<body>
  <h1>Yuki — variantes de surfaces contre l'effet « monotone »</h1>
  <p class="lead">
    Maquette <b>hors production</b>, pour <b>choisir sur le visuel</b>. Trois variantes de
    <b>surfaces</b> (chroma + profondeur de clarté) sont déclinées pour les <b>3 familles</b>
    montrées dans les captures (<b>Turquoise, Corail, Ambre</b>) × <b>2 modes</b>, sur le
    <b>même écran réaliste</b>. Les <b>accents</b> restent les graines <b>V2 validées</b> lues
    dans <code>themes.css</code> : le sujet est la <b>surface</b> et la <b>profondeur</b>, pas
    la couleur d'accent. HTML <b>autonome</b> (ni image, ni script, ni ressource externe).
  </p>

  <nav class="toc">
    <a href="#avant">1 · Mesure de la monotonie (AVANT)</a>
    <a href="#variante-A">2 · Variante A</a>
    <a href="#variante-B">3 · Variante B</a>
    <a href="#variante-C">4 · Variante C</a>
    <a href="#comparaison">5 · Comparaison côte à côte</a>
  </nav>

  <div class="principe">
    <div>
      <h3>Le diagnostic, chiffré</h3>
      <p>Deux causes : <b>lavis d'une teinte</b> (le chroma des surfaces reste quasi constant
      d'un palier à l'autre — l'écart de chroma interne est minuscule) et <b>profondeur</b>
      (écarts de clarté entre paliers et entre la page et la bulle d'assistant).</p>
    </div>
    <div>
      <h3>Ce que les variantes changent</h3>
      <p><b>A</b> : surfaces quasi neutres (trace de teinte), accent fort.
      <b>B</b> : teinte plus discrète + profondeur nettement accrue.
      <b>C</b> : surfaces totalement grises, l'accent fait tout. La <b>clarté de fond propre à
      chaque famille</b> est conservée en A et B ; C partage une rampe neutre unique.</p>
    </div>
    <div>
      <h3>Seuils de lecture</h3>
      <p>Texte et texte atténué ≥ <b>${AA_TEXT}:1</b> ; texte sur accent ≥ <b>${AA_TEXT}:1</b> ;
      élément non textuel ≥ <b>${AA_NONTEXT}:1</b> ; écart de profondeur ≥ <b>${JND}</b> (ΔEok,
      seuil juste-perceptible). Vert = conforme, rouge = sous le seuil.</p>
    </div>
    <div>
      <h3>Hors périmètre — famille « Matrix »</h3>
      <p>La famille d'identité <code>matrix</code> (accent néon vert, surfaces <b>monochromes</b>) n'est
      <b>pas</b> traitée dans ces variantes : ses surfaces ne sont pas teintées vers l'accent, elle
      échappe donc à la doctrine V2. Aucune de ses valeurs n'est ni dérivée ni modifiée ici.</p>
    </div>
  </div>

  <h2 id="avant">1 · Mesure de la monotonie — thèmes EN PRODUCTION (AVANT)</h2>
  <p class="lead">
    Valeurs <b>réelles</b> de <code>Yuki/public/ui/themes.css</code> (mode sombre), lues sans
    aucune modification. Le <b>chroma OKLCH du fond</b> et sa <b>variation entre paliers</b>
    quantifient le lavis ; le <b>ΔL</b> entre paliers et l'<b>écart bulle/fond</b> quantifient
    la profondeur.
  </p>
  ${monotonyTable()}
  ${beforeBlock()}

  <h2>2 · Variante A — Neutres désaturés + accent fort</h2>
  ${variantSection("A")}

  <h2>3 · Variante B — Teinte réduite + profondeur accrue</h2>
  ${variantSection("B")}

  <h2>4 · Variante C — Neutres purs + accent</h2>
  ${variantSection("C")}

  <h2 id="comparaison">5 · Comparaison côte à côte — Turquoise, mode sombre</h2>
  <p class="lead">Même écran, mêmes accents : seule la <b>surface</b> change. De gauche à droite :
  production, puis A, B, C.</p>
  <div class="screens" id="comparaison-turquoise-dark">
    ${prodScreenCard(FAMILIES[0], "dark")}
    ${["A", "B", "C"].map((v) => screenCard(THEME[`v${v}-turquoise-dark`], `Variante ${v}`)).join("")}
  </div>
  <h2>5bis · Comparaison côte à côte — Corail et Ambre, mode sombre</h2>
  <div class="screens" id="comparaison-corail-dark">
    ${prodScreenCard(FAMILIES[1], "dark")}
    ${["A", "B", "C"].map((v) => screenCard(THEME[`v${v}-corail-dark`], `Variante ${v}`)).join("")}
  </div>
  <div class="screens" id="comparaison-ambre-dark">
    ${prodScreenCard(FAMILIES[2], "dark")}
    ${["A", "B", "C"].map((v) => screenCard(THEME[`v${v}-ambre-dark`], `Variante ${v}`)).join("")}
  </div>
  <h2>5ter · Comparaison côte à côte — Turquoise, mode clair</h2>
  <div class="screens" id="comparaison-turquoise-light">
    ${prodScreenCard(FAMILIES[0], "light")}
    ${["A", "B", "C"].map((v) => screenCard(THEME[`v${v}-turquoise-light`], `Variante ${v}`)).join("")}
  </div>

  <footer>
    Maquette de décision — <b>aucune</b> modification de production (ni <code>themes.css</code>,
    ni <code>generate-yuki-themes.mjs</code>, ni <code>theme.js</code>, ni <code>holaf-lib</code>).
    Générée par <code>_tools/theme-variants.mjs</code> ; primitives de
    <code>_tools/theme-lib.mjs</code>. Fichier autonome : ni image, ni
    <code>&lt;link&gt;</code>, ni <code>&lt;script&gt;</code>, ni URL réseau.
    Les valeurs de production sont <b>lues</b> dans <code>themes.css</code>, jamais écrites.
  </footer>
</body>
</html>
`;

const OUT = join(import.meta.dirname, "theme-variants.html");
writeFileSync(OUT, html, "utf8");

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. Rapport stdout
 * ═════════════════════════════════════════════════════════════════════════ */

const pad = (s, n) => String(s).padEnd(n);
const f2 = (v) => v.toFixed(2).padStart(6);
const f3 = (v) => v.toFixed(3).padStart(6);

console.log("═".repeat(96));
console.log("MESURE DE LA MONOTONIE — thèmes EN PRODUCTION (themes.css), mode sombre");
console.log("═".repeat(96));
console.log(pad("famille", 11), pad("fond", 9), "chroma", "chroma paliers (fond→survol)", "écart", "ΔL paliers", "bulle/fond");
for (const r of PROD_MEASURE.filter((x) => x.mode === "dark")) {
  const c = r.colors, m = r.m;
  console.log(
    pad(r.familyLabel, 11), pad(c.surface, 9),
    f3(m.chroma.surface),
    "  " + f3(m.chroma.surface) + "→" + f3(m.chroma.hover),
    " " + f3(m.chroma.spread),
    "  " + m.depth.map((d) => f3(d.dL)).join(" · "),
    f3(m.assistantOnSurface),
  );
}
console.log(`\nChromas OKLCH des 4 paliers (fond·carte·imbriqué·survol), mode sombre :`);
for (const r of PROD_MEASURE.filter((x) => x.mode === "dark")) {
  const m = r.m;
  console.log(`  ${pad(r.familyLabel, 11)} ${f3(m.chroma.surface)} · ${f3(m.chroma.elev)} · ${f3(m.chroma.raised)} · ${f3(m.chroma.hover)}   (écart ${f3(m.chroma.spread)})`);
}
console.log(`\nΔEok des paliers (fond→carte→imbriqué→survol), mode sombre :`);
for (const r of PROD_MEASURE.filter((x) => x.mode === "dark")) {
  console.log(`  ${pad(r.familyLabel, 11)} ${r.m.depth.map((d) => f3(d.dE)).join(" · ")}   (min ${f3(r.m.depthMin)})`);
}

console.log("\n" + "═".repeat(96));
console.log("CONTRASTES PRODUCTION (référence)");
console.log("═".repeat(96));
console.log(pad("famille", 11), pad("mode", 6), "txt/fond", "att/fond", "txt/accent", "accent/fond", "ok/fond", "danger/fond");
for (const r of PROD_MEASURE) {
  const m = r.m;
  console.log(pad(r.familyLabel, 11), pad(r.mode, 6), f2(m.textBg), f2(m.mutedBg), f2(m.onAccent), f2(m.accentSurface), f2(m.okBg), f2(m.dangerBg));
}

for (const vid of VARIANT_IDS) {
  const rows = VARIANT_MEASURE.filter((r) => r.variant === vid);
  const fails = verdict(rows);
  console.log("\n" + "═".repeat(96));
  console.log(`${PARAMS[vid].label}`);
  console.log(`surfaces : chroma ${PARAMS[vid].dark.tint}/${PARAMS[vid].light.tint} · pas ${PARAMS[vid].dark.steps.join("/")} (sombre) · ${PARAMS[vid].light.steps.join("/")} (clair)`);
  console.log("═".repeat(96));
  console.log(pad("famille", 11), pad("mode", 6), "txt/fond", "att/fond", "att/carte", "txt/accent", "acc/fond", "prof.min", "chroma", "verdict");
  for (const r of rows) {
    const m = r.m;
    const bad = m.textBg < AA_TEXT || m.mutedBg < AA_TEXT || m.mutedElev < AA_TEXT || m.onAccent < AA_TEXT || m.accentSurface < AA_TEXT || m.depthMin < JND;
    console.log(
      pad(r.familyLabel, 11), pad(MODE_FR[r.mode], 6),
      f2(m.textBg), f2(m.mutedBg), f2(m.mutedElev), f2(m.onAccent), f2(m.accentSurface), f3(m.depthMin), f3(m.chroma.surface),
      bad ? "  KO" : "  OK",
    );
  }
  console.log("Profondeur (ΔEok) — détails :");
  for (const r of rows) {
    console.log(`  ${pad(r.familyLabel, 11)} ${pad(MODE_FR[r.mode], 6)} ` +
      r.m.depth.map((d) => `${d.name} ${f3(d.dE)}`).join(" · ") +
      `  | bulle/fond ${f3(r.m.assistantOnSurface)}`);
  }
  console.log(fails.length === 0 ? "Verdict : LISIBILITÉ OK (0 point sous seuil)." : `Verdict : ${fails.length} point(s) sous seuil :`);
  for (const f of fails) console.log("  - " + f);
}

console.log("\n" + "═".repeat(96));
console.log(`Écrit : ${OUT} (${html.length} caractères)`);
