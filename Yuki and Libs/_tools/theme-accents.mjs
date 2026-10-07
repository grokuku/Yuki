/**
 * MAQUETTE JETABLE (hors production) — JEUX D'ACCENTS des familles de thème.
 *
 * Ce module ne touche AUCUNE production (ni Yuki, ni holaf-lib). Il produit :
 *   - les DÉFINITIONS des variantes d'accents V0/V1/V2/V3 ;
 *   - la construction des surfaces direction-C associées (familles REF et WHEEL) ;
 *   - la MESURE (contraste texte/accent, accent/surface non textuel, écarts ΔEok)
 *     et la GARDE automatique qui fait ÉCHOUER le générateur en cas de violation.
 *
 * Vocabulaire :
 *   - FAMILLE   = un jeu de surfaces + un accent (ex. « Améthyste ») ;
 *   - RÔLE      = position d'une famille dans un jeu (les variantes changent les
 *                 couleurs mais gardent la même place visuelle pour comparer).
 *
 * Primitives couleur : ./theme-lib.mjs (aucune dépendance, aucun réseau).
 */

import { contrast, hexToRgb, mix, oklch, rgbToOklab, toOklch } from "./theme-lib.mjs";

/* ═══════════════════════════════════════════════════════════════════════════
 * 0. Seuils (mesurés, jamais affirmés)
 * ═════════════════════════════════════════════════════════════════════════ */

/** Contraste WCAG exigé sur le texte posé SUR un aplat d'accent (WCAG 1.4.3 AA). */
export const AA_TEXT = 4.5;
/** Contraste minimal d'un élément NON textuel porteur de sens (WCAG 1.4.11). */
export const AA_NONTEXT = 3.0;
/** Écart perceptuel minimal entre deux accents d'un même mode (Ø JND OKLab = 0.02). */
export const ACCENT_SEP = 0.040;
/** Écart perceptuel minimal entre deux fonds de familles d'un même mode (2× JND). */
export const SURFACE_SEP = 0.040;
/** Écart perceptuel minimal entre deux paliers de profondeur (1× JND). */
export const DEPTH_SEP = 0.020;

/** Distance perceptuelle OKLab (ΔEok : 0,02 ≈ « juste perceptible »). */
export function deltaEok(a, b) {
  const A = rgbToOklab(hexToRgb(a));
  const B = rgbToOklab(hexToRgb(b));
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}

/** Couleur de texte lisible SUR un aplat d'accent : le blanc ou un quasi-noir,
 *  celui qui offre le MEILLEUR contraste (jamais d'à-peu-près : la garde vérifie). */
export function onAccentColor(accent) {
  const white = contrast("#ffffff", accent);
  const ink = contrast("#0b0b12", accent);
  return white >= ink ? "#ffffff" : "#0b0b12";
}

/** Réparation minimale d'un accent (emprunté à une source externe) pour qu'il
 *  tienne À LA FOIS ≥ 4,5:1 en texte-sur-accent ET ≥ 4,5:1 en accent-sur-surface.
 *  En mode clair on ASSOMBRIT l'accent, en mode sombre on l'ÉCLAIRCIT : la
 *  monotonie garantit la terminaison (et on borne le nombre de pas). */
export function repairAccent(accent, surface, mode) {
  const ok = (a) => contrast(onAccentColor(a), a) >= AA_TEXT && contrast(a, surface) >= AA_TEXT;
  if (ok(accent)) return { hex: accent, steps: 0 };
  const toward = mode === "light" ? "#000000" : "#ffffff";
  let a = accent;
  for (let i = 1; i <= 40; i++) {
    a = mix(accent, toward, i / 40);
    if (ok(a)) return { hex: a, steps: i };
  }
  return { hex: a, steps: 40 };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. Familles REF (libellés ACTUELS) — support des variantes de référence V0/V1
 * ═════════════════════════════════════════════════════════════════════════ */

/* Graines d'origine (= accents de public/ui/themes.css), la clarté/chroma de
 * fond reprend la direction C validée (séparation des 3 familles bleutées). */
export const FAMILIES_REF = [
  { id: "indigo",   label: "Indigo",   seed: { dark: "#6366f1", light: "#4f46e5" }, darkL: 0.205, dC: 0.010, lightL: 0.925, lC: 0.030 },
  { id: "midnight", label: "Nuit",     seed: { dark: "#818cf8", light: "#5b63d3" }, darkL: 0.135, dC: 0.014, lightL: 0.850, lC: 0.024 },
  { id: "slate",    label: "Ardoise",  seed: { dark: "#94a3b8", light: "#475569" }, darkL: 0.290, dC: 0.007, lightL: 0.962, lC: 0.005 },
  { id: "emerald",  label: "Émeraude", seed: { dark: "#34d399", light: "#047857" }, darkL: 0.245, dC: 0.013, lightL: 0.900, lC: 0.030 },
  { id: "amber",    label: "Ambre",    seed: { dark: "#fbbf24", light: "#b45309" }, darkL: 0.165, dC: 0.017, lightL: 0.880, lC: 0.032 },
];

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. Familles WHEEL (NOUVEAUX NOMS) — support de V2/V3
 * ═════════════════════════════════════════════════════════════════════════ */

/* Cinq teintes RÉGULIÈREMENT ESPACÉES (72° sur la roue OKLCH) + une famille
 * NEUTRE assumée. Les noms sont des minéraux/ambiances français, courts et
 * non trompeurs : chaque famille = une teinte franche, facile à reconnaître.
 *   Ambre 66° · Émeraude 138° · Turquoise 210° · Améthyste 282° · Corail 354°
 * La clarté de fond décroît par pas constants : c'est ELLE qui garantit que les
 * fonds restent distincts malgré le chroma très faible (direction C). */
export const FAMILIES_WHEEL = [
  //          id            libellé        H(°)  fond sombre            fond clair
  { id: "corail",    label: "Corail",    hue: 354, darkL: 0.288, dC: 0.028, lightL: 0.941, lC: 0.034 },
  { id: "ambre",     label: "Ambre",     hue: 66,  darkL: 0.120, dC: 0.028, lightL: 0.845, lC: 0.034 },
  { id: "emeraude",  label: "Émeraude",  hue: 138, darkL: 0.162, dC: 0.028, lightL: 0.869, lC: 0.034 },
  { id: "turquoise", label: "Turquoise", hue: 210, darkL: 0.204, dC: 0.028, lightL: 0.893, lC: 0.034 },
  { id: "amethyste", label: "Améthyste", hue: 282, darkL: 0.246, dC: 0.028, lightL: 0.917, lC: 0.034 },
  { id: "neutre",    label: "Neutre",    hue: 250, darkL: 0.330, dC: 0.003, lightL: 0.965, lC: 0.003 },
];

/** Ordre d'affichage stable (par teinte, le Neutre en dernier). */
export const WHEEL_ORDER = ["corail", "ambre", "emeraude", "turquoise", "amethyste", "neutre"];

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. Variantes d'accents V0/V1/V2/V3
 * ═════════════════════════════════════════════════════════════════════════ */

/* V0 — ACTUELS : graines exactes de themes.css. Référence, NON conforme :
 *   - Indigo sombre #6366f1 : ni blanc (4,47:1) ni quasi-noir (4,25:1) n'atteint
 *     le seuil 4,5:1 → texte-sur-accent illisible (défaut historique).
 *   - Indigo et Nuit sont deux violet-bleu quasi identiques (teinte −83° pour les
 *     deux) : les accents ne séparent pas les familles.
 *   - Ardoise a un accent GRIS : aucune identité chromatique. */
const ACCENTS_V0 = {
  indigo:   { dark: "#6366f1", light: "#4f46e5" },
  midnight: { dark: "#818cf8", light: "#5b63d3" },
  slate:    { dark: "#94a3b8", light: "#475569" },
  emerald:  { dark: "#34d399", light: "#047857" },
  amber:    { dark: "#fbbf24", light: "#b45309" },
};

/* V1 — MÊMES TEINTES RÉPARÉES : on garde les 5 familles actuelles, on ÉCARTE
 *   Indigo (violet 292°) de Nuit (bleu 252°) de ~40° et on cale la clarté de
 *   chaque accent par mode (sombre clair → texte encre ; clair sombre → texte
 *   blanc) pour garantir ≥ 4,5:1 partout. Surfaces INCHANGÉES (celles de REF),
 *   pour isoler l'effet accent. Ardoise reste un gris, mais un peu plus ardoise
 *   (chroma 0,05-0,06) pour cesser d'être un gris mort. */
const ACCENTS_V1 = {
  indigo:   { hue: 292, dL: 0.720, dC: 0.160, lL: 0.470, lC: 0.220 },
  midnight: { hue: 252, dL: 0.720, dC: 0.140, lL: 0.430, lC: 0.160 },
  slate:    { hue: 240, dL: 0.740, dC: 0.050, lL: 0.450, lC: 0.060 },
  emerald:  { hue: 160, dL: 0.760, dC: 0.140, lL: 0.450, lC: 0.110 },
  amber:    { hue: 76,  dL: 0.790, dC: 0.150, lL: 0.460, lC: 0.130 },
};

/* V2 — ROUE RÉGULIÈRE (piste principale) : 5 teintes à 72° + Neutre.
 *   L'accent reprend la TEINTE de la famille ; seule la clarté/chroma sont
 *   normées par mode (sombre clair → encre ; clair sombre → blanc). Neutre = gris
 *   franc (chroma 0,006), assumé et nommé, donc sans ambiguïté. */
const ACCENTS_V2 = {
  corail:    { dark: { L: 0.750, C: 0.160 }, light: { L: 0.455, C: 0.185 } },
  ambre:     { dark: { L: 0.760, C: 0.155 }, light: { L: 0.450, C: 0.150 } },
  emeraude:  { dark: { L: 0.760, C: 0.150 }, light: { L: 0.455, C: 0.150 } },
  turquoise: { dark: { L: 0.760, C: 0.130 }, light: { L: 0.450, C: 0.150 } },
  amethyste: { dark: { L: 0.750, C: 0.150 }, light: { L: 0.455, C: 0.170 } },
  neutre:    { dark: { L: 0.760, C: 0.006 }, light: { L: 0.445, C: 0.006 } },
};

/* V3 — CATPPUCCIN (source permissive MIT, 4 saveurs : Latte clair / Mocha sombre).
 *   Jeu emprunté TEL QUEL, puis RÉPARÉ au minimum (repairAccent) là où le seuil
 *   n'était pas tenu sur nos surfaces : les valeurs d'origine sont conservées
 *   dans `source` pour la traçabilité. Ardoise → Neutre reçoit le gris OVERLAY
 *   de Catppuccin (pas d'accent chromatique dans la source). */
const ACCENTS_V3 = {
  corail:    { source: { dark: "#f38ba8", light: "#d20f39" } }, // Mocha red  / Latte red
  ambre:     { source: { dark: "#f9e2af", light: "#df8e1d" } }, // Mocha yellow / Latte yellow
  emeraude:  { source: { dark: "#a6e3a1", light: "#40a02b" } }, // Mocha green / Latte green
  turquoise: { source: { dark: "#74c7ec", light: "#209fb5" } }, // Mocha sapphire / Latte sapphire
  amethyste: { source: { dark: "#cba6f7", light: "#8839ef" } }, // Mocha mauve / Latte mauve
  neutre:    { source: { dark: "#7f849c", light: "#8c8fa1" } }, // Mocha overlay1 / Latte overlay1
};

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. Construction des surfaces (direction C) pour chaque jeu de familles
 * ═════════════════════════════════════════════════════════════════════════ */

/** Surfaces direction-C d'une famille (REF : teinte du seed ; WHEEL : teinte imposée). */
export function familySurfaces(fam, mode) {
  const H = fam.hue != null ? fam.hue : toOklch(fam.seed[mode]).H;
  const L = mode === "dark" ? fam.darkL : fam.lightL;
  const C = mode === "dark" ? fam.dC : fam.lC;
  if (mode === "dark") {
    const surface = oklch(L, C, H);
    return {
      surface,
      elev: oklch(L + 0.045, C + 0.002, H),
      raised: oklch(L + 0.090, C + 0.004, H),
      hover: oklch(L + 0.135, C + 0.006, H),
      border: oklch(L + 0.205, C + 0.010, H),
      text: oklch(0.955, 0.006, H),
      muted: oklch(0.735, C + 0.006, H),
    };
  }
  return {
    surface: oklch(L, C, H),
    elev: oklch(0.998, C * 0.3, H),
    raised: oklch(L - 0.030, C, H),
    hover: oklch(L - 0.060, C, H),
    border: oklch(L - 0.125, C + 0.006, H),
    text: oklch(0.27, 0.020, H),
    muted: oklch(0.46, 0.030, H),
  };
}

/* V3 : la surface dépend de la famille WHEEL ; l'accent emprunté est réparé
 * contre CETTE surface. On précalcule donc les accents V3 par famille/mode. */
function accentHexFor(variantId, fam, mode) {
  if (variantId === "v0") return ACCENTS_V0[fam.id][mode];
  if (variantId === "v1") {
    const p = ACCENTS_V1[fam.id];
    return oklch(mode === "dark" ? p.dL : p.lL, mode === "dark" ? p.dC : p.lC, p.hue);
  }
  if (variantId === "v2") {
    const p = ACCENTS_V2[fam.id][mode];
    return oklch(p.L, p.C, fam.hue);
  }
  if (variantId === "v3") {
    const surf = familySurfaces(fam, mode).surface;
    return repairAccent(ACCENTS_V3[fam.id].source[mode], surf, mode).hex;
  }
  throw new Error(`variante inconnue : ${variantId}`);
}

/** Source brute d'un accent V3 (pour signaler la réparation dans la maquette). */
export function v3SourceHex(fam, mode) {
  return ACCENTS_V3[fam.id].source[mode];
}

/** Vrai si l'accent V3 a dû être réparé pour ce mode. */
export function v3WasRepaired(fam, mode) {
  return v3SourceHex(fam, mode) !== accentHexFor("v3", fam, mode);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. Les variantes (métadonnées + familles)
 * ═════════════════════════════════════════════════════════════════════════ */

export const VARIANTS = [
  {
    id: "v0", familySet: "ref", recommended: false, conformant: false,
    label: "V0 — accents ACTUELS",
    tagline: "Référence (thèmes en production) — NON conforme",
    idea: "Les graines exactes de themes.css, posées sur les surfaces direction C.",
    fixes: "Rien : sert d'étalon de comparaison et de preuve des défauts.",
    cost: "Indigo↔Nuit quasi confondus ; Ardoise sans identité ; texte sur l'accent Indigo sombre à 4,25:1 (< 4,5:1).",
  },
  {
    id: "v1", familySet: "ref", recommended: true, conformant: true,
    label: "V1 — mêmes teintes, séparées + lisibles",
    tagline: "Conservateur : on répare, on ne change pas d'identité",
    idea: "Garder les 5 familles actuelles ; écarter Indigo (violet 292°) et Nuit (bleu 252°), et caler la clarté de chaque accent par mode.",
    fixes: "Sépare Indigo/Nuit (~40° de teinte) ; ≥ 4,5:1 partout ; Ardoise légèrement plus chromatique.",
    cost: "Renonce à la roue régulière : deux familles restent bleutées ; Ardoise reste un gris.",
  },
  {
    id: "v2", familySet: "wheel", recommended: true, conformant: true,
    label: "V2 — roue régulière (piste principale)",
    tagline: "5 teintes à 72° + 1 Neutre — distinction par construction",
    idea: "Cinq teintes régulièrement espacées sur la roue (Corail, Ambre, Émeraude, Turquoise, Améthyste) + une famille Neutre assumée.",
    fixes: "Aucune famille ne peut être confondue (écart garanti par la géométrie) ; accents d'identité franche ; Neutre nommé.",
    cost: "Change les NOMS et les TEINTES : les presets actuels (indigo/nuit/ardoise…) deviennent obsolètes ; 6 familles au lieu de 5.",
  },
  {
    id: "v3", familySet: "wheel", recommended: false, conformant: true,
    label: "V3 — jeu emprunté (Catppuccin, MIT)",
    tagline: "Source permissive éprouvée, réparée au minimum",
    idea: "Accents Catppuccin (Latte clair / Mocha sombre) plaqués sur les familles V2, puis réparés au strict nécessaire pour tenir 4,5:1.",
    fixes: "Qualité éprouvée de la source ; cohérence clair/sombre fournie par les 2 saveurs.",
    cost: "La source n'est PAS une roue régulière (écarts d'accent inégaux) et plusieurs valeurs échouent telles quelles → réparation requise.",
  },
];

export function variantFamilies(variant) {
  return variant.familySet === "wheel" ? FAMILIES_WHEEL : FAMILIES_REF;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 6. Audit + garde
 * ═════════════════════════════════════════════════════════════════════════ */

const DEPTH_STEPS = [
  ["surface→elev", "surface", "elev"],
  ["elev→raised", "elev", "raised"],
  ["raised→hover", "raised", "hover"],
];

/** Audit d'un jeu d'accents générique (résolveur accent → familles → modes). */
export function auditWith(accentResolver, fams, id) {
  const out = { id, modes: {} };
  for (const mode of ["dark", "light"]) {
    const rows = fams.map((fam) => {
      const surf = familySurfaces(fam, mode);
      const accent = accentResolver(fam, mode);
      const on = onAccentColor(accent);
      return {
        id: fam.id, label: fam.label, hue: fam.hue,
        accent, onAccent: on, surface: surf,
        onAccentRatio: contrast(on, accent),
        linkRatio: contrast(accent, surf.surface),
        nonTextRatio: contrast(accent, surf.surface), // anneau de focus = accent sur fond
        depth: DEPTH_STEPS.map(([name, ka, kb]) => ({ name, d: deltaEok(surf[ka], surf[kb]) })),
        v3source: id === "v3" ? v3SourceHex(fam, mode) : null,
        v3repaired: id === "v3" ? v3WasRepaired(fam, mode) : false,
      };
    });
    // paires
    let minAccent = Infinity, minAccentPair = "";
    let minBg = Infinity, minBgPair = "";
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const da = deltaEok(rows[i].accent, rows[j].accent);
        const db = deltaEok(rows[i].surface.surface, rows[j].surface.surface);
        const pair = `${rows[i].label}↔${rows[j].label}`;
        if (da < minAccent) { minAccent = da; minAccentPair = pair; }
        if (db < minBg) { minBg = db; minBgPair = pair; }
      }
    }
    const minOn = Math.min(...rows.map((r) => r.onAccentRatio));
    const minLink = Math.min(...rows.map((r) => r.linkRatio));
    const minDepth = Math.min(...rows.flatMap((r) => r.depth.map((d) => d.d)));
    out.modes[mode] = { rows, minAccent, minAccentPair, minBg, minBgPair, minOn, minLink, minDepth };
  }
  return out;
}

/** Audit complet d'une variante : par mode, mesures par famille + minimums. */
export function auditVariant(variant) {
  return auditWith((fam, mode) => accentHexFor(variant.id, fam, mode), variantFamilies(variant), variant.id);
}

/** ⚠️ SELFTEST — jeu d'accents VOLONTAIREMENT MAUVAIS, pour prouver que la garde
 *  n'est pas vacue. En mode sombre : les 6 accents reçoivent le MÊME gris moyen
 *  (#787878) → écart d'accent NUL, texte-sur-accent à 4,44:1 (< 4,5) et
 *  accent-sur-fond insuffisant. Le mode clair reste celui de V2 (conforme) : les
 *  violations doivent donc provenir du seul mode sombre saboté. */
export function selftestBadAudit() {
  return auditWith(
    (fam, mode) => (mode === "dark" ? "#787878" : accentHexFor("v2", fam, mode)),
    FAMILIES_WHEEL,
    "selftest",
  );
}

/** Vérifie UN jeu audité et renvoie la liste des violations (vide = conforme). */
export function checkAudit(id, audit) {
  const v = [];
  for (const mode of ["dark", "light"]) {
    const m = audit.modes[mode];
    if (m.minAccent < ACCENT_SEP) v.push({ kind: "accent-proches", who: `${id}/${mode} ${m.minAccentPair}`, value: m.minAccent, min: ACCENT_SEP });
    if (m.minBg < SURFACE_SEP) v.push({ kind: "fonds-proches", who: `${id}/${mode} ${m.minBgPair}`, value: m.minBg, min: SURFACE_SEP });
    if (m.minOn < AA_TEXT) v.push({ kind: "texte-sur-accent", who: `${id}/${mode}`, value: m.minOn, min: AA_TEXT });
    if (m.minLink < AA_TEXT) v.push({ kind: "accent-sur-fond", who: `${id}/${mode}`, value: m.minLink, min: AA_TEXT });
    if (m.minDepth < DEPTH_SEP) v.push({ kind: "profondeur", who: `${id}/${mode}`, value: m.minDepth, min: DEPTH_SEP });
    // non textuel : l'anneau de focus (accent sur fond) doit tenir 3:1
    if (m.minLink < AA_NONTEXT) v.push({ kind: "non-textuel", who: `${id}/${mode}`, value: m.minLink, min: AA_NONTEXT });
  }
  return v;
}

/** Vérifie une variante (raccourci). */
export function checkVariant(variant, audit) {
  return checkAudit(variant.id, audit);
}

/** Audit de toutes les variantes (cache). */
export function auditAll() {
  return Object.fromEntries(VARIANTS.map((vr) => [vr.id, auditVariant(vr)]));
}
