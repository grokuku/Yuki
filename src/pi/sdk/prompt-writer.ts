/**
 * Écrivain de prompt GÉNÉRIQUE côté SDK (confidentiel — `src/pi/sdk/**`).
 *
 * ⚠️ Même chemin ISOLÉ que le récapitulatif et l'extracteur de mémoire : chaque appel
 * ouvre une session ÉPHÉMÈRE EN MÉMOIRE (`createEphemeralSession`). Le prompt ne touche
 * JAMAIS la session de l'utilisateur : il n'apparaît ni dans son historique, ni dans son
 * transcript. Aucun outil n'est exposé — le modèle ne fait que RÉDIGER.
 *
 * Ce module existe pour que plusieurs usages (« récapituler », « juger un message
 * distant », « rédiger une réponse dans un canal ») partagent EXACTEMENT le même chemin
 * SDK, avec seulement trois différences : le prompt système, la référence de modèle et
 * le délai maximal. Dupliquer ce code aurait été le meilleur moyen d'en oublier une
 * moitié au prochain changement du SDK.
 */

import { contentTextFromMessage, type RawAgentMessage } from "../events.js";
import type { PiLogger, PiThinkingLevel } from "../types.js";
import { getSharedModelRuntime, liveValue, resolveSdkModel } from "./model-runtime.js";
import { createEphemeralSession } from "./session-factory.js";

/** Écrivain bas niveau : `prompt → texte du modèle`. */
export type SdkPromptWriter = (prompt: string) => Promise<string>;

export interface SdkPromptWriterConfig {
  cwd: string;
  agentDir: string;
  authPath: string;
  modelsPath: string;
  /** Prompt SYSTÈME de cet usage (le seul texte qui change d'un usage à l'autre). */
  systemPrompt: string;
  /** Référence `provider/modelId`, relue à chaque appel (`apply: hot`). */
  modelReference: string | (() => string);
  thinking: PiThinkingLevel;
  /** Délai maximal d'un appel (ms), lu à chaud : au-delà, on interrompt. */
  timeoutMs: () => number;
  logger: PiLogger;
  /** Libellé de l'usage dans les journaux et les erreurs (`récapitulatif`, `juge`…). */
  label: string;
}

/**
 * Fabrique l'écrivain : `prompt → réponse brute du modèle`.
 *
 * ⚠️ Lève si le modèle est introuvable ou si aucun texte n'a été produit : les
 * appelants traduisent cet échec en message HONNÊTE (jamais une réponse vide envoyée
 * comme si elle existait).
 */
export function createSdkPromptWriter(config: SdkPromptWriterConfig): SdkPromptWriter {
  return async (prompt: string): Promise<string> => {
    const runtime = await getSharedModelRuntime({
      authPath: config.authPath,
      modelsPath: config.modelsPath,
    });
    const modelReference = liveValue(config.modelReference);
    const model = resolveSdkModel(runtime, modelReference);
    if (!model) {
      config.logger.warn("sdk.prompt.model.unresolved", {
        label: config.label,
        model: modelReference,
      });
      throw new Error(`Modèle de ${config.label} introuvable : ${modelReference}`);
    }
    const ephemeral = await createEphemeralSession({
      cwd: config.cwd,
      agentDir: config.agentDir,
      systemPrompt: config.systemPrompt,
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
