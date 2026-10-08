/**
 * Extension SDK de mémoire (confidentiel — `src/pi/sdk/**` uniquement, Lot 12).
 *
 * Enregistrée INLINE via `resourceLoaderOptions.extensionFactories` (aucune
 * dépendance, aucun build). Elle câble le port `MemoryPort` sur le cycle de vie
 * du SDK :
 *
 *  - `before_agent_start` : RAPPEL. On augmente le PROMPT SYSTÈME du tour
 *    (`systemPrompt`) — mécanisme le MOINS INTRUSIF : le résultat est
 *    « for this turn » (types.d.ts:845) et n'est JAMAIS persisté comme entrée de
 *    session, donc il n'apparaît pas dans le transcript ni dans l'UI. À l'inverse,
 *    retourner `message` créerait un `CustomMessageEntry` PERSISTÉ (pollution).
 *  - `agent_end` : ÉCRITURE AUTOMATIQUE, asynchrone (jamais bloquante).
 *  - `session_before_compact` : CONSOLIDATION (capture immédiate, travail async).
 *
 * Aucun souvenir n'est exécuté : c'est une DONNÉE injectée comme contexte.
 */

import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";

import type {
  ConsolidateMessage,
  MemoryPort,
} from "../../memory/types.js";
import { contentTextFromMessage, type RawAgentMessage } from "../events.js";

export interface MemoryExtensionOptions {
  /** Préfixes de textes utilisateur SYNTHÉTIQUES (report de job) à ignorer. */
  syntheticUserPrefixes?: readonly string[];
}

/**
 * Mention COURTE injectée quand la mémoire est ACTIVÉE mais qu'aucun souvenir
 * n'est pertinent pour le message.
 *
 * ⚠️ Défaut de conception corrigé : sans elle, un tour sans hit n'injectait RIEN
 * (`recall.block === null`) ⇒ le modèle, ne voyant aucune trace de la mémoire,
 * en concluait avoir été construit SANS mémoire automatique — et le niait avec
 * assurance. La condition d'injection porte donc sur la CAPACITÉ (`enabled`),
 * JAMAIS sur les hits : un tour sans hit doit annoncer la capacité, pas la
 * taire (sinon le bogue revient de façon intermittente).
 *
 * ⚠️ La plus courte des formulations : le prompt système est réémis à CHAQUE
 * tour, le budget est payé à chaque tour.
 */
export const MEMORY_IDLE_NOTICE =
  "Mémoire durable activée ; rien de pertinent pour ce message.";

function isSynthetic(text: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => prefix.length > 0 && text.startsWith(prefix));
}

/**
 * Dernier échange utilisateur→assistant de la branche ACTIVE, ou `null`.
 * Lecture seule : ne modifie jamais la session.
 */
function lastExchange(
  ctx: ExtensionContext,
  syntheticUserPrefixes: readonly string[],
): { userText: string; assistantText: string; source: string } | null {
  let entries: readonly unknown[];
  try {
    entries = ctx.sessionManager.getBranch();
  } catch {
    return null;
  }
  let assistant: { text: string; id: string } | null = null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as
      | { type?: unknown; id?: unknown; message?: unknown }
      | undefined;
    if (!entry || entry.type !== "message" || typeof entry.id !== "string") {
      continue;
    }
    const message = entry.message as RawAgentMessage | undefined;
    if (!message) continue;
    if (!assistant) {
      if (message.role !== "assistant") continue;
      const text = contentTextFromMessage(message);
      if (text.length > 0) assistant = { text, id: entry.id };
      continue;
    }
    if (message.role !== "user") continue;
    const userText = contentTextFromMessage(message);
    if (userText.length === 0 || isSynthetic(userText, syntheticUserPrefixes)) {
      return null;
    }
    return { userText, assistantText: assistant.text, source: entry.id };
  }
  return null;
}

function toConsolidateMessage(message: unknown): ConsolidateMessage | null {
  const role = (message as { role?: unknown } | null)?.role;
  if (role !== "user" && role !== "assistant") return null;
  const text = contentTextFromMessage(message as RawAgentMessage);
  if (text.trim().length === 0) return null;
  return { role, text };
}

/**
 * Construit la fabrique d'extension de mémoire. Le port est capturé par closure ;
 * aucun état n'est stocké dans la session.
 */
export function createMemoryExtensionFactory(
  memory: MemoryPort,
  options: MemoryExtensionOptions = {},
): InlineExtension {
  const syntheticUserPrefixes = options.syntheticUserPrefixes ?? [];
  return {
    name: "yuki-memory",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", async (event) => {
        const recall = await memory.recall(event.prompt);
        if (recall.block) {
          return { systemPrompt: `${event.systemPrompt}\n\n${recall.block}` };
        }
        // Aucun souvenir pertinent : si la CAPACITÉ est active, on se présente
        // quand même (une ligne), sinon le modèle renie une mémoire qu'il a.
        if (!recall.enabled) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${MEMORY_IDLE_NOTICE}` };
      });

      pi.on("agent_end", async (_event, ctx) => {
        const exchange = lastExchange(ctx, syntheticUserPrefixes);
        if (exchange) memory.onTurnEnd(exchange);
      });

      pi.on("session_before_compact", async (event) => {
        const preparation = event.preparation;
        const messages: ConsolidateMessage[] = [];
        for (const raw of [
          ...preparation.messagesToSummarize,
          ...(preparation.turnPrefixMessages ?? []),
        ]) {
          const message = toConsolidateMessage(raw);
          if (message) messages.push(message);
        }
        memory.onBeforeCompact({
          messages,
          ...(preparation.previousSummary
            ? { previousSummary: preparation.previousSummary }
            : {}),
        });
      });
    },
  };
}
