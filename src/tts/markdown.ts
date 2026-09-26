/**
 * Filtrage markdown pour la synthèse vocale (Lot 7, §5).
 *
 * Le texte destiné à l'oreille n'est pas le texte destiné à l'écran : lire
 * `**`, `#` ou ``` ``` ``` à voix haute n'a aucun sens. Ce module transforme un
 * flux de texte markdown en texte « parlé » (oublie les marqueurs de mise en
 * forme, conserve le contenu, ignore les blocs de code).
 *
 * Il est **incrémental** : un delta peut couper un marqueur au milieu
 * (`"**gr"` puis `"as**"`). L'état est conservé entre les appels `push`, et la
 * résolution est confirmée dès que la totalité du marqueur est disponible.
 *
 * Depuis le Lot 8, il compose aussi le nettoyage « non parlé » (`SpeechSanitizer`) :
 * emojis, symboles décoratifs et caractères invisibles sont retirés **après** le
 * markdown, et les espaces normalisées. Le filtre reste donc le **point unique**
 * de préparation du texte parlé.
 *
 * Constructs **muets** (chantier interface de chat) : en plus des blocs de code,
 * le filtre ignore désormais :
 *   - les **tableaux** markdown (ligne contenant `|` + ligne séparatrice), y
 *     compris coupés entre deux deltas ;
 *   - les **images** `![alt](url)` **entièrement** (plus de texte alternatif lu) ;
 *   - les blocs explicitement étiquetés **muets** (` ```muet `), via la
 *     convention unique `./mute.ts`.
 * Repli défensif : un construct non reconnu est **lu** (comportement d'origine).
 *
 * Limites documentées (fais au mieux) :
 *   - un bloc de code **non clôturé** est entièrement ignoré (jusqu'au `flush`) ;
 *   - un `*`/`_` isolé est retiré même s'il est une multiplication ;
 *   - un `[` non suivi d'un `]` reste « retenu » jusqu'à la fermeture ou un
 *     dépassement de `MAX_LINK_HOLD` (il est alors émis littéralement) ;
 *   - une ligne contenant `|` est **retenue** le temps de lire la suivante
 *     (décider si c'est un tableau) : sans séparatrice, elle est lue telle quelle ;
 *   - le contenu d'un lien est émis **tel quel** (non re-filtré).
 *
 * Ce comportement correspond au **défaut** du point ouvert C8 de la spec
 * (blocs de code **ignorés**) ; `codeAnnouncement` permet d'insérer une annonce
 * (« Bloc de code omis ») si l'on tranche autrement.
 */

import { isMuteInfoString } from "./mute.js";
import { SpeechSanitizer } from "./sanitize.js";

/** Longueur maximale d'un `[...` retenu en attente d'un `]` (anti-blocage). */
const MAX_LINK_HOLD = 256;

export interface MarkdownFilterOptions {
  /**
   * Annonce insérée à la place d'un bloc de code clôturé, ou `null` (défaut)
   * pour l'ignorer silencieusement.
   */
  codeAnnouncement?: string | null;
}

/** `true` si la ligne ne contient qu'une clôture/ouverture de bloc de code. */
function isFenceDelimiter(line: string, char: string): boolean {
  const trimmed = line.trim();
  let count = 0;
  for (const c of trimmed) {
    if (c === char) count += 1;
    else break;
  }
  if (count < 3) return false;
  return trimmed.slice(count).trim().length === 0;
}

/**
 * `true` si la ligne est une **séparatrice** de tableau markdown : uniquement
 * des tirets, deux-points, pipes et blancs, avec **au moins un tiret**. Ex.
 * `|---|:--:|`, `--- | ---`. Sert uniquement à confirmer qu'une ligne contenant
 * `|` ouvre bien un tableau (jamais à classer une ligne isolée).
 */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  let dashes = 0;
  for (const c of trimmed) {
    if (c === "-") dashes += 1;
    else if (c === ":" || c === "|" || c === " " || c === "\t") continue;
    else return false;
  }
  return dashes > 0;
}

/**
 * Filtre markdown incrémental. Non sûr en concurrence (un état par flux/run) :
 * une instance est **propre à un run** et n'est pas partagée.
 */
export class MarkdownSpeechFilter {
  private raw = "";
  private atLineStart = true;
  private inFence = false;
  private fenceChar = "`";
  /** Le bloc de code courant est étiqueté « muet » (aucune annonce). */
  private fenceMuted = false;
  /** Un tableau markdown est en cours : ses lignes sont ignorées. */
  private inTable = false;
  private readonly codeAnnouncement: string | null;
  /** Second étage : nettoyage des emojis/symboles/invisibles (Lot 8). */
  private readonly sanitizer = new SpeechSanitizer();

  constructor(options: MarkdownFilterOptions = {}) {
    this.codeAnnouncement = options.codeAnnouncement ?? null;
  }

  /** Ajoute un fragment et renvoie le texte parlé devenu résolu. */
  push(fragment: string): string {
    if (fragment.length === 0) return "";
    this.raw += fragment;
    return this.sanitizer.push(this.scan(false));
  }

  /** Vide le flux : renvoie tout le texte restant (résolu en fin de flux). */
  flush(): string {
    // `scan(true)` résout tout ce qui était retenu (marqueur coupé, lien non
    // fermé, dernière ligne d'un tableau) ; la sortie du nettoyeur **doit**
    // être renvoyée, sinon un fragment résolu seulement au flush serait perdu.
    let out = this.sanitizer.push(this.scan(true));
    // Sécurité : en fin de flux `scan(true)` consomme tout, mais on ne perdrait
    // pas un éventuel résidu s'il en restait.
    const leftover = this.raw;
    this.raw = "";
    if (leftover.length > 0) out += this.sanitizer.push(leftover);
    return out + this.sanitizer.flush();
  }

  /** Réinitialise l'état (nouveau run). */
  reset(): void {
    this.raw = "";
    this.atLineStart = true;
    this.inFence = false;
    this.fenceChar = "`";
    this.fenceMuted = false;
    this.inTable = false;
    this.sanitizer.reset();
  }

  private scan(final: boolean): string {
    const raw = this.raw;
    const n = raw.length;
    let out = "";
    let i = 0;

    while (i < n) {
      // --- À l'intérieur d'un bloc de code : tout est ignoré ----------------
      if (this.inFence) {
        const nl = raw.indexOf("\n", i);
        if (nl === -1) {
          if (!final) break; // attendre la fin de la ligne
          i = n;
          break;
        }
        if (isFenceDelimiter(raw.slice(i, nl), this.fenceChar)) {
          this.inFence = false;
          // Un bloc « muet » est ignoré SANS annonce (il n'est pas du code).
          if (this.codeAnnouncement && !this.fenceMuted) {
            out += `${this.codeAnnouncement} `;
          }
          this.fenceMuted = false;
        }
        i = nl + 1;
        this.atLineStart = true;
        continue;
      }

      const ch = raw[i]!;

      // --- Ouverture d'un bloc de code (en début de ligne) ------------------
      if (this.atLineStart && (ch === "`" || ch === "~")) {
        const triple = ch + ch + ch;
        const slice = raw.slice(i, i + 3);
        if (slice === triple) {
          const nl = raw.indexOf("\n", i + 3);
          if (nl === -1 && !final) break; // attendre la fin de la ligne d'ouverture
          this.inFence = true;
          this.fenceChar = ch;
          // Info-string de la ligne d'ouverture (`muet`, `js`…) : décide si le
          // bloc est un bloc muet de la convention (`./mute.ts`).
          const infoEnd = nl === -1 ? n : nl;
          this.fenceMuted = isMuteInfoString(raw.slice(i + 3, infoEnd));
          i = nl === -1 ? n : nl + 1;
          this.atLineStart = true;
          continue;
        }
        if (!final && triple.startsWith(slice) && n - i < 3) break; // marqueur partiel
      }

      // --- Tableaux markdown : entièrement ignorés --------------------------
      if (this.atLineStart) {
        const table = this.scanTableLine(raw, i, final);
        if (table === -1) break; // attendre (ligne/séparatrice incomplète)
        if (table > 0) {
          i += table;
          this.atLineStart = true;
          continue;
        }
      }

      // --- Marqueurs de bloc en début de ligne ------------------------------
      if (this.atLineStart) {
        const consumed = this.matchBlockMarker(raw, i, final);
        if (consumed === -1) break; // attendre
        if (consumed > 0) {
          i += consumed;
          this.atLineStart = false;
          continue;
        }
      }

      // --- Liens / images ---------------------------------------------------
      if (ch === "[" || (ch === "!" && raw[i + 1] === "[")) {
        const link = this.readLink(raw, i, final);
        if (link === null) break; // attendre la fermeture
        out += link.text;
        i = link.next;
        this.atLineStart = false;
        continue;
      }

      // --- Espaces et sauts de ligne ---------------------------------------
      if (ch === " " || ch === "\t") {
        out += ch;
        i += 1;
        continue; // l'état « début de ligne » est conservé à travers les blancs
      }
      if (ch === "\n") {
        out += "\n";
        i += 1;
        this.atLineStart = true;
        continue;
      }

      // --- Marqueurs inline (2 caractères) ---------------------------------
      const two = raw.slice(i, i + 2);
      if (two === "**" || two === "__" || two === "~~") {
        i += 2;
        this.atLineStart = false;
        continue;
      }
      // --- Marqueurs inline (1 caractère) ----------------------------------
      if (ch === "*" || ch === "_" || ch === "`") {
        i += 1;
        this.atLineStart = false;
        continue;
      }

      out += ch;
      i += 1;
      this.atLineStart = false;
    }

    this.raw = raw.slice(i);
    return out;
  }

  /**
   * Reconnaît un marqueur de bloc en début de ligne.
   *
   * @returns le nombre de caractères consommés, `0` si aucun marqueur,
   *          `-1` s'il faut attendre d'autres caractères (marqueur partiel).
   */
  private matchBlockMarker(raw: string, i: number, final: boolean): number {
    const ch = raw[i]!;

    // Titre : `#{1,6} ` en début de ligne.
    if (ch === "#") {
      let k = i;
      while (k < raw.length && raw[k] === "#" && k - i < 7) k += 1;
      const hashes = k - i;
      if (hashes >= 1 && hashes <= 6) {
        if (k >= raw.length) return final ? hashes : -1;
        if (raw[k] === " ") return hashes + 1;
      }
      return 0;
    }

    // Citation : `>` (espace optionnel).
    if (ch === ">") {
      if (i + 1 >= raw.length) return final ? 1 : -1;
      return raw[i + 1] === " " ? 2 : 1;
    }

    // Liste non ordonnée : `- ` / `+ ` / `* `.
    if (ch === "-" || ch === "+" || ch === "*") {
      if (i + 1 >= raw.length) return final ? 0 : -1;
      return raw[i + 1] === " " ? 2 : 0;
    }

    // Liste ordonnée : `1. ` / `1) `.
    if (ch >= "0" && ch <= "9") {
      let k = i;
      while (k < raw.length && raw[k] >= "0" && raw[k] <= "9" && k - i < 9) k += 1;
      const digits = k - i;
      if (digits >= 1 && digits <= 9) {
        if (k >= raw.length) return final ? 0 : -1;
        const sep = raw[k];
        if (sep === "." || sep === ")") {
          if (k + 1 >= raw.length) return final ? 0 : -1;
          if (raw[k + 1] === " ") return digits + 2;
        }
      }
      return 0;
    }

    return 0;
  }

  /**
   * Gère une **ligne de tableau markdown** en début de ligne.
   *
   * Un tableau commence par une ligne contenant `|` suivie d'une
   * **séparatrice** (`|---|`). Une fois reconnu, toutes les lignes contenant `|`
   * sont ignorées jusqu'à une ligne qui n'en contient pas (ou un blanc).
   *
   * @returns le nombre de caractères consommés (lignes entières, saut de ligne
   *          compris) si du tableau a été ignoré, `0` si la ligne courante n'est
   *          pas du tableau (traitée normalement), `-1` s'il faut attendre
   *          d'autres caractères (ligne ou séparatrice incomplète).
   */
  private scanTableLine(raw: string, i: number, final: boolean): number {
    const nl = raw.indexOf("\n", i);
    const complete = nl !== -1;
    const line = raw.slice(i, complete ? nl : raw.length);

    // --- Déjà dans un tableau : consommer chaque ligne qui contient un `|` ---
    if (this.inTable) {
      if (!complete && !final) return -1; // attendre la fin de la ligne
      if (line.includes("|") || isTableSeparator(line)) {
        return (complete ? nl + 1 : raw.length) - i;
      }
      this.inTable = false; // tableau terminé : traiter la ligne normalement
      return 0;
    }

    // --- Hors tableau : seule une ligne contenant `|` peut en ouvrir un ------
    // Un titre ou une citation n'est jamais un en-tête de tableau (on évite de
    // confondre `# A | B` suivi d'une ligne `---` avec un tableau).
    const leading = line.trimStart();
    if (leading.startsWith("#") || leading.startsWith(">")) return 0;
    if (!line.includes("|")) return 0;
    if (!complete) {
      return final ? 0 : -1; // en fin de flux, pas de séparatrice : texte normal
    }

    // La ligne suivante doit être une séparatrice pour confirmer le tableau.
    const sepStart = nl + 1;
    const sepNl = raw.indexOf("\n", sepStart);
    const sepComplete = sepNl !== -1;
    const sepLine = raw.slice(sepStart, sepComplete ? sepNl : raw.length);
    if (isTableSeparator(sepLine)) {
      // Attendre la fin de la séparatrice : sinon le `\n` suivant arriverait
      // dans un delta séparé et clôturerait le tableau à tort.
      if (!sepComplete && !final) return -1;
      this.inTable = true;
      return (sepComplete ? sepNl + 1 : raw.length) - i;
    }
    if (!sepComplete && !final) return -1; // la séparatrice peut encore venir
    return 0; // pas de séparatrice : ce n'est pas un tableau, on lit la ligne
  }

  /**
   * Lit un lien `[texte](url)` (ou une image `![alt](url)`).
   *
   * Un **lien** est réécrit en son texte ; une **image** est ignorée
   * **entièrement** (son texte alternatif n'est jamais parlé : le visuel est
   * muet, il revient au modèle de commenter ce qui compte). Repli défensif pour
   * une image non fermée : on retire le marqueur `![` et on lit le reste.
   *
   * @returns le texte parlé et l'index suivant, ou `null` s'il faut attendre.
   */
  private readLink(
    raw: string,
    i: number,
    final: boolean,
  ): { text: string; next: number } | null {
    const isImage = raw[i] === "!";
    const open = isImage ? i + 1 : i; // index du `[`
    const close = raw.indexOf("]", open + 1);
    if (close === -1) {
      if (!final && raw.length - open <= MAX_LINK_HOLD) return null;
      // Image non fermée : on retire tout de même le marqueur `![` (muet),
      // le reste est lu. Lien non fermé : émis littéralement (inchangé).
      if (isImage) return { text: "", next: open + 1 };
      return { text: raw.slice(i, open + 1), next: open + 1 };
    }
    const inner = raw.slice(open + 1, close);
    if (inner.includes("\n")) {
      return {
        text: isImage ? "" : raw.slice(i, close + 1),
        next: close + 1,
      };
    }
    if (raw[close + 1] === "(") {
      const closeParen = raw.indexOf(")", close + 2);
      if (closeParen === -1) {
        if (!final) return null;
        return { text: isImage ? "" : inner, next: raw.length };
      }
      return { text: isImage ? "" : inner, next: closeParen + 1 };
    }
    return {
      text: isImage ? "" : raw.slice(i, close + 1),
      next: close + 1,
    };
  }
}
