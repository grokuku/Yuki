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
 * SOURCE UNIQUE DE COULEURS (doctrine « alias + repli », comme Pi-Web) :
 * la brique `tokens` de holaf-lib est désormais chargée AU RUNTIME et devient
 * la seule à poser les variables `--holaf-*` sur `:root`. Les variables de
 * Yuki (`themes.css`) sont des ALIAS de ces tokens :
 *     --bg: var(--holaf-surface, #1e1e1e);   // repli = valeur d'avant
 * `applyTheme` applique donc :
 *   1. `data-theme="<famille>-<mode>"` sur `<html>` (sélecteur des alias) ;
 *   2. `HolafTokens.setTheme("yuki-<famille>-<mode>")` — le PACK HÔTE qui
 *      `extends` le preset intégré `<famille>-<mode>` et ajoute les 3 dérivés
 *      propres à Yuki (`user`, `assistant`, `ok`, cf. `themes-data.js`) ;
 *   3. `HolafModal.setTheme("<famille>-<mode>")` — nom EXACT connu de la
 *      modale (holaf-modal 0.5.0).
 *
 * ⚠️ Anti-flash : `data-theme` est déjà posé en dur dans le markup et les
 * alias portent leur repli → le PREMIER rendu est correct même avant que les
 * modules JS ne s'exécutent ; la brique ne fait ensuite que confirmer les
 * mêmes valeurs (aucun flash, aucune bascule visible).
 *
 * Migration (même clé, silencieuse) : les anciennes valeurs plates sont
 * mappées à la lecture — `dark` → `indigo-dark`, `light` → `indigo-light`,
 * `midnight` → `midnight-dark`, `slate` → `slate-dark` ; chaîne vide ou
 * inconnue → `indigo-dark` (défaut, aligné sur le markup). La valeur migrée
 * est réécrite dans la clé.
 *
 * CSP (`style-src 'self'`) : AUCUN `<style>` n'est injecté — seul
 * `Element.setAttribute` / CSSOM (`setProperty` de la brique) est utilisé.
 * Le marqueur `<style>` de la brique est neutralisé par `holaf-tokens-boot.js`
 * (importé AVANT la brique, cf. son en-tête).
 *
 * Icônes : TOUTES les icônes de l'UI (soleil/lune du bouton de mode,
 * haut-parleur/barré du contrôle voix, flèche retour de la page /config)
 * viennent de la brique `icons` via `HolafIcons.render(...)` — le markup ne
 * contient plus aucun SVG inline (cf. `renderBrickIcons`).
 *
 * Persistance : `localStorage["yuki-theme"]` protégée (mode privé, quota) :
 * toute erreur est non bloquante.
 */

// ⚠️ ORDRE CAPITAL : `holaf-tokens-boot.js` doit être évalué AVANT la brique
// `tokens` (neutralisation de son marqueur <style>, cf. son en-tête).
import "./holaf-tokens-boot.js";
// Brique `tokens` (FONDATION) — effet de bord : elle s'expose sur window
// (0.3.0 n'a AUCUN export ESM nommé : un import nommé échouerait).
import "./vendor/holaf/holaf-tokens.js";
// Brique `icons` — export ESM nommé (dual ESM + global).
import { HolafIcons } from "./vendor/holaf/holaf-icons.js";
// Dérivés Yuki générés (user / assistant / ok), à porter par le pack hôte.
import { YUKI_THEME_DERIVED } from "./themes-data.js";

/** Clé de persistance du choix de l'utilisateur (inchangée — migration incluse). */
const STORAGE_KEY = "yuki-theme";

/** Familles du catalogue holaf-lib (axe 1) et modes (axe 2). */
export const FAMILIES = ["indigo", "midnight", "slate", "emerald", "amber"];
const MODES = ["light", "dark"];

/** Presets valides : les 10 combinaisons <famille>-<mode> (catalogue holaf). */
const PRESETS = new Set(FAMILIES.flatMap((f) => MODES.map((m) => `${f}-${m}`)));

/** Défaut : posé en dur dans le markup des deux pages (`data-theme`). */
const DEFAULT_PRESET = "indigo-dark";

/** Préfixe des packs hôte Yuki (les 10 noms <fam>-<mode> sont RÉSERVÉS par la brique). */
const PACK_PREFIX = "yuki-";

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

/** API de la brique `tokens`, ou `undefined` si la brique n'a pas chargé. */
function tokensApi() {
  return typeof window !== "undefined" ? window.HolafTokens : undefined;
}

/** Décompose « famille-mode » (les slugs ne contiennent pas de « - »). */
function parsePreset(preset) {
  const i = preset.indexOf("-");
  return { family: preset.slice(0, i), mode: preset.slice(i + 1) };
}

/** Nom du pack hôte Yuki pour un preset `<famille>-<mode>`. */
function packName(preset) {
  return `${PACK_PREFIX}${preset}`;
}

/**
 * Enregistre (une fois) les 10 packs hôte Yuki dans la brique `tokens`.
 * Chaque pack `yuki-<fam>-<mode>` HÉRITE du preset intégré homonyme (toute la
 * palette standard) et n'ajoute QUE les 3 dérivés propres à Yuki (`user`,
 * `assistant`, `ok`). Registre VOLATILE de la brique : on (re)enregistre à
 * chaque boot. Sans brique, on ne fait rien (les alias CSS gardent leur repli).
 */
function registerYukiPacks() {
  const HT = tokensApi();
  if (!HT || typeof HT.registerPreset !== "function") return;
  for (const preset of PRESETS) {
    const derived = YUKI_THEME_DERIVED[preset];
    if (!derived) continue;
    HT.registerPreset(
      packName(preset),
      { user: derived.user, assistant: derived.assistant, ok: derived.ok },
      { extends: preset, derive: false },
    );
  }
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

/** Applique le preset au document, à la brique `tokens` et à `HolafModal`. */
function applyTheme(preset) {
  const root = document.documentElement;
  root.setAttribute("data-theme", preset);

  // Source unique de couleurs : la brique pose les --holaf-* sur :root ; les
  // alias de themes.css suivent automatiquement. Toute erreur est non
  // bloquante : les alias retombent alors sur leur repli (mêmes valeurs).
  try {
    tokensApi()?.setTheme(packName(preset));
  } catch {
    // Brique optionnelle.
  }

  // Pont holaf : la modale (et tout autre brique pilotée par nom de preset)
  // reçoit le nom EXACT du catalogue (holaf-modal 0.5.0 connaît les 10).
  try {
    window.HolafModal?.setTheme(preset);
  } catch {
    // Brique optionnelle : toute erreur est non bloquante.
  }
}

/**
 * Rend les icônes statiques de la brique `icons` dans leurs emplacements du
 * markup (contenu REMPLACÉ, comme le faisait le markup inline avant) :
 *   - `#theme-toggle`   : soleil/lune — le mode (`data-theme`) décide lequel
 *     est visible (styles.css) ;
 *   - `#tts-toggle`     : haut-parleur / barré — les classes d'état
 *     (`tts-toggle--off`/`--muted` posées par app.js) décident lequel est
 *     visible (styles.css) ;
 *   - `.nav-back__icon` : flèche retour de la page /config.
 * Colorisation inchangée : `stroke="currentColor"` + classes `.icon` /
 * `--icon-color`, aucun style inline (CSP `style-src 'self'`). No-op là où
 * l'élément (ou la brique) manque : l'emplacement reste alors vide.
 */
function renderBrickIcons() {
  if (!HolafIcons) return;
  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.innerHTML =
      HolafIcons.render("sun", { class: "icon icon--sun" }) +
      HolafIcons.render("moon", { class: "icon icon--moon" });
  }
  const ttsToggle = document.getElementById("tts-toggle");
  if (ttsToggle) {
    ttsToggle.innerHTML =
      HolafIcons.render("volume", { class: "icon icon--volume" }) +
      HolafIcons.render("volume-off", { class: "icon icon--volume-off" });
  }
  const navBackIcon = document.querySelector(".nav-back__icon");
  if (navBackIcon) {
    navBackIcon.innerHTML = HolafIcons.render("arrow-left", {
      class: "icon icon--arrow-left",
    });
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
    // L'icône visuelle (soleil/lune) est rendue par `renderBrickIcons()` ;
    // le mode (`data-theme` sur <html>) décide lequel est visible via CSS
    // (styles.css) — on ne remplace donc PAS `innerHTML` ici, sinon on
    // effacerait les deux SVG. L'état reste porté par `aria-pressed` ; le
    // libellé décrit l'action résultante (ce que fera le prochain clic).
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
 * Initialise le thème : enregistre les packs hôte, rend les icônes de la
 * brique dans le markup,
 * applique le choix persisté (migration silencieuse le cas échéant), câble le
 * select (famille) et le bouton (mode).
 * @returns {{ theme: string, setTheme: (preset: string, opts?: object) => string }}
 */
export function initTheme() {
  if (initialized) {
    return { get theme() { return current; }, setTheme };
  }
  initialized = true;

  // 0) Packs hôte (source unique runtime) + icônes de la brique dans le markup.
  registerYukiPacks();
  renderBrickIcons();

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
