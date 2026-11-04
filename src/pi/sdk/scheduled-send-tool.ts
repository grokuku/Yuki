/**
 * Outil custom `programmer_envoi` — Yuki publie un message PLUS TARD.
 *
 * ⚠️ CE QUE CET OUTIL CORRIGE (production, 2026-11-04 15:54) : « j'aimerais que tu
 * fasses une image… et que tu la postes à 16h10 dans l'Imagerie ». Yuki a répondu
 * « je ne peux pas la programmer pour 16h10 : je n'ai pas de minuteur ». C'était
 * exact POUR ELLE — le planificateur existe depuis le lot 2
 * (`src/sources/scheduler.ts`), mais aucun outil ne lui permettait de s'en servir.
 *
 * ⚠️ LE NOM DIT L'EFFET : `programmer_envoi` (et non `envoyer_plus_tard`) parce que
 * l'effet n'est pas seulement « partir plus tard » mais « créer un envoi PERSISTÉ,
 * VISIBLE dans la page de gestion et ANNULABLE » — c'est ce que « programmer » dit, et
 * c'est ce que la personne doit pouvoir vérifier. Le risque de confusion avec
 * `envoyer_message` (publication immédiate) est écarté par le radical différent.
 *
 * ⚠️ TEXTE FIGÉ : ce n'est PAS un tour différé. Aucun modèle n'est appelé à l'heure
 * dite — le texte stocké est publié tel quel. C'est ce qui rend l'envoi gratuit,
 * déterministe, et sûr : il ne peut pas dire autre chose que ce qui a été annoncé.
 *
 * ⚠️ L'OUTIL NE DÉCIDE DE RIEN : bornes, fuseau, plafond, canaux suivis et validation
 * des fichiers sont tenus par le PORT (`src/chat/envois/service.ts`), comme pour
 * `publier_dans_canal`. Un modèle ne peut donc pas contourner une règle par le prompt.
 */

import {
  defineTool,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ENVOYER_MESSAGE_MAX_CHARS } from "./send-message-tool.js";

/** Demande de programmation, telle que l'outil la transmet au port. */
export interface ScheduledSendRequest {
  /** Délai relatif (`dans 30 min`) ou instant (ISO, `16:10`). */
  quand: string;
  /** Texte FIGÉ du message (non vide, vérifié par le port). */
  texte: string;
  /** Identifiants du store à joindre (0 à 3). */
  fichierIds?: readonly string[];
  /** Canal cible (canal SUIVI) ; omis ⇒ la conversation courante. */
  canal?: string;
  /**
   * Conversation COURANTE du run — résolue par l'appelant, jamais par le modèle.
   * `canal` pour un run de canal (`buildRemoteRunTools`), `session` pour le host local.
   */
  conversation: { canal?: string; session?: string };
}

/** Issue d'une programmation : toujours DITE, jamais un booléen muet. */
export type ScheduledSendOutcome =
  | {
      ok: true;
      /** Instant EFFECTIF, en français, avec son fuseau (le modèle le répète). */
      quandLisible: string;
      /** Destination lisible (« L'Imagerie », « cette conversation »). */
      cibleLisible: string;
      /** `true` quand la plateforme a imposé une coupe (annoncée au modèle). */
      tronque: boolean;
      /** Nombre d'envois encore en attente (plafond `MAX_ENVOIS_EN_ATTENTE`). */
      enAttente: number;
    }
  | { ok: false; raison: string };

/**
 * Port de programmation : la SEULE autorité sur les bornes, le fuseau et la cible.
 *
 * ⚠️ Il est fourni par le câblage (`src/index.ts`, `src/pi/sdk-host.ts`) et testé
 * séparément. Un outil qui déciderait lui-même de l'horizon ou de la cible serait
 * contournable par le prompt.
 */
export interface ScheduledSendPort {
  programmer: (request: ScheduledSendRequest) => Promise<ScheduledSendOutcome>;
}

export interface ScheduledSendToolOptions {
  /**
   * Conversation COURANTE (résolue par l'appelant).
   *
   * ⚠️ Run de canal : `{ canal: conversationId }` (la cible par défaut est le canal).
   * Host local : `{ session: sessionId }` (la cible par défaut est le fil).
   */
  conversation: (ctx?: ExtensionContext) => { canal?: string; session?: string };
}

/** Détails structurés rendus à l'interface (jamais un contenu secret). */
interface ScheduledSendDetails {
  status: "programme" | "refus";
  quand?: string;
  cible?: string;
  tronque?: boolean;
  enAttente?: number;
  raison?: string;
}

/** Identifiant de session du contexte de l'outil (host local), ou `undefined`. */
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
 * Construit l'outil `programmer_envoi`.
 *
 * ⚠️ Un seul outil, pas deux : on ne crée pas un `annuler_envoi` pour le modèle. Une
 * annulation est un acte HUMAIN (page de gestion, confirmation `HolafModal`) — le
 * modèle peut programmer, il ne peut pas retirer en silence un envoi que la personne
 * vient de voir confirmé.
 */
export function createScheduledSendTools(
  port: ScheduledSendPort,
  options: ScheduledSendToolOptions,
): ToolDefinition[] {
  const tool = defineTool({
    name: "programmer_envoi",
    label: "Programmer un envoi (publier plus tard)",
    description:
      "Programme l'envoi d'un message à une heure PRÉCISE, dans cette conversation ou " +
      "dans un canal SUIVI. Le texte est FIGÉ : aucun modèle ne sera appelé à l'heure " +
      "dite, le message partira tel que tu l'écris maintenant. " +
      "Utilise-le dès qu'on te demande de publier « plus tard », « à 16h10 », « dans une " +
      "heure », « demain matin » : n'invente JAMAIS un minuteur, ne promets jamais une " +
      "publication que tu ne peux pas programmer, et ne dis pas que tu n'as pas de " +
      "minuteur — si cet outil est dans ta liste, tu peux programmer, et tu le fais. " +
      "`quand` accepte un DÉLAI (« dans 30 min », « dans 2 h », « dans 3 jours ») ou une " +
      "HEURE (« 16:10 » pour aujourd'hui, ou une date ISO comme " +
      "« 2026-11-04T16:10:00+01:00 »). " +
      "`canal` est FACULTATIF : omis, le message part dans cette conversation ; fourni, " +
      "il désigne un canal SUIVI (comme `publier_dans_canal`, qui te donne la liste). " +
      "`fichier_ids` joint des fichiers du store (trois au maximum, seulement des " +
      "fichiers de CETTE conversation, et seulement vers un canal). " +
      "Bornes : au moins 30 secondes d'avance, 30 jours au plus, 20 envois en attente " +
      "au total. Un refus dit toujours pourquoi. L'envoi est visible et annulable en " +
      "permanence dans Configuration → Déclencheurs → « Envois programmés ».",
    promptSnippet:
      "programmer_envoi(quand, texte, canal?, fichier_ids?) — publie un message PLUS " +
      "TARD (texte figé, aucun modèle appelé à l'heure dite)",
    parameters: Type.Object({
      quand: Type.String({
        maxLength: 100,
        description:
          "Moment de l'envoi : un DÉLAI (« dans 30 min », « dans 2 h », « dans 3 jours ») " +
          "ou une HEURE (« 16:10 » pour aujourd'hui, une date ISO comme " +
          "« 2026-11-04T16:10:00+01:00 »). L'heure dite est celle de Yuki " +
          "(Europe/Paris) quand aucun fuseau n'est précisé.",
      }),
      texte: Type.String({
        maxLength: ENVOYER_MESSAGE_MAX_CHARS,
        description:
          "Texte EXACT du message qui partira à l'heure dite. Il est FIGÉ : écris-le " +
          "comme s'il partait maintenant. Au-delà de la limite de la plateforme, il est " +
          "tronqué avec une mention explicite (et c'est dit dans le résultat).",
      }),
      canal: Type.Optional(
        Type.String({
          maxLength: 200,
          description:
            "Canal SUIVI où publier (nom lisible comme « L'Imagerie », ou identifiant " +
            "`mm-…`/`dc-…`). Omis ⇒ cette conversation. Un canal non suivi est refusé " +
            "avec la liste des canaux disponibles.",
        }),
      ),
      fichier_ids: Type.Optional(
        Type.Array(Type.String({ maxLength: 64 }), {
          // ⚠️ Même borne que `publier_dans_canal` (`maxItems: 3`,
          // `channel-post-tool.ts`) : le PORT applique la vraie borne
          // (`CHANNEL_POST_MAX_FILES`), celle-ci n'est qu'une indication de schéma.
          maxItems: 3,
          description:
            "Identifiants de fichiers à JOINDRE (ceux de `lister_fichiers`, ou une image " +
            "que tu viens de produire). Trois au maximum, et seulement vers un canal. Le " +
            "fichier doit appartenir à CETTE conversation : sinon rien n'est programmé.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const quandBrut = (params as { quand?: unknown }).quand;
      const quand = typeof quandBrut === "string" ? quandBrut.trim() : "";
      const texteBrut = (params as { texte?: unknown }).texte;
      const texte = typeof texteBrut === "string" ? texteBrut : "";
      const canalBrut = (params as { canal?: unknown }).canal;
      const canal = typeof canalBrut === "string" ? canalBrut.trim() : "";
      const fichiersBruts = (params as { fichier_ids?: unknown }).fichier_ids;
      const fichierIds = Array.isArray(fichiersBruts)
        ? fichiersBruts
            .map((id) => (typeof id === "string" ? id.trim() : ""))
            .filter((id) => id !== "")
        : [];

      const conversation = options.conversation(ctx);
      const courante =
        conversation.canal !== undefined
          ? { canal: conversation.canal }
          : conversation.session !== undefined
            ? { session: conversation.session }
            : {};
      if (courante.canal === undefined && courante.session === undefined) {
        const details: ScheduledSendDetails = { status: "refus" };
        return {
          content: [
            {
              type: "text",
              text:
                "Rien n'a été programmé : aucune conversation courante n'est identifiée, " +
                "donc la destination du message est inconnue. Précise `canal` (un canal suivi).",
            },
          ],
          details,
        };
      }

      let issue: ScheduledSendOutcome;
      try {
        issue = await port.programmer({
          quand,
          texte,
          ...(fichierIds.length > 0 ? { fichierIds } : {}),
          ...(canal !== "" ? { canal } : {}),
          conversation: courante,
        });
      } catch (error) {
        // ⚠️ Un échec de programmation n'est jamais un succès silencieux : la personne
        // croirait qu'un message partira, et il ne partirait pas.
        issue = {
          ok: false,
          raison: error instanceof Error ? error.message : String(error),
        };
      }

      if (!issue.ok) {
        return {
          content: [{ type: "text", text: issue.raison }],
          details: { status: "refus", raison: issue.raison } satisfies ScheduledSendDetails,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Envoi programmé pour le ${issue.quandLisible}, dans ${issue.cibleLisible}. ` +
              "Il partira TOUT SEUL : le texte est figé, aucun modèle ne sera appelé à " +
              "ce moment-là." +
              (issue.tronque
                ? " ATTENTION : le texte dépassait la limite de la plateforme et a été " +
                  "TRONQUÉ (la mention figure dans le message qui partira)."
                : "") +
              ` (${issue.enAttente} envoi(s) en attente au total ; annulable dans ` +
              "Configuration → Déclencheurs → « Envois programmés ».)",
          },
        ],
        details: {
          status: "programme",
          quand: issue.quandLisible,
          cible: issue.cibleLisible,
          tronque: issue.tronque,
          enAttente: issue.enAttente,
        } satisfies ScheduledSendDetails,
      };
    },
  });

  return [tool];
}

/** Session du contexte (exportée pour les tests et la fabrique locale). */
export { sessionIdFromContext };
