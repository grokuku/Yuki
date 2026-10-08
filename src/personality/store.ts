/**
 * `PersonalityStore` — personnalité de Yuki : fichier + historique + journal.
 *
 * PROMESSES UTILISATEUR : la personnalité est un fichier Markdown LISIBLE et
 * CORRIGEABLE À LA MAIN (`personality.md`), chaque écriture est VERSIONNÉE
 * (snapshots horodatés, 20 conservés) et JOURNALISÉE (avant/après, source,
 * horodatage). L'écriture est ATOMIQUE (aucun fichier à moitié écrit).
 *
 * Invariants :
 *  - LECTURE TOLÉRANTE : fichier absent ou illisible ⇒ contenu vide, AUCUNE
 *    exception (la personnalité ne doit jamais faire échouer un tour).
 *  - BORNE DURE (8 000 points de code) : un contenu plus long est TRONQUÉ avec
 *    un avertissement VISIBLE (journalisé + remonté dans le résultat), jamais
 *    en silence.
 *  - Historique : un snapshot par version écrite ; purge des plus anciens au
 *    delà de 20. `revert()` restaure la version précédente (la plus récente
 *    différente de l'actuelle).
 *  - Journal : `personality-journal.jsonl`, avant/après REDACTÉS (aucun secret
 *    de l'environnement n'y apparaît).
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

import {
  PERSONALITY_HISTORY_MAX,
  PERSONALITY_MAX_CHARS,
  clampPersonalityText,
} from "./personality.js";
import type {
  PersonalityAdminPort,
  PersonalityDocument,
  PersonalityHistoryEntry,
  PersonalityJournalEntry,
  PersonalityLogger,
  PersonalitySource,
  PersonalityWriteResult,
} from "./types.js";

const HISTORY_SUFFIX = ".md";

/**
 * Écriture ATOMIQUE (fichier temporaire puis `rename`). Helper volontairement
 * DUPLIQUÉ : les trois autres copies locales (`src/tts/engine-config.ts`,
 * `src/tts/voices-store.ts`, `src/agents/ca.ts`) suivent la même convention
 * (helper local, non exporté). On ne les factorise PAS pour ne pas élargir le
 * périmètre d'un lot de personnalité au code TTS/agents (risque de régression).
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

export interface PersonalityStoreOptions {
  /** Fichier de personnalité (ex. `/data/state/personality.md`). */
  path: string;
  /** Dossier des snapshots (défaut : `<dir(path)>/personality-history`). */
  historyDir?: string;
  /** Journal (défaut : `<dir(path)>/personality-journal.jsonl`). */
  journalPath?: string;
  logger?: PersonalityLogger;
  now?: () => number;
  /** Valeurs secrètes à masquer dans le journal (défaut : `collectSecretValues()`). */
  secretValues?: string[];
  /** Nombre de versions conservées (défaut : `PERSONALITY_HISTORY_MAX`). */
  historyMax?: number;
  /** Borne de caractères (défaut : `PERSONALITY_MAX_CHARS`). */
  maxChars?: number;
}

/**
 * Store de personnalité. Implémente `PersonalityPort` (extension SDK) et
 * `PersonalityAdminPort` (API `/api/self/personality`).
 */
export class PersonalityStore implements PersonalityAdminPort {
  private readonly path: string;
  private readonly historyDir: string;
  private readonly journalPath: string;
  private readonly logger?: PersonalityLogger;
  private readonly now: () => number;
  private readonly secretValues: string[];
  private readonly historyMax: number;
  readonly maxChars: number;
  /** Compteur monotone : garantit l'ordre des snapshots d'une même milliseconde. */
  private seq = 0;

  constructor(options: PersonalityStoreOptions) {
    this.path = options.path;
    const baseDir = dirname(options.path);
    this.historyDir = options.historyDir ?? join(baseDir, "personality-history");
    this.journalPath =
      options.journalPath ?? join(baseDir, "personality-journal.jsonl");
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.secretValues = options.secretValues ?? collectSecretValues();
    this.historyMax = options.historyMax ?? PERSONALITY_HISTORY_MAX;
    this.maxChars = options.maxChars ?? PERSONALITY_MAX_CHARS;
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
   * Lit la personnalité FRAÎCHE. Fichier absent ⇒ contenu vide (jamais
   * d'erreur). Fichier trop long ⇒ tronqué et signalé.
   */
  read(): PersonalityDocument {
    if (!existsSync(this.path)) {
      return { text: "", chars: 0, truncated: false, exists: false };
    }
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch (error) {
      // Le fichier existe mais est illisible : on traite comme vide pour ne
      // jamais faire échouer un tour, et on journalise honnêtement.
      this.logger?.warn("personality.read.failed", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
      return { text: "", chars: 0, truncated: false, exists: true };
    }
    const clamped = clampPersonalityText(content, this.maxChars);
    return {
      text: clamped.text,
      chars: clamped.chars,
      truncated: clamped.truncated,
      exists: true,
    };
  }

  /**
   * Écrit la personnalité (atomique) + un snapshot horodaté + une entrée de
   * journal. Renvoie `changed:false` sans rien écrire si le contenu est
   * identique à l'actuel.
   */
  write(text: string, source: PersonalitySource): PersonalityWriteResult {
    const clamped = clampPersonalityText(text, this.maxChars);
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
      this.logger?.warn("personality.truncated", {
        source,
        receivedChars: Array.from(text).length,
        maxChars: this.maxChars,
      });
    }
    this.logger?.info("personality.written", {
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
  revert(source: PersonalitySource): PersonalityWriteResult | null {
    const current = this.read();
    const previous = this.history().find((entry) => entry.text !== current.text);
    if (!previous) return null;
    return this.write(previous.text, source);
  }

  /** Versions de l'historique, de la plus récente à la plus ancienne. */
  history(limit?: number): PersonalityHistoryEntry[] {
    if (!existsSync(this.historyDir)) return [];
    let names: string[];
    try {
      names = readdirSync(this.historyDir)
        .filter((name) => name.endsWith(HISTORY_SUFFIX) && !name.startsWith("."))
        .sort()
        .reverse();
    } catch (error) {
      this.logger?.warn("personality.history.list.failed", {
        dir: this.historyDir,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    if (limit !== undefined && limit >= 0) names = names.slice(0, limit);
    const out: PersonalityHistoryEntry[] = [];
    for (const name of names) {
      try {
        const content = readFileSync(join(this.historyDir, name), "utf8");
        const clamped = clampPersonalityText(content, this.maxChars);
        out.push({
          at: name.slice(0, -HISTORY_SUFFIX.length),
          text: clamped.text,
          chars: clamped.chars,
        });
      } catch (error) {
        this.logger?.warn("personality.history.read.failed", {
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
      this.logger?.warn("personality.history.snapshot.failed", {
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
        this.logger?.warn("personality.history.purge.failed", {
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
  private appendJournal(entry: PersonalityJournalEntry): void {
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
      this.logger?.warn("personality.journal.failed", {
        path: this.journalPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

