/**
 * PORT de publication d'un message DANS LA CONVERSATION COURANTE (`envoyer_message`).
 *
 * ⚠️ CE QUE CE MODULE FERME (demande utilisateur du 2026-11-04) : Yuki ne savait
 * répondre qu'UN SEUL message par tour. Pour répondre « en plusieurs messages
 * successifs » (PI, une décimale par message), le modèle a besoin d'un outil qui
 * publie PENDANT son tour — sans minuteur, sans second tour.
 *
 * ⚠️ UN SEUL CHEMIN DE PUBLICATION : la publication effective est fournie par
 * l'appelant, qui est `ReplyProgress` (`src/chat/reply/progress.ts`). Ce module ne
 * parle à aucune plateforme, n'ouvre aucune file : il applique les BORNES de la
 * plateforme (les mêmes que `publier_dans_canal`, `src/chat/reply/channel-post.ts`),
 * puis délègue. Rien ici ne peut donc produire un `send` simultané ni un message
 * hors du fil de la réponse.
 *
 * ⚠️ RÉUTILISE, PAS RÉÉCRIT : `couperPourPlateforme` est la fonction PARTAGÉE avec
 * `publier_dans_canal`. Une borne recopiée divergerait au premier changement de
 * limite, et le modèle croirait selon l'outil avoir publié l'intégralité de son
 * texte.
 */

import type { MessageSendOutcome, MessageSendPort } from "../../pi/index.js";
import type { RemotePlatform } from "../types.js";
import { couperPourPlateforme } from "./channel-post.js";

export interface ReplyMessagePortOptions {
  /** Plateforme du run : c'est elle qui fixe la borne de caractères. */
  plateforme: RemotePlatform;
  /**
   * Publication effective — `ReplyProgress.envoyerTexte` de CE tour.
   *
   * ⚠️ Elle est asynchrone et rend la main quand le message est réellement parti :
   * l'outil ne dit jamais « envoyé » avant que la plateforme ait accepté.
   */
  publier: (texte: string) => Promise<void>;
  /**
   * Borne de caractères, relue à CHAQUE appel (réglage `apply: hot`).
   * Absente ⇒ borne par défaut de la plateforme.
   */
  maxChars?: () => number | undefined;
  logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}

/**
 * Implémente le port : borne, publication, issue DITE.
 *
 * Aucun échec silencieux : une exception de publication devient une raison lisible
 * en français, que l'outil rend au modèle (le texte n'est donc pas perdu, il reste
 * dans la réponse finale — `ReplyProgress` ne retient que ce qui est parti).
 */
export function createReplyMessagePort(options: ReplyMessagePortOptions): MessageSendPort {
  return {
    envoyer: async ({ texte }): Promise<MessageSendOutcome> => {
      // ⚠️ Un texte vide n'est jamais publié (aucune bulle vide) : l'outil le refuse
      // déjà, ceci est le second filet du port.
      if (texte.trim() === "") {
        return { ok: false, raison: "Le message est vide : rien n'a été publié." };
      }
      const coupe = couperPourPlateforme(options.plateforme, texte, options.maxChars?.());
      try {
        await options.publier(coupe.texte);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger?.warn("chat.message.failed", { error: message });
        return { ok: false, raison: `L'envoi a échoué : ${message}` };
      }
      if (coupe.tronque) {
        options.logger?.warn("chat.message.truncated", {
          limite: coupe.limite,
          longueur: [...texte].length,
        });
      }
      return { ok: true, tronque: coupe.tronque };
    },
  };
}
