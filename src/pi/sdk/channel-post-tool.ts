/**
 * Outil custom `publier_dans_canal` — Yuki PUBLIE un message dans un AUTRE canal.
 *
 * ⚠️ CE QUE CET OUTIL CORRIGE : en production, Yuki a répondu qu'écrire dans un autre
 * canal « demande une validation humaine qui ne s'affiche que dans l'interface web ».
 * C'était FAUX deux fois : aucune approbation n'était en jeu, et l'outil n'existait
 * simplement pas (voir `docs/lot20-chat-outils-distants.md`). Le prompt du rédacteur
 * portait la phrase fautive (`src/chat/reply/prompt.ts`, corrigée ici aussi).
 *
 * ⚠️ PÉRIMÈTRE — décision A (utilisateur, 2026-11-02) : l'outil n'écrit QUE dans les
 * canaux SUIVIS (ceux du miroir, `chat-mirror.json`), et seulement sur la plateforme du
 * run. Un canal hors miroir — ou d'une autre plateforme — est REFUSÉ avec une raison
 * actionnable ; ce refus est décidé par le PORT (`src/chat/reply/channel-post.ts`), pas
 * par ce fichier : le modèle ne peut pas contourner une règle posée côté serveur.
 *
 * ⚠️ AUCUNE APPROBATION : publier un message ne touche à aucune machine. L'outil est
 * donc dans `REMOTE_SAFE_TOOLS` (`src/llm/tool-policy.ts`) et disponible même sous
 * `chat.remoteAgents = desactive`.
 *
 * ⚠️ ANTI-BOUCLE : le message publié revient par le WebSocket et il est ingéré (l'UI
 * doit le voir). Son auteur est le compte du bot, donc `estBot`/`assistant` ⇒ il ne
 * déclenche AUCUNE réponse (`isOwnMessage`, `src/chat/mirror/ingest.ts`).
 */

import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Canal où Yuki peut publier (canaux SUIVIS, donc présents dans le miroir). */
export interface ChannelPostChannel {
  /** Identifiant Yuki préfixé (`mm-…` / `dc-…`). */
  conversationId: string;
  /** Titre affichable (nom du canal). */
  titre: string;
  /** Plateforme (`mattermost` | `discord`). */
  plateforme: string;
}

/** Demande de publication (le PORT décide de la résolution et des bornes). */
export interface ChannelPostRequest {
  /** Nom lisible du canal, ou son identifiant (`mm-…` / `dc-…`). */
  canal: string;
  /** Texte à publier (borné par la plateforme, troncature DITE). */
  texte: string;
  /** Message RACINE du fil où répondre (`root_id`), si fourni. */
  filDe?: string;
  /**
   * Identifiants du STORE des fichiers à joindre.
   *
   * ⚠️ Résolus CÔTÉ SERVEUR (`src/chat/reply/channel-post.ts`) : le fichier doit
   * appartenir à la conversation SOURCE du run (sinon fuite inter-conversations),
   * peser moins que `files.maxFileBytes`, et il y en a TROIS au plus. Aucun chemin
   * disque, aucun octet ne traverse le prompt.
   */
  fichierIds?: readonly string[];
}

/** Issue d'une publication : toujours DITE, jamais un booléen muet. */
export type ChannelPostOutcome =
  | {
      ok: true;
      /** Canal effectivement publié (identifiant Yuki). */
      conversationId: string;
      titre: string;
      /** `true` quand la plateforme a imposé une coupe (annoncée au modèle). */
      tronque: boolean;
      /** Fichiers RÉELLEMENT joints (0 quand aucun). */
      fichiers?: number;
    }
  | {
      ok: false;
      /** Raison en français, actionnable. */
      raison: string;
      /** Canaux réellement disponibles (pour que le modèle propose le bon). */
      canaux?: readonly ChannelPostChannel[];
    };

/**
 * Port de publication : la SEULE autorité sur « où Yuki a le droit d'écrire ».
 *
 * ⚠️ Il est fourni par le câblage (`src/index.ts`), implémenté par
 * `createChannelPostPort` (`src/chat/reply/channel-post.ts`) et testé séparément : un
 * outil qui déciderait lui-même du périmètre serait contournable par le prompt.
 */
export interface ChannelPostPort {
  /** Canaux où la publication est possible (déjà filtrés par plateforme). */
  canaux: () => readonly ChannelPostChannel[];
  /** Publie, ou refuse en EXPLIQUANT. Ne lève jamais pour un refus attendu. */
  publier: (request: ChannelPostRequest) => Promise<ChannelPostOutcome>;
}

/** Détails structurés rendus par l'outil (rendu UI, jamais un contenu secret). */
interface ChannelPostDetails {
  status: "liste" | "aucun_canal" | "texte_vide" | "refus" | "publie";
  /** Canaux disponibles (liste ou refus seulement). */
  canaux?: readonly ChannelPostChannel[];
  /** Canal visé (identifiant brut du modèle, ou identifiant résolu). */
  canal?: string;
  /** Raison d'un refus, en français. */
  raison?: string;
  /** Titre du canal effectivement publié. */
  titre?: string;
  /** `true` quand la plateforme a imposé une coupe. */
  tronque?: boolean;
  /** Nombre de fichiers réellement joints à la publication. */
  fichiers?: number;
}

/** Description du canal pour le modèle : titre ET identifiant (les deux sont acceptés). */
function describeChannel(channel: ChannelPostChannel): string {
  return `- « ${channel.titre} » (identifiant : ${channel.conversationId})`;
}

/**
 * Construit l'outil `publier_dans_canal`.
 *
 * Sans `canal`, l'outil LISTE les canaux où la publication est possible : c'est ce qui
 * permet au modèle de proposer le bon nom au lieu d'en inventer un.
 */
export function createChannelPostTool(port: ChannelPostPort): ToolDefinition[] {
  const tool = defineTool({
    name: "publier_dans_canal",
    label: "Publier un message dans un autre canal",
    description:
      "Publie un message dans un AUTRE canal que celui où tu es. Le canal se désigne " +
      "par son NOM lisible (celui affiché dans l'interface) ou par son identifiant. " +
      "Seuls les canaux SUIVIS sont accessibles : ceux de Configuration → Discussions, " +
      "sur la même plateforme que ce canal. Un canal non suivi est refusé, et l'outil " +
      "te dit lequel ajouter — ne réessaie pas un autre nom au hasard. Sans argument, " +
      "l'outil liste les canaux disponibles. " +
      "⚠️ TU PEUX JOINDRE DES FICHIERS (`fichier_ids`) : les identifiants viennent de " +
      "`lister_fichiers` (ou d'une image que tu viens de produire) et le fichier doit " +
      "appartenir à CETTE conversation ; trois fichiers au maximum par message. Un " +
      "fichier qui n'est pas d'ici, d'une autre plateforme, introuvable ou trop gros " +
      "est REFUSÉ (rien n'est publié). " +
      "La publication ne demande AUCUNE " +
      "validation : elle est immédiate (au-delà de la limite de la plateforme, le texte " +
      "est tronqué et c'est annoncé). ⚠️ Si ce canal n'est pas suivi, ou si l'outil " +
      "n'est pas disponible, dis simplement que tu ne peux pas publier là — n'invente " +
      "jamais une approbation, une validation humaine ou une limitation technique.",
    promptSnippet:
      "publier_dans_canal(canal?, texte?, fichier_ids?, fil_de?) — publie dans un canal " +
      "SUIVI, avec des fichiers du store si besoin (liste si `canal` est omis)",
    parameters: Type.Object({
      canal: Type.Optional(
        Type.String({
          maxLength: 200,
          description:
            "Nom lisible du canal (ex. « L'Imagerie ») ou son identifiant (`mm-…`). " +
            "Omis ⇒ liste des canaux où la publication est possible.",
        }),
      ),
      texte: Type.Optional(
        Type.String({
          maxLength: 40_000,
          description:
            "Texte du message. Au-delà de la limite de la plateforme (Mattermost " +
            "16 383 caractères par défaut, Discord 2 000), le message est tronqué avec " +
            "une mention explicite.",
        }),
      ),
      fil_de: Type.Optional(
        Type.String({
          maxLength: 100,
          description:
            "Identifiant du message RACINE du fil où publier (répondre dans un fil " +
            "existant). Omis ⇒ message à la racine du canal.",
        }),
      ),
      fichier_ids: Type.Optional(
        Type.Array(Type.String({ maxLength: 64 }), {
          maxItems: 3,
          description:
            "Identifiants de fichiers à JOINDRE (ceux de `lister_fichiers`, ou d'une " +
            "image que tu viens de produire). Trois au maximum. Le fichier doit " +
            "appartenir à CETTE conversation et à la même plateforme que le canal " +
            "cible : sinon la publication est refusée et rien ne part.",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const canalBrut = (params as { canal?: unknown }).canal;
      const canal = typeof canalBrut === "string" ? canalBrut.trim() : "";
      const texteBrut = (params as { texte?: unknown }).texte;
      const texte = typeof texteBrut === "string" ? texteBrut : "";
      const filBrut = (params as { fil_de?: unknown }).fil_de;
      const filDe = typeof filBrut === "string" && filBrut.trim() !== "" ? filBrut.trim() : undefined;
      const fichiersBruts = (params as { fichier_ids?: unknown }).fichier_ids;
      const fichierIds =
        Array.isArray(fichiersBruts)
          ? fichiersBruts
              .map((id) => (typeof id === "string" ? id.trim() : ""))
              .filter((id) => id !== "")
          : [];

      if (canal === "") {
        const canaux = port.canaux();
        const body =
          canaux.length === 0
            ? "Aucun canal n'est suivi : tu ne peux publier dans AUCUN autre canal. " +
              "Dis-le simplement à la personne qui te le demande (les canaux suivis se " +
              "règlent dans Configuration → Discussions)."
            : "Canaux où tu peux publier (nom lisible et identifiant) :\n" +
              canaux.map(describeChannel).join("\n") +
              "\n\nPour publier, appelle `publier_dans_canal` avec le NOM exact du " +
              "canal et le texte du message.";
        const details: ChannelPostDetails = {
          status: canaux.length === 0 ? "aucun_canal" : "liste",
          canaux,
        };
        return { content: [{ type: "text", text: body }], details };
      }

      if (texte.trim() === "" && fichierIds.length === 0) {
        const details: ChannelPostDetails = { status: "texte_vide", canal };
        return {
          content: [
            {
              type: "text",
              text:
                "Rien n'a été publié : il n'y a ni texte ni fichier à envoyer. Donne le " +
                "message dans l'argument `texte`, ou les identifiants de fichiers dans " +
                "`fichier_ids` (un message peut n'être qu'une pièce jointe).",
            },
          ],
          details,
        };
      }

      const outcome = await port.publier({
        canal,
        texte,
        ...(filDe !== undefined ? { filDe } : {}),
        ...(fichierIds.length > 0 ? { fichierIds } : {}),
      });
      if (!outcome.ok) {
        const liste =
          outcome.canaux === undefined || outcome.canaux.length === 0
            ? ""
            : "\n\nCanaux réellement disponibles :\n" +
              outcome.canaux.map(describeChannel).join("\n");
        const details: ChannelPostDetails = {
          status: "refus",
          canal,
          raison: outcome.raison,
          ...(outcome.canaux !== undefined ? { canaux: outcome.canaux } : {}),
        };
        return {
          content: [
            {
              type: "text",
              text: `Rien n'a été publié. ${outcome.raison}${liste}`,
            },
          ],
          details,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Message publié dans « ${outcome.titre} »` +
              ((outcome.fichiers ?? 0) > 0
                ? ` avec ${outcome.fichiers} pièce(s) jointe(s)`
                : "") +
              (outcome.tronque
                ? " — ATTENTION : le texte dépassait la limite de la plateforme et a " +
                  "été TRONQUÉ (la mention de troncature figure dans le message publié)."
                : ".") +
              " La publication ne demande aucune validation : elle est déjà visible " +
              "dans ce canal.",
          },
        ],
        details: {
          status: "publie",
          canal: outcome.conversationId,
          titre: outcome.titre,
          tronque: outcome.tronque,
          fichiers: outcome.fichiers ?? 0,
        } satisfies ChannelPostDetails,
      };
    },
  });

  return [tool];
}
