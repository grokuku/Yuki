/**
 * Écrivain de RÉCAPITULATIF côté SDK (confidentiel — `src/pi/sdk/**`).
 *
 * ⚠️ CHEMIN ISOLÉ : chaque récapitulatif ouvre une session ÉPHÉMÈRE EN MÉMOIRE
 * (`SessionManager.inMemory`, via `createEphemeralSession`) — exactement comme
 * l'extracteur de mémoire. Le prompt de récapitulation ne touche JAMAIS la
 * session de l'utilisateur : il n'apparaît donc ni dans son historique ni dans son
 * transcript. Aucun outil n'est exposé (le modèle ne fait que rédiger).
 */

import { contentTextFromMessage, type RawAgentMessage } from "../events.js";
import type { PiLogger, PiThinkingLevel } from "../types.js";
import { RECAP_SYSTEM_PROMPT, type RecapWriter } from "../../recap/index.js";
import { getSharedModelRuntime, liveValue, resolveSdkModel } from "./model-runtime.js";
import { createEphemeralSession } from "./session-factory.js";

export interface SdkRecapWriterConfig {
  cwd: string;
  agentDir: string;
  authPath: string;
  modelsPath: string;
  /**
   * Référence `provider/modelId` utilisée pour le récapitulatif (ex. le LOURD).
   * Une FONCTION est relue à chaque appel ⇒ un changement de modèle (`apply: hot`)
   * s'applique sans redémarrage.
   */
  modelReference: string | (() => string);
  thinking: PiThinkingLevel;
  /** Délai maximal d'un récapitulatif (ms), lu à chaud : au-delà, on interrompt. */
  timeoutMs: () => number;
  logger: PiLogger;
}

/**
 * Fabrique l'écrivain SDK : `prompt → réponse brute du modèle`.
 *
 * ⚠️ Lève si le modèle est introuvable ou si aucun texte n'a été produit : le
 * service de récapitulatif traduit cet échec en message HONNÊTE, et AUCUNE
 * conversation n'est créée (règle « tout ou rien »).
 */
export function createSdkRecapWriter(config: SdkRecapWriterConfig): RecapWriter {
  return async (prompt: string): Promise<string> => {
    const runtime = await getSharedModelRuntime({
      authPath: config.authPath,
      modelsPath: config.modelsPath,
    });
    const modelReference = liveValue(config.modelReference);
    const model = resolveSdkModel(runtime, modelReference);
    if (!model) {
      config.logger.warn("recap.model.unresolved", { model: modelReference });
      throw new Error(`Modèle de récapitulatif introuvable : ${modelReference}`);
    }
    const ephemeral = await createEphemeralSession({
      cwd: config.cwd,
      agentDir: config.agentDir,
      systemPrompt: RECAP_SYSTEM_PROMPT,
      modelRuntime: runtime,
      model,
      thinkingLevel: config.thinking,
      tools: [],
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
