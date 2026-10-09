/**
 * `SessionPinStore` — épinglage des conversations de la barre latérale.
 *
 * ⚠️ Les sessions appartiennent au SDK Pi (JSONL, `id` = nom de fichier). On
 * N'ÉCRIT JAMAIS de champ maison dans le JSONL d'une session : le SDK en est
 * propriétaire et un champ inconnu risquerait de casser sa lecture.
 *
 * Cet état vit donc À PART, dans le volume `state` (à côté des autres stores),
 * sous la forme d'un petit fichier JSON réécrit ATOMIQUEMENT (`tmp` + `rename`)
 * qui associe `sessionId → épinglé`. Un simple ensemble suffit : l'absence vaut
 * « non épinglé ».
 *
 * Nettoyage : quand une conversation est mise de côté, l'appelant retire son
 * entrée (`remove`). `prune` retire les épingles orphelines en une passe.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface SessionPinLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface SessionPinStoreOptions {
  /** Chemin du fichier JSON (volume `state`). */
  path: string;
  logger?: SessionPinLogger;
}

/** Contenu persisté du fichier d'épingles. */
interface PinFile {
  schemaVersion: number;
  /** Identifiants de sessions épinglées (l'ordre n'importe pas). */
  pinned: string[];
}

const SCHEMA_VERSION = 1;

/** Écrit un fichier JSON de façon atomique (`tmp` + `rename`). */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  renameSync(tmp, path);
}

/**
 * Store d'épinglage des conversations.
 *
 * Toutes les mutations renvoient `true` si l'état a CHANGÉ (et donc a été
 * persisté), `false` sinon — l'appelant peut éviter une écriture inutile.
 */
export class SessionPinStore {
  private readonly path: string;
  private readonly logger?: SessionPinLogger;
  private readonly pinned = new Set<string>();

  private constructor(options: SessionPinStoreOptions) {
    this.path = options.path;
    this.logger = options.logger;
  }

  /** Ouvre (ou crée) le fichier d'épingles et charge l'état en mémoire. */
  static open(options: SessionPinStoreOptions): SessionPinStore {
    const store = new SessionPinStore(options);
    store.load();
    return store;
  }

  get filePath(): string {
    return this.path;
  }

  /** Nombre de conversations épinglées. */
  get size(): number {
    return this.pinned.size;
  }

  isPinned(sessionId: string): boolean {
    return typeof sessionId === "string" && this.pinned.has(sessionId);
  }

  /** Identifiants épinglés (copie, ordre d'insertion). */
  list(): string[] {
    return [...this.pinned];
  }

  /** Épingle / désépingle une session. Renvoie `true` si l'état a changé. */
  setPinned(sessionId: string, value: boolean): boolean {
    if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
      return false;
    }
    const desired = Boolean(value);
    if (desired === this.pinned.has(sessionId)) return false;
    if (desired) this.pinned.add(sessionId);
    else this.pinned.delete(sessionId);
    this.persist();
    return true;
  }

  /** Retire une épingle (nettoyage après mise de côté / suppression). */
  remove(sessionId: string): boolean {
    return this.setPinned(sessionId, false);
  }

  /**
   * Retire toutes les épingles dont l'identifiant N'EST PAS dans `validIds`.
   * Renvoie la liste des identifiants retirés. N'écrit que si nécessaire.
   */
  prune(validIds: Iterable<string>): string[] {
    const valid = validIds instanceof Set ? validIds : new Set(validIds);
    const removed: string[] = [];
    for (const id of this.pinned) {
      if (!valid.has(id)) removed.push(id);
    }
    if (removed.length > 0) {
      for (const id of removed) this.pinned.delete(id);
      this.persist();
    }
    return removed;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch (error) {
      this.logger?.warn("session_pins.read_failed", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      this.logger?.warn("session_pins.invalid_json", { path: this.path });
      return;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      this.logger?.warn("session_pins.invalid_shape", { path: this.path });
      return;
    }
    const pinned = (parsed as PinFile).pinned;
    if (!Array.isArray(pinned)) return;
    for (const id of pinned) {
      if (typeof id === "string" && id.trim().length > 0) this.pinned.add(id);
    }
  }

  private persist(): void {
    const value: PinFile = {
      schemaVersion: SCHEMA_VERSION,
      pinned: [...this.pinned],
    };
    try {
      writeJsonAtomic(this.path, value);
    } catch (error) {
      // Écriture impossible : on retient l'erreur côté logs. L'état en mémoire
      // reste cohérent pour la session en cours (l'utilisateur voit sa liste) ;
      // la persistance reprendra à la prochaine mutation réussie.
      this.logger?.warn("session_pins.write_failed", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
