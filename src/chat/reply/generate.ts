/**
 * RÉDACTION d'une réponse dans un canal distant — avec OUTILS (lot 20).
 *
 * ⚠️ CE QUE CE MODULE FERME : la réponse d'un canal était écrite par un écrivain
 * de prompt à `tools: []` ⇒ **aucun run venu de Mattermost n'appelait d'outil**,
 * donc `generer_image` y était inatteignable, alors que l'utilisateur l'a exigé
 * (« je peux générer et analyser des images sur mattermost »).
 *
 * Il assemble les maillons, dans l'ordre, sans en doubler aucun :
 *  1. la POLITIQUE du run (`createRemoteRunTools`, `src/pi/chat-run.ts`) ;
 *  2. l'écrivain SDK, qui reçoit cette allowlist et ses définitions ;
 *  3. la COLLECTE des fichiers produits (image générée → fichier de la
 *     conversation), rendus à l'adaptateur qui les téléverse puis les attache
 *     au post (`file_ids`).
 *
 * ⚠️ Reste DEHORS de ce module : la politique elle-même (`src/llm/tool-policy.ts`)
 * et les outils (`src/pi/sdk/remote-run-tools.ts`). Ici, uniquement le câblage —
 * c'est ce qui permet de le tester de bout en bout avec un vrai adaptateur, un
 * vrai store et un écrivain simulé.
 */

import type { SdkPromptWriter, RemoteRunTools } from "../../pi/index.js";
import type { FileImageContent } from "../../files/index.js";
import type { ChatOriginMode } from "../../llm/tool-policy.js";
import { mirrorPlatformOf } from "../mirror.js";
import type { RemoteMessage } from "../types.js";
import { buildReplyPrompt } from "./prompt.js";

/** Un run distant : sa politique (allowlist) et ses définitions d'outils. */
export interface ReplyRun {
  tools: () => readonly string[];
  customTools: () => readonly unknown[];
}

export interface RemoteReplyGeneratorOptions {
  /** Le modèle léger est-il disponible ? Sinon le run REFUSE explicitement. */
  available: () => boolean;
  /**
   * Nom affiché du bot (préfixe du prompt), **par PLATEFORME DU RUN**.
   *
   * ⚠️ La conversation est passée EXPRÈS : un run né dans un salon Discord doit nommer le
   * bot Discord même quand `chat.mode` affiche Mattermost (les deux plateformes se
   * synchronisent indépendamment du mode). Un `botName()` sans argument ne pouvait lire que
   * le mode GLOBAL, donc se tromper de plateforme.
   */
  botName: (conversationId: string) => string;
  /**
   * Politique + outils du canal, recalculés à CHAQUE réponse (`apply: hot`).
   *
   * ⚠️ `onFileProduced` est passé ICI (jamais recopié côté câblage) : c'est le
   * SEUL moyen pour que l'image générée au milieu de la boucle d'outils remonte
   * jusqu'au message publié.
   */
  runTools: (
    conversationId: string,
    onFileProduced: (fileId: string) => void,
  ) => RemoteRunTools;
  /** Écrivain SDK, construit avec le run (la politique y entre). */
  createWriter: (run: ReplyRun) => SdkPromptWriter;
}

/** Entrée du générateur (forme du contrat `MattermostReplyGenerator`). */
export interface RemoteReplyInput {
  channelTitle: string;
  transcript: readonly RemoteMessage[];
  message: RemoteMessage;
  images?: readonly FileImageContent[];
  notes?: readonly string[];
}

/** Sortie : texte seul, ou texte + identifiants de fichiers à joindre. */
export type RemoteReplyOutcome = string | { text: string; fichiers?: readonly string[] };

/**
 * PLATEFORME d'un run distant.
 *
 * ⚠️ C'est la plateforme de la CONVERSATION qui décide, jamais le mode d'AFFICHAGE
 * (`chat.mode`) : les deux plateformes se synchronisent INDÉPENDAMMENT du mode. Un run né
 * dans un salon Discord alors que l'interface regarde Mattermost doit se nommer « bot
 * Discord » et recevoir la politique d'outils d'un run Discord.
 *
 * Le mode global ne sert de repli QUE pour un identifiant qui n'est pas un miroir — cas
 * qui ne devrait pas arriver, mais qui ne doit pas produire un nom de bot inventé.
 */
export function runPlatformOf(conversationId: string, chatMode: ChatOriginMode): ChatOriginMode {
  return mirrorPlatformOf(conversationId) ?? chatMode;
}

/**
 * Fabrique le générateur de réponse d'un canal distant.
 *
 * ⚠️ Les fichiers produits sont rendus à l'appelant : c'est l'adaptateur qui les
 * téléverse (`POST /files`) et les attache (`file_ids`). Sans ce retour, une
 * image générée resterait dans le store et n'arriverait jamais dans le canal.
 */
export function createRemoteReplyGenerator(
  options: RemoteReplyGeneratorOptions,
): (input: RemoteReplyInput) => Promise<RemoteReplyOutcome> {
  return async (input: RemoteReplyInput): Promise<RemoteReplyOutcome> => {
    if (!options.available()) {
      // Jamais une réponse inventée : l'adaptateur traduit ce refus en message.
      throw new Error("Aucun modèle léger disponible : Yuki ne peut pas rédiger de réponse.");
    }

    // ⚠️ FICHIERS PRODUITS par CE run (image générée, copiée dans le store par
    // `generer_image`). Collectés ICI, rendus avec le texte.
    const produits: string[] = [];
    const run = options.runTools(input.message.conversationId, (fileId) => {
      if (!produits.includes(fileId)) produits.push(fileId);
    });
    const writer = options.createWriter({
      tools: () => run.tools,
      customTools: () => run.customTools,
    });

    const prompt = buildReplyPrompt({
      channelTitle: input.channelTitle,
      transcript: input.transcript,
      message: input.message,
      botName: options.botName(input.message.conversationId),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    });
    // ⚠️ `images` n'est passé que s'il y en a : les options du prompt restent alors
    // EXACTEMENT celles d'un message texte (aucune surprise pour un modèle sans vision).
    const texte =
      input.images !== undefined && input.images.length > 0
        ? await writer(prompt, { images: input.images })
        : await writer(prompt);

    // ⚠️ La collecte se fait PAR RÉFÉRENCE : `runTools` a reçu le tableau, il l'a
    // rempli pendant le run (l'image est produite au milieu de la boucle d'outils).
    return produits.length > 0 ? { text: texte, fichiers: produits } : texte;
  };
}
