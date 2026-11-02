/**
 * RÉVEIL d'un job terminé quand sa conversation est un CANAL DISTANT.
 *
 * ⚠️ LE TROU QUE CE MODULE FERME (2026-11-02). Un `delegate` lancé depuis un
 * canal produit un job ASYNCHRONE. Son résultat est livré par le service de
 * délégation via un « réveil » (`LightWaker.send`), et le seul réveil branché en
 * production est le HOST PI (`src/index.ts`, `delegation.setWaker(host)`). Or le
 * host refuse une session qu'il ne connaît pas (`PI_SESSION_ERROR`,
 * « Session inconnue. », `src/pi/sdk-host.ts:2295`) : une conversation de canal
 * n'est PAS une session Pi. Résultat sans ce module : le job se termine, son
 * rapport est perdu, et **la personne dans le canal attend indéfiniment**.
 *
 * ⚠️ CE QUE CE MODULE FAIT : il enveloppe le réveil historique sans le modifier.
 *  - session Pi (conversation LOCALE) ⇒ délégation EXACTE à `fallback` (aucun
 *    changement de comportement, testé) ;
 *  - conversation de CANAL (identifiant miroir `mm-…`/`dc-…`) ⇒ le rapport est
 *    RÉSUMÉ par le modèle léger puis PUBLIÉ dans ce canal (adaptateur de la
 *    plateforme). Aucun run Pi n'est ouvert, aucune session fantôme.
 *
 * ⚠️ HONNÊTETÉ : si le résumé échoue, on publie quand même une phrase qui dit
 * la vérité (et qui donne l'identifiant du job, pour que « où en est le job X »
 * ait une réponse) ; si la PUBLICATION elle-même échoue, l'échec est journalisé
 * (`chat.job_report.failed`) — il n'y a rien d'autre à faire, et le taire serait
 * pire.
 */

import type { LightWaker } from "../../delegation/ports.js";
import { isMirrorConversationId } from "../mirror.js";

/** Journal minimal (aucun type du SDK ne traverse ce module). */
export interface ChannelWakerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ChannelWakerOptions {
  /** Réveil historique : les conversations LOCALES gardent leur comportement. */
  fallback: LightWaker;
  /**
   * Résume le rapport d'un job en une réponse publiable (modèle léger). Peut
   * lever : l'échec est traité, jamais propagé au service de délégation.
   */
  summarize: (report: string) => Promise<string>;
  /**
   * Publie un texte (et, s'il y en a, des FICHIERS) dans le canal. Peut lever
   * (canal supprimé, jeton expiré…) : l'échec est traité, jamais propagé.
   *
   * ⚠️ `fichiers` ne doit JAMAIS faire perdre le texte : un échec de publication
   * avec fichiers est RETENTÉ sans eux, en le disant (voir `publier`).
   */
  post: (conversationId: string, text: string, fichiers?: readonly string[]) => Promise<void>;
  logger?: ChannelWakerLogger;
  /** Borne du texte publié (défaut `CHANNEL_REPORT_MAX_CHARS`). */
  maxChars?: number;
}

/** Caractères publiés au maximum : au-delà, on tronque et on le dit. */
export const CHANNEL_REPORT_MAX_CHARS = 4_000;

/**
 * Nombre maximal de FICHIERS joints au rapport d'un job.
 *
 * ⚠️ Un rapport agrège un LOT de jobs : sans borne, une tâche bavarde posterait
 * dix images d'un coup dans le canal. Au-delà, on joint les premiers et on DIT
 * combien ne suivent pas — le fichier reste dans le store de la conversation,
 * jamais détruit en silence.
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

/** Phrase de repli quand le résumé n'a pas pu être produit (jamais un mensonge). */
export function reportFallbackText(jobId?: string): string {
  const ref = jobId && jobId.length > 0 ? ` (job ${jobId})` : "";
  return (
    `Une tâche d'arrière-plan lancée depuis ce canal s'est terminée${ref}, mais je ` +
    "n'ai pas pu en rédiger le résumé ici. Le résultat n'est pas perdu : demande-moi " +
    (jobId && jobId.length > 0 ? `« où en est le job ${jobId} »` : "l'état de la tâche") +
    " et je te le donnerai."
  );
}

/**
 * Réveil COMPOSITE : les conversations locales passent par `fallback`, les
 * canaux reçoivent une réponse publiée.
 */
export function createChannelAwareWaker(options: ChannelWakerOptions): LightWaker {
  const maxChars = options.maxChars ?? CHANNEL_REPORT_MAX_CHARS;

  const borné = (text: string): string => {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n[…tronqué]`;
  };

  /** Publication d'un rapport dans son canal (jamais bloquante pour l'appelant). */
  const publier = async (
    conversationId: string,
    report: string,
    jobId: string | undefined,
    fichiers: readonly string[],
  ): Promise<void> => {
    let texte = "";
    try {
      texte = (await options.summarize(report)).trim();
    } catch (error) {
      options.logger?.warn("chat.job_report.summary_failed", {
        conversation: conversationId,
        job_id: jobId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (texte === "") texte = reportFallbackText(jobId);
    // ⚠️ BORNE des fichiers : les premiers sont joints, le reste est DIT.
    const joints = fichiers.slice(0, CHANNEL_REPORT_MAX_FILES);
    const omis = fichiers.length - joints.length;
    if (omis > 0) texte = `${texte}\n\n${filesOmittedText(omis)}`;
    const texteBorne = borné(texte);
    try {
      await options.post(
        conversationId,
        texteBorne,
        joints.length > 0 ? joints : undefined,
      );
    } catch (error) {
      // ⚠️ ÉCHEC DE FICHIER ⇒ LE TEXTE PART QUAND MÊME. Un rapport sans son
      // image reste utile ; un rapport perdu ne l'est jamais. On retente donc
      // SANS les fichiers, en disant l'échec (jamais d'échec silencieux).
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
          borné(`${texteBorne}\n\n${filesFailureText(joints.length)}`),
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

  return {
    send(sessionId, text, opts) {
      if (!isMirrorConversationId(sessionId)) {
        // Conversation LOCALE : comportement historique, à l'identique.
        return options.fallback.send(sessionId, text, opts);
      }
      options.logger?.info("chat.job_report.publishing", {
        conversation: sessionId,
        job_id: opts?.jobId ?? null,
        origin: opts?.origin ?? null,
        fichiers: opts?.fichiers?.length ?? 0,
      });
      void publier(sessionId, text, opts?.jobId, opts?.fichiers ?? []);
      // Aucun run Pi n'est ouvert : pas d'identifiant de run à rendre.
      return undefined;
    },
  };
}
