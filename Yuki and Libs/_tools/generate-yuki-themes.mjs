#!/usr/bin/env node
/**
 * GÉNÉRATEUR JETABLE — palettes Yuki (LOT B, modèle à deux axes).
 *
 * Situation : ce script vit à la racine du workspace composite
 * (« /projects/Yuki/Yuki and Libs »), HORS des deux dépôts git (Yuki et
 * holaf-lib). Il importe le catalogue holaf-lib et écrit l'artefact généré
 * `Yuki/public/ui/themes.css` (qui reste commité dans Yuki).
 *
 * Source de vérité des palettes : `HolafTokens.PRESETS` (holaf-tokens 0.3.0),
 * c'est-à-dire EXACTEMENT le catalogue holaf-lib (5 familles × 2 modes). Les
 * 4 palettes historiques (indigo/midnight/slate × dark + indigo-light) y sont
 * figées à l'identique ; midnight-light, slate-light, emerald-* et amber-*
 * sont générées par le catalogue. Aucune palette n'est réinventée ici.
 *
 * Doctrine « ALIAS + REPLI » (identique à l'unification Pi-Web) : chaque
 * variable de Yuki POINTE sur un token `--holaf-*` posé au runtime par la
 * brique, avec la valeur d'avant l'unification en 2e argument de `var()` :
 *   --bg / --panel  ← --holaf-surface        (fond de page du catalogue)
 *   --panel-2       ← --holaf-surface-elev   (surface surélevée)
 *   --border        ← --holaf-border
 *   --text          ← --holaf-text           --muted ← --holaf-text-muted
 *   --accent        ← --holaf-accent         --danger ← --holaf-danger
 *   --user          ← --holaf-user      (pack hôte Yuki, dérivé non standard)
 *   --assistant     ← --holaf-assistant (pack hôte Yuki, dérivé non standard)
 *   --ok            ← --holaf-ok        (pack hôte Yuki, dérivé non standard)
 * Ainsi, brique chargée OU PAS, l'apparence est STRICTEMENT identique (le
 * repli vaut exactement la valeur que la brique repose).
 *
 * Dérivés non standard de Yuki (enregistrés comme PACKS HÔTE `yuki-<fam>-<mode>`
 * par `public/ui/theme.js`, cf. `themes-data.js`) :
 *   --user      = HolafColor.mix(surface, accent, 0.18)
 *   --assistant = HolafColor.mix(surface, accent, 0.06)
 *   --ok       = graine Yuki #4cc38a ajustée par paliers ADDITIFS de 5 %
 *                (lighten vers blanc en mode sombre, darken vers noir en
 *                mode clair) jusqu'à contrastRatio(ok, surface) >= 4.5 (WCAG AA).
 *
 * Deux artefacts sont écrits (tous deux commités dans Yuki) :
 *   - public/ui/themes.css      : les 10 presets en ALIAS + repli + contrôle ;
 *   - public/ui/themes-data.js  : les seuls dérivés à fournir au pack hôte
 *                                 ({ user, assistant, ok } par preset).
 *
 * Usage :  node _tools/generate-yuki-themes.mjs
 * Sortie : table de rapport sur stdout + écriture des deux artefacts.
 *
 * Idempotent : aucune date ni valeur volatille n'est écoute, deux exécutions
 * successives produisent des fichiers identiques octet pour octet.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HolafColor } from "../holaf-lib/js/holaf-color.js";
// holaf-tokens 0.3.0 : plus d'export ESM nommé — l'import par effet de bord
// exécute la brique, qui s'expose sur window (navigateur) ou globalThis (Node).
import "../holaf-lib/js/holaf-tokens.js";
const HolafTokens = globalThis.HolafTokens || window.HolafTokens;

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIR = join(HERE, "..", "Yuki", "public", "ui");
const OUT = join(UI_DIR, "themes.css");
const DATA_OUT = join(UI_DIR, "themes-data.js");

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

/** Projection d'un preset du catalogue sur les variables de Yuki. */
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
console.log(`Palettes Yuki — projetées depuis HolafTokens.PRESETS (holaf-lib ${HolafTokens.VERSION})`);
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

/* Correspondance Yuki → token holaf (doctrine « alias + repli »).
 * [variable CSS de Yuki, token --holaf-*, clé du projet]. La valeur de repli
 * est `v[clé]` : la valeur d'AVANT l'unification, calculée ci-dessus. */
const ALIAS = [
  ["--bg", "holaf-surface", "bg"],
  ["--panel", "holaf-surface", "panel"],
  ["--panel-2", "holaf-surface-elev", "panel2"],
  ["--border", "holaf-border", "border"],
  ["--text", "holaf-text", "text"],
  ["--muted", "holaf-text-muted", "muted"],
  ["--accent", "holaf-accent", "accent"],
  ["--danger", "holaf-danger", "danger"],
  ["--user", "holaf-user", "user"],
  ["--assistant", "holaf-assistant", "assistant"],
  ["--ok", "holaf-ok", "ok"],
];

function block(t) {
  const v = t.vars;
  return [
    `:root[data-theme="${t.name}"] {`,
    `  color-scheme: ${t.mode};`,
    ...ALIAS.map(([cssVar, token, key]) => `  ${cssVar}: var(--${token}, ${v[key]});`),
    `}`,
  ].join("\n");
}

const header = `/*
 * Thèmes de l'UI Yuki — FICHIER GÉNÉRÉ, ne pas éditer à la main.
 *
 * Modèle à DEUX AXES : famille (indigo, midnight, slate, emerald, amber) ×
 * mode (light, dark) = 10 presets « <famille>-<mode> ».
 *
 * DOCTRINE « ALIAS + REPLI » (comme Pi-Web) : ces variables ne portent plus
 * de couleur littérale, elles POINTENT sur les tokens --holaf-* posés au
 * runtime par la brique holaf-tokens v${HolafTokens.VERSION} (via le pack hôte
 * « yuki-<famille>-<mode> », voir public/ui/theme.js et themes-data.js) :
 *   - surfaces/bordures/textes/accent/danger : preset INTÉGRÉ <famille>-<mode>
 *     de la brique (HolafTokens) ;
 *   - --user / --assistant / --ok : dérivés propres à Yuki, portés par le pack
 *     hôte (themes-data.js) ;
 *   - le 2e argument de var() est le REPLI : la valeur d'avant l'unification,
 *     calculée ci-dessous. Si la brique ne se charge pas, le rendu reste
 *     STRICTEMENT identique.
 *
 * Rapport de projection (valeurs de repli) :
 *   --bg / --panel  ← surface        --panel-2 ← surface-elev
 *   --border        ← border
 *   --text          ← text           --muted   ← text-muted
 *   --accent        ← accent         --danger  ← danger
 *   --user      = HolafColor.mix(surface, accent, 0.18)
 *   --assistant = HolafColor.mix(surface, accent, 0.06)
 *   --ok        = graine Yuki ${OK_SEED} ajustée par paliers de 5 %
 *                 (darken en clair / lighten en sombre) jusqu'à
 *                 contrastRatio(ok, surface) >= ${OK_MIN_CONTRAST} (WCAG AA).
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

/* ─── themes-data.js — dérivés non standard à fournir au PACK HÔTE ──────
 * theme.js enregistre un pack hôte `yuki-<famille>-<mode>` qui `extends` le
 * preset intégré `<famille>-<mode>` de la brique (qui porte alors TOUT le
 * vocabulaire standard : surface, border, text, accent, danger…) et n'ajoute
 * QUE les 3 dérivés propres à Yuki (user, assistant, ok — sans équivalent
 * standard dans la brique). Ce sont ces 3 valeurs que l'on émet ici : elles
 * sont calculées une seule fois, dans le même passage que les replis de
 * themes.css → les deux sources coïncident au bit près.
 */
const dataHeader = `/*
 * Dérivés de thème de l'UI Yuki — FICHIER GÉNÉRÉ, ne pas éditer à la main.
 *
 * Généré en même temps que themes.css par _tools/generate-yuki-themes.mjs
 * (holaf-lib js/holaf-tokens.js v${HolafTokens.VERSION}).
 *
 * Yuki enregistre un PACK HÔTE \`yuki-<famille>-<mode>\` par preset (voir
 * public/ui/theme.js) : ce pack \`extends\` le preset INTÉGRÉ homonyme de la
 * brique (toute la palette standard) et n'ajoute QUE ces 3 dérivés, propres
 * à Yuki et SANS token standard dans la brique :
 *   user      = mix(surface, accent, 0.18)
 *   assistant = mix(surface, accent, 0.06)
 *   ok        = graine Yuki ${OK_SEED} ajustée jusqu'à >= ${OK_MIN_CONTRAST}:1 sur surface
 *
 * Les valeurs sont EXACTEMENT celles des replis de themes.css : rien n'est
 * perdu, et le rendu ne dépend pas de la présence de la brique.
 */
`;

const dataObject = [
  "export const YUKI_THEME_DERIVED = Object.freeze({",
  ...themes.map((t) => {
    const v = t.vars;
    return `  "${t.name}": { user: "${v.user}", assistant: "${v.assistant}", ok: "${v.ok}" },`;
  }),
  "});",
  "",
].join("\n");

const dataJs = `${dataHeader}\n${dataObject}`;
writeFileSync(DATA_OUT, dataJs, "utf8");
console.log(`Écrit : ${DATA_OUT} (${dataJs.length} caractères)`);
