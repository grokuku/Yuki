/**
 * Nettoyage « non parlé » du texte destiné à la synthèse vocale (Lot 8).
 *
 * Le filtre markdown (`./markdown.ts`) retire la mise en forme, mais laisse
 * passer **emojis, pictogrammes, symboles décoratifs et caractères invisibles** :
 * un moteur TTS les prononce mal, les épelle, ou émet des sons parasites. Ce
 * module transforme le flux de texte « déjà markdowné » en texte réellement
 * **parlable**, et **seulement** cela :
 *
 *   - supprime les **emojis** et pictogrammes (séquences ZWJ, modificateurs de
 *     peau, sélecteurs de variation, paires d'indicateurs régionaux = drapeaux) ;
 *   - supprime les **symboles décoratifs** (flèches, coches, étoiles, cœurs,
 *     puces, dingbats…) ;
 *   - supprime les **caractères invisibles / de contrôle** (ZWSP, ZWJ, BOM,
 *     trait d'union conditionnel, marques bidi, tags…) ;
 *   - **normalise les espaces** : tous les blancs « exotiques » (insécables,
 *     fines, cadratin…) deviennent une espace normale, les espaces consécutives
 *     sont réduites à une seule.
 *
 * **Ce qui est impérativement préservé** (le segmenteur de phrases en dépend) :
 * lettres et accents, chiffres, unités (`% € ° C`), ponctuation française
 * (`« » … “ ”`) et apostrophes, tirets, et **toute ponctuation de fin de
 * phrase** (`. ! ? …`). Les plages ci-dessous sont choisies pour ne **jamais**
 * englober ces caractères.
 *
 * **Incrémental.** Un fragment peut couper une séquence en deux : c'est le cas
 * **critique** d'une paire de substitution (un emoji non-BMP = 2 unités UTF-16).
 * Le filtre **retient** alors le demi-caractère en attente (`pending`) et ne
 * l'émet qu'une fois la paire complète — ou l'ignore s'il s'agit d'un
 * demi-surrogate isolé en fin de flux. Un demi-emoji n'est **jamais** émis ; tout
 * caractère adjacent est conservé.
 *
 * Aucune dépendance externe, aucune table téléchargée : uniquement des **plages
 * Unicode explicites** et une boucle sur les points de code (pas d'expression
 * régulière, donc aucun risque de retour arrière catastrophique).
 */

/** Un espace « exotique » à normaliser en espace normale (`U+0020`). */
function isSpaceLike(cp: number): boolean {
  return (
    cp === 0x0009 || // TABULATION
    cp === 0x0020 || // ESPACE
    cp === 0x00a0 || // ESPACE INSÉCABLE
    cp === 0x1680 || // TRÉMA OGAM
    (cp >= 0x2000 && cp <= 0x200a) || // espaces quadratin → fine (U+2007 chiffre, U+2009 fine…)
    cp === 0x2028 || // SÉPARATEUR DE LIGNE
    cp === 0x2029 || // SÉPARATEUR DE PARAGRAPHE
    cp === 0x202f || // ESPACE INSÉCABLE FINE
    cp === 0x205f || // ESPACE MATHÉMATIQUE MOYENNE
    cp === 0x3000 // ESPACE IDÉOGRAPHIQUE
  );
}

/** Retour à la ligne conservé (structure de flux). */
function isNewline(cp: number): boolean {
  return cp === 0x000a;
}

/**
 * Caractère normalement **invisible** ou de formatage : il ne se prononce pas et
 * sa suppression ne laisse aucune trace (contrairement à un symbole, on
 * n'insère **pas** d'espace à sa place).
 */
function isInvisible(cp: number): boolean {
  return (
    cp === 0x00ad || // TRAIT D'UNION CONDITIONNEL (soft hyphen)
    cp === 0x061c || // MARQUE DE LETTRE ARABE
    cp === 0x180e || // SÉPARATEUR DE VOYELLE MONGOL
    cp === 0x200b || // ESPACE DE LARGEUR NULLE (ZWSP)
    cp === 0x200c || // ANTIJOINTEUR DE LARGEUR NULLE (ZWNJ)
    cp === 0x200d || // JOINTEUR DE LARGEUR NULLE (ZWJ)
    cp === 0x200e || // MARQUE GAUCHE-À-DROITE (LRM)
    cp === 0x200f || // MARQUE DROITE-À-GAUCHE (RLM)
    (cp >= 0x202a && cp <= 0x202e) || // plongements/dépassements bidi (LRE…RLO)
    (cp >= 0x2060 && cp <= 0x2064) || // opérateurs invisibles (word joiner…)
    (cp >= 0x2066 && cp <= 0x2069) || // isolats bidi
    (cp >= 0xfe00 && cp <= 0xfe0f) || // sélecteurs de variation
    cp === 0xfeff || // ESPACE SANS COUPURE LARGEUR NULLE / BOM
    (cp >= 0x20d0 && cp <= 0x20ff) || // marques diacritiques pour symboles (+ keycap U+20E3)
    (cp >= 0xe0100 && cp <= 0xe01ef) || // sélecteurs de variation (supplément)
    (cp >= 0xe0000 && cp <= 0xe007f) // caractères « tag » (drapeaux 🏴…)
  );
}

/** Caractères de contrôle C0/C1 (hors tabulation et retour à la ligne). */
function isControl(cp: number): boolean {
  if (isNewline(cp) || isSpaceLike(cp)) return false;
  return cp <= 0x001f || cp === 0x007f || (cp >= 0x0080 && cp <= 0x009f);
}

/**
 * Emoji, pictogramme ou symbole décoratif : supprimé, et si un autre
 * caractère le suit immédiatement (sans blanc), un espace est inséré pour
 * **éviter de coller deux mots**.
 *
 * ⚠️ Les plages ci-dessous **excluent** volontairement la ponctuation, les
 * unités, les devises et les opérateurs mathématiques : voir `docs/lot8.md` §12.
 */
function isEmojiOrSymbol(cp: number): boolean {
  return (
    // © ® ™ ℹ : symboles emoji-capables isolés dans des blocs autrement gardés.
    cp === 0x00a9 ||
    cp === 0x00ae ||
    cp === 0x2122 ||
    cp === 0x2139 ||
    // Puces décoratives de ponctuation générale (•, ‣).
    cp === 0x2022 ||
    cp === 0x2023 ||
    // Flèches.
    (cp >= 0x2190 && cp <= 0x21ff) ||
    // Symboles techniques divers (⌚ ⌛ ⌘ ⏎…).
    (cp >= 0x2300 && cp <= 0x23ff) ||
    // Alphanumériques cerclés (① Ⓐ…).
    (cp >= 0x2460 && cp <= 0x24ff) ||
    // Formes géométriques (▲ ● ○ ◆…).
    (cp >= 0x25a0 && cp <= 0x25ff) ||
    // Symboles divers (★ ☺ ♥ ☕ ⚠…).
    (cp >= 0x2600 && cp <= 0x26ff) ||
    // Dingbats (✓ ✔ ✂ ❤ ✨…).
    (cp >= 0x2700 && cp <= 0x27bf) ||
    // Flèches supplémentaires-B (⤴ ⤵…).
    (cp >= 0x2900 && cp <= 0x297f) ||
    // Symboles et flèches divers (⭐ ⬆ ⬛ ⭕…).
    (cp >= 0x2b00 && cp <= 0x2bff) ||
    // Emoji CJK isolés (〰 〽 ㊗ ㊙).
    cp === 0x3030 ||
    cp === 0x303d ||
    cp === 0x3297 ||
    cp === 0x3299 ||
    // Bloc emoji/pictogrammes (plans supplémentaires) : inclut les drapeaux
    // (indicateurs régionaux U+1F1E6–U+1F1FF), les tons de peau
    // (U+1F3FB–U+1F3FF), les cartes, les dominos…
    (cp >= 0x1f000 && cp <= 0x1faff)
  );
}

/**
 * Catégories **volontairement conservées** (elles ne sont pas dans les plages
 * ci-dessus) : ponctuation latine et française, symboles de devise (€ £ ¥…),
 * opérateurs mathématiques (± × ÷ ≤ ≥), unités (° ℃ ℉), signes de paragraphe et
 * marques d'espacement. Le détail et la justification sont dans
 * `docs/lot8.md` §12.
 */

/**
 * Nettoyeur incrémental, **sans état partagé** : une instance par flux (comme
 * `MarkdownSpeechFilter`, dont elle est le second étage). Non sûr en concurrence.
 */
export class SpeechSanitizer {
  /** Caractères reçus mais pas encore résolus (demi-surrogate en attente). */
  private pending = "";
  /** Nature du dernier caractère émis (pour l'écrasement des espaces). */
  private lastKind: "none" | "space" | "newline" | "other" = "none";
  /** Un symbole vient d'être supprimé : décider d'un espace de séparation. */
  private pendingRemoved = false;

  /** Ajoute un fragment et renvoie le texte nettoyé devenu résolu. */
  push(fragment: string): string {
    if (fragment.length === 0) return "";
    this.pending += fragment;
    return this.scan(false);
  }

  /** Vide le flux : renvoie le texte restant (un demi-surrogate isolé est ignoré). */
  flush(): string {
    const out = this.scan(true);
    // À `final`, `scan` résout tout : `pending` ne devrait plus rien contenir.
    this.pending = "";
    return out;
  }

  /** Réinitialise l'état (nouveau run). */
  reset(): void {
    this.pending = "";
    this.lastKind = "none";
    this.pendingRemoved = false;
  }

  private scan(final: boolean): string {
    const raw = this.pending;
    const n = raw.length;
    let out = "";
    let i = 0;

    while (i < n) {
      const code = raw.charCodeAt(i);
      let cp = code;
      let len = 1;

      // --- Surrogates : jamais émettre un demi-emoji ------------------------
      if (code >= 0xd800 && code <= 0xdbff) {
        if (i + 1 >= n) {
          if (!final) break; // attendre le « low surrogate »
          i += 1; // demi-surrogate isolé en fin de flux : ignoré
          continue;
        }
        const low = raw.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          cp = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
          len = 2;
        } else {
          i += 1; // high surrogate suivi d'autre chose : unité invalide, ignorée
          continue;
        }
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        i += 1; // low surrogate orphelin : ignoré
        continue;
      }

      // --- Symboles / emojis : suppression (avec séparation si collé) --------
      if (isEmojiOrSymbol(cp)) {
        this.pendingRemoved = true;
        i += len;
        continue;
      }

      // --- Invisibles / contrôle : suppression pure -------------------------
      if (isInvisible(cp) || isControl(cp)) {
        i += len;
        continue;
      }

      // --- Retour à la ligne : conservé ------------------------------------
      if (isNewline(cp)) {
        out += "\n";
        this.lastKind = "newline";
        this.pendingRemoved = false;
        i += len;
        continue;
      }

      // --- Blancs : normalisés et écrasés ----------------------------------
      if (isSpaceLike(cp)) {
        if (this.lastKind !== "space") {
          out += " ";
          this.lastKind = "space";
        }
        this.pendingRemoved = false;
        i += len;
        continue;
      }

      // --- Caractère parlé : conservé --------------------------------------
      if (
        this.pendingRemoved &&
        this.lastKind !== "none" &&
        this.lastKind !== "space" &&
        this.lastKind !== "newline"
      ) {
        // Un symbole supprimé collait deux mots (« Bonjour😊Ensuite »).
        out += " ";
        this.lastKind = "space";
      }
      this.pendingRemoved = false;
      out += raw.slice(i, i + len);
      this.lastKind = "other";
      i += len;
    }

    this.pending = raw.slice(i);
    return out;
  }
}
