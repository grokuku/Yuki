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

import type { DeltaChannel, PiUsage, TranscriptEntry } from "./types.js";

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

/** Options de reconstruction du transcript depuis une session reprise. */
export interface TranscriptRestoreOptions {
  /**
   * Préfixes de texte désignant un message `user` SYNTHÉTIQUE — ex. le prompt de
   * report d'un job d'arrière-plan. Ces messages ne figurent jamais dans le
   * transcript, exactement comme sur le flux temps réel (qui les exclut).
   */
  syntheticUserPrefixes?: readonly string[];
}

/** `true` si le texte d'un message utilisateur est un prompt synthétique. */
function isSyntheticUserText(
  text: string,
  prefixes: readonly string[],
): boolean {
  return prefixes.some(
    (prefix) => prefix.length > 0 && text.startsWith(prefix),
  );
}

/**
 * Reconstruit le transcript de l'UI depuis les entrées d'une session reprise.
 *
 * Miroir EXACT du transcript temps réel (`SessionRecord.transcript`) :
 *   - seules les entrées `type:"message"` de rôle `user`/`assistant` comptent ;
 *   - le texte est le CONTENU seul (les blocs `thinking` sont exclus) ;
 *   - les entrées d'outils, les résumés de compaction/branche, les entrées
 *     `custom` et les changements de modèle/niveau sont IGNORÉS (ils ne sont
 *     jamais dans le transcript live) ;
 *   - une entrée vide est ignorée (jamais de bulle muette) ;
 *   - un prompt utilisateur synthétique (report de job) est ignoré.
 *
 * Les entrées sont fournies dans l'ordre racine → feuille : l'ordre du retour
 * est donc l'ordre chronologique d'affichage. Mapping PUR et SANS état :
 * l'appliquer deux fois donne le même résultat (aucun doublon possible, le
 * transcript restauré n'est servi que par le snapshot — cf. `buildState`).
 */
export function transcriptFromEntries(
  entries: readonly unknown[],
  options: TranscriptRestoreOptions = {},
): TranscriptEntry[] {
  const prefixes = options.syntheticUserPrefixes ?? [];
  const transcript: TranscriptEntry[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { type?: unknown; message?: unknown };
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const role = (message as RawAgentMessage).role;
    if (role !== "user" && role !== "assistant") continue;
    const text = contentTextFromMessage(message as RawAgentMessage);
    if (text.length === 0) continue;
    if (role === "user" && isSyntheticUserText(text, prefixes)) continue;
    transcript.push({ role, text });
  }
  return transcript;
}

/**
 * Suffixe de CONTENU non encore streamé, à émettre comme delta de rattrapage.
 *
 * Certains fournisseurs n'émettent pas de `text_delta` pour tout le contenu :
 * le texte n'est alors complet que dans l'événement `text_end` / `message_end`.
 * Or le chemin **live** (affichage incrémental de l'UI ET synthèse TTS, qui lit
 * uniquement les deltas du canal `content`) ne verrait jamais ce texte : la
 * réponse resterait **vide à l'écran** et **muette**, alors que le moteur TTS
 * et le transport fonctionnent.
 *
 * On ne renvoie QUE le suffixe manquant :
 *   - `content` vide → rien ;
 *   - `streamed` vide → tout `content` ;
 *   - `streamed` préfixe de `content` → le suffixe ;
 *   - divergence (contenu réécrit) → rien (on ne duplique jamais, le transcript
 *     reste la source de vérité).
 */
export function unstreamedContentSuffix(
  streamed: string,
  content: string,
): string {
  if (content.length === 0) return "";
  if (streamed.length === 0) return content;
  if (content.startsWith(streamed)) return content.slice(streamed.length);
  return "";
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
