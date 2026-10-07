/*
 * Dérivés de thème de l'UI Yuki — FICHIER GÉNÉRÉ, ne pas éditer à la main.
 *
 * Généré en même temps que themes.css par _tools/generate-yuki-themes.mjs
 * (holaf-lib js/holaf-tokens.js v0.4.1).
 *
 * Yuki enregistre un PACK HÔTE `yuki-<famille>-<mode>` par preset (voir
 * public/ui/theme.js) : ce pack `extends` le preset INTÉGRÉ homonyme de la
 * brique (toute la palette standard) et n'ajoute QUE ces 3 dérivés, propres
 * à Yuki et SANS token standard dans la brique :
 *   user      = mix(surface, accent, 0.18)
 *   assistant = mix(surface, accent, 0.06)
 *   ok        = graine Yuki #4cc38a ajustée jusqu'à >= 4.5:1 sur surface
 *
 * Les valeurs sont EXACTEMENT celles des replis de themes.css : rien n'est
 * perdu, et le rendu ne dépend pas de la présence de la brique.
 */

export const YUKI_THEME_DERIVED = Object.freeze({
  "corail-light": { user: "#edbbd3", assistant: "#f9d6e4", ok: "#2e7553" },
  "corail-dark": { user: "#593545", assistant: "#422a34", ok: "#4cc38a" },
  "ambre-light": { user: "#cab194", assistant: "#d6c0aa", ok: "#22583e" },
  "ambre-dark": { user: "#351f08", assistant: "#1a0d03", ok: "#4cc38a" },
  "emeraude-light": { user: "#acc5a1", assistant: "#bfd3b8", ok: "#266245" },
  "emeraude-dark": { user: "#1d3116", assistant: "#0f1b0b", ok: "#4cc38a" },
  "turquoise-light": { user: "#a1cbd2", assistant: "#b8dae1", ok: "#2a6b4c" },
  "turquoise-dark": { user: "#073941", assistant: "#06242a", ok: "#4cc38a" },
  "amethyste-light": { user: "#c5c4ed", assistant: "#d6d7f6", ok: "#2a6b4c" },
  "amethyste-dark": { user: "#363754", assistant: "#26273b", ok: "#4cc38a" },
  "neutre-light": { user: "#d5d7d9", assistant: "#e8eaec", ok: "#2e7553" },
  "neutre-dark": { user: "#4a4b4e", assistant: "#3b3c3f", ok: "#4cc38a" },
});
