/**
 * Client HTTP + adaptateur du moteur TTS (`audio.cpp`) — Lot 7, socle serveur.
 *
 * ⚠️ CONTRAT PARTIELLEMENT INCERTAIN (spec §10.2). Ce fichier est le **SEUL**
 * endroit où le contrat de requête `audio.cpp` est matérialisé : la fonction
 * `toAudioCppRequest` (et la table `AUDIO_CPP_KEYS`) concentre l'incertitude,
 * pour qu'une correction en réel ne touche qu'un point.
 *
 * ATTESTÉ par les archives locales (`audio-cpp-http-server`, `chatterbox-tts`) :
 *   - `POST /v1/audio/speech` existe ; sortie WAV PCM16 ou SSE de chunks PCM16
 *     (`stream_format=sse|audio`) ;
 *   - un **503** est renvoyé si le modèle est occupé (`BusyGuard`) ;
 *   - les **noms de champs de CONFIG** `voice_presets`, `voice_dir`,
 *     `voice_ref` (« chemin de référence WAV »), `reference_text`,
 *     `default_voice_preset` ;
 *   - côté lib Python Chatterbox : `language_id="fr"`, `exaggeration=0.5`,
 *     `cfg=0.5` (défauts).
 *
 * ATTESTÉ par le **code source du runtime** (`/tmp/audiocpp`, commit local) :
 *   - l'émotion se passe **dans `options`** : `exaggeration` (float, défaut 0.5)
 *     et **`guidance_scale`** (float, défaut 0.5 — c'est le « cfg » de Yuki, =
 *     le `cfg_weight` Python/T3 CFG) — `src/models/chatterbox/session.cpp:42-60`,
 *     `include/engine/models/chatterbox/tts.h:19-32` ;
 *   - le moteur lit AUSSI `s3gen_cfg_rate` (CFG du **flux S3Gen**, défaut 0.7),
 *     mais c'est un **autre étage** que Yuki ne pilote pas ;
 *   - seul `options_from_object(body.options)` alimente `request.options`
 *     (`app/server/runtime.cpp:1994-2006`) ;
 *   - le **débit** est **top-level** mais **par-modèle** (`runtime.cpp:2107-2127`).
 *
 * NON ATTESTÉ (à vérifier en réel — C1/C17) :
 *   - le **nom d'option de requête** pour choisir une voix (`voice` ? `speaker`
 *     ? `voice_ref` ? un preset ?) — on tente `voice` + `voice_ref` ;
 *   - l'acceptation d'une **référence par requête** (par opposition à un
 *     chargement au démarrage) ;
 *   - la **clé de langue** HTTP (`language` vs `language_id`) ;
 *   - la clé exacte du texte (`input` vs `text`).
 *
 * Aucun câblage dans le flux de conversation dans ce lot : le client est livré
 * avec ses tests, prêt à être appelé par le pipeline (lot suivant).
 */

import type { TtsOptions, Voice } from "./types.js";
import { resolveEmotionValues } from "./options.js";

/** Chemin documenté du serveur HTTP `audio.cpp`. */
export const AUDIO_CPP_SPEECH_PATH = "/v1/audio/speech";

/**
 * Table des clés de requête — POINT UNIQUE de l'incertitude (§10.2).
 * Chaque entrée porte la clé tentée et son statut d'attestation. Pour changer
 * une clé, modifier ICI (et nulle part ailleurs).
 *
 *   attested: true  → nom documenté par les archives
 *   attested: false → hypothèse à confirmer en réel
 */
export const AUDIO_CPP_KEYS = {
  /** Texte à synthétiser (hypothèse convention OpenAI-compatible). */
  text: { key: "input", attested: false },
  /** Identifiant de modèle (nom de famille `audio.cpp`, ex. `chatterbox`). */
  model: { key: "model", attested: false },
  /** Voix par identifiant Yuki (hypothèse ; le nom de preset n'est pas prouvé). */
  voice: { key: "voice", attested: false },
  /** Chemin de référence WAV (nom de champ de CONFIG attesté). */
  voiceRef: { key: "voice_ref", attested: true },
  /** Transcription de la référence (champ de `VoicePreset` attesté). */
  referenceText: { key: "reference_text", attested: true },
  /** Langue (la lib Python utilise `language_id` ; clé HTTP non prouvée). */
  language: { key: "language", attested: false },
  /**
   * **Objet d'options par requête** — les réglages d'émotion NE SONT PAS lus au
   * top-level. `build_speech_request` ne copie au top-level qu'une **liste
   * fixe** (`seed`, `temperature`, `top_k`, `top_p`, `max_tokens`, `max_steps`,
   * `repetition_penalty`, `guidance_scale`, `num_inference_steps`,
   * `instructions`) puis affecte `request.options = options_from_object(body.options)`
   * (`app/server/runtime.cpp:1994-2006`). Une clé top-level inconnue n'est ni
   * lue ni rejetée : elle part « dans le vide ».
   */
  options: { key: "options", attested: true },
  /**
   * Expressivité — lue par la session Chatterbox **DANS `options`**
   * (`src/models/chatterbox/session.cpp:45-46`), type `float`, défaut moteur
   * `0.5` (`include/engine/models/chatterbox/tts.h:20`). Aucune borne côté
   * moteur (`parse_float_option`, pas de clamp).
   */
  exaggeration: { key: "exaggeration", attested: true },
  /**
   * « CFG » de Yuki (`tts.cfg`, défaut 0.5) — lu **DANS `options`**
   * (`src/models/chatterbox/session.cpp:47-48`). Nom **réel** côté moteur :
   * **`guidance_scale`**, le CFG du **T3** (`src/models/chatterbox/t3_component.cpp:615`
   * `logits = cond + guidance_scale·(cond−uncond)`). C'est l'équivalent du
   * **`cfg_weight`** de l'API Python (même défaut **0.5**,
   * `include/engine/models/chatterbox/tts.h:21`) — donc le « cfg » de la spec
   * `docs/lot7.md` (§10.7).
   *
   * ⚠️ Le moteur lit AUSSI `s3gen_cfg_rate` (CFG du **flux S3Gen**, défaut
   * **0.7**, `src/models/chatterbox/session.cpp:57-60`), mais c'est un **autre
   * étage** — l'équivalent de `model.s3gen.flow.inference_cfg_rate` côté Python
   * (réglé séparément, cf. `tests/chatterbox/chatterbox_python_warm_bench.py:109`),
   * **pas** de `cfg_weight`. Yuki ne le pilote pas (il reste au défaut moteur).
   */
  guidanceScale: { key: "guidance_scale", attested: true },
  /**
   * Débit — clé **top-level attestée** (`app/server/README.md:5`,
   * `app/server/runtime.cpp:2112-2124`), MAIS **par-modèle** : le serveur
   * n'applique le multiplicateur que si le modèle supporte la vitesse, sinon il
   * **rejette** (HTTP 500 « speed is not supported by this model ») pour un
   * modèle à contrat schema-v1, ou l'**ignore** (spec legacy sans contrat).
   * Voir `engineSupportsSpeed` / `SPEED_CAPABLE_ENGINES`.
   */
  speed: { key: "speed", attested: true },
  /** Format de sortie (`wav` demandé pour l'aperçu). */
  responseFormat: { key: "response_format", attested: false },
  /** Mode streaming (`sse` ou `audio`). */
  streamFormat: { key: "stream_format", attested: true },
} as const;

export interface AudioCppRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  /** Corps JSON sérialisé. */
  body: string;
}

/** Options d'adaptation (config effective + chemin de montage des voix `tts`). */
export interface ToAudioCppOptions extends TtsOptions {
  /** URL de base du service (`tts.baseUrl`). */
  baseUrl: string;
  /** Moteur (`tts.engine`), ex. `chatterbox`. */
  engine: string;
  /** `true` → demande un flux SSE de chunks PCM16. */
  stream?: boolean;
  /**
   * Chemin de montage des voix **dans le conteneur `tts`** (défaut `/voices`).
   * Le service n'y voit que les WAV du registre Yuki (ro).
   */
  voiceBaseDir?: string;
}

function joinVoiceRef(baseDir: string, relative: string): string {
  const base = baseDir.replace(/\/+$/, "");
  return `${base}/${relative.replace(/^\/+/, "")}`;
}

/**
 * Moteurs de Yuki dont le modèle **applique réellement** un champ de débit au
 * niveau requête. Source de vérité : les `model_specs/*.json` du runtime
 * `audio.cpp` (`options.request[].name`) croisés avec
 * `app/server/runtime.cpp:2112-2124`.
 *
 * | Moteur (enum `tts.engine`) | Spec (`request_option_keys`) | Effet d'un `speed` top-level |
 * | --- | --- | --- |
 * | `kokoro` | `kokoro_tts.json` : `speed` | **appliqué** (`runtime.cpp:2119`) |
 * | `sanotts` | `sanotts.json` : `speaking_rate` | **appliqué** comme `speaking_rate` (`runtime.cpp:2121-2123`) |
 * | `chatterbox` | `chatterbox.json` : **aucun** champ de débit | **ignoré** (spec legacy ⇒ `accepts_speed=true`, mais la session ne lit pas `speed`) |
 * | `qwen3-tts` | `qwen3_tts.json` : **aucun** champ de débit | **rejeté** (HTTP 500, `runtime.cpp:2116-2118`) |
 * | `cosyvoice3` | `cosyvoice3.json` : **aucun** champ de débit | **rejeté** (HTTP 500) |
 *
 * On **omet** donc la clé pour tout moteur non listé : cela évite le rejet dur
 * (qwen3-tts, cosyvoice3) et n'enlève rien à ceux qui l'ignorent (chatterbox).
 * Un moteur inconnu est traité comme non supporté (omission prudente).
 */
const SPEED_CAPABLE_ENGINES: ReadonlySet<string> = new Set([
  "kokoro",
  // Nom de famille du runtime (au cas où `tts.engine` porterait la famille).
  "kokoro_tts",
  "sanotts",
]);

/** `true` si un `speed` top-level a un effet réel pour ce moteur. */
export function engineSupportsSpeed(engine: string): boolean {
  return SPEED_CAPABLE_ENGINES.has(engine.trim().toLowerCase());
}

/**
 * Moteurs dont le modèle **lit réellement** les réglages d'émotion portés par
 * l'objet `options` (`exaggeration`, `guidance_scale`).
 *
 * | Moteur (`tts.engine`) | Lecture d'émotion | Preuve |
 * | --- | --- | --- |
 * | `chatterbox` | **oui** (`exaggeration`, `guidance_scale`) | `src/models/chatterbox/session.cpp:42-60` |
 * | `qwen3-tts`, `cosyvoice3`, `kokoro`, `sanotts`, inconnu | **non** | aucun `make_voice_clone_config`/lecture d'`exaggeration` dans ces familles |
 *
 * On n'émet donc l'objet `options` d'émotion que pour **Chatterbox** : envoyer
 * ces clés à une famille qui ne les lit pas est inutile (au mieux) et risqué
 * pour un moteur à contrat strict (au pire). Le mode Turbo de Chatterbox
 * (`chatterbox_turbo`) est une **famille séparée** qui **ignore** ces champs
 * (`include/engine/community_models/chatterbox_turbo/tts.h:24`) et n'est pas un
 * choix de l'enum `tts.engine`.
 */
const EMOTION_CAPABLE_ENGINES: ReadonlySet<string> = new Set(["chatterbox"]);

/**
 * `true` si `exaggeration` / `guidance_scale` (dans `options`) ont un effet réel
 * pour ce moteur. L'émotion est **spécifique à Chatterbox**.
 */
export function engineSupportsEmotion(engine: string): boolean {
  return EMOTION_CAPABLE_ENGINES.has(engine.trim().toLowerCase());
}

/**
 * ADAPTATEUR UNIQUE : construit la requête `POST /v1/audio/speech` à partir
 * d'une **voix Yuki** (ou `null` = voix par défaut du service), d'un **texte**
 * et des **options d'émotion**. Voir `AUDIO_CPP_KEYS` pour l'incertitude.
 */
export function toAudioCppRequest(
  voice: Voice | null,
  text: string,
  options: ToAudioCppOptions,
): AudioCppRequest {
  const emotion = resolveEmotionValues(
    options.emotion,
    options.exaggeration,
    options.cfg,
  );

  const payload: Record<string, unknown> = {
    [AUDIO_CPP_KEYS.model.key]: options.engine,
    [AUDIO_CPP_KEYS.text.key]: text,
    [AUDIO_CPP_KEYS.language.key]: options.language,
    [AUDIO_CPP_KEYS.responseFormat.key]: "wav",
  };

  // Émotion : les réglages voyagent DANS `options` (le top-level n'est PAS lu
  // par le serveur, cf. `AUDIO_CPP_KEYS.options`). Noms et échelle réels :
  //   - `exaggeration`    : float, défaut moteur 0.5 ;
  //   - `guidance_scale`  : float, défaut moteur 0.5 — le « cfg » de Yuki
  //                         (`tts.cfg`) = `cfg_weight` Python (T3 CFG).
  // (`s3gen_cfg_rate` est un AUTRE étage, non piloté par Yuki.)
  // Pour-mille → réel (`/1000`, spec §9.1). Émis UNIQUEMENT pour Chatterbox
  // (`engineSupportsEmotion`) : c'est la seule famille qui lit ces clés.
  if (engineSupportsEmotion(options.engine)) {
    payload[AUDIO_CPP_KEYS.options.key] = {
      [AUDIO_CPP_KEYS.exaggeration.key]: emotion.exaggeration / 1000,
      [AUDIO_CPP_KEYS.guidanceScale.key]: emotion.cfg / 1000,
    };
  }

  if (voice) {
    payload[AUDIO_CPP_KEYS.voice.key] = voice.id;
    if (voice.refAudio) {
      payload[AUDIO_CPP_KEYS.voiceRef.key] = joinVoiceRef(
        options.voiceBaseDir ?? "/voices",
        voice.refAudio,
      );
      if (voice.refText) {
        payload[AUDIO_CPP_KEYS.referenceText.key] = voice.refText;
      }
    }
  }

  // Débit : multiplicateur `speed/100` (UI en % ; 100 = 1.0). Envoyé
  // UNIQUEMENT aux moteurs qui l'appliquent — les autres le rejettent (HTTP 500)
  // ou l'ignorent, donc l'envoyer n'aurait aucun effet (au mieux) ou casserait
  // la synthèse (au pire). Cf. `engineSupportsSpeed`.
  if (options.speed !== 100 && engineSupportsSpeed(options.engine)) {
    payload[AUDIO_CPP_KEYS.speed.key] = options.speed / 100;
  }
  if (options.stream) {
    payload[AUDIO_CPP_KEYS.streamFormat.key] = "sse";
  }

  return {
    url: `${options.baseUrl.replace(/\/+$/, "")}${AUDIO_CPP_SPEECH_PATH}`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: options.stream ? "text/event-stream, audio/wav" : "audio/wav",
    },
    body: JSON.stringify(payload),
  };
}

/**
 * Chemin `voice_ref` **réellement présent** dans un corps de requête sérialisé
 * (diagnostic `x-yuki-tts-voice-ref`), ou `null` s'il est absent/illisible.
 * On lit le corps SÉRIALISÉ : aucune divergence possible avec ce qui a été
 * réellement envoyé au moteur.
 */
export function voiceRefOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const value = parsed[AUDIO_CPP_KEYS.voiceRef.key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

/** Sous-ensemble du logger d'observabilité requis par le client. */
export interface TtsLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export type AudioCppErrorCode =
  | "server_busy"
  | "http_error"
  | "timeout"
  | "aborted"
  | "network_error";

/**
 * Erreur du moteur TTS : code stable + statut HTTP éventuel + corps d'erreur
 * brut (borné), pour le diagnostic.
 *
 * ⚠️ Le moteur renvoie **503** pour PLUSIEURS causes : `BusyGuard` (« server
 * busy ») MAIS AUSSI « Insufficient Memory » (`min_free_memory_mb`). Le contrat
 * HTTP attesté ne fournit pas de code machine fiable pour les distinguer : on
 * conserve donc le corps brut (`body`) et on NE prétend PAS distinguer la
 * cause (voir `docs/lot7.md` §10.8 et le rapport de lot).
 */
export class AudioCppError extends Error {
  override readonly name: string = "AudioCppError";
  constructor(
    readonly code: AudioCppErrorCode,
    message: string,
    readonly status?: number,
    /** Début du corps de la réponse d'erreur du moteur (borné), si lisible. */
    readonly body?: string,
  ) {
    super(message);
  }
}

/** `503 server busy` : le `BusyGuard` du moteur sérialise déjà par modèle. */
export class AudioCppBusyError extends AudioCppError {
  override readonly name = "AudioCppBusyError";
  constructor(message = "Le service TTS est occupé (503).", body?: string) {
    super("server_busy", message, 503, body);
  }
}

/** Taille maximale conservée du corps d'erreur du moteur (diagnostic). */
export const AUDIO_CPP_ERROR_BODY_LIMIT = 1_000;

/**
 * Lit le corps d'une réponse d'erreur, borné et jamais bloquant : une lecture
 * impossible renvoie `undefined` (le diagnostic est un bonus, pas un prérequis).
 */
async function readErrorBody(
  response: Response,
  limit = AUDIO_CPP_ERROR_BODY_LIMIT,
): Promise<string | undefined> {
  try {
    const text = (await response.text()).trim();
    if (text.length === 0) return undefined;
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return undefined;
  }
}

export interface AudioCppClientOptions {
  baseUrl: string;
  /** Délai avant abandon (`tts.timeoutMs`). */
  timeoutMs: number;
  /** Injectable pour les tests. Défaut : `fetch` global. */
  fetchImpl?: typeof fetch;
  logger?: TtsLogger;
}

export interface SynthesizeParams {
  voice: Voice | null;
  text: string;
  options: TtsOptions;
  engine: string;
  /** Annulation (barge-in). */
  signal?: AbortSignal;
  /** `true` → `stream_format=sse`. */
  stream?: boolean;
  voiceBaseDir?: string;
}

export interface SpeechStreamResult {
  status: number;
  contentType: string | null;
  /** Flux de réponse (corps brut) — `null` si le serveur n'en fournit pas. */
  body: ReadableStream<Uint8Array> | null;
  request: AudioCppRequest;
}

export interface SpeechBufferResult {
  status: number;
  contentType: string | null;
  bytes: Buffer;
  request: AudioCppRequest;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Client HTTP du service `audio.cpp` : synthèse d'un segment de texte vers un
 * flux audio, avec gestion du **503 busy**, du **timeout** et de
 * l'**annulation**. Aucune dépendance au SDK Pi.
 */
export class AudioCppClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly logger?: TtsLogger;

  constructor(options: AudioCppClientOptions) {
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  /**
   * Exécute la requête et vérifie le statut. Lève `AudioCppBusyError` sur 503,
   * `AudioCppError` sinon. Le `AbortController` combine l'annulation externe et
   * le timeout.
   */
  private async fetchSpeech(
    params: SynthesizeParams,
  ): Promise<{ response: Response; request: AudioCppRequest }> {
    const request = toAudioCppRequest(params.voice, params.text, {
      ...params.options,
      baseUrl: this.baseUrl,
      engine: params.engine,
      ...(params.stream ? { stream: true } : {}),
      ...(params.voiceBaseDir ? { voiceBaseDir: params.voiceBaseDir } : {}),
    });

    const controller = new AbortController();
    const external = params.signal;
    const onAbort = (): void => controller.abort();
    if (external) {
      if (external.aborted) controller.abort();
      else external.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    try {
      const response = await this.fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      if (response.status === 503) {
        // 503 ≠ forcément « busy » (aussi « mémoire insuffisante ») : on
        // conserve le corps brut sans prétendre trancher la cause.
        throw new AudioCppBusyError(undefined, await readErrorBody(response));
      }
      if (!response.ok) {
        throw new AudioCppError(
          "http_error",
          `Le service TTS a répondu ${response.status}.`,
          response.status,
          await readErrorBody(response),
        );
      }
      return { response, request };
    } catch (error) {
      if (error instanceof AudioCppError) throw error;
      if (controller.signal.aborted) {
        if (external?.aborted) {
          throw new AudioCppError("aborted", "Requête TTS annulée.");
        }
        throw new AudioCppError(
          "timeout",
          `Délai dépassé (${this.timeoutMs} ms) vers le service TTS.`,
        );
      }
      this.logger?.warn("tts.request.failed", { error: messageOf(error) });
      throw new AudioCppError("network_error", messageOf(error));
    } finally {
      clearTimeout(timer);
      // Le timeout ne s'applique qu'à l'obtention de la réponse : une fois les
      // en-têtes reçus, le corps peut être lu en streaming. L'écouteur
      // d'annulation externe reste attaché pour interrompre la lecture.
    }
  }

  /** Synthétise un segment et renvoie le flux de réponse. */
  async synthesize(params: SynthesizeParams): Promise<SpeechStreamResult> {
    const { response, request } = await this.fetchSpeech(params);
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: response.body,
      request,
    };
  }

  /** Synthétise un segment et matérialise tout le corps (aperçu WAV). */
  async synthesizeBuffer(params: SynthesizeParams): Promise<SpeechBufferResult> {
    const { response, request } = await this.fetchSpeech(params);
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      bytes,
      request,
    };
  }
}
