/**
 * `ConversationArchiveStore` — archive des conversations mises de côté.
 *
 * ⚠️ SOURCE DE VÉRITÉ = les FICHIERS JSON (un par conversation, lisibles et
 * supprimables à la main, dans le volume `state`). L'index FTS5 est DÉRIVÉ et
 * JETABLE : il est réconcilié au premier usage, et un index absent ou corrompu
 * ne fait JAMAIS échouer l'archivage ni la mise de côté.
 *
 * Invariants :
 *  - IDEMPOTENT : une conversation déjà archivée n'est ni réécrite ni dupliquée
 *    (écriture en `wx`, jamais d'écrasement) ;
 *  - JAMAIS bloquant pour la mise de côté : toutes les erreurs d'archivage sont
 *    journalisées et renvoyées (`archived:false`, `path:null`), jamais levées ;
 *  - JAMAIS lu par l'extracteur de mémoire ni par une extension de prompt : seul
 *    l'outil `chercher_conversations_archivees` (lecture seule) le consulte ;
 *  - la recherche est PLEIN TEXTE : colonne indexée = `foldText(texte)` (casse et
 *    accents ignorés), colonne restituée = texte ORIGINAL.
 *
 * ZÉRO dépendance npm : `node:sqlite` est un module intégré à Node.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  buildConversationArchiveReadme,
  conversationFileName,
  CONVERSATION_ARCHIVE_INDEX_FILE,
  CONVERSATION_ARCHIVE_README_FILE,
  type ArchiveSearchHit,
  type ArchiveWriteResult,
  type ArchivedConversation,
  type ArchivedConversationDraft,
  type ConversationArchiveInfo,
  type ConversationArchivePort,
} from "./conversation-archive.js";
import { buildMatchQuery, foldText } from "./normalize.js";
import type { MemoryLogger } from "./types.js";

export interface ConversationArchiveStoreOptions {
  /** Dossier d'archive (ex. `/data/state/conversations-archive`). */
  dir: string;
  /**
   * Fichier SQLite de l'index FTS5. Défaut : voisin du dossier d'archive
   * (`<parent>/conversations-archive-index.sqlite`).
   */
  indexPath?: string;
  logger?: MemoryLogger;
  now?: () => number;
}

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** Index FTS5 de l'archive (colonnes non indexées = métadonnées d'affichage). */
const FTS_TABLE = "conversation_fts";
/** Table DÉRIVÉE de suivi : quelles conversations sont déjà indexées. */
const TRACK_TABLE = "conversation_index";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Lit un fichier d'archive. Renvoie `null` si illisible (jamais d'exception). */
export function parseArchivedConversation(content: string): ArchivedConversation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.v !== 1) return null;
  if (typeof parsed.id !== "string" || parsed.id.length === 0) return null;
  const rawMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const messages: ArchivedConversation["messages"] = [];
  for (const raw of rawMessages) {
    if (!isRecord(raw)) continue;
    const role = raw.role;
    const text = raw.text;
    const at = raw.at;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof text !== "string" || text.length === 0) continue;
    messages.push({ at: typeof at === "string" ? at : "", role, text });
  }
  return {
    v: 1,
    id: parsed.id,
    title:
      typeof parsed.title === "string" && parsed.title.length > 0 ? parsed.title : parsed.id,
    archivedAt: typeof parsed.archivedAt === "string" ? parsed.archivedAt : "",
    messages,
  };
}

/**
 * Archive des conversations mises de côté. Implémente `ConversationArchivePort`
 * (écriture à la mise de côté, lecture seule pour l'outil du modèle).
 */
export class ConversationArchiveStore implements ConversationArchivePort {
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly logger?: MemoryLogger;
  private readonly now: () => number;
  private reconciling = false;
  private db: DatabaseSync | undefined;
  private statements:
    | {
        insert: SqliteStatement;
        deleteConversation: SqliteStatement;
        search: SqliteStatement;
        trackUpsert: SqliteStatement;
        trackDelete: SqliteStatement;
        tracked: SqliteStatement;
      }
    | undefined;

  constructor(options: ConversationArchiveStoreOptions) {
    this.dir = options.dir;
    this.indexPath =
      options.indexPath ?? join(dirname(this.dir), CONVERSATION_ARCHIVE_INDEX_FILE);
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  get dirPath(): string {
    return this.dir;
  }

  get indexFilePath(): string {
    return this.indexPath;
  }

  /**
   * Met en place le dossier d'archive et sa notice SANS écraser l'existant.
   * Une erreur d'écriture est journalisée et n'empêche rien.
   */
  ensureLayout(): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const readme = join(this.dir, CONVERSATION_ARCHIVE_README_FILE);
      if (!existsSync(readme)) {
        writeFileSync(readme, `${buildConversationArchiveReadme()}\n`, "utf8");
      }
    } catch (error) {
      this.logger?.warn("memory.conversation_archive.layout.failed", {
        dir: this.dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Archive UNE conversation entière. IDEMPOTENT : si le fichier existe déjà, la
   * conversation n'est ni réécrite ni dupliquée (`archived:false`).
   */
  archiveConversation(input: ArchivedConversationDraft): ArchiveWriteResult {
    const at = new Date(this.now()).toISOString();
    const id = input.id;
    const empty: ArchiveWriteResult = { archived: false, id, path: null, messages: 0, at };
    if (id.length === 0) return empty;
    const path = join(this.dir, conversationFileName(id));
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch (error) {
      this.logger?.warn("memory.conversation_archive.dir.failed", {
        dir: this.dir,
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }
    if (existsSync(path)) {
      // ⚠️ IDEMPOTENCE : mettre de côté deux fois ne réécrit pas l'archive.
      this.logger?.debug("memory.conversation_archive.already", { id, path });
      return { ...empty, path };
    }
    const conversation: ArchivedConversation = {
      v: 1,
      id,
      title: input.title,
      archivedAt: input.archivedAt ?? at,
      messages: input.messages.map((message) => ({
        at: message.at,
        role: message.role,
        text: message.text,
      })),
    };
    try {
      // `wx` : jamais d'écrasement, même en cas de course.
      writeFileSync(path, `${JSON.stringify(conversation, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === "EEXIST") {
        this.logger?.debug("memory.conversation_archive.already", { id, path });
        return { ...empty, path };
      }
      this.logger?.warn("memory.conversation_archive.write.failed", {
        id,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }
    // L'index DÉRIVÉ suit : une erreur d'index n'annule pas l'archivage.
    this.indexConversation(conversation, path);
    this.logger?.info("memory.conversation_archive.archived", {
      id,
      path,
      messages: conversation.messages.length,
    });
    return { archived: true, id, path, messages: conversation.messages.length, at };
  }

  /** Recherche PLEIN TEXTE bornée. `[]` si rien/indisponible (jamais d'exception). */
  search(query: string, limit: number): ArchiveSearchHit[] {
    const match = buildMatchQuery(query);
    if (!match || limit <= 0) return [];
    if (!this.ensureIndex()) return [];
    try {
      const rows = this.statements!.search.all(match, limit) as Array<
        Record<string, unknown>
      >;
      const hits: ArchiveSearchHit[] = [];
      for (const row of rows) {
        if (typeof row.conv_id !== "string" || typeof row.raw !== "string") continue;
        hits.push({
          conversationId: row.conv_id,
          title: typeof row.conv_title === "string" ? row.conv_title : row.conv_id,
          archivedAt: typeof row.conv_archived === "string" ? row.conv_archived : "",
          at: typeof row.msg_at === "string" ? row.msg_at : "",
          role: typeof row.msg_role === "string" ? row.msg_role : "assistant",
          text: row.raw,
        });
      }
      return hits;
    } catch (error) {
      this.logger?.warn("memory.conversation_archive.search.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** Synthèse (conversations/messages) — lecture du DOSSIER, pas de l'index. */
  info(): ConversationArchiveInfo {
    const files = this.archiveFiles();
    let messages = 0;
    for (const file of files) {
      const conversation = this.readConversation(file);
      if (conversation) messages += conversation.messages.length;
    }
    return {
      present: files.length > 0,
      conversations: files.length,
      messages,
      dir: this.dir,
    };
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

  /** Fichiers d'archive lisibles (triés), sans la notice ni les fichiers cachés. */
  private archiveFiles(): string[] {
    if (!existsSync(this.dir)) return [];
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (error) {
      this.logger?.warn("memory.conversation_archive.read_dir.failed", {
        dir: this.dir,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    return names
      .filter((name) => !name.startsWith(".") && name.endsWith(".json"))
      .sort()
      .map((name) => join(this.dir, name));
  }

  private readConversation(file: string): ArchivedConversation | null {
    try {
      return parseArchivedConversation(readFileSync(file, "utf8"));
    } catch (error) {
      this.logger?.warn("memory.conversation_archive.read.failed", {
        file,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private fileBytes(file: string): number {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
  }

  /**
   * Ouvre l'index et le RÉCONCILIE avec le dossier. Renvoie `false` si l'index
   * est indisponible (la recherche répond alors `[]`, sans exception).
   */
  private ensureIndex(): boolean {
    if (!this.openIfNeeded()) return false;
    // Un seul `reconcile` à la fois : `indexConversation` peut être rappelé par
    // le câblage pendant une réconciliation (jamais de récursion infinie).
    if (this.reconciling) return true;
    this.reconciling = true;
    try {
      this.reconcile();
    } finally {
      this.reconciling = false;
    }
    return true;
  }

  /** Ouvre (ou récupère) l'index, sans réconciliation. `false` si indisponible. */
  private openIfNeeded(): boolean {
    if (this.db) return true;
    if (!this.openIndex(false)) {
      // Index corrompu : c'est un DÉRIVÉ ⇒ on le supprime et on réessaie UNE fois.
      try {
        rmSync(this.indexPath, { force: true });
        this.logger?.warn("memory.conversation_archive.index.recreated", {
          path: this.indexPath,
        });
      } catch (error) {
        this.logger?.warn("memory.conversation_archive.index.remove.failed", {
          path: this.indexPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      if (!this.openIndex(true)) return false;
    }
    return true;
  }

  private openIndex(recreated: boolean): boolean {
    try {
      if (this.indexPath !== ":memory:") {
        mkdirSync(dirname(this.indexPath), { recursive: true });
      }
      const db = new DatabaseSync(this.indexPath);
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(` +
          "conv_id UNINDEXED, conv_title UNINDEXED, conv_archived UNINDEXED, " +
          "msg_at UNINDEXED, msg_role UNINDEXED, raw UNINDEXED, body, " +
          "tokenize='unicode61 remove_diacritics 2')",
      );
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${TRACK_TABLE}(` +
          "conv_id TEXT PRIMARY KEY, file TEXT NOT NULL, bytes INTEGER NOT NULL)",
      );
      this.db = db;
      this.statements = {
        insert: db.prepare(
          `INSERT INTO ${FTS_TABLE}(conv_id, conv_title, conv_archived, msg_at, msg_role, raw, body) ` +
            "VALUES(?, ?, ?, ?, ?, ?, ?)",
        ) as unknown as SqliteStatement,
        deleteConversation: db.prepare(
          `DELETE FROM ${FTS_TABLE} WHERE conv_id = ?`,
        ) as unknown as SqliteStatement,
        search: db.prepare(
          `SELECT conv_id, conv_title, conv_archived, msg_at, msg_role, raw ` +
            `FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ? ORDER BY rank LIMIT ?`,
        ) as unknown as SqliteStatement,
        trackUpsert: db.prepare(
          `INSERT INTO ${TRACK_TABLE}(conv_id, file, bytes) VALUES(?, ?, ?) ` +
            "ON CONFLICT(conv_id) DO UPDATE SET file=excluded.file, bytes=excluded.bytes",
        ) as unknown as SqliteStatement,
        trackDelete: db.prepare(
          `DELETE FROM ${TRACK_TABLE} WHERE conv_id = ?`,
        ) as unknown as SqliteStatement,
        tracked: db.prepare(
          `SELECT conv_id, file, bytes FROM ${TRACK_TABLE}`,
        ) as unknown as SqliteStatement,
      };
      this.logger?.debug("memory.conversation_archive.index.opened", {
        path: this.indexPath,
        recreated,
      });
      return true;
    } catch (error) {
      this.logger?.warn("memory.conversation_archive.index.open.failed", {
        path: this.indexPath,
        recreated,
        error: error instanceof Error ? error.message : String(error),
      });
      this.db = undefined;
      this.statements = undefined;
      return false;
    }
  }

  /**
   * Insère les messages D'UNE conversation dans l'index (transactionnel).
   * Remplace une éventuelle indexation antérieure (mise à jour du fichier).
   */
  private indexConversation(conversation: ArchivedConversation, file: string): void {
    if (!this.openIfNeeded()) return;
    try {
      this.db!.exec("BEGIN");
      try {
        this.statements!.deleteConversation.run(conversation.id);
        for (const message of conversation.messages) {
          if (message.text.length === 0) continue;
          this.statements!.insert.run(
            conversation.id,
            conversation.title,
            conversation.archivedAt,
            message.at,
            message.role,
            message.text,
            foldText(message.text),
          );
        }
        this.statements!.trackUpsert.run(
          conversation.id,
          basename(file),
          this.fileBytes(file),
        );
        this.db!.exec("COMMIT");
      } catch (error) {
        this.db!.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      this.logger?.warn("memory.conversation_archive.index.write.failed", {
        id: conversation.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Réconcilie l'index avec le dossier (idempotent) : entre ce qui manque, sort
   * ce qui n'existe plus. Coût = un `readdir` + la lecture des seuls fichiers
   * nouveaux ou modifiés (jamais une reconstruction complète au démarrage).
   */
  private reconcile(): void {
    if (!this.db || !this.statements) return;
    const files = this.archiveFiles();
    let known: Map<string, { file: string; bytes: number }>;
    try {
      known = new Map();
      for (const row of this.statements.tracked.all() as Array<Record<string, unknown>>) {
        if (typeof row.conv_id !== "string") continue;
        known.set(row.conv_id, {
          file: typeof row.file === "string" ? row.file : "",
          bytes: typeof row.bytes === "number" ? row.bytes : 0,
        });
      }
    } catch (error) {
      this.logger?.warn("memory.conversation_archive.track.read.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const onDisk = new Set<string>();
    for (const file of files) {
      const bytes = this.fileBytes(file);
      const conversation = this.readConversation(file);
      if (!conversation) continue;
      onDisk.add(conversation.id);
      const tracked = known.get(conversation.id);
      // Déjà indexée ET fichier inchangé (même taille) ⇒ rien à faire.
      if (tracked && tracked.bytes === bytes) continue;
      this.indexConversation(conversation, file);
    }
    for (const id of known.keys()) {
      if (onDisk.has(id)) continue;
      // Le fichier a disparu du disque (supprimé à la main) : l'index s'aligne.
      try {
        this.db.exec("BEGIN");
        this.statements.deleteConversation.run(id);
        this.statements.trackDelete.run(id);
        this.db.exec("COMMIT");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // ignore
        }
        this.logger?.warn("memory.conversation_archive.index.prune.failed", {
          id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
