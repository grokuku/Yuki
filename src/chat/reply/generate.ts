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
 *     conversation), publiés DÈS LEUR PRODUCTION dans le canal (lot 2) — ils ne sont
 *     plus réattachés à la réponse finale.
 *
 * ⚠️ Il porte aussi la PROGRESSION (`src/chat/reply/progress.ts`) : l'écrivain lui
 * signale le démarrage et la fin de chaque outil, et l'accusé part AVANT l'action.
 *
 * ⚠️ Reste DEHORS de ce module : la politique elle-même (`src/llm/tool-policy.ts`)
 * et les outils (`src/pi/sdk/remote-run-tools.ts`). Ici, uniquement le câblage —
 * c'est ce qui permet de le tester de bout en bout avec un vrai adaptateur, un
 * vrai store et un écrivain simulé.
 */

import type { SdkPromptWriter, RemoteRunTools, SdkToolEvent } from "../../pi/index.js";
import type { FileImageContent } from "../../files/index.js";
import type { ChatOriginMode } from "../../llm/tool-policy.js";
import { mirrorPlatformOf } from "../mirror.js";
import type { RemoteMessage } from "../types.js";
import { buildReplyPrompt } from "./prompt.js";
import { ReplyProgress, type ProgressLogger, type ProgressPublisher } from "./progress.js";

/** Un run distant : sa politique (allowlist) et ses définitions d'outils. */
export interface ReplyRun {
  tools: () => readonly string[];
  customTools: () => readonly unknown[];
  /**
   * EXTENSIONS INLINE du run (opaques ici) : elles portent la RÈGLE DE
   * DÉLÉGATION et la liste des jobs du CANAL, sous `chat.remoteAgents = actives`
   * (`createRemoteRunTools`, `src/pi/chat-run.ts`). Absentes ⇒ aucune extension
   * (comportement inchangé).
   */
  extensionFactories?: () => readonly unknown[];
  /**
   * Événements d'OUTIL du run (`tool_execution_start`/`_end`).
   *
   * ⚠️ C'est le SEUL moyen de publier un accusé AVANT que l'outil ne tourne :
   * sans lui, l'écrivain ne savait rien dire avant la fin du tour.
   */
  onTool?: (event: SdkToolEvent) => void;
  /**
   * BORNE (ms) des outils longs AUTORISÉS INLINE (`0` : aucun).
   *
   * ⚠️ Transmise par `createRemoteRunTools` (`src/pi/chat-run.ts`) : sous
   * `chat.remoteAgents = desactive`, `generer_image` s'exécute dans le tour, donc
   * le délai du tour doit couvrir `images.timeoutMs` — sinon la génération serait
   * coupée en plein vol.
   */
  inlineLongToolBudgetMs?: number;
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
  /**
   * Journal de la PROGRESSION (facultatif).
   *
   * ⚠️ Il sert à MESURER l'accusé en production : `chat.progress.ack` porte sa SOURCE
   * (`modele`/`repli`) et JAMAIS son texte. Si les `repli` dominent, c'est la consigne
   * du prompt qu'il faut renforcer. Absent ⇒ aucun journal (comportement inchangé).
   */
  logger?: ProgressLogger;
}

/** Entrée du générateur (forme du contrat `MattermostReplyGenerator`). */
export interface RemoteReplyInput {
  channelTitle: string;
  transcript: readonly RemoteMessage[];
  message: RemoteMessage;
  images?: readonly FileImageContent[];
  notes?: readonly string[];
  /**
   * Publication INTERMÉDIAIRE (accusé, image produite, échec) dans le canal.
   *
   * ⚠️ Construite par l'ADAPTATEUR, parce qu'elle doit être ancrée au MÊME fil que
   * la réponse (`rootIdForReply` + `composeReplyText`) : le générateur ne connaît ni
   * le réglage `replyStyle` du canal ni sa règle de citation. Absente ⇒ aucune
   * publication intermédiaire (aucun changement pour un appelant qui n'en veut pas).
   */
  publier?: ProgressPublisher;
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
  /**
   * ROTATION du repli d'accusé, PAR CONVERSATION.
   *
   * ⚠️ Même mécanisme que le host local (`record.ackFallbacks`) : sans compteur
   * partagé, chaque run repartirait de l'index 0 et le repli dirait TOUJOURS la même
   * phrase — exactement le défaut mécanique que l'accusé écrit par le modèle corrige.
   * Déterministe (donc reproductible en test), borné par le nombre de canaux suivis.
   */
  const replisAck = new Map<string, number>();
  return async (input: RemoteReplyInput): Promise<RemoteReplyOutcome> => {
    if (!options.available()) {
      // Jamais une réponse inventée : l'adaptateur traduit ce refus en message.
      throw new Error("Aucun modèle léger disponible : Yuki ne peut pas rédiger de réponse.");
    }

    // ⚠️ FICHIERS PRODUITS par CE run (image générée, copiée dans le store par
    // `generer_image`). Chacun part IMMÉDIATEMENT dans le canal (lot 2) : il n'est
    // plus réattaché à la réponse finale, qui arrive parfois trois minutes après.
    const produits: string[] = [];
    // La progression est créée APRÈS la politique (elle a besoin de son allowlist),
    // mais `onFileProduced` ne tire que PENDANT le run : la fermeture est donc
    // toujours renseignée au moment où elle sert.
    let progress: ReplyProgress | undefined;
    const run = options.runTools(input.message.conversationId, (fileId) => {
      if (produits.includes(fileId)) return;
      produits.push(fileId);
      progress?.publierFichier(fileId);
    });
    if (input.publier !== undefined) {
      const conversationId = input.message.conversationId;
      progress = new ReplyProgress({
        publier: input.publier,
        outils: run.tools,
        indexRepli: () => {
          const index = replisAck.get(conversationId) ?? 0;
          replisAck.set(conversationId, index + 1);
          return index;
        },
        ...(options.logger ? { logger: options.logger } : {}),
      });
    }
    const progression = progress;
    const writer = options.createWriter({
      tools: () => run.tools,
      customTools: () => run.customTools,
      // ⚠️ BORNE DU TOUR : les outils longs autorisés INLINE (sous `desactive`)
      // doivent tenir dans le délai de l'écrivain. Sans ce report, l'appel serait
      // coupé en plein vol — le défaut que le refus prétendait fermer.
      ...((run.inlineLongToolBudgetMs ?? 0) > 0
        ? { inlineLongToolBudgetMs: run.inlineLongToolBudgetMs as number }
        : {}),
      // ⚠️ RÈGLE DE DÉLÉGATION (lot 23) et CONSIGNE D'ACCUSÉ (lot 24) : transmises au run
      // quand sa politique les produit (`createRemoteRunTools`, `src/pi/chat-run.ts`). Sans
      // elles, le modèle exécutait le travail long INLINE et le tour était coupé ; et il
      // appelait l'outil SANS RIEN DIRE (c'était alors la table de repli qui parlait).
      // ⚠️ `ReplyRun` porte la LISTE, l'écrivain attend une FABRIQUE relue à chaque tour
      // (`apply: hot`) : d'où cette lambda, qui rend le tableau COURANT à chaque appel.
      ...(run.extensionFactories !== undefined
        ? { extensionFactories: () => run.extensionFactories ?? [] }
        : {}),
      ...(progression !== undefined
        ? {
            onTool: (event: SdkToolEvent): void => {
              if (event.phase === "start") {
                progression.demarrerOutil({
                  tool: event.tool,
                  ...(event.ackCandidat !== undefined ? { ackCandidat: event.ackCandidat } : {}),
                });
                return;
              }
              progression.terminerOutil({
                tool: event.tool,
                ...(event.isError === true ? { isError: true } : {}),
              });
            },
          }
        : {}),
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
    const brut =
      input.images !== undefined && input.images.length > 0
        ? await writer(prompt, { images: input.images })
        : await writer(prompt);

    // ⚠️ ORDRE GARANTI : on attend que les publications intermédiaires soient
    // PARTIES avant de rendre le texte, sinon la réponse finale pourrait arriver
    // avant l'image qu'elle commente.
    await progression?.attendre();
    // ⚠️ CLÔTURE : après ce point, plus AUCUNE publication intermédiaire n'est
    // possible. Un accusé qui arriverait APRÈS la réponse ne serait plus un accusé
    // (défaut signalé le 2026-11-02 : « s'il attend que tout soit fait pour le
    // poster, ça sert à rien ») : il est donc structurellement impossible.
    progression?.cloturer();

    // ⚠️ La ligne d'accusé a DÉJÀ été publiée : la laisser dans le corps la
    // dupliquerait à chaque tour. On ne retire QUE cette ligne-là (égalité stricte).
    const corps = progression !== undefined ? progression.retirerAck(brut) : brut;
    const agrege = progression?.resume();
    const texte =
      agrege === undefined
        ? corps
        : corps.trim() === ""
          ? agrege
          : `${corps}\n\n${agrege}`;

    // ⚠️ Les fichiers DÉJÀ postés ne sont pas réattachés (ils auraient deux fois).
    const restants = progression !== undefined ? progression.fichiersRestants(produits) : produits;
    return restants.length > 0 ? { text: texte, fichiers: restants } : texte;
  };
}
