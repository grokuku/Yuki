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

import type {
  DeltaChannel,
  PiUsage,
  RunMetrics,
  TranscriptEntry,
} from "./types.js";
import { stripTimestampPrefix } from "./timestamp.js";
import { ackTextForTool } from "./ack.js";
import { parseRecapPrompt } from "../recap/prompt.js";
import { stripFilesBlock } from "../files/frame.js";

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
  /** Instant du message (ms Unix), posé par le SDK. */
  timestamp?: unknown;
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

/**
 * Cause BRUTE d'un message assistant en erreur (`message.errorMessage`), posée
 * par le SDK Pi et contenant le statut HTTP + le corps du fournisseur.
 *
 * Assainie (jamais de clé/token) et normalisée en `undefined` si absente/vide.
 * ⚠️ Sans cette reprise, la cause d'un échec de génération est JETÉE : le run se
 * termine en `error` sans qu'aucune cause ne soit journalisée ni affichée.
 */
export function errorTextFromMessage(
  message: RawAgentMessage,
): string | undefined {
  const value = message.errorMessage;
  if (typeof value !== "string") return undefined;
  const sanitized = sanitizeErrorText(value).trim();
  return sanitized.length > 0 ? sanitized : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Instant d'un message (ms Unix) posé par le SDK, ou `undefined` s'il est
 * absent/illisible. Tolérant : un ancien message sans `timestamp` est accepté
 * (aucune heure ne sera affichée pour lui).
 */
export function messageTimestamp(message: RawAgentMessage): number | undefined {
  const value = finiteNumber(message.timestamp);
  return value !== undefined && value > 0 ? value : undefined;
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

/**
 * Type d'entrée `custom` portant les statistiques d'exécution d'un message
 * assistant (`{ttftMs?, totalMs, tokensOut?}` — NOMBRES uniquement).
 *
 * Écrite par `src/pi/sdk-host.ts` via `SessionManager.appendCustomEntry`, donc
 * en tant qu'enfant (`parentId`) de l'entrée de message assistant qu'elle
 * documente. Le SDK Pi IGNORE les entrées `custom` dans le contexte du modèle
 * (`sessionEntryToContextMessages` renvoie `[]`) : leur présence ne perturbe ni
 * la reprise ni la compaction.
 */
export const RUN_METRICS_CUSTOM_TYPE = "yuki.run_metrics";

/**
 * Type d'entrée `custom` portant l'ACCUSÉ DE RÉCEPTION d'un message assistant
 * (« C'est parti. », « Je m'en occupe. »).
 *
 * ⚠️ Écrite elle aussi via `SessionManager.appendCustomEntry`, donc dans la
 * branche de session, ENFANT de l'entrée de message assistant qu'elle préface :
 * l'accusé revient donc après un RECHARGEMENT (et même après un redémarrage du
 * gateway, puisque le JSONL de session est la source de reprise).
 *
 * ⚠️ Le `data` porte `{tool, text}` : le TEXTE est conservé verbatim, parce qu'il
 * est désormais écrit par le MODÈLE (c'est le premier texte du tour). Sans lui, un
 * rechargement montrerait une autre phrase que celle qui a été dite. Les entrées
 * d'une version antérieure ne portaient que `{tool}` : leur libellé est alors
 * REDÉRIVÉ par `ackTextForTool` (sessions déjà écrites). Le SDK Pi IGNORE les
 * entrées `custom` dans le contexte du modèle (`sessionEntryToContextMessages`
 * renvoie `[]`) : un accusé n'est donc jamais mémoire, jamais un tour du modèle.
 */
export const RUN_ACK_CUSTOM_TYPE = "yuki.run_ack";

/**
 * ACCUSÉ contenu dans une entrée `custom` de type `yuki.run_ack`.
 *
 * `text` est le texte RÉEL (écrit par le modèle ou par le repli). À défaut
 * (entrée d'une version antérieure), il est redérivé du nom d'outil par la règle
 * unique (`ackTextForTool`). Un outil inconnu est ignoré — jamais un accusé
 * inventé.
 */
export interface StoredAck {
  tool: string;
  text: string;
}

export function ackFromCustomEntry(raw: unknown): StoredAck | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as { type?: unknown; customType?: unknown; data?: unknown };
  if (entry.type !== "custom" || entry.customType !== RUN_ACK_CUSTOM_TYPE) {
    return undefined;
  }
  const data = entry.data;
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  const tool = record.tool;
  if (typeof tool !== "string") return undefined;
  const stored = record.text;
  if (typeof stored === "string" && stored.trim().length > 0) {
    return { tool, text: stored.trim() };
  }
  const legacy = ackTextForTool(tool);
  return legacy === undefined ? undefined : { tool, text: legacy };
}

/**
 * Extrait les statistiques d'une entrée `custom` de type `yuki.run_metrics`.
 *
 * ⚠️ SEULS trois NOMBRES sont repris (`ttftMs`, `totalMs`, `tokensOut`) : tout
 * champ inconnu — en particulier un éventuel texte — est IGNORÉ, afin qu'aucun
 * contenu de prompt ne puisse fuiter dans l'historique. `totalMs` est requis ;
 * sans lui, l'entrée est ignorée (le message restera sans pied).
 */
export function metricsFromCustomEntry(raw: unknown): RunMetrics | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as {
    type?: unknown;
    customType?: unknown;
    data?: unknown;
  };
  if (entry.type !== "custom" || entry.customType !== RUN_METRICS_CUSTOM_TYPE) {
    return undefined;
  }
  const data = entry.data;
  if (!data || typeof data !== "object") return undefined;
  const record = data as Record<string, unknown>;
  const totalMs = finiteNumber(record.totalMs);
  if (totalMs === undefined) return undefined;
  const metrics: RunMetrics = { totalMs };
  const ttftMs = finiteNumber(record.ttftMs);
  if (ttftMs !== undefined) metrics.ttftMs = ttftMs;
  const tokensOut = finiteNumber(record.tokensOut);
  if (tokensOut !== undefined) metrics.tokensOut = tokensOut;
  return metrics;
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
 *   - le préfixe d'horodatage `[horodatage] … (heure locale)` d'un message
 *     utilisateur est MASQUÉ (en stockage il est conservé ; voir timestamp.ts) ;
 *   - `timestamp` (ms Unix) est repris du message quand il est présent, afin
 *     que l'UI puisse afficher l'heure — y compris après restauration ;
 *   - les entrées d'outils, les résumés de compaction/branche, les changements
 *     de modèle/niveau sont IGNORÉS (ils ne sont jamais dans le transcript live) ;
 *   - une entrée vide est ignorée (jamais de bulle muette) ;
 *   - un prompt utilisateur synthétique (report de job) est ignoré ;
 *   - une entrée `custom` de type `yuki.run_metrics` n'apparaît JAMAIS comme
 *     bulle, mais ses NOMBRES sont rattachés au message assistant dont elle est
 *     l'enfant (`parentId`) et exposés via `TranscriptEntry.metrics` ;
 *   - une entrée `custom` de type `yuki.run_ack` n'apparaît JAMAIS comme bulle
 *     non plus : son libellé (redérivé du nom d'outil) ouvre une entrée d'ACCUSÉ
 *     (`TranscriptEntry.ack`, `text` vide), c'est-à-dire un MESSAGE À PART
 *     ENTIÈRE placé AVANT la réponse — donc visible après un rechargement, dans
 *     le MÊME ordre que le direct, sans jamais entrer dans le texte du message ;
 *   - chaque entrée de message expose son IDENTIFIANT d'entrée de session
 *     (`TranscriptEntry.id`), seule corrélation admise pour les RÉACTIONS.
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
  // Index de session par identifiant : sert à remonter la chaîne des `parentId`.
  const byId = new Map<string, unknown>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const id = (raw as { id?: unknown }).id;
    if (typeof id === "string") byId.set(id, raw);
  }
  /**
   * Identifiant du MESSAGE ASSISTANT dont une entrée `custom` dépend.
   *
   * ⚠️ Le parent n'est pas toujours le message : deux entrées `custom` d'un même
   * message (accusé puis métriques) forment une CHAÎNE. On remonte donc les
   * `parentId` — le rattachement est ainsi insensible à l'ordre d'écriture.
   */
  const assistantMessageIdOf = (raw: unknown): string | undefined => {
    let current = raw;
    // Borne dure : une chaîne corrompue (cycle) ne boucle pas indéfiniment.
    for (let hops = 0; hops < 64; hops += 1) {
      if (!current || typeof current !== "object") return undefined;
      const parentId = (current as { parentId?: unknown }).parentId;
      if (typeof parentId !== "string") return undefined;
      const parent = byId.get(parentId);
      if (parent === undefined) return undefined;
      const parentEntry = parent as { type?: unknown; message?: unknown };
      if (parentEntry.type === "message") {
        const role = (parentEntry.message as RawAgentMessage | undefined)?.role;
        return role === "assistant" ? parentId : undefined;
      }
      current = parent;
    }
    return undefined;
  };
  // PASSAGE 0 — ACCUSÉS décidés en direct. C'est la SEULE source de vérité : elle
  // reproduit exactement ce que l'interface a affiché (même décision, même texte),
  // y compris quand le repli a parlé parce que le modèle n'avait rien écrit.
  //
  // Deux vues, pour deux besoins distincts :
  //  - `ackByMessageId` : l'accusé rattaché au message que l'entrée `custom` décore
  //    (le message qui a reçu l'accusé côté direct) ;
  //  - `ackTexts` : l'ensemble des phrases d'accusé. Un message dont le TEXTE est
  //    exactement l'une d'elles n'est pas une réponse : c'est le message qu'à lui
  //    seul l'accusé constitue (le modèle a écrit la phrase, puis appelé l'outil).
  //
  // ⚠️ Ces deux vues peuvent désigner la MÊME phrase : la précédence est fixée
  // par `pendingAck === undefined` (un seul accusé par bulle, jamais deux).
  const ackByMessageId = new Map<string, StoredAck>();
  const ackTexts = new Set<string>();
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    if ((raw as { type?: unknown }).type !== "custom") continue;
    const ack = ackFromCustomEntry(raw);
    if (ack === undefined) continue;
    ackTexts.add(ack.text);
    const messageId = assistantMessageIdOf(raw);
    if (messageId !== undefined && !ackByMessageId.has(messageId)) {
      ackByMessageId.set(messageId, ack);
    }
  }

  // PASSAGE 1 — le transcript (contenu seul). On mémorise l'index de chaque
  // message ASSISTANT par identifiant d'entrée, pour corréler les métriques.
  const assistantIndexById = new Map<string, number>();
  /**
   * Accusé EN ATTENTE de sa place : il ouvre une entrée À LUI dès qu'on sait où
   * (juste AVANT la prochaine entrée du fil, quelle qu'elle soit).
   *
   * ⚠️ C'est un MESSAGE, pas un préambule : le direct lui donne sa propre bulle
   * (`public/ui/app.js`), et le rechargement doit produire exactement la même
   * chose — même nombre de bulles, même ordre, même horodatage.
   *
   * `id` n'est conservé que si l'accusé est TOUT le message du tour (aucune réponse
   * ne suit) : c'est alors lui qui porte la corrélation du message (réactions,
   * statistiques). Quand une réponse suit, ses actions restent sur la réponse.
   */
  let pendingAck: { text: string; id?: string; timestamp?: number } | undefined;
  const flushPendingAck = (followedByAnswer = false): void => {
    if (pendingAck === undefined) return;
    transcript.push({
      role: "assistant",
      text: "",
      ack: pendingAck.text,
      ...(!followedByAnswer && pendingAck.id !== undefined ? { id: pendingAck.id } : {}),
      ...(pendingAck.timestamp !== undefined ? { timestamp: pendingAck.timestamp } : {}),
    });
    pendingAck = undefined;
  };

  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { type?: unknown; id?: unknown; message?: unknown };
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    const role = (message as RawAgentMessage).role;
    if (role !== "user" && role !== "assistant") continue;
    const entryId = typeof entry.id === "string" ? entry.id : undefined;
    const storedAck = entryId !== undefined ? ackByMessageId.get(entryId) : undefined;
    /**
     * Accusé que CE message porte, s'il n'a pas déjà été posé plus haut.
     *
     * `fromText` = le texte du message lui-même, quand il tient lieu d'accusé
     * (repli si l'entrée `yuki.run_ack` manque : vieille session, écriture
     * interrompue).
     *
     * ⚠️ `pendingAck === undefined` est la garde anti-doublon : la même phrase
     * peut être désignée DEUX fois (par le texte du message qui ne portait qu'elle
     * ET par l'entrée `custom` rattachée à la réponse) — elle ne doit produire
     * qu'UNE seule bulle.
     */
    const takeAck = (at: number | undefined, fromText?: string): void => {
      if (pendingAck !== undefined) return;
      const label = storedAck?.text ?? fromText;
      if (label === undefined || label === "") return;
      pendingAck = {
        text: label,
        ...(entryId !== undefined ? { id: entryId } : {}),
        ...(at !== undefined ? { timestamp: at } : {}),
      };
    };
    // Le repère temporel d'un message utilisateur est retiré AVANT le filtre
    // synthétique : un report de job n'est jamais horodaté, mais l'ordre reste
    // correct quel que soit l'ordre de pose des préfixes.
    // ⚠️ Le bloc `<fichiers>` (DONNÉE jointe par l'utilisateur) est retiré AUSSI :
    // c'est du matériau de PROMPT, pas un message. Les marqueurs
    // `[fichier] <id> <nom> (<n> octets)`, eux, RESTENT : ils portent les cartes
    // cliquables du message.
    const rawText = contentTextFromMessage(message as RawAgentMessage);
    const text =
      role === "user" ? stripFilesBlock(stripTimestampPrefix(rawText)) : rawText;
    if (role === "assistant") {
      const trimmed = text.trim();
      // ⚠️ MESSAGE QUI N'ÉTAIT QUE L'ACCUSÉ : le modèle a écrit la phrase, puis
      // appelé l'action longue — ce n'est pas une réponse, et le direct ne lui a
      // donné qu'une bulle d'accusé. Il occupe donc SA place ici : une entrée à
      // part, AVANT l'image et AVANT la réponse finale.
      //
      // ⚠️ Le critère est l'ÉGALITÉ avec le texte RÉELLEMENT persisté, jamais « ça a
      // l'air court » : une réponse brève (« Voilà l'image. ») ne doit JAMAIS être
      // confondue avec un accusé.
      const isAckText = trimmed.length > 0 && ackTexts.has(trimmed);
      if (isAckText || text.length === 0) {
        takeAck(messageTimestamp(message as RawAgentMessage), isAckText ? trimmed : undefined);
        continue;
      }
    } else if (text.length === 0) {
      continue;
    }
    if (role === "user") {
      // ⚠️ RÉCAPITULATIF GÉNÉRÉ : c'est un message synthétique (rôle `user` dans
      // le SDK) qui doit être VISIBLE — et non silencieusement écarté — car c'est
      // le POINT DE DÉPART de la conversation. On l'affiche comme un bloc dédié
      // (`role: "recap"`), jamais comme une bulle utilisateur, et on en extrait le
      // corps VERBATIM. Les AUTRES prompts synthétiques restent exclus.
      const recap = parseRecapPrompt(text);
      if (recap) {
        const timestamp = messageTimestamp(message as RawAgentMessage);
        flushPendingAck();
        transcript.push({
          role: "recap",
          text: recap.recap,
          ...(timestamp !== undefined ? { timestamp } : {}),
          ...(recap.originTitle ? { origin: recap.originTitle } : {}),
          ...(recap.subject ? { subject: recap.subject } : {}),
        });
        continue;
      }
      // Un prompt synthétique n'ouvre PAS la bulle : l'accusé reste en attente.
      if (isSyntheticUserText(text, prefixes)) continue;
    }
    const timestamp = messageTimestamp(message as RawAgentMessage);
    // Ce message porte-t-il l'accusé (mais pas son texte) ? Il le précède alors
    // DANS SON PROPRE message : on le pose AVANT lui, jamais dedans.
    takeAck(timestamp);
    flushPendingAck(role === "assistant");
    transcript.push({
      role,
      text,
      ...(entryId !== undefined ? { id: entryId } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
    });
    if (role === "assistant" && entryId !== undefined) {
      assistantIndexById.set(entryId, transcript.length - 1);
    }
  }
  // Un accusé resté en attente ouvre sa propre entrée : jamais une bulle vide,
  // jamais un accusé perdu.
  flushPendingAck();

  // PASSAGE 2 — statistiques d'exécution (`yuki.run_metrics`). Une entrée
  // orpheline — parent disparu, session corrompue, ancienne version — est
  // simplement IGNORÉE (jamais un pied sans message).
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    if ((raw as { type?: unknown }).type !== "custom") continue;
    const metrics = metricsFromCustomEntry(raw);
    if (!metrics) continue;
    const messageId = assistantMessageIdOf(raw);
    if (messageId === undefined) continue;
    const index = assistantIndexById.get(messageId);
    if (index === undefined) continue;
    transcript[index].metrics = metrics;
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
