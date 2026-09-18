/**
 * Événements normalisés + mapping pur SDK → façade.
 *
 * Ce module ne dépend QUE de types structurels (`unknown`/interfaces locales) :
 * aucun type du SDK n'y est importé. `src/pi/sdk-host.ts` lui passe les
 * événements bruts du SDK et reçoit en retour des valeurs sérialisables.
 *
 * Le champ `channel` est structurant : `thinking` transite mais n'est jamais
 * assimilable à une réponse.
 */

import type { DeltaChannel, PiUsage } from "./types.js";

/** Forme minimale d'un `assistantMessageEvent` du SDK. */
export interface RawAssistantMessageEvent {
  type?: unknown;
  delta?: unknown;
}

/** Forme minimale d'un message de l'agent. */
export interface RawAgentMessage {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  usage?: unknown;
  content?: unknown;
}

/** Extrait le canal d'un événement de streaming, ou `null` s'il est ignoré. */
export function channelForAssistantEvent(
  event: RawAssistantMessageEvent,
): DeltaChannel | null {
  if (event.type === "text_delta") return "content";
  if (event.type === "thinking_delta") return "thinking";
  return null;
}

/** Extrait le texte d'un delta (jamais `undefined`). */
export function deltaText(event: RawAssistantMessageEvent): string {
  return typeof event.delta === "string" ? event.delta : "";
}

/**
 * Traduit la raison d'arrêt d'un message assistant en issue de run.
 * Renvoie `null` si le message ne porte pas d'information exploitable.
 */
export function finishReasonForMessage(
  message: RawAgentMessage,
): "done" | "abort" | "error" | null {
  const reason = message.stopReason;
  if (reason === "aborted") return "abort";
  if (reason === "error") return "error";
  if (
    reason === "stop" ||
    reason === "length" ||
    reason === "toolUse" ||
    reason === "deferred"
  ) {
    return "done";
  }
  return null;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Convertit une `usage` du SDK en `PiUsage` sérialisable. */
export function usageFromMessage(
  message: RawAgentMessage,
): PiUsage | undefined {
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const input = finiteNumber(record.input);
  const output = finiteNumber(record.output);
  if (input === undefined && output === undefined) return undefined;
  const result: PiUsage = {
    input: input ?? 0,
    output: output ?? 0,
  };
  const cacheRead = finiteNumber(record.cacheRead);
  const cacheWrite = finiteNumber(record.cacheWrite);
  const total = finiteNumber(record.totalTokens);
  if (cacheRead !== undefined) result.cacheRead = cacheRead;
  if (cacheWrite !== undefined) result.cacheWrite = cacheWrite;
  if (total !== undefined) result.total = total;
  return result;
}

/**
 * Extrait le texte de CONTENU d'un message assistant : les blocs `thinking`
 * sont explicitement exclus, afin de garantir le critère « transcript =
 * contenu seul ».
 */
export function contentTextFromMessage(message: RawAgentMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.join("");
}

const REDACTED = "[REDACTED]";

/**
 * Sanitise un message d'erreur AVANT journalisation : les erreurs de provider
 * (SDK, HTTP) peuvent contenir des entêtes `Authorization`, des clés `api_key`
 * ou des jetons opaques. On masque ces motifs. Le logger applique en plus une
 * redaction des valeurs de secrets présentes dans l'environnement.
 */
export function sanitizeErrorText(text: string): string {
  return text
    .replace(
      /(authorization\s*[:=]\s*)(bearer\s+)?[^\s,;]+/gi,
      `$1$2${REDACTED}`,
    )
    .replace(/(bearer\s+)[A-Za-z0-9._\-]{6,}/gi, `$1${REDACTED}`)
    .replace(
      /(api[_-]?key["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/sk-[A-Za-z0-9._\-]{6,}/g, REDACTED)
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, REDACTED)
    .replace(/\b[A-Za-z0-9_\-]{40,}\b/g, REDACTED);
}
