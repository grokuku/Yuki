/**
 * Extension SDK des RÉACTIONS (confidentiel — `src/pi/sdk/**` uniquement).
 *
 * Enregistrée INLINE via `resourceLoaderOptions.extensionFactories` (aucune
 * dépendance, aucun build). Elle câble le port `ReactionsPort` sur le cycle de
 * vie du SDK :
 *
 *  - `before_agent_start` : INJECTION. On augmente le PROMPT SYSTÈME du tour
 *    (`systemPrompt`) — mécanisme le MOINS INTRUSIF : le résultat est « for this
 *    turn » et n'est JAMAIS persisté comme entrée de session, donc il
 *    n'apparaît ni dans le transcript, ni dans l'UI, ni dans le rejeu.
 *    ⚠️ Retourner `message` créerait au contraire un `CustomMessageEntry`
 *    PERSISTÉ (pollution) : on ne le fait jamais.
 *
 * ⚠️ CE QUE CETTE EXTENSION NE FAIT PAS, ET NE DOIT PAS FAIRE :
 *  - elle n'ouvre AUCUN tour (elle ne fait que lire des données au moment où un
 *    tour est DÉJÀ déclenché par l'utilisateur) ;
 *  - elle n'écrit RIEN (aucune entrée de session, aucun souvenir : une réaction
 *    isolée n'est pas un souvenir, voir `src/reactions/store.ts`) ;
 *  - elle n'alimente JAMAIS la synthèse vocale (le bloc n'est pas un delta de
 *    contenu ; la TTS ne lit que les deltas, donc c'est muet par construction).
 *
 * Le bloc est encadré comme DONNÉE (`<reactions_utilisateur>`) et borné aux N
 * dernières réactions (voir `src/reactions/prompt.ts`).
 */

import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";

import type { ReactionView, ReactionsPort } from "../../reactions/types.js";
import {
  formatReactionsBlock,
  REACTIONS_PROMPT_MAX,
  type ReactionPromptItem,
} from "../../reactions/prompt.js";
import { contentTextFromMessage, type RawAgentMessage } from "../events.js";

export type { ReactionsPort };

export interface ReactionsExtensionOptions {
  /** Nombre maximal de réactions injectées (borne du prompt). */
  maxItems?: number;
}

/**
 * Extrait de chaque message de la branche, indexé par identifiant d'entrée.
 * Sert à SITUER la réaction (« sur ce message-là ») : sans extrait, le modèle
 * devrait deviner de quoi parle la réaction.
 */
function excerptIndex(ctx: ExtensionContext): Map<string, string> {
  const index = new Map<string, string>();
  let entries: readonly unknown[];
  try {
    entries = ctx.sessionManager.getBranch();
  } catch {
    return index;
  }
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { type?: unknown; id?: unknown; message?: unknown };
    if (entry.type !== "message" || typeof entry.id !== "string") continue;
    const message = entry.message as RawAgentMessage | undefined;
    if (!message) continue;
    const text = contentTextFromMessage(message);
    if (text.length === 0) continue;
    index.set(entry.id, text);
  }
  return index;
}

/**
 * Construit la fabrique d'extension. Le port est capturé par closure ; aucun
 * état n'est stocké dans la session.
 */
export function createReactionsExtensionFactory(
  reactions: ReactionsPort,
  options: ReactionsExtensionOptions = {},
): InlineExtension {
  const maxItems = options.maxItems ?? REACTIONS_PROMPT_MAX;
  const limit = Math.max(1, Math.floor(maxItems));
  return {
    name: "yuki-reactions",
    hidden: true,
    factory: (pi: ExtensionAPI) => {
      pi.on("before_agent_start", async (event, ctx) => {
        let sessionId: string | undefined;
        try {
          sessionId = ctx.sessionManager.getSessionId();
        } catch {
          sessionId = undefined;
        }
        if (!sessionId) return undefined;
        let views: ReactionView[];
        try {
          views = reactions.recentFor(sessionId, limit);
        } catch {
          // Un store indisponible ne casse JAMAIS un tour : le prompt part sans
          // les réactions (dégradation silencieuse, même doctrine que la mémoire).
          return undefined;
        }
        if (views.length === 0) return undefined;
        const excerpts = excerptIndex(ctx);
        const items: ReactionPromptItem[] = views.map((view) => ({
          entryId: view.entryId,
          reaction: view.reaction,
          ...(excerpts.has(view.entryId) ? { excerpt: excerpts.get(view.entryId)! } : {}),
        }));
        const block = formatReactionsBlock(items, limit);
        if (!block) return undefined;
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
      });
    },
  };
}
