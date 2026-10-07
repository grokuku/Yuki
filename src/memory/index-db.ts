/**
 * `MemoryIndex` — index de recherche plein texte (SQLite + FTS5, Lot 12).
 *
 * ⚠️ L'index est DÉRIVÉ et JETABLE : la source de vérité est le JSONL
 * (`MemoryStore`). Il est reconstruit à tout moment (`rebuild`) ; un index
 * absent ou corrompu n'empêche jamais le démarrage (on repart d'un index vide et
 * on reconstruit en tâche de fond — voir `MemoryService.start`).
 *
 * Accents : la colonne indexée contient `foldText(texte)` (accents retirés) et la
 * requête est construite par `buildMatchQuery` (même repli). La recherche est
 * donc insensible aux accents ET à la casse. Le tokenizer déclare en plus
 * `remove_diacritics 2` (ceinture-bretelles).
 *
 * ZÉRO dépendance npm : `node:sqlite` est un module intégré à Node.
 */

import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { buildMatchQuery, foldText } from "./normalize.js";
import type { MemoryEntry, MemoryLogger } from "./types.js";

export interface MemoryIndexOptions {
  path: string;
  logger?: MemoryLogger;
}

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export class MemoryIndex {
  private readonly path: string;
  private readonly logger?: MemoryLogger;
  private db: DatabaseSync | undefined;
  private statements:
    | {
        insert: SqliteStatement;
        remove: SqliteStatement;
        clear: SqliteStatement;
        search: SqliteStatement;
        count: SqliteStatement;
      }
    | undefined;

  constructor(options: MemoryIndexOptions) {
    this.path = options.path;
    this.logger = options.logger;
  }

  get filePath(): string {
    return this.path;
  }

  isAvailable(): boolean {
    return this.db !== undefined;
  }

  /**
   * Ouvre (ou crée) la base et la table FTS5. Renvoie `false` si l'index est
   * indisponible après tentative (jamais d'exception vers l'appelant).
   */
  open(): boolean {
    if (this.db) return true;
    try {
      if (this.path === ":memory:") {
        return this.openAt(this.path, false);
      }
      mkdirSync(dirname(this.path), { recursive: true });
    } catch (error) {
      this.logger?.warn("memory.index.dir.failed", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    if (this.openAt(this.path, false)) return true;
    // Fichier corrompu : c'est un DÉRIVÉ ⇒ on le supprime et on réessaie UNE fois.
    try {
      rmSync(this.path, { force: true });
      this.logger?.warn("memory.index.corrupt.recreated", { path: this.path });
    } catch (error) {
      this.logger?.error("memory.index.remove.failed", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
    return this.openAt(this.path, true);
  }

  private openAt(path: string, recreated: boolean): boolean {
    try {
      const db = new DatabaseSync(path);
      db.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(" +
          "mem_id UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')",
      );
      const insert = db.prepare(
        "INSERT INTO memory_fts(mem_id, body) VALUES(?, ?)",
      );
      const remove = db.prepare("DELETE FROM memory_fts WHERE mem_id = ?");
      const clear = db.prepare("DELETE FROM memory_fts");
      const search = db.prepare(
        "SELECT mem_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?",
      );
      const count = db.prepare("SELECT COUNT(*) AS n FROM memory_fts");
      this.db = db;
      this.statements = {
        insert: insert as unknown as SqliteStatement,
        remove: remove as unknown as SqliteStatement,
        clear: clear as unknown as SqliteStatement,
        search: search as unknown as SqliteStatement,
        count: count as unknown as SqliteStatement,
      };
      this.logger?.debug("memory.index.opened", {
        path: this.path,
        recreated,
      });
      return true;
    } catch (error) {
      this.logger?.warn("memory.index.open.failed", {
        path: this.path,
        recreated,
        error: error instanceof Error ? error.message : String(error),
      });
      this.db = undefined;
      this.statements = undefined;
      return false;
    }
  }

  /** Reconstruit l'index à partir des entrées courantes (transactionnel). */
  rebuild(entries: readonly MemoryEntry[]): void {
    if (!this.db || !this.statements) return;
    try {
      this.db.exec("BEGIN");
      try {
        this.statements.clear.run();
        for (const entry of entries) {
          this.statements.insert.run(entry.id, foldText(entry.text));
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.logger?.debug("memory.index.rebuilt", { entries: entries.length });
    } catch (error) {
      this.logger?.warn("memory.index.rebuild.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Nombre de documents indexés (0 si l'index est indisponible). */
  count(): number {
    if (!this.db || !this.statements) return 0;
    try {
      const rows = this.statements.count.all() as Array<{ n?: unknown }>;
      const value = rows[0]?.n;
      return typeof value === "number" ? value : 0;
    } catch {
      return 0;
    }
  }

  upsert(entry: MemoryEntry): void {
    if (!this.db || !this.statements) return;
    try {
      this.statements.remove.run(entry.id);
      this.statements.insert.run(entry.id, foldText(entry.text));
    } catch (error) {
      this.logger?.warn("memory.index.upsert.failed", {
        id: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  remove(id: string): void {
    if (!this.db || !this.statements) return;
    try {
      this.statements.remove.run(id);
    } catch (error) {
      this.logger?.warn("memory.index.remove.failed", {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Recherche bornée : renvoie au plus `topK` identifiants, du plus pertinent au
   * moins pertinent (bm25). Renvoie `[]` si l'index est indisponible ou si la
   * requête n'a aucun terme exploitable (jamais d'exception).
   */
  search(query: string, topK: number): string[] {
    if (!this.db || !this.statements) return [];
    const match = buildMatchQuery(query);
    if (!match || topK <= 0) return [];
    try {
      const rows = this.statements.search.all(match, topK) as Array<{
        mem_id?: unknown;
      }>;
      const ids: string[] = [];
      for (const row of rows) {
        if (typeof row.mem_id === "string") ids.push(row.mem_id);
      }
      return ids;
    } catch (error) {
      this.logger?.warn("memory.index.search.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  close(): void {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
    this.db = undefined;
    this.statements = undefined;
  }
}
