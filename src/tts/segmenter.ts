/**
 * Segmentation incrémentale par phrase (Lot 7, §5) — cœur du principe TTS.
 *
 * Un delta peut couper une phrase en plein milieu : on ne synthétise qu'une
 * **phrase complète** (ponctuation forte suivie d'un blanc), afin que
 * l'intonation du modèle ne s'effondre pas sur des fragments. Deux bornes
 * évitent les extrêmes :
 *   - **longueur minimale** `tts.minSentenceChars` : les phrases trop courtes
 *     (« Oui. ») sont fusionnées avec la suivante ;
 *   - **longueur maximale** `tts.maxSentenceChars` : coupe forcée (à la virgule
 *     la plus proche, sinon à l'espace) pour ne jamais bloquer le pipeline.
 *
 * **Exception au minimum : le PREMIER segment d'un flux** (D44). Pour réduire
 * le TTFA, le premier segment part **dès la première ponctuation forte**, même
 * plus court que `tts.minSentenceChars`, sous réserve d'un **plancher**
 * anti-fragment (`FIRST_SEGMENT_FLOOR_CHARS`) : un moteur `offline` (Chatterbox)
 * ne rend le WAV qu'après avoir synthétisé le segment **entier**, donc plus le
 * premier segment est court, plus le premier son arrive tôt. La règle ne vaut
 * que pour le **premier** segment du run (les suivants gardent min/max, sinon la
 * parole deviendrait hachée) et se réarme à chaque `reset()`.
 *
 * Le `flush` final restitue le résidu sans ponctuation terminale. Le filtrage
 * markdown (blocs de code, emphases, liens…) est délégué à
 * `MarkdownSpeechFilter` ; ce module reste **pur** (aucune I/O, aucun timer) et
 * donc directement testable.
 *
 * Limites documentées :
 *   - les abréviations détectées (`M.`, `Dr.`, `etc.`…) ne créent pas de
 *     frontière ; une phrase finissant littéralement par `etc.` sera fusionnée
 *     avec la suivante ;
 *   - `maxChars < minChars` est ramené à `min = max` (sinon aucune frontière
 *     naturelle ne serait jamais acceptée).
 */

import { MarkdownSpeechFilter } from "./markdown.js";

/** Abréviations françaises courantes dont le point n'est pas une frontière. */
const ABBREVIATIONS = new Set([
  "m",
  "mm",
  "mme",
  "mmes",
  "mlle",
  "mlles",
  "dr",
  "dre",
  "pr",
  "st",
  "ste",
  "etc",
  "cf",
  "p",
  "pp",
  "ex",
  "fig",
  "art",
  "no",
  "nos",
  "vs",
  "env",
  "av",
  "bd",
  "tel",
  "tél",
]);

/** Caractères de fermeture admis entre la ponctuation et le blanc. */
const CLOSERS = "»\"')]”’";

/**
 * Plancher anti-fragment du **premier** segment d'un flux (D44).
 *
 * Le premier segment peut être plus court que `tts.minSentenceChars`, mais pas
 * au point d'envoyer une onction dérisoire au moteur. `8` est la **borne basse
 * du schéma** (`tts.minSentenceChars` : `min 8`, `src/config/schema.ts`) : en
 * dessous, il s'agit plus probablement d'une interjection ou d'un fragment
 * (« M. », « ! ») que d'une amorce utile. Le plancher n'est **jamais** plus
 * restrictif que la config : `effMin = min(8, tts.minSentenceChars)`, donc un
 * `tts.minSentenceChars ≤ 8` conserve exactement l'ancien comportement.
 */
const FIRST_SEGMENT_FLOOR_CHARS = 8;

/** Au moins un caractère prononçable (lettre ou chiffre). */
const WORD_CHAR_RE = /[0-9A-Za-zÀ-ÿ]/;

export interface SegmenterOptions {
  /** Longueur minimale d'un segment émis (`tts.minSentenceChars`). */
  minChars?: number;
  /** Longueur maximale d'un segment (`tts.maxSentenceChars`). */
  maxChars?: number;
  /** Désactive le filtrage markdown (tests/segments déjà propres). */
  filterMarkdown?: boolean;
  /** Annonce des blocs de code (défaut : ignorés silencieusement). */
  codeAnnouncement?: string | null;
}

/** `true` si le point à `dotIndex` clôt une abréviation ou un nombre. */
function isAbbreviationDot(text: string, dotIndex: number): boolean {
  const before = text.slice(0, dotIndex);
  const match = /([A-Za-zÀ-ÿ0-9]+)$/.exec(before);
  if (!match) return false;
  const word = match[1]!;
  if (ABBREVIATIONS.has(word.toLowerCase())) return true;
  // Initiale (« M. Dupont », « J. »).
  if (word.length === 1 && /[A-Za-zÀ-ÿ]/.test(word)) return true;
  // Nombre décimal (« 3.14 »).
  if (/[0-9]$/.test(word) && /^[0-9]/.test(text.slice(dotIndex + 1))) return true;
  return false;
}

/** Options de `findSentenceEnd` (pour le cas « premier segment », D44). */
export interface SentenceEndOptions {
  /**
   * N'accepte qu'un segment contenant au moins un caractère prononçable
   * (lettre/chiffre). Garde-fou du premier segment : empêche d'émettre une
   * suite de ponctuation (« ........ ») qui atteindrait le plancher de longueur.
   */
  requireWordChars?: boolean;
}

/**
 * Cherche la première fin de phrase acceptable : ponctuation forte suivie d'un
 * blanc (ou fin de flux), d'une longueur (trimée) ≥ `min` et ≤ `max`.
 *
 * @returns l'index de fin (exclu) du segment, ou `-1` si aucune frontière.
 */
export function findSentenceEnd(
  text: string,
  min: number,
  max: number,
  options: SentenceEndOptions = {},
): number {
  const requireWordChars = options.requireWordChars === true;
  let openQuote = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "«") {
      openQuote += 1;
      continue;
    }
    if (ch === "»") {
      if (openQuote > 0) openQuote -= 1;
      continue;
    }
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") continue;
    // Une ponctuation DANS une citation ouverte n'est pas une frontière :
    // « Bonjour ! » puis …  se termine à l'ellipse, pas au point d'exclamation.
    if (openQuote > 0) continue;

    let j = i + 1;
    while (j < text.length && "!?.".includes(text[j]!)) j += 1;
    while (j < text.length && CLOSERS.includes(text[j]!)) j += 1;
    if (j < text.length && !/\s/.test(text[j]!)) continue;
    if (ch === "." && isAbbreviationDot(text, i)) continue;

    const length = text.slice(0, j).trim().length;
    if (length < min) continue;
    if (j > max) continue;
    // Garde-fou du premier segment : une ponctuation seule n'est jamais parlée.
    if (requireWordChars && !WORD_CHAR_RE.test(text.slice(0, j))) continue;
    return j;
  }
  return -1;
}

/**
 * Coupe forcée d'un segment trop long : virgule (ou `;`/`:`) la plus proche
 * avant la borne, sinon l'espace précédent, sinon la borne elle-même.
 */
export function forcedCutIndex(text: string, max: number): number {
  const window = text.slice(0, max);
  for (let k = window.length - 1; k >= 1; k -= 1) {
    if (",;:".includes(window[k]!)) return k + 1;
  }
  const space = window.lastIndexOf(" ");
  if (space >= 1) return space;
  return max;
}

/**
 * Segmenteur incrémental par phrase. Une instance est **propre à un run** ;
 * `push` renvoie les segments complets disponibles, `flush` le résidu.
 */
export class SentenceSegmenter {
  private readonly filter: MarkdownSpeechFilter | null;
  private readonly min: number;
  private readonly max: number;
  /** Plancher effectif du premier segment : `min(FIRST_SEGMENT_FLOOR_CHARS, min)`. */
  private readonly firstFloor: number;
  private buffer = "";
  /** `true` dès le premier segment émis du run (règle D44 réarmée par `reset`). */
  private emittedFirst = false;

  constructor(options: SegmenterOptions = {}) {
    const maxChars = Math.max(1, Math.floor(options.maxChars ?? 240));
    const minChars = Math.max(1, Math.floor(options.minChars ?? 24));
    this.max = maxChars;
    this.min = Math.min(minChars, maxChars);
    this.firstFloor = Math.min(FIRST_SEGMENT_FLOOR_CHARS, this.min);
    this.filter =
      options.filterMarkdown === false
        ? null
        : new MarkdownSpeechFilter({
            codeAnnouncement: options.codeAnnouncement ?? null,
          });
  }

  /** Alimente le segmenteur et renvoie les phrases complètes. */
  push(fragment: string): string[] {
    if (fragment.length === 0) return [];
    const plain = this.filter ? this.filter.push(fragment) : fragment;
    this.buffer += plain;
    return this.drain();
  }

  /** Résidu de fin de run (texte sans ponctuation finale). */
  flush(): string[] {
    const tail = this.filter ? this.filter.flush() : "";
    this.buffer += tail;
    const segments = this.drain();
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest.length > 0) segments.push(rest);
    this.filter?.reset();
    return segments;
  }

  /** Réinitialise l'état (abandon de run). */
  reset(): void {
    this.buffer = "";
    this.emittedFirst = false;
    this.filter?.reset();
  }

  /** Nombre de caractères en attente (non encore émis). */
  get pendingChars(): number {
    return this.buffer.length;
  }

  private drain(): string[] {
    const out: string[] = [];
    for (;;) {
      // Les blancs de tête ne comptent pas dans la longueur.
      const trimmed = this.buffer.replace(/^\s+/, "");
      if (trimmed.length === 0) {
        this.buffer = "";
        break;
      }
      this.buffer = trimmed;

      // Le PREMIER segment du run accepte le plancher (D44) et exige un mot ;
      // dès qu'il est émis, on revient à la règle min/max historique.
      const useFirstRule = !this.emittedFirst && this.firstFloor < this.min;
      const boundary = useFirstRule
        ? findSentenceEnd(this.buffer, this.firstFloor, this.max, {
            requireWordChars: true,
          })
        : findSentenceEnd(this.buffer, this.min, this.max);
      if (boundary > 0) {
        const segment = this.buffer.slice(0, boundary).trim();
        this.buffer = this.buffer.slice(boundary);
        if (segment.length > 0) {
          out.push(segment);
          this.emittedFirst = true;
        }
        continue;
      }

      if (this.buffer.length > this.max) {
        const cut = forcedCutIndex(this.buffer, this.max);
        const segment = this.buffer.slice(0, cut).trim();
        this.buffer = this.buffer.slice(cut);
        if (segment.length > 0) {
          out.push(segment);
          this.emittedFirst = true;
        }
        continue;
      }

      break;
    }
    return out;
  }
}
