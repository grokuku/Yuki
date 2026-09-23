/**
 * CATALOGUE FERMÉ des paquets de modèles TTS téléchargeables (Lot 9, étape 2).
 *
 * ⚠️ Anti-SSRF par construction : le navigateur n'envoie JAMAIS d'URL. Il ne
 * fournit qu'un **identifiant de catalogue** ; les URL Hugging Face sont
 * **construites par le serveur** à partir des données ci-dessous.
 *
 * Chaque entrée a été ÉTABLIE depuis la source amont (aucune valeur inventée) :
 *   - fichiers/taille/`oid` : API Hugging Face
 *     `GET /api/models/<repo>/tree/main/<dir>` (HTTP 200) ;
 *   - licence : tableau du README du dépôt HF (`licenses` par dossier) ;
 *   - `family` / `task` / `mode` : `model_specs/*.json` du dépôt `audio.cpp`
 *     (`family`, `tasks`, `modes`) recoupés par le code du loader/session.
 *
 * Correspondance Yuki ↔ amont : l'`id` est la valeur EXACTE de `tts.engine`
 * (`src/config/schema.ts:221-224`) ; la `family` est le nom reconnu par le
 * moteur (`ModelRegistry::supports_family`, `family()` du loader) — ⚠️ `id` et
 * `family` diffèrent (`qwen3-tts` vs `qwen3_tts`, `kokoro` vs `kokoro_tts`), voir
 * `docs/lot9.md` D62/D64.
 *
 * Politique de licence de l'utilisateur : seuls les paquets **MIT** ou
 * **Apache-2.0** entrent au catalogue. Un moteur de l'enum qui tombe hors
 * politique n'est PAS retiré silencieusement : il est listé dans
 * `CATALOG_REJECTIONS` et exposé par `GET /api/tts/catalog` (`notIncluded`).
 */

import { CONTAINER_PATHS, MODELS_DOWNLOADS_SUBDIR } from "../config/container-paths.js";

/** Version du schéma du catalogue (stable pour la consommation UI). */
export const CATALOG_SCHEMA_VERSION = 1;

/** Licences acceptées par la politique de l'utilisateur. */
export const CATALOG_ALLOWED_LICENSES = ["MIT", "Apache-2.0"] as const;

/** Nom du fichier local IMPOSÉ dans le dossier du moteur (sélecteur unique). */
export const DOWNLOAD_FILE_NAME = "model.gguf";
/** Suffixe du fichier partiel (avant `rename` atomique). */
export const DOWNLOAD_PART_SUFFIX = ".part";
/** Base des URL de résolution Hugging Face (jamais fournie par le client). */
export const HF_RESOLVE_BASE = "https://huggingface.co";
/** Base de l'API Hugging Face (métadonnées : nom exact, taille, SHA-256). */
export const HF_API_BASE = "https://huggingface.co/api";

/**
 * Une entrée du catalogue téléchargeable. Toutes les valeurs proviennent de la
 * source amont ; `approxBytes`/`sha256` sont un **repli documenté** utilisé
 * quand l'API HF est injoignable (la résolution à la demande reste la règle).
 */
export interface CatalogEntry {
  /** Valeur EXACTE de `tts.engine` (clé `id` de `models[]`). */
  readonly id: string;
  readonly label: string;
  /** Dépôt Hugging Face (jamais fourni par le client). */
  readonly repo: string;
  /** Dossier du paquet dans le dépôt. */
  readonly dir: string;
  /** Variante lisible (quantification / sous-modèle). */
  readonly variant: string;
  /** Fichier recommandé (repli si l'API HF ne peut être interrogée). */
  readonly recommendedFile: string;
  /** Famille reconnue par le moteur `audio.cpp`. */
  readonly family: string;
  /** Jeton canonique de `task` (`clon`, `tts`, …). */
  readonly task: string;
  /** Mode d'exécution (`offline` uniquement pour ces paquets). */
  readonly mode: string;
  readonly license: string;
  /** Taille annoncée (octets) au moment de la rédaction (repli). */
  readonly approxBytes: number;
  /** SHA-256 annoncé (LFS `oid`) au moment de la rédaction (repli). */
  readonly sha256: string;
  /** Justification du choix de la variante (documentation). */
  readonly rationale: string;
}

/**
 * Catalogue fermé. Ordre = ordre d'affichage souhaité (moteur principal d'abord).
 *
 * Preuves :
 *   - Chatterbox  : `Chatterbox-GGUF/chatterbox-q8_0.gguf`, 2088393668 o, MIT
 *     (`README.md` du dépôt HF ; `model_specs/chatterbox.json` : family
 *     `chatterbox`, tasks `[tts, clone, vc]`, modes `[offline]` ; loader
 *     `src/models/chatterbox/loader.cpp:27` family `chatterbox`, `:17-18`
 *     VoiceCloning/VoiceConversion, `:131-138` offline) ;
 *   - Qwen3-TTS   : `Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf`,
 *     2695175104 o, Apache-2.0 (`README.md` ; `model_specs/qwen3_tts.json`
 *     `ui.recommended_package`, family `qwen3_tts`, modes `[offline]`) ;
 *     task `tts` prouvée par le loader `src/models/qwen3_tts/loader.cpp:140`
 *     (« Qwen3 base TTS model only supports the Tts task ») ;
 *   - CosyVoice 3 : `CosyVoice3-GGUF/cosyvoice3-q8_0.gguf`, 2257658080 o,
 *     Apache-2.0 (`README.md` ; `model_specs/cosyvoice3.json` family
 *     `cosyvoice3`, tasks `[tts, clone]`, modes `[offline]` ;
 *     `src/models/cosyvoice3/session.cpp:88-92`) ;
 *   - Kokoro 82M  : `Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf`, 189549408 o,
 *     Apache-2.0 (`README.md` ; `model_specs/kokoro_tts.json` family
 *     `kokoro_tts`, tasks `[tts]`, modes `[offline]` ;
 *     `app/server/runtime.cpp:2116` compare bien `family != "kokoro_tts"`).
 */
export const CATALOG_ENTRIES: readonly CatalogEntry[] = [
  {
    id: "chatterbox",
    label: "Chatterbox Multilingue",
    repo: "audio-cpp/audio.cpp-gguf",
    dir: "Chatterbox-GGUF",
    variant: "Q8_0",
    recommendedFile: "chatterbox-q8_0.gguf",
    family: "chatterbox",
    task: "clon",
    mode: "offline",
    license: "MIT",
    approxBytes: 2_088_393_668,
    sha256: "d586dd1aa59613cab8046176fb7ca5ba191c02a9b10ffa5b0d892ed22b470656",
    rationale:
      "Paquet recommandé par la spec amont (`ui.recommended_package = chatterbox_q8_0`). " +
      "Tâche `clon` : le loader Chatterbox ne supporte que le clonage et la conversion de voix.",
  },
  {
    id: "cosyvoice3",
    label: "CosyVoice 3",
    repo: "audio-cpp/audio.cpp-gguf",
    dir: "CosyVoice3-GGUF",
    variant: "Q8_0",
    recommendedFile: "cosyvoice3-q8_0.gguf",
    family: "cosyvoice3",
    task: "clon",
    mode: "offline",
    license: "Apache-2.0",
    approxBytes: 2_257_658_080,
    sha256: "ff31bb29ba5723809ec817c9fcc09a5f88d5d8ef6cfbc623edb5a7d7be8a6fca",
    rationale:
      "Q8_0 retenu (F32 pèse 6,5 Gio pour un gain de qualité marginal). Tâche `clon` : " +
      "CosyVoice 3 accepte `tts` et `clone`, mais Yuki s'en sert avec une voix de référence.",
  },
  {
    id: "qwen3-tts",
    label: "Qwen3-TTS 12 Hz 1.7B (Base)",
    repo: "audio-cpp/audio.cpp-gguf",
    dir: "Qwen3-TTS-12Hz-1.7B-Base-GGUF",
    variant: "1.7B Base · Q8_0",
    recommendedFile: "qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf",
    family: "qwen3_tts",
    task: "tts",
    mode: "offline",
    license: "Apache-2.0",
    approxBytes: 2_695_175_104,
    sha256: "b55e06c7890d43c208d15aed8b4ed3f18215f295e47d5960e061b15bff338ab0",
    rationale:
      "Paquet `ui.recommended_package` de la spec (`qwen3_tts_1_7b_base_q8_0`) ; variante `Base` " +
      "= clonage (seule réellement pilotable depuis Yuki). Tâche `tts` imposée : le loader refuse " +
      "`clon` sur `Base` (`Qwen3 base TTS model only supports the Tts task`).",
  },
  {
    id: "kokoro",
    label: "Kokoro 82M",
    repo: "audio-cpp/audio.cpp-gguf",
    dir: "Kokoro-82M-GGUF",
    variant: "Q8_0",
    recommendedFile: "kokoro-82m-q8_0.gguf",
    family: "kokoro_tts",
    task: "tts",
    mode: "offline",
    license: "Apache-2.0",
    approxBytes: 189_549_408,
    sha256: "5d800fd204029302c10313daeafdb31c875c7c29ae31974d0d156cc7f512d1d0",
    rationale:
      "Paquet recommandé (`kokoro_82m_q8_0`) ; 54 voix intégrées, pas de clonage. " +
      "Tâche `tts` (spec `tasks: [\"tts\"]`).",
  },
];

/** Moteur de l'enum `tts.engine` volontairement NON téléchargeable. */
export interface CatalogRejection {
  readonly id: string;
  readonly label: string;
  readonly repo: string;
  readonly dir: string;
  readonly family: string;
  readonly license: string;
  /** Code stable, exploité par l'UI pour un message honnête. */
  readonly reason: "license_out_of_policy";
  readonly detail: string;
}

/**
 * Entrées ÉCARTÉES et POURQUOI — jamais retirées silencieusement.
 *
 * `sanotts` : seul paquet amont identifié dans le dépôt `ampixa/sanoTTS`
 * (`model_specs/sanotts.json` → `package_defaults.download.repo`), mais sa
 * licence est **GPL-3.0** (`license: gpl-3.0` sur la fiche HF et le README), donc
 * hors politique (MIT/Apache-2.0). Il n'est donc PAS téléchargeable depuis Yuki.
 */
export const CATALOG_REJECTIONS: readonly CatalogRejection[] = [
  {
    id: "sanotts",
    label: "sanoTTS Nano",
    repo: "ampixa/sanoTTS",
    dir: "gguf",
    family: "sanotts",
    license: "GPL-3.0",
    reason: "license_out_of_policy",
    detail:
      "Paquet communautaire hébergé sur `ampixa/sanoTTS`, sous licence GPL-3.0 : hors " +
      "politique MIT/Apache-2.0. Non proposé au téléchargement ; un opérateur peut " +
      "toujours déposer un GGUF valide à la main et le déclarer via l'éditeur.",
  },
];

/** Vrai si la licence est acceptable pour le catalogue. */
export function isAllowedLicense(license: string): boolean {
  return (CATALOG_ALLOWED_LICENSES as readonly string[]).includes(license);
}

/** Retrouve une entrée par son identifiant de catalogue (`tts.engine`). */
export function findCatalogEntry(
  id: string,
  entries: readonly CatalogEntry[] = CATALOG_ENTRIES,
): CatalogEntry | undefined {
  return entries.find((entry) => entry.id === id);
}

/* ─── Résolution à la demande via l'API Hugging Face ─────────────────────── */

/** Entrée de l'API `tree` (champs utilisés). */
interface HfTreeEntry {
  type?: unknown;
  path?: unknown;
  size?: unknown;
  oid?: unknown;
  lfs?: { oid?: unknown; size?: unknown } | undefined;
}

/** Paquet RÉSOLU : la source de vérité d'un téléchargement. */
export interface ResolvedPackage {
  readonly catalogId: string;
  readonly repo: string;
  /** Chemin du fichier dans le dépôt (`<dir>/<fichier>`). */
  readonly path: string;
  readonly fileName: string;
  readonly url: string;
  readonly bytes: number;
  /** SHA-256 si l'API l'expose (`lfs.oid`), sinon `null` (jamais prétendu). */
  readonly sha256: string | null;
}

/** Provenance de la résolution : API HF vivante, ou repli documenté. */
export type ResolveSource = "hf" | "fallback";

export interface ResolvedCatalogPackage {
  readonly resolved: ResolvedPackage;
  readonly source: ResolveSource;
  /** Explication honnête quand un repli a été utilisé. */
  readonly warning: string | null;
}

/** Erreur de résolution (paquet introuvable côté HF). */
export class CatalogResolveError extends Error {
  override readonly name = "CatalogResolveError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ResolveCatalogOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** URL de l'API `tree` d'un dossier de dépôt. */
export function hfTreeUrl(entry: CatalogEntry): string {
  return `${HF_API_BASE}/models/${entry.repo}/tree/main/${entry.dir}`;
}

/** URL de téléchargement (`resolve`) construite CÔTÉ SERVEUR. */
export function hfResolveUrl(repo: string, path: string): string {
  return `${HF_RESOLVE_BASE}/${repo}/resolve/main/${path}`;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

/** Repli documenté : nom/taille/SHA annoncés à la rédaction. */
function fallbackResolved(entry: CatalogEntry, warning: string): ResolvedCatalogPackage {
  const path = `${entry.dir}/${entry.recommendedFile}`;
  return {
    resolved: {
      catalogId: entry.id,
      repo: entry.repo,
      path,
      fileName: entry.recommendedFile,
      url: hfResolveUrl(entry.repo, path),
      bytes: entry.approxBytes,
      sha256: null,
    },
    source: "fallback",
    warning,
  };
}

/**
 * Interroge l'API HF pour obtenir le **nom exact**, la **taille** et, si elle
 * est exposée, le **SHA-256** (`lfs.oid`) du fichier recommandé.
 *
 * Si l'API est injoignable ou répond en erreur, un **repli documenté** est
 * renvoyé (`source: "fallback"`, `sha256: null`) : la taille n'est alors
 * qu'annoncée et l'intégrité n'est PAS prétendue vérifiée. Si l'API répond mais
 * que le fichier recommandé est absent, une `CatalogResolveError` est levée
 * (jamais de nom deviné).
 */
export async function resolveCatalogPackage(
  entry: CatalogEntry,
  options: ResolveCatalogOptions = {},
): Promise<ResolvedCatalogPackage> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  let response: Response;
  try {
    response = await fetchImpl(hfTreeUrl(entry), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error) {
    const detail = controller.signal.aborted
      ? `délai dépassé (${timeoutMs} ms)`
      : error instanceof Error
        ? error.message
        : String(error);
    return fallbackResolved(
      entry,
      `API Hugging Face injoignable (${detail}) : repli sur le nom et la taille annoncés ` +
        "à la rédaction du catalogue ; l'intégrité ne sera pas vérifiée.",
    );
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    return fallbackResolved(
      entry,
      `API Hugging Face a répondu ${response.status} : repli sur le nom et la taille annoncés ; ` +
        "l'intégrité ne sera pas vérifiée.",
    );
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return fallbackResolved(entry, "Réponse Hugging Face illisible : repli documenté.");
  }
  if (!Array.isArray(parsed)) {
    return fallbackResolved(entry, "Réponse Hugging Face inattendue : repli documenté.");
  }
  const files: Array<{ path: string; bytes: number; sha256: string | null }> = [];
  for (const raw of parsed as HfTreeEntry[]) {
    if (!raw || typeof raw !== "object" || raw.type !== "file") continue;
    if (typeof raw.path !== "string" || !raw.path.toLowerCase().endsWith(".gguf")) continue;
    const lfsSize = raw.lfs && typeof raw.lfs.size === "number" ? raw.lfs.size : undefined;
    const plainSize = typeof raw.size === "number" ? raw.size : undefined;
    const bytes = lfsSize ?? plainSize ?? 0;
    const lfsOid = raw.lfs ? raw.lfs.oid : undefined;
    const sha256 = isSha256(lfsOid) ? lfsOid.toLowerCase() : null;
    files.push({ path: raw.path, bytes, sha256 });
  }
  if (files.length === 0) {
    throw new CatalogResolveError(
      "package_not_found",
      `Aucun fichier « .gguf » dans « ${entry.dir} » du dépôt « ${entry.repo} ».`,
    );
  }
  const wanted = entry.recommendedFile.toLowerCase();
  let chosen = files.find((file) => file.path.toLowerCase().endsWith(`/${wanted}`));
  if (!chosen && files.length === 1) {
    // Repli documenté : un seul GGUF dans le dossier → c'est lui.
    chosen = files[0];
  }
  if (!chosen) {
    const names = files.map((file) => file.path.split("/").pop()).join(", ");
    throw new CatalogResolveError(
      "package_changed",
      `Le fichier recommandé « ${entry.recommendedFile} » est absent de « ${entry.dir} » ` +
        `(dépôt « ${entry.repo} »). Fichiers présents : ${names}.`,
    );
  }
  const resolved: ResolvedPackage = {
    catalogId: entry.id,
    repo: entry.repo,
    path: chosen.path,
    fileName: chosen.path.split("/").pop() ?? entry.recommendedFile,
    url: hfResolveUrl(entry.repo, chosen.path),
    bytes: chosen.bytes,
    sha256: chosen.sha256,
  };
  const warning =
    chosen.bytes > 0
      ? null
      : "L'API Hugging Face n'a pas annoncé de taille pour ce fichier ; la vérification " +
        "de taille utilisera la taille réellement reçue.";
  return { resolved, source: "hf", warning };
}

/** Chemin du dossier de destination, VU PAR LE MOTEUR (`/models/downloads/<id>`). */
export function downloadEngineDir(engineId: string): string {
  return `${CONTAINER_PATHS.models}/${MODELS_DOWNLOADS_SUBDIR}/${engineId}`;
}

/** Chemin du fichier de destination, VU PAR LE MOTEUR. */
export function downloadEnginePath(engineId: string): string {
  return `${downloadEngineDir(engineId)}/${DOWNLOAD_FILE_NAME}`;
}
