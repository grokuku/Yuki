#!/usr/bin/env node
/**
 * MAQUETTE JETABLE (hors production) — FOCALISÉE sur la direction C :
 * « neutre teinté maîtrisé + profondeur ».
 *
 * Pourquoi ce script : la maquette large `theme-proposal.mjs` (13 variantes)
 * ne montrait le C qu'en petite tuile, au milieu de 12 autres. Ici, le C est
 * montré EN GRAND : un écran complet par famille (5 familles × 2 modes),
 * plus deux démonstrations ciblées :
 *   - la PROFONDEUR (surface / surface-elev / surface-raised / hover) ;
 *   - la DISTINCTION entre familles (Indigo ≠ Nuit ≠ Ardoise ≠ Émeraude ≠ Ambre),
 *     mesurée en OKLab (ΔEok) et exposée visuellement.
 *
 * Principes de la direction C (rappel de la décision d'étude) :
 *   - accent = graine Yuki INCHANGÉE par famille et par mode (thèmes réels de
 *     public/ui/themes.css) ;
 *   - surfaces à chroma OKLCH TRÈS faible : le fond redevient quasi neutre et
 *     l'accent ressort (sombre : 0,007–0,017 ; clair : ≤ 0,032, voir plus bas) ;
 *   - CLARTÉ de fond propre à CHAQUE famille : c'est elle qui garantit qu'Indigo,
 *     Nuit et Ardoise (mêmes teintes ou presque) ne se confondent plus ;
 *   - 3 niveaux de surface réels + survol (aujourd'hui Yuki n'en a que 2) ;
 *   - STRATÉGIE CLAIR (correctif « Indigo ≈ Nuit en clair ») : en mode clair, des
 *     surfaces proches du blanc n'ont quasi aucune marge (ni teinte ni clarté).
 *     On combine donc (a) une RÉPARTITION DE CLARTÉ marquée (page teintée de
 *     L 0,850 à 0,962) et (b) des NEUTRES LÉGÈREMENT COLORÉS (chroma ≤ 0,032),
 *     la carte (surface-elev) restant quasi blanche pour porter la profondeur.
 *     L'identité ne repose PAS sur le seul accent (ce serait le défaut d'origine).
 *   - RÈGLE DE NON-REDONDANCE mesurable et appliquée SÉPARÉMENT par mode (voir
 *     RULE plus bas) : le générateur ÉCHOUE (exit 1) si une paire de familles
 *     d'un même mode est trop proche — la garde n'est pas vacueuse
 *     (`--selftest-redundant` injecte volontairement une famille redondante).
 *
 * Contraintes respectées :
 *   - fichier HTML AUTONOME : un seul .html, aucune image, aucun <link>, aucun
 *     <script>, aucune URL réseau (immunisé au sandbox d'origine opaque de la
 *     Preview Pi-Web) ;
 *   - thème par VARIABLES CSS + `data-theme` (comme Yuki), AUCUN attribut
 *     `style=` sur les éléments (esprit CSP `style-src 'self'`) ;
 *   - la maquette ne touche AUCUN fichier de production (Yuki ni holaf-lib) ;
 *   - le basculeur clair/sombre est en CSS PUR (checkbox + `:checked`), sans JS.
 *
 * Usage :  node _tools/theme-proposal-c.mjs
 * Sortie : _tools/theme-proposal-c.html + rapport (contrastes, ΔEok) sur stdout.
 *
 * Primitives couleur partagées : ./theme-lib.mjs (aucune dépendance).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  contrast, hexToRgb, mix, oklch, readableOn, rgbToOklab, toOklch,
} from "./theme-lib.mjs";
import {
  VARIANTS as ACCENT_VARIANTS, auditAll as accentAuditAll, checkAudit, selftestBadAudit,
  variantFamilies, WHEEL_ORDER,
  AA_TEXT, AA_NONTEXT, ACCENT_SEP, SURFACE_SEP, DEPTH_SEP,
} from "./theme-accents.mjs";

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. Les 5 familles × 2 modes — accents Yuki réels + clarté de fond propre
 * ═════════════════════════════════════════════════════════════════════════ */

/* Accents repris TELS QUELS de public/ui/themes.css (graines Yuki) — JAMAIS touchés.
 * `darkL`/`darkChroma` = clarté/chroma OKLCH du fond de page en mode sombre ;
 * `lightL`/`lightChroma` = idem en mode clair. La clarté de CHAQUE famille est
 * choisie pour que les 5 fonds restent perceptiblement distincts DANS LES DEUX
 * modes (les 3 familles bleutées Indigo/Nuit/Ardoise sont séparées sur la clarté,
 * Émeraude/Ambre sur leur teinte).
 * En clair, la plage de clarté est volontairement large (0,850–0,962) : c'est la
 * réponse au peu de marge des surfaces quasi blanches. */
const FAMILIES = [
  { id: "indigo",   label: "Indigo",   accentDark: "#6366f1", accentLight: "#4f46e5", darkL: 0.205, darkChroma: 0.010, lightL: 0.925, lightChroma: 0.030 },
  { id: "midnight", label: "Nuit",     accentDark: "#818cf8", accentLight: "#5b63d3", darkL: 0.135, darkChroma: 0.014, lightL: 0.850, lightChroma: 0.024 },
  { id: "slate",    label: "Ardoise",  accentDark: "#94a3b8", accentLight: "#475569", darkL: 0.290, darkChroma: 0.007, lightL: 0.962, lightChroma: 0.005 },
  { id: "emerald",  label: "Émeraude", accentDark: "#34d399", accentLight: "#047857", darkL: 0.245, darkChroma: 0.013, lightL: 0.900, lightChroma: 0.030 },
  { id: "amber",    label: "Ambre",    accentDark: "#fbbf24", accentLight: "#b45309", darkL: 0.165, darkChroma: 0.017, lightL: 0.880, lightChroma: 0.032 },
];

/* ⚠️ `--selftest-redundant` : PREUVE que la garde n'est pas vacueuse. On force
 * volontairement Ardoise-Clair à adopter la clarté/chroma de Nuit-Clair : les
 * deux fonds deviennent quasi identiques, et le générateur DOIT échouer (exit 1).
 * Sans ce drapeau, aucun effet (sortie normale, idempotente). */
const SELF_TEST = process.argv.includes("--selftest-redundant");
if (SELF_TEST) {
  const slate = FAMILIES.find((f) => f.id === "slate");
  const midnight = FAMILIES.find((f) => f.id === "midnight");
  slate.lightL = midnight.lightL;
  slate.lightChroma = midnight.lightChroma;
  console.error("[selftest] Ardoise-Clair rendu volontairement redondant avec Nuit-Clair.");
}

/** --ok : graine Yuki #4cc38a ajustée par paliers de 5 % jusqu'à ≥ 4.5:1. */
function okOn(surface, mode) {
  let ok = "#4cc38a";
  if (contrast(ok, surface) >= 4.5) return ok;
  for (let a = 0.05; a <= 1.0001; a += 0.05) {
    ok = mode === "light" ? mix("#4cc38a", "#000000", a) : mix("#4cc38a", "#ffffff", a);
    if (contrast(ok, surface) >= 4.5) return ok;
  }
  return ok;
}

/** --danger : graine Yuki ajustée par paliers de 5 % jusqu'à ≥ 4.5:1 sur la surface. */
function dangerOn(surface, mode) {
  const base = mode === "light" ? "#dc2626" : "#f87171";
  let danger = base;
  if (contrast(danger, surface) >= 4.5) return danger;
  for (let a = 0.05; a <= 1.0001; a += 0.05) {
    danger = mode === "light" ? mix(base, "#000000", a) : mix(base, "#ffffff", a);
    if (contrast(danger, surface) >= 4.5) return danger;
  }
  return danger;
}

/** Palette complète d'une famille dans un mode, direction C. */
function familyPalette({ accent, mode, L, chroma }) {
  const { H } = toOklch(accent);
  if (mode === "dark") {
    const surface = oklch(L, chroma, H);
    return {
      surface,
      elev: oklch(L + 0.045, chroma + 0.002, H),
      raised: oklch(L + 0.090, chroma + 0.004, H),
      hover: oklch(L + 0.135, chroma + 0.006, H),
      border: oklch(L + 0.205, chroma + 0.010, H),
      text: oklch(0.955, 0.006, H),
      muted: oklch(0.735, chroma + 0.006, H),
      accent,
      onAccent: readableOn(accent),
      danger: dangerOn(surface, "dark"),
      ok: okOn(surface, "dark"),
      user: mix(surface, accent, 0.20),
      assistant: mix(surface, accent, 0.06),
    };
  }
  // CLAIR : la page (surface) est TEINTÉE et descendue en clarté — elle porte donc
  // l'identité de famille ; la carte (elev) reste quasi blanche et « pop » dessus,
  // puis le bloc imbriqué (raised) et le survol (hover) redescendent en gris.
  const surface = oklch(L, chroma, H);
  return {
    surface,
    elev: oklch(0.998, chroma * 0.3, H), // carte quasi blanche posée sur la page teintée
    raised: oklch(L - 0.030, chroma, H),
    hover: oklch(L - 0.060, chroma, H),
    border: oklch(L - 0.125, chroma + 0.006, H),
    text: oklch(0.27, 0.020, H),
    muted: oklch(0.46, 0.030, H),
    accent,
    onAccent: readableOn(accent),
    danger: dangerOn(surface, "light"),
    ok: okOn(surface, "light"),
    user: mix(surface, accent, 0.16),
    assistant: mix(surface, accent, 0.05),
  };
}

/* Une entrée de thème par famille × mode. */
const THEMES = [];
for (const fam of FAMILIES) {
  for (const mode of ["dark", "light"]) {
    const accent = mode === "dark" ? fam.accentDark : fam.accentLight;
    const L = mode === "dark" ? fam.darkL : fam.lightL;
    const chroma = mode === "dark" ? fam.darkChroma : fam.lightChroma;
    const colors = familyPalette({ accent, mode, L, chroma });
    THEMES.push({
      id: `c-${fam.id}-${mode}`,
      family: fam.id,
      familyLabel: fam.label,
      mode,
      accent,
      colors,
    });
  }
}
const THEME = Object.fromEntries(THEMES.map((t) => [t.id, t]));

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. Vérifications (contraste WCAG + distinction ΔEok) — rapportées + inscrites
 * ═════════════════════════════════════════════════════════════════════════ */

/** Distance perceptuelle en OKLab (ΔEok ~ 0,02 = seuil « juste perceptible »). */
function deltaEok(a, b) {
  const A = rgbToOklab(hexToRgb(a));
  const B = rgbToOklab(hexToRgb(b));
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

const AA = 4.5;

function audit(t) {
  const c = t.colors;
  const r = {
    textBg: contrast(c.text, c.surface),
    textCard: contrast(c.text, c.elev),
    mutedBg: contrast(c.muted, c.surface),
    borderBg: contrast(c.border, c.surface),
    okBg: contrast(c.ok, c.surface),
    dangerBg: contrast(c.danger, c.surface),
    onAccent: contrast(c.onAccent, c.accent),
    // profondeur : chaque palier doit se voir sur le précédent
    elevOnSurface: deltaEok(c.elev, c.surface),
    raisedOnElev: deltaEok(c.raised, c.elev),
    hoverOnRaised: deltaEok(c.hover, c.raised),
  };
  return r;
}

const AUDITS = Object.fromEntries(THEMES.map((t) => [t.id, audit(t)]));

/** Distances entre familles (par mode), sur le fond et l'accent (matrice complète). */
function familyDistances(mode) {
  const rows = FAMILIES.map((f) => THEME[`c-${f.id}-${mode}`]);
  const pairs = [];
  let minBg = Infinity, minBgPair = "", minAccent = Infinity, minAccentPair = "";
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const bg = deltaEok(rows[i].colors.surface, rows[j].colors.surface);
      const ac = deltaEok(rows[i].accent, rows[j].accent);
      const pair = `${rows[i].familyLabel}↔${rows[j].familyLabel}`;
      pairs.push({ pair, bg, ac });
      if (bg < minBg) { minBg = bg; minBgPair = pair; }
      if (ac < minAccent) { minAccent = ac; minAccentPair = pair; }
    }
  }
  pairs.sort((a, b) => a.bg - b.bg);
  return { mode, pairs, minBg, minBgPair, minAccent, minAccentPair };
}
const DIST = { dark: familyDistances("dark"), light: familyDistances("light") };

/* ═══════════════════════════════════════════════════════════════════════════
 * RÈGLE DE NON-REDONDANCE — seuils CHIFFRÉS, appliqués SÉPARÉMENT PAR MODE
 * ═════════════════════════════════════════════════════════════════════════
 * Pour chaque mode et chaque paire de familles (i, j), i ≠ j :
 *   (fond)   ΔEok(--surface_i, --surface_j) ≥ RULE.surface  (0,040)
 *   (accent) ΔEok(--accent_i,  --accent_j ) ≥ RULE.accent   (0,020)
 * et, pour chaque thème, chaque palier de profondeur successif ≥ RULE.depth.
 * Le seuil 0,020 est le seuil « juste perceptible » (JND) en OKLab ; 0,040 = 2×.
 * ⚠️ L'accent NE PEUT PAS être le seul porteur de l'identité : c'est le FOND
 * (--surface) qui doit franchir le seuil — sinon on retombe sur le défaut
 * « les fonds ne bougent pas ».
 * Le générateur ÉCHOUE (exit 1) dès qu'une violation existe : build cassé. */
const RULE = {
  surface: 0.040, // fond : 2× le seuil juste-perceptible (ΔEok JND ≈ 0,020)
  accent:  0.020, // accent : 1× le JND (accents = graines Yuki, NON modifiées)
  depth:   0.020, // paliers de profondeur : 1× le JND
};

const DEPTH_STEPS = [
  ["surface→elev", "surface", "elev"],
  ["elev→raised", "elev", "raised"],
  ["raised→hover", "raised", "hover"],
];

/** Liste des violations de la règle (vide ⇒ règle respectée). */
function checkNonRedundancy() {
  const violations = [];
  for (const mode of ["dark", "light"]) {
    for (const p of DIST[mode].pairs) {
      if (p.bg < RULE.surface) violations.push({ mode, kind: "fond", who: p.pair, value: p.bg, min: RULE.surface });
      if (p.ac < RULE.accent) violations.push({ mode, kind: "accent", who: p.pair, value: p.ac, min: RULE.accent });
    }
  }
  for (const t of THEMES) {
    for (const [name, ka, kb] of DEPTH_STEPS) {
      const d = deltaEok(t.colors[ka], t.colors[kb]);
      if (d < RULE.depth) violations.push({ mode: t.mode, kind: "profondeur", who: `${t.id} ${name}`, value: d, min: RULE.depth });
    }
  }
  return violations;
}

const VIOLATIONS = checkNonRedundancy();
if (VIOLATIONS.length > 0) {
  console.error(`\n✗ RÈGLE DE NON-REDONDANCE VIOLÉE (${VIOLATIONS.length} cas) :`);
  for (const v of VIOLATIONS) {
    console.error(`  [${v.mode}] ${v.kind.padEnd(10)} ${v.who} : ΔEok ${v.value.toFixed(4)} < ${v.min}`);
  }
  console.error(`\nSeuils : fond ΔEok ≥ ${RULE.surface} · accent ΔEok ≥ ${RULE.accent} · profondeur ΔEok ≥ ${RULE.depth}.`);
  process.exit(1);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 2bis. GARDE DES ACCENTS (V0/V1/V2/V3) — contraste + distinction + profondeur
 * ═════════════════════════════════════════════════════════════════════════
 * On audite les 4 variantes d'accents, puis on VÉRIFIE (par mode) :
 *   - écart d'ACCENT entre familles ≥ ACCENT_SEP ;
 *   - écart de FOND entre familles ≥ SURFACE_SEP ;
 *   - contraste TEXTE-SUR-ACCENT ≥ 4,5:1 (WCAG 1.4.3) ;
 *   - contraste ACCENT-SUR-FOND ≥ 4,5:1 (lien = texte) ET ≥ 3:1 (anneau de focus,
 *     élément non textuel porteur de sens, WCAG 1.4.11) ;
 *   - paliers de profondeur ≥ DEPTH_SEP.
 * Les variantes marquées `conformant:false` (V0 = accents actuels) sont la
 * RÉFÉRENCE : leurs défauts sont MESURÉS et AFFICHÉS mais ne cassent pas le build
 * (c'est précisément le constat à corriger). Les propositions V1/V2/V3 doivent, elles,
 * passer SANS violation. `--selftest-accent` injecte un jeu volontairement mauvais. */
const AUDIT_ACCENT = accentAuditAll();
const ACCENT_VIOLATIONS = [];
for (const vr of ACCENT_VARIANTS) {
  if (!vr.conformant) continue;
  ACCENT_VIOLATIONS.push(...checkAudit(vr.id, AUDIT_ACCENT[vr.id]));
}

const SELF_TEST_ACCENT = process.argv.includes("--selftest-accent");
if (SELF_TEST_ACCENT) {
  console.error("[selftest] jeu d'accents volontairement mauvais : 6 accents sombres identiques (#787878).");
  ACCENT_VIOLATIONS.push(...checkAudit("selftest", selftestBadAudit()));
}
if (ACCENT_VIOLATIONS.length > 0) {
  console.error(`\n✗ GARDE DES ACCENTS VIOLÉE (${ACCENT_VIOLATIONS.length} cas) :`);
  for (const v of ACCENT_VIOLATIONS) {
    console.error(`  ${v.kind.padEnd(17)} ${v.who} : ${v.value.toFixed(4)} < ${v.min}`);
  }
  console.error(`\nSeuils : texte/accent ≥ ${AA_TEXT} · non textuel ≥ ${AA_NONTEXT} · écart accent ≥ ${ACCENT_SEP} · écart fond ≥ ${SURFACE_SEP} · profondeur ≥ ${DEPTH_SEP}.`);
  process.exit(1);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. Rendu HTML autonome
 * ═════════════════════════════════════════════════════════════════════════ */

const VARS = [
  ["--surface", "surface"], ["--elev", "elev"], ["--raised", "raised"], ["--hover", "hover"],
  ["--border", "border"], ["--text", "text"], ["--muted", "muted"],
  ["--accent", "accent"], ["--danger", "danger"], ["--ok", "ok"],
  ["--user", "user"], ["--assistant", "assistant"],
];

const varsRule = (t) =>
  [
    `[data-theme="${t.id}"] {`,
    `  color-scheme: ${t.mode};`,
    `  --on-accent: ${t.colors.onAccent};`,
    ...VARS.map(([cssVar, key]) => `  ${cssVar}: ${t.colors[key]};`),
    `}`,
  ].join("\n");

/** Le mini-écran riche, strictement le même markup pour tous les thèmes. */
function screen(t) {
  return `
  <div class="screen" data-theme="${t.id}" data-mode="${t.mode}">
    <div class="app">
      <header class="topbar">
        <span class="brand">Yuki</span>
        <span class="status">
          <span class="pill">Configuration</span>
          <span class="pill pill--accent">En ligne</span>
          <span class="badge badge--ok">ok</span>
        </span>
      </header>
      <main class="conversation">
        <div class="card">
          <div class="card__head">
            <h3 class="card__title">Panneau</h3>
            <span class="lvl-tag">surface-elev</span>
          </div>
          <p class="normal">Texte normal sur la carte (surface-elev).</p>
          <p class="muted">Texte atténué (secondaire) sur la carte.</p>
          <div class="raised">
            <span class="lvl-tag">surface-raised</span>
            <p class="normal">Bloc imbriqué sur la carte : 3ᵉ niveau de surface.</p>
          </div>
          <div class="chips">
            <span class="chip chip--hover">survol</span>
            <span class="chip chip--border">bordure</span>
            <span class="badge badge--warn">en file</span>
          </div>
          <p class="link-line"><span class="link">Voir la configuration →</span></p>
        </div>
        <div class="msg msg--assistant">
          <span class="msg__who">Assistant</span>
          <p>Réponse du modèle, sur la surface assistant.</p>
        </div>
        <div class="msg msg--user">
          <span class="msg__who">Vous</span>
          <p>Message de l'utilisateur, sur la surface user.</p>
        </div>
      </main>
      <footer class="composer">
        <div class="field">Écrivez un message…</div>
        <button class="button" type="button">Envoyer</button>
      </footer>
    </div>
  </div>`;
}

/** Carte « famille » : titre + écran + audit + hexes. */
function familyCard(t) {
  const a = AUDITS[t.id];
  const c = t.colors;
  const check = (v, min) => `<span class="${v >= min ? "ok" : "ko"}">${v.toFixed(2)}:1</span>`;
  const info = (v) => `<span class="info">${v.toFixed(2)}:1</span>`;
  return `
  <figure class="family" data-theme="${t.id}" data-mode="${t.mode}">
    <figcaption class="family__cap">
      <span class="family__name">${t.familyLabel}</span>
      <span class="family__mode">${t.mode === "dark" ? "sombre" : "clair"}</span>
      <span class="family__hex">fond ${c.surface} · carte ${c.elev} · accent ${c.accent}</span>
    </figcaption>
    ${screen(t)}
    <div class="audit">
      <span>texte/fond ${check(a.textBg, AA)}</span>
      <span>texte/carte ${check(a.textCard, AA)}</span>
      <span>atténué/fond ${check(a.mutedBg, AA)}</span>
      <span>bouton/accent ${check(a.onAccent, AA)}</span>
      <span>ok/fond ${check(a.okBg, AA)}</span>
      <span>bordure/fond ${info(a.borderBg)}</span>
      <span>danger/fond ${check(a.dangerBg, AA)}</span>
    </div>
  </figure>`;
}

/** Échelle de profondeur : les 4 niveaux empilés sur un fond de famille. */
function ladder(t) {
  const c = t.colors;
  const a = AUDITS[t.id];
  const step = (key, label, hex, dist) => `
    <div class="step">
      <span class="step__sw step__sw--${key}"></span>
      <span class="step__txt"><b>${label}</b><code>${hex}</code></span>
      ${dist == null ? "" : `<span class="step__d">Δ ${dist.toFixed(3)}</span>`}
    </div>`;
  return `
  <div class="ladder" data-theme="${t.id}" data-mode="${t.mode}">
    <div class="ladder__head">${t.familyLabel} · ${t.mode === "dark" ? "sombre" : "clair"}</div>
    ${step("surface", "surface", c.surface, null)}
    ${step("elev", "surface-elev", c.elev, a.elevOnSurface)}
    ${step("raised", "surface-raised", c.raised, a.raisedOnElev)}
    ${step("hover", "hover", c.hover, a.hoverOnRaised)}
  </div>`;
}

/** Bandeau de distinction : un gros aplat de fond par famille (mode donné). */
function distinctionStrip(mode) {
  const items = FAMILIES.map((f) => {
    const t = THEME[`c-${f.id}-${mode}`];
    return `
      <div class="ds" data-theme="${t.id}">
        <span class="ds__sw ds__sw--bg"></span>
        <span class="ds__lab">${f.label}</span>
        <code>${t.colors.surface}</code>
        <span class="ds__acc"></span>
      </div>`;
  }).join("");
  return `<div class="ds-strip" data-strip="${mode}">${items}</div>`;
}

const styleBlock = THEMES.map(varsRule).join("\n");

/* ═══════════════════════════════════════════════════════════════════════════
 * 3bis. Section ACCENTS : variables CSS + widgets « en contexte »
 * ═════════════════════════════════════════════════════════════════════════ */

/** Bloc de variables par (variante × famille × mode) — posé sur [data-accent]. */
const accentVarsRule = (vr, row, mode) => {
  const s = row.surface;
  return [
    `[data-accent="${vr.id}-${row.id}-${mode}"] {`,
    `  color-scheme: ${mode};`,
    `  --surface: ${s.surface};`,
    `  --elev: ${s.elev};`,
    `  --raised: ${s.raised};`,
    `  --border: ${s.border};`,
    `  --text: ${s.text};`,
    `  --muted: ${s.muted};`,
    `  --accent: ${row.accent};`,
    `  --on-accent: ${row.onAccent};`,
    `}`,
  ].join("\n");
};
const accentStyleBlock = ACCENT_VARIANTS
  .flatMap((vr) => ["dark", "light"].flatMap((mode) =>
    AUDIT_ACCENT[vr.id].modes[mode].rows.map((row) => accentVarsRule(vr, row, mode))))
  .join("\n");

const ratioSpan = (v, min) => `<span class="${v >= min ? "ok" : "ko"}">${v.toFixed(2)}:1</span>`;

/** Widget « en contexte » (bouton, lien, badge, anneau de focus, onglet actif). */
function accentCard(vr, row, mode) {
  const key = `${vr.id}-${row.id}-${mode}`;
  const rep = row.v3repaired ? `<span class="av-rep">réparé de ${row.v3source}</span>` : "";
  return `
    <div class="av-card" data-accent="${key}">
      <div class="av-head"><b>${row.label}</b> <code>${row.accent}</code>${rep}</div>
      <div class="av-row">
        <button class="av-btn" type="button">Envoyer</button>
        <span class="av-link">Voir la configuration →</span>
        <span class="av-badge">Nouveau</span>
      </div>
      <div class="av-row">
        <span class="av-focus">anneau de focus</span>
        <span class="av-tab">Onglet actif</span>
      </div>
      <div class="av-ro">
        <span>texte/accent ${ratioSpan(row.onAccentRatio, AA_TEXT)}</span>
        <span>accent/fond (lien) ${ratioSpan(row.linkRatio, AA_TEXT)}</span>
        <span>anneau/fond ${ratioSpan(row.nonTextRatio, AA_NONTEXT)}</span>
      </div>
    </div>`;
}

/** Tableau de synthèse (matrice famille × mode, contraste texte/accent). */
function accentTable(vr) {
  const a = AUDIT_ACCENT[vr.id];
  const rows = a.modes.dark.rows.map((dr, i) => {
    const lr = a.modes.light.rows[i];
    return `<tr>
      <th scope="row">${dr.label}</th>
      <td><span class="av-sw" data-accent="${vr.id}-${dr.id}-dark"></span></td>
      <td>${ratioSpan(dr.onAccentRatio, AA_TEXT)}</td>
      <td><span class="av-sw" data-accent="${vr.id}-${lr.id}-light"></span></td>
      <td>${ratioSpan(lr.onAccentRatio, AA_TEXT)}</td>
    </tr>`;
  }).join("");
  return `<table class="av-table">
      <thead><tr><th>Famille</th><th>Accent sombre</th><th>txt/accent</th><th>Accent clair</th><th>txt/accent</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** Un bloc de variante : idée, mesures, matrice, puis les 2 modes en contexte. */
function accentBlock(vr) {
  const a = AUDIT_ACCENT[vr.id];
  const badge = vr.recommended
    ? `<span class="rec">recommandé</span>`
    : vr.conformant ? "" : `<span class="nonconf">non conforme</span>`;
  const minRow = `<div class="av-notes">
      <span>écart accent min — sombre <b>${a.modes.dark.minAccent.toFixed(3)}</b> · clair <b>${a.modes.light.minAccent.toFixed(3)}</b></span>
      <span>écart fond min — sombre <b>${a.modes.dark.minBg.toFixed(3)}</b> · clair <b>${a.modes.light.minBg.toFixed(3)}</b></span>
      <span>texte/accent min — sombre <b>${a.modes.dark.minOn.toFixed(2)}:1</b> · clair <b>${a.modes.light.minOn.toFixed(2)}:1</b></span>
    </div>`;
  const modeGrid = (mode) => `<div class="av-mode">
      <div class="av-mode__head">${mode === "dark" ? "Mode sombre" : "Mode clair"} — bouton · lien · badge · anneau de focus · onglet actif</div>
      <div class="av-grid">${a.modes[mode].rows.map((row) => accentCard(vr, row, mode)).join("")}</div>
    </div>`;
  return `
  <section class="av-block" id="accents-${vr.id}">
    <div class="av-title"><h3>${vr.label}</h3>${badge}<span class="av-tag">${vr.tagline}</span></div>
    <p class="av-idea"><b>Idée :</b> ${vr.idea} <b>Règle :</b> ${vr.fixes} <b>Coût :</b> ${vr.cost}</p>
    ${minRow}
    ${accentTable(vr)}
    ${modeGrid("dark")}
    ${modeGrid("light")}
  </section>`;
}

const dDark = DIST.dark, dLight = DIST.light;
const passBgDark = dDark.minBg >= RULE.surface, passAccDark = dDark.minAccent >= RULE.accent;
const passBgLight = dLight.minBg >= RULE.surface, passAccLight = dLight.minAccent >= RULE.accent;

const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Yuki — direction C « neutre teinté maîtrisé + profondeur » (maquette hors production)</title>
<style>
/* ═══ Page de la maquette (neutre, SANS couleur de marque) ═══════════════ */
* { box-sizing: border-box; }
body {
  margin: 0; padding: 30px 34px 80px; max-width: 1720px;
  background: #14161a; color: #e7eaf0;
  font: 14px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
h1 { font-size: 23px; margin: 0 0 8px; }
h2 { font-size: 17px; margin: 40px 0 12px; border-top: 1px solid #2b2f36; padding-top: 22px; }
p.lead { color: #a4acba; max-width: 120ch; margin: 8px 0 0; }
p.lead b { color: #e7eaf0; }
code { background: #22262d; border: 1px solid #2f3540; border-radius: 4px; padding: 0 4px;
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: .85em; }
.note { color: #8b93a1; font-size: 12.5px; }

/* Bandeau d'explication des deux correctifs. */
.fixes { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; margin-top: 18px; }
.fix { border: 1px solid #2b2f36; border-radius: 12px; padding: 14px 16px; background: #191c21; }
.fix h3 { margin: 0 0 6px; font-size: 14px; }
.fix p { margin: 6px 0 0; color: #a4acba; }
.fix b { color: #e7eaf0; }

/* ═══ Thèmes : variables CSS par variante (data-theme) — aucun style inline ═══ */
${styleBlock}

/* ═══ Accents : variables CSS par (variante × famille × mode) — data-accent ═══ */
${accentStyleBlock}

/* ═══ Mini-écran — mêmes règles pour TOUS les thèmes ; seuls les var changent ═══ */
.family { margin: 0; border: 1px solid #2b2f36; border-radius: 14px; padding: 12px; background: #191c21; }
.family__cap { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
.family__name { font-weight: 700; font-size: 15px; }
.family__mode { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8b93a1;
  border: 1px solid #2f3540; border-radius: 999px; padding: 1px 8px; }
.family__hex { color: #7f8794; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; margin-left: auto; }

.screen { border-radius: 11px; overflow: hidden; border: 1px solid var(--border); }
.app { display: flex; flex-direction: column; background: var(--surface); color: var(--text); font-size: 13px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 10px 14px; background: var(--surface); border-bottom: 1px solid var(--border); }
.brand { font-weight: 700; letter-spacing: .02em; }
.status { display: flex; gap: 6px; align-items: center; }
.pill { font-size: 11px; padding: 2px 10px; border-radius: 999px; border: 1px solid var(--border);
  background: var(--elev); color: var(--muted); }
.pill--accent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.badge { font-size: 10.5px; padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border); }
.badge--ok { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, var(--border)); }
.badge--warn { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.conversation { display: flex; flex-direction: column; gap: 10px; padding: 14px; background: var(--surface); }

/* La CARTE porte le 2ᵉ niveau (surface-elev) posé sur le fond (surface). */
.card { background: var(--elev); border: 1px solid var(--border); border-radius: 11px; padding: 12px 14px; }
.card__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.card__title { margin: 0; font-size: 14px; }
.normal { margin: 7px 0 2px; }
.muted { margin: 2px 0 8px; color: var(--muted); }
/* Le BLOC IMBRIQUÉ porte le 3ᵉ niveau (surface-raised) posé sur la carte. */
.raised { background: var(--raised); border: 1px solid var(--border); border-radius: 9px; padding: 9px 11px; margin: 8px 0; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0 4px; }
.chip { font-size: 11px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border); }
.chip--hover { background: var(--hover); }
.chip--border { background: transparent; }
.link-line { margin: 6px 0 0; }
.link { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.msg { max-width: 84%; padding: 9px 12px; border-radius: 12px; border: 1px solid var(--border); }
.msg p { margin: 3px 0 0; }
.msg__who { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
.msg--assistant { align-self: flex-start; background: var(--assistant); }
.msg--user { align-self: flex-end; background: var(--user); }
.composer { display: flex; gap: 8px; align-items: center; padding: 11px 14px;
  background: var(--surface); border-top: 1px solid var(--border); }
.field { flex: 1; padding: 9px 11px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--elev); color: var(--muted); }
.button { padding: 9px 16px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; cursor: pointer; }

/* Petite étiquette monospace qui ANNOTE le niveau de surface en place. */
.lvl-tag { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 10px;
  color: var(--muted); border: 1px dashed color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: 5px; padding: 1px 6px; }

/* Audit WCAG sous chaque écran. */
.audit { display: flex; flex-wrap: wrap; gap: 6px 14px; margin-top: 10px; font-size: 11.5px; color: #9aa2af; }
.audit .ok { color: #7fd6a3; }
.audit .ko { color: #ff9d9d; }
.audit .info { color: #9aa2af; }

/* Grille des écrans : GRAND (2 colonnes sur large). */
.screens { display: grid; grid-template-columns: repeat(auto-fit, minmax(480px, 1fr)); gap: 20px; margin-top: 16px; }

/* Échelle de profondeur. */
.ladders { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-top: 14px; }
.ladder { border: 1px solid var(--border); border-radius: 12px; padding: 12px; background: var(--surface); color: var(--text); }
.ladder__head { font-weight: 700; margin-bottom: 8px; }
.step { display: flex; align-items: center; gap: 10px; padding: 7px 9px; border-radius: 8px; margin: 5px 0; }
.step__sw { width: 40px; height: 26px; border-radius: 6px; border: 1px solid var(--border); flex: none; }
.step__sw--surface { background: var(--surface); }
.step__sw--elev { background: var(--elev); }
.step__sw--raised { background: var(--raised); }
.step__sw--hover { background: var(--hover); }
.step__txt { display: flex; align-items: baseline; gap: 8px; flex: 1; }
.step__txt code { background: transparent; border: none; color: var(--muted); }
.step__d { font-size: 11px; color: var(--muted); font-family: ui-monospace, Menlo, Consolas, monospace; }

/* Bandeau de distinction entre familles. */
.ds-strip { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-top: 12px; }
.ds { border: 1px solid var(--border); border-radius: 10px; padding: 10px; background: var(--surface);
  color: var(--text);
  display: flex; flex-direction: column; gap: 6px; align-items: center; }
.ds__sw--bg { width: 100%; height: 72px; border-radius: 8px; background: var(--surface);
  border: 1px solid color-mix(in srgb, var(--border) 70%, transparent); }
.ds__lab { font-weight: 700; }
.ds code { background: transparent; border: none; color: var(--muted); }
.ds__acc { width: 100%; height: 10px; border-radius: 5px; background: var(--accent); }

/* ═══ Basculeur clair/sombre CSS PUR (checkbox + :checked), SANS JS ═════════ */
.toggle-bar { display: flex; align-items: center; gap: 10px; margin: 14px 0 4px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.toggle { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;
  border: 1px solid #2f3540; border-radius: 999px; padding: 7px 14px; background: #22262d; color: #e7eaf0;
  font-weight: 600; }
.toggle__knob { width: 30px; height: 16px; border-radius: 999px; background: #3a4150; position: relative; }
.toggle__knob::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
  border-radius: 50%; background: #e7eaf0; transition: left .15s ease; }
.toggle-bar .on-light { display: none; }
#mode-toggle:checked ~ .toggle-bar .on-dark { display: none; }
#mode-toggle:checked ~ .toggle-bar .on-light { display: inline; }
#mode-toggle:checked ~ .toggle-bar .toggle__knob::after { left: 16px; background: var(--accent, #e7eaf0); }
.screen-tog--light { display: none; }
#mode-toggle:checked ~ .toggle-demo .screen-tog--dark { display: none; }
#mode-toggle:checked ~ .toggle-demo .screen-tog--light { display: block; }
.toggle-demo { display: block; margin-top: 10px; max-width: 760px; }

/* ═══ Section ACCENTS : comparaison côte à côte des jeux d'accents ═════════ */
.av-block { border: 1px solid #2b2f36; border-radius: 14px; padding: 14px 16px; margin-top: 16px; background: #191c21; }
.av-title { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.av-title h3 { margin: 0; font-size: 16px; }
.rec { font-size: 11px; font-weight: 700; color: #0b0b12; background: #7fd6a3; border-radius: 999px; padding: 1px 9px; }
.nonconf { font-size: 11px; font-weight: 700; color: #101014; background: #ffb4b4; border-radius: 999px; padding: 1px 9px; }
.av-tag { color: #8b93a1; font-size: 12.5px; }
.av-idea { color: #a4acba; margin: 8px 0 10px; max-width: 150ch; }
.av-idea b { color: #e7eaf0; }
.av-notes { display: flex; flex-wrap: wrap; gap: 6px 18px; font-size: 12px; color: #9aa2af; margin-bottom: 10px; }
.av-notes b { color: #e7eaf0; }
.av-table { border-collapse: collapse; margin: 4px 0 12px; font-size: 12px; }
.av-table th, .av-table td { border: 1px solid #2f3540; padding: 3px 9px; text-align: left; }
.av-table thead th { color: #8b93a1; font-weight: 600; }
.av-table tbody th { color: #c3cad6; font-weight: 500; }
.av-table .ok { color: #7fd6a3; } .av-table .ko { color: #ff9d9d; }
.av-sw { display: inline-block; width: 34px; height: 18px; border-radius: 5px; border: 1px solid #3a4150; background: var(--accent); vertical-align: middle; }
.av-mode { margin-top: 12px; }
.av-mode__head { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #8b93a1; margin-bottom: 6px; }
.av-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
.av-card { border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--surface); color: var(--text); }
.av-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.av-head code { background: transparent; border: none; color: var(--muted); }
.av-rep { font-size: 10.5px; color: #ffbf7a; border: 1px dashed #6b5a3a; border-radius: 5px; padding: 0 5px; }
.av-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0; }
.av-btn { padding: 7px 13px; border-radius: 8px; border: 1px solid var(--border); background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; cursor: pointer; }
.av-link { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.av-badge { font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--accent); color: var(--accent); }
.av-focus { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border); background: var(--elev);
  outline: 2px solid var(--accent); outline-offset: 2px; }
.av-tab { padding: 5px 11px; border-radius: 6px 6px 0 0; border-bottom: 2px solid var(--accent); color: var(--accent); background: var(--elev); }
.av-ro { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px 12px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; color: var(--muted); }
.av-ro .ok { color: #7fd6a3; }
.av-ro .ko { color: #ff9d9d; }

footer { margin-top: 46px; border-top: 1px solid #2b2f36; padding-top: 16px; color: #8b93a1; font-size: 12.5px; }
</style>
</head>
<body>
  <h1>Yuki — direction C « neutre teinté maîtrisé + profondeur »</h1>
  <p class="lead">
    Maquette <b>hors production</b>, focalisée sur la direction <b>C</b> seule, pour la juger
    <b>en grand</b>. Cinq familles (<b>Indigo, Nuit, Ardoise, Émeraude, Ambre</b>) × deux modes
    (sombre dominant / clair), un <b>écran complet</b> par famille. Le HTML est <b>autonome</b> :
    aucune image, aucun script, aucune ressource externe — thème par <code>data-theme</code> +
    variables CSS, aucun style en ligne.
  </p>

  <div class="fixes">
    <div class="fix">
      <h3>Correctif 1 — neutre teinté maîtrisé</h3>
      <p>L'accent est conservé <b>à l'identique</b> (graines de <code>themes.css</code>), mais les
      surfaces passent à un <b>chroma OKLCH très faible</b> (sombre : 0,007–0,017 ; clair : ≤ 0,032) :
      le fond redevient quasi neutre et l'accent ressort. Résultat : <b>plus d'effet « même teinte sur
      toute la page »</b>.</p>
    </div>
    <div class="fix">
      <h3>Correctif 2 — profondeur (3 niveaux + survol)</h3>
      <p>Là où Yuki n'utilise que 2 niveaux, la direction C en pose <b>3 réels</b> + le survol :
      <code>surface</code> (fond) → <code>surface-elev</code> (carte) → <code>surface-raised</code>
      (bloc imbriqué) → <code>hover</code>. Chaque palier est <b>annoté et mesuré</b> (ΔEok).</p>
    </div>
    <div class="fix">
      <h3>Correctif 3 — familles distinctes DANS LES DEUX modes</h3>
      <p>Chaque famille a sa <b>propre clarté de fond</b> : mêmes teintes ou presque (Indigo/Nuit),
      mais des <code>--surface</code> visiblement différents. Mesure ΔEok fond min —
      <b>sombre ${dDark.minBg.toFixed(3)}</b> (${dDark.minBgPair}, ${passBgDark ? "OK" : "KO"}),
      <b>clair ${dLight.minBg.toFixed(3)}</b> (${dLight.minBgPair}, ${passBgLight ? "OK" : "KO"}) —
      seuil ${RULE.surface.toFixed(3)} = 2× le juste-perceptible 0,020.</p>
    </div>
    <div class="fix">
      <h3>Correctif 4 — garde automatique (build cassé si redondance)</h3>
      <p>La <b>règle de non-redondance</b> (fond ΔEok ≥ ${RULE.surface}, accent ≥ ${RULE.accent},
      profondeur ≥ ${RULE.depth}) est <b>vérifiée séparément par mode</b> et le générateur
      <b>échoue (exit 1)</b> sinon. Preuve de non-vacuité : <code>--selftest-redundant</code>.
      Accents <b>inchangés</b>.</p>
    </div>
  </div>

  <h2>1 · Les 5 familles en grand — mode sombre (dominant)</h2>
  <p class="lead">Un écran complet par famille. Comparer les fonds et les accents d'un écran à l'autre :
  Ardoise (plus clair, gris-bleu) ≠ Indigo ≠ Nuit (le plus sombre) ≠ Émeraude ≠ Ambre.</p>
  <div class="screens">
    ${FAMILIES.map((f) => familyCard(THEME[`c-${f.id}-dark`])).join("\n")}
  </div>

  <h2>2 · Profondeur rendue visible — les 4 niveaux de surface</h2>
  <p class="lead">Empilement réel : chaque palier est mesuré par sa distance perceptuelle (ΔEok) au
  palier inférieur. Un Δ ≈ 0,02 est déjà <b>juste perceptible</b> ; ici les paliers visent nettement plus.</p>
  <div class="ladders">
    ${FAMILIES.map((f) => ladder(THEME[`c-${f.id}-dark`])).join("\n")}
  </div>

  <h2>3 · Distinction entre familles — preuve visuelle</h2>
  <p class="lead">À gauche le <b>fond</b> de chaque famille (mode sombre), à droite l'<b>accent</b>.
  Les aplats de fond doivent être visiblement différents d'une pastille à l'autre.</p>
  ${distinctionStrip("dark")}
  <p class="lead note">La distinction repose sur le <b>fond</b> (<code>--surface</code>), pas sur
  le seul accent. Mode clair : page <b>teintée et descendue en clarté</b> (L 0,850→0,962) + carte
  quasi blanche pour la profondeur — ΔEok fond min = <b>${dLight.minBg.toFixed(3)}</b>
  (${dLight.minBgPair}), accent min = ${dLight.minAccent.toFixed(3)} (${dLight.minAccentPair}).</p>
  ${distinctionStrip("light")}

  <h2>4 · Bascule clair / sombre — CSS pur, sans JS</h2>
  <p class="lead">Cochez : bascule d'<b>Indigo</b> sombre ↔ clair, réalisée par <code>:checked</code>
  (aucun script — sûr dans le sandbox de la Preview).</p>
  <input type="checkbox" id="mode-toggle" class="sr-only" />
  <div class="toggle-bar">
    <label class="toggle" for="mode-toggle">
      <span class="toggle__knob"></span>
      <span class="on-dark">Mode sombre</span>
      <span class="on-light">Mode clair</span>
    </label>
    <span class="note">Démonstration — cliquez l'interrupteur.</span>
  </div>
  <div class="toggle-demo">
    <div class="screen-tog screen-tog--dark">${screen(THEME["c-indigo-dark"])}</div>
    <div class="screen-tog screen-tog--light">${screen(THEME["c-indigo-light"])}</div>
  </div>

  <h2>5 · Les 5 familles — mode clair</h2>
  <p class="lead">Mêmes familles, mode clair : la <b>page est teintée</b> (et plus basse en clarté),
  la carte quasi blanche « pop » dessus. Les 5 fonds se distinguent <b>à l'œil</b> : Ardoise (presque
  blanche) ≠ Indigo ≠ Ambre ≠ Émeraude ≠ <b>Nuit</b> (le gris le plus profond).</p>
  <div class="screens">
    ${FAMILIES.map((f) => familyCard(THEME[`c-${f.id}-light`])).join("\n")}
  </div>

  <h2>6 · Accents — quatre jeux, comparés en contexte (bouton, lien, badge, anneau, onglet)</h2>
  <p class="lead">
    Ici on ne parle plus de FOND mais d'<b>ACCENT</b>. Chaque jeu est montré avec les <b>mêmes
    widgets</b>, dans les <b>deux modes</b>, sur <b>chaque famille</b> : bouton (texte posé sur
    l'accent), lien, badge, <b>anneau de focus</b> et onglet actif. Sous chaque famille, le contraste
    <b>mesuré</b> (vert = conforme, rouge = sous le seuil). Seuils : texte/accent ≥ 4,5:1 ;
    élément non textuel porteur de sens (anneau) ≥ 3:1 ; écart d'accent ≥ ${ACCENT_SEP} ;
    écart de fond ≥ ${SURFACE_SEP}. Les <b>propositions</b> V1/V2/V3 passent sans violation ;
    V0 (accents actuels) est la <b>référence non conforme</b> : ses défauts sont mesurés.
  </p>
  ${ACCENT_VARIANTS.map((vr) => accentBlock(vr)).join("\n")}

  <footer>
    Maquette de décision — <b>aucune</b> modification de production (ni <code>themes.css</code>, ni
    <code>generate-yuki-themes.mjs</code>, ni <code>theme.js</code>, ni <code>holaf-lib</code>).
    Générée par <code>_tools/theme-proposal-c.mjs</code> (réutilise les primitives de
    <code>_tools/theme-lib.mjs</code> et les jeux d'accents de <code>_tools/theme-accents.mjs</code>).
    Fichier autonome : ni image, ni <code>&lt;link&gt;</code>,
    ni <code>&lt;script&gt;</code>, ni URL réseau.
  </footer>
</body>
</html>
`;

const OUT = join(import.meta.dirname, "theme-proposal-c.html");
writeFileSync(OUT, html, "utf8");

/* ─── Rapport stdout ───────────────────────────────────────────────────── */
const pad = (s, n) => String(s).padEnd(n);
const num = (v) => v.toFixed(2).padStart(6);

console.log("Contrastes WCAG (AA : texte >= 4.5 ; non-texte/bordure >= 3) :");
console.log(pad("thème", 17), pad("mode", 6), "txt/bg", "txt/carte", "atten/bg", "bord/bg", "btn/acc", "ok/bg", "danger/bg");
for (const t of THEMES) {
  const a = AUDITS[t.id];
  console.log(
    pad(t.id, 17), pad(t.mode, 6),
    num(a.textBg), num(a.textCard), num(a.mutedBg), num(a.borderBg), num(a.onAccent), num(a.okBg), num(a.dangerBg),
  );
}

console.log("\nProfondeur — distance perceptuelle (ΔEok) entre paliers de surface :");
console.log(pad("thème", 17), "elev/fond", "raised/elev", "hover/raised");
for (const t of THEMES) {
  const a = AUDITS[t.id];
  console.log(pad(t.id, 17), num(a.elevOnSurface), num(a.raisedOnElev), num(a.hoverOnRaised));
}

console.log("\nRÈGLE DE NON-REDONDANCE (par mode) — matrice des écarts entre les 5 familles :");
console.log(`Seuils : fond ΔEok >= ${RULE.surface} · accent ΔEok >= ${RULE.accent} · profondeur ΔEok >= ${RULE.depth}`);
for (const mode of ["dark", "light"]) {
  const d = DIST[mode];
  console.log(`\n  mode ${mode} — fond (min ${d.minBg.toFixed(4)} ${d.minBgPair}) :`);
  for (const p of d.pairs) console.log(`    fond   ${pad(p.pair, 20)} ΔEok ${p.bg.toFixed(4)} ${p.bg >= RULE.surface ? "OK" : "KO"}`);
  const accSorted = [...d.pairs].sort((a, b) => a.ac - b.ac);
  for (const p of accSorted) console.log(`    accent ${pad(p.pair, 20)} ΔEok ${p.ac.toFixed(4)} ${p.ac >= RULE.accent ? "OK" : "KO"}`);
  console.log(`    accent min ${d.minAccent.toFixed(4)} (${d.minAccentPair})`);
}
console.log(`\nGarde automatique : ${VIOLATIONS.length === 0 ? "PASS (0 violation)" : VIOLATIONS.length + " violation(s)"}.`);
console.log(`Sombre : fond ${passBgDark ? "OK" : "KO"} / accent ${passAccDark ? "OK" : "KO"} · Clair : fond ${passBgLight ? "OK" : "KO"} / accent ${passAccLight ? "OK" : "KO"}.`);

/* ─── Rapport ACCENTS ──────────────────────────────────────────────────── */
console.log(`\n═══ ACCENTS — 4 variantes (V0 référence non conforme ; V1/V2/V3 propositions) ═══`);
console.log(`Seuils : texte/accent >= ${AA_TEXT} · non textuel >= ${AA_NONTEXT} · écart accent >= ${ACCENT_SEP} · écart fond >= ${SURFACE_SEP} · profondeur >= ${DEPTH_SEP}`);
for (const vr of ACCENT_VARIANTS) {
  const a = AUDIT_ACCENT[vr.id];
  const viol = vr.conformant ? checkAudit(vr.id, a) : [];
  console.log(`\n  ${vr.label} [${vr.familySet}]${vr.conformant ? "" : "  (référence — non soumise à la garde)"}`);
  for (const mode of ["dark", "light"]) {
    const m = a.modes[mode];
    console.log(`    ${pad(mode, 5)} accSep ${m.minAccent.toFixed(4)} (${m.minAccentPair}) · bgSep ${m.minBg.toFixed(4)} (${m.minBgPair}) · txt/accent min ${m.minOn.toFixed(2)} · accent/fond min ${m.minLink.toFixed(2)} · profondeur min ${m.minDepth.toFixed(4)}`);
  }
  if (vr.conformant) console.log(`    garde : ${viol.length === 0 ? "PASS (0 violation)" : viol.length + " violation(s)"}`);
}
console.log(`\nGarde des accents (V1/V2/V3) : ${ACCENT_VIOLATIONS.length === 0 ? "PASS (0 violation)" : ACCENT_VIOLATIONS.length + " violation(s)"}.`);

console.log(`\nÉcrit : ${OUT} (${html.length} caractères)`);
