/* ═══════════════════════════════════════════════════════════════════════════
 * Holaf UI — Brique HolafIcons · version 0.1.5
 * ─────────────────────────────────────────────────────────────────────────────
 * Set d'icônes SVG en trait (style « feather »), ZÉRO CSS (aucune feuille
 * n'est injectée) : chaque icône utilise `stroke="currentColor"` et lèse à
 * l'hôte le soin de la colorer via son propre CSS (color / currentColor).
 *
 * Chaque icône est un trait 24×24 (`viewBox="0 0 24 24"`), `fill="none"`,
 * `stroke-width="2"`, lignes/arrondis dans le style Feather. La plupart des
 * tracés sont repris du jeu d'icônes **Feather Icons** (licence MIT — voir
 * `README-holaf-icons.md` pour le crédit complet) ; certaines icônes ajoutées
 * ensuite (ex. `bar-chart`) reprennent ce style mais ne sont PAS des tracés
 * Feather littéraux.
 *
 * AJOUT D'ICÔNE : cherche d'abord l'icône sur icons0.dev — API JSON publique
 * sans clé : GET https://icons0.dev/api/icons?q=<prefix>:<nom> (le champ
 * `body` est déjà le SVG 24×24 en `currentColor`) ; vérifie la licence de la
 * COLLECTION D'ORIGINE avant de copier. Procédure complète : §6 de
 * `README-holaf-icons.md`.
 *
 * API :
 *   HolafIcons.get(name)                          → string SVG (complet, 24px)
 *   HolafIcons.render(name, { size, class })      → string SVG (custom size/class)
 *   HolafIcons.list()                             → noms disponibles
 *   nom inconnu → throw clair listant les proches
 *
 * Fichier DUAL : module ES (export) + global window.HolafIcons — se charge
 * via <script type="module"> ou `import { HolafIcons }`.
 * ═════════════════════════════════════════════════════════════════════════ */

const HolafIcons = (function () {
    "use strict";

    const VERSION = "0.1.5";

    const NS = "http://www.w3.org/2000/svg";

    // ── Corpus des icônes : nom → corps SVG (traits internes, sans wrapper).
    // Style « feather » : 24×24, stroke currentColor, stroke-width 2, fill none.
    // Tracés : majoritairement le jeu Feather Icons (MIT) ; icônes ajoutées
    // (ex. bar-chart) dessinées dans le même style, non reprises de Feather.
    const ICONS = {
        // Graphique / stats (tracé propre au set, style Feather — pas Feather).
        "bar-chart":
            '<rect x="3" y="10" width="4" height="10" rx="1" ry="1"></rect>' +
            '<rect x="10" y="6" width="4" height="14" rx="1" ry="1"></rect>' +
            '<rect x="17" y="13" width="4" height="7" rx="1" ry="1"></rect>',

        // Bouclier / protection.
        shield:
            '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>',

        // Globe / monde.
        globe:
            '<circle cx="12" cy="12" r="10"></circle>' +
            '<line x1="2" y1="12" x2="22" y2="12"></line>' +
            '<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>',

        // Frame / layout (widgets Homy).

        layout:
            '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>' +
            '<line x1="3" y1="9" x2="21" y2="9"></line>' +
            '<line x1="9" y1="21" x2="9" y2="9"></line>',

        // Lien / URL (widget links, iframe, …).
        link:
            '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>' +
            '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>',

        // Horloge (widget clock).
        clock:
            '<circle cx="12" cy="12" r="10"></circle>' +
            '<polyline points="12 6 12 12 16 14"></polyline>',

        // Image (widget image / preview).
        image:
            '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>' +
            '<circle cx="8.5" cy="8.5" r="1.5"></circle>' +
            '<polyline points="21 15 16 10 5 21"></polyline>',

        // Signet.
        bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path>',

        // Recherche (widget search).
        search:
            '<circle cx="11" cy="11" r="8"></circle>' +
            '<line x1="21" y1="21" x2="16.65" y2="16.65"></line>',

        // Note / édition de note (widget notes).
        edit:
            '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>',

        // Météo / nuage (widget weather).
        cloud: '<path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>',

        // Fermer (×).
        x:
            '<line x1="18" y1="6" x2="6" y2="18"></line>' +
            '<line x1="6" y1="6" x2="18" y2="18"></line>',

        // Ajouter (+).
        plus:
            '<line x1="12" y1="5" x2="12" y2="19"></line>' +
            '<line x1="5" y1="12" x2="19" y2="12"></line>',

        // Corbeille.
        trash:
            '<polyline points="3 6 5 6 21 6"></polyline>' +
            '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>' +
            '<line x1="10" y1="11" x2="10" y2="17"></line>' +
            '<line x1="14" y1="11" x2="14" y2="17"></line>',

        // Crayon / stylo (édition).
        pencil:
            '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>' +
            '<path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>',

        // Engrenage / réglages.
        gear:
            '<circle cx="12" cy="12" r="3"></circle>' +
            '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',

        // Lecture / play.
        play: '<polygon points="5 3 19 12 5 21 5 3"></polygon>',

        // Pause.
        pause:
            '<rect x="6" y="4" width="4" height="16"></rect>' +
            '<rect x="14" y="4" width="4" height="16"></rect>',

        // Arrêt / stop (carré).
        stop:
            '<rect x="5" y="5" width="14" height="14" rx="2" ry="2"></rect>',

        // Flèche droite.
        "arrow-right":
            '<line x1="5" y1="12" x2="19" y2="12"></line>' +
            '<polyline points="12 5 19 12 12 19"></polyline>',

        // Œil (visible).
        eye:
            '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>' +
            '<circle cx="12" cy="12" r="3"></circle>',

        // Œil barré (masqué).
        "eye-off":
            '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>' +
            '<line x1="1" y1="1" x2="23" y2="23"></line>',

        // Chevrons directionnels.
        "chevron-down":  '<polyline points="6 9 12 15 18 9"></polyline>',
        "chevron-up":    '<polyline points="18 15 12 9 6 15"></polyline>',
        "chevron-left":  '<polyline points="15 18 9 12 15 6"></polyline>',
        "chevron-right": '<polyline points="9 18 15 12 9 6"></polyline>',

        // Validation.
        check: '<polyline points="20 6 9 17 4 12"></polyline>',

        // Alerte triangle.
        "alert-triangle":
            '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>' +
            '<line x1="12" y1="9" x2="12" y2="13"></line>' +
            '<line x1="12" y1="17" x2="12.01" y2="17"></line>',

        // Info.
        info:
            '<circle cx="12" cy="12" r="10"></circle>' +
            '<line x1="12" y1="16" x2="12" y2="12"></line>' +
            '<line x1="12" y1="8" x2="12.01" y2="8"></line>',

        // Téléchargement.
        download:
            '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' +
            '<polyline points="7 10 12 15 17 10"></polyline>' +
            '<line x1="12" y1="15" x2="12" y2="3"></line>',

        // Envoi / upload.
        upload:
            '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>' +
            '<polyline points="17 8 12 3 7 8"></polyline>' +
            '<line x1="12" y1="3" x2="12" y2="15"></line>',

        // Copier.
        copy:
            '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>' +
            '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',

        // Rafraîchir.
        refresh:
            '<polyline points="23 4 23 10 17 10"></polyline>' +
            '<polyline points="1 20 1 14 7 14"></polyline>' +
            '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>',

        // Agrandir.
        maximize:
            '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>',

        // Réduire.
        minimize:
            '<path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path>',

        // Dossier.
        folder:
            '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>',

        // Terminal / console.
        terminal:
            '<polyline points="4 17 10 11 4 5"></polyline>' +
            '<line x1="12" y1="19" x2="20" y2="19"></line>',

        // Branche git.
        "git-branch":
            '<line x1="6" y1="3" x2="6" y2="15"></line>' +
            '<circle cx="18" cy="6" r="3"></circle>' +
            '<circle cx="6" cy="18" r="3"></circle>' +
            '<path d="M18 9a9 9 0 0 1-9 9"></path>',

        // Soleil (mode clair).
        sun:
            '<circle cx="12" cy="12" r="5"></circle>' +
            '<line x1="12" y1="1" x2="12" y2="3"></line>' +
            '<line x1="12" y1="21" x2="12" y2="23"></line>' +
            '<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>' +
            '<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>' +
            '<line x1="1" y1="12" x2="3" y2="12"></line>' +
            '<line x1="21" y1="12" x2="23" y2="12"></line>' +
            '<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>' +
            '<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>',

        // Lune (mode sombre).
        moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>',

        // ── v0.1.4 : ajouts pour la migration d'icônes de Pi-Web ──────────────
        // Les 9 premières sont des tracés Feather littéraux (MIT, Cole Bemis).

        // Document / fichier texte.
        "file-text":
            '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>' +
            '<path d="M14 2v6h6m-4 5H8m8 4H8m2-8H8"></path>',

        // Lien externe (ouvrir ailleurs).
        "external-link":
            '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6m4-3h6v6m-11 5L21 3"></path>',

        // Flèche haut dans un cercle (mise à jour / upload).
        "arrow-up-circle":
            '<circle cx="12" cy="12" r="10"></circle>' +
            '<path d="m16 12l-4-4l-4 4m4 4V8"></path>',

        // Flèche haut (ex. git push).
        "arrow-up": '<path d="M12 19V5m-7 7l7-7l7 7"></path>',

        // Flèche bas (ex. git pull).
        "arrow-down": '<path d="M12 5v14m7-7l-7 7l-7-7"></path>',

        // Utilisateur (identité, compte).
        user:
            '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>' +
            '<circle cx="12" cy="7" r="4"></circle>',

        // Clé (clés API, secrets).
        key:
            '<path d="m21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778a5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>',

        // Alimentation / activer (bouton power).
        power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"></path>',

        // Étoile (favori / défaut).
        star: '<path d="m12 2l3.09 6.26L22 9.27l-5 4.87l1.18 6.88L12 17.77l-6.18 3.25L7 14.14L2 9.27l6.91-1.01z"></path>',

        // ── Tracés Tabler Icons (MIT) — Feather ne les fournit pas ────────────

        // Dossier ouvert.
        "folder-open":
            '<path d="m5 19l2.757-7.351A1 1 0 0 1 8.693 11H21a1 1 0 0 1 .986 1.164l-.996 5.211A2 2 0 0 1 19.026 19za2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2"></path>',

        // Cerveau (mémoire / analyse).
        brain:
            '<path d="M15.5 13a3.5 3.5 0 0 0-3.5 3.5v1a3.5 3.5 0 0 0 7 0v-1.8M8.5 13a3.5 3.5 0 0 1 3.5 3.5v1a3.5 3.5 0 0 1-7 0v-1.8"></path>' +
            '<path d="M17.5 16a3.5 3.5 0 0 0 0-7H17"></path>' +
            '<path d="M19 9.3V6.5a3.5 3.5 0 0 0-7 0M6.5 16a3.5 3.5 0 0 1 0-7H7"></path>' +
            '<path d="M5 9.3V6.5a3.5 3.5 0 0 1 7 0v10"></path>',

        // ── v0.1.5 : ajouts pour la migration d'icônes de Yuki ───────────────
        // Tracés Feather littéraux (MIT, Cole Bemis), sourcés via icons0.dev
        // (GET /api/icons?q=feather:<nom>) — voir README-holaf-icons.md §6.

        // Flèche gauche (retour / navigation arrière) — miroir de `arrow-right`.
        "arrow-left":
            '<line x1="19" y1="12" x2="5" y2="12"></line>' +
            '<polyline points="12 19 5 12 12 5"></polyline>',

        // Volume actif (haut-parleur + ondes). Tracé Feather `volume-2` fourni
        // sous le nom court `volume` (la brique ne porte pas les variantes -1/-2).
        volume:
            '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>' +
            '<path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>',

        // Volume coupé (haut-parleur barré). Tracé Feather `volume-x`, nommé
        // `volume-off` (nom sémantique demandé par Yuki ; Feather dit `volume-x`).
        "volume-off":
            '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>' +
            '<line x1="23" y1="9" x2="17" y2="15"></line>' +
            '<line x1="17" y1="9" x2="23" y2="15"></line>',
    };

    // ── Helpers ─────────────────────────────────────────────────────────────
    // Distance de Levenshtein : permet de « proposer les proches » pour un nom
    // inconnu (fautes de frappe / orthographe approximative).
    function levenshtein(a, b) {
        const m = a.length;
        const n = b.length;
        const d = new Array(m + 1);
        for (let i = 0; i <= m; i++) d[i] = new Array(n + 1).fill(0);
        for (let i = 0; i <= m; i++) d[i][0] = i;
        for (let j = 0; j <= n; j++) d[0][j] = j;
        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                d[i][j] = Math.min(
                    d[i - 1][j] + 1,
                    d[i][j - 1] + 1,
                    d[i - 1][j - 1] + cost
                );
            }
        }
        return d[m][n];
    }

    // Construction du SVG complet (wrapper + corps) avec taille/class.
    function buildSvg(body, size, className) {
        const s = Number.isFinite(size) && size > 0 ? size : 24;
        const cls = className ? ' class="' + className + '"' : "";
        return (
            '<svg xmlns="' + NS + '" viewBox="0 0 24 24" width="' + s + '" height="' + s +
            '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
            'stroke-linejoin="round"' + cls + '>' + body + "</svg>"
        );
    }

    // Récupération du corps, avec erreur claire listant les proches.
    function bodyOf(name) {
        if (typeof name !== "string" || name.length === 0) {
            throw new Error(
                "[HolafIcons] nom d'icône invalide. Voir list() pour les noms disponibles."
            );
        }
        const key = name.trim();
        if (Object.prototype.hasOwnProperty.call(ICONS, key)) return ICONS[key];

        // Nom inconnu → proposer les plus proches (distance de Levenshtein).
        const closest = Object.keys(ICONS)
            .map((n) => ({ name: n, d: levenshtein(key.toLowerCase(), n.toLowerCase()) }))
            .sort((a, b) => a.d - b.d)
            .filter((x, i) => i < 5)
            .map((x) => x.name + (x.d <= 2 ? " ←" : ""));
        throw new Error(
            "[HolafIcons] icône inconnue : '" + key + "'. " +
            "Disponibles : " + Object.keys(ICONS).join(", ") +
            ". Proches : " + closest.join(", ") + "."
        );
    }

    // ── API publique ─────────────────────────────────────────────────────────
    return {
        version: VERSION,

        list() {
            return Object.keys(ICONS);
        },

        get(name) {
            return buildSvg(bodyOf(name), 24, null);
        },

        render(name, opts) {
            const o = opts || {};
            const size =
                o.size !== undefined && o.size !== null
                    ? Number(o.size)
                    : 24;
            const cls = o.class || o.className || "";
            return buildSvg(bodyOf(name), size, cls);
        },
    };
})();

// Exposition globale (scripts classiques de la page).
if (typeof window !== "undefined") {
    window.HolafIcons = HolafIcons;
}

// Export ESM (import { HolafIcons } from "./holaf-icons.js").
export { HolafIcons };
