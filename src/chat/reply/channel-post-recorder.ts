/**
 * SUIVI des publications inter-canal d'un TOUR de canal — aucun double envoi.
 *
 * ⚠️ INVARIANT (exigence utilisateur, `docs/lot18-chat.md`) : **dans un canal, un
 * seul rédacteur — le tour de Yuki**. Ce module ne publie rien lui-même : il
 * ENVELOPPE le port existant (`createChannelPostPort`, `src/chat/reply/channel-post.ts`)
 * pour que le tour sache ce qu'il a RÉELLEMENT publié ailleurs.
 *
 * ⚠️ LE DÉFAUT QUE CE MODULE FERME. Un job produit une image ; elle arrive au tour
 * de Yuki (rapport injecté, `src/chat/reply/job-report.ts`) et elle est JOINTE à sa
 * réponse — c'est la règle : la personne qui a demandé la tâche doit recevoir le
 * fichier. Mais si la demande était « publie-la dans l'Imagerie, pas ici », Yuki
 * l'a publiée avec `publier_dans_canal` : la joindre EN PLUS à sa réponse ferait
 * apparaître l'image DEUX FOIS (une dans le canal cible, une ici), ce qui est
 * exactement le défaut de production du 2026-11-02.
 *
 * ⚠️ L'état est LOCAL À UN TOUR (jamais partagé entre deux tours, sinon un tour
 * hériterait des publications d'un autre).
 *
 * ⚠️ Le périmètre (« canaux SUIVIS, même plateforme, fichiers de la conversation
 * source ») n'est PAS décidé ici : il reste tenu par le port.
 */

import type { ChannelPostPort, ChannelPostRequest } from "../../pi/index.js";

/** Tentative de publication restée sans effet (le modèle la reçoit, il la dit). */
export interface ChannelPostFailure {
  /** Canal demandé par le modèle (`canal` de la requête, tel quel). */
  readonly canal: string;
  /** Raison du refus ou de l'échec, en français (celle du port). */
  readonly raison: string;
}

/** Suivi des publications d'UN tour. */
export interface ChannelPostRecorder {
  /** Enveloppe le port : retient ce qui a été publié, et ce qui a échoué. */
  wrap(port: ChannelPostPort): ChannelPostPort;
  /** Identifiants de fichiers RÉELLEMENT publiés par l'outil (jamais re-joints). */
  fichiersPublies(): readonly string[];
  /** Publications restées sans effet, dans l'ordre des tentatives. */
  echecs(): readonly ChannelPostFailure[];
}

/** Crée le suivi d'un tour (état vide). */
export function createChannelPostRecorder(): ChannelPostRecorder {
  const publies: string[] = [];
  const echecs: ChannelPostFailure[] = [];

  return {
    wrap(port: ChannelPostPort): ChannelPostPort {
      return {
        canaux: () => port.canaux(),
        publier: async (request: ChannelPostRequest) => {
          const outcome = await port.publier(request);
          if (outcome.ok) {
            // ⚠️ On retient les identifiants DEMANDÉS (le port a validé chacun
            // d'eux avant l'envoi) : ce sont exactement ceux qui sont arrivés.
            for (const id of request.fichierIds ?? []) {
              if (!publies.includes(id)) publies.push(id);
            }
          } else {
            echecs.push({ canal: request.canal, raison: outcome.raison });
          }
          return outcome;
        },
      };
    },

    fichiersPublies: () => publies,
    echecs: () => echecs,
  };
}
