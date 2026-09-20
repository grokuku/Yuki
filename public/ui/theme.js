/**
 * Thème de l'UI Yuki (vanilla ESM, aucune chaîne de build).
 *
 * Deux contrôles, synchronisés en permanence :
 * - `#theme-select` : « Système » (valeur `""`), `dark`, `light`, `midnight`,
 *   `slate` ;
 * - `#theme-toggle` : bascule clair↔sombre sur le thème résolu courant.
 *
 * Application : l'attribut `data-theme` sur `<html>` est lu par `themes.css`.
 * Le mode « système » retire l'attribut ; `styles.css` suit alors
 * `prefers-color-scheme` (bloc `:root:not([data-theme])`).
 *
 * CSP (`style-src 'self'`) : AUCUN `<style>` n'est injecté — seul
 * `Element.setAttribute` / `removeAttribute` est utilisé.
 *
 * Persistance : `localStorage["yuki-theme"]` (clé absente ou vide = système).
 */

/** Clé de persistance du choix de l'utilisateur. */
const STORAGE_KEY = "yuki-theme";

/** Presets explicites connus (doivent exister dans `themes.css`). */
const THEMES = ["dark", "light", "midnight", "slate"];
const THEME_SET = new Set(THEMES);

/** Thème courant : `""` (système) ou un des presets explicites. */
let current = "";

/** Garde d'idempotence : `initTheme()` peut être appelé plusieurs fois. */
let initialized = false;

/** Lit le choix persisté, en le validant contre les presets connus. */
function readStored() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && THEME_SET.has(value) ? value : "";
  } catch {
    // localStorage indisponible (mode privé, quota, origine opaque) : système.
    return "";
  }
}

/** Écrit (ou efface, en mode système) le choix persisté. */
function writeStored(theme) {
  try {
    if (theme && THEME_SET.has(theme)) {
      window.localStorage.setItem(STORAGE_KEY, theme);
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Persistance best-effort : l'absence de stockage ne doit jamais bloquer.
  }
}

/** Thème résolu quand l'utilisateur suit le réglage de l'OS. */
function systemTheme() {
  return window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Applique le thème au document et à la brique holaf (si présente). */
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme && THEME_SET.has(theme)) {
    root.setAttribute("data-theme", theme);
  } else {
    root.removeAttribute("data-theme");
  }

  // Bonus : pilote la modale/le toast holaf si la brique est chargée. En mode
  // système, on lui transmet le preset équivalent au réglage de l'OS.
  try {
    const holaf = window.HolafModal;
    if (holaf && typeof holaf.setTheme === "function") {
      holaf.setTheme(theme && THEME_SET.has(theme) ? theme : systemTheme());
    }
  } catch {
    // Brique optionnelle : toute erreur est non bloquante.
  }
}

/** Reflète le thème courant dans le `<select>` et le `<button>`. */
function syncControls() {
  const select = document.getElementById("theme-select");
  if (select) {
    select.value = THEME_SET.has(current) ? current : "";
  }

  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    const resolved = THEME_SET.has(current) ? current : systemTheme();
    const isLight = resolved === "light";
    // ◑ = bascule disponible (vers le sombre si clair, vers le clair si sombre).
    toggle.textContent = isLight ? "☀" : "◑";
    toggle.setAttribute("aria-pressed", String(isLight));
    toggle.title = isLight
      ? "Passer en mode sombre"
      : "Passer en mode clair";
  }
}

/**
 * Applique un thème (`""` pour système) et synchronise l'UI + le stockage.
 * @param {string} theme
 * @param {{ persist?: boolean }} [opts]
 */
export function setTheme(theme, opts = {}) {
  current = THEME_SET.has(theme) ? theme : "";
  applyTheme(current);
  if (opts.persist !== false) writeStored(current);
  syncControls();
  return current;
}

/**
 * Initialise le thème : applique le choix persisté, câble les contrôles et
 * suit les changements de préférence système tant qu'aucun preset explicite
 * n'est sélectionné.
 * @returns {{ theme: string, setTheme: (theme: string) => string }}
 */
export function initTheme() {
  if (initialized) {
    return { get theme() { return current; }, setTheme };
  }
  initialized = true;

  // 1) Applique le thème persisté avant tout rendu utile (pas de re-persist).
  setTheme(readStored(), { persist: false });

  // 2) Câble le menu déroulant.
  const select = document.getElementById("theme-select");
  if (select) {
    select.addEventListener("change", () => setTheme(select.value));
  }

  // 3) Câble la bascule clair↔sombre sur le thème résolu courant. Depuis le
  //    mode système, la bascule fige un preset explicite (comportement voulu).
  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const resolved = THEME_SET.has(current) ? current : systemTheme();
      setTheme(resolved === "light" ? "dark" : "light");
    });
  }

  // 4) Tant qu'aucun choix explicite n'est fait, suivre l'OS (couleurs gérées
  //    par le CSS ; ici on resynchronise seulement la brique holaf et le bouton).
  const media =
    window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  if (media) {
    const onSystemChange = () => {
      if (current) return;
      applyTheme("");
      syncControls();
    };
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onSystemChange);
    } else if (typeof media.addListener === "function") {
      // Safari/anciens WebKit.
      media.addListener(onSystemChange);
    }
  }

  return { get theme() { return current; }, setTheme };
}
