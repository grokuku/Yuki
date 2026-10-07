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
import { getSharedModelRuntime, resolveSdkModel } from "./model-runtime.js";
import { createEphemeralSession } from "./session-factory.js";

/** Prompt système de la session d'extraction (réponse = tableau JSON strict). */
export const MEMORY_EXTRACTOR_SYSTEM_PROMPT =
  "Tu es le module de mémoire durable de Yuki. Tu réponds UNIQUEMENT par un " +
  "tableau JSON en français, sans aucun autre texte, sans balise de code.";

export interface SdkMemoryExtractorConfig {
  cwd: string;
  agentDir: string;
  authPath: string;
  modelsPath: string;
  /** Référence `provider/modelId` utilisée pour l'extraction (ex. le léger). */
  modelReference: string;
  thinking: PiThinkingLevel;
  /** Allowlist d'outils (défaut : aucun). */
  tools?: readonly string[];
  /** Délai maximal d'une extraction (ms), lu à chaud : au-delà, on interrompt. */
  timeoutMs: () => number;
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
    const model = resolveSdkModel(runtime, config.modelReference);
    if (!model) {
      config.logger.warn("memory.extractor.model.unresolved", {
        model: config.modelReference,
      });
      return "";
    }
    const ephemeral = await createEphemeralSession({
      cwd: config.cwd,
      agentDir: config.agentDir,
      systemPrompt: MEMORY_EXTRACTOR_SYSTEM_PROMPT,
      modelRuntime: runtime,
      model,
      thinkingLevel: config.thinking,
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
