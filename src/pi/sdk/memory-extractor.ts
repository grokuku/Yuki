/**
 * Extracteur de mémoire côté SDK (confidentiel — `src/pi/sdk/**`, Lot 12).
 *
 * ⚠️ CHEMIN ISOLÉ : chaque extraction ouvre une session ÉPHÉMÈRE EN MÉMOIRE
 * (`SessionManager.inMemory`, via `createEphemeralSession`) — exactement comme le
 * worker lourd. Le prompt d'extraction ne touche JAMAIS la session de
 * l'utilisateur : il n'apparaît donc ni dans son historique ni dans son
 * transcript. Un test le prouve.
 */

import { contentTextFromMessage, type RawAgentMessage } from "../events.js";
import type { MemoryExtractor } from "../../memory/types.js";
import type { PiLogger, PiThinkingLevel } from "../types.js";
import { getSharedModelRuntime, liveValue, resolveSdkModel } from "./model-runtime.js";
import { createEphemeralSession } from "./session-factory.js";

/** Prompt système de la session d'extraction (réponse = tableau JSON strict). */
export const MEMORY_EXTRACTOR_SYSTEM_PROMPT =
  "Tu es le module de mémoire durable de Yuki. Tu réponds UNIQUEMENT par un " +
  "tableau JSON en français, sans aucun autre texte, sans balise de code.";

/**
 * Prompt système de la CONSOLIDATION HEBDOMADAIRE (lot 29) : la réponse est un
 * OBJET JSON (`{"version":1,"lot":n,"operations":[…]}`), jamais un tableau.
 */
export const CONSOLIDATION_HEBDO_SYSTEM_PROMPT =
  "Tu es le module de consolidation hebdomadaire de la mémoire durable de Yuki. " +
  "Tu réponds UNIQUEMENT par un objet JSON en français, sans aucun autre texte, " +
  "sans balise de code.";

/**
 * ⚠️ ANTI-RÉCURSION : la passe de consolidation hebdomadaire n'a AUCUN outil.
 * `delegate` (délégation au worker lourd) est donc structurellement impossible :
 * une passe de mémoire ne peut pas lancer de tâche, ni écrire ailleurs.
 */
export const CONSOLIDATION_HEBDO_TOOLS: readonly string[] = Object.freeze([]);

export interface SdkMemoryExtractorConfig {
  cwd: string;
  agentDir: string;
  authPath: string;
  modelsPath: string;
  /** Référence `provider/modelId` utilisée pour l'extraction (ex. le léger).
   *  Une FONCTION est relue à chaque extraction ⇒ un changement de modèle
   *  (`apply: hot`) s'applique sans redémarrage. */
  modelReference: string | (() => string);
  thinking: PiThinkingLevel | (() => PiThinkingLevel);
  /** Allowlist d'outils (défaut : aucun). */
  tools?: readonly string[];
  /** Délai maximal d'une extraction (ms), lu à chaud : au-delà, on interrompt. */
  timeoutMs: () => number;
  /** Prompt système de la session éphémère (défaut : extraction par tour). */
  systemPrompt?: string;
  logger: PiLogger;
}

/** Fabrique l'extracteur SDK : `prompt → réponse brute du modèle`. */
export function createSdkMemoryExtractor(
  config: SdkMemoryExtractorConfig,
): MemoryExtractor {
  return async (prompt: string): Promise<string> => {
    const runtime = await getSharedModelRuntime({
      authPath: config.authPath,
      modelsPath: config.modelsPath,
    });
    const modelReference = liveValue(config.modelReference);
    const model = resolveSdkModel(runtime, modelReference);
    if (!model) {
      config.logger.warn("memory.extractor.model.unresolved", {
        model: modelReference,
      });
      return "";
    }
    const resolvedThinking =
      typeof config.thinking === "function" ? config.thinking() : config.thinking;
    const ephemeral = await createEphemeralSession({
      cwd: config.cwd,
      agentDir: config.agentDir,
      systemPrompt: config.systemPrompt ?? MEMORY_EXTRACTOR_SYSTEM_PROMPT,
      modelRuntime: runtime,
      model,
      thinkingLevel: resolvedThinking,
      tools: config.tools ?? [],
    });
    const { session } = ephemeral;

    let lastText = "";
    let currentText = "";
    const unsubscribe = session.subscribe((raw) => {
      const event = raw as { type?: unknown; message?: unknown; assistantMessageEvent?: unknown };
      if (event.type === "message_update") {
        const assistantEvent = event.assistantMessageEvent as
          | { type?: unknown; delta?: unknown }
          | undefined;
        if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
          currentText += assistantEvent.delta;
        }
        return;
      }
      if (event.type === "message_end") {
        const message = event.message as RawAgentMessage | undefined;
        if (!message || message.role !== "assistant") return;
        const content = contentTextFromMessage(message);
        if (content.length > 0) lastText = content;
        currentText = "";
      }
    });

    const timer = setTimeout(() => {
      void session.abort().catch(() => undefined);
    }, Math.max(1, config.timeoutMs()));
    timer.unref?.();

    try {
      await session.prompt(prompt, { expandPromptTemplates: false });
    } finally {
      clearTimeout(timer);
      unsubscribe();
      session.dispose();
    }
    return lastText || currentText;
  };
}

/**
 * Extracteur de la CONSOLIDATION HEBDOMADAIRE (lot 29) : même session éphémère,
 * même isolation, mais **AUCUN OUTIL** (`CONSOLIDATION_HEBDO_TOOLS`) et le
 * prompt système de l'objet JSON.
 *
 * ⚠️ Le modèle est celui qu'on lui passe (`modelReference`), et l'appelant
 * fournit le LOURD imposé, SANS repli sur le léger.
 */
export function createSdkConsolidationHebdoExtractor(
  config: Omit<SdkMemoryExtractorConfig, "tools" | "systemPrompt">,
): MemoryExtractor {
  return createSdkMemoryExtractor({
    ...config,
    // ⚠️ `tools: []` et rien d'autre : ni `delegate`, ni écriture. Anti-récursion.
    tools: [],
    systemPrompt: CONSOLIDATION_HEBDO_SYSTEM_PROMPT,
  });
}
