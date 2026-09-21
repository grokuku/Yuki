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
 * Contrat moteur ATTESTÉ par l'archive locale `audio-cpp-http-server` :
 *   - `GET /health` → `{ ready, model_count }` (toujours 200) ;
 *   - `GET /v1/models` → liste OpenAI-compatible `{ id, task }` ;
 *   - `503` renvoyé par le `BusyGuard` … ET par le garde-mémoire
 *     (`min_free_memory_mb`, « Insufficient Memory »). Le contrat n'expose PAS
 *     de discriminant fiable : on conserve le corps brut sans trancher.
 *
 * ⚠️ Le réseau n'est pas exposé au client : le service `tts` vit sur
 * `yuki-net` ; tout passe par le gateway (seul à pouvoir joindre `tts:8081`).
 *
 * Aucune écriture n'est faite dans `/models` (volume monté `ro`) : on ne fait
 * que **lire** le répertoire pour dire à l'utilisateur où déposer un modèle.
 *
 * Le choix de performance de `/health` est documenté sur `TtsDiagnostics` :
 * sonde en tâche de fond + cache court (5 s), jamais d'attente bloquante.
 */

import type { IncomingHttpHeaders } from "node:http";
import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

import { AudioCppError } from "../../tts/audio-cpp.js";
import type { Voice } from "../../tts/types.js";
import type { Logger } from "../../observability/logger.js";
import { requireWriteGuards, type ConfigHttpResponse } from "./config.js";

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
  ready: boolean | null;
  modelCount: number | null;
  latencyMs: number | null;
  error: string | null;
  /** Horodatage de la mesure (`0` = jamais mesuré). */
  at: number;
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

/** Diagnostic du répertoire des modèles (volume `yuki-models`, monté `ro`). */
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
  }): Promise<{ contentType: string; bytes: Buffer }>;
}

/** Résolution d'un id de voix du registre (même chemin que le pipeline). */
export interface TtsVoiceResolver {
  get(id: string): Voice | null;
}

/** Accès minimal à la configuration (`tts.*`). */
export interface TtsConfigPort {
  getString(path: string): string;
  getNumber(path: string): number;
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
      return {
        reachable: true,
        ready: null,
        modelCount: null,
        latencyMs,
        error: `Le moteur a répondu ${response.status}${body ? ` : ${body}` : ""}`,
        at: options.now(),
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
    const ready = typeof record?.ready === "boolean" ? record.ready : null;
    const modelCount =
      typeof record?.model_count === "number" ? record.model_count : null;
    const error =
      record === null
        ? `Réponse /health illisible${body ? ` : ${body}` : ""}`
        : ready === null
          ? "Réponse /health sans champ booléen `ready`."
          : null;
    return { reachable: true, ready, modelCount, latencyMs, error, at: options.now() };
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
  };
}

/** Dérive l'état synthétique à partir d'une sonde brute et de `tts.enabled`. */
export function deriveTtsState(probe: TtsProbeRaw, enabled: boolean): TtsState {
  if (!enabled) return "off";
  if (!probe.reachable) return "unreachable";
  if (probe.error) return "error";
  if (probe.ready === true) return "ready";
  if (probe.ready === false) return "starting";
  return "error";
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
  private lastAt = 0;
  private inflight: Promise<TtsProbeRaw> | null = null;

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

  /** Sonde FRAÎCHE (attendue, bornée par `timeoutMs`). */
  refresh(): Promise<TtsProbeRaw> {
    if (this.inflight) return this.inflight;
    const pending = this.probe().then(
      (raw) => {
        this.last = raw;
        this.lastAt = this.now();
        this.inflight = null;
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

  /** Compose un rapport public à partir d'une sonde brute. */
  private compose(probe: TtsProbeRaw): TtsEngineReport {
    const enabled = this.config.enabled();
    return {
      enabled,
      reachable: probe.reachable,
      ready: probe.ready,
      modelCount: probe.modelCount,
      engine: this.config.engine(),
      baseUrl: this.config.baseUrl(),
      latencyMs: probe.latencyMs,
      error: probe.error,
      state: deriveTtsState(probe, enabled),
      measuredAt: probe.at > 0 ? new Date(probe.at).toISOString() : null,
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

async function handleStatus(deps: TtsApiDeps): Promise<ConfigHttpResponse> {
  const report = await deps.diagnostics.status();
  return json(200, { ...report, modelsDir: inspectModelsDir(deps.modelsDir) });
}

async function handleModels(deps: TtsApiDeps): Promise<ConfigHttpResponse> {
  return json(200, await deps.diagnostics.models());
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

  // Voix active, résolue par le MÊME chemin que le pipeline
  // (`src/tts/pipeline.ts:402-410` + `src/index.ts` : `get(id) ?? null`).
  const id = input.deps.config.getString("tts.voice").trim();
  const voice = id.length === 0 ? null : input.deps.voices.get(id);
  try {
    const { contentType, bytes } = await input.deps.synth.synthesize({
      text: outcome,
      voice,
    });
    return binary(200, bytes, contentType || "audio/wav", {
      // Diagnostic honnête : quelle voix et quel moteur ont réellement produit
      // cet échantillon (une voix inconnue retombe sur le défaut du service).
      "x-yuki-tts-voice": voice?.id ?? "default",
      "x-yuki-tts-engine": input.deps.config.getString("tts.engine"),
    });
  } catch (error) {
    return synthesisError(error, input.deps, "tts.test.failed");
  }
}

/** Vrai si le chemin relève du diagnostic TTS. */
export function isTtsPath(path: string): boolean {
  return (
    path === "/api/tts/status" ||
    path === "/api/tts/models" ||
    path === "/api/tts/test"
  );
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
  return json(404, { error: "not_found", path });
}
