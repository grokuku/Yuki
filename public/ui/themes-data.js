/*
 * Dérivés de thème de l'UI Yuki — FICHIER GÉNÉRÉ, ne pas éditer à la main.
 *
 * Généré en même temps que themes.css par _tools/generate-yuki-themes.mjs
 * (holaf-lib js/holaf-tokens.js v0.6.0).
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
  "corail-light": { user: "#dfc4d4", assistant: "#e9e0e5", ok: "#2e7553" },
  "corail-dark": { user: "#402a33", assistant: "#251d20", ok: "#4cc38a" },
  "ambre-light": { user: "#d9d0c3", assistant: "#e7e4e0", ok: "#2e7553" },
  "ambre-dark": { user: "#3e2f1b", assistant: "#241f18", ok: "#4cc38a" },
  "emeraude-light": { user: "#cad6c3", assistant: "#e2e6e0", ok: "#2e7553" },
  "emeraude-dark": { user: "#2a3725", assistant: "#1d221c", ok: "#4cc38a" },
  "turquoise-light": { user: "#c4d4d7", assistant: "#e0e5e6", ok: "#2e7553" },
  "turquoise-dark": { user: "#15373b", assistant: "#162223", ok: "#4cc38a" },
  "amethyste-light": { user: "#d1cfe3", assistant: "#e4e4ea", ok: "#2e7553" },
  "amethyste-dark": { user: "#303041", assistant: "#1f1f25", ok: "#4cc38a" },
  "neutre-light": { user: "#d2d2d3", assistant: "#e5e5e5", ok: "#2e7553" },
  "neutre-dark": { user: "#323333", assistant: "#202020", ok: "#4cc38a" },
});
