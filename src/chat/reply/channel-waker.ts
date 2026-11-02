/**
 * RÉVEIL d'un job terminé dans un CANAL — **le rapport RÉVEILLE Yuki, il ne publie pas**.
 *
 * ⚠️ INVARIANT (exigence utilisateur, rappelée dans `docs/lot18-chat.md`) : **dans un
 * canal, un seul rédacteur — le tour de Yuki**. Le worker lourd REND un résultat, il
 * ne parle jamais ; le SERVEUR ne publie qu'en dernier recours, et quand il le fait,
 * il le DIT.
 *
 * ⚠️ LE DÉFAUT QUE CE MODULE CORRIGE (deux défauts, mesurés en production) :
 *  1. le seul réveil branché était le HOST PI, qui REFUSE une session qu'il n'a pas
 *     ouverte (« Session inconnue. », `src/pi/sdk-host.ts`) : un `delegate` lancé
 *     depuis Mattermost produisait un job dont le résultat n'arrivait nulle part ;
 *  2. corrigé, il a produit un SECOND RÉDACTEUR : le réveil RÉSUMAIT le rapport avec
 *     un écrivain dédié puis le PUBLIAIT — deux messages collés, deux images, un
 *     ordre cassé. Le rapport est désormais INJECTÉ comme message dans la conversation
 *     du canal (`src/chat/reply/job-report.ts`) : Yuki le lit, décide de ce qu'elle
 *     dit, et c'est SA réponse qui part.
 *
 * ⚠️ CE MODULE EST LE RÉVEIL COMPOSITE, et il ne double AUCUN mécanisme :
 *  - conversation LOCALE (session Pi) ⇒ délégation EXACTE à `fallback` (inchangé) ;
 *  - conversation de CANAL (identifiant miroir `mm-…`/`dc-…`) ⇒ `wake` (le tour de
 *    Yuki, qui publie lui-même) ;
 *  - `wake` en ÉCHEC (modèle injoignable, canal supprimé, tour sans réponse) ⇒
 *    REPLI EXPLICITE : le rapport part en TEXTE, précédé d'une phrase qui dit que
 *    c'est un repli. C'est le SEUL cas où le serveur écrit dans un canal.
 *
 * ⚠️ RÉUTILISATION, PAS UN SECOND MÉCANISME : le réveil des SOURCES fait exactement
 * la même chose pour une session Pi — un message ENCADRÉ, marqué d'une ORIGINE
 * (`src/sources/frame.ts`, `ORIGIN_SOURCE`, `SourcesWaker.send`), qui déclenche un
 * tour au lieu d'être publié. On reprend ce PATTERN à l'identique (encadrement +
 * origine marquée + bornes, `src/chat/reply/job-report.ts`) ; seul le TRANSPORT
 * change, parce qu'un canal n'est pas une session Pi : c'est l'adaptateur de la
 * plateforme qui ouvre le tour (`wakeReport`), pas le host. Écrire un second
 * réveil parallèle aurait produit exactement le doublon que ce module supprime.
 *
 * ⚠️ ORDRE : les réveils d'un MÊME canal sont SÉRIALISÉS (une file par
 * conversation). Deux réveils simultanés publieraient deux messages qui se
 * chevauchent — donc un ordre non garanti, et éventuellement un repli qui double un
 * tour de Yuki. Les canaux DIFFÉRENTS restent parallèles.
 */

import type { LightWaker } from "../../delegation/ports.js";
import { isMirrorConversationId } from "../mirror.js";
import type { ChatWakeRequest } from "../types.js";
import { frameRapportSysteme } from "./job-report.js";

/** Journal minimal (aucun type du SDK ne traverse ce module). */
export interface ChannelWakerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

/** Demande de réveil d'un canal — définie avec le contrat d'adaptateur (`ChatWakeRequest`). */
export type ChannelWakeRequest = ChatWakeRequest;

export interface ChannelWakerOptions {
  /** Réveil historique : les conversations LOCALES gardent leur comportement. */
  fallback: LightWaker;
  /**
   * RÉVEILLE Yuki DANS le canal : injecte le message et attend que SA réponse soit
   * publiée. Peut lever : l'échec déclenche le REPLI, jamais un silence.
   */
  wake: (request: ChannelWakeRequest) => Promise<void>;
  /**
   * REPLI : publie un TEXTE (et, s'il y en a, des FICHIERS) dans le canal.
   *
   * ⚠️ Ce n'est PAS le chemin normal : il ne sert que si `wake` a échoué, et le
   * texte publié le DIT (`reportFallbackText`). Peut lever (canal supprimé, jeton
   * expiré…) : l'échec est traité, jamais propagé.
   */
  post: (conversationId: string, text: string, fichiers?: readonly string[]) => Promise<void>;
  logger?: ChannelWakerLogger;
  /** Borne du texte injecté/publié (défaut `CHANNEL_REPORT_MAX_CHARS`). */
  maxChars?: number;
}

/** Caractères d'un rapport transmis au canal, au maximum : au-delà, on tronque et on le dit. */
export const CHANNEL_REPORT_MAX_CHARS = 4_000;

/**
 * Nombre maximal de FICHIERS joints à la réponse de Yuki.
 *
 * ⚠️ Un rapport agrège un LOT de jobs : sans borne, une tâche bavarde joindrait dix
 * images d'un coup. Au-delà, on joint les premiers et on DIT combien ne suivent pas —
 * le fichier reste dans le store de la conversation, jamais détruit en silence.
 */
export const CHANNEL_REPORT_MAX_FILES = 3;

/** Phrase qui dit qu'un fichier du job n'a pas pu être publié (jamais un silence). */
export function filesFailureText(count: number): string {
  const pluriel = count > 1 ? "s" : "";
  return (
    `[⚠️ ${count} fichier${pluriel} produit${pluriel} par la tâche n'a pas pu ` +
    "être joint" +
    `${pluriel} : il${pluriel ? "s restent" : " reste"} dans les fichiers de ` +
    "cette conversation (dis-moi de te l'envoyer).]"
  );
}

/** Phrase qui dit combien de fichiers produits restent NON joints (borne). */
export function filesOmittedText(omis: number): string {
  const pluriel = omis > 1 ? "s" : "";
  return (
    `[${omis} autre${pluriel} fichier${pluriel} produit${pluriel} : non joint${pluriel} ` +
    `ici (${CHANNEL_REPORT_MAX_FILES} au maximum). Il${pluriel ? "s restent" : " reste"} ` +
    "dans les fichiers de cette conversation.]"
  );
}

/**
 * Phrase du REPLI (le serveur parle : il doit le dire).
 *
 * ⚠️ Elle nomme l'identifiant du job pour que « où en est le job X » ait une
 * réponse, et elle annonce que le rapport brut suit — jamais de rapport muet, jamais
 * de prétention à un résumé qui n'a pas eu lieu.
 */
export function reportFallbackText(jobId?: string): string {
  const ref = jobId && jobId.length > 0 ? ` (job ${jobId})` : "";
  return (
    `⚠️ Repli : je n'ai pas pu reprendre la rédaction dans ce canal, donc voici le ` +
    `résultat BRUT de la tâche${ref}, tel quel.` +
    (jobId && jobId.length > 0 ? ` (demande-moi « où en est le job ${jobId} ».)` : "")
  );
}

/**
 * Réveil COMPOSITE : les conversations locales passent par `fallback`, les canaux
 * réveillent Yuki (et ne publient en texte qu'en dernier recours).
 */
export function createChannelAwareWaker(options: ChannelWakerOptions): LightWaker {
  const maxChars = options.maxChars ?? CHANNEL_REPORT_MAX_CHARS;
  /** File par CONVERSATION : deux réveils d'un même canal ne se chevauchent jamais. */
  const files = new Map<string, Promise<void>>();

  const borné = (text: string): string => {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n[…tronqué]`;
  };

  /** Sérialise une tâche par conversation (les canaux différents restent parallèles). */
  const enfiler = (conversationId: string, tache: () => Promise<void>): void => {
    const precedente = files.get(conversationId) ?? Promise.resolve();
    const suivante = precedente.then(tache, tache);
    // ⚠️ On ne laisse pas la promesse accumuler des rejets : `tache` ne lève jamais.
    files.set(
      conversationId,
      suivante.then(
        () => undefined,
        () => undefined,
      ),
    );
  };

  /**
   * Publication du REPLI : le rapport en TEXTE, précédé de la phrase qui le dit.
   *
   * ⚠️ Les fichiers sont joints APRÈS le texte, et un échec de fichier ne fait pas
   * perdre le texte (on retente SANS, en le disant) : un rapport sans son image reste
   * utile, un rapport perdu ne l'est jamais.
   */
  const replier = async (
    conversationId: string,
    texte: string,
    jobId: string | undefined,
    joints: readonly string[],
  ): Promise<void> => {
    const corps = borné(`${reportFallbackText(jobId)}\n\n${texte}`);
    try {
      await options.post(
        conversationId,
        corps,
        joints.length > 0 ? joints : undefined,
      );
    } catch (error) {
      if (joints.length === 0) {
        // ⚠️ Il n'y a AUCUN autre chemin : c'est le seul endroit où l'échec peut
        // être dit. Le taire ferait attendre la personne du canal pour toujours.
        options.logger?.warn("chat.job_report.failed", {
          conversation: conversationId,
          job_id: jobId ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      options.logger?.warn("chat.job_report.files_failed", {
        conversation: conversationId,
        job_id: jobId ?? null,
        fichiers: joints.length,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await options.post(
          conversationId,
          borné(`${corps}\n\n${filesFailureText(joints.length)}`),
        );
      } catch (second) {
        options.logger?.warn("chat.job_report.failed", {
          conversation: conversationId,
          job_id: jobId ?? null,
          error: second instanceof Error ? second.message : String(second),
        });
      }
    }
  };

  /** Réveil d'un canal : Yuki rédige ; le serveur ne parle qu'en repli. */
  const reveiller = async (
    conversationId: string,
    report: string,
    jobId: string | undefined,
    fichiers: readonly string[],
    repli: string | undefined,
  ): Promise<void> => {
    // ⚠️ BORNE des fichiers : les premiers sont joints, le reste est DIT (le fichier
    // n'est jamais détruit, il reste dans les fichiers de la conversation).
    const joints = fichiers.slice(0, CHANNEL_REPORT_MAX_FILES);
    const omis = fichiers.length - joints.length;
    // ⚠️ Le message injecté nomme les fichiers pour que Yuki puisse les PUBLIER
    // (`fichier_ids`) : sans leurs identifiants, elle ne les a pas.
    const texte = frameRapportSysteme({
      rapport: borné(omis > 0 ? `${report}\n\n${filesOmittedText(omis)}` : report),
      fichiers: joints,
      ...(repli !== undefined ? { repli } : {}),
      ...(jobId !== undefined ? { jobId } : {}),
    });
    options.logger?.info("chat.job_report.waking", {
      conversation: conversationId,
      job_id: jobId ?? null,
      fichiers: joints.length,
    });
    try {
      await options.wake({
        conversationId,
        texte,
        ...(jobId !== undefined ? { jobId } : {}),
        ...(joints.length > 0 ? { fichiers: joints } : {}),
      });
      return;
    } catch (error) {
      // ⚠️ SEUL CAS OÙ LE SERVEUR PARLE : le tour de Yuki n'a pas eu lieu (modèle
      // injoignable, canal disparu, file pleine). On publie le rapport en texte, et
      // on le DIT — un silence laisserait la personne attendre indéfiniment.
      options.logger?.warn("chat.job_report.wake_failed", {
        conversation: conversationId,
        job_id: jobId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      await replier(conversationId, texte, jobId, joints);
    }
  };

  return {
    send(sessionId, text, opts) {
      if (!isMirrorConversationId(sessionId)) {
        // Conversation LOCALE : comportement historique, à l'identique.
        return options.fallback.send(sessionId, text, opts);
      }
      enfiler(sessionId, () =>
        reveiller(
          sessionId,
          text,
          opts?.jobId,
          opts?.fichiers ?? [],
          opts?.repli,
        ),
      );
      // Aucun run Pi n'est ouvert ici : pas d'identifiant de run à rendre (le tour
      // de Yuki est celui du canal, suivi par son propre adaptateur).
      return undefined;
    },
  };
}
