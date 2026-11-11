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
  "Ce canal n'est pas suivi par Yuki : ajoutez-le dans Configuration → Conversation " +
  "→ « Discussions — Mattermost / Discord » " +
  "(les canaux suivis sont les seuls où elle peut écrire).";

/** Raison affichée quand le canal appartient à une AUTRE plateforme que le run. */
export const CANAL_AUTRE_PLATEFORME_RAISON =
  "Ce canal appartient à une autre plateforme que cette conversation : Yuki ne publie " +
  "que sur la plateforme du canal où elle se trouve.";

/** Raison affichée quand un fichier joint appartient à une AUTRE conversation. */
export const FICHIER_AUTRE_CONVERSATION_RAISON =
  "Ce fichier n'appartient pas à cette conversation : Yuki ne joint que les fichiers " +
  "qui lui ont été envoyés ici (ou qu'elle y a produits).";

/** Raison affichée quand un fichier joint vient d'une AUTRE plateforme. */
export const FICHIER_AUTRE_PLATEFORME_RAISON =
  "Ce fichier vient d'une autre plateforme que ce canal : un fichier Mattermost ne " +
  "part pas sur Discord, et inversement.";

/** Raison affichée quand aucun port de fichiers n'est branché (jamais un silence). */
export const FICHIER_INDISPONIBLE_RAISON =
  "Le stockage des fichiers n'est pas disponible dans ce processus : aucun fichier ne " +
  "peut être joint à la publication.";

export interface ChannelPostPortOptions {
  /** Plateforme du RUN : seuls les canaux de cette plateforme sont publiables. */
  plateforme: RemotePlatform;
  /**
   * Conversation SOURCE du run (le canal où Yuki se trouve).
   *
   * ⚠️ C'est la garde anti-FUITE : un fichier n'est publiable que s'il est rattaché
   * à CETTE conversation (`StoredFileRecord.sessionId`). Sans elle, un identifiant
   * suffirait à faire sortir un fichier d'une autre conversation (locale comprise).
   */
  conversationSource?: string;
  /** Canaux SUIVIS (lus dans le miroir à chaque appel : `apply: hot`). */
  canaux: () => readonly ChannelPostChannel[];
  /**
   * Envoi effectif (l'adaptateur de la plateforme). Lève en cas d'échec : le port
   * transforme l'exception en refus LISIBLE (jamais un succès silencieux).
   *
   * ⚠️ `fichierIds` : identifiants du STORE des fichiers Yuki, téléversés par
   * l'adaptateur (multipart) puis attachés au post (`file_ids`) — jamais des
   * chemins, jamais des octets qui traverseraient le prompt.
   */
  envoyer: (input: {
    conversationId: string;
    texte: string;
    filDe?: string;
    fichierIds?: readonly string[];
  }) => Promise<void>;
  /**
   * Résolution SERVEUR d'un identifiant de fichier (métadonnées seulement).
   * Absent ⇒ aucun fichier ne peut être joint (refus explicite, jamais un silence).
   */
  fichier?: (fichierId: string) => {
    sessionId?: string;
    name: string;
    bytes: number;
  } | null;
  /** Borne de TAILLE par fichier (octets), relue à chaque appel. */
  maxFichierBytes?: () => number;
  /** Borne de caractères d'un message, par plateforme (relue à chaque appel). */
  maxChars?: (plateforme: RemotePlatform) => number;
  /** Un message RACINE existe-t-il dans ce canal ? (garde sur `fil_de`). */
  filConnu?: (conversationId: string, remoteId: string) => boolean;
  /**
   * APPARTENANCE du canal au bot qui publie (lot 36, L5).
   *
   * ⚠️ Appelée AVANT tout appel réseau, juste après la résolution du canal :
   * un canal déjà possédé par un AUTRE bot est refusé en le NOMMANT, et rien
   * n'est publié. Sans cette garde, deux bots abonnés au même canal
   * répondraient deux fois au même message. Absente ⇒ aucune restriction
   * (mono-bot historique, où il n'y a qu'un bot).
   */
  autoriser?: (conversationId: string) => { ok: true } | { ok: false; raison: string };
  logger?: { warn(message: string, fields?: Record<string, unknown>): void };
}

/**
 * Nombre MAXIMAL de fichiers joints à une publication inter-canal.
 *
 * ⚠️ Trois : au-delà, ce n'est plus un message de canal mais un transfert — et
 * chaque fichier ajoute un téléversement (temps d'attente dans le canal). Le
 * dépassement est REFUSÉ en le disant, jamais tronqué en silence.
 */
export const CHANNEL_POST_MAX_FILES = 3;

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
 * Coupe `texte` aux BORNES de la plateforme — troncature TOUJOURS dite.
 *
 * ⚠️ Fonction PARTAGÉE, et c'est le point : `publier_dans_canal` (autre canal) et
 * `envoyer_message` (conversation courante) appliquent les MÊMES bornes, avec la
 * même mention de troncature. Deux implémentations divergeraient au premier
 * changement de limite, et le modèle croirait selon l'outil avoir tout publié.
 *
 * ⚠️ Bornes RÉUTILISÉES, jamais réécrites : `fitMattermostContent`
 * (`src/chat/mattermost/adapter.ts`) et `fitDiscordContent`
 * (`src/chat/discord/adapter.ts`).
 */
export function couperPourPlateforme(
  plateforme: RemotePlatform,
  texte: string,
  maxChars?: number,
): { texte: string; tronque: boolean; limite: number } {
  if (plateforme === "discord") {
    // ⚠️ Discord n'a pas de borne configurable : sa limite est un fait d'API.
    const ajuste = fitDiscordContent(texte);
    return {
      texte: ajuste,
      tronque: ajuste !== texte,
      limite: DISCORD_MAX_CONTENT_CHARS,
    };
  }
  const lue = maxChars;
  const limite =
    lue !== undefined && Number.isFinite(lue) && lue > 0
      ? Math.trunc(lue)
      : MM_DEFAULT_MAX_POST_CHARS;
  const coupe = fitMattermostContent(texte, limite);
  return { texte: coupe.texte, tronque: coupe.tronque, limite };
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

  return {
    canaux,
    publier: async ({ canal, texte, filDe, fichierIds }): Promise<ChannelPostOutcome> => {
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

      // ⚠️ APPARTENANCE (lot 36, L5) : un canal = un bot. Le contrôle passe AVANT
      // le fil, les bornes et l'appel réseau — un refus ici ne publie RIEN.
      const appartenance = options.autoriser?.(cible.conversationId);
      if (appartenance !== undefined && !appartenance.ok) {
        return {
          ok: false,
          raison: appartenance.raison,
          canaux: disponibles,
        };
      }

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
      const coupe = couperPourPlateforme(
        options.plateforme,
        texte,
        options.maxChars?.(options.plateforme),
      );
      const limite = coupe.limite;

      // ⚠️ BORNES FICHIERS, AVANT tout appel réseau : un binaire ne se tronque pas,
      // donc un dépassement est un REFUS explicite (jamais un envoi partiel).
      const fichiers = validerFichiers(fichierIds, options);
      if (!fichiers.ok) {
        return {
          ok: false,
          raison: fichiers.raison,
          ...(disponibles.length > 0 ? { canaux: disponibles } : {}),
        };
      }

      try {
        await options.envoyer({
          conversationId: cible.conversationId,
          texte: coupe.texte,
          ...(filDe !== undefined ? { filDe } : {}),
          ...(fichiers.ids.length > 0 ? { fichierIds: fichiers.ids } : {}),
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
        // ⚠️ Champ ABSENT quand aucun fichier n'est joint : une publication de
        // texte seul garde exactement la forme qu'elle avait.
        ...(fichiers.ids.length > 0 ? { fichiers: fichiers.ids.length } : {}),
      };
    },
  };
}

/**
 * Ce que la VALIDATION des fichiers a besoin de savoir (sous-ensemble du port).
 *
 * ⚠️ Type NARROW à dessein : la même validation sert à `publier_dans_canal` et aux
 * ENVOIS PROGRAMMÉS (`src/chat/envois/service.ts`, lot 28) — un second contrôle
 * écrit ailleurs divergerait au premier changement de borne.
 */
export interface ValidationFichiersOptions {
  plateforme: RemotePlatform;
  conversationSource?: string;
  fichier?: (fichierId: string) => { sessionId?: string; name: string; bytes: number } | null;
  maxFichierBytes?: () => number;
}

/**
 * VALIDE les fichiers demandés : propriété, plateforme, taille, nombre.
 *
 * ⚠️ Tout est vérifié AVANT l'appel réseau : un refus ici ne publie RIEN (ni texte,
 * ni fichier) — la personne n'a donc jamais un demi-message.
 *
 * ⚠️ L'ORDRE des contrôles est celui du DROIT : nombre (le modèle s'est trompé
 * d'outil) → résolution (le fichier existe-t-il ?) → propriété (fuite possible ?) →
 * plateforme → taille. Le premier refus est le plus utile à lire.
 *
 * ⚠️ EXPORTÉE (lot 28) : un ENVOI PROGRAMMÉ joint les mêmes fichiers que
 * `publier_dans_canal` et doit donc passer EXACTEMENT les mêmes contrôles, au moment
 * où il est programmé (à l'heure dite, il n'y a plus de run pour les revalider).
 */
export function validerFichiers(
  demandes: readonly string[] | undefined,
  options: ValidationFichiersOptions,
): { ok: true; ids: string[] } | { ok: false; raison: string } {
  if (demandes === undefined || demandes.length === 0) return { ok: true, ids: [] };
  const ids = demandes.map((id) => (typeof id === "string" ? id.trim() : "")).filter((id) => id !== "");
  if (ids.length > CHANNEL_POST_MAX_FILES) {
    return {
      ok: false,
      raison:
        `Rien n'a été publié : ${ids.length} fichiers demandés alors que ${CHANNEL_POST_MAX_FILES} ` +
        "au maximum peuvent être joints à un message. Publie le texte seul, puis les " +
        `fichiers en plusieurs messages (${CHANNEL_POST_MAX_FILES} par message au plus).`,
    };
  }
  if (options.fichier === undefined) {
    return { ok: false, raison: FICHIER_INDISPONIBLE_RAISON };
  }
  const borne = Math.max(1, Math.trunc(options.maxFichierBytes?.() ?? Number.POSITIVE_INFINITY));
  const uniques: string[] = [];
  for (const id of ids) {
    if (uniques.includes(id)) continue;
    const record = options.fichier(id);
    if (!record) {
      return {
        ok: false,
        raison:
          `Rien n'a été publié : le fichier « ${id} » est introuvable ou expiré. ` +
          "Liste les fichiers disponibles avec `lister_fichiers` avant de publier.",
      };
    }
    const source = record.sessionId ?? "";
    if (options.conversationSource !== undefined && source !== options.conversationSource) {
      // ⚠️ Plateforme DIFFÉRENTE : la raison le dit (« un fichier Mattermost ne part
      // pas sur Discord »), sinon on explique simplement l'appartenance.
      const autrePlateforme = platformOfConversation(source);
      return {
        ok: false,
        raison:
          autrePlateforme !== undefined && autrePlateforme !== options.plateforme
            ? FICHIER_AUTRE_PLATEFORME_RAISON
            : FICHIER_AUTRE_CONVERSATION_RAISON,
      };
    }
    if (record.bytes > borne) {
      return {
        ok: false,
        raison:
          `Rien n'a été publié : le fichier « ${record.name} » (${record.bytes} octets) ` +
          `dépasse la taille maximale d'un fichier (${borne} octets).`,
      };
    }
    uniques.push(id);
  }
  return { ok: true, ids: uniques };
}

/** Plateforme d'une conversation miroir (`mm-…` / `dc-…`), ou `undefined`. */
function platformOfConversation(conversationId: string): RemotePlatform | undefined {
  if (conversationId.startsWith("mm-")) return "mattermost";
  if (conversationId.startsWith("dc-")) return "discord";
  return undefined;
}
