/**
 * PORT de publication inter-canal — la seule autorité sur « où Yuki peut écrire ».
 *
 * ⚠️ DÉCISION A (utilisateur, 2026-11-02) : l'outil `publier_dans_canal` existe, mais
 * il est RESTREINT aux canaux SUIVIS (ceux du miroir `chat-mirror.json`) et à la
 * plateforme du run. Ce module porte cette restriction côté SERVEUR : le modèle ne peut
 * pas la contourner par le prompt, et un nom inventé est refusé (avec la liste réelle
 * des canaux disponibles en réponse).
 *
 * ⚠️ POURQUOI LE NOM PLUTÔT QUE L'IDENTIFIANT COMME PARAMÈTRE PRINCIPAL : un modèle qui
 * doit recopier un identifiant de 26 caractères se trompe (ou l'invente) ; le nom
 * lisible est ce que la personne dit (« l'Imagerie »). Les deux sont acceptés — le nom
 * est résolu ICI, par comparaison normalisée, et une ambiguïté est REFUSÉE plutôt que
 * devinée.
 *
 * ⚠️ BORNES RÉUTILISÉES, PAS RÉÉCRITES : `fitMattermostContent`
 * (`src/chat/mattermost/adapter.ts`) et `fitDiscordContent` (`src/chat/discord/adapter.ts`).
 * Une troncature est TOUJOURS dite au modèle, qui ne croit donc jamais avoir publié
 * l'intégralité de son texte.
 */

import { DISCORD_MAX_CONTENT_CHARS } from "../discord/types.js";
import { fitDiscordContent } from "../discord/adapter.js";
import { MM_DEFAULT_MAX_POST_CHARS, fitMattermostContent } from "../mattermost/adapter.js";
import type { RemotePlatform } from "../types.js";
import type { ChannelPostChannel, ChannelPostOutcome, ChannelPostPort } from "../../pi/index.js";

/** Raison affichée quand le canal demandé n'est pas suivi (jamais un simple « non »). */
export const CANAL_NON_SUIVI_RAISON =
  "Ce canal n'est pas suivi par Yuki : ajoutez-le dans Configuration → Discussions " +
  "(les canaux suivis sont les seuls où elle peut écrire).";

/** Raison affichée quand le canal appartient à une AUTRE plateforme que le run. */
export const CANAL_AUTRE_PLATEFORME_RAISON =
  "Ce canal appartient à une autre plateforme que cette conversation : Yuki ne publie " +
  "que sur la plateforme du canal où elle se trouve.";

export interface ChannelPostPortOptions {
  /** Plateforme du RUN : seuls les canaux de cette plateforme sont publiables. */
  plateforme: RemotePlatform;
  /** Canaux SUIVIS (lus dans le miroir à chaque appel : `apply: hot`). */
  canaux: () => readonly ChannelPostChannel[];
  /**
   * Envoi effectif (l'adaptateur de la plateforme). Lève en cas d'échec : le port
   * transforme l'exception en refus LISIBLE (jamais un succès silencieux).
   */
  envoyer: (input: {
    conversationId: string;
    texte: string;
    filDe?: string;
  }) => Promise<void>;
  /** Borne de caractères d'un message, par plateforme (relue à chaque appel). */
  maxChars?: (plateforme: RemotePlatform) => number;
  /** Un message RACINE existe-t-il dans ce canal ? (garde sur `fil_de`). */
  filConnu?: (conversationId: string, remoteId: string) => boolean;
  logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}

/** Normalise un nom de canal pour la comparaison (casse, `#`, espaces, apostrophes). */
export function normaliserNomCanal(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[#@]+/u, "")
    .replace(/[’']/gu, "'")
    .replace(/\s+/gu, " ");
}

/**
 * Résout un canal par NOM ou par IDENTIFIANT.
 *
 * Règles, dans cet ordre : identifiant exact → nom exact → UN SEUL nom qui contient la
 * recherche. Deux candidats pour la dernière règle ⇒ AMBIGU (refus, jamais un choix
 * silencieux : publier dans le mauvais canal est visible par toute l'équipe).
 */
export function resoudreCanal(
  canaux: readonly ChannelPostChannel[],
  demande: string,
): { ok: true; canal: ChannelPostChannel } | { ok: false; raison: string } {
  const brut = demande.trim();
  if (brut === "") {
    return { ok: false, raison: "Aucun canal n'a été précisé." };
  }
  const exactId = canaux.find((canal) => canal.conversationId === brut);
  if (exactId) return { ok: true, canal: exactId };

  const cible = normaliserNomCanal(brut);
  const exactNom = canaux.filter((canal) => normaliserNomCanal(canal.titre) === cible);
  if (exactNom.length === 1 && exactNom[0]) return { ok: true, canal: exactNom[0] };
  if (exactNom.length > 1) {
    return {
      ok: false,
      raison:
        `Plusieurs canaux portent le nom « ${brut} » : précisez l'identifiant ` +
        `(${exactNom.map((canal) => canal.conversationId).join(", ")}).`,
    };
  }

  const partiels = canaux.filter((canal) => normaliserNomCanal(canal.titre).includes(cible));
  if (partiels.length === 1 && partiels[0]) return { ok: true, canal: partiels[0] };
  if (partiels.length > 1) {
    return {
      ok: false,
      raison:
        `Plusieurs canaux correspondent à « ${brut} » : précisez le nom exact ou ` +
        `l'identifiant (${partiels.map((canal) => `« ${canal.titre} »`).join(", ")}).`,
    };
  }

  return { ok: false, raison: CANAL_NON_SUIVI_RAISON };
}

/**
 * Implémente le port de publication.
 *
 * ⚠️ Le port ne publie JAMAIS dans un canal absent de `canaux()` : c'est la restriction
 * « canaux suivis » de la décision A, et elle est vérifiée deux fois (plateforme, puis
 * résolution dans la liste filtrée).
 */
export function createChannelPostPort(options: ChannelPostPortOptions): ChannelPostPort {
  const canaux = (): ChannelPostChannel[] =>
    options.canaux().filter((canal) => canal.plateforme === options.plateforme);

  const borne = (plateforme: RemotePlatform): number => {
    const lue = options.maxChars?.(plateforme);
    if (lue !== undefined && Number.isFinite(lue) && lue > 0) return Math.trunc(lue);
    return plateforme === "discord" ? DISCORD_MAX_CONTENT_CHARS : MM_DEFAULT_MAX_POST_CHARS;
  };

  return {
    canaux,
    publier: async ({ canal, texte, filDe }): Promise<ChannelPostOutcome> => {
      const disponibles = canaux();
      // ⚠️ Un identifiant d'une AUTRE plateforme est refusé AVANT la résolution : c'est
      // une erreur de modèle fréquente, et le message doit dire pourquoi.
      const prefixeAutrePlateforme =
        (options.plateforme === "mattermost" && canal.trim().startsWith("dc-")) ||
        (options.plateforme === "discord" && canal.trim().startsWith("mm-"));
      if (prefixeAutrePlateforme) {
        return {
          ok: false,
          raison: CANAL_AUTRE_PLATEFORME_RAISON,
          ...(disponibles.length > 0 ? { canaux: disponibles } : {}),
        };
      }

      const resolution = resoudreCanal(disponibles, canal);
      if (!resolution.ok) {
        return {
          ok: false,
          raison: resolution.raison,
          ...(disponibles.length > 0 ? { canaux: disponibles } : {}),
        };
      }
      const cible = resolution.canal;

      if (filDe !== undefined && options.filConnu && !options.filConnu(cible.conversationId, filDe)) {
        return {
          ok: false,
          raison:
            "Rien n'a été publié : le message racine du fil demandé est introuvable dans " +
            "ce canal. Publie à la racine (sans `fil_de`) ou réponds à un message existant.",
          canaux: disponibles,
        };
      }

      // ⚠️ Borne appliquée AVANT l'appel : la plateforme refuserait le message entier
      // (`400`/`2000` caractères), donc la publication complète serait perdue.
      const limite = borne(options.plateforme);
      const coupe =
        options.plateforme === "discord"
          ? (() => {
              const ajuste = fitDiscordContent(texte);
              return { texte: ajuste, tronque: ajuste !== texte };
            })()
          : fitMattermostContent(texte, limite);

      try {
        await options.envoyer({
          conversationId: cible.conversationId,
          texte: coupe.texte,
          ...(filDe !== undefined ? { filDe } : {}),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger?.warn("chat.channel_post.failed", {
          canal: cible.conversationId,
          error: message,
        });
        return {
          ok: false,
          raison: `L'envoi a échoué : ${message}`,
          canaux: disponibles,
        };
      }

      if (coupe.tronque) {
        options.logger?.warn("chat.channel_post.truncated", {
          canal: cible.conversationId,
          limite,
          longueur: [...texte].length,
        });
      }

      return {
        ok: true,
        conversationId: cible.conversationId,
        titre: cible.titre,
        tronque: coupe.tronque,
      };
    },
  };
}
