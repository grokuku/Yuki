/**
 * Configuration STRUCTURÉE du moteur TTS `audio.cpp` (Lot 9, étape 1).
 *
 * Le moteur lit un fichier `server.json` **au démarrage** (`server --config
 * /config/server.json`). Yuki l'expose dans l'interface sous forme d'un
 * **patch structuré** — JAMAIS de JSON brut envoyé par le navigateur :
 *
 *   - le serveur relit le fichier, **préserve les clés inconnues** (l'opérateur
 *     a pu ajouter `max_loaded_models`, `idle_unload_ms`, `min_free_memory_mb`,
 *     `load_options`, …), fusionne, **valide**, écrit `server.json.bak` puis
 *     `server.json` en **atomique** (`tmp` + `rename`, même patron que
 *     `src/tts/voices-store.ts`).
 *
 * Listes FERMÉES pour empêcher les erreurs connues (l'opérateur a perdu du
 * temps avec `clone` et des modes invalides) :
 *   - `task` : jetons **canoniques** de `task_vocabulary.cpp` — ⚠️ `clon`,
 *     **jamais** `clone` (preuve : `docs/lot8.md` §11.11) ;
 *   - `mode` : `offline` | `streaming` ; `chatterbox` et `cosyvoice3` sont
 *     **`offline` obligatoire** (preuve : loader `audio.cpp`) ;
 *   - `family` : liste fermée issue du catalogue GGUF amont ;
 *   - `id` : les 5 valeurs de `tts.engine` (`src/config/schema.ts`) ; un id
 *     hors liste est **accepté mais signalé** (le moteur le chargera, Yuki ne
 *     saura pas le sélectionner) ;
 *   - `path` : choisi dans la liste des modèles présents sur le disque, jamais
 *     saisi librement.
 *
 * Correspondance des chemins (⚠️ honnêteté) : le gateway voit le dossier hôte
 * des modèles sous `/models`, monté `rw` (lecture + écriture des futurs
 * téléchargements) ; le moteur ne le voit que sous `/models`, monté `ro`. Un
 * `models[].path` stocké est TOUJOURS le chemin **vu par le moteur** ; la
 * conversion dans les deux sens est explicite, et un chemin hors de ces
 * montages est « non vérifiable » (jamais prétendu existant).
 *
 * ⚠️ Les téléchargements sont rangés par CONVENTION dans le sous-dossier
 * `downloads/` (voir `MODELS_DOWNLOADS_SUBDIR`). Ce n'est PAS une barrière :
 * comme le montage `/models` est `rw`, le gateway peut écrire partout sous
 * `/models` — choix assumé (voir `docs/lot9.md`, D60).
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import { MODELS_DOWNLOADS_SUBDIR } from "../config/container-paths.js";
import { describeWriteFailure, probeWritable } from "../config/paths.js";
import {
  CATALOG_ENTRIES,
  downloadEngineDir,
  downloadEnginePath,
} from "./catalog-data.js";

/** Nom du fichier de configuration du moteur dans le dossier monté. */
export const ENGINE_CONFIG_FILENAME = "server.json";
/**
 * Sous-dossier (`/models/downloads`) où le gateway range les téléchargements.
 * CONVENTION d'organisation DÉRIVÉE du montage `/models` (jamais configurable) :
 * elle ne restreint pas l'écriture, le montage `/models` étant lui-même `rw`
 * côté gateway. Source unique : `src/config/container-paths.ts`.
 */
export { MODELS_DOWNLOADS_SUBDIR };
/** Profondeur maximale d'exploration des modèles sur le disque. */
export const DISK_SCAN_MAX_DEPTH = 4;
/** Nombre maximal de fichiers `.gguf` listés. */
export const DISK_SCAN_MAX_FILES = 200;

/**
 * Jetons canoniques de `task` (source : `task_vocabulary.cpp` amont).
 * ⚠️ `clon` (pas `clone`) : `parse_voice_task_kind` n'accepte que ce jeton.
 */
export const ENGINE_TASK_TOKENS = [
  "vad",
  "asr",
  "diar",
  "sep",
  "gen",
  "tts",
  "clon",
  "vc",
  "s2s",
  "align",
  "vdes",
  "spk",
  "svc",
  "midi",
] as const;

/** Modes d'exécution d'un modèle. */
export const ENGINE_MODES = ["offline", "streaming"] as const;

/**
 * Familles du catalogue GGUF amont (liste fermée). ⚠️ Ce sont les noms
 * reconnus par le MOTEUR (`ModelRegistry::supports_family`, `family()` des
 * loaders), PAS les ids de `tts.engine` : `qwen3_tts` (underscore) et
 * `kokoro_tts` diffèrent de `qwen3-tts`/`kokoro`. Preuves : `model_specs/*.json`
 * (`family`), `README.md` du dépôt HF (tableau « audio.cpp family »),
 * `app/server/runtime.cpp:2116` (`family != "kokoro_tts"`), et l'exemple amont
 * `examples/docker/server/qwen3-tts-server.json` (`id: qwen3-tts`,
 * `family: qwen3_tts`). Voir `docs/lot9.md` D62/D64/D66.
 */
export const ENGINE_FAMILIES = [
  "chatterbox",
  "qwen3_tts",
  "cosyvoice3",
  "kokoro_tts",
  "sanotts",
] as const;

/**
 * Ids connus de Yuki (`tts.engine`, `src/config/schema.ts`). Un id hors liste
 * est ACCEPTÉ (le moteur le chargera) mais signalé (Yuki ne saura pas le
 * sélectionner).
 */
export const ENGINE_IDS = [
  "chatterbox",
  "qwen3-tts",
  "cosyvoice3",
  "kokoro",
  "sanotts",
] as const;

/** Familles dont le SEUL mode accepté est `offline` (preuve : loader amont). */
export const ENGINE_FORCE_OFFLINE_FAMILIES = ["chatterbox", "cosyvoice3"] as const;

export type EngineGlobalType = "string" | "int" | "bool" | "enum";

/** Descripteur d'une globale connue de `server.json` (édition structurée). */
export interface EngineGlobalDescriptor {
  readonly type: EngineGlobalType;
  readonly min?: number;
  readonly max?: number;
  readonly enum?: readonly string[];
}

/**
 * Globables ÉDITABLES depuis l'interface. Les autres clés de premier niveau
 * (`cors_origins`, `live_ingest`, `model_spec_override`, …) ne sont **jamais**
 * touchées : elles sont préservées telles quelles.
 */
export const ENGINE_GLOBAL_SCHEMA: Readonly<Record<string, EngineGlobalDescriptor>> = {
  host: { type: "string" },
  port: { type: "int", min: 1, max: 65535 },
  backend: { type: "enum", enum: ["cpu", "cuda", "vulkan", "metal", "hip"] },
  device: { type: "int", min: 0 },
  threads: { type: "int", min: 1 },
  lazy_load: { type: "bool" },
  ui_enabled: { type: "bool" },
  voice_dir: { type: "string" },
  max_loaded_models: { type: "int", min: 0 },
  idle_unload_ms: { type: "int", min: 0 },
  min_free_memory_mb: { type: "int", min: 0 },
};

export interface FieldError {
  path: string;
  code: string;
  message: string;
}

/** Erreur métier de la configuration du moteur (porte un statut HTTP). */
export class EngineConfigError extends Error {
  override readonly name = "EngineConfigError";
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly fields: FieldError[] = [],
  ) {
    super(message);
  }
}

/** Entrée `models[]` telle que lue (les clés inconnues sont conservées dans `raw`). */
export interface EngineModelEntry {
  id: string;
  family: string;
  task: string;
  mode: string;
  path: string;
  raw: Record<string, unknown>;
}

/** Contenu brut lu du fichier (sans interprétation). */
export interface EngineConfigRaw {
  exists: boolean;
  valid: boolean;
  parseError: string | null;
  raw: Record<string, unknown> | null;
  backupExists: boolean;
}

/** État d'un point de montage (sans effet de bord : `probeWritable` n'est
 * appelé que si le dossier EXISTE déjà — jamais de dossier créé par la lecture). */
export interface MountState {
  dir: string;
  exists: boolean;
  isDirectory: boolean;
  writable: boolean;
  error: string | null;
  /** Code système Node (`EROFS`, `EACCES`…) de la sonde, si elle a échoué. */
  code: string | null;
}

/** Modèle présent sur le disque (tel que vu par le gateway ET par le moteur). */
export interface DiskModel {
  name: string;
  gatewayPath: string;
  enginePath: string;
  size: number;
  root: string;
}

export type PathStatus = "exists" | "missing" | "unverifiable";

/** Variante publique d'une entrée `models[]`, enrichie de l'état disque. */
export interface EngineModelView {
  id: string;
  family: string;
  task: string;
  mode: string;
  /** Chemin **vu par le moteur** (valeur stockée dans `server.json`). */
  path: string;
  /** Chemin équivalent vu par le gateway (`null` si non traduisible). */
  gatewayPath: string | null;
  pathStatus: PathStatus;
  pathNote: string | null;
  /**
   * Incohérences de cohérence famille ↔ fichier pour CETTE entrée (catalogue
   * reconnu par le basename de fichier ou le dossier du `path`). Vide = rien à
   * signaler (chemin inconnu, ou champs cohérents). C'est un **signalement** en
   * lecture : une entrée déjà incohérente reste éditable (jamais de blocage).
   */
  coherenceIssues: FieldError[];
}

/** Rapport complet de `GET /api/tts/engine-config`. */
export interface EngineConfigReport {
  /** Dossier monté ET inscriptible côté gateway. */
  available: boolean;
  configDir: string;
  configPath: string;
  engineConfigDir: string;
  engineConfigPath: string;
  modelsDir: string;
  modelsWriteDir: string;
  engineModelsDir: string;
  fileExists: boolean;
  valid: boolean;
  parseError: string | null;
  backupExists: boolean;
  mounted: boolean;
  writable: boolean;
  writeError: string | null;
  /** Code système Node (`EROFS`, `EACCES`…) de l'échec d'écriture, si connu. */
  writeCode: string | null;
  /**
   * Conseil EXACT selon la cause réelle (code système), calculé côté serveur
   * (`describeWriteFailure`). `null` quand le dossier est inscriptible.
   */
  writeHint: string | null;
  globals: Record<string, unknown>;
  models: EngineModelView[];
  unknownTopLevelKeys: string[];
  diagnostics: FieldError[];
  warnings: string[];
  diskModels: DiskModel[];
  diskTruncated: boolean;
  note: string | null;
}

export interface EngineConfigStoreOptions {
  /** Dossier de configuration VU PAR LE GATEWAY (montage `rw`). */
  configDir: string;
  /** Dossier de configuration VU PAR LE MOTEUR (montage `ro`). */
  engineConfigDir: string;
  fileName?: string;
  /** Premier montage des modèles, en `ro` côté gateway. */
  modelsDir: string;
  /** Dossier des modèles tel que vu par le moteur. */
  engineModelsDir: string;
  /**
   * Catalogue fermé utilisé par le garde-fou famille ↔ fichier : un `path`
   * RECONNU (chemin de téléchargement exact, dossier, basename de fichier ou
   * dossier amont) doit porter sa famille (et la tâche/le mode fixés par le
   * catalogue). Défaut : le catalogue réel.
   */
  catalogModels?: readonly CatalogModelSpec[];
}

/**
 * Spécification minimale d'un modèle du catalogue, utile au garde-fou
 * `path` ↔ `family`/`task`/`mode`. Le catalogue réel (`CATALOG_ENTRIES`)
 * satisfait structurellement ce type.
 *
 * `recommendedFile`/`dir` sont OPTIONNELS : ils permettent au garde-fou de
 * reconnaître un **chemin manuel** (basename de fichier, ou dossier du paquet)
 * déposé hors de l'arborescence de téléchargement. Sans eux, seul le chemin
 * exact `downloadEnginePath(id)` est contraint.
 */
export interface CatalogModelSpec {
  readonly id: string;
  readonly family: string;
  readonly task: string;
  readonly mode: string;
  /** Nom de fichier recommandé du catalogue (basename), si connu. */
  readonly recommendedFile?: string;
  /** Alias accepté : les vues d'API exposent ce champ (`expectedFile`). */
  readonly expectedFile?: string;
  /** Nom du dossier du paquet (dépôt amont), si connu. */
  readonly dir?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Écrit un fichier de façon atomique (`tmp` + `rename`), en créant le parent. */
function writeAtomic(path: string, data: Buffer | string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dernier segment d'un chemin (`\` et `/` acceptés), sans l'index de racine. */
function pathBasename(value: string): string {
  const segments = value.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.length > 0 ? (segments[segments.length - 1] as string) : "";
}

/**
 * Forme acceptée d'un `path` de modèle. Le moteur accepte :
 *   - un FICHIER `*.gguf` (casse libre, `.GGUF` inclus) ;
 *   - un DOSSIER (nom sans extension de fichier, y compris un dossier versionné
 *     à points comme `Qwen3-…-1.7B-…`) qui contient `model.gguf` ou l'unique
 *     `*.gguf`.
 * Un nom qui ressemble à un FICHIER d'une autre extension (`.bin`, `.txt`…) est
 * refusé — jamais un modèle. Un dossier inconnu reste accepté (jamais bloquant).
 */
export function isModelPathShape(value: string): boolean {
  const base = pathBasename(value);
  if (base.length === 0) return false;
  if (base.toLowerCase().endsWith(".gguf")) return true;
  return !/\.[A-Za-z0-9]{1,8}$/.test(base);
}

/** Un `id` de modèle est un jeton sûr (jamais un chemin). */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function normalizeInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

/**
 * Valide une valeur de globale selon son descripteur. Renvoie la valeur
 * normalisée ou une erreur champ-par-champ.
 */
function validateGlobal(
  key: string,
  descriptor: EngineGlobalDescriptor,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: FieldError } {
  const path = `globals.${key}`;
  if (descriptor.type === "bool") {
    if (typeof value === "boolean") return { ok: true, value };
    if (value === "true" || value === "false") return { ok: true, value: value === "true" };
    return {
      ok: false,
      error: { path, code: "invalid_bool", message: "Booléen attendu (true/false)." },
    };
  }
  if (descriptor.type === "int") {
    const n = normalizeInt(value);
    if (n === null) {
      return { ok: false, error: { path, code: "invalid_int", message: "Entier attendu." } };
    }
    if (descriptor.min !== undefined && n < descriptor.min) {
      return {
        ok: false,
        error: {
          path,
          code: "below_min",
          message: `Valeur trop petite (minimum ${descriptor.min}).`,
        },
      };
    }
    if (descriptor.max !== undefined && n > descriptor.max) {
      return {
        ok: false,
        error: {
          path,
          code: "above_max",
          message: `Valeur trop grande (maximum ${descriptor.max}).`,
        },
      };
    }
    return { ok: true, value: n };
  }
  if (typeof value !== "string") {
    return { ok: false, error: { path, code: "invalid_string", message: "Texte attendu." } };
  }
  const trimmed = value.trim();
  if (descriptor.type === "enum") {
    if (descriptor.enum && !descriptor.enum.includes(trimmed)) {
      return {
        ok: false,
        error: {
          path,
          code: "invalid_enum",
          message: `Valeur autorisée : ${descriptor.enum.join(" | ")}.`,
        },
      };
    }
  }
  return { ok: true, value: trimmed };
}

/** Valide une entrée `models[]` (jetons fermés) et renvoie le chemin moteur. */
function validateModelInput(
  index: number,
  input: unknown,
): { ok: true; entry: Omit<EngineModelEntry, "raw"> } | { ok: false; errors: FieldError[] } {
  const at = (field: string) => `models[${index}].${field}`;
  const errors: FieldError[] = [];
  if (!isRecord(input)) {
    return {
      ok: false,
      errors: [
        {
          path: `models[${index}]`,
          code: "invalid_model",
          message: "Entrée attendue : objet { id, family, task, mode, path }.",
        },
      ],
    };
  }

  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (id.length === 0) {
    errors.push({ path: at("id"), code: "invalid_id", message: "Identifiant requis." });
  } else if (!ID_PATTERN.test(id)) {
    errors.push({
      path: at("id"),
      code: "invalid_id",
      message: "Identifiant invalide (lettres, chiffres, « . », « _ », « - » ; 1 à 64 caractères).",
    });
  }

  const family = typeof input.family === "string" ? input.family.trim() : "";
  if (!(ENGINE_FAMILIES as readonly string[]).includes(family)) {
    errors.push({
      path: at("family"),
      code: "invalid_family",
      message: `Famille autorisée : ${ENGINE_FAMILIES.join(" | ")}.`,
    });
  }

  const task = typeof input.task === "string" ? input.task.trim() : "";
  if (!(ENGINE_TASK_TOKENS as readonly string[]).includes(task)) {
    errors.push({
      path: at("task"),
      code: "invalid_task",
      message:
        task === "clone"
          ? "Jeton « clone » refusé : le moteur n'accepte que « clon » (vocabulaire de tâche canonique)."
          : `Tâche autorisée : ${ENGINE_TASK_TOKENS.join(" | ")}.`,
    });
  }

  const mode = typeof input.mode === "string" ? input.mode.trim() : "";
  if (!(ENGINE_MODES as readonly string[]).includes(mode)) {
    errors.push({
      path: at("mode"),
      code: "invalid_mode",
      message: `Mode autorisé : ${ENGINE_MODES.join(" | ")}.`,
    });
  } else if (
    (ENGINE_FORCE_OFFLINE_FAMILIES as readonly string[]).includes(family) &&
    mode !== "offline"
  ) {
    errors.push({
      path: at("mode"),
      code: "mode_not_supported",
      message: `La famille « ${family} » n'accepte que le mode « offline ».`,
    });
  }

  const rawPath = typeof input.path === "string" ? input.path.trim() : "";
  if (rawPath.length === 0) {
    errors.push({ path: at("path"), code: "invalid_path", message: "Chemin requis." });
  } else if (rawPath.split(/[\\/]+/).includes("..")) {
    errors.push({
      path: at("path"),
      code: "unsafe_path",
      message: "Chemin non sûr : la composante « .. » est interdite.",
    });
  } else if (!isModelPathShape(rawPath)) {
    errors.push({
      path: at("path"),
      code: "invalid_path",
      message:
        "Le fichier de modèle doit être un « .gguf » ou un dossier contenant le modèle.",
    });
  }

  // Le chemin doit être traduisible (montage connu) : la traduction est faite
  // par l'appelant (qui porte les racines) ; ici on s'assure au minimum qu'il
  // est ABSOLU.
  if (rawPath.length > 0 && !rawPath.startsWith("/")) {
    errors.push({
      path: at("path"),
      code: "invalid_path",
      message: "Chemin absolu attendu.",
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entry: { id, family, task, mode, path: rawPath } };
}

/** Valide l'ensemble d'une configuration (jetons + cohérences). */
export function validateEngineConfig(
  raw: Record<string, unknown> | null,
): FieldError[] {
  if (!raw) return [];
  const errors: FieldError[] = [];
  const modelsRaw = raw.models;
  if (modelsRaw !== undefined && !Array.isArray(modelsRaw)) {
    errors.push({
      path: "models",
      code: "invalid_models",
      message: "« models » doit être un tableau.",
    });
    return errors;
  }
  const list = Array.isArray(modelsRaw) ? modelsRaw : [];
  const seen = new Set<string>();
  list.forEach((entry, index) => {
    if (!isRecord(entry)) {
      errors.push({
        path: `models[${index}]`,
        code: "invalid_model",
        message: "Entrée attendue : objet.",
      });
      return;
    }
    const check = validateModelInput(index, entry);
    if (!check.ok) {
      errors.push(...check.errors);
    } else if (seen.has(check.entry.id)) {
      errors.push({
        path: `models[${index}].id`,
        code: "duplicate_id",
        message: `L'identifiant « ${check.entry.id} » est déjà déclaré.`,
      });
    } else {
      seen.add(check.entry.id);
    }
  });
  return errors;
}

/** Extrait les globals connues du document. */
function extractGlobals(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(ENGINE_GLOBAL_SCHEMA)) {
    if (key in raw) out[key] = raw[key];
  }
  return out;
}

/** Extrait les entrées `models[]`. */
function extractModels(raw: Record<string, unknown>): EngineModelEntry[] {
  const modelsRaw = raw.models;
  if (!Array.isArray(modelsRaw)) return [];
  const out: EngineModelEntry[] = [];
  for (const entry of modelsRaw) {
    if (!isRecord(entry)) continue;
    out.push({
      id: typeof entry.id === "string" ? entry.id : "",
      family: typeof entry.family === "string" ? entry.family : "",
      task: typeof entry.task === "string" ? entry.task : "",
      mode: typeof entry.mode === "string" ? entry.mode : "",
      path: typeof entry.path === "string" ? entry.path : "",
      raw: entry,
    });
  }
  return out;
}

/** Clés de premier niveau inconnues (préservées telles quelles). */
function unknownTopLevel(raw: Record<string, unknown>): string[] {
  return Object.keys(raw).filter(
    (key) => key !== "models" && !(key in ENGINE_GLOBAL_SCHEMA),
  );
}

/**
 * Magasin de la configuration du moteur : lecture, validation, patch structuré,
 * écriture atomique, sauvegarde unique et restauration.
 */
export class EngineConfigStore {
  readonly configDir: string;
  readonly configPath: string;
  readonly backupPath: string;
  readonly engineConfigDir: string;
  readonly engineModelsDir: string;
  readonly modelsDir: string;
  /** Toujours un SOUS-DOSSIER de `modelsDir` : DÉRIVÉ, jamais configurable. */
  readonly modelsWriteDir: string;
  /** Catalogue indexé par chemin de téléchargement MOTEUR (garde-fou). */
  private readonly catalogByEnginePath: Map<string, CatalogModelSpec>;
  /** Catalogue indexé par DOSSIER de téléchargement moteur (`/models/downloads/<id>`). */
  private readonly catalogByEngineDir: Map<string, CatalogModelSpec>;
  /** Catalogue indexé par BASENAME de fichier (`chatterbox-q8_0.gguf`), en minuscules. */
  private readonly catalogByBasename: Map<string, CatalogModelSpec>;
  /** Catalogue indexé par nom de DOSSIER amont (`dir`), en minuscules. */
  private readonly catalogByDirName: Map<string, CatalogModelSpec>;

  constructor(options: EngineConfigStoreOptions) {
    this.configDir = resolve(options.configDir);
    this.engineConfigDir = resolve(options.engineConfigDir);
    this.configPath = join(this.configDir, options.fileName ?? ENGINE_CONFIG_FILENAME);
    this.backupPath = join(this.configDir, `${options.fileName ?? ENGINE_CONFIG_FILENAME}.bak`);
    this.modelsDir = resolve(options.modelsDir);
    // Le chemin d'écriture est DÉRIVÉ du montage des modèles (`/models` en
    // `rw` côté gateway) : il en est TOUJOURS un sous-dossier (`downloads/`).
    // C'est une convention d'organisation, pas une barrière de sécurité.
    this.modelsWriteDir = join(this.modelsDir, MODELS_DOWNLOADS_SUBDIR);
    this.engineModelsDir = resolve(options.engineModelsDir);
    // Garde-fou famille ↔ fichier : le catalogue est indexé de QUATRE façons
    // pour reconnaître aussi les chemins MANUELS déposés hors des
    // téléchargements : chemin exact, dossier de téléchargement, basename de
    // fichier (casse libre) et nom de dossier amont (`dir`). Un nom de DOSSIER
    // quelconque reste INCONNU (jamais contraint) pour ne pas bloquer un
    // dossier personnel.
    this.catalogByEnginePath = new Map();
    this.catalogByEngineDir = new Map();
    this.catalogByBasename = new Map();
    this.catalogByDirName = new Map();
    for (const raw of options.catalogModels ?? CATALOG_ENTRIES) {
      const entry = raw as CatalogModelSpec;
      this.catalogByEnginePath.set(downloadEnginePath(entry.id), entry);
      this.catalogByEngineDir.set(downloadEngineDir(entry.id), entry);
      const file = (entry.expectedFile ?? entry.recommendedFile ?? "").trim();
      if (file.length > 0) this.catalogByBasename.set(file.toLowerCase(), entry);
      const dir = (entry.dir ?? "").trim();
      if (dir.length > 0) this.catalogByDirName.set(dir.toLowerCase(), entry);
    }
  }

  /**
   * Résout la spécification de catalogue d'un `path` déclaré (vue moteur).
   * Priorité : chemin exact > dossier de téléchargement > basename de fichier >
   * nom de dossier. `null` = chemin INCONNU (GGUF personnel / moteur hors
   * catalogue) : il reste LIBRE.
   */
  private catalogSpecForPath(enginePath: string): CatalogModelSpec | null {
    const normalized = enginePath.replace(/\\/g, "/");
    const exact = this.catalogByEnginePath.get(normalized);
    if (exact) return exact;
    const dir = this.catalogByEngineDir.get(normalized);
    if (dir) return dir;
    const base = pathBasename(normalized).toLowerCase();
    if (base.length === 0) return null;
    return this.catalogByBasename.get(base) ?? this.catalogByDirName.get(base) ?? null;
  }

  /** Chemin du fichier tel que VU PAR LE MOTEUR. */
  get engineConfigPath(): string {
    return join(this.engineConfigDir, ENGINE_CONFIG_FILENAME);
  }

  /* ── Lecture brute ─────────────────────────────────────────────────────── */

  readRaw(): EngineConfigRaw {
    const backupExists = existsSync(this.backupPath);
    if (!existsSync(this.configPath)) {
      return { exists: false, valid: false, parseError: null, raw: null, backupExists };
    }
    let text: string;
    try {
      text = readFileSync(this.configPath, "utf8");
    } catch (error) {
      return {
        exists: true,
        valid: false,
        parseError: `Fichier illisible : ${messageOf(error)}`,
        raw: null,
        backupExists,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        exists: true,
        valid: false,
        parseError: `JSON invalide : ${messageOf(error)}`,
        raw: null,
        backupExists,
      };
    }
    if (!isRecord(parsed)) {
      return {
        exists: true,
        valid: false,
        parseError: "JSON invalide : un objet racine est attendu.",
        raw: null,
        backupExists,
      };
    }
    return { exists: true, valid: true, parseError: null, raw: parsed, backupExists };
  }

  /** Diagnostics de la configuration ACTUELLE (jamais d'exception). */
  diagnostics(): FieldError[] {
    const read = this.readRaw();
    if (!read.raw) return [];
    return validateEngineConfig(read.raw);
  }

  /* ── Traduction des chemins ────────────────────────────────────────────── */

  /**
   * Convertit un chemin VU PAR LE GATEWAY en chemin VU PAR LE MOTEUR.
   * Accepte aussi un chemin déjà « moteur » (idempotent). `null` si hors des
   * montages connus.
   */
  toEnginePath(gatewayOrEnginePath: string): string | null {
    const abs = resolve(gatewayOrEnginePath);
    // `modelsWriteDir` est un sous-dossier de `modelsDir` : la racine `modelsDir`
    // couvre donc aussi les chemins de téléchargement.
    if (abs === this.modelsDir) return this.engineModelsDir;
    if (abs.startsWith(this.modelsDir + sep)) {
      return join(this.engineModelsDir, abs.slice(this.modelsDir.length + 1));
    }
    if (abs === this.engineModelsDir) return abs;
    if (abs.startsWith(this.engineModelsDir + sep)) return abs;
    return null;
  }

  /** Convertit un chemin VU PAR LE MOTEUR en chemin VU PAR LE GATEWAY. */
  toGatewayPath(enginePath: string): string | null {
    const abs = resolve(enginePath);
    if (abs === this.engineModelsDir) return this.modelsDir;
    if (abs.startsWith(this.engineModelsDir + sep)) {
      return join(this.modelsDir, abs.slice(this.engineModelsDir.length + 1));
    }
    return null;
  }

  /* ── État des montages ─────────────────────────────────────────────────── */

  /**
   * État d'un dossier sans effet de bord : `probeWritable` (qui crée le dossier)
   * n'est appelé QUE s'il existe déjà — une lecture ne doit jamais créer de
   * dossier (le rootfs du gateway est en lecture seule).
   */
  private inspectDir(dir: string): MountState {
    let exists = false;
    let isDirectory = false;
    try {
      const info = statSync(dir);
      exists = true;
      isDirectory = info.isDirectory();
    } catch {
      exists = false;
      isDirectory = false;
    }
    let writable = false;
    let error: string | null = null;
    let code: string | null = null;
    if (exists && isDirectory) {
      const probe = probeWritable(dir);
      writable = probe.writable;
      error = probe.error ?? null;
      code = probe.code ?? null;
    }
    return { dir, exists, isDirectory, writable, error, code };
  }

  mountState(): { config: MountState; modelsWrite: MountState; modelsRead: MountState } {
    return {
      config: this.inspectDir(this.configDir),
      modelsWrite: this.inspectDir(this.modelsWriteDir),
      modelsRead: this.inspectDir(this.modelsDir),
    };
  }

  /* ── Scan des modèles présents sur le disque ───────────────────────────── */

  /** Liste (bornée) des fichiers `.gguf` présents sous les montages modèles. */
  listDiskModels(): { models: DiskModel[]; truncated: boolean } {
    // `modelsWriteDir` est un sous-dossier de `modelsDir` : n'ajouter que les
    // racines NON déjà couvertes, pour ne pas lister deux fois le même fichier.
    const roots: string[] = [];
    for (const root of [this.modelsDir, this.modelsWriteDir]) {
      if (roots.some((known) => root === known || root.startsWith(known + sep))) continue;
      roots.push(root);
    }
    const models: DiskModel[] = [];
    let truncated = false;
    const walk = (dir: string, depth: number): void => {
      if (depth > DISK_SCAN_MAX_DEPTH || truncated) return;
      let entries: Dirent<string>[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (truncated) return;
        if (entry.isSymbolicLink()) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".gguf")) continue;
        if (models.length >= DISK_SCAN_MAX_FILES) {
          truncated = true;
          return;
        }
        const enginePath = this.toEnginePath(full);
        if (enginePath === null) continue;
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          size = 0;
        }
        models.push({ name: entry.name, gatewayPath: full, enginePath, size, root: dir });
      }
    };
    for (const root of roots) {
      if (!existsSync(root)) continue;
      walk(root, 0);
    }
    models.sort((a, b) => a.enginePath.localeCompare(b.enginePath));
    return { models, truncated };
  }

  /* ── Rapport ───────────────────────────────────────────────────────────── */

  report(): EngineConfigReport {
    const read = this.readRaw();
    const mounts = this.mountState();
    const diagnostics = read.raw ? validateEngineConfig(read.raw) : [];
    const globals = read.raw ? extractGlobals(read.raw) : {};
    const entries = read.raw ? extractModels(read.raw) : [];
    const disk = this.listDiskModels();

    const warnings: string[] = [];
    const models: EngineModelView[] = entries.map((entry, index) => {
      if (entry.id.length > 0 && !(ENGINE_IDS as readonly string[]).includes(entry.id)) {
        warnings.push(
          `L'identifiant « ${entry.id} » n'est pas connu de Yuki : le moteur le chargera, ` +
            "mais Yuki ne saura pas le sélectionner (champ tts.engine).",
        );
      }
      const gatewayPath = this.toGatewayPath(entry.path);
      let pathStatus: PathStatus = "unverifiable";
      let pathNote: string | null = null;
      if (gatewayPath === null) {
        pathStatus = "unverifiable";
        pathNote =
          "Chemin hors des montages modèles du gateway : son existence ne peut pas être " +
          "vérifiée ici (seul le moteur, qui le voit sous son propre montage, tranche).";
      } else if (existsSync(gatewayPath)) {
        pathStatus = "exists";
      } else {
        pathStatus = "missing";
        pathNote = `Introuvable côté gateway : ${gatewayPath}.`;
      }
      // Signalement EN LECTURE des incohérences famille ↔ fichier : l'éditeur
      // peut ainsi expliquer POURQUOI le moteur refuse de démarrer. Aucun
      // blocage : la config reste éditable et réparable.
      const coherenceIssues = this.checkCatalogCoherence(entry, entry.path, index);
      return {
        id: entry.id,
        family: entry.family,
        task: entry.task,
        mode: entry.mode,
        path: entry.path,
        gatewayPath,
        pathStatus,
        pathNote,
        coherenceIssues,
      };
    });

    const available = mounts.config.exists && mounts.config.isDirectory && mounts.config.writable;
    const note =
      "Le gateway lit et écrit le dossier de configuration monté ; le moteur, lui, lit " +
      "« " +
      this.engineConfigPath +
      " » (même dossier hôte monté en lecture seule). Un changement n'est relu par le moteur " +
      "qu'à son redémarrage (1 clic dans votre UI Docker).";

    return {
      available,
      configDir: this.configDir,
      configPath: this.configPath,
      engineConfigDir: this.engineConfigDir,
      engineConfigPath: this.engineConfigPath,
      modelsDir: this.modelsDir,
      modelsWriteDir: this.modelsWriteDir,
      engineModelsDir: this.engineModelsDir,
      fileExists: read.exists,
      valid: read.valid,
      parseError: read.parseError,
      backupExists: read.backupExists,
      mounted: mounts.config.exists && mounts.config.isDirectory,
      writable: mounts.config.writable,
      writeError: mounts.config.error,
      writeCode: mounts.config.code,
      writeHint: mounts.config.writable
        ? null
        : describeWriteFailure({
            volume: "tts-config",
            path: mounts.config.dir,
            code: mounts.config.code ?? undefined,
            service: "gateway",
          }),
      globals,
      models,
      unknownTopLevelKeys: read.raw ? unknownTopLevel(read.raw) : [],
      diagnostics,
      warnings,
      diskModels: disk.models,
      diskTruncated: disk.truncated,
      note,
    };
  }

  /* ── Patch structuré ───────────────────────────────────────────────────── */

  /**
   * Applique un **patch structuré** : `{ globals?, models? }`. Le patch est
   * fusionné dans le document EXISTANT (les clés inconnues sont préservées) puis
   * validé, sauvegardé (`server.json.bak`) et écrit atomiquement.
   */
  applyPatch(patch: unknown): EngineConfigReport {
    const mounts = this.mountState();
    if (!mounts.config.exists || !mounts.config.isDirectory) {
      throw new EngineConfigError(
        "config_dir_not_mounted",
        503,
        "Le dossier de configuration du moteur n'est pas monté dans le gateway. " +
          "Appliquez le montage décrit dans le README de déploiement puis rechargez.",
      );
    }
    if (!mounts.config.writable) {
      throw new EngineConfigError(
        "config_dir_unwritable",
        503,
        "Le dossier de configuration du moteur n'est pas inscriptible par le gateway : " +
          describeWriteFailure({
            volume: "tts-config",
            path: mounts.config.dir,
            code: mounts.config.code ?? undefined,
            service: "gateway",
          }) +
          (mounts.config.error ? ` Détail brut : ${mounts.config.error}.` : ""),
      );
    }
    if (!isRecord(patch)) {
      throw new EngineConfigError(
        "invalid_body",
        400,
        "Objet attendu : { globals?, models? }.",
        [{ path: "", code: "invalid_body", message: "Objet attendu : { globals?, models? }." }],
      );
    }
    const allowed = new Set(["globals", "models"]);
    for (const key of Object.keys(patch)) {
      if (!allowed.has(key)) {
        const message = `Champ de patch inconnu : « ${key} » (autorisés : globals, models).`;
        throw new EngineConfigError("unknown_patch_field", 400, message, [
          { path: key, code: "unknown_patch_field", message },
        ]);
      }
    }

    const current = this.readRaw();
    if (current.exists && !current.valid) {
      throw new EngineConfigError(
        "config_invalid",
        422,
        `Le fichier de configuration existant est invalide et ne peut pas être fusionné : ${current.parseError}`,
        [{ path: "", code: "config_invalid", message: current.parseError ?? "JSON invalide." }],
      );
    }
    // Clone profond du document existant : garantit la préservation fidèle des
    // clés inconnues (ordre inclus).
    const doc: Record<string, unknown> = current.raw ? structuredClone(current.raw) : {};
    const errors: FieldError[] = [];

    // 1) Globables.
    if (patch.globals !== undefined) {
      if (!isRecord(patch.globals)) {
        throw new EngineConfigError("invalid_globals", 400, "« globals » doit être un objet.", [
          { path: "globals", code: "invalid_globals", message: "Objet attendu." },
        ]);
      }
      for (const [key, value] of Object.entries(patch.globals)) {
        const descriptor = ENGINE_GLOBAL_SCHEMA[key];
        if (!descriptor) {
          errors.push({
            path: `globals.${key}`,
            code: "unknown_global",
            message: `Globale inconnue : « ${key} ».`,
          });
          continue;
        }
        if (value === null) {
          delete doc[key];
          continue;
        }
        const check = validateGlobal(key, descriptor, value);
        if (!check.ok) errors.push(check.error);
        else doc[key] = check.value;
      }
    }

    // 2) Modèles (remplacement complet de la liste déclarée).
    if (patch.models !== undefined) {
      if (!Array.isArray(patch.models)) {
        throw new EngineConfigError("invalid_models", 400, "« models » doit être un tableau.", [
          { path: "models", code: "invalid_models", message: "Tableau attendu." },
        ]);
      }
      const existing = current.raw ? extractModels(current.raw) : [];
      const byId = new Map(existing.map((entry) => [entry.id, entry]));
      const next: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      patch.models.forEach((input, index) => {
        const check = validateModelInput(index, input);
        if (!check.ok) {
          errors.push(...check.errors);
          return;
        }
        const entry = check.entry;
        if (seen.has(entry.id)) {
          errors.push({
            path: `models[${index}].id`,
            code: "duplicate_id",
            message: `L'identifiant « ${entry.id} » est déjà déclaré.`,
          });
          return;
        }
        seen.add(entry.id);
        const enginePath = this.toEnginePath(entry.path);
        if (enginePath === null) {
          errors.push({
            path: `models[${index}].path`,
            code: "path_outside_mounts",
            message:
              "Chemin hors des montages modèles connus. Choisissez un fichier présent sur le " +
              "disque (le chemin est converti vers le point de vue du moteur).",
          });
          return;
        }
        // Préserve les clés inconnues de l'entrée existante de MÊME id.
        const previous = byId.get(entry.id)?.raw ?? {};
        const extras: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(previous)) {
          if (["id", "family", "path", "task", "mode"].includes(key)) continue;
          extras[key] = value;
        }
        // Garde-fou famille ↔ fichier : le catalogue CONNAÎT la famille/la
        // tâche/le mode d'un chemin qu'il a fourni.
        errors.push(...this.checkCatalogCoherence(entry, enginePath, index));
        next.push({
          id: entry.id,
          family: entry.family,
          path: enginePath,
          task: entry.task,
          mode: entry.mode,
          ...extras,
        });
      });
      if (errors.length === 0) doc.models = next;
    }

    if (errors.length > 0) {
      // Le message de premier niveau reprend la cause la PLUS actionnable
      // (garde-fou catalogue) ; les champs portent le détail exact.
      const actionable = errors.find(
        (error) => error.code.startsWith("catalog_") || error.code === "path_outside_mounts",
      );
      throw new EngineConfigError(
        "invalid_engine_config",
        400,
        actionable ? actionable.message : "Configuration refusée.",
        errors,
      );
    }

    this.writeConfig(doc);
    return this.report();
  }

  /**
   * Garde-fou « famille ↔ fichier » (défense en profondeur, côté serveur).
   *
   * ⚠️ Portée : il s'applique quand le `path` déclaré est RECONNU comme un
   * modèle du catalogue fermé — soit par son chemin de téléchargement EXACT
   * (`/models/downloads/<id>/model.gguf`), soit par le **basename** de son
   * fichier (`chatterbox-q8_0.gguf`, casse libre) ou le nom de son dossier
   * (`/models/downloads/<id>`, `Chatterbox-GGUF`…), ce qui couvre les fichiers
   * déposés À LA MAIN. Un chemin INCONNU (GGUF personnel, moteur hors catalogue)
   * reste LIBRE (aucun blocage).
   *
   * Un fichier GGUF porte sa famille : quand le catalogue le reconnaît, sa
   * famille (et la tâche/le mode qu'il fixe) est la SEULE cohérente. Sans ce
   * contrôle, une `family` erronée ne serait détectée qu'au DÉMARRAGE du moteur
   * (« GGUF embeds model spec for family '…', not '…' »).
   */
  private checkCatalogCoherence(
    entry: { id: string; family: string; task: string; mode: string },
    enginePath: string,
    index: number,
  ): FieldError[] {
    const spec = this.catalogSpecForPath(enginePath);
    if (!spec) return [];
    const label = entry.id.length > 0 ? `« ${entry.id} »` : "(sans identifiant)";
    const file = (spec.recommendedFile ?? spec.expectedFile ?? "").trim();
    const origin =
      file.length > 0 && file.toLowerCase() !== spec.id.toLowerCase()
        ? `reconnu comme le fichier « ${file} » du modèle de catalogue « ${spec.id} »`
        : `reconnu comme le modèle de catalogue « ${spec.id} »`;
    const errors: FieldError[] = [];
    if (entry.family !== spec.family) {
      errors.push({
        path: `models[${index}].family`,
        code: "catalog_family_mismatch",
        message:
          `L'entrée models[${index}] ${label} pointe le chemin « ${enginePath} », ${origin} : ` +
          `sa famille doit être « ${spec.family} », or elle est déclarée « ${entry.family} ». ` +
          `Corrigez la famille (choisissez « ${spec.family} ») ou le chemin (ce fichier ne ` +
          `correspond pas à cette famille).`,
      });
    }
    if (entry.task !== spec.task) {
      errors.push({
        path: `models[${index}].task`,
        code: "catalog_task_mismatch",
        message:
          `L'entrée models[${index}] ${label} pointe le chemin « ${enginePath} », ${origin} : ` +
          `sa tâche doit être « ${spec.task} », or elle est déclarée « ${entry.task} ». ` +
          `Corrigez la tâche (choisissez « ${spec.task} ») ou le chemin.`,
      });
    }
    if (entry.mode !== spec.mode) {
      errors.push({
        path: `models[${index}].mode`,
        code: "catalog_mode_mismatch",
        message:
          `L'entrée models[${index}] ${label} pointe le chemin « ${enginePath} », ${origin} : ` +
          `son mode doit être « ${spec.mode} », or il est déclaré « ${entry.mode} ». ` +
          `Corrigez le mode (choisissez « ${spec.mode} ») ou le chemin.`,
      });
    }
    return errors;
  }

  /** Écrit le document : sauvegarde de l'ancien, puis écriture atomique. */
  private writeConfig(doc: Record<string, unknown>): void {
    const payload = `${JSON.stringify(doc, null, 2)}\n`;
    if (existsSync(this.configPath)) {
      try {
        const previous = readFileSync(this.configPath);
        writeAtomic(this.backupPath, previous, 0o644);
      } catch (error) {
        throw new EngineConfigError(
          "backup_failed",
          500,
          `Impossible d'écrire la sauvegarde « ${this.backupPath} » : ${messageOf(error)}`,
        );
      }
    }
    try {
      writeAtomic(this.configPath, payload, 0o644);
    } catch (error) {
      throw new EngineConfigError(
        "config_write_failed",
        500,
        `Impossible d'écrire « ${this.configPath} » : ${messageOf(error)}`,
      );
    }
  }

  /* ── Restauration ──────────────────────────────────────────────────────── */

  /** Restaure `server.json.bak` dans `server.json` (écriture atomique). */
  revert(): EngineConfigReport {
    if (!existsSync(this.backupPath)) {
      throw new EngineConfigError(
        "no_backup",
        404,
        "Aucune sauvegarde « server.json.bak » : rien à restaurer.",
      );
    }
    let text: string;
    try {
      text = readFileSync(this.backupPath, "utf8");
    } catch (error) {
      throw new EngineConfigError(
        "backup_unreadable",
        500,
        `Sauvegarde illisible : ${messageOf(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new EngineConfigError(
        "backup_invalid",
        422,
        `La sauvegarde n'est pas un JSON valide : ${messageOf(error)}`,
      );
    }
    if (!isRecord(parsed)) {
      throw new EngineConfigError(
        "backup_invalid",
        422,
        "La sauvegarde ne contient pas un objet JSON.",
      );
    }
    try {
      writeAtomic(this.configPath, `${JSON.stringify(parsed, null, 2)}\n`, 0o644);
    } catch (error) {
      throw new EngineConfigError(
        "config_write_failed",
        500,
        `Impossible d'écrire « ${this.configPath} » : ${messageOf(error)}`,
      );
    }
    return this.report();
  }
}

/* ─── Sonde de capacités du moteur ───────────────────────────────────────── */

export interface EngineCapabilitiesReport {
  reachable: boolean;
  baseUrl: string;
  /** Nom de la route sondée. */
  route: string;
  method: string;
  /** `true` = route confirmée présente ; `false` = 404 (absente) ; `null` = indéterminé. */
  unloadModels: boolean | null;
  probeStatus: number | null;
  probeBody: string | null;
  detail: string | null;
  measuredAt: string | null;
}

export interface EngineCapabilitiesOptions {
  timeoutMs?: number;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Route attestée par le README amont (existence réelle NON vérifiée). */
export const ENGINE_UNLOAD_ROUTE = "/v1/tasks/unload_models";
/** Id sentinelle : ne peut correspondre à aucun modèle chargé. */
const CAPABILITY_SENTINEL_ID = "__yuki_capability_probe__";

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/**
 * Sonde la présence de `POST /v1/tasks/unload_models` **sans effet de bord**.
 *
 * ⚠️ On n'envoie PAS une liste vide : une sémantique plausible « liste vide =
 * tout décharger » toucherait des modèles UTILISÉS. On envoie un **id
 * sentinelle** (`__yuki_capability_probe__`) qui ne peut correspondre à aucun
 * modèle : soit la route l'ignore (déchargement de rien), soit elle répond une
 * erreur de validation — dans les deux cas aucun modèle réel n'est déchargé.
 *
 * Lecture du résultat : `404` ⇒ route absente (`false`) ; `2xx`/`400`/`422`/
 * `405` ⇒ route présente (`true`, avec la réserve du code) ; `5xx` ou erreur
 * réseau ⇒ indéterminé (`null`). L'UI ne montre la fonction que si `true`.
 */
export class EngineCapabilitiesProbe {
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private last: EngineCapabilitiesReport | null = null;
  private lastAt = 0;
  private inflight: Promise<EngineCapabilitiesReport> | null = null;

  constructor(
    private readonly baseUrl: () => string,
    options: EngineCapabilitiesOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 1_500;
    this.ttlMs = options.ttlMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async probe(force = false): Promise<EngineCapabilitiesReport> {
    if (!force && this.last && this.now() - this.lastAt < this.ttlMs) {
      return this.last;
    }
    if (this.inflight) return this.inflight;
    const pending = this.run().then(
      (report) => {
        this.last = report;
        this.lastAt = this.now();
        this.inflight = null;
        return report;
      },
      (error: unknown) => {
        this.inflight = null;
        throw error;
      },
    );
    this.inflight = pending;
    return pending;
  }

  private async run(): Promise<EngineCapabilitiesReport> {
    const baseUrl = trimBaseUrl(this.baseUrl());
    const url = `${baseUrl}${ENGINE_UNLOAD_ROUTE}`;
    const method = "POST";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ models: [CAPABILITY_SENTINEL_ID] }),
        signal: controller.signal,
      });
      const body = (await response.text().catch(() => "")).trim().slice(0, 400);
      const measuredAt = new Date(this.now()).toISOString();
      const detail = describeProbeStatus(response.status, body);
      let unloadModels: boolean | null;
      if (response.status === 404) unloadModels = false;
      else if (response.status === 405) unloadModels = true;
      else if (response.status >= 200 && response.status < 300) unloadModels = true;
      else if (response.status === 400 || response.status === 422) unloadModels = true;
      else unloadModels = null;
      return {
        reachable: true,
        baseUrl,
        route: ENGINE_UNLOAD_ROUTE,
        method,
        unloadModels,
        probeStatus: response.status,
        probeBody: body.length > 0 ? body : null,
        detail,
        measuredAt,
      };
    } catch (error) {
      const detail = controller.signal.aborted
        ? `Délai dépassé (${this.timeoutMs} ms) vers ${url}.`
        : messageOf(error);
      return {
        reachable: false,
        baseUrl,
        route: ENGINE_UNLOAD_ROUTE,
        method,
        unloadModels: null,
        probeStatus: null,
        probeBody: null,
        detail,
        measuredAt: new Date(this.now()).toISOString(),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function describeProbeStatus(status: number, body: string): string {
  const suffix = body.length > 0 ? ` : ${body}` : "";
  if (status === 404) return `Route absente (404)${suffix}.`;
  if (status === 405) {
    return `Route présente mais méthode refusée (405)${suffix}.`;
  }
  if (status >= 200 && status < 300) return `Route présente (${status})${suffix}.`;
  if (status === 400 || status === 422) {
    return `Route présente (${status} : corps sentinelle refusé)${suffix}.`;
  }
  return `Résultat indéterminé (${status})${suffix}.`;
}
