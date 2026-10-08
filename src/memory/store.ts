/**
 * `MemoryStore` — journal append-only JSONL + projection en mémoire (Lot 12).
 *
 * PROMESSE UTILISATEUR : le fichier de mémoire est LISIBLE et CORRIGEABLE À LA
 * MAIN. Il est donc en JSONL (une ligne = un événement), avec un en-tête
 * commenté décrivant le format.
 *
 * Invariants (cf. règles de conception) :
 *  - ÉDITIONS ÉTROITES uniquement : chaque ajout / mise à jour / suppression
 *    n'ajoute QU'UNE ligne au fichier (`appendFileSync`). **Aucune réécriture
 *    globale** n'est jamais faite (le piège documenté : écraser 1000 lignes de
 *    mémoire par un placeholder).
 *  - Rejeu TOLÉRANT : une ligne illisible est ignorée + avertie ; le store n'est
 *    jamais bloqué par une corruption partielle.
 *  - IDEMPOTENCE de l'écriture : deux `add` du même contenu (à la casse/accents
 *    près) fusionnent — rejouer une extraction ne duplique pas.
 *  - Chaque entrée CONSERVE sa source (message d'origine) et sa date.
 *
 * Aucun import SDK/typebox.
 */

import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { fingerprint } from "./normalize.js";
import {
  MEMORY_CATEGORIES,
  type MemoryCategory,
  type MemoryChange,
  type MemoryEntry,
  type MemoryEvent,
  type MemoryLogger,
  type MemoryResetResult,
} from "./types.js";

/** Longueur maximale d'un souvenir (garde-fou anti-emballement). */
export const MEMORY_TEXT_MAX_CHARS = 600;

/**
 * En-tête commenté écrit UNE SEULE FOIS à la création du fichier. Il documente
 * le format pour un utilisateur qui ouvre le fichier à la main.
 */
export const MEMORY_FILE_HEADER = [
  "# Yuki — mémoire durable (Lot 12).",
  "# Une ligne = un événement JSON. Fichier LISIBLE et corrigeable à la main.",
  "# Le contenu courant est la PROJECTION de toutes les lignes, dans l'ordre.",
  '# Actions : "add" (créer), "update" (modifier), "delete" (supprimer).',
  '#   {"v":1,"t":"add","id":"mem-…","at":"<ISO>","text":"…","source":"…","cat":"preference"}',
  '#   {"v":1,"t":"update","id":"mem-…","at":"<ISO>","text":"…","source":"…","cat":"fait"}',
  '#   {"v":1,"t":"delete","id":"mem-…","at":"<ISO>"}',
  "# Pour retirer un souvenir : ajoutez une ligne \"delete\" (ou supprimez sa ligne d'ajout).",
  "# N'écrivez jamais de ligne vide ou d'instruction exécutable : c'est une DONNÉE.",
].join("\n");

/** Nom du dossier d'archivage (voisin du fichier de mémoire, volume `state`). */
export const MEMORY_ARCHIVE_DIR_NAME = "memory-archive";

export interface MemoryStoreOptions {
  path: string;
  logger?: MemoryLogger;
  now?: () => number;
  /** Fabrique d'identifiants (injectable pour des tests déterministes). */
  idFactory?: () => string;
  /**
   * Dossier où déposer les archives (défaut : `<dir(path)>/memory-archive`).
   * ⚠️ Distinct de l'archive « vie antérieure » (`memory-heritage`).
   */
  archiveDir?: string;
}

export interface MemoryDraft {
  text: string;
  source: string;
  cat?: string;
}

export interface AddResult {
  entry: MemoryEntry;
  /** `false` si l'entrée existait déjà (déduplication idempotente). */
  created: boolean;
}

export interface MemoryUpdatePatch {
  text?: string;
  cat?: string;
  source?: string;
}

let fallbackCounter = 0;

function defaultIdFactory(): string {
  fallbackCounter += 1;
  return `mem-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

/** Horodatage compact et portable pour nommer une archive (`:`/`.` remplacés). */
function isoCompact(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

/** Ramène une catégorie arbitraire à une catégorie reconnue. */
export function normalizeCategory(value: unknown): MemoryCategory {
  if (typeof value === "string" && (MEMORY_CATEGORIES as readonly string[]).includes(value)) {
    return value as MemoryCategory;
  }
  return "autre";
}

/** Tronque un texte de souvenir à la borne dure. */
export function clampMemoryText(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > MEMORY_TEXT_MAX_CHARS
    ? trimmed.slice(0, MEMORY_TEXT_MAX_CHARS)
    : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rejoue un événement sur la projection. Renvoie `true` si appliqué.
 * Lors d'un rejeu, un événement incohérent est ignoré (averti) sans lever.
 */
function applyEvent(
  state: {
    byId: Map<string, MemoryEntry>;
    fingerprints: Map<string, string>;
  },
  event: MemoryEvent,
  options: { replay?: boolean; logger?: MemoryLogger } = {},
): boolean {
  const { replay = false, logger } = options;
  if (event.t === "add") {
    if (state.byId.has(event.id)) return false;
    const entry: MemoryEntry = {
      id: event.id,
      at: event.at,
      text: event.text,
      source: event.source,
      cat: event.cat,
    };
    state.byId.set(entry.id, entry);
    state.fingerprints.set(fingerprint(entry.text), entry.id);
    return true;
  }
  if (event.t === "update") {
    const current = state.byId.get(event.id);
    if (!current) {
      if (!replay) logger?.warn("memory.store.update.unknown", { id: event.id });
      return false;
    }
    state.fingerprints.delete(fingerprint(current.text));
    const next: MemoryEntry = {
      ...current,
      text: event.text,
      source: event.source,
      cat: event.cat,
      updatedAt: event.at,
    };
    state.byId.set(next.id, next);
    state.fingerprints.set(fingerprint(next.text), next.id);
    return true;
  }
  // delete
  const current = state.byId.get(event.id);
  if (!current) {
    if (!replay) logger?.warn("memory.store.delete.unknown", { id: event.id });
    return false;
  }
  state.byId.delete(event.id);
  state.fingerprints.delete(fingerprint(current.text));
  return true;
}

export class MemoryStore {
  private readonly path: string;
  private readonly logger?: MemoryLogger;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly archiveDirPath: string;
  private readonly byId = new Map<string, MemoryEntry>();
  private readonly fingerprints = new Map<string, string>();
  private readonly listeners = new Set<(change: MemoryChange) => void>();

  private constructor(options: MemoryStoreOptions) {
    this.path = options.path;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.archiveDirPath =
      options.archiveDir ?? join(dirname(options.path), MEMORY_ARCHIVE_DIR_NAME);
  }

  /** Ouvre (ou crée) le journal et reconstruit la projection en le rejouant. */
  static open(options: MemoryStoreOptions): MemoryStore {
    const store = new MemoryStore(options);
    store.ensureFile();
    store.replayFromDisk();
    return store;
  }

  /** Construit un store purement EN MÉMOIRE à partir d'événements (tests). */
  static fromEvents(
    events: readonly MemoryEvent[],
    options: { path?: string; logger?: MemoryLogger; now?: () => number; idFactory?: () => string } = {},
  ): MemoryStore {
    const store = new MemoryStore({
      path: options.path ?? ":memory:",
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.idFactory ? { idFactory: options.idFactory } : {}),
    });
    for (const event of events) {
      applyEvent(
        { byId: store.byId, fingerprints: store.fingerprints },
        event,
        { replay: true },
      );
    }
    return store;
  }

  get filePath(): string {
    return this.path;
  }

  /** Dossier où seront déposées les archives (jamais l'archive « vie antérieure »). */
  get archiveDir(): string {
    return this.archiveDirPath;
  }

  get entries(): readonly MemoryEntry[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: string): MemoryEntry | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  subscribe(listener: (change: MemoryChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(change: MemoryChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        this.logger?.warn("memory.store.listener.error", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Crée le fichier avec son en-tête s'il n'existe pas (une seule fois).
   * Une erreur d'écriture n'empêche pas l'ouverture (mode lecture seule) : elle
   * est journalisée et resurgira à la première écriture.
   */
  private ensureFile(): void {
    if (this.path === ":memory:" || existsSync(this.path)) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, `${MEMORY_FILE_HEADER}\n`, { mode: 0o600 });
    } catch (error) {
      this.logger?.warn("memory.store.header.failed", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private replayFromDisk(): void {
    if (this.path === ":memory:" || !existsSync(this.path)) return;
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch (error) {
      this.logger?.warn("memory.store.read.failed", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.logger?.warn("memory.store.line.invalid", { path: this.path });
        continue;
      }
      const event = parseEvent(parsed);
      if (!event) {
        this.logger?.warn("memory.store.line.unsupported", { path: this.path });
        continue;
      }
      applyEvent({ byId: this.byId, fingerprints: this.fingerprints }, event, {
        replay: true,
        ...(this.logger ? { logger: this.logger } : {}),
      });
    }
  }

  /** Persiste UNE ligne (jamais de réécriture). Peut lever en cas d'échec disque. */
  private persist(event: MemoryEvent): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf8");
    } catch (error) {
      this.logger?.error("memory.store.write.failed", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Ajoute un souvenir. Idempotent : si un souvenir identique (au repli
   * casse/accents/espaces près) existe déjà, aucune ligne n'est écrite.
   */
  add(draft: MemoryDraft): AddResult {
    const text = clampMemoryText(draft.text);
    const existingId = this.fingerprints.get(fingerprint(text));
    const existing = existingId ? this.byId.get(existingId) : undefined;
    if (existing) {
      return { entry: existing, created: false };
    }
    const cat = normalizeCategory(draft.cat);
    const entry: MemoryEntry = {
      id: this.idFactory(),
      at: new Date(this.now()).toISOString(),
      text,
      source: draft.source.length > 0 ? draft.source : "unknown",
      cat,
    };
    const event: MemoryEvent = {
      v: 1,
      t: "add",
      id: entry.id,
      at: entry.at,
      text: entry.text,
      source: entry.source,
      cat: entry.cat,
    };
    this.persist(event);
    applyEvent({ byId: this.byId, fingerprints: this.fingerprints }, event, {});
    this.emit({ type: "added", entry });
    return { entry, created: true };
  }

  /** Met à jour une entrée (une seule ligne). Renvoie `false` si inconnue/no-op. */
  update(id: string, patch: MemoryUpdatePatch): boolean {
    const current = this.byId.get(id);
    if (!current) {
      this.logger?.warn("memory.store.update.unknown", { id });
      return false;
    }
    const text = patch.text !== undefined ? clampMemoryText(patch.text) : current.text;
    const cat = patch.cat !== undefined ? normalizeCategory(patch.cat) : current.cat;
    const source = patch.source !== undefined ? patch.source : current.source;
    if (text === current.text && cat === current.cat && source === current.source) {
      return false;
    }
    const at = new Date(this.now()).toISOString();
    const event: MemoryEvent = { v: 1, t: "update", id, at, text, source, cat };
    this.persist(event);
    applyEvent({ byId: this.byId, fingerprints: this.fingerprints }, event, {});
    this.emit({ type: "updated", entry: this.byId.get(id) as MemoryEntry });
    return true;
  }

  /** Supprime une entrée (une seule ligne `delete`). `false` si inconnue. */
  remove(id: string): boolean {
    if (!this.byId.has(id)) {
      return false;
    }
    const at = new Date(this.now()).toISOString();
    const event: MemoryEvent = { v: 1, t: "delete", id, at };
    this.persist(event);
    applyEvent({ byId: this.byId, fingerprints: this.fingerprints }, event, {});
    this.emit({ type: "removed", id });
    return true;
  }

  /**
   * ⚠️ Réinitialisation = ARCHIVAGE RÉCUPÉRABLE (jamais une destruction).
   *
   * Le journal de mémoire est RENOMMÉ (nom horodaté) dans un dossier d'archive
   * DÉDIÉ, puis un fichier propre (avec son en-tête) est recréé. La projection en
   * mémoire est vidée et un changement `reset` est diffusé (l'index DÉRIVÉ repart
   * vide).
   *
   * Mémoire DÉJÀ VIDE ⇒ aucune archive vide n'est créée, `archived:false` est
   * renvoyé (message honnête côté UI). Une erreur de renommage ne détruit RIEN :
   * elle remonte à l'appelant et laisse le fichier d'origine intact.
   */
  archiveAndReset(options: { archiveDir?: string } = {}): MemoryResetResult {
    const nowMs = this.now();
    const at = new Date(nowMs).toISOString();
    const entries = this.byId.size;
    if (entries === 0 || this.path === ":memory:") {
      // Rien à archiver : on ne crée PAS de fichier vide inutilement.
      this.ensureFile();
      return { archived: false, entries: 0, archivePath: null, bytes: 0, at };
    }

    let bytes = 0;
    try {
      bytes = statSync(this.path).size;
    } catch {
      // Fichier disparu du disque : on archive ce qu'on peut (projection vide).
      bytes = 0;
    }

    const archiveDir = options.archiveDir ?? this.archiveDirPath;
    const name = `memory-${isoCompact(nowMs)}-${randomBytes(3).toString("hex")}.jsonl`;
    const archivePath = join(archiveDir, name);
    try {
      mkdirSync(archiveDir, { recursive: true });
      renameSync(this.path, archivePath);
    } catch (error) {
      // Le renommage a échoué : RIEN n'est perdu (le fichier reste en place).
      this.logger?.error("memory.store.archive.failed", {
        path: this.path,
        archive: archivePath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    // Purge de la projection : plus aucun souvenir servi depuis la RAM.
    this.byId.clear();
    this.fingerprints.clear();

    // Nouveau fichier propre et auto-documenté (en-tête recréé).
    try {
      writeFileSync(this.path, `${MEMORY_FILE_HEADER}\n`, { mode: 0o600 });
    } catch (error) {
      this.logger?.warn("memory.store.reset.header.failed", {
        path: this.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.emit({ type: "reset" });
    this.logger?.info("memory.store.archived", {
      at,
      entries,
      bytes,
      archive: archivePath,
      dir: archiveDir,
    });
    return { archived: true, entries, archivePath, bytes, at };
  }
}

/** Valide et normalise une ligne d'événement lue sur disque. */
export function parseEvent(value: unknown): MemoryEvent | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const t = value.t;
  if (t === "add" || t === "update") {
    if (
      typeof value.id !== "string" ||
      typeof value.at !== "string" ||
      typeof value.text !== "string" ||
      typeof value.source !== "string"
    ) {
      return null;
    }
    return {
      v: 1,
      t,
      id: value.id,
      at: value.at,
      text: clampMemoryText(value.text),
      source: value.source,
      cat: normalizeCategory(value.cat),
    };
  }
  if (t === "delete") {
    if (typeof value.id !== "string" || typeof value.at !== "string") return null;
    return { v: 1, t: "delete", id: value.id, at: value.at };
  }
  return null;
}
