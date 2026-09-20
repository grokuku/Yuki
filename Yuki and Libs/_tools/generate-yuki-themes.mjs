#!/usr/bin/env node
/**
 * GÉNÉRATEUR JETABLE — palettes Yuki (LOT B, modèle à deux axes).
 *
 * Situation : ce script vit à la racine du workspace composite
 * (« /projects/Yuki/Yuki and Libs »), HORS des deux dépôts git (Yuki et
 * holaf-lib). Il importe le catalogue holaf-lib et écrit l'artefact généré
 * `Yuki/public/ui/themes.css` (qui reste commité dans Yuki).
 *
 * Source de vérité des palettes : `HolafTokens.PRESETS` (holaf-tokens 0.2.0),
 * c'est-à-dire EXACTEMENT le catalogue holaf-lib (5 familles × 2 modes). Les
 * 4 palettes historiques (indigo/midnight/slate × dark + indigo-light) y sont
 * figées à l'identique ; midnight-light, slate-light, emerald-* et amber-*
 * sont générées par le catalogue. Aucune palette n'est réinventée ici.
 *
 * Projection sur les 11 variables de Yuki :
 *   --bg / --panel  ← surface        (fond de page du catalogue)
 *   --panel-2       ← surface-elev   (surface surélevée)
 *   --border        ← border
 *   --text          ← text           --muted ← text-muted
 *   --accent        ← accent         --danger ← danger
 *   --user      = HolafColor.mix(surface, accent, 0.18)
 *   --assistant = HolafColor.mix(surface, accent, 0.06)
 *   --ok       = graine Yuki #4cc38a ajustée par paliers ADDITIFS de 5 %
 *                (lighten vers blanc en mode sombre, darken vers noir en mode
 *                clair) jusqu'à contrastRatio(ok, surface) >= 4.5 (WCAG AA).
 *
 * Usage :  node _tools/generate-yuki-themes.mjs
 * Sortie : table de rapport sur stdout + écriture de themes.css.
 *
 * Idempotent : aucune date ni valeur volatille n'est écoute, deux exécutions
 * successives produisent un fichier identique octet pour octet.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HolafColor } from "../holaf-lib/js/holaf-color.js";
import { HolafTokens } from "../holaf-lib/js/holaf-tokens.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "Yuki", "public", "ui", "themes.css");

const FAMILIES = ["indigo", "midnight", "slate", "emerald", "amber"];
const MODES = ["light", "dark"];
const OK_SEED = "#4cc38a";
const OK_STEP = 0.05; // palier additif (part de noir/blanc mélangée à la graine)
const OK_MIN_CONTRAST = 4.5;

const SEEDS = {
  indigo: "#6366f1",
  midnight: "#818cf8",
  slate: "#94a3b8",
  emerald: "#10b981",
  amber: "#f59e0b",
};

/** --ok : premier palier additif (5 %) atteignant contrastRatio >= 4.5. */
function okColor(surface, mode) {
  let ok = OK_SEED;
  if (HolafColor.contrastRatio(ok, surface) >= OK_MIN_CONTRAST) return ok;
  for (let a = OK_STEP; a <= 1.0001; a += OK_STEP) {
    ok = mode === "light"
      ? HolafColor.darken(OK_SEED, a)
      : HolafColor.lighten(OK_SEED, a);
    if (HolafColor.contrastRatio(ok, surface) >= OK_MIN_CONTRAST) return ok;
  }
  throw new Error(`--ok : aucun palier n'atteint ${OK_MIN_CONTRAST}:1 sur ${surface}`);
}

/** Projection d'un preset du catalogue sur les 11 variables de Yuki. */
function project(preset) {
  const surface = p(preset, "surface");
  const accent = p(preset, "accent");
  return {
    bg: surface,
    panel: surface,
    panel2: p(preset, "surface-elev"),
    border: p(preset, "border"),
    text: p(preset, "text"),
    muted: p(preset, "text-muted"),
    accent,
    danger: p(preset, "danger"),
    user: HolafColor.mix(surface, accent, 0.18).toLowerCase(),
    assistant: HolafColor.mix(surface, accent, 0.06).toLowerCase(),
    ok: okColor(surface, preset.name.endsWith("-dark") ? "dark" : "light").toLowerCase(),
  };
  function p(preset, key) {
    const value = HolafTokens.PRESETS[preset.name][key];
    if (!value) throw new Error(`preset ${preset.name} : token « ${key} » absent du catalogue`);
    return value.toLowerCase();
  }
}

/* ─── Calcul + rapport ──────────────────────────────────────────────────── */

const themes = [];
for (const family of FAMILIES) {
  for (const mode of MODES) {
    const name = `${family}-${mode}`;
    const vars = project({ name });
    themes.push({
      name,
      family,
      mode,
      vars,
      ratios: {
        "text/bg": HolafColor.contrastRatio(vars.text, vars.bg),
        "muted/bg": HolafColor.contrastRatio(vars.muted, vars.bg),
        "ok/bg": HolafColor.contrastRatio(vars.ok, vars.bg),
        "danger/bg": HolafColor.contrastRatio(vars.danger, vars.bg),
      },
    });
  }
}

// Cohérence avec la brique modale vendorisée : mêmes noms de presets.
const modalNames = new Set(HolafTokens.listPresets());
for (const t of themes) {
  if (!modalNames.has(t.name)) {
    throw new Error(`preset « ${t.name} » absent du catalogue holaf-tokens`);
  }
}

const ratio = (v) => v.toFixed(2).padStart(6);
console.log("Palettes Yuki — projetées depuis HolafTokens.PRESETS (holaf-lib 0.2.0)");
console.log("Contrastes WCAG (min. exigé : text et muted >= 4.5 ; ok >= 4.5 ; danger info) :");
console.log(
  "preset".padEnd(15),
  "text/bg", "muted/bg", "ok/bg", "danger/bg",
  "| bg", "panel-2", "border", "text", "muted", "accent", "danger", "user", "assistant", "ok",
);
for (const t of themes) {
  const v = t.vars;
  console.log(
    t.name.padEnd(15),
    ratio(t.ratios["text/bg"]),
    ratio(t.ratios["muted/bg"]),
    ratio(t.ratios["ok/bg"]),
    ratio(t.ratios["danger/bg"]),
    "|",
    v.bg, v.panel2, v.border, v.text, v.muted, v.accent, v.danger, v.user, v.assistant, v.ok,
  );
}

/* ─── Écriture de themes.css ─────────────────────────────────────────────── */

function block(t) {
  const v = t.vars;
  return [
    `:root[data-theme="${t.name}"] {`,
    `  color-scheme: ${t.mode};`,
    `  --bg: ${v.bg};`,
    `  --panel: ${v.panel};`,
    `  --panel-2: ${v.panel2};`,
    `  --border: ${v.border};`,
    `  --text: ${v.text};`,
    `  --muted: ${v.muted};`,
    `  --accent: ${v.accent};`,
    `  --danger: ${v.danger};`,
    `  --user: ${v.user};`,
    `  --assistant: ${v.assistant};`,
    `  --ok: ${v.ok};`,
    `}`,
  ].join("\n");
}

const header = `/*
 * Thèmes de l'UI Yuki — FICHIER GÉNÉRÉ, ne pas éditer à la main.
 *
 * Modèle à DEUX AXES : famille (indigo, midnight, slate, emerald, amber) ×
 * mode (light, dark) = 10 presets « <famille>-<mode> ». Les valeurs sont la
 * projection EXACTE du catalogue holaf-lib sur les 11 variables de Yuki :
 *   - surfaces/bordures/textes/accent/danger : HolafTokens.PRESETS
 *     (holaf-lib js/holaf-tokens.js v${HolafTokens.VERSION}, presets miroirs de
 *     la brique modale HolafModal v0.5.0) ;
 *   - graines des familles : indigo ${SEEDS.indigo}, midnight ${SEEDS.midnight},
 *     slate ${SEEDS.slate}, emerald ${SEEDS.emerald}, amber ${SEEDS.amber} ;
 *   - --user      = HolafColor.mix(surface, accent, 0.18)
 *     --assistant = HolafColor.mix(surface, accent, 0.06)
 *     --ok        = graine Yuki ${OK_SEED} ajustée par paliers de 5 %
 *                   (darken en clair / lighten en sombre) jusqu'à
 *                   contrastRatio(ok, surface) >= ${OK_MIN_CONTRAST} (WCAG AA).
 *
 * Provenance / régénération :
 *   script : _tools/generate-yuki-themes.mjs (racine du workspace composite,
 *   HORS des dépôts git — l'artefact, lui, reste commité dans Yuki) ;
 *   commande (depuis le dépôt Yuki) : node ../_tools/generate-yuki-themes.mjs
 *   (régénération idempotente : aucune donnée datée dans la sortie).
 *
 * CSP (style-src 'self') : fichier statique servi sous /ui/themes.css —
 * aucun style n'est injecté dynamiquement par la page.
 */
`;

const controls = `
/* ─── Contrôle de thème (topbar) ─────────────────────────────────────────
 * Deux contrôles aux rôles distincts :
 *   select#theme-family : la FAMILLE (Indigo, Nuit, Ardoise, Émeraude, Ambre) ;
 *   button#theme-toggle : le MODE clair/sombre (conserve la famille).
 * Compact, cohérent avec la topbar ; focus visible (clavier) ; l'état
 * « pressé » du bouton (mode sombre actif) reçoit une teinte accent.
 */

.theme-control {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.theme-control select {
  font: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  cursor: pointer;
}

.theme-control select:hover,
.theme-control select:focus-visible {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
}

.theme-control select:focus-visible,
.theme-control button:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: 1px;
}

.theme-control button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
}

.theme-control button:hover {
  border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
  color: var(--accent);
}

/* Mode sombre actif (aria-pressed="true") : teinte accent discrète. */
.theme-control button[aria-pressed="true"] {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  color: var(--accent);
}
`;

const css = `${header}
${themes.map(block).join("\n\n")}
${controls}
`;

writeFileSync(OUT, css, "utf8");
console.log(`\nÉcrit : ${OUT} (${css.length} caractères)`);