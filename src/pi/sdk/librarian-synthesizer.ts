/**
 * Rédacteur de synthèse d'archivage côté SDK (confidentiel — `src/pi/sdk/**`).
 *
 * ⚠️ CHEMIN ISOLÉ : chaque synthèse ouvre une session ÉPHÉMÈRE EN MÉMOIRE (une
 * rédaction = une session = une réponse). Le prompt de synthèse ne touche JAMAIS
 * la conversation de l'utilisateur : il n'apparaît ni dans son historique ni dans
 * son transcript.
 *
 * ⚠️ Modèle utilisé : le LÉGER, réflexion `off`. La synthèse est une tâche
 * MÉCANIQUE et bornée (mise en forme structurée d'une matière déjà fournie), pas
 * un raisonnement profond : on ne consomme pas le modèle lourd, et on reste hors
 * du chemin critique (l'appel a lieu en tâche de fond).
 */

import { contentTextFromMessage, type RawAgentMessage } from "../events.js";
import type { LibrarianSynthesizer } from "../../librarian/types.js";
import type { PiLogger, PiThinkingLevel } from "../types.js";
import { getSharedModelRuntime, resolveSdkModel } from "./model-runtime.js";
import { createEphemeralSession } from "./session-factory.js";

export interface SdkLibrarianSynthesizerConfig {
  cwd: string;
  agentDir: string;
  authPath: string;
  modelsPath: string;
  /** Référence `provider/modelId` utilisée (ex. le léger). */
  modelReference: string;
  thinking: PiThinkingLevel;
  /** Délai maximal d'une synthèse (ms), lu à chaud. */
  timeoutMs: () => number;
  systemPrompt: string;
  logger: PiLogger;
}

/** Fabrique le rédacteur SDK : `prompt → réponse brute du modèle` (chaîne vide si échec). */
export function createSdkLibrarianSynthesizer(
  config: SdkLibrarianSynthesizerConfig,
): LibrarianSynthesizer {
  return async (prompt: string): Promise<string> => {
    const runtime = await getSharedModelRuntime({
      authPath: config.authPath,
      modelsPath: config.modelsPath,
    });
    const model = resolveSdkModel(runtime, config.modelReference);
    if (!model) {
      config.logger.warn("librarian.synthesizer.model.unresolved", {
        model: config.modelReference,
      });
      return "";
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
    } catch (error) {
      config.logger.warn("librarian.synthesizer.failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return "";
    } finally {
      clearTimeout(timer);
      unsubscribe();
      session.dispose();
    }
    return lastText || currentText;
  };
}
