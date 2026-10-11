/**
 * `TextDocumentStore` — SOCLE PARTAGÉ d'un document Markdown éditable : fichier
 * + historique de versions + journal append-only + retour en arrière.
 *
 * Ce module est LA MISE EN COMMUN du mécanisme de la personnalité
 * (`personality.md`) et des règles strictes (`rules.md`) : les deux documents
 * ont exactement les mêmes garde-fous (lecture tolérante, borne dure signalée,
 * snapshots horodatés purgés, journal avant/après redacté, `revert()`). On ne
 * réimplémente PAS le mécanisme : on l'instancie avec un `label` distinct, qui
 * préfixe les clés de journalisation (ex. `personality.truncated`,
 * `rules.truncated`) et nomme par défaut les dossiers (`<label>-history`,
 * `<label>-journal.jsonl`).
 *
 * Invariants :
 *  - LECTURE TOLÉRANTE : fichier absent ou illisible ⇒ contenu vide, AUCUNE
 *    exception (un document illisible ne doit jamais faire échouer un tour).
 *  - BORNE DURE : un contenu plus long est TRONQUÉ avec un avertissement
 *    VISIBLE (journalisé + remonté dans le résultat), jamais en silence.
 *  - Historique : un snapshot par version écrite ; purge des plus anciens au
 *    delà de `historyMax`. `revert()` restaure la version précédente (la plus
 *    récente différente de l'actuelle).
 *  - Journal : JSONL, avant/après REDACTÉS (aucun secret de l'environnement).
 *
 * Aucun import SDK/typebox.
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { collectSecretValues, redactObject } from "../observability/logger.js";

const HISTORY_SUFFIX = ".md";

/**
 * Écriture ATOMIQUE (fichier temporaire puis `rename`). Deux autres copies
 * locales subsistent (`src/tts/engine-config.ts`, `src/tts/voices-store.ts`,
 * `src/agents/ca.ts`) : elles restent hors périmètre de ce lot (ne pas élargir
 * au code TTS/agents). En revanche la personnalité ET les règles partagent
 * CETTE implémentation : plus aucune duplication pour les documents éditables.
 */
function writeAtomic(path: string, data: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

/** Horodatage compact et portable pour nommer un snapshot (`:`/`.` remplacés). */
function isoCompact(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

/** Source d'une écriture (qui l'a produite). */
export type TextDocumentSource = "user" | "model";

/** Sous-ensemble du logger d'observabilité utilisé par le socle. */
export interface TextDocumentLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Lecture d'un document (contenu effectif, borné). */
export interface TextDocumentReadResult {
  /** Contenu effectif (borné à `maxChars`). */
  text: string;
  /** Nombre de caractères (points de code) du contenu effectif. */
  chars: number;
  /** `true` si le fichier dépassait la borne et a été tronqué à la lecture. */
  truncated: boolean;
  /** `false` si le fichier n'existe pas (alors `text` est vide). */
  exists: boolean;
}

/** Version de l'historique (snapshot horodaté). */
export interface TextDocumentHistoryEntry {
  /** Identifiant du snapshot (horodatage contenu dans le nom de fichier). */
  at: string;
  /** Contenu de la version. */
  text: string;
  /** Nombre de caractères du contenu (borné). */
  chars: number;
}

/** Résultat d'une écriture (ou d'un retour arrière). */
export interface TextDocumentWriteResult {
  /** `false` si le contenu était identique à l'actuel (aucune écriture). */
  changed: boolean;
  /** Contenu effectif après l'opération. */
  text: string;
  chars: number;
  /** `true` si le contenu fourni a été tronqué à la borne. */
  truncated: boolean;
  /** Nombre de caractères du contenu AVANT l'opération. */
  beforeChars: number;
}

/**
 * Entrée du journal. `before`/`after` sont REDACTÉS (aucun secret de
 * l'environnement n'y apparaît).
 */
export interface TextDocumentJournalEntry {
  v: 1;
  at: string;
  source: TextDocumentSource;
  beforeChars: number;
  afterChars: number;
  truncated: boolean;
  before: string;
  after: string;
}

/** Résultat de la normalisation d'un texte à la borne. */
export interface ClampedText {
  /** Contenu borné (au plus `max` points de code). */
  text: string;
  /** Nombre de points de code du contenu borné. */
  chars: number;
  /** `true` si le texte fourni dépassait la borne et a été tronqué. */
  truncated: boolean;
}

/**
 * Borne un texte à `max` **points de code** (un emoji = un caractère, pas deux).
 * Le débordement est SIGNALÉ (`truncated`), jamais silencieux.
 */
export function clampText(text: string, max: number): ClampedText {
  const codePoints = Array.from(text);
  if (codePoints.length <= max) {
    return { text, chars: codePoints.length, truncated: false };
  }
  return {
    text: codePoints.slice(0, max).join(""),
    chars: max,
    truncated: true,
  };
}

export interface TextDocumentStoreOptions {
  /** Fichier du document (ex. `/data/state/personality.md`). */
  path: string;
  /** Dossier des snapshots (défaut : `<dir(path)>/<label>-history`). */
  historyDir?: string;
  /** Journal (défaut : `<dir(path)>/<label>-journal.jsonl`). */
  journalPath?: string;
  logger?: TextDocumentLogger;
  now?: () => number;
  /** Valeurs secrètes à masquer dans le journal (défaut : `collectSecretValues()`). */
  secretValues?: string[];
  /** Nombre de versions conservées. */
  historyMax: number;
  /** Borne de caractères (défaut appliqué aux écritures et lectures). */
  maxChars: number;
  /**
   * Étiquette du document : préfixe des clés de journalisation et nom par
   * défaut des dossiers dérivés (ex. « personality », « rules »).
   */
  label: string;
}

/**
 * Store d'un document Markdown versionné. Voir le commentaire de tête pour le
 * contrat (lecture tolérante, borne signalée, historique, journal, réversion).
 */
export class TextDocumentStore {
  private readonly path: string;
  private readonly historyDir: string;
  private readonly journalPath: string;
  private readonly logger?: TextDocumentLogger;
  private readonly now: () => number;
  private readonly secretValues: string[];
  private readonly historyMax: number;
  private readonly label: string;
  /** Compteur monotone : garantit l'ordre des snapshots d'une même milliseconde. */
  private seq = 0;
  readonly maxChars: number;

  constructor(options: TextDocumentStoreOptions) {
    this.path = options.path;
    const baseDir = dirname(options.path);
    this.historyDir = options.historyDir ?? join(baseDir, `${options.label}-history`);
    this.journalPath =
      options.journalPath ?? join(baseDir, `${options.label}-journal.jsonl`);
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.secretValues = options.secretValues ?? collectSecretValues();
    this.historyMax = options.historyMax;
    this.maxChars = options.maxChars;
    this.label = options.label;
  }

  get filePath(): string {
    return this.path;
  }

  get historyPath(): string {
    return this.historyDir;
  }

  get journalFilePath(): string {
    return this.journalPath;
  }

  /**
   * Lit le document FRAÎCHEMENT. Fichier absent ⇒ contenu vide (jamais
   * d'erreur). Fichier trop long ⇒ tronqué et signalé.
   */
  read(): TextDocumentReadResult {
    if (!existsSync(this.path)) {
      return { text: "", chars: 0, truncated: false, exists: false };
    }
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch (error) {
      // Le fichier existe mais est illisible : on traite comme vide pour ne
      // jamais faire échouer un tour, et on journalise honnêtement.
      this.logger?.warn(`${this.label}.read.failed`, {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
      return { text: "", chars: 0, truncated: false, exists: true };
    }
    const clamped = clampText(content, this.maxChars);
    return {
      text: clamped.text,
      chars: clamped.chars,
      truncated: clamped.truncated,
      exists: true,
    };
  }

  /**
   * Écrit le document (atomique) + un snapshot horodaté + une entrée de
   * journal. Renvoie `changed:false` sans rien écrire si le contenu est
   * identique à l'actuel.
   */
  write(text: string, source: TextDocumentSource): TextDocumentWriteResult {
    const clamped = clampText(text, this.maxChars);
    const before = this.read();
    if (before.text === clamped.text) {
      return {
        changed: false,
        text: clamped.text,
        chars: clamped.chars,
        truncated: clamped.truncated,
        beforeChars: before.chars,
      };
    }

    writeAtomic(this.path, clamped.text, 0o600);

    const at = this.now();
    this.snapshot(clamped.text, at);
    this.purgeHistory();
    this.appendJournal({
      v: 1,
      at: new Date(at).toISOString(),
      source,
      beforeChars: before.chars,
      afterChars: clamped.chars,
      truncated: clamped.truncated,
      before: before.text,
      after: clamped.text,
    });

    if (clamped.truncated) {
      // Troncature SIGNALÉE (jamais silencieuse) : borne atteinte.
      this.logger?.warn(`${this.label}.truncated`, {
        source,
        receivedChars: Array.from(text).length,
        maxChars: this.maxChars,
      });
    }
    this.logger?.info(`${this.label}.written`, {
      source,
      beforeChars: before.chars,
      afterChars: clamped.chars,
      truncated: clamped.truncated,
    });
    return {
      changed: true,
      text: clamped.text,
      chars: clamped.chars,
      truncated: clamped.truncated,
      beforeChars: before.chars,
    };
  }

  /**
   * Restaure la version PRÉCÉDENTE (le snapshot le plus récent dont le contenu
   * diffère de l'actuel). Renvoie `null` s'il n'y a rien à restaurer. La
   * restauration est elle-même une écriture (snapshot + journal, source).
   */
  revert(source: TextDocumentSource): TextDocumentWriteResult | null {
    const current = this.read();
    const previous = this.history().find((entry) => entry.text !== current.text);
    if (!previous) return null;
    return this.write(previous.text, source);
  }

  /** Versions de l'historique, de la plus récente à la plus ancienne. */
  history(limit?: number): TextDocumentHistoryEntry[] {
    if (!existsSync(this.historyDir)) return [];
    let names: string[];
    try {
      names = readdirSync(this.historyDir)
        .filter((name) => name.endsWith(HISTORY_SUFFIX) && !name.startsWith("."))
        .sort()
        .reverse();
    } catch (error) {
      this.logger?.warn(`${this.label}.history.list.failed`, {
        dir: this.historyDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    if (limit !== undefined && limit >= 0) names = names.slice(0, limit);
    const out: TextDocumentHistoryEntry[] = [];
    for (const name of names) {
      try {
        const content = readFileSync(join(this.historyDir, name), "utf8");
        const clamped = clampText(content, this.maxChars);
        out.push({
          at: name.slice(0, -HISTORY_SUFFIX.length),
          text: clamped.text,
          chars: clamped.chars,
        });
      } catch (error) {
        this.logger?.warn(`${this.label}.history.read.failed`, {
          file: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return out;
  }

  /** Écrit un snapshot horodaté (nom trié lexicographiquement). */
  private snapshot(text: string, at: number): void {
    const seq = String(this.seq++).padStart(6, "0");
    const name = `${isoCompact(at)}-${seq}-${randomBytes(3).toString("hex")}${HISTORY_SUFFIX}`;
    try {
      writeAtomic(join(this.historyDir, name), text, 0o600);
    } catch (error) {
      this.logger?.warn(`${this.label}.history.snapshot.failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Purge les snapshots au-delà de `historyMax` (les plus anciens d'abord). */
  private purgeHistory(): void {
    let names: string[];
    try {
      names = readdirSync(this.historyDir)
        .filter((name) => name.endsWith(HISTORY_SUFFIX) && !name.startsWith("."))
        .sort();
    } catch {
      return;
    }
    const excess = names.length - this.historyMax;
    for (let index = 0; index < excess; index += 1) {
      try {
        rmSync(join(this.historyDir, names[index]), { force: true });
      } catch (error) {
        this.logger?.warn(`${this.label}.history.purge.failed`, {
          file: names[index],
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Ajoute UNE ligne au journal. Le contenu avant/après est REDACTÉ : aucune
   * valeur secrète de l'environnement n'apparaît. Une écriture de journal qui
   * échoue n'invalide pas l'écriture principale (déjà atomiquement persistée).
   */
  private appendJournal(entry: TextDocumentJournalEntry): void {
    const redacted = redactObject(
      { before: entry.before, after: entry.after },
      this.secretValues,
    );
    const line = JSON.stringify({
      ...entry,
      before: redacted.before,
      after: redacted.after,
    });
    try {
      mkdirSync(dirname(this.journalPath), { recursive: true });
      appendFileSync(this.journalPath, `${line}\n`, "utf8");
    } catch (error) {
      this.logger?.warn(`${this.label}.journal.failed`, {
        path: this.journalPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
