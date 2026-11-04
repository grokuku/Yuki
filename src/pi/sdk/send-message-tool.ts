/**
 * Outil custom `envoyer_message` — Yuki répond en PLUSIEURS MESSAGES SUCCESSIFS.
 *
 * ⚠️ CE QUE CET OUTIL APPORTE (demande utilisateur du 2026-11-04) : « est-ce que Yuki
 * saura faire des réponses étalées sur plusieurs messages ? (PI jusqu'à la 20ᵉ
 * décimale, avec une décimale par message) », puis « l'idée n'est pas de TIMER chaque
 * réponse, mais de les ENCHAÎNER automatiquement » et « je préfère l'appel d'outil,
 * même si c'est plus coûteux : c'est plus élégant ». Chaque appel publie donc UN
 * message, PENDANT le tour, sans aucun minuteur : l'enchaînement des appels EST
 * l'enchaînement des messages.
 *
 * ⚠️ UN SEUL CHEMIN DE PUBLICATION : ce n'est PAS ce fichier qui parle à la
 * plateforme. Il appelle le PORT fourni par le câblage, qui publie par
 * `ReplyProgress` (`src/chat/reply/progress.ts`) — donc la MÊME file sérialisée
 * (aucun `send` simultané), le MÊME ancrage au fil (`root_id`/`message_reference`) et
 * la MÊME forme de message que l'accusé, l'image ou la réponse finale. Un second
 * chemin doublerait la file et l'ordre.
 *
 * ⚠️ RÉSULTAT COURT, SANS LE TEXTE : le résultat d'outil entre dans l'historique du
 * modèle et y reste. Recopier le texte envoyé doublerait le coût du tour (le cas
 * d'usage envoie 20 messages) pour une information que le modèle vient d'écrire. On
 * rend donc un accusé de publication, jamais le contenu.
 *
 * ⚠️ DEUX REFUS EXPLICITES, jamais une troncature muette :
 *  - texte vide ⇒ RIEN n'est publié (pas de bulle vide dans le canal) ;
 *  - au-delà de `ENVOYER_MESSAGE_MAX_PAR_TOUR` messages dans le tour ⇒ refus qui
 *    NOMME le plafond, au lieu de laisser croire que le 21ᵉ est parti.
 */

import {
  defineTool,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * Nombre MAXIMAL de messages envoyés par TOUR.
 *
 * ⚠️ Vingt parce que c'est le cas d'usage mesuré (l'exemple « PI jusqu'à la 20ᵉ
 * décimale, une décimale par message ») : un plafond plus bas refuserait la demande
 * qui a motivé l'outil, un plafond plus haut transforme un canal en inondation.
 */
export const ENVOYER_MESSAGE_MAX_PAR_TOUR = 20;

/**
 * Borne HAUTE du paramètre `texte`, en points de code.
 *
 * ⚠️ La MÊME valeur que `publier_dans_canal` (`src/pi/sdk/channel-post-tool.ts`) :
 * c'est une borne de paramètre d'outil, pas la borne de la plateforme. Celle-ci est
 * appliquée à la publication, et la troncature y est DITE.
 */
export const ENVOYER_MESSAGE_MAX_CHARS = 40_000;

/** Issue d'une publication : toujours DITE, jamais un booléen muet. */
export type MessageSendOutcome =
  | {
      ok: true;
      /**
       * `true` quand la plateforme a imposé une coupe (le texte publié porte une
       * mention de troncature) : le modèle l'apprend, il ne croit donc jamais avoir
       * envoyé l'intégralité de son texte.
       */
      tronque: boolean;
    }
  | { ok: false; raison: string };

/** Demande de publication d'un message dans la conversation COURANTE. */
export interface MessageSendRequest {
  /** Texte du message (déjà vérifié non vide par l'outil). */
  texte: string;
  /**
   * Conversation de l'outil (`ctx`), pour le host LOCAL.
   *
   * ⚠️ Un run DISTANT l'ignore : sa conversation est FORCÉE (le canal), comme pour
   * tous les autres outils de `buildRemoteRunTools` (sa session est éphémère).
   */
  sessionId?: string;
}

/**
 * Port de publication d'un message dans la conversation courante.
 *
 * ⚠️ Il est fourni par le câblage : le host local publie dans sa session
 * (`PiHost.publierMessage`), un run de canal publie par `ReplyProgress`. L'outil ne
 * sait pas — et ne doit pas savoir — sur quelle plateforme il écrit.
 */
export interface MessageSendPort {
  envoyer: (request: MessageSendRequest) => Promise<MessageSendOutcome>;
  /**
   * CLÉ DU TOUR EN COURS, pour le compteur du plafond.
   *
   * ⚠️ ABSENTE pour un run de CANAL, et c'est correct : l'outil y est instancié PAR
   * TOUR (`buildRemoteRunTools`), donc son compteur repart à zéro tout seul.
   * ⚠️ NÉCESSAIRE en LOCAL : le host construit ses outils UNE fois et les partage
   * entre TOUTES les conversations (`createPiHost`) — un compteur unique y refuserait
   * le 21ᵉ message… de la vie du processus. La clé est le tour (`runId`) de la
   * conversation : le plafond redevient bien « par tour ».
   */
  tour?: (sessionId?: string) => string | undefined;
}

export interface SendMessageToolOptions {
  /**
   * Conversation FORCÉE (run distant : le canal). Absente ⇒ lue du contexte de
   * l'outil (host local), exactement comme `envoyer_fichier`.
   */
  sessionId?: () => string | undefined;
}

/** Détails structurés rendus par l'outil (rendu UI, jamais un contenu secret). */
interface SendMessageDetails {
  status: "envoye" | "refus" | "texte_vide" | "plafond";
  /** Numéro du message envoyé dans le tour (1 pour le premier). */
  numero?: number;
  plafond?: number;
  /** `true` quand la plateforme a imposé une coupe. */
  tronque?: boolean;
  /** Raison d'un refus, en français. */
  raison?: string;
}

/** Identifiant de la session (conversation) courante, ou `undefined`. */
function sessionIdFromContext(ctx: ExtensionContext | undefined): string | undefined {
  if (!ctx) return undefined;
  try {
    const id = ctx.sessionManager.getSessionId();
    return id && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Construit l'outil `envoyer_message`.
 *
 * L'outil est INSTANCIÉ PAR RUN : le compteur du plafond est donc propre au tour
 * (il repart à zéro au tour suivant), sans état partagé entre conversations.
 */
export function createSendMessageTools(
  port: MessageSendPort,
  options?: SendMessageToolOptions,
): ToolDefinition[] {
  /**
   * Messages RÉELLEMENT partis, PAR TOUR (source du plafond).
   *
   * ⚠️ Une MAP et pas un simple compteur : en LOCAL le host instancie ses outils une
   * seule fois pour toutes les conversations (voir `MessageSendPort.tour`).
   */
  const compteurs = new Map<string, number>();

  const tool = defineTool({
    name: "envoyer_message",
    label: "Envoyer un message tout de suite",
    description:
      "Envoie un message IMMÉDIATEMENT dans cette conversation, sans attendre la fin " +
      "de ton tour. Utilise-le pour répondre en PLUSIEURS messages successifs : un " +
      "appel = un message, publié tout de suite, dans l'ordre de tes appels. " +
      "C'est le bon outil quand on te demande une réponse étalée (« une décimale par " +
      "message », « une étape par message », « en plusieurs messages ») : appelle-le " +
      "une fois par message. " +
      "⚠️ N'en use PAS pour dire une seule chose que tu dirais en une seule réponse : " +
      "dans ce cas tu réponds normalement, sans outil. " +
      "Ce que tu envoies par cet outil est DÉJÀ publié : ne le répète pas dans ta " +
      "réponse finale (elle ne doit contenir que ce que tu n'as pas encore dit — ou " +
      "rien, si tu as tout dit). " +
      `Tu peux envoyer ${ENVOYER_MESSAGE_MAX_PAR_TOUR} messages au maximum dans un ` +
      "tour ; au-delà, l'outil refuse (rien n'est publié). " +
      "Un texte vide est refusé, et au-delà de la limite de la plateforme le texte " +
      "est tronqué avec une mention explicite.",
    promptSnippet:
      "envoyer_message(texte) — publie UN message tout de suite dans cette " +
      "conversation (pour répondre en plusieurs messages successifs)",
    parameters: Type.Object({
      texte: Type.String({
        maxLength: ENVOYER_MESSAGE_MAX_CHARS,
        description:
          "Texte EXACT du message à publier maintenant. Il ne doit pas répéter un " +
          "message déjà envoyé.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const brut = (params as { texte?: unknown }).texte;
      const texte = typeof brut === "string" ? brut : "";
      const sessionId = options?.sessionId?.() ?? sessionIdFromContext(ctx);
      // ⚠️ Clé du tour : par défaut, l'outil est déjà propre à UN tour (run de canal).
      const cle = port.tour?.(sessionId) ?? "tour";
      const envoyes = compteurs.get(cle) ?? 0;

      // ① TEXTE VIDE : aucune bulle vide n'est publiée, et le refus est explicite.
      if (texte.trim() === "") {
        const details: SendMessageDetails = { status: "texte_vide" };
        return {
          content: [
            {
              type: "text",
              text:
                "Rien n'a été envoyé : le message est vide. Donne le texte dans " +
                "l'argument `texte`.",
            },
          ],
          details,
        };
      }

      // ② PLAFOND DU TOUR : refus EXPLICITE (jamais une troncature muette). Le
      //    modèle apprend qu'il a atteint la limite, et la réponse finale reste le
      //    seul canal pour la suite.
      if (envoyes >= ENVOYER_MESSAGE_MAX_PAR_TOUR) {
        const details: SendMessageDetails = {
          status: "plafond",
          numero: envoyes,
          plafond: ENVOYER_MESSAGE_MAX_PAR_TOUR,
        };
        return {
          content: [
            {
              type: "text",
              text:
                `Rien n'a été envoyé : tu as atteint le maximum de ` +
                `${ENVOYER_MESSAGE_MAX_PAR_TOUR} messages pour ce tour. ` +
                "N'en envoie pas d'autre et ne réessaie pas : dis le reste dans ta " +
                "réponse finale, en une seule fois.",
            },
          ],
          details,
        };
      }

      let issue: MessageSendOutcome;
      try {
        issue = await port.envoyer({
          texte,
          ...(sessionId !== undefined && sessionId !== "" ? { sessionId } : {}),
        });
      } catch (error) {
        // ⚠️ Un échec de publication n'est jamais un succès silencieux : l'erreur
        // est rendue en français, et le plafond n'est PAS décompté (rien n'est parti).
        issue = {
          ok: false,
          raison: error instanceof Error ? error.message : String(error),
        };
      }

      if (!issue.ok) {
        const details: SendMessageDetails = { status: "refus", raison: issue.raison };
        return {
          content: [
            { type: "text", text: `Rien n'a été envoyé. ${issue.raison}` },
          ],
          details,
        };
      }

      const total = envoyes + 1;
      compteurs.set(cle, total);
      return {
        content: [
          {
            type: "text",
            text:
              `Message ${total} envoyé (${total}/${ENVOYER_MESSAGE_MAX_PAR_TOUR}). ` +
              "Il est DÉJÀ publié dans la conversation : ne le répète pas dans ta " +
              "réponse finale." +
              (issue.tronque
                ? " ATTENTION : le texte dépassait la limite de la plateforme et a " +
                  "été TRONQUÉ (la mention figure dans le message publié)."
                : ""),
          },
        ],
        details: {
          status: "envoye",
          numero: total,
          plafond: ENVOYER_MESSAGE_MAX_PAR_TOUR,
          tronque: issue.tronque,
        } satisfies SendMessageDetails,
      };
    },
  });

  return [tool];
}
