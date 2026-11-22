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

import { createGestionTachesTools } from "./taches-gestion-tools.js";

/** Demande de planification, telle que l'outil la transmet au port. */
export interface PlanifierTacheRequest {
  /**
   * Délai relatif (`dans 30 min`), heure (`16:10`), jour relatif (`demain à 8 h`), ISO.
   * ⚠️ ABSENT quand `recurrence` est fourni (les deux voies sont exclusives) — c'est le
   * PORT qui refuse un appel qui porterait les deux.
   */
  quand?: string;
  /** Ce que le LLM devra FAIRE à l'heure dite. */
  instruction: string;
  /** Libellé libre ; omis ⇒ dérivé de l'instruction. */
  nom?: string;
  /**
   * RÉCURRENCE BRUTE du modèle (`{ type, heure, jour, heures, jourDuMois }`).
   * ⚠️ `unknown` À DESSEIN : elle est validée par le PORT (`validerRecurrence`), pas ici.
   */
  recurrence?: unknown;
  /** Fin de récurrence par NOMBRE de passages (1–10 000). */
  occurrencesMax?: number;
  /** Fin de récurrence par DATE (ISO). */
  jusquAu?: string;
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
      /** Instant EFFECTIF en français (ponctuelle) ou récurrence lisible. */
      quandLisible: string;
      /** Où le résultat sera publié (« cette conversation », « le fil … »). */
      cibleLisible: string;
      /** `true` quand la tâche créée est une RÉCURRENCE (déclencheur durable). */
      recurrence?: true;
    }
  | { ok: false; raison: string };

/**
 * Une TÂCHE telle que le port la rend à `lister_taches`.
 *
 * ⚠️ Aucune donnée de coffre, aucun chemin : ce qui permet d'AGIR (id, horaire, état,
 * raison d'une extinction).
 */
export interface TacheVue {
  nom: string;
  libelle: string;
  genre: "ponctuelle" | "recurrence";
  instruction: string;
  planification: string;
  prochaineLisible: string;
  etat: "actif" | "suspendu";
  raison?: string;
  occurrencesMax?: number;
  occurrencesFaites?: number;
  jusquAu?: string;
  cible: "conversation" | "declencheurs";
}

/** Demande de MODIFICATION d'une tâche (`modifier_tache`). */
export interface ModifierTacheRequest {
  /** Identifiant rendu par `lister_taches` (ou par `planifier_tache`). */
  id: string;
  nom?: string;
  instruction?: string;
  quand?: string;
  /** RÉCURRENCE BRUTE, validée par le PORT. */
  recurrence?: unknown;
  occurrencesMax?: number | null;
  jusquAu?: string | null;
}

/** Issue d'une modification : la tâche à jour, ou une raison LISIBLE du refus. */
export type ModifierTacheOutcome =
  | {
      ok: true;
      tache: TacheVue;
      prochaineLisible: string;
      compteurInvalide: boolean;
    }
  | { ok: false; raison: string };

/** Issue d'une suppression : le nom retiré, ou une raison LISIBLE du refus. */
export type SupprimerTacheOutcome =
  | { ok: true; nom: string; libelle: string }
  | { ok: false; raison: string };

/**
 * Port des TÂCHES : la SEULE autorité sur les bornes, le fuseau, le nom, la cible et le
 * périmètre (les tâches de CE bot, créées par le modèle).
 *
 * ⚠️ `lister` / `modifier` / `supprimer` sont OPTIONNELS : un host construit à la main
 * (tests, host nu) peut ne porter que `planifier`. Les trois outils de gestion ne sont
 * alors pas construits, plutôt que d'annoncer une capacité absente.
 */
export interface PlanifierTachePort {
  planifier: (request: PlanifierTacheRequest) => Promise<PlanifierTacheOutcome>;
  lister?: () => Promise<TacheVue[]>;
  modifier?: (request: ModifierTacheRequest) => Promise<ModifierTacheOutcome>;
  supprimer?: (request: { id: string }) => Promise<SupprimerTacheOutcome>;
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
      "Bornes : au moins 30 secondes d'avance, 20 tâches en attente. Aucune limite de " +
      "DATE : une heure lointaine (« dans trois mois », « le 1ᵉʳ janvier ») est acceptée. " +
      "⚠️ RÉCURRENCE : pour une demande RÉPÉTÉE (« tous les matins à 8 h », « chaque " +
      "lundi 9 h », « toutes les 6 heures », « le 1ᵉʳ du mois 10 h »), donne `recurrence` " +
      "AU LIEU de `quand` — les deux sont EXCLUSIFS. La récurrence devient un déclencheur " +
      "durable : elle reste visible et MODIFIABLE dans Configuration → Déclencheurs, et " +
      "elle tourne jusqu'à ce qu'on l'arrête (`occurrences_max` ou `jusqu_au` pour une fin). " +
      "Une tâche ponctuelle s'exécute UNE fois puis s'éteint. " +
      "⚠️ `lister_taches`, `modifier_tache` et `supprimer_tache` gèrent ensuite ces tâches " +
      "sans passer par l'interface.",
    promptSnippet:
      "planifier_tache(quand | recurrence, instruction, nom?) — fait AGIR un LLM à une " +
      "heure dite, une fois ou de façon récurrente (texte déjà prêt ⇒ `programmer_envoi`)",
    parameters: Type.Object({
      quand: Type.Optional(
        Type.String({
          maxLength: 100,
          description:
            "Moment de la tâche PONCTUELLE : un DÉLAI (« dans 30 min », « dans 2 h »), " +
            "une HEURE (« 16:10 » — aujourd'hui, ou demain si elle est passée), un JOUR " +
            "RELATIF (« demain à 8 h », « après-demain 18:00 ») ou une date ISO. " +
            "L'heure dite est celle de Yuki (Europe/Paris) quand aucun fuseau n'est " +
            "précisé. ⚠️ Omets-le si tu donnes `recurrence`.",
        }),
      ),
      recurrence: Type.Optional(
        Type.Object({
          type: Type.String({
            maxLength: 40,
            description:
              "Forme de la récurrence : « tous_les_jours », « chaque_semaine », " +
              "« toutes_les_heures » ou « tous_les_mois ».",
          }),
          heure: Type.Optional(
            Type.String({
              maxLength: 10,
              description:
                "Heure « HH:MM » (fuseau de Yuki) — requise pour « tous_les_jours », " +
                "« chaque_semaine » et « tous_les_mois ».",
            }),
          ),
          jour: Type.Optional(
            Type.String({
              maxLength: 20,
              description:
                "Jour de la semaine pour « chaque_semaine » : « lundi » … « dimanche ».",
            }),
          ),
          heures: Type.Optional(
            Type.Number({
              description:
                "Écart en heures pour « toutes_les_heures » : entier de 1 à 24. La série " +
                "est calée sur minuit local (0 h, N h, 2N h…).",
            }),
          ),
          jourDuMois: Type.Optional(
            Type.Number({
              description:
                "Jour du mois pour « tous_les_mois » : entier de 1 à 31 (au-delà de 28, " +
                "les mois qui n'ont pas ce jour sont sautés).",
            }),
          ),
        }),
      ),
      occurrences_max: Type.Optional(
        Type.Number({
          description:
            "Fin de la RÉCURRENCE par NOMBRE de passages (1 à 10 000). Omis ⇒ aucune fin " +
            "par le compteur.",
        }),
      ),
      jusqu_au: Type.Optional(
        Type.String({
          maxLength: 40,
          description:
            "Fin de la RÉCURRENCE par DATE (ISO) : plus aucun passage au-delà. Omis ⇒ " +
            "aucune fin par la date.",
        }),
      ),
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
      // ⚠️ La RÉCURRENCE part BRUTE : c'est le port qui la valide (formes, bornes 1–24,
      // jour du mois 1–31, fuseau). Un cast ici laisserait passer n'importe quoi.
      const recurrence = (params as { recurrence?: unknown }).recurrence;
      const occurrencesMaxBrut = (params as { occurrences_max?: unknown }).occurrences_max;
      const occurrencesMax =
        typeof occurrencesMaxBrut === "number" && Number.isFinite(occurrencesMaxBrut)
          ? Math.trunc(occurrencesMaxBrut)
          : undefined;
      const jusquAuBrut = (params as { jusqu_au?: unknown }).jusqu_au;
      const jusquAu = typeof jusquAuBrut === "string" ? jusquAuBrut.trim() : "";

      const conversation = options.conversation(ctx);
      const session = (conversation.session ?? "").trim();

      let issue: PlanifierTacheOutcome;
      try {
        issue = await port.planifier({
          ...(quand !== "" ? { quand } : {}),
          instruction,
          ...(nom !== "" ? { nom } : {}),
          ...(recurrence !== undefined && recurrence !== null ? { recurrence } : {}),
          ...(occurrencesMax !== undefined ? { occurrencesMax } : {}),
          ...(jusquAu !== "" ? { jusquAu } : {}),
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

      const texte = issue.recurrence === true
        ? `Récurrence « ${issue.libelle} » créée : ${issue.quandLisible}. ` +
          "À chaque passage, une tâche de fond exécutera l'instruction et son résultat " +
          `sera publié dans ${issue.cibleLisible}. ` +
          "Elle est visible et modifiable dans Configuration → Déclencheurs, et " +
          "`lister_taches` en rend l'identifiant ; `modifier_tache` et `supprimer_tache` " +
          "la changent ou l'arrêtent. " +
          "⚠️ Aucune pré-autorisation ne l'accompagne : une action qui exige une " +
          "approbation humaine échouera proprement à chaque passage."
        : `Tâche « ${issue.libelle} » programmée pour le ${issue.quandLisible}. ` +
          "À ce moment-là, une tâche de fond exécutera l'instruction et son résultat " +
          `sera publié dans ${issue.cibleLisible}. ` +
          "Elle s'exécute UNE seule fois, puis s'éteint (elle reste visible et " +
          "supprimable dans Configuration → Déclencheurs, et `supprimer_tache` peut " +
          "l'annuler avant l'heure). " +
          "⚠️ Aucune pré-autorisation ne l'accompagne : une action qui exige une " +
          "approbation humaine échouera proprement à ce moment-là.";
      return {
        content: [{ type: "text", text: texte }],
        details: {
          status: "planifie",
          nom: issue.nom,
          quand: issue.quandLisible,
          cible: issue.cibleLisible,
        } satisfies DetailsPlanification,
      };
    },
  });

  return [tool, ...createGestionTachesTools(port, options)];
}

/** Session du contexte (exportée pour les tests et la fabrique locale). */
export { sessionIdFromContext };
