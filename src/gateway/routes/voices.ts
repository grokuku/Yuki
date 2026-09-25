/**
 * API de gestion des voix TTS (Lot 7, §10.4) — `node:http`, aucun framework.
 *
 * Routes (fonctionnent même sans service `tts` : la liste ne dépend que du
 * registre) :
 *   GET    /api/voices                  → liste (presets + clonées)
 *   GET    /api/voices/{id}/sample      → échantillon de référence (WAV)
 *   POST   /api/voices/clone            → création par UPLOAD binaire (D18/D20)
 *   PATCH  /api/voices/{id}             → renommage du libellé
 *   DELETE /api/voices/{id}             → suppression (clone uniquement)
 *   POST   /api/voices/{id}/preview     → extrait de démonstration (appel `tts`)
 *
 * Garde-fous d'écriture : en-tête `X-Yuki-Config: 1` + `Origin`/`Host`
 * (`requireWriteGuards`, réutilisé de `config.ts` comme `admin.ts`).
 *
 * L'upload est un **corps binaire** (`audio/wav`) ; les métadonnées passent par
 * des en-têtes. La limite de corps dédiée `MAX_VOICE_BODY_BYTES` (6 Mo) est
 * appliquée en amont par `src/gateway/app.ts`.
 */

import type { IncomingHttpHeaders } from "node:http";
import { readFileSync } from "node:fs";

import { AudioCppError } from "../../tts/audio-cpp.js";
import { toPublicVoice, type Voice } from "../../tts/types.js";
import {
  MAX_VOICE_BODY_BYTES,
  VoiceStoreError,
  isValidVoiceId,
  type VoiceStore,
} from "../../tts/voices-store.js";
import type { Logger } from "../../observability/logger.js";
import { requireWriteGuards, type ConfigHttpResponse } from "./config.js";

export { MAX_VOICE_BODY_BYTES };

/** En-têtes de métadonnées de l'upload de clonage. */
export const VOICE_LABEL_HEADER = "x-voice-label";
export const VOICE_LANG_HEADER = "x-voice-lang";
export const VOICE_REF_TEXT_HEADER = "x-voice-ref-text";

/** Fournisseur d'aperçu (appel du moteur `tts`) — injectable pour les tests. */
export interface TtsPreviewProvider {
  synthesizePreview(voice: Voice | null): Promise<{
    contentType: string;
    bytes: Buffer;
    /** Chemin `voice_ref` réellement envoyé au moteur (diagnostic), ou `null`. */
    voiceRef?: string | null;
  }>;
}

/**
 * Accès minimal au store de configuration — utilisé uniquement pour réinitialiser
 * `tts.voice` quand la voix sélectionnée est supprimée (§10.8).
 */
export interface VoiceConfigPort {
  getString(path: string): string;
  update(patch: Record<string, unknown>): unknown;
}

export interface VoiceApiDeps {
  store: VoiceStore;
  logger: Logger;
  /** Optionnel : permet le repli de `tts.voice` après suppression d'une voix. */
  config?: VoiceConfigPort;
  /** Optionnel : sans lui, `preview` répond 503. */
  tts?: TtsPreviewProvider;
  now?: () => number;
}

export interface VoiceRequestInput {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  deps: VoiceApiDeps;
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

/** Lit un en-tête de façon insensible à la casse. */
function headerString(
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, raw] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (typeof raw === "string") return raw;
    if (Array.isArray(raw)) return raw[0];
  }
  return undefined;
}

function storeError(error: unknown): ConfigHttpResponse {
  if (error instanceof VoiceStoreError) {
    return json(error.status, {
      error: error.code,
      code: error.code,
      message: error.message,
    });
  }
  throw error;
}

/** Vrai si le chemin relève de l'API des voix. */
export function isVoicesPath(path: string): boolean {
  return path === "/api/voices" || path.startsWith("/api/voices/");
}

function demoAvailable(deps: VoiceApiDeps): boolean {
  return deps.tts !== undefined;
}

function handleList(deps: VoiceApiDeps): ConfigHttpResponse {
  const voices = deps.store
    .list()
    .map((voice) => toPublicVoice(voice, { demoAvailable: demoAvailable(deps) }));
  return json(200, { voices });
}

function handleSample(deps: VoiceApiDeps, id: string): ConfigHttpResponse {
  const path = deps.store.samplePath(id);
  if (!path) {
    return json(404, {
      error: "sample_not_found",
      code: "sample_not_found",
      message: `Aucun échantillon pour la voix « ${id} ».`,
    });
  }
  try {
    const bytes = readFileSync(path);
    return binary(200, Buffer.from(bytes), "audio/wav");
  } catch (error) {
    deps.logger.error("voices.sample.read_failed", {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return json(500, {
      error: "sample_unreadable",
      code: "sample_unreadable",
      message: "Échantillon illisible sur le volume des voix.",
    });
  }
}

function handleClone(input: VoiceRequestInput): ConfigHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;

  const label = headerString(input.headers, VOICE_LABEL_HEADER)?.trim() ?? "";
  if (label.length === 0) {
    return json(400, {
      error: "invalid_label",
      code: "invalid_label",
      message: `En-tête ${VOICE_LABEL_HEADER} requis (libellé de la voix).`,
    });
  }
  const lang = headerString(input.headers, VOICE_LANG_HEADER)?.trim() || "fr";
  const refText = headerString(input.headers, VOICE_REF_TEXT_HEADER) ?? null;

  try {
    const voice = input.deps.store.createFromUpload({
      bytes: input.body,
      label,
      lang,
      refText,
    });
    input.deps.logger.info("voices.created", {
      id: voice.id,
      kind: voice.kind,
      bytes: input.body.length,
    });
    return json(201, {
      voice: toPublicVoice(voice, { demoAvailable: demoAvailable(input.deps) }),
    });
  } catch (error) {
    return storeError(error);
  }
}

function parseLabelPatch(body: Buffer): string | { error: ConfigHttpResponse } {
  let parsed: unknown;
  try {
    parsed = body.length === 0 ? {} : JSON.parse(body.toString("utf8"));
  } catch {
    return {
      error: json(400, {
        error: "invalid_json",
        code: "invalid_json",
        message: "Corps JSON invalide.",
      }),
    };
  }
  const label = (parsed as { label?: unknown } | null)?.label;
  if (typeof label !== "string") {
    return {
      error: json(400, {
        error: "invalid_label",
        code: "invalid_label",
        message: "Champ `label` (texte) requis.",
      }),
    };
  }
  return label;
}

function handleRename(input: VoiceRequestInput, id: string): ConfigHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  const outcome = parseLabelPatch(input.body);
  if (typeof outcome !== "string") return outcome.error;
  try {
    const voice = input.deps.store.rename(id, outcome);
    input.deps.logger.info("voices.renamed", { id: voice.id });
    return json(200, {
      voice: toPublicVoice(voice, { demoAvailable: demoAvailable(input.deps) }),
    });
  } catch (error) {
    return storeError(error);
  }
}

function handleDelete(input: VoiceRequestInput, id: string): ConfigHttpResponse {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  let voice: Voice;
  try {
    voice = input.deps.store.remove(id);
  } catch (error) {
    return storeError(error);
  }
  // §10.8 : si la voix supprimée était sélectionnée, on réinitialise `tts.voice`
  // (voix par défaut). Un échec (champ verrouillé par l'env, store non
  // inscriptible) n'annule PAS la suppression : la résolution retombera sur le
  // défaut à la lecture.
  const config = input.deps.config;
  if (config && config.getString("tts.voice") === id) {
    try {
      config.update({ "tts.voice": null });
      input.deps.logger.info("voices.selected_reset", { id });
    } catch (error) {
      input.deps.logger.warn("voices.selected_reset_failed", {
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  input.deps.logger.info("voices.deleted", { id, kind: voice.kind });
  return json(200, { deleted: id });
}

async function handlePreview(
  input: VoiceRequestInput,
  id: string,
): Promise<ConfigHttpResponse> {
  const guard = requireWriteGuards(input.headers);
  if (guard) return guard;
  if (!input.deps.tts) {
    return json(503, {
      error: "tts_unavailable",
      code: "tts_unavailable",
      message: "Le service TTS n'est pas disponible.",
    });
  }
  if (
    input.deps.config &&
    input.deps.config.getString("tts.enabled") !== "on"
  ) {
    return json(503, {
      error: "tts_disabled",
      code: "tts_disabled",
      message: "TTS désactivé (tts.enabled = off).",
    });
  }
  const voice = input.deps.store.get(id);
  if (!voice) {
    return json(404, {
      error: "not_found",
      code: "not_found",
      message: `Voix inconnue : ${id}.`,
    });
  }
  try {
    const { contentType, bytes, voiceRef } = await input.deps.tts.synthesizePreview(voice);
    return binary(200, bytes, contentType || "audio/wav", {
      // Même diagnostic que `POST /api/tts/test` : quelle voix, et quel WAV de
      // référence a réellement été envoyé au moteur (`voice_ref`).
      "x-yuki-tts-voice": voice.id,
      ...(voiceRef ? { "x-yuki-tts-voice-ref": voiceRef } : {}),
    });
  } catch (error) {
    if (error instanceof VoiceStoreError) {
      input.deps.logger.warn("voices.preview.voice_error", {
        id,
        code: error.code,
        status: error.status,
      });
      return json(error.status, {
        error: error.code,
        code: error.code,
        message: error.message,
      });
    }
    if (error instanceof AudioCppError) {
      const status =
        error.code === "server_busy" ? 503 : error.code === "timeout" ? 504 : 502;
      // ⚠️ Un 503 du moteur ne signifie pas forcément « occupé » (il couvre
      // aussi la mémoire insuffisante) : on remonte le corps brut pour que
      // l'utilisateur puisse lire la vraie raison, sans prétendre trancher.
      input.deps.logger.warn("voices.preview.engine_error", {
        id,
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
    input.deps.logger.error("voices.preview.failed", {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
    return json(502, {
      error: "preview_failed",
      code: "preview_failed",
      message: "La synthèse de démonstration a échoué.",
    });
  }
}

/** Traite une requête de l'API des voix et renvoie la réponse HTTP. */
export async function handleVoicesRequest(
  input: VoiceRequestInput,
): Promise<ConfigHttpResponse> {
  const { method, path } = input;
  if (path === "/api/voices") {
    if (method === "GET" || method === "HEAD") return handleList(input.deps);
    return json(405, { error: "method_not_allowed", method });
  }

  const rest = path.slice("/api/voices/".length);
  if (rest === "clone") {
    if (method !== "POST") return json(405, { error: "method_not_allowed", method });
    return handleClone(input);
  }

  const segments = rest.split("/").filter((segment) => segment.length > 0);
  let id = "";
  try {
    id = decodeURIComponent(segments[0] ?? "");
  } catch {
    return json(400, { error: "invalid_id", code: "invalid_id", message: "Identifiant de voix invalide." });
  }
  if (!isValidVoiceId(id)) {
    return json(404, { error: "not_found", path });
  }

  if (segments.length === 1) {
    if (method === "PATCH") return handleRename(input, id);
    if (method === "DELETE") return handleDelete(input, id);
    return json(405, { error: "method_not_allowed", method });
  }
  if (segments.length === 2 && segments[1] === "sample") {
    if (method === "GET" || method === "HEAD") return handleSample(input.deps, id);
    return json(405, { error: "method_not_allowed", method });
  }
  if (segments.length === 2 && segments[1] === "preview") {
    if (method === "POST") return handlePreview(input, id);
    return json(405, { error: "method_not_allowed", method });
  }
  return json(404, { error: "not_found", path });
}
