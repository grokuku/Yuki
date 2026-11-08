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
import { isAckTool } from "../ack.js";
import type { InlineExtension, ToolDefinition } from "@earendil-works/pi-coding-agent";
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

/**
 * ÉVÉNEMENT D'OUTIL d'un run distant : le DÉMARRAGE et la FIN d'un appel.
 *
 * ⚠️ Mêmes événements que le host LOCAL (`tool_execution_start` /
 * `tool_execution_end`, `src/pi/sdk-host.ts:785`, `:870`) : la progression publiée
 * dans un canal distant ne doit pas reposer sur une autre mécanique que celle qui
 * alimente déjà l'interface web.
 *
 * ⚠️ `ackCandidat` : le texte que le modèle a DÉJÀ ÉCRIT avant cet appel (blancs de
 * bord retirés, longueur NON bornée). C'est le CANDIDAT à l'accusé, pas l'accusé : la
 * décision de FORME appartient à `ReplyProgress` (`ackShapedText`, `src/pi/ack.ts`),
 * qui est aussi le seul endroit à tenir le verrou « un accusé par run ».
 *
 * ⚠️ Pourquoi le texte BRUT et non déjà filtré : un texte trop long ou multiligne n'est
 * PAS un accusé mais une RÉPONSE. Si l'écrivain le taisait, l'appelant ne pourrait pas
 * distinguer « le modèle est resté muet » (⇒ repli autorisé) de « le modèle a écrit une
 * réponse » (⇒ aucun accusé ne doit s'y ajouter). Le repli ne parle donc que sur un
 * silence RÉEL — règle identique au host local (`maybeAcknowledge`, `src/pi/sdk-host.ts`).
 */
export interface SdkToolEvent {
  phase: "start" | "end";
  tool: string;
  /** `true` quand l'outil s'est terminé en erreur (`phase: "end"`). */
  isError?: boolean;
  /** Texte du modèle écrit avant l'appel (`phase: "start"` seulement), brut. */
  ackCandidat?: string;
}

export interface SdkPromptWriterConfig {
  cwd: string;
  agentDir: string;
  authPath: string;
  modelsPath: string;
  /** Prompt SYSTÈME de cet usage (le seul texte qui change d'un usage à l'autre). */
  systemPrompt: string;
  /** Référence `provider/modelId`, relue à chaque appel (`apply: hot`). */
  modelReference: string | (() => string);
  thinking: PiThinkingLevel | (() => PiThinkingLevel);
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
   * EXTENSIONS INLINE du run, RELUES à chaque appel.
   *
   * ⚠️ C'est par là qu'entre la RÈGLE DE DÉLÉGATION d'un run de CANAL
   * (`createDelegationExtensionFactory`, `src/pi/sdk/delegation-extension.ts`) :
   * sans elle, le modèle d'un canal ignore qu'il peut déléguer, et exécute le
   * travail long INLINE — donc jusqu'à la coupure du tour, sans message.
   *
   * Absent ⇒ aucune extension (récapitulatif, juge, extracteur de mémoire :
   * comportement inchangé).
   */
  extensionFactories?: () => readonly unknown[];
  /**
   * Événements d'OUTIL du run, si l'appelant veut publier une progression.
   *
   * ⚠️ Absent ⇒ comportement INCHANGÉ (récapitulatif, juge, extracteur de
   * mémoire : aucun outil, donc aucun événement de toute façon). Un observateur
   * qui lève n'interrompt JAMAIS le run : son exception est avalée.
   */
  onTool?: (event: SdkToolEvent) => void;
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
      thinkingLevel:
        typeof config.thinking === "function"
          ? (config.thinking as () => PiThinkingLevel)()
          : config.thinking,
      // ⚠️ POLITIQUE DU RUN : vide par défaut (récapitulatif, juge, mémoire
      // n'agissent pas). Un run distant reçoit celle de son origine.
      tools: config.tools?.() ?? [],
      customTools: (config.customTools?.() ?? []) as readonly ToolDefinition[],
      // ⚠️ EXTENSIONS INLINE : la RÈGLE DE DÉLÉGATION d'un run de canal entre par
      // ici (mécanisme NON PERSISTÉ : on n'augmente que le prompt du tour).
      ...(config.extensionFactories
        ? {
            extensionFactories: (config.extensionFactories() ?? []) as readonly InlineExtension[],
          }
        : {}),
    });
    const { session } = ephemeral;

    let lastText = "";
    let currentText = "";
    /**
     * Le TEXTE DU MESSAGE ASSISTANT EN COURS (brut, jamais émis comme contenu ici).
     *
     * ⚠️ MÊME PRINCIPE QUE LE HOST LOCAL (`run.ackCandidate`, `src/pi/sdk-host.ts`) à une
     * différence près : ici, on ne RETIENT rien du flux (l'écrivain rend un texte, il
     * n'affiche pas), on en GARDE une copie jusqu'à savoir si l'outil qui démarre en fait
     * un accusé. Le texte reste donc intact dans `lastText` : l'appelant retire lui-même
     * la ligne déjà publiée (`ReplyProgress.retirerAck`).
     */
    let ackCandidat = "";
    /** Notifie l'observateur sans jamais casser le run (un journal ne jette pas). */
    const emitTool = (event: SdkToolEvent): void => {
      if (!config.onTool) return;
      try {
        config.onTool(event);
      } catch {
        // Un observateur défaillant ne doit pas interrompre la réponse.
      }
    };
    const unsubscribe = session.subscribe((raw) => {
      const event = raw as { type?: unknown; message?: unknown; assistantMessageEvent?: unknown };
      if (event.type === "message_start") {
        // Un message ASSISTANT commence : son texte peut être un accusé.
        const role = (event as { message?: { role?: unknown } }).message?.role;
        if (role !== "assistant") return;
        ackCandidat = "";
        return;
      }
      if (event.type === "message_update") {
        const assistantEvent = event.assistantMessageEvent as
          | { type?: unknown; delta?: unknown }
          | undefined;
        if (assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string") {
          currentText += assistantEvent.delta;
          ackCandidat += assistantEvent.delta;
        }
        return;
      }
      if (event.type === "tool_execution_start") {
        const tool = (event as { toolName?: unknown }).toolName;
        if (typeof tool !== "string" || tool === "") return;
        // ⚠️ Un outil de LECTURE ne consomme pas le candidat : si l'action longue vient
        // ensuite, le texte écrit avant la lecture reste le candidat (même règle qu'en
        // local, où `ackHolding` survit à un outil non déclencheur).
        const candidat = isAckTool(tool) ? ackCandidat.trim() : "";
        if (isAckTool(tool)) ackCandidat = "";
        emitTool({
          phase: "start",
          tool,
          ...(candidat !== "" ? { ackCandidat: candidat } : {}),
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        const tool = (event as { toolName?: unknown }).toolName;
        if (typeof tool !== "string" || tool === "") return;
        emitTool({
          phase: "end",
          tool,
          ...((event as { isError?: unknown }).isError === true ? { isError: true } : {}),
        });
        return;
      }
      if (event.type === "message_end") {
        const message = event.message as RawAgentMessage | undefined;
        if (!message || message.role !== "assistant") return;
        const content = contentTextFromMessage(message);
        if (content.length > 0) lastText = content;
        currentText = "";
        // ⚠️ Le message est clos : plus rien à retenir. Le message SUIVANT peut encore
        // porter un accusé (texte écrit après un outil) ; c'est `ReplyProgress` qui tient
        // le verrou « un accusé par run », jamais deux.
        ackCandidat = "";
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
