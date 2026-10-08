/**
 * `HeritageAdminService` — ÉCRITURE de l'archive « vie antérieure » (interface).
 *
 * Cette classe est le SEUL point d'écriture de l'archive. Elle est branchée sur
 * l'API d'administration `/api/self/heritage` — **réservée à l'INTERFACE
 * utilisateur**, jamais exposée au modèle. L'outil de consultation
 * (`archive_vie_anterieure`) reste en **LECTURE SEULE** (décision du Lot 13) : il
 * ne voit que `HeritageStore`.
 *
 * Invariants :
 *  - L'archive reste SÉPARÉE de la mémoire courante : RIEN n'écrit jamais dans
 *    `memory.jsonl` (la règle cardinale « à ne jamais fusionner »).
 *  - L'ÉTIQUETTE (`HERITAGE_LABEL`) et la provenance sont RÉAPPLIQUÉES à chaque
 *    écriture (`serializeHeritageEntry`) : l'utilisateur ne peut pas les omettre.
 *  - Écriture ATOMIQUE (fichier temporaire puis `rename`).
 *  - Bornage de taille : un contenu trop long est TRONQUÉ et signalé (jamais en
 *    silence), aligné sur la borne de lecture.
 *  - Suppression = MISE DE CÔTÉ (`deleted/`), jamais destruction.
 *  - Journalisation : `heritage-journal.jsonl` (action, clé, taille, horodatage),
 *    JAMAIS le contenu, jamais de secret.
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
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";

import { collectSecretValues, redactObject } from "../observability/logger.js";

import { HERITAGE_ENTRY_EXTENSIONS, type HeritageStore } from "./heritage-store.js";
import {
  HERITAGE_DEFAULT_PERIODE,
  HERITAGE_DEFAULT_PROVENANCE,
  HERITAGE_DELETED_DIR,
  HERITAGE_JOURNAL_FILE,
  HERITAGE_LABEL,
  HERITAGE_MANIFEST_FILE,
  HERITAGE_README_FILE,
  HERITAGE_TITRE_MAX_CHARS,
  HERITAGE_WRITE_TEXT_MAX_CHARS,
  clampHeritageWriteText,
  heritageSlug,
  idFromFilename,
  normalizeHeritageCategorie,
  normalizeHeritageTitre,
  parseHeritageEntry,
  parseHeritageManifest,
  serializeHeritageEntry,
  type HeritageAdminDetail,
  type HeritageAdminEntry,
  type HeritageAdminInfo,
  type HeritageAdminPort,
  type HeritageDefaults,
  type HeritageDeleteResult,
  type HeritageEntry,
  type HeritageManifest,
  type HeritageWriteInput,
  type HeritageWriteResult,
} from "./heritage.js";
import type { MemoryLogger } from "./types.js";

/**
 * Écriture ATOMIQUE (fichier temporaire puis `rename`). Helper volontairement
 * DUPLIQUÉ, comme `src/personality/store.ts` : même convention locale, non
 * exportée.
 */
function writeAtomic(path: string, data: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

/** Erreur métier d'administration (mappée en HTTP 400 par la route). */
export class HeritageAdminError extends Error {
  override readonly name = "HeritageAdminError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Entrée telle que lue sur disque, avec sa clé et ses métadonnées de fichier. */
interface ScannedEntry {
  cle: string;
  absPath: string;
  name: string;
  id: string;
  entry: HeritageEntry;
  bytes: number;
  mtime: string;
}

interface Scan {
  manifest: HeritageManifest | null;
  defaults: HeritageDefaults;
  files: ScannedEntry[];
}

export interface HeritageAdminServiceOptions {
  logger?: MemoryLogger;
  now?: () => number;
  /** Valeurs secrètes à masquer dans le journal (défaut : `collectSecretValues()`). */
  secretValues?: string[];
  /** Borne d'écriture (défaut : `HERITAGE_WRITE_TEXT_MAX_CHARS`). */
  textMaxChars?: number;
}

/**
 * Administration de l'archive. Prend le `HeritageStore` DE LECTURE SEULE (source
 * du dossier et du manifeste) et écrit à côté, sans jamais toucher au store de
 * mémoire.
 */
export class HeritageAdminService implements HeritageAdminPort {
  private readonly store: HeritageStore;
  private readonly logger?: MemoryLogger;
  private readonly now: () => number;
  private readonly secretValues: string[];
  readonly textMaxChars: number;

  constructor(store: HeritageStore, options: HeritageAdminServiceOptions = {}) {
    this.store = store;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.secretValues = options.secretValues ?? collectSecretValues();
    this.textMaxChars = options.textMaxChars ?? HERITAGE_WRITE_TEXT_MAX_CHARS;
  }

  get dirPath(): string {
    return this.store.dirPath;
  }

  get deletedDirPath(): string {
    return join(this.store.dirPath, HERITAGE_DELETED_DIR);
  }

  get journalFilePath(): string {
    return join(this.store.dirPath, HERITAGE_JOURNAL_FILE);
  }

  info(): HeritageAdminInfo {
    const scan = this.scan();
    return {
      present: scan.manifest !== null || scan.files.length > 0,
      entries: scan.files.length,
      dir: this.dirPath,
      maxChars: this.textMaxChars,
      titreMaxChars: HERITAGE_TITRE_MAX_CHARS,
      manifest: scan.manifest,
    };
  }

  list(): HeritageAdminEntry[] {
    return this.scan().files.map((file) => this.summary(file));
  }

  read(cle: string): HeritageAdminDetail | undefined {
    const file = this.findByCle(cle);
    return file ? this.detail(file) : undefined;
  }

  create(input: HeritageWriteInput): HeritageWriteResult {
    const titre = normalizeHeritageTitre(input.titre);
    if (titre === undefined) {
      throw new HeritageAdminError("titre_required", "Un titre est requis pour créer une entrée.");
    }
    const categorie = normalizeHeritageCategorie(input.categorie);
    const clamped = clampHeritageWriteText(
      typeof input.texte === "string" ? input.texte : "",
      this.textMaxChars,
    );
    const { defaults } = this.scan();
    const entriesDir = this.store.entriesDirPath;
    mkdirSync(entriesDir, { recursive: true });

    const slug = heritageSlug(titre);
    let name = `${slug}.json`;
    let suffix = 2;
    while (existsSync(join(entriesDir, name))) {
      name = `${slug}-${suffix}.json`;
      suffix += 1;
    }
    const absPath = join(entriesDir, name);
    const id = idFromFilename(name);
    const at = new Date(this.now()).toISOString();
    const content = serializeHeritageEntry({
      id,
      titre,
      categorie,
      texte: clamped.text,
      provenance: defaults.provenance,
      periode: defaults.periode,
      importe_le: at,
    });
    writeAtomic(absPath, content, 0o600);
    const bytes = Buffer.byteLength(content, "utf8");
    this.journal({ action: "create", cle: relative(this.dirPath, absPath), id, titre, categorie, bytes, truncated: clamped.truncated });
    this.logger?.info("memory.heritage.written", { action: "create", id, bytes, truncated: clamped.truncated });
    return {
      changed: true,
      entry: {
        id,
        cle: relative(this.dirPath, absPath),
        titre,
        categorie,
        bytes,
        importe_le: at,
        texte: clamped.text,
        label: HERITAGE_LABEL,
        provenance: { ...defaults.provenance },
        periode: defaults.periode,
      },
      bytes,
      truncated: clamped.truncated,
    };
  }

  update(cle: string, input: HeritageWriteInput): HeritageWriteResult | undefined {
    const file = this.findByCle(cle);
    if (!file) return undefined;

    const titre = normalizeHeritageTitre(input.titre) ?? file.entry.titre;
    const categorie = normalizeHeritageCategorie(input.categorie ?? file.entry.categorie);
    const clamped = clampHeritageWriteText(
      typeof input.texte === "string" ? input.texte : file.entry.texte,
      this.textMaxChars,
    );
    const importeLe = file.entry.importe_le ?? new Date(this.now()).toISOString();
    const content = serializeHeritageEntry({
      id: file.id,
      titre,
      categorie,
      texte: clamped.text,
      provenance: file.entry.provenance,
      periode: file.entry.periode,
      importe_le: importeLe,
    });

    let before = "";
    try {
      before = readFileSync(file.absPath, "utf8");
    } catch {
      before = "";
    }
    if (before === content) {
      return { changed: false, entry: this.detail(file), bytes: file.bytes, truncated: false };
    }

    writeAtomic(file.absPath, content, 0o600);
    const bytes = Buffer.byteLength(content, "utf8");
    this.journal({ action: "update", cle: file.cle, id: file.id, titre, categorie, bytes, truncated: clamped.truncated });
    this.logger?.info("memory.heritage.written", { action: "update", id: file.id, bytes, truncated: clamped.truncated });
    return {
      changed: true,
      entry: {
        id: file.id,
        cle: file.cle,
        titre,
        categorie,
        bytes,
        importe_le: importeLe,
        texte: clamped.text,
        label: HERITAGE_LABEL,
        provenance: { ...file.entry.provenance },
        periode: file.entry.periode,
      },
      bytes,
      truncated: clamped.truncated,
    };
  }

  remove(cle: string): HeritageDeleteResult | undefined {
    const file = this.findByCle(cle);
    if (!file) return undefined;
    const at = this.now();
    const iso = new Date(at).toISOString().replace(/[:.]/g, "-");
    const ext = extname(file.name);
    const base = basename(file.name, ext);
    const dest = join(
      this.deletedDirPath,
      `${base}-${iso}-${randomBytes(3).toString("hex")}${ext}`,
    );
    try {
      mkdirSync(this.deletedDirPath, { recursive: true });
      renameSync(file.absPath, dest);
    } catch (error) {
      this.logger?.error("memory.heritage.delete.failed", {
        id: file.id,
        cle: file.cle,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.journal({
      action: "delete",
      cle: file.cle,
      id: file.id,
      titre: file.entry.titre,
      categorie: file.entry.categorie,
      bytes: file.bytes,
      truncated: false,
      movedTo: dest,
    });
    this.logger?.info("memory.heritage.deleted", { id: file.id, cle: file.cle, moved: dest });
    return { id: file.id, cle: file.cle, moved: true, deletedPath: dest, at: new Date(at).toISOString() };
  }

  /** Résout une entrée par sa clé (chemin relatif) ; `undefined` si inconnue. */
  private findByCle(cle: string): ScannedEntry | undefined {
    if (typeof cle !== "string" || cle.length === 0) return undefined;
    return this.scan().files.find((file) => file.cle === cle);
  }

  private summary(file: ScannedEntry): HeritageAdminEntry {
    return {
      id: file.id,
      cle: file.cle,
      titre: file.entry.titre,
      categorie: file.entry.categorie,
      bytes: file.bytes,
      importe_le: file.entry.importe_le ?? file.mtime,
    };
  }

  private detail(file: ScannedEntry): HeritageAdminDetail {
    return {
      ...this.summary(file),
      texte: file.entry.texte,
      label: file.entry.label,
      provenance: file.entry.provenance,
      periode: file.entry.periode,
    };
  }

  /**
   * Relit l'archive FRAÎCHEMENT (l'utilisateur corrige aussi à la main). Reproduit
   * la collecte de `HeritageStore.readAll` (mêmes fichiers, même ordre de tri et
   * même dédoublonnage d'identifiant), mais conserve en plus la clé (chemin
   * relatif) et les métadonnées de fichier nécessaires à l'administration.
   */
  private scan(): Scan {
    const dir = this.dirPath;
    const entriesDir = this.store.entriesDirPath;

    let manifest: HeritageManifest | null = null;
    const manifestPath = join(dir, HERITAGE_MANIFEST_FILE);
    if (existsSync(manifestPath)) {
      try {
        manifest = parseHeritageManifest(readFileSync(manifestPath, "utf8"));
      } catch {
        manifest = null;
      }
    }
    const defaults: HeritageDefaults = {
      provenance: manifest?.provenance ?? { ...HERITAGE_DEFAULT_PROVENANCE },
      periode: manifest?.periode ?? HERITAGE_DEFAULT_PERIODE,
    };

    const candidates: Array<{ abs: string; base: string; name: string }> = [];
    for (const base of [dir, entriesDir]) {
      if (!existsSync(base)) continue;
      let names: string[];
      try {
        names = readdirSync(base);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith(".")) continue;
        if (
          base === dir &&
          (name === HERITAGE_MANIFEST_FILE ||
            name === HERITAGE_README_FILE ||
            name === HERITAGE_JOURNAL_FILE)
        ) {
          continue;
        }
        if (!HERITAGE_ENTRY_EXTENSIONS.has(extname(name).toLowerCase())) continue;
        candidates.push({ abs: join(base, name), base, name });
      }
    }
    candidates.sort((a, b) => (a.abs < b.abs ? -1 : a.abs > b.abs ? 1 : 0));

    const files: ScannedEntry[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      let content: string;
      let mtime: string;
      try {
        content = readFileSync(candidate.abs, "utf8");
        mtime = statSync(candidate.abs).mtime.toISOString();
      } catch {
        continue;
      }
      const parsed = parseHeritageEntry(content, candidate.name, defaults);
      let id = parsed.id;
      let suffix = 2;
      while (seen.has(id)) id = `${parsed.id}-${suffix++}`;
      seen.add(id);
      files.push({
        cle: relative(dir, candidate.abs),
        absPath: candidate.abs,
        name: candidate.name,
        id,
        entry: parsed,
        bytes: Buffer.byteLength(content, "utf8"),
        mtime,
      });
    }
    return { manifest, defaults, files };
  }

  /**
   * Ajoute UNE ligne au journal des modifications (métadonnées SEULES). Le
   * contenu n'y apparaît JAMAIS ; les valeurs secrètes de l'environnement sont
   * masquées (`redactObject`). Une écriture de journal qui échoue n'invalide pas
   * l'écriture principale (déjà persistée atomiquement).
   */
  private journal(record: {
    action: "create" | "update" | "delete";
    cle: string;
    id: string;
    titre: string;
    categorie: string;
    bytes: number;
    truncated: boolean;
    movedTo?: string;
  }): void {
    const redacted = redactObject(record, this.secretValues);
    const line = JSON.stringify({
      v: 1,
      at: new Date(this.now()).toISOString(),
      ...redacted,
    });
    try {
      mkdirSync(this.dirPath, { recursive: true });
      appendFileSync(this.journalFilePath, `${line}\n`, "utf8");
    } catch (error) {
      this.logger?.warn("memory.heritage.journal.failed", {
        path: this.journalFilePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
