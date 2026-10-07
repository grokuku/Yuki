/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafTokens · version 0.4.1
 * ─────────────────────────────────────────────────────────────────────────────
 * BRIQUE « FONDATION » — les tokens CSS de PAGE.
 *
 * ▸ PATCH 0.4.1 (contraste du texte atténué) ────────────────────────────────
 *   Correction de VALEUR (aucun changement d'API, aucune clé nouvelle) :
 *   6 `text-muted` du catalogue V2 passaient sous le seuil AA 4,5:1 sur un
 *   palier de fond (le pire étant `ambre-light` sur `surface` = 4,42:1, et
 *   `neutre-dark` sur `surface-hover` = 2,97:1). Chacun est retouché A MINIMA
 *   (luminosité ajustée, teinte/saturation de la famille PRÉSERVÉES) jusqu'à
 *   ≥ 4,5:1 sur LES QUATRE paliers de profondeur. Aucune autre valeur n'est
 *   touchée. La garde V2 (tests/helpers/theme-guard.js) contrôle désormais
 *   AUSSI `text-muted` sur les 4 paliers (lacune comblée : elle ne vérifiait
 *   que `text` et l'accent).
 *
 * ▸ RUPTURE 0.4.0 (catalogue V2) ─────────────────────────────────────────────
 *   Le catalogue à 2 axes est REMPLACÉ : 6 familles × 2 modes = 12 presets
 *   `<famille>-<mode>` (corail, ambre, emeraude, turquoise, amethyste, neutre),
 *   valeurs FIGÉES en hex, calculées une fois depuis la maquette V2 validée
 *   (`Yuki and Libs/_tools/theme-accents.mjs` : FAMILIES_WHEEL + ACCENTS_V2).
 *   Les 10 presets de la 0.2/0.3 (indigo/midnight/slate/emerald/amber ×
 *   light/dark) DISPARAISSENT. Les 4 alias historiques (dark/light/midnight/
 *   slate) sont CONSERVÉS mais REMAPPÉS (table MIGRATIONS exportée) pour ne
 *   pas casser les préférences « plates ».
 *   Chaque preset porte 16 clés : les 15 clés standard + `surface-hover`, le 4ᵉ
 *   palier de profondeur (surface → surface-elev → surface-raised →
 *   surface-hover). La règle V2 (fonds/accents distincts par mode, texte — y
 *   compris le texte ATTÉNUÉ — /fond ≥ 4,5:1, non-textuel ≥ 3:1, profondeur ≥
 *   seuil) est REJOUÉE en test (tests/holaf-tokens.test.js), sans coût runtime.
 *
 * ▸ HÉRITAGE 0.3.0 (conservé) ────────────────────────────────────────────────
 *   23 clés optionnelles (13 dérivables + 5 d'état + 5 d'identité), registre
 *   de PACKS hôte (registerPreset / updatePreset / unregisterPreset /
 *   getPreset / alpha), PURGE PAR POSSESSION D'ENSEMBLE, et fichier chargeable
 *   en <script> classique (file:// ET HTTP) : AUCUN export top-level (l'`export
 *   { HolafTokens }` de la 0.2.0 est retiré).
 *   ⚠️ Les VALEURS du catalogue changent (rupture) mais l'API, l'événement et
 *   le mécanisme de packs de la 0.3.0 sont inchangés.
 *
 * ▸ PRIVILÈGE (par CONTRAT EXPLICITE) ───────────────────────────────────────
 *   HolafTokens est la SEULE brique du kit autorisée à poser des variables
 *   CSS sur `:root` (document.documentElement), sous le préfixe RÉSERVÉ
 *   --holaf-*. C'est l'exception à la règle du kit (« chaque brique scope son
 *   CSS sous ses propres classes, jamais sur :root »). Installer cette brique,
 *   c'est savoir (opt-in) qu'on installe un THÈME GLOBAL de page : elle prend
 *   le contrôle de la palette (surface, texte, accent, danger…).
 *
 * ▸ SANS RENDU ──────────────────────────────────────────────────────────────
 *   La brique ne rend AUCUN élément : elle ne fait que poser/retirer des
 *   variables CSS sur :root. Le CSS auto-injecté est donc minimal (un commentaire
 *   de repère, injecté une seule fois) — rien de scopé n'est nécessaire.
 *
 * ▸ CONTRAT DE SURFACE ───────────────────────────────────────────────────────
 *   Tokens posés (préfixe --holaf-*) :
 *     surface, surface-elev, surface-raised, border, text, text-muted,
 *     accent, accent-hover, accent-text, danger, danger-hover, danger-text,
 *     radius, shadow, font-size.
 *   Clés OPTIONNELLES 0.3.0 (23 — jamais posées par les presets intégrés,
 *     EXCEPTÉ surface-hover, désormais porté par les 12 presets V2) :
 *     groupe A (dérivables) : accent-soft, accent-glow, accent-gradient,
 *       accent-gradient-hover, accent-shadow, danger-soft, danger-shadow,
 *       danger-gradient*, border-muted, text-faint, surface-hover,
 *       chrome-header, chrome-footer          (* hors dérivation par défaut)
 *     groupe B (états, fournis par le pack) : ok, ok-text, ok-soft, warn,
 *       warn-text
 *     groupe C (identité) : bg-image, txt-glow*, radius-sm, font-sans,
 *       font-mono                              (* opt-in : jamais dérivés)
 *   Mapping hôte (ex. Homy — ses 11 vars actuelles) :
 *     --bg         → var(--holaf-surface)
 *     --bg-elev    → var(--holaf-surface-elev)
 *     --bg-elev-2  → var(--holaf-surface-raised)
 *     --border     → var(--holaf-border)
 *     --text       → var(--holaf-text)
 *     --text-muted → var(--holaf-text-muted)
 *     --accent         → var(--holaf-accent)
 *     --accent-hover   → var(--holaf-accent-hover)
 *     --danger     → var(--holaf-danger)
 *     --radius     → var(--holaf-radius)
 *     --shadow     → var(--holaf-shadow)
 *   Voir js/README-holaf-tokens.md pour le mapping complet.
 *
 * ▸ FAMILLES × MODES (catalogue à 2 axes — V2) ─────────────────────────────
 *   6 familles (corail, ambre, emeraude, turquoise, amethyste, neutre) ×
 *   2 modes (light, dark) = 12 presets `<famille>-<mode>`, PLUS 4 alias
 *   historiques (dark / light / midnight / slate) REMAPPÉS vers les nouvelles
 *   familles (valeurs RIGOUREUSEMENT identiques à leur jumeau). Chaque famille
 *   a sa propre clarté de fond (les fonds restent distincts malgré un chroma
 *   faible) et son accent d'identité. Contraste des textes (`text` ET
 *   `text-muted`) ≥ 4.5:1 sur les 4 paliers de surface. Si l'hôte n'a fait
 *   AUCUN choix, la brique applique au chargement
 *   le preset initial issu de `prefers-color-scheme` (dark/light).
 *
 * ▸ API 0.4.0 ────────────────────────────────────────────────────────────────
 *   setTokens / setTheme / setFamily / getTheme / getFamily / getMode /
 *   applyPalette / reset / listPresets / listFamilies / FAMILIES / PRESETS /
 *   ALIASES / PREFIX / VERSION                    — INCHANGÉS (0.2.0)
 *   registerPreset(name, tokens, options?)   → { name, vars } (remplace si repris)
 *   updatePreset(name, tokens)               → { name, vars } (fusion + re-dérivés)
 *   unregisterPreset(name)                   → boolean (false si intégré/inconnu)
 *   getPreset(name)                          → copie | null (intégré/alias/pack)
 *   alpha(color, a)                          → hex → rgba (non-hex inchangé)
 *   MIGRATIONS                               → table ancien→nouveau (hôtes)
 *   listPresets() = 16 intégrés (12 presets + 4 alias) PUIS packs dans l'ordre.
 *   Événement : à CHAQUE changement de palette appliquée (setTokens / setTheme /
 *   applyPalette / reset / initial). register / update / unregister n'émettent
 *   PAS ; setTheme("<pack>") émet comme les autres.
 *
 * ▸ REGISTRE DE PACKS (0.3.0) ───────────────────────────────────────────────
 *   Un PACK hôte est un preset nommé enregistré via registerPreset, sans
 *   toucher aux 16 intégrés. options.extends : nom d'un intégré / alias / pack
 *   (base = copie complète). options.derive : true (défaut = groupe A+B moins
 *   danger-gradient/txt-glow) | false | tableau de clés. Priorité de fusion :
 *   spec explicite > extends > dérivé. Une dérivation dont la source est
 *   absente ou non-hex est SAUTÉE silencieusement (clé non posée, pas d'erreur).
 *   Noms réservés : les 12 <famille>-<mode> + 4 alias + 6 familles → throw.
 *   Registre VOLATILE : les packs sont perdus au rechargement, l'hôte les
 *   ré-enregistre au boot. getFamily() / getMode() renvoient null pour un pack.
 *
 * ▸ PURGE PAR POSSESSION D'ENSEMBLE (correctif 0.3.0) ─────────────────────────
 *   La brique mémorise un Set des clés qu'ELLE a posées. À chaque application,
 *   elle retire d'abord les clés possédées ABSENTES du nouveau lot puis pose le
 *   nouveau lot (même tâche JS → aucun flash). reset() retire tout le set. Les
 *   variables posées HORS brique ne sont jamais touchées. Corrige le résidu
 *   constaté en 0.2.0 (ex. une clé posée par un setTokens riche puis absente
 *   d'un setTokens minimal reste purgée).
 *
 * Autonome : la brique RÉIMPLÉMENTE une version minimale de mix/contrast (pas
 * de dépendance inter-briques vers HolafColor).
 *
 * Fichier CLASSIC-COMPATIBLE (correctif 0.3.0) : AUCUN export top-level —
 * chargeable en <script> classique (file:// ET HTTP), en <script type="module"
 * src> et en import ESM par effet de bord (`import "./holaf-tokens.js"`).
 * L'API est exposée via window.HolafTokens (repli globalThis).
 * ═════════════════════════════════════════════════════════════════════════ */

const HolafTokens = (function () {
    "use strict";

    const VERSION = "0.4.1";

    // Préfixe RÉSERVÉ : toutes les variables posées sont sous --holaf-*.
    const PREFIX = "--holaf-";
    const EVENT_NAME = "holaf-tokens-changed";

    // ─── État interne ──────────────────────────────────────────────────────
    let currentName = null;      // nom du preset en cours (ou null si custom)
    let appliedVars = null;      // dernières variables posées (clés --holaf-*)
    let initialized = false;     // le preset initial par défaut a-t-il été posé ?
    let explicitChoice = false;  // l'hôte a-t-il choisi lui-même ?
    // POSSESSION D'ENSEMBLE (correctif 0.3.0) : toutes les clés --holaf-* que
    // la brique a posées AU MOINS UNE FOIS. Seules celles-ci sont purgées ; une
    // variable posée hors brique n'entre jamais dans ce set.
    const ownedKeys = new Set();
    // REGISTRE DE PACKS (0.3.0) : name → { spec, resolved }. `spec` garde la
    // spec explicite + les options (pour updatePreset) ; `resolved` est la carte
    // finale (extends + spec + dérivées) réellement applicable.
    const PACKS = new Map();

    // ─── Utilitaires internes (pas dépendance inter-briques) ──────────────
    function parseHex(hex) {
        if (typeof hex !== "string") {
            throw new Error("[HolafTokens] hex invalide : " + String(hex) + " (chaîne attendue).");
        }
        let h = hex.trim();
        if (h.charAt(0) === "#") h = h.slice(1);
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        if (!/^[0-9a-fA-F]{6}$/.test(h)) {
            throw new Error('[HolafTokens] hex invalide : "' + hex + '" (attendu "#rgb" ou "#rrggbb").');
        }
        return [
            parseInt(h.slice(0, 2), 16),
            parseInt(h.slice(2, 4), 16),
            parseInt(h.slice(4, 6), 16),
        ];
    }
    function toHex(r, g, b) {
        const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).toUpperCase().padStart(2, "0");
        return "#" + c(r) + c(g) + c(b);
    }
    // mix(a, b, ratio) : ratio 0..1 = part de b.
    function mix(a, b, ratio) {
        const ca = parseHex(a);
        const cb = parseHex(b);
        return toHex(
            ca[0] + (cb[0] - ca[0]) * ratio,
            ca[1] + (cb[1] - ca[1]) * ratio,
            ca[2] + (cb[2] - ca[2]) * ratio
        );
    }
    // Contrast ratio WCAG 2.1 minimal (luminance relative) — pour les accents.
    function lumChannel(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    function contrastRatio(a, b) {
        const la = [0.2126, 0.7152, 0.0722].reduce((acc, w, i) => acc + w * lumChannel(parseHex(a)[i]), 0);
        const lb = [0.2126, 0.7152, 0.0722].reduce((acc, w, i) => acc + w * lumChannel(parseHex(b)[i]), 0);
        const hi = Math.max(la, lb), lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
    }

    // ─── Choix du texte lisible (dérivations ok-text / warn-text) ─────────
    // La brique reste AUTONOME (pas de dépendance inter-briques vers HolafColor) :
    // on retient la plus lisible des deux couleurs (sombre / claire), ≥ 4.5:1
    // quand c'est possible.
    function readableText(bg, dark, light) {
        const d = dark || "#000000";
        const l = light || "#ffffff";
        const rDark = contrastRatio(bg, d);
        const rLight = contrastRatio(bg, l);
        const darkOk = rDark >= 4.5;
        const lightOk = rLight >= 4.5;
        if (darkOk && !lightOk) return d;
        if (lightOk && !darkOk) return l;
        return rDark >= rLight ? d : l;
    }

    // ─── Catalogue V2 — 6 familles × 2 modes, valeurs FIGÉES en hex ───────
    // Valeurs calculées UNE FOIS depuis la maquette V2 validée
    // (`Yuki and Libs/_tools/theme-accents.mjs` : FAMILIES_WHEEL + ACCENTS_V2),
    // puis FIGÉES ici : AUCUN moteur OKLCH n'est embarqué (précédent accepté :
    // modal / toast figent déjà leurs palettes littérales). Chaque mode porte
    // 16 clés : les 15 clés standard + `surface-hover` (4ᵉ palier de profondeur
    // surface → surface-elev → surface-raised → surface-hover). Les clés NON
    // produites par la maquette suivent des règles documentées (README) :
    //   accent-hover = mix(accent, surface, 15 %)    (comme applyPalette)
    //   danger       = graine #dc2626 (clair) / #f87171 (sombre), assombrie par
    //                  pas de 5 % jusqu'à ≥ 4.5:1 sur la surface de la famille
    //   danger-hover = mix(danger, surface, 15 %)
    //   danger-text  = readableText(danger) (#ffffff ou #000000)
    //   radius = "12px" ; font-size = "14px" ; shadow = ombre par mode.
    const FAMILIES = {
        corail: {
            label: "Corail", hue: 354,
            light: {
                "surface": "#ffe3ed",
                "surface-elev": "#fefefe",
                "surface-raised": "#f5d9e3",
                "surface-hover": "#ebcfd9",
                "border": "#d9b9c4",
                "text": "#2f2227",
                "text-muted": "#665159",
                "accent": "#9c045e",
                "accent-hover": "#ab2573",
                "accent-text": "#ffffff",
                "danger": "#c62222",
                "danger-hover": "#cf3f40",
                "danger-text": "#ffffff",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(24, 24, 27, 0.18)",
                "font-size": "14px",
            },
            dark: {
                "surface": "#36252c",
                "surface-elev": "#433037",
                "surface-raised": "#503b43",
                "surface-hover": "#5d464f",
                "border": "#735963",
                "text": "#f4eef0",
                "text-muted": "#ccb7bf",
                "accent": "#fa7fb5",
                "accent-hover": "#dd72a0",
                "accent-text": "#0b0b12",
                "danger": "#f87171",
                "danger-hover": "#db6667",
                "danger-text": "#000000",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(0, 0, 0, 0.55)",
                "font-size": "14px",
            },
        },
        ambre: {
            label: "Ambre", hue: 66,
            light: {
                "surface": "#dcc8b5",
                "surface-elev": "#fefefe",
                "surface-raised": "#d2bfac",
                "surface-hover": "#c9b5a3",
                "border": "#b6a08b",
                "text": "#2d251c",
                "text-muted": "#54473b",
                "accent": "#7a4800",
                "accent-hover": "#895b1b",
                "accent-text": "#ffffff",
                "danger": "#a51d1d",
                "danger-hover": "#ad3734",
                "danger-text": "#ffffff",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(24, 24, 27, 0.18)",
                "font-size": "14px",
            },
            dark: {
                "surface": "#0c0400",
                "surface-elev": "#170b02",
                "surface-raised": "#221508",
                "surface-hover": "#2e1f10",
                "border": "#42301f",
                "text": "#f3efec",
                "text-muted": "#b9a593",
                "accent": "#f29a2d",
                "accent-hover": "#d08426",
                "accent-text": "#0b0b12",
                "danger": "#f87171",
                "danger-hover": "#d56160",
                "danger-text": "#000000",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(0, 0, 0, 0.55)",
                "font-size": "14px",
            },
        },
        emeraude: {
            label: "Émeraude", hue: 138,
            light: {
                "surface": "#c9dac4",
                "surface-elev": "#fdfffc",
                "surface-raised": "#c0d0bb",
                "surface-hover": "#b6c6b1",
                "border": "#a0b29a",
                "text": "#22291f",
                "text-muted": "#465143",
                "accent": "#276701",
                "accent-hover": "#3f781e",
                "accent-text": "#ffffff",
                "danger": "#b01e1e",
                "danger-hover": "#b43a37",
                "danger-text": "#ffffff",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(24, 24, 27, 0.18)",
                "font-size": "14px",
            },
            dark: {
                "surface": "#081005",
                "surface-elev": "#111b0d",
                "surface-raised": "#1a2617",
                "surface-hover": "#253120",
                "border": "#354430",
                "text": "#eef1ed",
                "text-muted": "#9faf9a",
                "accent": "#7fc765",
                "accent-hover": "#6dac57",
                "accent-text": "#0b0b12",
                "danger": "#f87171",
                "danger-hover": "#d46261",
                "danger-text": "#000000",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(0, 0, 0, 0.55)",
                "font-size": "14px",
            },
        },
        turquoise: {
            label: "Turquoise", hue: 210,
            light: {
                "surface": "#c3e2e8",
                "surface-elev": "#fdffff",
                "surface-raised": "#b9d9de",
                "surface-hover": "#b0cfd5",
                "border": "#97bbc2",
                "text": "#1b292c",
                "text-muted": "#42585c",
                "accent": "#07606c",
                "accent-hover": "#23747f",
                "accent-text": "#ffffff",
                "danger": "#bb2020",
                "danger-hover": "#bc3d3e",
                "danger-text": "#ffffff",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(24, 24, 27, 0.18)",
                "font-size": "14px",
            },
            dark: {
                "surface": "#051a1e",
                "surface-elev": "#0e2529",
                "surface-raised": "#183135",
                "surface-hover": "#223d41",
                "border": "#315056",
                "text": "#ecf1f2",
                "text-muted": "#91b0b5",
                "accent": "#0ec7de",
                "accent-hover": "#0dadc1",
                "accent-text": "#0b0b12",
                "danger": "#f87171",
                "danger-hover": "#d46465",
                "danger-text": "#000000",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(0, 0, 0, 0.55)",
                "font-size": "14px",
            },
        },
        amethyste: {
            label: "Améthyste", hue: 282,
            light: {
                "surface": "#dfe1fa",
                "surface-elev": "#fefefe",
                "surface-raised": "#d6d8f0",
                "surface-hover": "#cccee6",
                "border": "#b6b9d5",
                "text": "#252530",
                "text-muted": "#555669",
                "accent": "#4d41b0",
                "accent-hover": "#6359bb",
                "accent-text": "#ffffff",
                "danger": "#bb2020",
                "danger-hover": "#c03d41",
                "danger-text": "#ffffff",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(24, 24, 27, 0.18)",
                "font-size": "14px",
            },
            dark: {
                "surface": "#1e1f2e",
                "surface-elev": "#292a3a",
                "surface-raised": "#343547",
                "surface-hover": "#3f4155",
                "border": "#52536b",
                "text": "#eff0f4",
                "text-muted": "#abadc4",
                "accent": "#a1a3ff",
                "accent-hover": "#8d8fe0",
                "accent-text": "#0b0b12",
                "danger": "#f87171",
                "danger-hover": "#d76567",
                "danger-text": "#000000",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(0, 0, 0, 0.55)",
                "font-size": "14px",
            },
        },
        neutre: {
            label: "Neutre", hue: 250,
            light: {
                "surface": "#f2f4f5",
                "surface-elev": "#fefeff",
                "surface-raised": "#e8eaeb",
                "surface-hover": "#dee0e1",
                "border": "#c6cbd0",
                "text": "#1f2730",
                "text-muted": "#4c5a69",
                "accent": "#515457",
                "accent-hover": "#696c6f",
                "accent-text": "#ffffff",
                "danger": "#d12424",
                "danger-hover": "#d64343",
                "danger-text": "#ffffff",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(24, 24, 27, 0.18)",
                "font-size": "14px",
            },
            dark: {
                "surface": "#343537",
                "surface-elev": "#3f4144",
                "surface-raised": "#4a4d51",
                "surface-hover": "#565a5e",
                "border": "#686e75",
                "text": "#edf0f4",
                "text-muted": "#ced1d4",
                "accent": "#aeb1b5",
                "accent-hover": "#9c9ea2",
                "accent-text": "#0b0b12",
                "danger": "#f87878",
                "danger-hover": "#db6e6e",
                "danger-text": "#000000",
                "radius": "12px",
                "shadow": "0 18px 50px rgba(0, 0, 0, 0.55)",
                "font-size": "14px",
            },
        },
    };

    // Ordre d'affichage stable (par teinte, le Neutre en dernier).
    const MODES = ["light", "dark"];
    const FAMILY_NAMES = ["corail", "ambre", "emeraude", "turquoise", "amethyste", "neutre"];

    // ─── Catalogue des presets (12 familles×modes + 4 alias REMAPPÉS) ──────
    const PRESETS = {};
    FAMILY_NAMES.forEach((family) => {
        MODES.forEach((mode) => {
            PRESETS[family + "-" + mode] = Object.assign({}, FAMILIES[family][mode]);
        });
    });

    // Alias historiques → valeurs RIGOUREUSEMENT identiques (copies des jumeaux).
    // REMAPPÉS : les anciennes familles (indigo/midnight/slate/emerald/amber)
    // n'existent plus (voir MIGRATIONS). `midnight` était violet → amethyste ;
    // `slate` était gris → neutre.
    const ALIASES = {
        dark: "amethyste-dark",
        light: "amethyste-light",
        midnight: "amethyste-dark",
        slate: "neutre-dark",
    };
    Object.keys(ALIASES).forEach((alias) => {
        PRESETS[alias] = Object.assign({}, PRESETS[ALIASES[alias]]);
    });

    // ─── Table de MIGRATION (0.4.0) — fournie AUX HÔTES ────────────────────
    // Les hôtes l'appliquent EUX-MÊMES à leur préférence stockée : <ancien nom>
    // (10 anciens presets + 4 alias) → <nouveau nom>. La brique n'effectue
    // AUCUNE migration automatique (elle ne stocke aucune préférence).
    const MIGRATIONS = {
        "indigo-light": "amethyste-light",
        "indigo-dark": "amethyste-dark",
        "midnight-light": "amethyste-light",
        "midnight-dark": "amethyste-dark",
        "slate-light": "neutre-light",
        "slate-dark": "neutre-dark",
        "emerald-light": "emeraude-light",
        "emerald-dark": "emeraude-dark",
        "amber-light": "ambre-light",
        "amber-dark": "ambre-dark",
        dark: "amethyste-dark",
        light: "amethyste-light",
        midnight: "amethyste-dark",
        slate: "neutre-dark",
    };

    // ─── Noms réservés (0.4.0) ──────────────────────────────────────────────
    // Les 12 <famille>-<mode>, les 4 alias et les 6 noms de familles sont
    // RÉSERVÉS : un pack hôte ne peut pas les reprendre (throw clair).
    const RESERVED_NAMES = new Set(Object.keys(PRESETS).concat(FAMILY_NAMES));

    // ─── Clés optionnelles 0.3.0 (23) + moteur de dérivation ───────────────
    // Groupe A (dérivables) : accent-soft … chrome-footer, plus danger-gradient
    //   (dérivable mais HORS DÉFAUT : opt-in).
    // Groupe B (états, fournis par le pack puis dérivés) : ok / warn et leurs
    //   dérivées ok-text, ok-soft, warn-text.
    // Groupe C (identité) : bg-image, txt-glow (opt-in, aucune règle), radius-sm
    //   (dérivable à la demande), font-sans, font-mono.
    // Une règle reçoit la carte fusionnée (clés non préfixées) et retourne la
    // valeur dérivée, ou undefined si la source manque / n'est pas exploitable :
    // la clé n'est alors PAS posée, silencieusement (pas d'erreur).
    function hexToken(value) {
        if (typeof value !== "string") return null;
        try { return parseHex(value); } catch (e) { return null; }
    }
    function hexOf(value) {
        const c = hexToken(value);
        return c ? toHex(c[0], c[1], c[2]) : null;
    }
    // Dérivée de couleur : null si la source n'est pas un hex exploitable.
    function rgbaOf(value, a) {
        return hexToken(value) ? alpha(value, a) : null;
    }
    // Ordre = ordre des dépendances (accent-soft avant accent-shadow…).
    const DERIVE_RULES = {
        // — Groupe A —
        "accent-soft": (t) => rgbaOf(t.accent, 0.16),
        "accent-glow": (t) => rgbaOf(t.accent, 0.5),
        "accent-gradient": (t) => {
            const a = hexOf(t.accent);
            const h = hexOf(t["accent-hover"]);
            return a && h ? "linear-gradient(135deg, " + a + ", " + h + ")" : undefined;
        },
        "accent-gradient-hover": (t) => {
            const a = hexOf(t.accent);
            const h = hexOf(t["accent-hover"]);
            return a && h
                ? "linear-gradient(135deg, " + mix(a, "#ffffff", 0.12) + ", " + mix(h, "#ffffff", 0.12) + ")"
                : undefined;
        },
        "accent-shadow": (t) => (t["accent-soft"] ? "0 0 18px var(--holaf-accent-soft)" : undefined),
        "danger-soft": (t) => rgbaOf(t.danger, 0.12),
        "danger-shadow": (t) => (t["danger-soft"] ? "0 0 16px var(--holaf-danger-soft)" : undefined),
        // danger-gradient : dérivable mais HORS DÉFAUT (opt-in via derive:[…]).
        "danger-gradient": (t) => {
            const d = hexOf(t.danger);
            const h = hexOf(t["danger-hover"]);
            return d && h ? "linear-gradient(135deg, " + d + ", " + h + ")" : undefined;
        },
        "border-muted": (t) => rgbaOf(t.border, 0.45),
        "text-faint": (t) => {
            const a = hexOf(t["text-muted"]);
            const b = hexOf(t.surface);
            return a && b ? mix(a, b, 0.42) : undefined;
        },
        "surface-hover": (t) => rgbaOf(t["surface-raised"], 0.7),
        "chrome-header": (t) => {
            const a = rgbaOf(t.surface, 0.92);
            const b = rgbaOf(t.surface, 0.66);
            return a && b ? "linear-gradient(180deg, " + a + ", " + b + ")" : undefined;
        },
        "chrome-footer": (t) => {
            const a = rgbaOf(t.surface, 0.95);
            const b = rgbaOf(t.surface, 0.66);
            return a && b ? "linear-gradient(0deg, " + a + ", " + b + ")" : undefined;
        },
        // — Groupe B (états) —
        "ok-text": (t) => (hexToken(t.ok) ? readableText(hexOf(t.ok)) : undefined),
        "ok-soft": (t) => rgbaOf(t.ok, 0.1),
        "warn-text": (t) => (hexToken(t.warn) ? readableText(hexOf(t.warn)) : undefined),
        // — Groupe C —
        "radius-sm": (t) => (typeof t.radius === "string" && t.radius.trim()
            ? "calc(" + t.radius.trim() + " - 2px)"
            : undefined),
    };
    const DERIVE_ORDER = Object.keys(DERIVE_RULES);
    // Dérivations par DÉFAUT = « liste A+B » moins les opt-in : danger-gradient
    // et txt-glow restent HORS défaut.
    const DEFAULT_DERIVE = [
        "accent-soft", "accent-glow", "accent-gradient", "accent-gradient-hover",
        "accent-shadow", "danger-soft", "danger-shadow", "border-muted",
        "text-faint", "surface-hover", "chrome-header", "chrome-footer",
        "ok-text", "ok-soft", "warn-text",
    ];

    function deriveInto(tokens, requested) {
        DERIVE_ORDER.forEach((key) => {
            if (!requested.has(key)) return;
            // Priorité : spec explicite > extends > dérivé.
            if (Object.prototype.hasOwnProperty.call(tokens, key)) return;
            const rule = DERIVE_RULES[key];
            if (!rule) return; // clé sans règle (opt-in) → sautée silencieusement
            const value = rule(tokens);
            if (value !== undefined && value !== null && value !== "") tokens[key] = value;
        });
    }

    // options.derive → Set de clés. true / undefined = liste par défaut.
    function deriveList(derive) {
        if (derive === undefined || derive === null || derive === true) return new Set(DEFAULT_DERIVE);
        if (derive === false) return new Set();
        if (Array.isArray(derive)) return new Set(derive.filter((k) => typeof k === "string"));
        throw new Error("[HolafTokens] options.derive : attendu true | false | tableau de clés.");
    }

    // Preset intégré, alias ou pack → carte (clés non préfixées) ; null sinon.
    function findPreset(name) {
        if (typeof name !== "string" || !name) return null;
        if (PACKS.has(name)) return PACKS.get(name).resolved;
        if (Object.prototype.hasOwnProperty.call(PRESETS, name)) return PRESETS[name];
        return null;
    }

    // Résolution d'un pack : base (extends) → spec explicite → dérivations.
    function resolvePack(tokens, options) {
        const opts = options || {};
        let base = {};
        if (opts.extends !== undefined && opts.extends !== null) {
            const inherited = findPreset(opts.extends);
            if (!inherited) {
                throw new Error('[HolafTokens] options.extends : preset inconnu "' + opts.extends + '".');
            }
            base = Object.assign({}, inherited);
        }
        const merged = Object.assign({}, base, tokens);
        const requested = deriveList(opts.derive);
        if (requested.size) deriveInto(merged, requested);
        return merged;
    }

    // ─── Application DOM ────────────────────────────────────────────────────
    function root() {
        return typeof document !== "undefined" ? document.documentElement : null;
    }

    // Préfixe une clé de token : passé tel quel si déjà "--", sinon --holaf-*.
    function prefixKey(key) {
        return key.indexOf("--") === 0 ? key : PREFIX + key;
    }

    // Prend un objet { key: value } (clés sans préfixe ou avec) → objet de
    // variables --holaf-* prêtes pour la pose.
    function tokenVars(values) {
        const vars = {};
        Object.keys(values).forEach((k) => {
            if (values[k] === undefined || values[k] === null) return;
            vars[prefixKey(k)] = String(values[k]);
        });
        return vars;
    }

    function dispatch(theme) {
        if (typeof document === "undefined") return;
        document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { theme } }));
    }

    // Pose des variables --holaf-* sur :root et met à jour l'état interne.
    // `name` = nom de preset (ou null si palette custom). `explicit` distingue
    // la pose volontaire de l'hôte du preset initial automatique.
    function applyTokens(values, name, explicit) {
        const el = root();
        const vars = tokenVars(values);
        if (el) {
            // PURGE PAR POSSESSION D'ENSEMBLE (correctif 0.3.0) : retire d'abord
            // les clés possédées ABSENTES du nouveau lot, PUIS pose le nouveau
            // lot — même tâche JS, donc aucun flash intermédiaire.
            ownedKeys.forEach((k) => {
                if (!Object.prototype.hasOwnProperty.call(vars, k)) el.style.removeProperty(k);
            });
            Object.keys(vars).forEach((k) => el.style.setProperty(k, vars[k]));
        }
        Object.keys(vars).forEach((k) => ownedKeys.add(k));
        currentName = name || null;
        appliedVars = vars;
        if (explicit) explicitChoice = true;
        initialized = true;
        dispatch(name || { vars: Object.assign({}, vars) });
    }

    // ─── Preset initial par défaut (prefers-color-scheme, si AUCUN choix) ──
    // Posé au chargement de la brique, UNIQUEMENT si l'hôte n'a pas déjà fait
    // un choix explicite (donc jamais après un setTheme/setTokens/applyPalette).
    function ensureInitial() {
        if (initialized || explicitChoice) return;
        let preset = "light";
        if (typeof window !== "undefined" && window.matchMedia &&
            window.matchMedia("(prefers-color-scheme: dark)").matches) {
            preset = "dark";
        }
        applyTokens(PRESETS[preset], preset, false);
    }

    // ─── API publique ───────────────────────────────────────────────────────
    // setTokens({ name?, values }) — pose des tokens --holaf-* sur :root.
    function setTokens(spec) {
        if (!spec || typeof spec !== "object" || !spec.values || typeof spec.values !== "object") {
            throw new Error("[HolafTokens] setTokens : attendu { name?, values }.");
        }
        applyTokens(spec.values, spec.name || null, true);
        return getTheme();
    }

    // setTheme(presetName) — applique un preset par son nom. Accepte les
    // <famille>-<mode> (ex. "turquoise-light") ET les alias (dark/light/midnight/slate).
    function setTheme(presetName) {
        const preset = findPreset(presetName);
        if (!preset) {
            throw new Error(
                '[HolafTokens] setTheme : preset inconnu "' + presetName + '" — disponibles : ' +
                listPresets().join(", ") + "."
            );
        }
        applyTokens(preset, presetName, true);
        return getTheme();
    }

    // listPresets() → TOUS les noms valides : 12 familles×modes + 4 alias
    // (intégrés) PUIS les packs hôte dans leur ordre d'enregistrement (0.3.0).
    function listPresets() {
        return Object.keys(PRESETS).concat(Array.from(PACKS.keys()));
    }

    // listFamilies() → noms des familles (axe 1).
    function listFamilies() {
        return FAMILY_NAMES.slice();
    }

    // setFamily(family, mode?) — applique <famille>-<mode>. Sans `mode`, garde le
    // mode courant de cette famille si elle est déjà active, sinon "light".
    function setFamily(family, mode) {
        if (!FAMILIES[family]) {
            throw new Error(
                '[HolafTokens] setFamily : famille inconnue "' + family + '" — disponibles : ' +
                FAMILY_NAMES.join(", ") + "."
            );
        }
        let m = mode;
        if (m === undefined || m === null) {
            m = (currentName && currentName.indexOf(family + "-") === 0)
                ? currentName.slice(family.length + 1)
                : "light";
        }
        if (MODES.indexOf(m) === -1) {
            throw new Error(
                '[HolafTokens] setFamily : mode inconnu "' + m + '" — attendu : ' + MODES.join(" ou ") + "."
            );
        }
        return setTheme(family + "-" + m);
    }

    // describeName(name) → { name, family, mode } | null (résout aussi les alias).
    // Un PACK hôte ne décrit jamais une famille / un mode : getFamily() et
    // getMode() renvoient null pour un pack (contrat 0.3.0).
    function describeName(name) {
        if (!name) return null;
        if (PACKS.has(name)) return null;
        if (ALIASES[name]) {
            const twin = ALIASES[name];
            const i = twin.indexOf("-");
            return { name, family: twin.slice(0, i), mode: twin.slice(i + 1) };
        }
        const i = name.indexOf("-");
        if (i > 0) {
            const fam = name.slice(0, i);
            const md = name.slice(i + 1);
            if (FAMILIES[fam] && MODES.indexOf(md) !== -1) return { name, family: fam, mode: md };
        }
        return null;
    }

    // getFamily() / getMode() → axe 1 / axe 2 du thème courant (ou null).
    function getFamily() {
        const d = describeName(currentName);
        return d ? d.family : null;
    }
    function getMode() {
        const d = describeName(currentName);
        return d ? d.mode : null;
    }

    // getTheme() → { name, vars } (copie) avec les variables actuellement posées,
    // ou les valeurs du dernier preset/tokens appliqué ; null si reset() fait.
    function getTheme() {
        if (!initialized || !appliedVars) {
            return currentName ? { name: currentName, vars: Object.assign({}, PRESETS[currentName] || {}) } : null;
        }
        return { name: currentName, vars: Object.assign({}, appliedVars) };
    }

    // applyPalette(accentHex, opts?) — calcule la palette via les calculs
    // internes (mix/contrast) et la pose. Base = preset en cours (sinon dark).
    function applyPalette(accentHex, opts) {
        const options = opts || {};
        // Base : les surfaces du preset en cours, sinon dark.
        // Base : les surfaces du preset en cours, sinon dark. Le pack (ou le
        // preset) est fusionné PAR-DESSUS dark pour garantir une base complète
        // même si un pack hôte ne fournit qu'une partie des clés.
        const baseName = (currentName && findPreset(currentName)) ? currentName : "dark";
        const base = Object.assign({}, PRESETS.dark, findPreset(baseName));
        const accent = options.accent || accentHex;
        // Validation de l'accent (throw clair) avant tout calcul.
        parseHex(accent);
        const hoverRatio = typeof options.hoverRatio === "number" ? options.hoverRatio : 0.15;
        const borderRatio = typeof options.borderRatio === "number" ? options.borderRatio : 0.22;
        const danger = options.danger || base.danger;
        const accentText = options.accentText
            || (contrastRatio(accent, "#000000") >= contrastRatio(accent, "#ffffff") ? "#000000" : "#ffffff");

        const palette = {
            surface: options.surface || base.surface,
            "surface-elev": options.surfaceElev || base["surface-elev"],
            "surface-raised": options.surfaceRaised || base["surface-raised"],
            border: options.border || mix(base.surface, accent, borderRatio),
            text: options.text || base.text,
            "text-muted": options.textMuted || mix(base.text, base.surface, 0.42),
            accent: toHex.apply(null, parseHex(accent)),
            "accent-hover": options.accentHover || mix(accent, base.surface, hoverRatio),
            "accent-text": accentText,
            danger: toHex.apply(null, parseHex(danger)),
            "danger-text": options.dangerText || base["danger-text"],
            radius: options.radius || base.radius,
            shadow: options.shadow || base.shadow,
            "font-size": options.fontSize || base["font-size"],
        };
        // danger-hover dérivé.
        palette["danger-hover"] = mix(danger, base.surface, hoverRatio);
        applyTokens(palette, null, true);
        return getTheme();
    }

    // reset() — retire TOUTES les variables --holaf-* posées par la brique.
    function reset() {
        const el = root();
        // Retire TOUT le set possédé (pas seulement appliedVars) : les clés
        // posées lors d'applications antérieures sont purgées elles aussi.
        if (el) {
            ownedKeys.forEach((k) => el.style.removeProperty(k));
        }
        ownedKeys.clear();
        currentName = null;
        appliedVars = null;
        // Ne réarme PAS le presets initial automatique : après reset, on est
        // « sans thème » jusqu'au prochain choix de l'hôte.
        dispatch(null);
    }

    // ─── API 0.3.0 — registre de packs hôte (additive) ─────────────────────
    // Les 16 presets INTÉGRÉS sont figés : registerPreset ne les touche jamais.
    // Le registre est VOLATILE (perdu au rechargement) : l'hôte ré-enregistre
    // ses packs au boot, avant de rejouer setTheme.
    function isPlainObject(v) {
        return v !== null && typeof v === "object" && !Array.isArray(v);
    }

    function validatePackName(name) {
        const clean = typeof name === "string" ? name.trim() : "";
        if (!clean) {
            throw new Error("[HolafTokens] registerPreset : nom de pack vide (chaîne non vide attendue).");
        }
        if (RESERVED_NAMES.has(clean)) {
            throw new Error(
                '[HolafTokens] registerPreset : nom réservé "' + clean +
                '" (preset intégré, alias ou famille) — choisissez un autre nom.'
            );
        }
        return clean;
    }

    // registerPreset(name, tokens, options?) → { name, vars } (copie protégée).
    // Un nom déjà enregistré est REMPLACÉ (le pack, pas les intégrés). N'émet
    // PAS d'événement : setTheme("<pack>") émet comme n'importe quel preset.
    function registerPreset(name, tokens, options) {
        const packName = validatePackName(name);
        if (tokens !== undefined && !isPlainObject(tokens)) {
            throw new Error("[HolafTokens] registerPreset : tokens attendu sous forme d'objet { clé: valeur }.");
        }
        if (options !== undefined && !isPlainObject(options)) {
            throw new Error("[HolafTokens] registerPreset : options attendu sous forme d'objet { extends?, derive? }.");
        }
        const opts = options || {};
        // Copie protégée : le registre ne partage AUCUNE référence avec l'hôte
        // (ni les tokens, ni le tableau derive).
        const spec = {
            tokens: Object.assign({}, tokens || {}),
            options: {
                extends: opts.extends,
                derive: Array.isArray(opts.derive) ? opts.derive.slice() : opts.derive,
            },
        };
        const resolved = resolvePack(spec.tokens, spec.options);
        PACKS.set(packName, { spec, resolved });
        return { name: packName, vars: Object.assign({}, resolved) };
    }

    // updatePreset(name, tokens) → { name, vars }. Fusionne dans la spec
    // explicite puis re-résout : les dérivées non re-fournies par l'appel sont
    // recalculées depuis les nouvelles sources. Throw si intégré ou inconnu.
    function updatePreset(name, tokens) {
        if (typeof name === "string" && RESERVED_NAMES.has(name)) {
            throw new Error(
                '[HolafTokens] updatePreset : "' + name +
                '" est un preset intégré (figé) — seuls les packs enregistrés sont modifiables.'
            );
        }
        const pack = PACKS.get(name);
        if (!pack) {
            throw new Error(
                '[HolafTokens] updatePreset : pack inconnu "' + String(name) + '" — packs enregistrés : ' +
                (PACKS.size ? Array.from(PACKS.keys()).join(", ") : "(aucun)") + "."
            );
        }
        if (!isPlainObject(tokens)) {
            throw new Error("[HolafTokens] updatePreset : tokens attendu sous forme d'objet { clé: valeur }.");
        }
        Object.assign(pack.spec.tokens, tokens);
        pack.resolved = resolvePack(pack.spec.tokens, pack.spec.options);
        return { name: name, vars: Object.assign({}, pack.resolved) };
    }

    // unregisterPreset(name) → boolean : false si intégré (jamais dans PACKS)
    // ou inconnu. N'émet PAS d'événement ; la palette déjà posée n'est pas retirée.
    function unregisterPreset(name) {
        return PACKS.delete(name);
    }

    // getPreset(name) → copie (clés non préfixées) d'un intégré / alias / pack,
    // null si inconnu. Copie protégée : muter le retour n'affecte pas le registre.
    function getPreset(name) {
        const preset = findPreset(name);
        return preset ? Object.assign({}, preset) : null;
    }

    // alpha(color, a) — utilitaire public : hex → "rgba(r, g, b, a)", alpha
    // borné à [0, 1]. Couleur non-hex ou alpha non numérique → valeur inchangée.
    function alpha(color, a) {
        const c = hexToken(color);
        if (!c) return color;
        if (a !== undefined && (typeof a !== "number" || !isFinite(a))) return color;
        const av = a === undefined ? 1 : Math.max(0, Math.min(1, a));
        return "rgba(" + c[0] + ", " + c[1] + ", " + c[2] + ", " + av + ")";
    }

    // ─── Injection CSS minimale (une seule fois) ────────────────────────────
    // La brique ne rend rien : le CSS injecté est un simple repère documentant
    // que les variables proviennent du JS, rien de scopé. Guard idempotent.
    const CSS_ID = "holaf-tokens-style";
    function ensureCss() {
        if (typeof document === "undefined") return;
        if (document.getElementById(CSS_ID)) return;
        const style = document.createElement("style");
        style.id = CSS_ID;
        style.textContent =
            "/* HolafTokens (FONDATION) : les variables --holaf-* sont posées " +
            "sur :root par cette brique (JS), aucune règle scopée nécessaire " +
            "— la brique est sans rendu. */";
        const head = document.head || document.documentElement;
        if (head) head.appendChild(style);
    }

    // ─── Initialisation au chargement ───────────────────────────────────────
    ensureCss();
    ensureInitial();

    return {
        VERSION,
        setTokens,
        setTheme,
        setFamily,
        getTheme,
        getFamily,
        getMode,
        applyPalette,
        reset,
        listPresets,
        listFamilies,
        // — API 0.3.0 (additive) —
        registerPreset,
        updatePreset,
        unregisterPreset,
        getPreset,
        alpha,
        PREFIX,
        PRESETS: (function () { const c = {}; Object.keys(PRESETS).forEach((k) => { c[k] = Object.assign({}, PRESETS[k]); }); return c; })(),
        FAMILIES: (function () {
            const c = {};
            FAMILY_NAMES.forEach((f) => {
                c[f] = { label: FAMILIES[f].label, hue: FAMILIES[f].hue };
                MODES.forEach((m) => { c[f][m] = Object.assign({}, FAMILIES[f][m]); });
            });
            return c;
        })(),
        ALIASES: Object.assign({}, ALIASES),
        MIGRATIONS: Object.assign({}, MIGRATIONS),
    };
})();

// ─── Exposition (correctif 0.3.0 : AUCUN export top-level) ───────────────────
// Le fichier est chargeable À LA FOIS :
//   • en <script> classique (file:// ET HTTP)   → window.HolafTokens ;
//   • en <script type="module" src>             → window.HolafTokens ;
//   • en import ESM par effet de bord (`import "./holaf-tokens.js"`) → globalThis.
// La ligne `export { HolafTokens }` de la 0.2.0 est SUPPRIMÉE : elle rendait le
// fichier inutilisable en <script> classique (SyntaxError) alors qu'il pose ses
// variables dès l'évaluation. Conséquence : un consommateur doit désormais
// faire `import "./holaf-tokens.js"; const { HolafTokens } = window;`.
if (typeof window !== "undefined") {
    window.HolafTokens = HolafTokens;
} else if (typeof globalThis !== "undefined") {
    globalThis.HolafTokens = HolafTokens;
}
