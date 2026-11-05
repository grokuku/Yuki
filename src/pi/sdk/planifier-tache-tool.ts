/**
 * Outil custom `planifier_tache` — Yuki FAIT AGIR un LLM plus tard (lot 31).
 *
 * ⚠️ CE QUE CET OUTIL AJOUTE, ET CE QUI LE DISTINGUE DE `programmer_envoi` :
 *
 *   - `programmer_envoi` publie un texte **DÉJÀ ÉCRIT** à l'heure dite. Aucun modèle
 *     n'est appelé : c'est gratuit, déterministe, et limité au texte (et à des fichiers
 *     déjà présents).
 *   - `planifier_tache` réveille un LLM à l'heure dite pour **AGIR** : l'instruction est
 *     une DEMANDE (« résume le journal », « génère une image de … », « lance la commande
 *     … via un agent »), exécutée par le worker lourd, dont le RÉSULTAT est publié dans
 *     la conversation demandeuse.
 *
 * C'est la différence entre « poste ce message à 16h10 » et « à 16h10, débrouille-toi
 * pour faire ça ».
 *
 * ⚠️ 1 APPEL = 1 TÂCHE. Deux heures ⇒ deux appels : un appel qui porterait deux
 * horaires obligerait le serveur à deviner laquelle va avec quoi.
 *
 * ⚠️ AUCUNE PRÉ-AUTORISATION : une tâche créée ici n'hérite d'aucune autorisation. Une
 * action qui exige une approbation humaine (`run_command` sur une machine appairée)
 * échouera PROPREMENT (message déjà écrit pour le worker, `src/sources/service.ts`), et
 * l'outil le DIT au modèle AVANT qu'il ne promette l'action.
 *
 * ⚠️ L'OUTIL NE DÉCIDE DE RIEN : bornes, fuseau, nom slugifié, quota, cible — tout est
 * tenu par le PORT (`SourcesService.planifierTache`). Un modèle ne peut donc pas
 * contourner une règle par le prompt.
 */

import {
  defineTool,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Demande de planification, telle que l'outil la transmet au port. */
export interface PlanifierTacheRequest {
  /** Délai relatif (`dans 30 min`), heure (`16:10`), jour relatif (`demain à 8 h`), ISO. */
  quand: string;
  /** Ce que le LLM devra FAIRE à l'heure dite. */
  instruction: string;
  /** Libellé libre ; omis ⇒ dérivé de l'instruction. */
  nom?: string;
  /** Conversation COURANTE du run — résolue par l'appelant, jamais par le modèle. */
  conversation: { session?: string };
}

/** Issue d'une planification : toujours DITE, jamais un booléen muet. */
export type PlanifierTacheOutcome =
  | {
      ok: true;
      /** Nom technique (slug dédupliqué) de la tâche créée. */
      nom: string;
      /** Libellé humain affiché dans la page de gestion. */
      libelle: string;
      /** Instant EFFECTIF en français, DATE COMPLÈTE et fuseau compris. */
      quandLisible: string;
      /** Où le résultat sera publié (« cette conversation », « le fil … »). */
      cibleLisible: string;
    }
  | { ok: false; raison: string };

/**
 * Port de planification : la SEULE autorité sur les bornes, le fuseau, le nom et la
 * cible. Fourni par le câblage (`src/index.ts`).
 */
export interface PlanifierTachePort {
  planifier: (request: PlanifierTacheRequest) => Promise<PlanifierTacheOutcome>;
}

export interface PlanifierTacheToolOptions {
  /**
   * Conversation COURANTE (résolue par l'appelant).
   * ⚠️ Host local : `{ session: sessionId }`. Un run de CANAL n'a pas de session locale :
   * l'outil n'y est pas construit (le résultat ne saurait pas où revenir).
   */
  conversation: (ctx?: ExtensionContext) => { session?: string };
}

/** Détails structurés rendus à l'interface (jamais un contenu secret). */
interface DetailsPlanification {
  status: "planifie" | "refus";
  nom?: string;
  quand?: string;
  cible?: string;
  raison?: string;
}

/** Identifiant de session du contexte de l'outil, ou `undefined`. */
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
 * Construit l'outil `planifier_tache`.
 *
 * ⚠️ Un seul outil, pas deux : il n'y a PAS de `annuler_tache` pour le modèle. Annuler
 * une tâche est un acte HUMAIN (page de gestion, confirmation `HolafModal`) — le modèle
 * peut programmer, il ne retire pas en silence quelque chose que la personne vient de
 * voir confirmé.
 */
export function createPlanifierTacheTools(
  port: PlanifierTachePort,
  options: PlanifierTacheToolOptions,
): ToolDefinition[] {
  const tool = defineTool({
    name: "planifier_tache",
    label: "Planifier une tâche (faire AGIR un LLM à une heure dite)",
    description:
      "Programme UNE tâche que TU exécuteras plus tard, à une heure précise : à l'heure " +
      "dite, un modèle est réveillé et FAIT ce que dit `instruction`, puis son résultat " +
      "est publié dans cette conversation. " +
      "⚠️ CET OUTIL FAIT AGIR : c'est pour « à 8 h, résume-moi le journal », « dans deux " +
      "heures, génère une image de … », « demain 9 h, lance la sauvegarde via l'agent ». " +
      "Si le texte est DÉJÀ PRÊT et qu'il suffit de le publier plus tard, n'utilise PAS " +
      "cet outil : utilise `programmer_envoi` (le texte est figé, aucun modèle n'est " +
      "appelé, c'est exactement ce qui a été montré). " +
      "⚠️ UN SEUL APPEL = UNE SEULE TÂCHE : pour deux heures différentes, fais DEUX " +
      "appels. " +
      "`quand` accepte un DÉLAI (« dans 30 min », « dans 2 h »), une HEURE (« 16:10 » — " +
      "aujourd'hui, ou demain si cette heure est déjà passée), un JOUR RELATIF " +
      "(« demain à 8 h », « après-demain 18:00 ») ou une date ISO comme " +
      "« 2026-11-04T16:10:00+01:00 ». Une date ISO déjà passée est refusée. " +
      "⚠️ Une tâche créée ici n'a AUCUNE pré-autorisation : une action qui exige une " +
      "approbation humaine (par exemple `run_command` sur une machine appairée) " +
      "échouera proprement — dis-le alors à la place, ne promets pas l'action. " +
      "Bornes : au moins 30 secondes d'avance, 30 jours au plus, 20 tâches en attente. " +
      "La tâche s'exécute UNE fois puis s'éteint ; elle reste visible et supprimable " +
      "dans Configuration → Déclencheurs.",
    promptSnippet:
      "planifier_tache(quand, instruction, nom?) — fait AGIR un LLM à une heure dite " +
      "(une seule tâche par appel ; texte déjà prêt ⇒ `programmer_envoi`)",
    parameters: Type.Object({
      quand: Type.String({
        maxLength: 100,
        description:
          "Moment de la tâche : un DÉLAI (« dans 30 min », « dans 2 h »), une HEURE " +
          "(« 16:10 » — aujourd'hui, ou demain si elle est passée), un JOUR RELATIF " +
          "(« demain à 8 h », « après-demain 18:00 ») ou une date ISO. L'heure dite est " +
          "celle de Yuki (Europe/Paris) quand aucun fuseau n'est précisé.",
      }),
      instruction: Type.String({
        maxLength: 4_000,
        description:
          "Ce qu'il faudra FAIRE à l'heure dite, écrit comme une demande complète " +
          "(« résume les messages non lus et dis-moi ce qui est urgent »). C'est cette " +
          "instruction qui sera exécutée — pas un texte publié tel quel.",
      }),
      nom: Type.Optional(
        Type.String({
          maxLength: 80,
          description:
            "Libellé court et lisible de la tâche (« Résumé du journal »), affiché dans " +
            "Configuration → Déclencheurs. Omis, il est dérivé de l'instruction.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const quandBrut = (params as { quand?: unknown }).quand;
      const quand = typeof quandBrut === "string" ? quandBrut.trim() : "";
      const instructionBrute = (params as { instruction?: unknown }).instruction;
      const instruction = typeof instructionBrute === "string" ? instructionBrute : "";
      const nomBrut = (params as { nom?: unknown }).nom;
      const nom = typeof nomBrut === "string" ? nomBrut.trim() : "";

      const conversation = options.conversation(ctx);
      const session = (conversation.session ?? "").trim();

      let issue: PlanifierTacheOutcome;
      try {
        issue = await port.planifier({
          quand,
          instruction,
          ...(nom !== "" ? { nom } : {}),
          conversation: session === "" ? {} : { session },
        });
      } catch (error) {
        // ⚠️ Un échec de planification n'est jamais un succès silencieux : la personne
        // croirait qu'une tâche tournera, et rien ne tournerait.
        issue = {
          ok: false,
          raison: error instanceof Error ? error.message : String(error),
        };
      }

      if (!issue.ok) {
        return {
          content: [{ type: "text", text: issue.raison }],
          details: { status: "refus", raison: issue.raison } satisfies DetailsPlanification,
        };
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Tâche « ${issue.libelle} » programmée pour le ${issue.quandLisible}. ` +
              `À ce moment-là, une tâche de fond exécutera l'instruction et son résultat ` +
              `sera publié dans ${issue.cibleLisible}. ` +
              "Elle s'exécute UNE seule fois, puis s'éteint (elle reste visible et " +
              "supprimable dans Configuration → Déclencheurs). " +
              "⚠️ Aucune pré-autorisation ne l'accompagne : une action qui exige une " +
              "approbation humaine échouera proprement à ce moment-là.",
          },
        ],
        details: {
          status: "planifie",
          nom: issue.nom,
          quand: issue.quandLisible,
          cible: issue.cibleLisible,
        } satisfies DetailsPlanification,
      };
    },
  });

  return [tool];
}

/** Session du contexte (exportée pour les tests et la fabrique locale). */
export { sessionIdFromContext };
