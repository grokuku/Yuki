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
import {
  createChannelPostRecorder,
  type ChannelPostRecorder,
} from "./channel-post-recorder.js";
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
   * bot Discord même quand l'autre plateforme est aussi active (les deux se
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
    contexte: ReplyRunContext,
  ) => RemoteRunTools;
  /** Écrivain SDK, construit avec le run (la politique y entre). */
  createWriter: (run: ReplyRun) => SdkPromptWriter;
  /**
   * FUSEAU des horodatages du prompt (réglage `/config` `ui.timeZone`, défaut
   * `UTC`), relu à CHAQUE réponse (`apply: hot`).
   *
   * ⚠️ Sans lui, `buildReplyPrompt` retombait sur le fuseau du PROCESS : un
   * conteneur en UTC et un hôte en `Europe/Paris` dataient le même fil
   * différemment — et différemment de Mattermost, qui est en UTC.
   *
   * Absent ⇒ `UTC` (`src/pi/timestamp.ts`).
   */
  timeZone?: () => string;
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
   * la réponse (`rootIdForReply`) : le générateur ne connaît ni le réglage
   * `replyStyle` du canal ni la règle de mention. Absente ⇒ aucune
   * publication intermédiaire (aucun changement pour un appelant qui n'en veut pas).
   */
  publier?: ProgressPublisher;
  /**
   * ORIGINE du tour : `job` = le message déclencheur est un RAPPORT SYSTÈME
   * (`src/chat/reply/job-report.ts`), pas une parole d'humain (défaut `message`).
   */
  origine?: "message" | "job";
  /**
   * FICHIERS produits par la tâche (identifiants du store de CETTE conversation).
   *
   * ⚠️ Ils sont joints à la réponse SAUF s'ils ont été publiés ailleurs dans le tour
   * (`publier_dans_canal`) : un fichier ne doit jamais partir deux fois.
   */
  fichiersDuJob?: readonly string[];
}

/**
 * CONTEXTE du tour transmis à la fabrique d'outils (`runTools`).
 *
 * ⚠️ Deux décisions structurelles en dépendent, jamais le prompt seul :
 *  - `origine` : un tour né d'un rapport de tâche ne peut pas DÉLÉGUER (aucune
 *    nouvelle tâche ⇒ aucune boucle de rédélégation) ;
 *  - `channelPosts` : le suivi des publications inter-canal du tour, pour que les
 *    fichiers du job ne soient pas joints à la réponse en plus d'avoir été publiés.
 */
export interface ReplyRunContext {
  origine: "message" | "job";
  channelPosts: ChannelPostRecorder;
  /**
   * PUBLIE un message DANS la conversation de ce tour (`envoyer_message`).
   *
   * ⚠️ Fourni par le générateur, jamais recopié côté câblage : c'est ce qui garantit
   * que les messages de l'outil passent par la MÊME `ReplyProgress` (même file, même
   * ancrage au fil) que l'accusé et la réponse finale. Absent ⇒ l'outil n'est pas
   * construit (aucun second chemin de publication).
   */
  publierMessage?: (texte: string) => Promise<void>;
}

/** Sortie : texte seul, ou texte + identifiants de fichiers à joindre. */
export type RemoteReplyOutcome = string | { text: string; fichiers?: readonly string[] };

/**
 * PLATEFORME d'un run distant.
 *
 * ⚠️ C'est la plateforme de la CONVERSATION qui décide, jamais le mode d'AFFICHAGE
 * : les deux plateformes se synchronisent INDÉPENDAMMENT l'une de l'autre. Un run né
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
    // plus réattaché à la réponse finale, qui arrive parfois plusieurs minutes après.
    const produits: string[] = [];
    // La progression est créée APRÈS la politique (elle a besoin de son allowlist),
    // mais `onFileProduced` ne tire que PENDANT le run : la fermeture est donc
    // toujours renseignée au moment où elle sert.
    let progress: ReplyProgress | undefined;
    // ⚠️ ORIGINE du tour : un rapport de tâche (`job`) ne relance AUCUN travail.
    const origine = input.origine ?? "message";
    // ⚠️ SUIVI des publications inter-canal de CE tour (état local) : il porte la
    // garantie « aucun fichier envoyé deux fois ». Un fichier du job publié ailleurs
    // n'est PAS re-joint à la réponse ; sans ce suivi, l'image apparaîtrait dans le
    // canal cible ET ici (défaut de production du 2026-11-02).
    const channelPosts = createChannelPostRecorder();
    const run = options.runTools(
      input.message.conversationId,
      (fileId) => {
        if (produits.includes(fileId)) return;
        produits.push(fileId);
        progress?.publierFichier(fileId);
      },
      {
        origine,
        channelPosts,
        // ⚠️ ENVOI DE MESSAGE (`envoyer_message`, 2026-11-04) : la publication passe
        // par la `ReplyProgress` de CE tour (créée juste après — d'où la fermeture
        // tardive), donc par la MÊME file sérialisée et le MÊME ancrage au fil que
        // l'accusé et la réponse. Si la progression n'existe pas (aucun `publier`),
        // la fonction lève : on ne prétend jamais avoir publié.
        ...(input.publier !== undefined
          ? {
              publierMessage: async (texte: string): Promise<void> => {
                if (progress === undefined) {
                  throw new Error(
                    "Publication impossible : aucune progression de réponse n'est active.",
                  );
                }
                await progress.envoyerTexte(texte);
              },
            }
          : {}),
      },
    );
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
      // ⚠️ Fuseau EXPLICITE (`ui.timeZone`, défaut UTC) : le prompt ne dépend
      // jamais du fuseau du process.
      ...(options.timeZone !== undefined ? { timeZone: options.timeZone() } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      // ⚠️ ORIGINE et FICHIERS du job : sans eux, Yuki lit un rapport qui parle
      // d'une image qu'elle ne peut ni nommer ni publier.
      ...(origine === "job" ? { origine: "job" as const } : {}),
      ...(input.fichiersDuJob !== undefined
        ? { fichiersDuJob: input.fichiersDuJob }
        : {}),
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
    const sansAck = progression !== undefined ? progression.retirerAck(brut) : brut;
    // ⚠️ MÊME PROBLÈME, EN PLUS GRAND (2026-11-04) : les messages déjà publiés par
    // `envoyer_message` ne doivent pas être republiés à la fin. C'est le drapeau
    // « j'ai déjà parlé » (compté par `ReplyProgress`) consulté ICI : si tout a été
    // dit, la réponse finale est vide et RIEN ne part (l'adaptateur sait qu'un tour
    // qui a déjà publié n'a pas besoin d'un second texte).
    const corps =
      progression !== undefined ? progression.retirerMessagesEnvoyes(sansAck) : sansAck;
    const agrege = progression?.resume();
    const texte =
      agrege === undefined
        ? corps
        : corps.trim() === ""
          ? agrege
          : `${corps}\n\n${agrege}`;

    // ⚠️ Les fichiers DÉJÀ postés ne sont pas réattachés (ils auraient deux fois).
    const restants = progression !== undefined ? progression.fichiersRestants(produits) : produits;
    // ⚠️ FICHIERS DU JOB : joints ici SAUF s'ils ont été publiés ailleurs dans le tour
    // (`publier_dans_canal`). C'est la seule raison d'avoir un suivi par tour.
    const publiesAilleurs = new Set(channelPosts.fichiersPublies());
    const duJob = (input.fichiersDuJob ?? []).filter(
      (id) => id !== "" && !publiesAilleurs.has(id) && !restants.includes(id),
    );
    for (const id of duJob) restants.push(id);
    if (channelPosts.echecs().length > 0) {
      options.logger?.warn?.("chat.channel_post.failed", {
        conversation: input.message.conversationId,
        echecs: channelPosts.echecs().length,
      });
    }
    return restants.length > 0 ? { text: texte, fichiers: restants } : texte;
  };
}
