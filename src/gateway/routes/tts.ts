/**
 * Diagnostic TTS (Lot 8) — `node:http`, aucun framework.
 *
 * Objectif : permettre à l'UI de dire **honnêtement** dans quel état est le
 * moteur `audio.cpp` et ce qui manque, **sans jamais mentir** et **sans jamais
 * bloquer** le gateway (le TTS n'est pas un facteur bloquant).
 *
 * Routes :
 *   GET  /api/tts/status  → sonde d'état du moteur (`{baseUrl}/health`) +
 *                           diagnostic du répertoire des modèles (ro).
 *   GET  /api/tts/models  → proxy de `{baseUrl}/v1/models` + présence du moteur.
 *   POST /api/tts/test    → synthèse d'un TEXTE LIBRE avec la voix active (WAV).
 *
 * Contrat moteur — état de la connaissance (⚠️ mis à jour par l'EXÉCUTION) :
 *   - `GET /v1/models` → liste OpenAI-compatible `{ id, task }` (observée en
 *     réel : `chatterbox — tts`) ;
 *   - `GET /health` → la forme `{ ready, model_count }` provenait d'une ARCHIVE
 *     documentaire, elle est **démentie par l'exécution réelle** : le moteur
 *     répond 200 **sans** champ `ready`. La forme exacte reste **INCONNUE** :
 *     la sonde est donc **TOLÉRANTE** (jamais « erreur » sur un champ absent ou
 *     incompris) et conserve le **corps brut borné** pour figer la forme dès
 *     qu'un relevé réel sera disponible (voir `docs/lot8.md`, point `C25`) ;
 *   - `503` renvoyé par le `BusyGuard` … ET par le garde-mémoire
 *     (`min_free_memory_mb`, « Insufficient Memory »). Le contrat n'expose PAS
 *     de discriminant fiable : on conserve le corps brut sans trancher.
 *
 * ⚠️ Le réseau n'est pas exposé au client : le service `tts` vit sur
 * `yuki-net` ; tout passe par le gateway (seul à pouvoir joindre `tts:8081`).
 *
 * Aucune écriture n'est faite dans `/models` par ces routes de diagnostic : on
 * ne fait que **lire** le répertoire pour dire à l'utilisateur où déposer un
 * modèle. (Le gateway a, depuis le Lot 9 M1, un accès en ÉCRITURE à `/models`,
 * mais il n'en a pas besoin ici ; le moteur `tts`, lui, le monte en `ro`.)
 *
 * Le choix de performance de `/health` est documenté sur `TtsDiagnostics` :
 * sonde en tâche de fond + cache court (5 s), jamais d'attente bloquante.
 */

import type { IncomingHttpHeaders } from "node:http";
import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { AudioCppError } from "../../tts/audio-cpp.js";
import {
  EngineConfigError,
  type EngineCapabilitiesReport,
  type EngineConfigReport,
} from "../../tts/engine-config.js";
import { TtsDownloadError } from "../../tts/downloads.js";
import type {
  CatalogEntry,
  CatalogRejection,
} from "../../tts/catalog-data.js";
import { CATALOG_SCHEMA_VERSION, isAllowedLicense } from "../../tts/catalog-data.js";
import type { DownloadTask } from "../../tts/downloads.js";
import { VoiceStoreError } from "../../tts/voices-store.js";
import type { Voice } from "../../tts/types.js";
import type { Logger } from "../../observability/logger.js";
import { configWriteFlow, requireWriteGuards, type ConfigHttpResponse } from "./config.js";

/** Délai maximal de la sonde `/health` et de `/v1/models` (court, non bloquant). */
export const TTS_PROBE_TIMEOUT_MS = 1_500;
/** Durée de validité du cache de la sonde utilisée par `/health`. */
export const TTS_PROBE_CACHE_TTL_MS = 5_000;
/** Nombre maximal de fichiers listés dans le diagnostic disque. */
export const TTS_MODELS_MAX_FILES = 50;
/** Longueur maximale du texte de test de synthèse. */
export const TTS_TEST_MAX_CHARS = 500;
/** Phrase par défaut du test de synthèse (et de l'aperçu de voix). */
export const DEFAULT_TTS_TEST_TEXT = "Bonjour, voici un aperçu de la voix.";

/** État synthétique du moteur, exploitable directement par l'UI. */
export type TtsState = "off" | "unreachable" | "starting" | "ready" | "error";

/** Résultat BRUT d'une sonde `/health` (avant composition avec la config). */
export interface TtsProbeRaw {
  reachable: boolean;
  /** `true`/`false` = préparation explicite ; `null` = indéterminable. */
  ready: boolean | null;
  modelCount: number | null;
  latencyMs: number | null;
  /** Uniquement une VRAIE erreur (HTTP ≠ 2xx ou champ d'erreur explicite). */
  error: string | null;
  /** Horodatage de la mesure (`0` = jamais mesuré). */
  at: number;
  /** Corps brut borné de `/health` (pour figer la forme réelle plus tard). */
  payload: string | null;
  /** Clés de premier niveau du JSON (bornées), journalisées une fois par forme. */
  shapeKeys: string[];
}

/** Rapport public de `GET /api/tts/status`. */
export interface TtsEngineReport {
  enabled: boolean;
  reachable: boolean;
  ready: boolean | null;
  modelCount: number | null;
  engine: string;
  baseUrl: string;
  latencyMs: number | null;
  error: string | null;
  state: TtsState;
  /** Horodatage ISO de la mesure, ou `null` si jamais mesuré. */
  measuredAt: string | null;
  /** Corps brut borné de `/health` (transparence : jamais interprété à tort). */
  payload: string | null;
  /** `true` si « prêt » a été DÉDUIT (modèles listés) faute de préparation explicite. */
  readinessInferred: boolean;
  /** Origine du nombre de modèles exposé (`health` ou `models`), sinon `null`. */
  modelCountSource: "health" | "models" | null;
  /** Explication honnête de la décision d'état (déduction / indétermination). */
  readinessNote: string | null;
  /**
   * Nombre d'entrées DÉCLARÉES dans `server.json` (lecture seule, `null` si la
   * configuration du moteur n'est pas câblée). Sert à l'assistant pour orienter
   * le diagnostic quand le moteur est injoignable — jamais une cause inventée.
   */
  declaredModelCount?: number | null;
  /**
   * Nombre d'entrées déclarées dont la famille ne correspond PAS au fichier
   * reconnu par le catalogue (`null` si non calculable).
   */
  declaredModelsIncoherent?: number | null;
}

export interface TtsModelEntry {
  id: string;
  task: string | null;
}

/** Rapport public de `GET /api/tts/models`. */
export interface TtsModelsReport {
  baseUrl: string;
  engine: string;
  reachable: boolean;
  models: TtsModelEntry[];
  count: number | null;
  /** `true` si un modèle correspond à `tts.engine` (heuristique), sinon `null`. */
  enginePresent: boolean | null;
  latencyMs: number | null;
  error: string | null;
}

export interface TtsDiskModelFile {
  name: string;
  size: number;
}

/** Diagnostic du répertoire des modèles (volume `yuki-models`, `rw` gateway / `ro` moteur). */
export interface TtsDiskReport {
  dir: string;
  present: boolean;
  readable: boolean;
  fileCount: number;
  files: TtsDiskModelFile[];
  truncated: boolean;
  error: string | null;
}

/** Fournisseur de synthèse (appel moteur) — injectable pour les tests. */
export interface TtsSynthesizer {
  synthesize(input: {
    text: string;
    voice: Voice | null;
  }): Promise<{
    contentType: string;
    bytes: Buffer;
    /**
     * Chemin `voice_ref` réellement envoyé au moteur (diagnostic), ou `null`.
     * Optionnel : les doublures de test peuvent l'omettre.
     */
    voiceRef?: string | null;
  }>;
}

/**
 * Résolution de l'id configuré (`tts.voice`) en voix à utiliser — MÊME chemin
 * que le pipeline (`VoiceStore.resolveVoice`) : un id **vide ou inconnu**
 * retombe sur la voix **par défaut** du registre, `null` = aucune voix.
 */
export interface TtsVoiceResolver {
  get(id: string): Voice | null;
}

/** Accès minimal à la configuration (`tts.*`). */
export interface TtsConfigPort {
  getString(path: string): string;
  getNumber(path: string): number;
}

/**
 * Port de la configuration STRUCTURÉE du moteur (Lot 9). L'implémentation
 * concrète (`EngineConfigStore` + `EngineCapabilitiesProbe`) est câblée dans
 * `src/index.ts` ; les tests peuvent injecter une doublure.
 */
export interface EngineConfigPort {
  report(): EngineConfigReport;
  applyPatch(patch: unknown): EngineConfigReport;
  revert(): EngineConfigReport;
  capabilities(): Promise<EngineCapabilitiesReport>;
}

/**
 * Port du TÉLÉCHARGEMENT des modèles (Lot 9, étape 2). L'implémentation
 * concrète (`TtsDownloadManager`) est câblée dans `src/index.ts` ; les tests
 * peuvent injecter une doublure.
 */
export interface TtsDownloadsPort {
  /** Catalogue FERMÉ (données serveur ; jamais fourni par le client). */
  catalogEntries(): readonly CatalogEntry[];
  /** Moteurs écartés et pourquoi (jamais retirés silencieusement). */
  notIncluded(): readonly CatalogRejection[];
  list(): DownloadTask[];
  get(catalogId: string): DownloadTask | undefined;
  hasActive(): boolean;
  activeId(): string | null;
  start(catalogId: string): Promise<DownloadTask>;
  cancel(catalogId: string): DownloadTask;
  gatewayPathFor(catalogId: string): string;
  enginePathFor(catalogId: string): string;
}

/** Vue publique d'une entrée de catalogue, enrichie de l'état LOCAL. */
export interface TtsCatalogItemView {
  id: string;
  label: string;
  repo: string;
  dir: string;
  variant: string;
  family: string;
  task: string;
  mode: string;
  license: string;
  licenseAllowed: boolean;
  expectedFile: string;
  expectedBytes: number;
  expectedSha256: string | null;
  /** Chemin de destination VU PAR LE MOTEUR. */
  enginePath: string;
  /** Chemin de destination VU PAR LE GATEWAY. */
  gatewayPath: string;
  installed: boolean;
  installedBytes: number | null;
  declared: boolean;
  declaredPath: string | null;
  /** Champs EXACTS à envoyer à `PUT /api/tts/engine-config` (pré-remplissage). */
  prefill: { id: string; family: string; task: string; mode: string; path: string };
  download: DownloadTask | null;
}

export interface TtsApiDeps {
  config: TtsConfigPort;
  logger: Logger;
  voices: TtsVoiceResolver;
  /** Sonde d'état du moteur (cache court + timeout court). */
  diagnostics: TtsDiagnostics;
  /** Répertoire des modèles tel que monté dans le gateway (`/models`). */
  modelsDir: string;
  /** Optionnel : sans lui, `POST /api/tts/test` répond 503. */
  synth?: TtsSynthesizer;
  /** Optionnel : sans lui, les routes `engine-config`/`capabilities` répondent 503. */
  engineConfig?: EngineConfigPort;
  /** Optionnel : sans lui, les routes `catalog`/`downloads` répondent 503. */
  downloads?: TtsDownloadsPort;
}

export interface TtsRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  deps: TtsApiDeps;
}

const JSON_HEADERS: Record<string, string> = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(status: number, body: unknown): ConfigHttpResponse {
  return { status, body, headers: JSON_HEADERS };
}

function binary(
  status: number,
  body: Buffer,
  contentType: string,
  extra?: Record<string, string>,
): ConfigHttpResponse {
  return {
    status,
    body,
    headers: {
      "content-type": contentType,
      "cache-control": "no-store",
      ...(extra ?? {}),
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

/** Lit un corps de réponse borné (jamais bloquant). */
async function readBounded(
  response: Response,
  limit: number,
): Promise<string> {
  try {
    const text = (await response.text()).trim();
    if (text.length === 0) return "";
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return "";
  }
}

/* ─── Lecture TOLÉRANTE de `/health` ─────────────────────────────────────────
 * La forme réelle de `/health` est INCONNUE (l'archive qui donnait
 * `{ ready, model_count }` est démentie par l'exécution). Ces helpers acceptent
 * les variantes raisonnables SANS jamais inventer : un champ absent, d'un type
 * inattendu ou incompris reste « indéterminé » — JAMAIS « erreur ».
 */

/** Tokens de préparation reconnus comme POSITIFS (moteur prêt). */
const TTS_READY_POSITIVE = new Set([
  "true", "1", "yes", "y", "on", "up", "ready", "ok", "available",
  "healthy", "live", "loaded", "done", "complete", "completed",
  "success", "succeeded", "initialized", "initialised",
]);

/** Tokens de préparation reconnus comme NÉGATIFS (pas encore prêt). */
const TTS_READY_NEGATIVE = new Set([
  "false", "0", "no", "n", "off", "down", "starting", "start", "loading",
  "load", "initializing", "initialising", "pending", "warming", "warmup",
  "not_ready", "unavailable", "offline", "disabled", "idle", "booting",
  "queued",
]);

/** Tokens signalant une VRAIE erreur moteur (preuve d'échec explicite). */
const TTS_READY_ERROR = new Set([
  "error", "errored", "failed", "failure", "fatal", "unhealthy", "broken",
  "crash", "crashed",
]);

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Convertit une valeur en compteur entier ≥ 0 (sinon `null`, jamais d'exception). */
function toCountValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const n = Number(value.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Interprète un champ de préparation : `true`/`false`, ou `null` si inconnu. */
function readReadinessValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const token = normalizeToken(value);
    if (token.length === 0) return null;
    if (TTS_READY_POSITIVE.has(token)) return true;
    if (TTS_READY_NEGATIVE.has(token)) return false;
  }
  return null;
}

/**
 * Lit l'état de préparation d'une réponse `/health` en acceptant les variantes
 * (`ready` booléen/chaîne/nombre, `ok`, `success`, `status`, `state`).
 * `null` = indéterminable (jamais une erreur).
 */
function readReadiness(record: Record<string, unknown>): boolean | null {
  for (const key of ["ready", "readyState", "ok", "success"]) {
    if (key in record) {
      const value = readReadinessValue(record[key]);
      if (value !== null) return value;
    }
  }
  for (const key of ["status", "state"]) {
    if (key in record) {
      const value = readReadinessValue(record[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

/** Lit le nombre de modèles depuis `/health` (variantes tolérées). */
function readModelCount(record: Record<string, unknown>): number | null {
  for (const key of [
    "model_count",
    "modelCount",
    "models_total",
    "modelsTotal",
    "models_loaded",
    "loaded_models",
    "loadedModels",
    "count",
  ]) {
    if (key in record) {
      const value = toCountValue(record[key]);
      if (value !== null) return value;
    }
  }
  if ("models" in record) {
    const value = record.models;
    if (Array.isArray(value)) return value.length;
    const count = toCountValue(value);
    if (count !== null) return count;
  }
  return null;
}

/** Tronque un texte borné (jamais de payload illisible en entier). */
function bounded(value: string, limit = 200): string {
  const trimmed = value.trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * Détecte une VRAIE erreur signalée par le moteur dans une réponse 2xx.
 * **Strict** : seul un champ d'erreur explicite, ou un `status`/`state`
 * d'échec, déclenche l'erreur — un champ absent ou incompris n'en est JAMAIS
 * une. C'est la 2ᵉ source de preuve après « HTTP ≠ 2xx ».
 */
function readEngineError(record: Record<string, unknown>): string | null {
  for (const key of ["error", "error_message", "errorMessage", "last_error"]) {
    if (!(key in record)) continue;
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return `Le moteur signale une erreur : ${bounded(value)}`;
    }
    if (value && typeof value === "object") {
      return `Le moteur signale une erreur : ${bounded(JSON.stringify(value))}`;
    }
    if (value === true) return "Le moteur signale une erreur.";
  }
  for (const key of ["status", "state"]) {
    const value = record[key];
    if (typeof value === "string" && TTS_READY_ERROR.has(normalizeToken(value))) {
      return `Le moteur signale un état « ${bounded(value, 60)} ».`;
    }
  }
  return null;
}

export interface TtsProbeOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  now: () => number;
  logger?: Logger;
}

/**
 * Sonde `GET {baseUrl}/health` avec timeout court. **N'échoue jamais** : toute
 * erreur devient un état `reachable:false` + `error` lisible. Un code HTTP
 * d'erreur est remonté AVEC le corps de la réponse (transparence).
 */
export async function probeTtsHealth(options: TtsProbeOptions): Promise<TtsProbeRaw> {
  const url = `${trimBaseUrl(options.baseUrl)}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  timer.unref?.();
  const t0 = options.now();
  try {
    const response = await options.fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const latencyMs = Math.max(0, options.now() - t0);
    const body = await readBounded(response, 1_000);
    if (!response.ok) {
      // Preuve d'erreur n°1 : HTTP ≠ 2xx.
      return {
        reachable: true,
        ready: null,
        modelCount: null,
        latencyMs,
        error: `Le moteur a répondu ${response.status}${body ? ` : ${body}` : ""}`,
        at: options.now(),
        payload: body.length > 0 ? body : null,
        shapeKeys: [],
      };
    }
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = null;
    }
    const record =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    if (record === null) {
      // 2xx mais corps vide / non-JSON / HTML : ce n'est PAS une erreur, c'est
      // une forme INCONNUE. On reste honnête : préparation indéterminée, et on
      // conserve le corps brut pour l'analyser plus tard.
      return {
        reachable: true,
        ready: null,
        modelCount: null,
        latencyMs,
        error: null,
        at: options.now(),
        payload: body.length > 0 ? body : null,
        shapeKeys: [],
      };
    }
    const shapeKeys = Object.keys(record).slice(0, 64);
    const engineError = readEngineError(record);
    return {
      reachable: true,
      ready: engineError ? null : readReadiness(record),
      modelCount: readModelCount(record),
      latencyMs,
      error: engineError,
      at: options.now(),
      payload: body.length > 0 ? body : null,
      shapeKeys,
    };
  } catch (error) {
    const latencyMs = Math.max(0, options.now() - t0);
    if (controller.signal.aborted) {
      return {
        reachable: false,
        ready: null,
        modelCount: null,
        latencyMs,
        error: `Délai dépassé (${options.timeoutMs} ms) vers ${url}.`,
        at: options.now(),
        payload: null,
        shapeKeys: [],
      };
    }
    options.logger?.debug("tts.probe.failed", { url, error: messageOf(error) });
    return {
      reachable: false,
      ready: null,
      modelCount: null,
      latencyMs,
      error: messageOf(error),
      at: options.now(),
      payload: null,
      shapeKeys: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

function emptyProbe(): TtsProbeRaw {
  return {
    reachable: false,
    ready: null,
    modelCount: null,
    latencyMs: null,
    error: null,
    at: 0,
    payload: null,
    shapeKeys: [],
  };
}

/**
 * Dérive l'état synthétique.
 *
 * Règle : **jamais d'« erreur » sur un champ absent ou incompris** ; jamais de
 * « prêt » sans preuve. Priorité :
 *   1. désactivé → `off` ;
 *   2. injoignable → `unreachable` ;
 *   3. erreur Prouvée (HTTP ≠ 2xx, champ d'erreur explicite) → `error` ;
 *   4. préparation explicitement négative (`ready:false`, `"starting"`) → `starting` ;
 *   5. aucun modèle lisible (`0` côté `/health` ou `/v1/models`) → `error` ;
 *   6. préparation explicite positive, OU indéterminable mais avec des modèles
 *      listés → `ready` (déduction signalée par `readinessInferred`) ;
 *   7. joignable mais tout est indéterminé → `starting` (jamais « erreur », et
 *      jamais « prêt » sans preuve).
 */
export function deriveTtsState(
  probe: TtsProbeRaw,
  enabled: boolean,
  engineModels: number | null = null,
): TtsState {
  if (!enabled) return "off";
  if (!probe.reachable) return "unreachable";
  if (probe.error) return "error";
  const modelCount = probe.modelCount !== null ? probe.modelCount : engineModels;
  if (probe.ready === false) return "starting";
  if (modelCount === 0) return "error";
  if (probe.ready === true) return "ready";
  if (modelCount !== null && modelCount > 0) return "ready";
  return "starting";
}

/** Explication honnête d'une décision d'état (déduction ou indétermination). */
function composeReadinessNote(
  state: TtsState,
  probe: TtsProbeRaw,
  modelCount: number | null,
  readinessInferred: boolean,
): string | null {
  if (state === "ready" && readinessInferred) {
    const plural = modelCount !== null && modelCount > 1 ? "modèles" : "modèle";
    const detail = modelCount !== null ? ` (${modelCount} ${plural} listé)` : "";
    return `Préparation déduite : /health ne l'expose pas explicitement${detail}.`;
  }
  if (state === "error" && probe.error === null) {
    return (
      "Aucun modèle lisible (ni /health, ni /v1/models) : la synthèse ne peut " +
      "pas aboutir."
    );
  }
  if (state === "starting" && probe.ready === null && probe.error === null) {
    return (
      "Préparation non exposée par /health et aucun modèle lisible : par " +
      "prudence, l'état reste « démarrage » — jamais « erreur » sur un champ absent."
    );
  }
  return null;
}

/** Normalise un nom de moteur/modèle pour la comparaison (heuristique). */
function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[\s_]+/g, "-").trim();
}

/**
 * Heuristique de correspondance modèle ↔ moteur. Le contrat `audio.cpp`
 * n'atteste PAS que l'`id` de `GET /v1/models` soit exactement le nom de
 * famille (`chatterbox`) : on accepte donc l'égalité OU l'inclusion, ce qui
 * couvre `chatterbox`, `chatterbox-multilingual`, etc. (à confirmer en réel).
 */
export function modelMatchesEngine(id: string, engine: string): boolean {
  const a = normalizeName(id);
  const b = normalizeName(engine);
  if (a.length === 0 || b.length === 0) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function extractModels(parsed: unknown): TtsModelEntry[] | null {
  let raw: unknown;
  if (Array.isArray(parsed)) raw = parsed;
  else if (parsed && typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.data)) raw = record.data;
    else if (Array.isArray(record.models)) raw = record.models;
    else return null;
  } else {
    return null;
  }
  const out: TtsModelEntry[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item === "string") {
      out.push({ id: item, task: null });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const id =
      typeof record.id === "string"
        ? record.id
        : typeof record.name === "string"
          ? record.name
          : null;
    if (id === null) continue;
    out.push({ id, task: typeof record.task === "string" ? record.task : null });
  }
  return out;
}

/**
 * Cache de la sonde d'état.
 *
 * **Choix de performance** : `/health` ne doit jamais ajouter le délai de
 * sonde (jusqu'à `TTS_PROBE_TIMEOUT_MS`). On utilise donc :
 *   1. un cache à TTL court (`TTS_PROBE_CACHE_TTL_MS`, 5 s) ;
 *   2. un rafraîchissement **en tâche de fond** : `cachedStatus()` renvoie
 *      TOUJOURS immédiatement la dernière valeur connue, et déclenche un
 *      `refresh()` non attendu si le cache est périmé ;
 *   3. une déduplication : une seule sonde en vol à la fois (`inflight`).
 *
 * `status()` expose au contraire la sonde **fraîche** (attendue, bornée), pour
 * la route dédiée `/api/tts/status` (diagnostic explicite).
 */
export interface TtsDiagnosticsConfig {
  enabled(): boolean;
  engine(): string;
  baseUrl(): string;
}

export interface TtsDiagnosticsOptions {
  timeoutMs?: number;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

export class TtsDiagnostics {
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly logger?: Logger;
  private last: TtsProbeRaw | null = null;
  /** Dernière liste `/v1/models` connue (sert à DÉDUIRE « prêt » sans preuve /health). */
  private lastModels: TtsModelsReport | null = null;
  private lastAt = 0;
  private inflight: Promise<TtsProbeRaw> | null = null;
  /** Signatures de formes `/health` déjà journalisées (log UNE fois par forme). */
  private readonly loggedShapes = new Set<string>();

  constructor(
    private readonly config: TtsDiagnosticsConfig,
    options: TtsDiagnosticsOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? TTS_PROBE_TIMEOUT_MS;
    this.ttlMs = options.ttlMs ?? TTS_PROBE_CACHE_TTL_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.logger = options.logger;
  }

  private probe(): Promise<TtsProbeRaw> {
    return probeTtsHealth({
      baseUrl: this.config.baseUrl(),
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
      now: this.now,
      ...(this.logger ? { logger: this.logger } : {}),
    });
  }

  /**
   * Sonde FRAÎCHE (attendue, bornée par `timeoutMs`). Interroge `/health` ET
   * `/v1/models` (en parallèle) : la liste des modèles permet de DÉDUIRE « prêt »
   * quand `/health` n'expose pas explicitement sa préparation. Aucune des deux
   * sondes ne lève.
   */
  refresh(): Promise<TtsProbeRaw> {
    if (this.inflight) return this.inflight;
    const pending = Promise.all([this.probe(), this.models()]).then(
      ([raw, models]) => {
        this.last = raw;
        this.lastModels = models;
        this.lastAt = this.now();
        this.inflight = null;
        this.logHealthShape(raw);
        return raw;
      },
      (error: unknown) => {
        this.inflight = null;
        throw error;
      },
    );
    this.inflight = pending;
    return pending;
  }

  /**
   * Journalise UNE FOIS par forme le corps brut borné de `/health` et la liste
   * de ses clés de premier niveau. Objectif : **figer la forme exacte** dès
   * qu'un relevé réel sera disponible, sans spammer (dédup par signature) et
   * sans jamais prétendre connaître le schéma. Jamais d'état, jamais de secret
   * (le corps de `/health` ne contient pas de clé d'API).
   */
  private logHealthShape(probe: TtsProbeRaw): void {
    if (!this.logger || !probe.reachable || probe.shapeKeys.length === 0) return;
    const signature = probe.shapeKeys.join(",");
    if (this.loggedShapes.has(signature)) return;
    if (this.loggedShapes.size >= 20) return;
    this.loggedShapes.add(signature);
    this.logger.debug("tts.health.shape", {
      keys: probe.shapeKeys,
      payload: probe.payload ? bounded(probe.payload, 500) : null,
    });
  }

  /** Compose un rapport public à partir d'une sonde brute. */
  private compose(probe: TtsProbeRaw): TtsEngineReport {
    const enabled = this.config.enabled();
    const engineModels =
      this.lastModels && this.lastModels.reachable ? this.lastModels.count : null;
    const modelCount = probe.modelCount !== null ? probe.modelCount : engineModels;
    const state = deriveTtsState(probe, enabled, engineModels);
    const readinessInferred = state === "ready" && probe.ready === null;
    return {
      enabled,
      reachable: probe.reachable,
      ready: probe.ready,
      modelCount,
      engine: this.config.engine(),
      baseUrl: this.config.baseUrl(),
      latencyMs: probe.latencyMs,
      error: probe.error,
      state,
      measuredAt: probe.at > 0 ? new Date(probe.at).toISOString() : null,
      payload: probe.payload,
      readinessInferred,
      modelCountSource:
        probe.modelCount !== null ? "health" : engineModels !== null ? "models" : null,
      readinessNote: composeReadinessNote(state, probe, modelCount, readinessInferred),
    };
  }

  /** Rapport FRAIS (attend la sonde). Utilisé par `/api/tts/status`. */
  async status(): Promise<TtsEngineReport> {
    return this.compose(await this.refresh());
  }

  /**
   * Rapport EN CACHE (synchrone, jamais bloquant). Utilisé par `/health`.
   * Déclenche une sonde de fond si le cache est périmé (sans l'attendre).
   */
  cachedStatus(): TtsEngineReport {
    if (this.last === null || this.now() - this.lastAt >= this.ttlMs) {
      void this.refresh().catch(() => {
        // La sonde de fond ne doit jamais faire échouer `/health`.
      });
    }
    return this.compose(this.last ?? emptyProbe());
  }

  /** Liste des modèles du moteur (`GET /v1/models`), jamais bloquante. */
  async models(): Promise<TtsModelsReport> {
    const baseUrl = trimBaseUrl(this.config.baseUrl());
    const engine = this.config.engine();
    const url = `${baseUrl}/v1/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();
    const t0 = this.now();
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      const latencyMs = Math.max(0, this.now() - t0);
      const body = await readBounded(response, 4_000);
      if (!response.ok) {
        return {
          baseUrl,
          engine,
          reachable: true,
          models: [],
          count: null,
          enginePresent: null,
          latencyMs,
          error: `Le moteur a répondu ${response.status}${body ? ` : ${body}` : ""}`,
        };
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const models = extractModels(parsed);
      if (models === null) {
        return {
          baseUrl,
          engine,
          reachable: true,
          models: [],
          count: null,
          enginePresent: null,
          latencyMs,
          error: `Réponse /v1/models illisible${body ? ` : ${body}` : ""}`,
        };
      }
      return {
        baseUrl,
        engine,
        reachable: true,
        models,
        count: models.length,
        enginePresent: models.some((model) => modelMatchesEngine(model.id, engine)),
        latencyMs,
        error: null,
      };
    } catch (error) {
      const latencyMs = Math.max(0, this.now() - t0);
      const detail = controller.signal.aborted
        ? `Délai dépassé (${this.timeoutMs} ms) vers ${url}.`
        : messageOf(error);
      this.logger?.debug("tts.models.failed", { url, error: detail });
      return {
        baseUrl,
        engine,
        reachable: false,
        models: [],
        count: null,
        enginePresent: null,
        latencyMs,
        error: detail,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Inspecte le répertoire des modèles (volume monté `ro`). **Robuste** :
 * répertoire absent, vide ou illisible = état normal (jamais une exception).
 */
export function inspectModelsDir(dir: string): TtsDiskReport {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    const absent = code === "ENOENT" || code === "ENOTDIR";
    return {
      dir,
      present: !absent,
      readable: false,
      fileCount: 0,
      files: [],
      truncated: false,
      error: absent ? null : messageOf(error),
    };
  }

  const files: TtsDiskModelFile[] = [];
  let total = 0;
  let truncated = false;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    total += 1;
    if (files.length >= TTS_MODELS_MAX_FILES) {
      truncated = true;
      continue;
    }
    let size = 0;
    try {
      size = statSync(join(dir, entry.name)).size;
    } catch {
      size = 0;
    }
    files.push({ name: entry.name, size });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return {
    dir,
    present: true,
    readable: true,
    fileCount: total,
    files,
    truncated,
    error: null,
  };
}

/**
 * Résumé de la configuration DÉCLARÉE (lecture seule) pour l'assistant :
 * nombre d'entrées et combien ont une famille incohérente avec leur fichier
 * reconnu. `null` si la configuration du moteur n'est pas câblée ou illisible —
 * jamais une cause inventée : ces nombres ne servent qu'à ORIENTER l'utilisateur.
 */
function declaredModelsSummary(deps: TtsApiDeps): {
  declaredModelCount: number | null;
  declaredModelsIncoherent: number | null;
} {
  if (!deps.engineConfig) {
    return { declaredModelCount: null, declaredModelsIncoherent: null };
  }
  try {
    const models = deps.engineConfig.report().models;
    return {
      declaredModelCount: models.length,
      declaredModelsIncoherent: models.filter(
        (model) => model.coherenceIssues.length > 0,
      ).length,
    };
  } catch (error) {
    deps.logger.warn("tts.status.declared_failed", { error: messageOf(error) });
    return { declaredModelCount: null, declaredModelsIncoherent: null };
  }
}

async function handleStatus(deps: TtsApiDeps): Promise<ConfigHttpResponse> {
  // 200 GARANTI : la route de diagnostic n'échoue jamais et n'est jamais
  // bloquante (sondes bornées par timeout, cache court).
  const declared = declaredModelsSummary(deps);
  try {
    const report = await deps.diagnostics.status();
    return json(200, {
      ...report,
      ...declared,
      modelsDir: inspectModelsDir(deps.modelsDir),
    });
  } catch (error) {
    deps.logger.warn("tts.status.failed", { error: messageOf(error) });
    const enabled = deps.config.getString("tts.enabled") === "on";
    return json(200, {
      enabled,
      reachable: false,
      ready: null,
      modelCount: null,
      engine: deps.config.getString("tts.engine"),
      baseUrl: deps.config.getString("tts.baseUrl"),
      latencyMs: null,
      error: null,
      state: enabled ? "unreachable" : "off",
      measuredAt: null,
      payload: null,
      readinessInferred: false,
      modelCountSource: null,
      readinessNote: null,
      ...declared,
      modelsDir: inspectModelsDir(deps.modelsDir),
    });
  }
}

async function handleModels(deps: TtsApiDeps): Promise<ConfigHttpResponse> {
  return json(200, await deps.diagnostics.models());
}

/* ─── Configuration structurée du moteur (Lot 9) ─────────────────────────────
 * Le navigateur envoie un PATCH STRUCTURÉ ({ globals?, models? }) ; jamais un
 * `server.json` complet. Toute écriture passe par les garde-fous existants
 * (`X-Yuki-Config: 1` + même origine).
 */

function engineConfigUnavailable(): ConfigHttpResponse {
  return json(503, {
    error: "engine_config_unavailable",
    code: "engine_config_unavailable",
    message: "La configuration du moteur n'est pas câblée dans ce gateway.",
  });
}

function handleEngineConfigGet(deps: TtsApiDeps): ConfigHttpResponse {
  if (!deps.engineConfig) return engineConfigUnavailable();
  // 200 GARANTI : un état « non monté » est un cas normal, pas une erreur.
  return json(200, deps.engineConfig.report());
}

/** Mappe une erreur de configuration du moteur vers une réponse HTTP précise. */
function engineConfigErrorResponse(error: unknown, deps: TtsApiDeps): ConfigHttpResponse {
  if (error instanceof EngineConfigError) {
    deps.logger.warn("tts.engine_config.refused", { code: error.code, status: error.status });
    return json(error.status, {
      error: error.code,
      code: error.code,
      message: error.message,
      ...(error.fields.length > 0 ? { fields: error.fields } : {}),
    });
  }
  deps.logger.error("tts.engine_config.failed", { error: messageOf(error) });
  return json(500, {
    error: "engine_config_failed",
    code: "engine_config_failed",
    message: "L'opération sur la configuration du moteur a échoué.",
  });
}

/** Nombre maximal d'entrées `models[]` journalisées (contenu BORNÉ). */
const ENGINE_CONFIG_LOG_LIMIT = 32;

/** Vrai pour un objet JSON simple (jamais un tableau ni `null`). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Résumé BORNÉ du patch d'écriture du moteur, pour le journal de diagnostic.
 * Objectif : si l'entrée famille-écrasée se reproduit, savoir QUELLE action l'a
 * écrite ET avec quel contenu (id/family/task/mode/path par entrée). Aucune
 * donnée sensible ; jamais le document complet.
 */
function summarizeEngineConfigPatch(patch: unknown): Record<string, unknown> {
  if (!isPlainObject(patch)) return { patchKind: typeof patch };
  const summary: Record<string, unknown> = {};
  if (Array.isArray(patch.models)) {
    const models = patch.models;
    summary.modelCount = models.length;
    summary.models = models.slice(0, ENGINE_CONFIG_LOG_LIMIT).map((entry) =>
      isPlainObject(entry)
        ? {
            id: typeof entry.id === "string" ? entry.id : null,
            family: typeof entry.family === "string" ? entry.family : null,
            task: typeof entry.task === "string" ? entry.task : null,
            mode: typeof entry.mode === "string" ? entry.mode : null,
            path: typeof entry.path === "string" ? entry.path : null,
          }
        : { invalid: true },
    );
    if (models.length > ENGINE_CONFIG_LOG_LIMIT) summary.modelsTruncated = true;
  } else if (patch.models !== undefined) {
    summary.models = "invalid";
  }
  if (isPlainObject(patch.globals)) {
    summary.globalKeys = Object.keys(patch.globals).slice(0, ENGINE_CONFIG_LOG_LIMIT);
  } else if (patch.globals !== undefined) {
    summary.globals = "invalid";
  }
  return summary;
}

function handleEngineConfigPut(input: TtsRequestInput): ConfigHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  if (!input.deps.engineConfig) return engineConfigUnavailable();
  const flow = configWriteFlow(input.headers);
  let patch: unknown;
  try {
    patch = input.body.length === 0 ? {} : JSON.parse(input.body.toString("utf8"));
  } catch {
    input.deps.logger.warn("tts.engine_config.write", { flow, action: "put", result: "invalid_json" });
    return json(400, {
      error: "invalid_json",
      code: "invalid_json",
      message: "Corps JSON invalide (objet { globals?, models? } attendu).",
      fields: [{ path: "", code: "invalid_json", message: "Corps JSON invalide." }],
    });
  }
  try {
    const report = input.deps.engineConfig.applyPatch(patch);
    input.deps.logger.info("tts.engine_config.write", {
      flow,
      action: "put",
      result: "accepted",
      ...summarizeEngineConfigPatch(patch),
    });
    return json(200, report);
  } catch (error) {
    input.deps.logger.warn("tts.engine_config.write", {
      flow,
      action: "put",
      result: "refused",
      code: error instanceof EngineConfigError ? error.code : "engine_config_failed",
      error: messageOf(error),
      ...summarizeEngineConfigPatch(patch),
    });
    return engineConfigErrorResponse(error, input.deps);
  }
}

function handleEngineConfigRevert(input: TtsRequestInput): ConfigHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  if (!input.deps.engineConfig) return engineConfigUnavailable();
  const flow = configWriteFlow(input.headers);
  try {
    const report = input.deps.engineConfig.revert();
    input.deps.logger.info("tts.engine_config.write", {
      flow,
      action: "revert",
      result: "accepted",
    });
    return json(200, report);
  } catch (error) {
    input.deps.logger.warn("tts.engine_config.write", {
      flow,
      action: "revert",
      result: "refused",
      code: error instanceof EngineConfigError ? error.code : "engine_config_failed",
      error: messageOf(error),
    });
    return engineConfigErrorResponse(error, input.deps);
  }
}

async function handleCapabilities(deps: TtsApiDeps): Promise<ConfigHttpResponse> {
  if (!deps.engineConfig) return engineConfigUnavailable();
  try {
    return json(200, await deps.engineConfig.capabilities());
  } catch (error) {
    deps.logger.warn("tts.capabilities.failed", { error: messageOf(error) });
    return json(200, {
      reachable: false,
      baseUrl: deps.config.getString("tts.baseUrl"),
      route: "/v1/tasks/unload_models",
      method: "POST",
      unloadModels: null,
      probeStatus: null,
      probeBody: null,
      detail: null,
      measuredAt: null,
    });
  }
}

/* ─── Catalogue + téléchargement des modèles (Lot 9, étape 2) ───────────────
 * Backend SEUL : aucune UI. Le client n'envoie jamais d'URL, seulement un
 * identifiant de catalogue. Toute écriture passe par les mêmes garde-fous que
 * le reste (`X-Yuki-Config: 1` + même origine).
 */

function downloadsUnavailable(): ConfigHttpResponse {
  return json(503, {
    error: "downloads_unavailable",
    code: "downloads_unavailable",
    message: "Le téléchargement des modèles n'est pas câblé dans ce gateway.",
  });
}

/** Mappe une erreur de téléchargement vers une réponse HTTP précise. */
function downloadErrorResponse(error: unknown, deps: TtsApiDeps): ConfigHttpResponse {
  if (error instanceof TtsDownloadError) {
    deps.logger.warn("tts.download.refused", { code: error.code, status: error.status });
    return json(error.status, {
      error: error.code,
      code: error.code,
      message: error.message,
    });
  }
  deps.logger.error("tts.download.failed", { error: messageOf(error) });
  return json(500, {
    error: "download_failed",
    code: "download_failed",
    message: "L'opération de téléchargement a échoué.",
  });
}

/**
 * Compose l'état LOCAL d'une entrée de catalogue : déjà téléchargée ? présente
 * sur le disque ? déjà déclarée dans `server.json` ? + de quoi PRÉ-REMPLIR
 * l'éditeur de configuration existant.
 */
function catalogItemView(
  entry: CatalogEntry,
  downloads: TtsDownloadsPort,
  declaredById: Map<string, string>,
): TtsCatalogItemView {
  const enginePath = downloads.enginePathFor(entry.id);
  const gatewayPath = downloads.gatewayPathFor(entry.id);
  let installed = false;
  let installedBytes: number | null = null;
  try {
    const info = statSync(gatewayPath);
    if (info.isFile()) {
      installed = true;
      installedBytes = info.size;
    }
  } catch {
    installed = false;
  }
  const declaredPath = declaredById.get(entry.id) ?? null;
  return {
    id: entry.id,
    label: entry.label,
    repo: entry.repo,
    dir: entry.dir,
    variant: entry.variant,
    family: entry.family,
    task: entry.task,
    mode: entry.mode,
    license: entry.license,
    licenseAllowed: isAllowedLicense(entry.license),
    expectedFile: entry.recommendedFile,
    expectedBytes: entry.approxBytes,
    expectedSha256: entry.sha256,
    enginePath,
    gatewayPath,
    installed,
    installedBytes,
    declared: declaredPath !== null,
    declaredPath,
    // Champs EXACTS attendus par `PUT /api/tts/engine-config` (pré-remplissage).
    prefill: { id: entry.id, family: entry.family, task: entry.task, mode: entry.mode, path: enginePath },
    download: downloads.get(entry.id) ?? null,
  };
}

function handleCatalog(deps: TtsApiDeps): ConfigHttpResponse {
  const downloads = deps.downloads;
  if (!downloads) return downloadsUnavailable();
  let declaredById = new Map<string, string>();
  let engineConfigAvailable = false;
  if (deps.engineConfig) {
    try {
      const report = deps.engineConfig.report();
      engineConfigAvailable = true;
      declaredById = new Map(report.models.map((model) => [model.id, model.path]));
    } catch (error) {
      deps.logger.warn("tts.catalog.engine_config_failed", { error: messageOf(error) });
    }
  }
  const entries = downloads
    .catalogEntries()
    .map((entry) => catalogItemView(entry, downloads, declaredById));
  return json(200, {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    entries,
    notIncluded: downloads.notIncluded(),
    engineConfigAvailable,
    note:
      "Catalogue fermé côté serveur : l'URL n'est jamais fournie par le client. " +
      "`prefill` contient les champs exacts à envoyer à l'éditeur de configuration.",
  });
}

function handleDownloadsList(deps: TtsApiDeps): ConfigHttpResponse {
  const downloads = deps.downloads;
  if (!downloads) return downloadsUnavailable();
  return json(200, {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    active: downloads.activeId(),
    tasks: downloads.list(),
  });
}

/** Extrait `{catalogId}` du corps JSON (objet strict). */
function parseCatalogId(
  body: Buffer,
): { ok: true; catalogId: string } | { ok: false; response: ConfigHttpResponse } {
  let parsed: unknown;
  try {
    parsed = body.length === 0 ? {} : JSON.parse(body.toString("utf8"));
  } catch {
    return {
      ok: false,
      response: json(400, {
        error: "invalid_json",
        code: "invalid_json",
        message: "Corps JSON invalide (objet { catalogId } attendu).",
      }),
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      response: json(400, {
        error: "invalid_body",
        code: "invalid_body",
        message: "Objet JSON attendu (champ `catalogId`).",
      }),
    };
  }
  const raw = (parsed as { catalogId?: unknown }).catalogId;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return {
      ok: false,
      response: json(400, {
        error: "invalid_catalog_id",
        code: "invalid_catalog_id",
        message: "Champ `catalogId` requis (chaîne non vide).",
      }),
    };
  }
  return { ok: true, catalogId: raw.trim() };
}

async function handleDownloadsStart(input: TtsRequestInput): Promise<ConfigHttpResponse> {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  if (!input.deps.downloads) return downloadsUnavailable();
  const parsed = parseCatalogId(input.body);
  if (!parsed.ok) return parsed.response;
  try {
    const task = await input.deps.downloads.start(parsed.catalogId);
    // 202 : la tâche est ACCEPTÉE et suivie ; le téléchargement est asynchrone.
    return json(202, { ok: true, accepted: true, task });
  } catch (error) {
    return downloadErrorResponse(error, input.deps);
  }
}

/** Extrait l'identifiant de `/api/tts/downloads/{id}/cancel`. */
export function downloadCancelId(path: string): string | null {
  const prefix = "/api/tts/downloads/";
  const suffix = "/cancel";
  if (!path.startsWith(prefix) || !path.endsWith(suffix)) return null;
  const id = path.slice(prefix.length, path.length - suffix.length);
  return id.length > 0 && !id.includes("/") ? id : null;
}

function handleDownloadsCancel(input: TtsRequestInput): ConfigHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  if (!input.deps.downloads) return downloadsUnavailable();
  const catalogId = downloadCancelId(input.path);
  if (catalogId === null) return json(404, { error: "not_found", path: input.path });
  try {
    return json(200, { ok: true, task: input.deps.downloads.cancel(catalogId) });
  } catch (error) {
    return downloadErrorResponse(error, input.deps);
  }
}

function parseTestText(body: Buffer): string | ConfigHttpResponse {
  if (body.length === 0) return DEFAULT_TTS_TEST_TEXT;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return json(400, {
      error: "invalid_json",
      code: "invalid_json",
      message: "Corps JSON invalide (objet { text } attendu).",
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json(400, {
      error: "invalid_body",
      code: "invalid_body",
      message: "Objet JSON attendu (champ `text` optionnel).",
    });
  }
  const raw = (parsed as { text?: unknown }).text;
  if (raw === undefined || raw === null) return DEFAULT_TTS_TEST_TEXT;
  if (typeof raw !== "string") {
    return json(400, {
      error: "invalid_text",
      code: "invalid_text",
      message: "Champ `text` : chaîne de caractères attendue.",
    });
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? DEFAULT_TTS_TEST_TEXT : trimmed;
}

/** Mappe une erreur du moteur vers une réponse HTTP (corps d'erreur inclus). */
function synthesisError(
  error: unknown,
  deps: TtsApiDeps,
  event: string,
): ConfigHttpResponse {
  if (error instanceof VoiceStoreError) {
    // Voix résolue mais référence absente (ou autre erreur métier du registre) :
    // on échoue AVANT le moteur, avec le statut/code portés par l'erreur.
    deps.logger.warn(event, { code: error.code, status: error.status });
    return json(error.status, {
      error: error.code,
      code: error.code,
      message: error.message,
    });
  }
  if (error instanceof AudioCppError) {
    const status =
      error.code === "server_busy" ? 503 : error.code === "timeout" ? 504 : 502;
    deps.logger.warn(event, {
      code: error.code,
      status: error.status,
      ...(error.body ? { engine_body: error.body } : {}),
    });
    return json(status, {
      error: error.code,
      code: error.code,
      message: error.message,
      ...(error.status !== undefined ? { engineStatus: error.status } : {}),
      ...(error.body ? { engineBody: error.body } : {}),
    });
  }
  deps.logger.error(event, { error: messageOf(error) });
  return json(502, {
    error: "synthesis_failed",
    code: "synthesis_failed",
    message: "La synthèse a échoué.",
  });
}

async function handleTest(input: TtsRequestInput): Promise<ConfigHttpResponse> {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  if (!input.deps.synth) {
    return json(503, {
      error: "tts_unavailable",
      code: "tts_unavailable",
      message: "Le service TTS n'est pas disponible.",
    });
  }
  if (input.deps.config.getString("tts.enabled") !== "on") {
    return json(503, {
      error: "tts_disabled",
      code: "tts_disabled",
      message: "TTS désactivé (tts.enabled = off).",
    });
  }
  const outcome = parseTestText(input.body);
  if (typeof outcome !== "string") return outcome;
  if (outcome.length > TTS_TEST_MAX_CHARS) {
    return json(400, {
      error: "text_too_long",
      code: "text_too_long",
      message: `Texte trop long (maximum ${TTS_TEST_MAX_CHARS} caractères).`,
    });
  }

  // Voix active, résolue par le MÊME chemin que le pipeline : le résolveur
  // injecté (`src/index.ts`) est `VoiceStore.resolveVoice` — un id vide ou
  // inconnu retombe sur la voix par défaut du registre (cf. `src/tts/pipeline.ts`).
  const id = input.deps.config.getString("tts.voice").trim();
  const voice = input.deps.voices.get(id);
  try {
    const { contentType, bytes, voiceRef } = await input.deps.synth.synthesize({
      text: outcome,
      voice,
    });
    return binary(200, bytes, contentType || "audio/wav", {
      // Diagnostic honnête : quelle voix et quel moteur ont réellement produit
      // cet échantillon, et quel WAV de référence a été envoyé (`voice_ref`).
      "x-yuki-tts-voice": voice?.id ?? "default",
      "x-yuki-tts-engine": input.deps.config.getString("tts.engine"),
      ...(voiceRef ? { "x-yuki-tts-voice-ref": voiceRef } : {}),
    });
  } catch (error) {
    return synthesisError(error, input.deps, "tts.test.failed");
  }
}

/** Vrai si le chemin relève du diagnostic TTS. */
export function isTtsPath(path: string): boolean {
  if (
    path === "/api/tts/status" ||
    path === "/api/tts/models" ||
    path === "/api/tts/test" ||
    path === "/api/tts/engine-config" ||
    path === "/api/tts/engine-config/revert" ||
    path === "/api/tts/capabilities" ||
    path === "/api/tts/catalog" ||
    path === "/api/tts/downloads"
  ) {
    return true;
  }
  // `/api/tts/downloads/{catalogId}/cancel` : identifiant borné (jamais un chemin).
  return downloadCancelId(path) !== null;
}

/** Traite une requête de diagnostic TTS et renvoie la réponse HTTP. */
export async function handleTtsRequest(
  input: TtsRequestInput,
): Promise<ConfigHttpResponse> {
  const { method, path } = input;
  if (path === "/api/tts/status") {
    if (method === "GET" || method === "HEAD") return handleStatus(input.deps);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/tts/models") {
    if (method === "GET" || method === "HEAD") return handleModels(input.deps);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/tts/test") {
    if (method === "POST") return handleTest(input);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/tts/engine-config") {
    if (method === "GET" || method === "HEAD") return handleEngineConfigGet(input.deps);
    if (method === "PUT") return handleEngineConfigPut(input);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/tts/engine-config/revert") {
    if (method === "POST") return handleEngineConfigRevert(input);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/tts/capabilities") {
    if (method === "GET" || method === "HEAD") return handleCapabilities(input.deps);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/tts/catalog") {
    if (method === "GET" || method === "HEAD") return handleCatalog(input.deps);
    return json(405, { error: "method_not_allowed", method });
  }
  if (path === "/api/tts/downloads") {
    if (method === "GET" || method === "HEAD") return handleDownloadsList(input.deps);
    if (method === "POST") return handleDownloadsStart(input);
    return json(405, { error: "method_not_allowed", method });
  }
  if (downloadCancelId(path) !== null) {
    if (method === "POST") return handleDownloadsCancel(input);
    return json(405, { error: "method_not_allowed", method });
  }
  return json(404, { error: "not_found", path });
}
