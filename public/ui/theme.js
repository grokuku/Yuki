/**
 * Thème de l'UI Yuki (vanilla ESM, aucune chaîne de build) — modèle à DEUX AXES.
 *
 * Deux contrôles, deux rôles distincts :
 * - `#theme-family` (select) : la FAMILLE — indigo, midnight, slate, emerald,
 *   amber (libellés FR : Indigo, Nuit, Ardoise, Émeraude, Ambre) ;
 * - `#theme-toggle` (bouton) : le MODE clair↔sombre, en conservant la famille.
 *
 * Il n'existe PAS de mode « Système » : ni le select ni le moteur ne suivent
 * le réglage de l'OS (aucune écoute du thème système). Le mode clair/sombre
 * est toujours explicite.
 *
 * État = couple { famille, mode }, sérialisé sous la forme
 * `<famille>-<mode>` dans `localStorage["yuki-theme"]` — la même chaîne sert
 * de valeur `data-theme`, de nom de preset holaf et de donnée stockée
 * (une seule source de vérité).
 *
 * Application : l'attribut `data-theme` sur `<html>` est lu par `themes.css`
 * (10 presets, exactement ceux du catalogue holaf-lib). Anti-flash : le
 * markup pose déjà `data-theme="indigo-dark"` en dur ; ce fichier l'écrase
 * ensuite depuis `localStorage`.
 *
 * Migration (même clé, silencieuse) : les anciennes valeurs plates sont
 * mappées à la lecture — `dark` → `indigo-dark`, `light` → `indigo-light`,
 * `midnight` → `midnight-dark`, `slate` → `slate-dark` ; chaîne vide ou
 * inconnue → `indigo-dark` (nouveau défaut, aligné sur le markup). La valeur
 * migrée est réécrite dans la clé.
 *
 * Pont holaf : `window.HolafModal?.setTheme(preset)` reçoit le nom EXACT du
 * preset (indigo-dark, emerald-light, …) — connus de holaf-modal 0.5.0.
 *
 * CSP (`style-src 'self'`) : AUCUN `<style>` n'est injecté — seul
 * `Element.setAttribute` est utilisé.
 *
 * Persistance : `localStorage["yuki-theme"]` protégée (mode privé, quota) :
 * toute erreur est non bloquante.
 */

/** Clé de persistance du choix de l'utilisateur (inchangée — migration incluse). */
const STORAGE_KEY = "yuki-theme";

/** Familles du catalogue holaf-lib (axe 1) et modes (axe 2). */
export const FAMILIES = ["indigo", "midnight", "slate", "emerald", "amber"];
const MODES = ["light", "dark"];

/** Presets valides : les 10 combinaisons <famille>-<mode> (catalogue holaf). */
const PRESETS = new Set(FAMILIES.flatMap((f) => MODES.map((m) => `${f}-${m}`)));

/** Défaut : posé en dur dans le markup des deux pages (`data-theme`). */
const DEFAULT_PRESET = "indigo-dark";

/** Migration silencieuse : anciennes valeurs plates → <famille>-<mode>. */
const LEGACY_MAP = new Map([
  ["dark", "indigo-dark"],
  ["light", "indigo-light"],
  ["midnight", "midnight-dark"],
  ["slate", "slate-dark"],
]);

/** Preset courant : toujours une des 10 chaînes « <famille>-<mode> ». */
let current = DEFAULT_PRESET;

/** Garde d'idempotence : `initTheme()` peut être appelé plusieurs fois. */
let initialized = false;

/** Décompose « famille-mode » (les slugs ne contiennent pas de « - »). */
function parsePreset(preset) {
  const i = preset.indexOf("-");
  return { family: preset.slice(0, i), mode: preset.slice(i + 1) };
}

/**
 * Normalise la valeur stockée lue. Retourne le preset à appliquer et
 * `migrated` (la valeur d'origine doit être RÉÉCRITE : ancien nom plat,
 * chaîne vide ou valeur inconnue trouvée dans le stockage).
 */
function normalizeStored(raw) {
  if (typeof raw === "string") {
    if (PRESETS.has(raw)) return { preset: raw, migrated: false };
    if (LEGACY_MAP.has(raw)) return { preset: LEGACY_MAP.get(raw), migrated: true };
    // Ancien « système » (chaîne vide) ou valeur inconnue : défaut explicite.
    return { preset: DEFAULT_PRESET, migrated: true };
  }
  // Clé absente : on applique le défaut sans rien écrire (première visite).
  return { preset: DEFAULT_PRESET, migrated: false };
}

/** Lit le choix persisté (protégé : mode privé, quota, origine opaque). */
function readStored() {
  try {
    return normalizeStored(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return { preset: DEFAULT_PRESET, migrated: false };
  }
}

/** Écrit le choix persisté (best-effort : l'absence de stockage ne bloque pas). */
function writeStored(preset) {
  try {
    if (PRESETS.has(preset)) {
      window.localStorage.setItem(STORAGE_KEY, preset);
    }
  } catch {
    // Persistance best-effort.
  }
}

/** Applique le preset au document et à la brique holaf (si présente). */
function applyTheme(preset) {
  const root = document.documentElement;
  root.setAttribute("data-theme", preset);

  // Pont holaf : la modale (et tout autre brique pilotée par nom de preset)
  // reçoit le nom EXACT du catalogue (holaf-modal 0.5.0 connaît les 10).
  try {
    window.HolafModal?.setTheme(preset);
  } catch {
    // Brique optionnelle : toute erreur est non bloquante.
  }
}

/** Reflète l'état courant dans le `<select>` (famille) et le bouton (mode). */
function syncControls() {
  const { family, mode } = parsePreset(current);

  const select = document.getElementById("theme-family");
  if (select) {
    select.value = family;
  }

  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    // Icône = mode courant (☀ clair, ☾ sombre) ; pressé = mode sombre actif ;
    // libellé = l'action résultante (ce que fera le prochain clic).
    toggle.textContent = mode === "light" ? "☀" : "☾";
    toggle.setAttribute("aria-pressed", String(mode === "dark"));
    const label = mode === "light" ? "Passer en mode sombre" : "Passer en mode clair";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
  }
}

/**
 * Applique un preset `<famille>-<mode>` et synchronise l'UI + le stockage.
 * Une valeur invalide retombe sur le défaut (jamais d'état sans thème).
 * @param {string} preset
 * @param {{ persist?: boolean }} [opts]
 */
export function setTheme(preset, opts = {}) {
  current = PRESETS.has(preset) ? preset : DEFAULT_PRESET;
  applyTheme(current);
  if (opts.persist !== false) writeStored(current);
  syncControls();
  return current;
}

/** Preset courant (chaîne « <famille>-<mode> »). */
export function getTheme() {
  return current;
}

/**
 * Initialise le thème : applique le choix persisté (migration silencieuse le
 * cas échéant), câble le select (famille) et le bouton (mode).
 * @returns {{ theme: string, setTheme: (preset: string, opts?: object) => string }}
 */
export function initTheme() {
  if (initialized) {
    return { get theme() { return current; }, setTheme };
  }
  initialized = true;

  // 1) Applique le choix persisté avant tout rendu utile. On ne réécrit le
  //    stockage QUE si une valeur ancienne/inconnue a été migrée.
  const stored = readStored();
  setTheme(stored.preset, { persist: stored.migrated });

  // 2) Câble le menu déroulant : changer de FAMILLE en conservant le mode.
  const select = document.getElementById("theme-family");
  if (select) {
    select.addEventListener("change", () => {
      const { mode } = parsePreset(current);
      setTheme(`${select.value}-${mode}`);
    });
  }

  // 3) Câble la bascule : changer de MODE en conservant la famille.
  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const { family, mode } = parsePreset(current);
      setTheme(`${family}-${mode === "light" ? "dark" : "light"}`);
    });
  }

  return { get theme() { return current; }, setTheme };
}