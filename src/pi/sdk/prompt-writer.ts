/**
 * Écrivain de prompt GÉNÉRIQUE côté SDK (confidentiel — `src/pi/sdk/**`).
 *
 * ⚠️ Même chemin ISOLÉ que le récapitulatif et l'extracteur de mémoire : chaque appel
 * ouvre une session ÉPHÉMÈRE EN MÉMOIRE (`createEphemeralSession`). Le prompt ne touche
 * JAMAIS la session de l'utilisateur : il n'apparaît ni dans son historique, ni dans son
 * transcript.
 *
 * ⚠️ OUTILS : aucun par DÉFAUT (récapitulatif, juge, extracteur de mémoire ne font que
 * RÉDIGER). Le run d'une réponse dans un canal distant, lui, reçoit l'allowlist de sa
 * POLITIQUE (`tools`) et les définitions correspondantes (`customTools`) : c'est ce qui
 * rend `generer_image` atteignable depuis Mattermost.
 *
 * Ce module existe pour que plusieurs usages (« récapituler », « juger un message
 * distant », « rédiger une réponse dans un canal ») partagent EXACTEMENT le même chemin
 * SDK, avec seulement trois différences : le prompt système, la référence de modèle et
 * le délai maximal. Dupliquer ce code aurait été le meilleur moyen d'en oublier une
 * moitié au prochain changement du SDK.
 */

import { contentTextFromMessage, type RawAgentMessage } from "../events.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FileImageContent } from "../../files/types.js";
import type { PiLogger, PiThinkingLevel } from "../types.js";
import { getSharedModelRuntime, liveValue, resolveSdkModel } from "./model-runtime.js";
import { createEphemeralSession } from "./session-factory.js";

/**
 * Écrivain bas niveau : `prompt → texte du modèle`.
 *
 * ⚠️ `images` (facultatif) joint des pièces jointes au MÊME tour : c'est ce qui permet
 * au rédacteur d'un canal distant de VOIR une image postée sur Mattermost. Aucun
 * changement pour un message texte (les options du prompt restent alors identiques).
 */
export type SdkPromptWriter = (
  prompt: string,
  options?: { images?: readonly FileImageContent[] },
) => Promise<string>;

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
  /**
   * ALLOWLIST d'outils du run, RELUE à chaque appel.
   *
   * ⚠️ C'est ici que passe la POLITIQUE (`toolAllowlistForChat`,
   * `src/llm/tool-policy.ts`) : un run distant reçoit la sienne, calculée par le
   * câblage. Absent ⇒ aucun outil (rédacteur de récapitulatif, juge, extracteur
   * de mémoire : ces usages ne doivent RIEN exécuter).
   */
  tools?: () => readonly string[];
  /**
   * DÉFINITIONS des outils de l'allowlist, RELUES à chaque appel.
   *
   * ⚠️ Le SDK Pi FILTRE ces définitions par l'allowlist
   * (`dist/core/agent-session.js:_refreshToolRegistry`) : une définition absente
   * de `tools` n'est jamais exposée au modèle. Le type est volontairement
   * OPAQUE (`unknown`) : aucun type du SDK ne traverse la façade `src/pi`.
   */
  customTools?: () => readonly unknown[];
  /**
   * Fabrique de session éphémère. Injectable pour les TESTS (défaut :
   * `createEphemeralSession`). Permet de vérifier QUELLE allowlist et QUELS
   * outils sont réellement passés au SDK, sans modèle ni réseau.
   */
  createSession?: typeof createEphemeralSession;
}

/**
 * Fabrique l'écrivain : `prompt → réponse brute du modèle`.
 *
 * ⚠️ Lève si le modèle est introuvable ou si aucun texte n'a été produit : les
 * appelants traduisent cet échec en message HONNÊTE (jamais une réponse vide envoyée
 * comme si elle existait).
 */
export function createSdkPromptWriter(config: SdkPromptWriterConfig): SdkPromptWriter {
  return async (
    prompt: string,
    options: { images?: readonly FileImageContent[] } = {},
  ): Promise<string> => {
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
    const ephemeral = await (config.createSession ?? createEphemeralSession)({
      cwd: config.cwd,
      agentDir: config.agentDir,
      systemPrompt: config.systemPrompt,
      modelRuntime: runtime,
      model,
      thinkingLevel: config.thinking,
      // ⚠️ POLITIQUE DU RUN : vide par défaut (récapitulatif, juge, mémoire
      // n'agissent pas). Un run distant reçoit celle de son origine.
      tools: config.tools?.() ?? [],
      customTools: (config.customTools?.() ?? []) as readonly ToolDefinition[],
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

    // ⚠️ MÊME forme `ImageContent` que les autres chemins (`sdk-host.ts`). Quand le
    // modèle est déclaré SANS vision (`llm.<rôle>.vision = non`), le SDK remplace
    // l'image par une mention explicite : rien n'est jeté en silence.
    const images =
      options.images !== undefined && options.images.length > 0
        ? options.images.map((image) => ({
            type: "image" as const,
            data: image.data,
            mimeType: image.mimeType,
          }))
        : undefined;
    try {
      await session.prompt(prompt, {
        expandPromptTemplates: false,
        ...(images !== undefined ? { images } : {}),
      });
    } finally {
      clearTimeout(timer);
      unsubscribe();
      session.dispose();
    }
    return lastText || currentText;
  };
}
