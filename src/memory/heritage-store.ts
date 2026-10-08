/**
 * `HeritageStore` — lecture de l'archive « vie antérieure » (Lot 13).
 *
 * L'archive vit dans un dossier DÉDIÉ, **voisin** du store de mémoire
 * (`memory.jsonl`), sur le volume `state`. Elle est lue À LA DEMANDE, jamais
 * absorbée par l'extraction automatique (qui ne lit que les conversations).
 *
 * Invariants :
 *  - LECTURE SEULE : l'application ne modifie JAMAIS l'archive (l'utilisateur la
 *    corrige à la main). Seule la mise en place initiale (`ensureLayout`) écrit
 *    la notice et le manifeste **s'ils n'existent pas**.
 *  - TOLÉRANCE : dossier absent, fichier corrompu, manifeste illisible ⇒
 *    comportement honnête (aucune exception, l'entrée fautive est signalée).
 *  - Les erreurs de lecture sont CONSERVÉES (`errors()`) pour un diagnostic
 *    honnête côté outil, jamais avalées.
 *  - Le cache d'existence (`info()`) évite toute I/O sur le chemin critique du
 *    rappel ; `list()`/`read()` relisent frais (l'utilisateur édite à la main).
 *
 * Aucun import SDK/typebox.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";

import {
  HERITAGE_DEFAULT_PERIODE,
  HERITAGE_DEFAULT_PROVENANCE,
  HERITAGE_ENTRIES_DIR,
  HERITAGE_MANIFEST_FILE,
  HERITAGE_README_FILE,
  buildHeritageReadme,
  defaultManifest,
  parseHeritageEntry,
  parseHeritageManifest,
  type HeritageDefaults,
  type HeritageEntry,
  type HeritageInfo,
  type HeritageManifest,
  type HeritagePort,
} from "./heritage.js";
import { foldText } from "./normalize.js";
import type { MemoryLogger } from "./types.js";

/** Extensions de fichiers lues comme entrées d'archive. */
const ENTRY_EXTENSIONS = new Set([".json", ".md", ".markdown", ".txt"]);

export interface HeritageStoreOptions {
  /** Chemin du dossier d'archive (ex. `/data/state/memory-heritage`). */
  dir: string;
  logger?: MemoryLogger;
}

/**
 * Lecture seule de l'archive. Implémente `HeritagePort` (outil de consultation)
 * et expose `ensureLayout`/`refresh` pour le câblage.
 */
export class HeritageStore implements HeritagePort {
  private readonly dir: string;
  private readonly logger?: MemoryLogger;
  private entriesCache: HeritageEntry[] | null = null;
  private manifestCache: HeritageManifest | null = null;
  private errorsCache: string[] = [];

  constructor(options: HeritageStoreOptions) {
    this.dir = options.dir;
    this.logger = options.logger;
  }

  get dirPath(): string {
    return this.dir;
  }

  get entriesDirPath(): string {
    return join(this.dir, HERITAGE_ENTRIES_DIR);
  }

  /**
   * Met en place la structure initiale SANS écraser l'existant : crée le
   * dossier et ses sous-dossiers, écrit la notice et le manifeste **s'ils
   * manquent**. Une erreur d'écriture est journalisée et n'empêche pas la
   * lecture. Puis rafraîchit le cache d'existence.
   */
  ensureLayout(): void {
    try {
      mkdirSync(this.entriesDirPath, { recursive: true });
      const readmePath = join(this.dir, HERITAGE_README_FILE);
      if (!existsSync(readmePath)) {
        writeFileSync(readmePath, `${buildHeritageReadme()}\n`, "utf8");
      }
      const manifestPath = join(this.dir, HERITAGE_MANIFEST_FILE);
      if (!existsSync(manifestPath)) {
        writeFileSync(
          manifestPath,
          `${JSON.stringify(defaultManifest(), null, 2)}\n`,
          "utf8",
        );
      }
    } catch (error) {
      this.logger?.warn("memory.heritage.layout.failed", {
        dir: this.dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.refresh();
  }

  /** Relit l'archive et renvoie sa synthèse (utilisé par le câblage). */
  refresh(): HeritageInfo {
    this.readAll();
    return this.info();
  }

  /** Existence + nombre d'entrées (cache, sans I/O si déjà lu). */
  info(): HeritageInfo {
    if (this.entriesCache === null) this.readAll();
    const entries = this.entriesCache ?? [];
    return {
      present: entries.length > 0 || this.manifestCache !== null,
      entries: entries.length,
      manifest: this.manifestCache,
    };
  }

  /** `true` si l'archive contient au moins une entrée (cache). */
  hasArchive(): boolean {
    if (this.entriesCache === null) this.readAll();
    return (this.entriesCache?.length ?? 0) > 0;
  }

  /** Entrées lisibles, relues fraîches (l'utilisateur corrige à la main). */
  list(): HeritageEntry[] {
    this.readAll();
    return [...(this.entriesCache ?? [])];
  }

  /** Résout une entrée par identifiant OU titre (insensible casse/accents). */
  read(identifier: string): HeritageEntry | undefined {
    const needle = foldText(identifier);
    if (needle.length === 0) return undefined;
    return this.list().find(
      (entry) =>
        entry.id === identifier ||
        foldText(entry.id) === needle ||
        foldText(entry.titre) === needle,
    );
  }

  /** Erreurs de lecture rencontrées lors du dernier `readAll` (diagnostic). */
  errors(): readonly string[] {
    return this.errorsCache;
  }

  /** Relit l'intégralité de l'archive, en accumulant les erreurs sans lever. */
  private readAll(): void {
    const entries: HeritageEntry[] = [];
    const errors: string[] = [];
    let manifest: HeritageManifest | null = null;

    const manifestPath = join(this.dir, HERITAGE_MANIFEST_FILE);
    if (existsSync(manifestPath)) {
      try {
        manifest = parseHeritageManifest(readFileSync(manifestPath, "utf8"));
        if (manifest === null) {
          errors.push(`${HERITAGE_MANIFEST_FILE} : JSON illisible (ignoré).`);
        }
      } catch (error) {
        errors.push(
          `${HERITAGE_MANIFEST_FILE} illisible : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const defaults: HeritageDefaults = {
      provenance: manifest?.provenance ?? { ...HERITAGE_DEFAULT_PROVENANCE },
      periode: manifest?.periode ?? HERITAGE_DEFAULT_PERIODE,
    };

    const files: string[] = [];
    for (const directory of [this.dir, this.entriesDirPath]) {
      if (!existsSync(directory)) continue;
      let names: string[];
      try {
        names = readdirSync(directory);
      } catch (error) {
        errors.push(
          `dossier illisible (${directory}) : ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      for (const name of names) {
        if (name.startsWith(".")) continue;
        if (directory === this.dir && (name === HERITAGE_MANIFEST_FILE || name === HERITAGE_README_FILE)) {
          continue;
        }
        if (!ENTRY_EXTENSIONS.has(extname(name).toLowerCase())) continue;
        files.push(join(directory, name));
      }
    }
    files.sort();

    const seen = new Set<string>();
    for (const file of files) {
      try {
        const content = readFileSync(file, "utf8");
        const parsed = parseHeritageEntry(content, basename(file), defaults);
        let id = parsed.id;
        let suffix = 2;
        while (seen.has(id)) id = `${parsed.id}-${suffix++}`;
        seen.add(id);
        entries.push({ ...parsed, id });
      } catch (error) {
        errors.push(
          `${basename(file)} illisible : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.entriesCache = entries;
    this.manifestCache = manifest;
    this.errorsCache = errors;
    if (errors.length > 0) {
      this.logger?.warn("memory.heritage.read.errors", {
        dir: this.dir,
        errors: errors.length,
      });
    }
  }
}
