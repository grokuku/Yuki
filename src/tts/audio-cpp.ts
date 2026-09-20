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
 * NON ATTESTÉ (à vérifier en réel — C1/C17) :
 *   - le **nom d'option de requête** pour choisir une voix (`voice` ? `speaker`
 *     ? `voice_ref` ? un preset ?) — on tente `voice` + `voice_ref` ;
 *   - l'acceptation d'une **référence par requête** (par opposition à un
 *     chargement au démarrage) ;
 *   - l'**exposition d'`exaggeration`/`cfg`** par le serveur HTTP (documentés
 *     seulement côté lib Python) ;
 *   - la **clé de langue** HTTP (`language` vs `language_id`) ;
 *   - la clé exacte du texte (`input` vs `text`) et du débit.
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
  /** Expressivité (lib Python attestée, surface HTTP NON prouvée). */
  exaggeration: { key: "exaggeration", attested: false },
  /** Guidance CFG (lib Python attestée, surface HTTP NON prouvée). */
  cfg: { key: "cfg", attested: false },
  /** Débit (hypothèse ; le format attendu n'est pas prouvé). */
  speed: { key: "speed", attested: false },
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
    // Pour-mille → réel (spec §9.1).
    [AUDIO_CPP_KEYS.exaggeration.key]: emotion.exaggeration / 1000,
    [AUDIO_CPP_KEYS.cfg.key]: emotion.cfg / 1000,
  };

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

  if (options.speed !== 100) {
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

/** Erreur du moteur TTS : code stable + statut HTTP éventuel. */
export class AudioCppError extends Error {
  override readonly name: string = "AudioCppError";
  constructor(
    readonly code: AudioCppErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** `503 server busy` : le `BusyGuard` du moteur sérialise déjà par modèle. */
export class AudioCppBusyError extends AudioCppError {
  override readonly name = "AudioCppBusyError";
  constructor(message = "Le service TTS est occupé (503).") {
    super("server_busy", message, 503);
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
      if (response.status === 503) throw new AudioCppBusyError();
      if (!response.ok) {
        throw new AudioCppError(
          "http_error",
          `Le service TTS a répondu ${response.status}.`,
          response.status,
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
