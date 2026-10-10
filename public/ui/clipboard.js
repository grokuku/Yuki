/**
 * Copie dans le presse-papiers — avec repli pour les contextes NON sécurisés.
 *
 * ─── Pourquoi ce module existe ─────────────────────────────────────────────
 * `navigator.clipboard.writeText` n'est disponible que dans un **contexte
 * sécurisé** (HTTPS ou `localhost`). Or Yuki s'atteint aussi en **HTTP simple
 * sur une IP de LAN** (proxy HTTPS d'un côté, accès direct de l'autre) : dans ce
 * cas l'API moderne est **absente**. Un bouton « Copier » qui échouerait en
 * silence serait pire que pas de bouton : ce module rapporte **toujours** une
 * issue à l'appelant, qui DOIT la montrer à l'utilisateur.
 *
 * ─── Les trois cas couverts ────────────────────────────────────────────────
 *   1. API moderne présente et acceptée           → `"copied"` ;
 *   2. API moderne ABSENTE (contexte non sûr)     → repli `execCommand("copy")` ;
 *   3. API présente mais REFUSÉE (permission…)    → repli `execCommand("copy")`.
 * Si aucune voie n'aboutit, l'issue est `"failed"` — jamais un silence.
 *
 * Le repli `execCommand` s'exécute **de façon synchrone** dans le gestionnaire
 * de clic (aucun `await` avant lui) : il conserve donc l'activation utilisateur
 * exigée par le navigateur. Le champ temporaire est retiré et le focus restauré.
 *
 * Aucun style en ligne (CSP `style-src 'self'`) : le champ porte une classe CSS.
 * Aucune dépendance, testable avec `navigator`/`document` injectés.
 */

/**
 * Résultat possible d'une copie.
 * @typedef {"copied" | "failed"} CopyResult
 */

/**
 * Copie `text` dans le presse-papiers.
 *
 * @param {string} text — texte EXACT à copier (jamais un libellé d'interface).
 * @param {{ nav?: Navigator, doc?: Document }} [deps] — dépendances injectables
 *   (tests) ; par défaut les globales du navigateur.
 * @returns {Promise<CopyResult>}
 */
export async function copyText(text, deps = {}) {
  const value = String(text ?? "");
  const nav = deps.nav ?? (typeof navigator !== "undefined" ? navigator : undefined);
  const doc = deps.doc ?? (typeof document !== "undefined" ? document : undefined);

  // 1) Voie moderne (contexte sécurisé uniquement).
  if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
    try {
      await nav.clipboard.writeText(value);
      return "copied";
    } catch {
      // Permission refusée / document non focalisé : on tente le repli.
    }
  }

  // 2) Repli : sélection temporaire + `execCommand("copy")`. Synchrone (aucun
  //    `await` en amont) pour préserver l'activation utilisateur.
  if (doc && typeof doc.execCommand === "function") {
    if (execCommandCopy(doc, value)) return "copied";
  }

  // 3) Échec franc : l'appelant DOIT le dire à l'utilisateur.
  return "failed";
}

/**
 * Copie via un `<textarea>` hors écran sélectionné puis `document.execCommand`.
 * Renvoie `true` si le navigateur confirme la copie. Le champ est TOUJOURS
 * retiré et le focus précédent restauré.
 *
 * @param {Document} doc
 * @param {string} value
 * @returns {boolean}
 */
function execCommandCopy(doc, value) {
  const body = doc.body;
  if (!body) return false;

  const previous = doc.activeElement;
  const helper = doc.createElement("textarea");
  helper.className = "md-copy-helper";
  helper.value = value;
  helper.setAttribute("readonly", "");
  helper.setAttribute("aria-hidden", "true");
  helper.setAttribute("tabindex", "-1");
  body.appendChild(helper);

  let ok = false;
  try {
    helper.select();
    // iOS : `select()` ne sélectionne pas toujours tout le contenu.
    if (typeof helper.setSelectionRange === "function") {
      helper.setSelectionRange(0, value.length);
    }
    ok = doc.execCommand("copy") === true;
  } catch {
    ok = false;
  } finally {
    if (helper.parentNode) helper.parentNode.removeChild(helper);
    if (previous && typeof previous.focus === "function") {
      try {
        previous.focus();
      } catch {
        // Le focus ne peut pas toujours être repris : sans conséquence.
      }
    }
  }
  return ok;
}
