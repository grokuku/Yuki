/**
 * Bibliothèque couleur partagée des MAQUETTES de thème (hors production).
 *
 * Ce module ne touche RIEN de la production : il factorise uniquement les
 * primitives de couleur (sRGB ↔ OKLab/OKLCH, mix perceptuel, contraste WCAG)
 * et les deux fabriques de palette utilisées par les générateurs de maquette
 * `theme-proposal.mjs` (comparaison large) et `theme-proposal-c.mjs`
 * (focalisation sur la direction C).
 *
 * Aucune dépendance, aucun réseau, aucune écriture de fichier.
 */

/* ═══════════════════════════════════════════════════════════════════════════
 * sRGB ↔ linéaire ↔ OKLab/OKLCH, mix, contraste WCAG
 * ═════════════════════════════════════════════════════════════════════════ */

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
export function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}
export function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}
export function rgbToHex([r, g, b]) {
  const to = (v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function rgbToOklab([r, g, b]) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  const l = 0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B;
  const m = 0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B;
  const s = 0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}
export function oklabToRgb([L, a, b]) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [linearToSrgb(R), linearToSrgb(G), linearToSrgb(B)];
}

/** Couleur depuis OKLCH ; réduit le chroma si le résultat sort du gamut sRGB. */
export function oklch(L, C, H) {
  const rad = (H * Math.PI) / 180;
  for (let c = C; c >= 0; c -= 0.002) {
    const rgb = oklabToRgb([L, c * Math.cos(rad), c * Math.sin(rad)]);
    if (rgb.every((v) => v >= -0.001 && v <= 1.001)) return rgbToHex(rgb.map(clamp01));
  }
  return rgbToHex(oklabToRgb([L, 0, 0]).map(clamp01));
}
export function toOklch(hex) {
  const [L, a, b] = rgbToOklab(hexToRgb(hex));
  return { L, C: Math.hypot(a, b), H: (Math.atan2(b, a) * 180) / Math.PI };
}

/** Mélange de deux hex en OKLab (perceptuellement régulier). */
export function mix(hexA, hexB, t) {
  const A = rgbToOklab(hexToRgb(hexA));
  const B = rgbToOklab(hexToRgb(hexB));
  return rgbToHex(oklabToRgb(A.map((v, i) => v + (B[i] - v) * t)));
}

export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Texte lisible sur un fond d'accent (blanc si >= 4.5:1, sinon quasi-noir). */
export function readableOn(accent) {
  return contrast("#ffffff", accent) >= 4.5 ? "#ffffff" : "#101014";
}

/* ═══════════════════════════════════════════════════════════════════════════
 * Fabriques de palette (surfaces)
 * ═════════════════════════════════════════════════════════════════════════ */

/** Rampe de gris purs (chroma OKLCH 0), seule la couleur d'accent change. */
export function grayPalette(accent, mode) {
  if (mode === "dark") {
    const bg = oklch(0.205, 0, 0);
    return {
      bg, panel: bg,
      elev: oklch(0.25, 0, 0),
      raised: oklch(0.295, 0, 0),
      hover: oklch(0.345, 0, 0),
      border: oklch(0.39, 0, 0),
      text: oklch(0.955, 0, 0),
      muted: oklch(0.72, 0, 0),
      accent,
      danger: "#f87171",
      ok: "#4cc38a",
      user: mix(bg, accent, 0.18),
      assistant: mix(bg, accent, 0.06),
    };
  }
  const bg = "#ffffff";
  return {
    bg, panel: bg,
    elev: oklch(0.972, 0, 0),
    raised: oklch(0.945, 0, 0),
    hover: oklch(0.915, 0, 0),
    border: oklch(0.86, 0, 0),
    text: oklch(0.22, 0, 0),
    muted: oklch(0.47, 0, 0),
    accent,
    danger: "#dc2626",
    ok: "#317f5a",
    user: mix(bg, accent, 0.14),
    assistant: mix(bg, accent, 0.05),
  };
}

/** Surfaces à chroma très faible (teinte = accent), 3 niveaux + survol. */
export function tintedPalette(accent, mode, over = {}) {
  const { H } = toOklch(accent);
  if (mode === "dark") {
    const L = over.L ?? 0.20;
    const bg = oklch(L, 0.010, H);
    return {
      bg, panel: bg,
      elev: oklch(L + 0.045, 0.012, H),
      raised: oklch(L + 0.09, 0.014, H),
      hover: oklch(L + 0.135, 0.014, H),
      border: oklch(L + 0.185, 0.020, H),
      text: oklch(0.955, 0.006, H),
      muted: oklch(0.72, 0.012, H),
      accent,
      danger: "#ef4444",
      ok: "#4cc38a",
      user: oklch(L + 0.115, 0.050, H),
      assistant: oklch(L + 0.040, 0.022, H),
    };
  }
  return {
    bg: oklch(0.985, 0.004, H),
    panel: oklch(0.985, 0.004, H),
    elev: "#ffffff",
    raised: oklch(0.955, 0.006, H),
    hover: oklch(0.93, 0.009, H),
    border: oklch(0.865, 0.016, H),
    text: oklch(0.28, 0.022, H),
    muted: oklch(0.50, 0.02, H),
    accent,
    danger: "#dc2626",
    ok: "#317f5a",
    user: oklch(0.90, 0.035, H),
    assistant: oklch(0.965, 0.012, H),
  };
}
