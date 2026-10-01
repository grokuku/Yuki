/*
 * Dérivés de thème de l'UI Yuki — FICHIER GÉNÉRÉ, ne pas éditer à la main.
 *
 * Généré en même temps que themes.css par _tools/generate-yuki-themes.mjs
 * (holaf-lib js/holaf-tokens.js v0.3.0).
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
  "indigo-light": { user: "#dfdefa", assistant: "#f4f4fd", ok: "#317f5a" },
  "indigo-dark": { user: "#2a2b44", assistant: "#22222b", ok: "#4cc38a" },
  "midnight-light": { user: "#dadcf5", assistant: "#edeefa", ok: "#317f5a" },
  "midnight-dark": { user: "#242744", assistant: "#17182a", ok: "#4cc38a" },
  "slate-light": { user: "#d5d9de", assistant: "#eaecef", ok: "#2e7553" },
  "slate-dark": { user: "#343a44", assistant: "#262b33", ok: "#4cc38a" },
  "emerald-light": { user: "#d2e7e1", assistant: "#f0f7f5", ok: "#317f5a" },
  "emerald-dark": { user: "#12372a", assistant: "#0d201a", ok: "#4cc38a" },
  "amber-light": { user: "#f2e0d3", assistant: "#fbf5f0", ok: "#317f5a" },
  "amber-dark": { user: "#43330d", assistant: "#281e0a", ok: "#4cc38a" },
});
